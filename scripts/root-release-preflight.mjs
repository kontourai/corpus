// Release preflight for the root @kontourai/corpus package, run from the
// repository root by the root publish workflow before anything is packed.
//
// The dispatched version must be the manifest version, and CHANGELOG.md must
// already describe it: its first level-2 heading is exactly that version, and
// no heading of any kind names "Unreleased" (ATX at any level, indented or
// tab-separated, bracketed as "[Unreleased]", or setext-underlined). A tree
// whose changelog still carries unreleased changes cannot be published under
// the previous version's number. Body text that mentions the word is fine.
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
// Every heading, deliberately looser than CommonMark so nothing slips past:
// ATX with any leading whitespace and a space or tab after the #s, and setext
// (a text line underlined with = or -). Keep a Changelog's [brackets] and
// closing #s are stripped from the text.
const headings = [];
const lines = changelog.split(/\r?\n/);
const clean = (text) => text.replace(/[[\]]/g, '').replace(/\s+#+\s*$/, '').trim();
lines.forEach((line, index) => {
  const atx = /^\s*(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
  if (atx) return headings.push({ written: line.trim(), level: atx[1].length, text: clean(atx[2] ?? '') });
  const underline = /^\s*(=+|-+)\s*$/.exec(lines[index + 1] ?? '');
  if (underline && line.trim() !== '' && !/^\s*([-*+]\s|>|\d+[.)]\s)/.test(line))
    headings.push({ written: `${line.trim()} (underlined)`, level: underline[1].startsWith('=') ? 1 : 2, text: clean(line) });
});
const unreleased = headings.find(({ text }) => /\bunreleased\b/i.test(text));
if (unreleased !== undefined) refuse(`CHANGELOG.md still has "${unreleased.written}"; release those changes under "## ${version}" first`);
const first = headings.find(({ level }) => level === 2);
if (first?.text !== version) refuse(`CHANGELOG.md's first section is ${first === undefined ? 'missing' : `"${first.written}"`}, not "## ${version}"`);

console.log(`Release preflight passed for @kontourai/corpus@${version}`);
