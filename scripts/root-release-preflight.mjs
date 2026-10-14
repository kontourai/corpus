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
const headings = [...changelog.matchAll(/^## +(.+?)\s*$/gm)].map((match) => match[1]);
const unreleased = headings.find((heading) => /^unreleased\b/i.test(heading));
if (unreleased !== undefined) refuse(`CHANGELOG.md still has "## ${unreleased}"; release those changes under "## ${version}" first`);
if (headings[0] !== version) refuse(`CHANGELOG.md's first section is ${headings[0] === undefined ? 'missing' : `"## ${headings[0]}"`}, not "## ${version}"`);

console.log(`Release preflight passed for @kontourai/corpus@${version}`);
