import { readFile, writeFile } from 'node:fs/promises';
import { runConformance, vectors } from '@kontourai/corpus-conformance';
import { makeHarness } from './conformance-harness.mjs';

export function adjudicate(report, profile, expected) {
  const known = new Set(report.results.map((result) => result.id));
  const unexpected = [];
  for (const [id, decision] of Object.entries(expected)) {
    if (decision.profiles.includes(profile) && !known.has(id)) unexpected.push({ id, error: 'Unknown expected-fail vector' });
  }
  for (const result of report.results) {
    const decision = expected[result.id];
    const listed = decision?.profiles.includes(profile);
    if (listed && result.passed) unexpected.push({ id: result.id, error: 'Expected-fail vector passed; remove it from the list' });
    else if (!result.passed && (!listed || !new RegExp(decision.errorPattern).test(result.error))) unexpected.push(result);
  }
  return { passed: unexpected.length === 0, unexpected };
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const expected = JSON.parse(await readFile(new URL('./expected-fails.json', import.meta.url)));
  const reports = [];
  const selected = process.argv.slice(2);
  for (const profile of ['default', 'vault']) {
    const report = await runConformance(() => makeHarness(profile), selected.length ? { cases: vectors.filter((vector) => selected.includes(vector.id)) } : {});
    const result = selected.length ? { passed: report.passed, unexpected: report.results.filter((entry) => !entry.passed) } : adjudicate(report, profile, expected);
    reports.push({ profile, node: process.version, ...report, adjudication: result });
    console.log(JSON.stringify({ profile, vectors: report.results.length, passing: report.results.filter((entry) => entry.passed).length, expectedFail: report.results.filter((entry) => !entry.passed).map((entry) => entry.id), ...result }, null, 2));
  }
  if (process.env.CORPUS_CONFORMANCE_REPORT) await writeFile(process.env.CORPUS_CONFORMANCE_REPORT, JSON.stringify(reports, null, 2) + '\n');
  if (reports.some((report) => !report.adjudication.passed)) process.exitCode = 1;
}
