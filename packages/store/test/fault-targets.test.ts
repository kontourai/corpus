/**
 * Every fault-injection control must still find the text it changes. A refactor that moves code
 * otherwise leaves a control that aborts `npm run proof:purge` partway, and the controls after it
 * never run (kontourai/corpus#64 review).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('every purge fault control finds its target in the current sources', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./purge-faults.mjs', import.meta.url)), '--check-targets'], { encoding: 'utf8', timeout: 60_000 });
  expect(run.stdout, run.stderr).toMatch(/^\d+ controls, 0 stale$/m);
  expect(run.status).toBe(0);
});
