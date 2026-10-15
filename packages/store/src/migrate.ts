/**
 * Offline conversion of a Knowledge Kit vault index (`kit-v1`, `.graph-index.json`)
 * to the canonical `path-index.json`. Stop every writer first: the migration's lock
 * only excludes other runs that share its coordination directory.
 *
 * Only the index file changes. The conversion runs as one journaled transaction
 * of the store's own transaction engine: it hashes every other file, saves the
 * original index and a manifest, writes `path-index.json` and removes
 * `.graph-index.json`. It then re-hashes every file and reads every indexed record
 * through the vault adapter before marking the manifest verified. Reversal restores
 * the saved index only while the new index and every hashed file are byte-for-byte
 * what the migration recorded, so it never overwrites later edits.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import type { StoreOptions } from './services.js';
import { KnowledgeFileTransactions } from './shared/file-transactions.js';
import { parseMarkdown } from './shared/frontmatter.js';
import {
  assertPathIndex,
  KIT_V1_PATH_INDEX_FILE,
  KitObsidianStoreAdapter,
  PATH_INDEX_FILE,
  type PathIndex,
} from './obsidian-store.js';

export const MIGRATION_DIRECTORY = '.corpus-store-migration';
export const MANIFEST_FILE = `${MIGRATION_DIRECTORY}/manifest.json`;
export const SAVED_INDEX_FILE = `${MIGRATION_DIRECTORY}/kit-v1-path-index.json`;
const JOURNAL_FILE = '.station-knowledge-transaction.json';
const MAX_ENTRIES = 200_000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

export type MigrationState = 'migrated' | 'verified' | 'reversed';

export interface MigrationManifest {
  schemaVersion: 1;
  kind: 'corpus-store/vault-index-migration';
  tool: { name: string; version: string };
  state: MigrationState;
  from: { format: 'kit-v1'; file: string; sha256: string; savedAs: string };
  to: { format: 'path-index'; file: string; sha256: string };
  records: number;
  archived: number;
  /** sha256 of every other file under the root, keyed by root-relative path. */
  files: Record<string, string>;
  /** Markdown files that the Kit index did not list (unchanged, recorded for review). */
  unindexedMarkdown: string[];
  migratedAt: string;
  verifiedAt?: string;
  reversedAt?: string;
}

export type MigrationOutcome = 'checked' | 'migrated' | 'already-migrated' | 'nothing-to-migrate' | 'reversed';

export interface MigrationResult {
  outcome: MigrationOutcome;
  records?: number;
  archived?: number;
  files?: number;
  unindexedMarkdown?: string[];
  manifest?: string;
  manifestSha256?: string;
}

/** The migration refused; `problems` lists every reason. */
export class MigrationRefusal extends Error {
  constructor(readonly problems: string[]) {
    super(`corpus-store migrate refused:\n- ${problems.join('\n- ')}`);
    this.name = 'MigrationRefusal';
  }
}

export interface MigrationOptions extends Omit<StoreOptions, 'storeRoot'> {
  root: string;
}

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function toolIdentity(): { name: string; version: string } {
  const metadata = createRequire(import.meta.url)('../package.json') as { name: string; version: string };
  return { name: metadata.name, version: metadata.version };
}

class Migration {
  readonly files: KnowledgeFileTransactions;
  constructor(readonly root: string, options: MigrationOptions) {
    this.files = new KnowledgeFileTransactions(root, {}, options);
  }

  path(relativePath: string): string {
    return join(this.root, ...relativePath.split('/'));
  }

  bytes(relativePath: string): Buffer | null {
    return this.files.readBytes(this.path(relativePath), MAX_FILE_BYTES);
  }

