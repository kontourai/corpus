#!/usr/bin/env node
/**
 * corpus-store migrate <vault-root> [--check | --reverse] [--coordination-directory <dir>]
 *
 * stdout carries one JSON result; diagnostics go to stderr. Exit 0 on success or
 * when there is nothing to do, 1 when the migration refuses, 2 on a usage error.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  checkVaultIndexMigration,
  MIGRATION_DIRECTORY,
  MigrationRefusal,
  migrateVaultIndex,
  reverseVaultIndexMigration,
} from './migrate.js';
import { observeDirectoryChain } from './shared/observation-file.js';
import { standaloneFileMutationLock } from './standalone-lock.js';

const USAGE = 'usage: corpus-store migrate <vault-root> [--check | --reverse] [--coordination-directory <dir>]';

function usage(message?: string): never {
  if (message) process.stderr.write(`corpus-store: ${message}\n`);
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

function parse(argv: string[]) {
  const [command, ...rest] = argv;
  if (command !== 'migrate') usage(command ? `unknown command: ${command}` : 'missing command');
  let root: string | undefined;
  let mode: 'migrate' | 'check' | 'reverse' = 'migrate';
  let coordinationDirectory: string | undefined;
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (argument === '--check' || argument === '--reverse') {
      if (mode !== 'migrate') usage('--check and --reverse are exclusive');
      mode = argument === '--check' ? 'check' : 'reverse';
    } else if (argument === '--coordination-directory') {
      const value = rest[++index];
      if (!value) usage('--coordination-directory needs a directory');
      coordinationDirectory = value;
    } else if (argument.startsWith('-')) {
      usage(`unknown option: ${argument}`);
    } else if (root === undefined) {
      root = argument;
    } else {
      usage(`unexpected argument: ${argument}`);
    }
  }
  if (!root) usage('missing vault root');
  return { root, mode, coordinationDirectory };
}

async function main(): Promise<void> {
  const { root, mode, coordinationDirectory } = parse(process.argv.slice(2));
  let storeRoot: string;
  try {
    storeRoot = realpathSync(resolve(root));
  } catch {
    usage(`vault root does not exist: ${root}`);
  }
  // The default lock lives inside the vault's migration directory, so runs against
  // one vault exclude each other. Hosts are not excluded: stop them first.
  const coordination = coordinationDirectory
    ? resolve(coordinationDirectory)
    : join(storeRoot, MIGRATION_DIRECTORY, 'coordination');
  if (!isAbsolute(coordination)) usage('coordination directory must resolve to an absolute path');
  const options = {
    root: storeRoot,
    coordinationDirectory: coordination,
    lock: standaloneFileMutationLock,
    coordinationIdentity: () => observeDirectoryChain(storeRoot),
  };
  try {
    const run = mode === 'check' ? checkVaultIndexMigration : mode === 'reverse' ? reverseVaultIndexMigration : migrateVaultIndex;
    const result = await run(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    if (error instanceof MigrationRefusal) {
      process.stdout.write(`${JSON.stringify({ outcome: 'refused', problems: error.problems }, null, 2)}\n`);
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`corpus-store migrate failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

await main();
