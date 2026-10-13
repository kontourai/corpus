import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import npa from 'npm-package-arg';
import { parse as parseYaml } from 'yaml';
import { parse as parseShell } from 'shell-quote';
import { UsageError } from './errors.mjs';
import { listFiles } from './paths.mjs';

function readPackage(root, file) {
  try {
    return JSON.parse(readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    throw new UsageError(`${file}: cannot read dependency evidence: ${error.message}`);
  }
}

function readYaml(root, file) {
  try {
    return parseYaml(readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    throw new UsageError(`${file}: cannot parse YAML evidence: ${error.message}`);
  }
}

function workspacePatterns(root, pkg) {
  const pnpm = existsSync(path.join(root, 'pnpm-workspace.yaml'));
  const patterns = pnpm ? readYaml(root, 'pnpm-workspace.yaml')?.packages ?? [] : pkg.workspaces?.packages ?? pkg.workspaces ?? [];
  if (!Array.isArray(patterns) || patterns.some((value) => typeof value !== 'string' || !value.trim())) throw new UsageError(`${pnpm ? 'pnpm-workspace.yaml' : 'package.json'}: workspace packages must be an array of non-empty directory globs`);
  return { patterns, pnpm };
}

function isKontourDependency(name, spec) {
  let parsed;
  try { parsed = npa.resolve(name, spec); } catch {
    // npm-package-arg does not support workspace/link/patch protocols.
    return name.startsWith('@kontourai/');
  }
  if (parsed.type === 'alias') return parsed.subSpec.name.startsWith('@kontourai/');
  if (name.startsWith('@kontourai/')) return true;
  if (parsed.hosted?.type === 'github') return parsed.hosted.user.split('/')[0].toLowerCase() === 'kontourai';
  if (parsed.type === 'remote') {
    const url = new URL(parsed.fetchSpec);
    const [, owner, repo] = url.pathname.split('/');
    return ['github.com', 'codeload.github.com'].includes(url.hostname.toLowerCase()) && owner?.toLowerCase() === 'kontourai' && Boolean(repo);
  }
  return false;
}

export function deriveBuiltOn(root) {
  if (!existsSync(path.join(root, 'package.json'))) return { skipped: 'no package.json; Kontour dependency comparison was not verified' };
  const pkg = readPackage(root, 'package.json');
  const { patterns, pnpm } = workspacePatterns(root, pkg);
  const files = listFiles(root);
  const include = picomatch(patterns.filter((pattern) => !pattern.startsWith('!')).map((pattern) => pattern.replace(/\/$/, '')));
  const exclude = picomatch(patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1).replace(/\/$/, '')));
  const matches = (directory) => include(directory) && !exclude(directory);
  const packages = [['package.json', pkg], ...files.filter((file) => file.endsWith('/package.json') && matches(path.posix.dirname(file))).map((file) => [file, readPackage(root, file)])];
  if (pnpm && packages.length === 1) throw new UsageError('pnpm-workspace.yaml: no workspace members resolve; fix packages globs or remove the workspace file');
  const ownPackages = new Set(packages.map(([, data]) => data.name).filter((name) => typeof name === 'string'));
  const dependencies = [];
  const excluded = [];
  for (const [file, data] of packages) {
    for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
      for (const [name, spec] of Object.entries(data[section] ?? {})) {
        if (!isKontourDependency(name, spec)) continue;
        const dependency = { package: name, file, section, dev: section === 'devDependencies' };
        if (name.startsWith('@kontourai/') && ownPackages.has(name)) excluded.push(dependency);
        else dependencies.push(dependency);
      }
    }
  }
  return { dependencies, excluded, packages, files };
}

function workflowCommands(root, file) {
  const data = readYaml(root, file);
  const steps = file.startsWith('.github/actions/')
    ? data?.runs?.using === 'composite' ? data.runs.steps ?? [] : []
    : Object.values(data?.jobs ?? {}).flatMap((job) => job?.steps ?? []);
  return steps.filter((step) => typeof step?.run === 'string').map((step) => step.run);
}