  /** Hashes every file except the two indexes, a journal and the migration directory. */
  inventory(): { files: Record<string, string>; markdown: string[] } {
    const files: Record<string, string> = {};
    const markdown: string[] = [];
    const skipped = new Set([PATH_INDEX_FILE, KIT_V1_PATH_INDEX_FILE, JOURNAL_FILE]);
    const directories = [this.root];
    let entries = 0;
    let total = 0;
    while (directories.length > 0) {
      const directory = directories.pop()!;
      for (const entry of this.files.listDirectoryEntries(directory)) {
        if (++entries > MAX_ENTRIES) throw new MigrationRefusal([`the vault has more than ${MAX_ENTRIES} entries`]);
        const absolute = join(directory, entry.name);
        const rel = relative(this.root, absolute).split(sep).join('/');
        if (rel === MIGRATION_DIRECTORY) continue;
        if (entry.kind === 'directory') {
          directories.push(absolute);
          continue;
        }
        if (skipped.has(rel)) continue;
        const value = this.files.readBytes(absolute, MAX_FILE_BYTES);
        if (value === null) throw new MigrationRefusal([`${rel} disappeared while it was being hashed`]);
        total += value.byteLength;
        if (total > MAX_TOTAL_BYTES) throw new MigrationRefusal(['the vault is larger than the migration byte bound']);
        files[rel] = sha256(value);
        if (rel.toLowerCase().endsWith('.md')) markdown.push(rel);
      }
    }
    const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
    return { files: sorted, markdown: markdown.sort() };
  }

  manifest(): MigrationManifest | null {
    const raw = this.bytes(MANIFEST_FILE);
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw.toString('utf8')) as MigrationManifest;
      if (value?.kind !== 'corpus-store/vault-index-migration' || value.schemaVersion !== 1) throw new Error('unknown manifest kind');
      return value;
    } catch (error) {
      throw new MigrationRefusal([`${MANIFEST_FILE} is not a readable migration manifest (${(error as Error).message})`]);
    }
  }

  /** Validates the Kit index as exact mappings: shape, location, existence and frontmatter identity. */
  validate(raw: Buffer): { index: PathIndex; problems: string[] } {
    let index: PathIndex;
    try {
      index = assertPathIndex(JSON.parse(raw.toString('utf8')), KIT_V1_PATH_INDEX_FILE);
    } catch (error) {
      return { index: { by_id: {}, by_path: {} }, problems: [`${KIT_V1_PATH_INDEX_FILE}: ${(error as Error).message}`] };
    }
    const problems: string[] = [];
    for (const [id, entry] of Object.entries(index.by_id)) {
      if (entry.archived !== entry.path.startsWith('archive/')) {
        problems.push(`${id}: archived is ${entry.archived} but the path is ${entry.path}`);
      }
      let text: Buffer | null;
      try {
        text = this.bytes(entry.path);
      } catch (error) {
        problems.push(`${id}: ${entry.path} cannot be read (${(error as Error).message})`);
        continue;
      }
      if (text === null) {
        problems.push(`${id}: ${entry.path} does not exist`);
        continue;
      }
      try {
        const { meta } = parseMarkdown(text.toString('utf8'));
        if (meta.id !== id) problems.push(`${id}: ${entry.path} has frontmatter id ${JSON.stringify(meta.id)}`);
      } catch (error) {
        problems.push(`${id}: ${entry.path} has unreadable frontmatter (${(error as Error).message})`);
      }
    }
    return { index, problems };
  }
}

/** Every file the manifest hashed must still exist with the same bytes, and nothing may be added. */
function differences(expected: Record<string, string>, actual: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [file, hash] of Object.entries(expected)) {
    if (!(file in actual)) problems.push(`${file} was removed`);
    else if (actual[file] !== hash) problems.push(`${file} changed`);
  }
  for (const file of Object.keys(actual)) if (!(file in expected)) problems.push(`${file} was added`);
  return problems;
}

function summary(manifest: MigrationManifest, outcome: MigrationOutcome, text: string): MigrationResult {
  return {
    outcome,
    records: manifest.records,
    archived: manifest.archived,
    files: Object.keys(manifest.files).length,
    unindexedMarkdown: manifest.unindexedMarkdown,
    manifest: MANIFEST_FILE,
    manifestSha256: sha256(text),
  };
}

type Plan =
  | { kind: 'done'; result: MigrationResult }
  | { kind: 'verify'; manifest: MigrationManifest }
  | { kind: 'convert'; legacy: Buffer; index: PathIndex; inventory: { files: Record<string, string>; markdown: string[] } };

