import { isDeepStrictEqual } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { runConformance, vectors, storeVectors, hostVectors } from '@kontourai/corpus-conformance';
import { makeHarness } from './conformance-harness.mjs';

// Host vectors are obligations of the host that mounts the store (for example,
// search over the working set). The package never runs them, so the list may not
// excuse them either: excusing one here would hide a host gap behind a store list.
const hostVectorIds = new Set(hostVectors.map((vector) => vector.id));

/** The vectors this package runs: every store vector, or the selected store vectors. */
export function packageCases(selected = []) {
  for (const id of selected) {
    if (!vectors.some((vector) => vector.id === id)) throw new Error(`Unknown selected vector: ${id}`);
    if (hostVectorIds.has(id)) throw new Error(`Selected vector ${id} is a host vector; corpus-store does not implement it, so run it through a host`);
  }
  return selected.length ? storeVectors.filter((vector) => selected.includes(vector.id)) : storeVectors;
}

export function adjudicate(report, profile, expected, { selected = false } = {}) {
  const known = new Set(report.results.map((result) => result.id));
  const unexpected = [];
  for (const [id, decision] of Object.entries(expected)) {
    if (hostVectorIds.has(id)) unexpected.push({ id, error: 'Host vector listed as a package expected failure; hosts must pass it' });
    else if (!selected && decision.profiles.includes(profile) && !known.has(id)) unexpected.push({ id, error: 'Unknown expected-fail vector' });
  }
  for (const result of report.results) {
    const decision = expected[result.id];
    const listed = decision?.profiles.includes(profile);
    if (listed && result.passed) unexpected.push({ id: result.id, error: 'Expected-fail vector passed; remove it from the list' });
    else if (!result.passed) {
      const matches = listed && (decision.assertions ? isDeepStrictEqual(result.assertion, decision.assertions[profile]) : new RegExp(decision.errorPattern).test(result.error));
      if (!matches) unexpected.push(result);
    }
  }
  return { passed: unexpected.length === 0, unexpected };
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  // CORPUS_EXPECTED_FAILS lets tests adjudicate the real CLI against a fixture list.
  const expected = JSON.parse(await readFile(process.env.CORPUS_EXPECTED_FAILS ?? new URL('./expected-fails.json', import.meta.url)));
  const reports = [];
  const selected = process.argv.slice(2);
  const cases = packageCases(selected);
  for (const profile of ['default', 'vault']) {
    const report = await runConformance(() => makeHarness(profile), { cases });
    const result = adjudicate(report, profile, expected, { selected: selected.length > 0 });
    reports.push({ profile, node: process.version, ...report, adjudication: result });
    console.log(JSON.stringify({ profile, vectors: report.results.length, hostVectorsNotRun: [...hostVectorIds], passing: report.results.filter((entry) => entry.passed).length, expectedFail: report.results.filter((entry) => !entry.passed).map((entry) => entry.id), ...result }, null, 2));
  }
  if (process.env.CORPUS_CONFORMANCE_REPORT) await writeFile(process.env.CORPUS_CONFORMANCE_REPORT, JSON.stringify(reports, null, 2) + '\n');
  if (reports.some((report) => !report.adjudication.passed)) process.exitCode = 1;
}
