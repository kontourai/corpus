import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { UsageError } from './errors.mjs';
import { addedFiles } from './git.mjs';
import { toFsPath } from './paths.mjs';

// The topic-keyed decision registry: one living record per decision subject at
// <dir>/<topic-slug>.md, plus a generated index. The format is documented in
// docs/decisions.md and published as schemas/decision-record.schema.json; this
// module enforces the same rules directly, plus the rules a JSON Schema cannot
// express (filename slugs, relations to other records, the index, the ADR freeze).

export const DECISION_STATUSES = ['current', 'superseded', 'merged', 'needs-decision'];
export const EVIDENCE_KINDS = ['issue', 'pr', 'commit', 'session-archive', 'adr', 'doc', 'url'];
export const RECORD_KEYS = ['status', 'subject', 'decided', 'evidence', 'supersedes', 'superseded_by', 'merged_into'];
export const EVIDENCE_KEYS = ['kind', 'ref'];
export const DECISIONS_DOC_URL = 'https://github.com/kontourai/corpus/blob/main/docs/decisions.md';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Secret-shaped literals refused in evidence refs. The schema's `not.pattern` mirrors these. */
export const SECRET_PATTERNS = [
  { label: 'aws access key id', re: /AKIA[A-Z0-9]{16}/ },
  { label: 'aws sts key id', re: /ASIA[A-Z0-9]{16}/ },
  { label: 'github token', re: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { label: 'private key block', re: /BEGIN[A-Z ]*PRIVATE KEY/ },
  { label: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { label: 'generic secret literal', re: /(secret|password|token|api[_-]?key)\s*[:=]\s*["'][^"']{8,}/i },
];

const problem = (rule, message) => ({ rule, message });
const show = (value) => (typeof value === 'string' ? `'${value}'` : JSON.stringify(value) ?? String(value));

/**
 * Split a record into its YAML frontmatter and body. The block must start at
 * byte 0 with a `---` line (no BOM) and end at the next line that is `---`
 * once trimmed. It is parsed with the failsafe schema, so every scalar is a
 * string (`ref: 310` stays "310"), and duplicate keys, anchors, aliases, and
 * explicit tags are refused. Returns { frontmatter, body, errors }; frontmatter
 * is null when the block is missing or unparseable.
 */
export function parseDecisionRecord(text) {
  const errors = [];
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    errors.push(problem('frontmatter', "file must begin with a YAML frontmatter block delimited by '---' (at byte 0)"));
    return { frontmatter: null, body: text, errors };
  }
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) {
    errors.push(problem('frontmatter', "frontmatter block is not terminated by a closing '---'"));
    return { frontmatter: null, body: text, errors };
  }
  const body = lines.slice(end + 1).join('\n');
  const doc = YAML.parseDocument(lines.slice(1, end).join('\n'), { schema: 'failsafe', uniqueKeys: true, prettyErrors: false });
  for (const error of [...doc.errors, ...doc.warnings])
    errors.push(problem('frontmatter', `frontmatter is not valid YAML: ${error.message.split('\n')[0]}`));
  YAML.visit(doc, {
    Alias() {
      errors.push(problem('frontmatter', 'frontmatter must not use YAML aliases'));
    },
    Node(_, node) {
      if (node.anchor) errors.push(problem('frontmatter', `frontmatter must not use YAML anchors (&${node.anchor})`));
      if (node.tag) errors.push(problem('frontmatter', `frontmatter must not use explicit YAML tags (${node.tag})`));
    },
  });
  if (errors.length > 0) return { frontmatter: null, body, errors };
  const frontmatter = doc.toJS();
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    errors.push(problem('frontmatter', 'frontmatter must be a mapping of keys to values'));
    return { frontmatter: null, body, errors };
  }
  return { frontmatter, body, errors };
}

/** The record rules. `knownSlugs` is every record slug in the registry. Returns [{ rule, message }]. */
export function validateDecisionRecord(slug, fm, knownSlugs, { dir = 'docs/decisions' } = {}) {
  const errors = [];
  if (!SLUG.test(slug)) errors.push(problem('slug', `filename slug '${slug}' is not a valid kebab-case topic slug`));
  for (const key of Object.keys(fm))
    if (!RECORD_KEYS.includes(key)) errors.push(problem('unknown-key', `unknown frontmatter key '${key}' (allowed: ${RECORD_KEYS.join(', ')})`));

  if (!Object.hasOwn(fm, 'status')) errors.push(problem('status', 'missing required field: status'));
  else if (!DECISION_STATUSES.includes(fm.status)) errors.push(problem('status', `unknown status ${show(fm.status)} (allowed: ${DECISION_STATUSES.join(', ')})`));

  if (typeof fm.subject !== 'string' || fm.subject.trim() === '') errors.push(problem('subject', 'missing required field: subject (non-empty)'));

  if (!Object.hasOwn(fm, 'decided')) errors.push(problem('decided', 'missing required field: decided'));
  else if (typeof fm.decided !== 'string' || !DATE.test(fm.decided)) errors.push(problem('decided', `decided must be an ISO date (YYYY-MM-DD); got ${show(fm.decided)}`));

  if (!Object.hasOwn(fm, 'evidence')) errors.push(problem('evidence', 'missing required field: evidence[]'));
  else if (!Array.isArray(fm.evidence) || fm.evidence.length === 0) errors.push(problem('evidence', 'evidence must be a non-empty array of {kind, ref}'));
  else
    fm.evidence.forEach((item, index) => {
      const at = `evidence[${index}]`;
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return errors.push(problem('evidence', `${at} must be an object {kind, ref}`));
      for (const key of Object.keys(item))
        if (!EVIDENCE_KEYS.includes(key)) errors.push(problem('unknown-key', `${at}: unknown key '${key}' (allowed: ${EVIDENCE_KEYS.join(', ')})`));
      if (!EVIDENCE_KINDS.includes(item.kind)) errors.push(problem('evidence-kind', `${at}.kind ${show(item.kind)} is not one of ${EVIDENCE_KINDS.join(', ')}`));
      if (typeof item.ref !== 'string' || item.ref.trim() === '')
        return errors.push(problem('evidence', `${at}.ref must be a non-empty string (quote a ref that starts with '#': a bare # begins a YAML comment)`));
      const secret = SECRET_PATTERNS.find(({ re }) => re.test(item.ref));
      if (secret) errors.push(problem('secret', `${at}.ref contains a secret-shaped literal (${secret.label}); link durable provenance, never a credential`));
    });

  for (const key of ['superseded_by', 'merged_into']) {
    if (!Object.hasOwn(fm, key)) continue;
    const target = fm[key];
    if (typeof target !== 'string' || !SLUG.test(target)) errors.push(problem('relation', `${key} must be a single topic slug; got ${show(target)}`));
    else if (target === slug) errors.push(problem('self-reference', `${key} must not point at its own slug`));
    else if (!knownSlugs.has(target)) errors.push(problem('relation', `${key} points at missing topic slug '${target}' (no ${dir}/${target}.md)`));
  }
  if (Object.hasOwn(fm, 'supersedes')) {
    if (!Array.isArray(fm.supersedes)) errors.push(problem('relation', `supersedes must be a list of topic slugs; got ${show(fm.supersedes)}`));
    else
      for (const target of fm.supersedes) {
        if (typeof target !== 'string' || !SLUG.test(target)) errors.push(problem('relation', `supersedes entry must be a topic slug; got ${show(target)}`));
        else if (!knownSlugs.has(target)) errors.push(problem('relation', `supersedes points at missing topic slug '${target}' (no ${dir}/${target}.md)`));
      }
  }

  const has = (key) => Object.hasOwn(fm, key);
  if ((fm.status === 'current' || fm.status === 'needs-decision') && (has('superseded_by') || has('merged_into')))
    errors.push(problem('tombstone', `status '${fm.status}' must not carry superseded_by or merged_into`));
  if (fm.status === 'superseded') {
    if (!has('superseded_by')) errors.push(problem('tombstone', "status 'superseded' requires superseded_by"));
    if (has('merged_into')) errors.push(problem('tombstone', "status 'superseded' must not carry merged_into"));
  }
  if (fm.status === 'merged') {
    if (!has('merged_into')) errors.push(problem('tombstone', "status 'merged' requires merged_into"));
    if (has('superseded_by')) errors.push(problem('tombstone', "status 'merged' must not carry superseded_by"));
  }
  return errors;
}

/** First non-blank body line after the frontmatter, without heading marks (the index fallback when a record has no subject). */
function firstBodyLine(text) {
  let fences = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '---') {
      fences += 1;
      continue;
    }
    if (fences < 2 || line.trim() === '') continue;
    return line.trim().replace(/^#+\s*/, '').trim();
  }
  return '';
}

