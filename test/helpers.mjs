import { execFile, execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(REPO_ROOT, 'bin', 'docs-kit.mjs');
export const FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures');

/** Run the real CLI as a child process. Resolves { status, stdout, stderr, output }. */
export function runCli(args, { cwd = REPO_ROOT, env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' }, (error, stdout, stderr) => {
      const status = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ status, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
  });
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'docs-kit test',
  GIT_AUTHOR_EMAIL: 'docs-kit-test@example.invalid',
  GIT_COMMITTER_NAME: 'docs-kit test',
  GIT_COMMITTER_EMAIL: 'docs-kit-test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

export function git(cwd, args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function commitAll(cwd, message) {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

/** A scratch directory removed by `t.after`. */
export function scratch(t, prefix = 'docs-kit-test-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Copy a fixture into its own git repository with one commit. Returns the checkout path. */
export function fixtureRepo(t, name, { into, as } = {}) {
  const parent = into ?? scratch(t);
  const dir = path.join(parent, as ?? name);
  cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  git(dir, ['init', '-q']);
  commitAll(dir, `fixture ${name}`);
  return dir;
}

export function write(file, content) {
  writeFileSync(file, content);
}
