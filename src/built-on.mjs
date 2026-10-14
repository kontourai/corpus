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
  // `.` (or `./`) names the root package, which is always compared. Exclusions only subtract, so a
  // list with no other inclusions describes a single-package repo, like an empty list.
  const members = patterns.filter((pattern) => !pattern.startsWith('!')).map((pattern) => pattern.replace(/\/+$/, '') || '.').filter((pattern) => pattern !== '.');
  const include = picomatch(members);
  const exclude = picomatch(patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1).replace(/\/$/, '')));
  const matches = (directory) => include(directory) && !exclude(directory);
  const packages = [['package.json', pkg], ...files.filter((file) => file.endsWith('/package.json') && matches(path.posix.dirname(file))).map((file) => [file, readPackage(root, file)])];
  if (pnpm && members.length > 0 && packages.length === 1) throw new UsageError('pnpm-workspace.yaml: no workspace members resolve; fix the non-empty packages globs');
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
  const runs = (steps, prefix) => (Array.isArray(steps) ? steps : []).flatMap((step, index) => (typeof step?.run === 'string' ? [{ source: `${file} ${prefix}steps[${index}].run`, text: step.run }] : []));
  if (file.startsWith('.github/actions/')) return data?.runs?.using === 'composite' ? runs(data.runs.steps, 'runs.') : [];
  return Object.entries(data?.jobs ?? {}).flatMap(([job, value]) => runs(value?.steps, `jobs.${job}.`));
}

const EXPRESSION = '__CORPUS_GITHUB_EXPRESSION__';
const UNTERMINATED_EXPRESSION = '__CORPUS_UNTERMINATED_GITHUB_EXPRESSION__';

// Replaces each `${{ … }}` with a placeholder word and joins backslash continuations, recording
// the original line number of every output line. Like GitHub's template reader, an expression ends
// at the first `}}` outside a single-quoted string ('' escapes a quote inside one). An expression
// that never closes makes GitHub reject the workflow; here it costs only the rest of its own line.
function neutralise(text) {
  let out = '';
  let line = 1;
  const lines = [1];
  for (let index = 0; index < text.length;) {
    if (text.startsWith('${{', index)) {
      let end = -1;
      let inString = false;
      for (let cursor = index + 3; cursor < text.length; cursor++) {
        if (text[cursor] === "'") inString = !inString;
        else if (!inString && text.startsWith('}}', cursor)) { end = cursor + 2; break; }
      }
      if (end === -1) {
        out += UNTERMINATED_EXPRESSION;
        end = text.indexOf('\n', index);
        if (end === -1) end = text.length;
        else if (text[end - 1] === '\r') end -= 1;
      }
      else out += EXPRESSION;
      line += (text.slice(index, end).match(/\n/g) ?? []).length;
      index = end;
    } else if (text[index] === '\\' && /^\\\r?\n/.test(text.slice(index, index + 3))) {
      out += ' ';
      line += 1;
      index += text[index + 1] === '\r' ? 3 : 2;
    } else {
      if (text[index] === '\n') lines.push(++line);
      out += text[index++];
    }
  }
  return { text: out, lines };
}

// Splits a script into simple commands. The unit of tokenisation is the logical line: physical
// lines joined by backslash continuations and by quotes still open at a line end, which is what the
// shell reads as one command line. A line the tokenizer cannot read (a bad `${…}` substitution or
// an unclosed GitHub expression) is skipped and reported, and later lines are still read. It is not
// split further at `;` or `&&`, because finding those separators needs the quote and substitution
// parsing that just failed; a guessed split could read quoted text as a command.
function shellCommands(command) {
  const { text, lines } = neutralise(command);
  const commands = [];
  const skipped = [];
  const heredocs = [];
  let quote = null;
  let logical = '';
  let start = 0;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (heredocs.length) {
      const { delimiter, tabs } = heredocs[0];
      if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) heredocs.shift();
      continue;
    }
    if (!logical) start = lines[index];
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
    let tokens;
    let unparseable = logical.includes(UNTERMINATED_EXPRESSION);
    if (!unparseable) {
      try { tokens = parseShell(logical, (name) => `$${name}`); } catch { unparseable = true; }
    }
    if (unparseable) {
      skipped.push(start);
      // shell-quote throws only on `${` substitutions, so with every `$` removed it still finds this
      // line's heredoc operators, and their bodies stay out of the evidence.
      tokens = parseShell(logical.replaceAll('$', '_'));
    }
    logical = '';
    for (let position = 0; position < tokens.length; position++) {
      if (['<<', '<<-'].includes(tokens[position]?.op) && typeof tokens[position + 1] === 'string') heredocs.push({ delimiter: tokens[position + 1], tabs: tokens[position].op === '<<-' });
    }
    if (unparseable) continue;
    let words = [];
    for (const token of tokens) {
      if ([';', '&&', '||', '|', '&', '|&'].includes(token?.op)) { commands.push(words); words = []; }
      else if (!token?.comment) words.push(token);
    }
    commands.push(words);
  }
  return { commands, skipped };
}

function invokes(commands, via, bin) {
  const executable = bin ?? via;
  return commands.some((tokens) => {
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
  const sources = packages.flatMap(([file, pkg]) => Object.entries(pkg.scripts ?? {}).filter(([, value]) => typeof value === 'string').map(([name, text]) => ({ source: `${file} scripts.${name}`, text })));
  for (const file of files.filter((file) => (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) || /^\.github\/actions\/(?:[^/]+\/)+action\.ya?ml$/.test(file)))) sources.push(...workflowCommands(root, file));
  const parsed = sources.map(({ source, text }) => ({ source, ...shellCommands(text) }));
  const commands = parsed.flatMap((script) => script.commands);
  const skipped = parsed.flatMap(({ source, skipped: lines }) => lines.map((line) => `${source} line ${line}`));
  const skippedNote = skipped.length ? `; ${skipped.length} command line${skipped.length === 1 ? ' was' : 's were'} skipped as unparseable (${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? `, and ${skipped.length - 3} more` : ''})` : '';
  for (const { entry, via } of declared) {
    if (dependencies.some((dep) => via === dep.package)) continue;
    if (entry.evidence === 'cli' && invokes(commands, via, entry.bin)) continue;
    failures.push(`builtOn ${entry.product} (via ${via}) has no matching dependency; remove it or use evidence: "cli" with a CLI invoked in package.json scripts, workflow steps or composite actions and explain its use in for${entry.evidence === 'cli' ? skippedNote : ''}`);
  }
  const runtime = new Set(dependencies.filter((dep) => !dep.dev).map((dep) => dep.package));
  for (const name of [...new Set(dependencies.filter((dep) => dep.dev && !runtime.has(dep.package)).map((dep) => dep.package))].sort()) warnings.push(`dev-only: ${name}; declare it in builtOn if the product's promise depends on it`);
  return { failures, warnings, note: `${packages.length} package.json file(s) compared` };
}
