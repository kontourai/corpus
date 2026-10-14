// Release preflight for the root @kontourai/corpus package, run from the
// repository root by the root publish workflow before anything is packed.
//
// The dispatched version must be the manifest version, and CHANGELOG.md must
// already describe it: its first `## ` heading is exactly that version and no
// `## Unreleased` section remains. A tree whose changelog still carries
// unreleased changes cannot be published under the previous version's number.
import { readFileSync } from 'node:fs';

const [version, ...extra] = process.argv.slice(2);
function refuse(message) {
  console.error(`Refusing release: ${message}`);
  process.exit(1);
}

if (extra.length || !version) refuse('usage: root-release-preflight.mjs <exact-version>');
let metadata;
try { metadata = JSON.parse(readFileSync('package.json', 'utf8')); }
catch (error) { refuse(`cannot read package.json: ${error.message}`); }
if (metadata.name !== '@kontourai/corpus') refuse(`package.json name is ${JSON.stringify(metadata.name)}, not "@kontourai/corpus"`);
if (metadata.version !== version) refuse(`package.json version ${JSON.stringify(metadata.version)} does not equal the requested ${JSON.stringify(version)}`);

let changelog;
try { changelog = readFileSync('CHANGELOG.md', 'utf8'); }
catch (error) { refuse(`cannot read CHANGELOG.md: ${error.message}`); }
// Every ATX heading, at any level, with Keep a Changelog's [brackets] stripped,
// so "## [Unreleased]", "### Unreleased", and "# Unreleased" are all seen.
const headings = [...changelog.matchAll(/^(#{1,6}) +(.+?)\s*$/gm)].map((match) => ({
  written: `${match[1]} ${match[2]}`,
  level: match[1].length,
  text: match[2].replace(/[[\]]/g, '').trim(),
}));
const unreleased = headings.find(({ text }) => /\bunreleased\b/i.test(text));
if (unreleased !== undefined) refuse(`CHANGELOG.md still has "${unreleased.written}"; release those changes under "## ${version}" first`);
const first = headings.find(({ level }) => level === 2);
if (first?.text !== version) refuse(`CHANGELOG.md's first section is ${first === undefined ? 'missing' : `"${first.written}"`}, not "## ${version}"`);

console.log(`Release preflight passed for @kontourai/corpus@${version}`);