function shellCommands(command) {
  const commands = [];
  const heredocs = [];
  let quote = null;
  let logical = '';
  for (const line of command.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    if (heredocs.length) {
      const { delimiter, tabs } = heredocs[0];
      if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) heredocs.shift();
      continue;
    }
    let escaped = false;
    for (const char of line) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\' && quote !== "'") { escaped = true; continue; }
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'" || char === '`') quote = char;
      else if (char === '#') break;
    }
    logical += line;
    if (quote) { logical += '\n'; continue; }
    const tokens = parseShell(logical.replace(/\$\{\{[\s\S]*?\}\}/g, '__CORPUS_EXPRESSION__'), (name) => `$${name}`);
    logical = '';
    for (let index = 0; index < tokens.length; index++) {
      if (['<<', '<<-'].includes(tokens[index]?.op) && typeof tokens[index + 1] === 'string') heredocs.push({ delimiter: tokens[index + 1], tabs: tokens[index].op === '<<-' });
    }
    let words = [];
    for (const token of tokens) {
      if ([';', '&&', '||', '|', '&', '|&'].includes(token?.op)) { commands.push(words); words = []; }
      else if (!token?.comment) words.push(token);
    }
    commands.push(words);
  }
  return commands;
}

function invokes(command, via, bin) {
  const executable = bin ?? via;
  return shellCommands(command).some((tokens) => {
    let words = [...tokens];
    while (typeof words[0] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    if (!words.length) return false;
    const runner = words[0];
    let versioned = false;
    if (runner === 'npx') {
      words.shift();
      while (['-y', '--yes', '--no-install', '--'].includes(words[0])) words.shift();
      versioned = true;
    } else if (['npm', 'pnpm', 'yarn'].includes(runner)) {
      words.shift();
      if (runner === 'npm' && words.shift() !== 'exec') return false;
      if (runner === 'npm') versioned = true;
      else if (['exec', 'dlx'].includes(words[0])) { words.shift(); versioned = true; }
      if (words[0] === '--') words.shift();
    }
    const target = words[0];
    if (typeof target !== 'string') return false;
    if (target === executable || target === `./node_modules/.bin/${executable}`) return true;
    return versioned && target.startsWith(`${executable}@`) && target.length > executable.length + 1;
  });
}

export function checkBuiltOn(root, manifest) {
  if (manifest.schemaVersion !== 2) return { skipped: 'v1 manifest has no builtOn contract' };
  const derived = deriveBuiltOn(root);
  if (derived.skipped) return derived;
  const { dependencies, packages, files } = derived;
  const failures = [];
  const warnings = [];
  const declared = manifest.builtOn.flatMap((entry, index) => (Array.isArray(entry.via) ? entry.via : [entry.via]).map((via) => ({ entry, index, via })));
  const seen = new Map();
  for (const { index, via } of declared) {
    if (seen.has(via)) failures.push(`builtOn: ${via} appears more than once (entries ${seen.get(via)} and ${index}); declare each package or CLI only once`);
    else seen.set(via, index);
  }
  for (const dep of dependencies.filter((dep) => !dep.dev)) {
    if (!declared.some(({ via }) => via === dep.package)) failures.push(`${dep.file} ${dep.section}: ${dep.package} is missing from builtOn; add { product: "OWNER_PRODUCT_ID", via: "${dep.package}", for: "reason" }`);
  }
  const commands = packages.flatMap(([, pkg]) => Object.values(pkg.scripts ?? {}).filter((value) => typeof value === 'string'));
  for (const file of files.filter((file) => (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) || /^\.github\/actions\/(?:[^/]+\/)+action\.ya?ml$/.test(file)))) commands.push(...workflowCommands(root, file));
  for (const { entry, via } of declared) {
    if (dependencies.some((dep) => via === dep.package)) continue;
    if (entry.evidence === 'cli' && commands.some((command) => invokes(command, via, entry.bin))) continue;
    failures.push(`builtOn ${entry.product} (via ${via}) has no matching dependency; remove it or use evidence: "cli" with a CLI invoked in package.json scripts, workflow steps or composite actions and explain its use in for`);
  }
  const runtime = new Set(dependencies.filter((dep) => !dep.dev).map((dep) => dep.package));
  for (const name of [...new Set(dependencies.filter((dep) => dep.dev && !runtime.has(dep.package)).map((dep) => dep.package))].sort()) warnings.push(`dev-only: ${name}; declare it in builtOn if the product's promise depends on it`);
  return { failures, warnings, note: `${packages.length} package.json file(s) compared` };
}
