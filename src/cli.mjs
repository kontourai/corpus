import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DocsKitError, EXIT_OK, EXIT_USAGE, UsageError } from './errors.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const HELP = `Corpus ${VERSION}: check, build, locate, and retrieve source-bound docs over MCP

Usage: corpus <command> [options]

Commands:
  check   Run the docs gates: manifest, purpose, links, reachability, topics,
          redirects, paths, builtOn, covers, and freshness with --base
            --root <dir>        repository root (default: .)
            --base <git-ref>    also check freshness against the changes in <git-ref>...HEAD
            --advisory          report stale documents as warnings and exit 0
  build   Run check (without freshness), render the site, write docs-bundle.json,
          and verify every internal link of the generated site
            --root <dir>        repository root (default: .)
            --out <dir>         output directory, replaced on each build (default: dist-pages)
            --base-url <url>    published site URL (default: https://kontourai.github.io/<product>/)
  locate  Locate a quote in source-bound docs
            --root <dir>        repository root (default: .)
            --quote <text>      passage to locate
            --source <path>     optionally restrict to one document
  mcp     Serve docs bundles over stdio to MCP clients; at most one source
            --repo <dir>        build one bundle in memory from a checkout
            --workspace <dir>   serve every immediate subdirectory that has corpus.json
            --hub <url>         fetch <url>/products.json and each bundle (default: https://kontourai.github.io/)
  hub     Build the organization hub page from products.json
            --products <file>   product list (default: products.json)
            --out <dir>         output directory (default: dist-hub)
  init    Scaffold a v2 corpus.json from README.md and docs/**/*.md; never overwrites a
          corpus.json, and refuses while a retired v1 docs-kit.json is present
            --root <dir>        repository root (default: .)

Options:
  -h, --help       show this help
  -v, --version    print the version

Exit codes: 0 ok, 1 gate failure, 2 usage or configuration error.
Manifest reference: https://github.com/kontourai/corpus#manifest-reference`;

const COMMAND_OPTIONS = {
  check: { root: { type: 'string' }, base: { type: 'string' }, advisory: { type: 'boolean' } },
  build: { root: { type: 'string' }, out: { type: 'string' }, 'base-url': { type: 'string' } },
  locate: { root: { type: 'string' }, quote: { type: 'string' }, source: { type: 'string' } },
  mcp: { repo: { type: 'string' }, workspace: { type: 'string' }, hub: { type: 'string' } },
  hub: { products: { type: 'string' }, out: { type: 'string' } },
  init: { root: { type: 'string' } },
};

function parse(command, args) {
  try {
    return parseArgs({
      args,
      options: { ...COMMAND_OPTIONS[command], help: { type: 'boolean', short: 'h' } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new UsageError(`${command}: ${error.message}`);
  }
}

function requireValue(values, name) {
  if (values[name] !== undefined && values[name].trim() === '') throw new UsageError(`--${name} needs a value`);
}

/** Run the CLI and return the exit code. Output goes to stdout; diagnostics to stderr. */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const say = (text) => stdout.write(`${text}\n`);
  const warn = (text) => stderr.write(`${text}\n`);
  let args = argv;
  // `npx -y github:kontourai/corpus#<sha> corpus <cmd>` runs this bin with
  // "docs-kit" as its first argument, so tolerate one leading program name.
  if (args[0] === 'docs-kit' || args[0] === 'corpus') args = args.slice(1);
  const [command, ...rest] = args;

  if (command === undefined) {
    warn(HELP);
    return EXIT_USAGE;
  }
  if (command === '-h' || command === '--help' || command === 'help') {
    say(HELP);
    return EXIT_OK;
  }
  if (command === '-v' || command === '--version') {
    say(VERSION);
    return EXIT_OK;
  }

  try {
    if (!Object.hasOwn(COMMAND_OPTIONS, command)) throw new UsageError(`unknown command "${command}"\n\n${HELP}`);
    const values = parse(command, rest);
    if (values.help) {
      say(HELP);
      return EXIT_OK;
    }
    for (const name of Object.keys(COMMAND_OPTIONS[command])) if (COMMAND_OPTIONS[command][name].type === 'string') requireValue(values, name);
    const root = path.resolve(values.root ?? '.');

    switch (command) {
      case 'check': {
        if (values.advisory && values.base === undefined) throw new UsageError('--advisory only applies to the freshness gate; pass --base <git-ref>');
        const { runChecks, formatCheckReport } = await import('./check.mjs');
        const result = runChecks({ root, base: values.base ?? null, advisory: Boolean(values.advisory) });
        (result.exitCode === EXIT_OK ? say : warn)(formatCheckReport(result, root));
        return result.exitCode;
      }
      case 'build': {
        const { runBuild } = await import('./build.mjs');
        const result = runBuild({ root, out: path.resolve(values.out ?? 'dist-pages'), baseUrl: values['base-url'] });
        (result.exitCode === EXIT_OK ? say : warn)(result.report);
        return result.exitCode;
      }
      case 'locate': {
        if (!values.quote) throw new UsageError('locate requires --quote <text>');
        const { bundleFromCheckout } = await import('./bundle.mjs');
        const { locateInBundle } = await import('./locate.mjs');
        const result = locateInBundle(bundleFromCheckout(root), values.quote, { source: values.source });
        say(JSON.stringify(result, null, 2));
        return result.error ? 1 : EXIT_OK;
      }
      case 'mcp': {
        const { runMcp } = await import('./mcp.mjs');
        await runMcp({ repo: values.repo, workspace: values.workspace, hub: values.hub });
        return EXIT_OK;
      }
      case 'hub': {
        const { runHub } = await import('./hub.mjs');
        say(runHub({ products: path.resolve(values.products ?? 'products.json'), out: path.resolve(values.out ?? 'dist-hub') }));
        return EXIT_OK;
      }
      case 'init': {
        const { runInit } = await import('./init.mjs');
        say(runInit({ root }));
        return EXIT_OK;
      }
    }
  } catch (error) {
    if (error instanceof DocsKitError) {
      warn(`docs-kit: ${error.message}`);
      return error.exitCode;
    }
    // Not a gate result: never let an unexpected crash read as "docs failed" (1).
    warn(`docs-kit: internal error: ${error?.stack ?? error}`);
    return EXIT_USAGE;
  }
  return EXIT_USAGE;
}