/** The generated index. Byte-compatible with the records' previous generator except for the header lines. */
export function renderDecisionIndex(records, { adrDir = null } = {}) {
  const lines = [
    '---',
    'title: Decision Index',
    '---',
    '',
    '# Decision Index',
    '',
    'Generated by `corpus decisions index`. Do not edit by hand.',
    `Topic-keyed living decision records; the format is described at ${DECISIONS_DOC_URL}.`,
    ...(adrDir ? [`Numbered ADRs under \`${adrDir}/\` are frozen history and are not listed here.`] : []),
    '',
    '| Topic | Status | Decision |',
    '| --- | --- | --- |',
  ];
  for (const record of [...records].sort((a, b) => a.slug.localeCompare(b.slug, 'en'))) {
    const fm = record.frontmatter ?? {};
    const status = typeof fm.status === 'string' ? fm.status : 'unknown';
    const subject = typeof fm.subject === 'string' ? fm.subject.trim() : '';
    const summary = (subject || firstBodyLine(record.text) || record.slug).replace(/\|/g, '\\|');
    lines.push(`| [${record.slug}](./${record.slug}.md) | ${status} | ${summary} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function isDirectory(fsPath) {
  try {
    return lstatSync(fsPath).isDirectory();
  } catch {
    return false;
  }
}

/** Read and validate every `<dir>/*.md` except the index. Never consults documents or exclude. */
export function readDecisionRecords(root, decisions) {
  const fsDir = toFsPath(root, decisions.dir);
  const indexName = path.posix.basename(decisions.index);
  const entries = isDirectory(fsDir) ? readdirSync(fsDir, { withFileTypes: true }) : [];
  const candidates = entries.filter((entry) => entry.name.endsWith('.md') && entry.name !== indexName).sort((a, b) => (a.name < b.name ? -1 : 1));
  const knownSlugs = new Set(candidates.map((entry) => entry.name.slice(0, -3)));
  return candidates.map((entry) => {
    const slug = entry.name.slice(0, -3);
    const repoPath = `${decisions.dir}/${entry.name}`;
    if (!entry.isFile()) return { slug, path: repoPath, text: '', frontmatter: null, errors: [problem('frontmatter', 'must be a regular file (not a symlink or directory)')] };
    const text = readFileSync(path.join(fsDir, entry.name), 'utf8');
    const { frontmatter, errors } = parseDecisionRecord(text);
    if (frontmatter) errors.push(...validateDecisionRecord(slug, frontmatter, knownSlugs, { dir: decisions.dir }));
    return { slug, path: repoPath, text, frontmatter, errors };
  });
}

function readIndex(root, decisions) {
  try {
    const fsPath = toFsPath(root, decisions.index);
    if (!lstatSync(fsPath).isFile()) return { state: 'invalid' };
    return { state: 'present', text: readFileSync(fsPath, 'utf8') };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { state: 'missing' };
    throw error;
  }
}

/**
 * The decisions gate: every record is valid and the index is exactly what
 * `corpus decisions index` would write. Returns { records, failures }.
 */
export function validateDecisions(root, decisions) {
  const records = readDecisionRecords(root, decisions);
  const failures = [];
  for (const record of records) for (const error of record.errors) failures.push(`${record.path}: ${error.message}`);
  const index = readIndex(root, decisions);
  const fix = 'run `corpus decisions index`';
  if (index.state === 'missing') failures.push(`${decisions.index} is missing; ${fix}`);
  else if (index.state === 'invalid') failures.push(`${decisions.index} must be a regular file (not a symlink or directory)`);
  else if (index.text !== renderDecisionIndex(records, { adrDir: decisions.adr?.dir ?? null })) failures.push(`${decisions.index} is stale; ${fix}`);
  return { records, failures };
}

/**
 * The ADR freeze: with a base ref, a file added under `adr.dir` since the
 * merge base is a failure. Edits and deletions are allowed. Git errors throw
 * UsageError.
 */
export function checkAdrFreeze(root, decisions, base) {
  const prefix = `${decisions.adr.dir}/`;
  const added = addedFiles(root, base).filter((file) => file.startsWith(prefix));
  return added.map(
    (file) =>
      `${file} was added since ${base}, but numbered ADRs under ${decisions.adr.dir}/ are frozen history; ` +
      `record the decision as ${decisions.dir}/<topic-slug>.md instead (see ${DECISIONS_DOC_URL}#numbered-adrs)`,
  );
}

/** Refuse to write through a symlink or over a non-file anywhere on the repo-relative path. */
function assertPlainPath(root, repoPath) {
  let current = root;
  const segments = repoPath.split('/');
  segments.forEach((segment, index) => {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const last = index === segments.length - 1;
    if (stat.isSymbolicLink()) throw new UsageError(`refusing to write ${repoPath}: ${segments.slice(0, index + 1).join('/')} is a symlink`);
    if (last ? !stat.isFile() : !stat.isDirectory()) throw new UsageError(`refusing to write ${repoPath}: ${segments.slice(0, index + 1).join('/')} is not a ${last ? 'file' : 'directory'}`);
  });
}

/** `corpus decisions index`: write the index file, and nothing else. Returns a report line. */
export function writeDecisionIndex(root, decisions) {
  assertPlainPath(root, decisions.index);
  const records = readDecisionRecords(root, decisions);
  mkdirSync(toFsPath(root, decisions.dir), { recursive: true });
  writeFileSync(toFsPath(root, decisions.index), renderDecisionIndex(records, { adrDir: decisions.adr?.dir ?? null }));
  const invalid = records.filter((record) => record.errors.length > 0).length;
  return (
    `corpus decisions index: wrote ${decisions.index} (${records.length} topic${records.length === 1 ? '' : 's'})` +
    (invalid > 0 ? `\n  note: ${invalid} record${invalid === 1 ? ' has' : 's have'} errors; run corpus decisions check` : '')
  );
}
