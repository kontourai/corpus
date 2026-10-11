# docs-kit contributor rules

- **Runtime:** plain ESM `.mjs` on Node 22 or newer. There is no build step, no TypeScript, and no `prepare` script. Consumers run `npx -y github:kontourai/docs-kit#<sha>`, so whatever is committed under `bin/` and `src/` is what ships. Everything a consumer needs must be listed in the `files` allowlist in `package.json`.
- **Dependencies:** keep the runtime set minimal: the MCP server SDK, `zod` for its tool schemas, `marked`, and `picomatch`. Never add native modules. Commit `package-lock.json` with any dependency change.
- **Contract:** the `docs-kit.json` schema, CLI flags, exit codes (0 ok, 1 gate failure, 2 usage or configuration error), `docs-bundle.json`, `products.json`, and the MCP tool names are consumed by about 20 repositories. Changing any of them is a versioned, documented change. Update `README.md` and `docs/` in the same commit.
- **Tests:** `npm test` runs `node --test`. A gate's rejection path is tested by running the real CLI as a child process against a fixture in `test/fixtures/`, asserting both the exit code and the message. Fixtures have the real manifest shape. Tests that need git copy a fixture into a temporary repository; they never depend on this checkout's history.
- **Fault injection:** when you change a gate, commit, weaken the gate, confirm that its test fails, restore it, and confirm the tests are green again.
- **Dogfood:** `node bin/docs-kit.mjs check` must pass on this repository. CI runs it.
- **Output discipline:** `mcp` writes only protocol messages to stdout; diagnostics go to stderr.