function plan(migration: Migration): Plan {
  const canonical = migration.bytes(PATH_INDEX_FILE);
  const legacy = migration.bytes(KIT_V1_PATH_INDEX_FILE);
  const manifest = migration.manifest();
  if (canonical !== null && legacy !== null) {
    throw new MigrationRefusal([`both ${PATH_INDEX_FILE} and ${KIT_V1_PATH_INDEX_FILE} exist; review both and remove the one that is not authoritative`]);
  }
  if (canonical !== null) {
    if (manifest?.state === 'migrated') return { kind: 'verify', manifest };
    if (manifest && manifest.state !== 'reversed') {
      return { kind: 'done', result: summary(manifest, 'already-migrated', migration.bytes(MANIFEST_FILE)!.toString('utf8')) };
    }
    return { kind: 'done', result: { outcome: 'nothing-to-migrate' } };
  }
  if (legacy === null) {
    throw new MigrationRefusal([`neither ${PATH_INDEX_FILE} nor ${KIT_V1_PATH_INDEX_FILE} exists; there is no index to convert`]);
  }
  if (manifest && manifest.state !== 'reversed') {
    throw new MigrationRefusal([`${MANIFEST_FILE} records state ${manifest.state}, but ${PATH_INDEX_FILE} is missing; inspect the vault before migrating again`]);
  }
  const { index, problems } = migration.validate(legacy);
  if (problems.length > 0) throw new MigrationRefusal(problems);
  return { kind: 'convert', legacy, index, inventory: migration.inventory() };
}

/** Validates without writing. */
export async function checkVaultIndexMigration(options: MigrationOptions): Promise<MigrationResult> {
  const migration = new Migration(options.root, options);
  return migration.files.read(() => {
    const planned = plan(migration);
    if (planned.kind === 'done') return planned.result;
    if (planned.kind === 'verify') {
      throw new MigrationRefusal(['the index conversion is committed but verification is incomplete; rerun corpus-store migrate without --check to verify the recorded bytes']);
    }
    const { index, inventory } = planned;
    return {
      outcome: 'checked',
      records: Object.keys(index.by_id).length,
      archived: Object.values(index.by_id).filter((entry) => entry.archived).length,
      files: Object.keys(inventory.files).length,
      unindexedMarkdown: inventory.markdown.filter((file) => !(file in index.by_path)),
    };
  });
}

