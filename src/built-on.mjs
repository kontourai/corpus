import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { UsageError } from './errors.mjs';
import { listFiles } from './paths.mjs';

function readPackage(root, file) {
  try {
    return JSON.parse(readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    throw new UsageError(`${file}: cannot read dependency evidence: ${error.message}`);
  }
}

export function deriveBuiltOn(root) {
  if (!existsSync(path.join(root, 'package.json'))) return { skipped: 'no package.json; Kontour dependency comparison was not verified' };
  const pkg = readPackage(root, 'package.json');
  const patterns = pkg.workspaces?.packages ?? pkg.workspaces ?? [];
  if (!Array.isArray(patterns) || patterns.some((value) => typeof value !== 'string')) throw new UsageError('package.json: workspaces must be an array of globs or { packages: [...] }');
  const files = listFiles(root);
  const matches = picomatch(patterns.map((pattern) => pattern.replace(/\/$/, '')));
  const packages = [['package.json', pkg], ...files.filter((file) => file.endsWith('/package.json') && matches(path.posix.dirname(file))).map((file) => [file, readPackage(root, file)])];
  const dependencies = [];
  for (const [file, data] of packages) {
    for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
      for (const [name, spec] of Object.entries(data[section] ?? {})) {
        const git = typeof spec === 'string' && /^(?:github:|git\+https:\/\/github\.com\/)kontourai\/([^/#]+)(?:\.git)?(?:#.*)?$/.exec(spec);
        const product = name.startsWith('@kontourai/') ? name.slice('@kontourai/'.length) : git ? git[1].replace(/\.git$/, '') : null;
        if (product) dependencies.push({ package: name, product, file, section, dev: section === 'devDependencies' });
      }
    }
  }
  return { dependencies, packages, files };
}

function workflowCommands(text) {
  const commands = [];
  let blockIndent = null;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (blockIndent !== null && indent > blockIndent) { commands.push(line.trim()); continue; }
    blockIndent = null;
    const run = /^\s*(?:-\s*)?run:\s*(.*)$/.exec(line);
    if (!run) continue;
    if (/^[|>][-+]?\s*$/.test(run[1])) blockIndent = indent;
    else commands.push(run[1].replace(/^(['"])(.*)\1$/, '$2'));
  }
  return commands;
}

function unquotedCommands(command) {
  let quote = null;
  let comment = false;
  let escaped = false;
  let text = '';
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === '\n') { comment = false; text += char; continue; }
    if (comment) { text += ' '; continue; }
    if (escaped) { text += ' '; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; text += ' '; continue; }
    if (quote) { if (char === quote) quote = null; text += ' '; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; text += ' '; continue; }
    if (char === '#' && (index === 0 || /\s/.test(command[index - 1]))) { comment = true; text += ' '; continue; }
    text += char;
  }
  return text;
}

function invokes(command, via) {
  // Deliberately narrow: a bare executable, optionally run through npx or pnpm exec.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(via)) return false;
  const escaped = via.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|&&|\\|\\||[;|])\\s*(?:(?:npx(?:\\s+--yes|\\s+-y)?|pnpm\\s+exec)\\s+)?${escaped}(?=\\s|$)`, 'm').test(unquotedCommands(command));
}

export function checkBuiltOn(root, manifest) {
  if (manifest.schemaVersion !== 2) return { skipped: 'v1 manifest has no builtOn contract' };
  const derived = deriveBuiltOn(root);
  if (derived.skipped) return derived;
  const { dependencies, packages, files } = derived;
  const failures = [];
  const warnings = [];
  const matching = (entry, dep) => entry.product === dep.product && (entry.via === dep.package || entry.via === dep.product);
  for (const dep of dependencies.filter((dep) => !dep.dev)) {
    if (!manifest.builtOn.some((entry) => matching(entry, dep))) failures.push(`${dep.file} ${dep.section}: ${dep.package} is missing from builtOn; add { product: "${dep.product}", via: "${dep.package}", for: "reason" }`);
  }
  const commands = packages.flatMap(([, pkg]) => Object.values(pkg.scripts ?? {}).filter((value) => typeof value === 'string'));
  for (const file of files.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file))) commands.push(...workflowCommands(readFileSync(path.join(root, file), 'utf8')));
  for (const entry of manifest.builtOn) {
    if (dependencies.some((dep) => matching(entry, dep))) continue;
    if (entry.evidence === 'cli' && commands.some((command) => invokes(command, entry.via))) continue;
    failures.push(`builtOn ${entry.product} (via ${entry.via}) has no matching dependency; remove it or use evidence: "cli" with a CLI invoked in package.json scripts or .github/workflows and explain its use in for`);
  }
  const runtime = new Set(dependencies.filter((dep) => !dep.dev).map((dep) => dep.package));
  for (const name of [...new Set(dependencies.filter((dep) => dep.dev && !runtime.has(dep.package)).map((dep) => dep.package))].sort()) warnings.push(`dev-only: ${name}; declare it in builtOn if the product's promise depends on it`);
  return { failures, warnings, note: `${packages.length} package.json file(s) compared` };
}