export async function migrateVaultIndex(options: MigrationOptions): Promise<MigrationResult> {
  const migration = new Migration(options.root, options);
  const clock = options.clock ?? Date.now;
  const converted = await migration.files.mutate('migrate-vault-index', () => {
    const planned = plan(migration);
    if (planned.kind !== 'convert') return planned;
    const { legacy, index, inventory } = planned;
    const canonicalText = serialize({ by_id: index.by_id, by_path: index.by_path });
    const manifest: MigrationManifest = {
      schemaVersion: 1,
      kind: 'corpus-store/vault-index-migration',
      tool: toolIdentity(),
      state: 'migrated',
      from: { format: 'kit-v1', file: KIT_V1_PATH_INDEX_FILE, sha256: sha256(legacy), savedAs: SAVED_INDEX_FILE },
      to: { format: 'path-index', file: PATH_INDEX_FILE, sha256: sha256(canonicalText) },
      records: Object.keys(index.by_id).length,
      archived: Object.values(index.by_id).filter((entry) => entry.archived).length,
      files: inventory.files,
      unindexedMarkdown: inventory.markdown.filter((file) => !(file in index.by_path)),
      migratedAt: new Date(clock()).toISOString(),
    };
    migration.files.writeBytes(migration.path(SAVED_INDEX_FILE), legacy);
    migration.files.writeText(migration.path(MANIFEST_FILE), serialize(manifest));
    migration.files.writeText(migration.path(PATH_INDEX_FILE), canonicalText);
    migration.files.remove(migration.path(KIT_V1_PATH_INDEX_FILE));
    return { kind: 'convert' as const, manifest };
  });
  if (converted.kind === 'done') return converted.result;
  const { manifest } = converted;

  // Verify the bytes, then open every record through the package's own reader.
  const verifyBytes = () => migration.files.read(() => {
    const problems = differences(manifest.files, migration.inventory().files);
    const saved = migration.bytes(SAVED_INDEX_FILE);
    if (saved === null || sha256(saved) !== manifest.from.sha256) problems.push(`${SAVED_INDEX_FILE} does not match the original index`);
    const written = migration.bytes(PATH_INDEX_FILE);
    if (written === null || sha256(written) !== manifest.to.sha256) problems.push(`${PATH_INDEX_FILE} does not match what was written`);
    if (migration.bytes(KIT_V1_PATH_INDEX_FILE) !== null) problems.push(`${KIT_V1_PATH_INDEX_FILE} still exists`);
    return problems;
  });
  const problems = await verifyBytes();
  if (problems.length === 0) {
    const reader = new KitObsidianStoreAdapter({ ...options, storeRoot: options.root });
    const index = JSON.parse((await migration.files.read(() => migration.bytes(PATH_INDEX_FILE)))!.toString('utf8')) as PathIndex;
    for (const id of Object.keys(index.by_id)) {
      try {
        const record = await reader.get(id);
        if (record?.id !== id) problems.push(`${id}: the vault reader returned ${record ? record.id : 'nothing'}`);
      } catch (error) {
        problems.push(`${id}: the vault reader failed (${(error as Error).message})`);
      }
    }
    // Reading must not have written anything.
    problems.push(...await verifyBytes());
  }
  if (problems.length > 0) {
    throw new MigrationRefusal([
      'the index was converted but verification failed; the manifest stays in state "migrated", and corpus-store migrate --reverse restores the original while the bytes match',
      ...problems,
    ]);
  }
  const verified: MigrationManifest = { ...manifest, state: 'verified', verifiedAt: new Date(clock()).toISOString() };
  const text = serialize(verified);
  await migration.files.mutate('verify-vault-index-migration', () => {
    const current = migration.manifest();
    if (!current || current.state !== 'migrated' || current.migratedAt !== manifest.migratedAt) {
      throw new MigrationRefusal([`${MANIFEST_FILE} changed during verification`]);
    }
    migration.files.writeText(migration.path(MANIFEST_FILE), text);
  });
  return summary(verified, 'migrated', text);
}

/** Restores the Kit index, only while the vault is byte-for-byte as the migration left it. */
export async function reverseVaultIndexMigration(options: MigrationOptions): Promise<MigrationResult> {
  const migration = new Migration(options.root, options);
  const clock = options.clock ?? Date.now;
  return migration.files.mutate('reverse-vault-index-migration', () => {
    const manifest = migration.manifest();
    if (!manifest || manifest.state === 'reversed') throw new MigrationRefusal(['there is no migration to reverse']);
    const problems: string[] = [];
    const canonical = migration.bytes(PATH_INDEX_FILE);
    if (canonical === null) problems.push(`${PATH_INDEX_FILE} is missing`);
    else if (sha256(canonical) !== manifest.to.sha256) problems.push(`${PATH_INDEX_FILE} changed after the migration`);
    if (migration.bytes(KIT_V1_PATH_INDEX_FILE) !== null) problems.push(`${KIT_V1_PATH_INDEX_FILE} already exists`);
    const saved = migration.bytes(SAVED_INDEX_FILE);
    if (saved === null || sha256(saved) !== manifest.from.sha256) problems.push(`${SAVED_INDEX_FILE} does not match the recorded original`);
    problems.push(...differences(manifest.files, migration.inventory().files));
    if (problems.length > 0) throw new MigrationRefusal(problems);
    const reversed: MigrationManifest = { ...manifest, state: 'reversed', reversedAt: new Date(clock()).toISOString() };
    const text = serialize(reversed);
    migration.files.writeBytes(migration.path(KIT_V1_PATH_INDEX_FILE), saved!);
    migration.files.remove(migration.path(PATH_INDEX_FILE));
    migration.files.writeText(migration.path(MANIFEST_FILE), text);
    return summary(reversed, 'reversed', text);
  });
}
