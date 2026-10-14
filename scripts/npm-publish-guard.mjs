import { spawnSync } from 'node:child_process';

const [name, version, tag, ...extra] = process.argv.slice(2);
function refuse(message) {
  console.error(`Refusing publish: ${message}`);
  process.exit(1);
}

const numeric = '(0|[1-9]\\d*)';
const identifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const exactVersion = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
// The root CLI and the two workspaces. Each is published by its own workflow,
// which is what its npm trusted publisher names; this list only bounds the guard.
const packages = ['@kontourai/corpus', '@kontourai/corpus-store', '@kontourai/corpus-conformance'];
if (extra.length || !packages.includes(name) || !exactVersion.test(version ?? '')) {
  refuse('expected a Corpus package name, exact semantic version, and dist-tag');
}
if (!['next', 'latest'].includes(tag)) refuse('dist-tag must be next or latest');
if (version.split('+')[0].includes('-') && tag !== 'next') {
  refuse('prerelease versions must use next; latest is forbidden');
}

const result = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json', '--registry=https://registry.npmjs.org'], {
  encoding: 'utf8', timeout: 60_000,
});
if (result.error) refuse(`npm view failed: ${result.error.message}`);
let response;
try { response = JSON.parse(result.stdout); }
catch { refuse('npm view returned no valid JSON; absence is unconfirmed'); }
if (result.status === 0) refuse(`${name}@${version} already exists on npm`);
if (response?.error?.code !== 'E404') refuse(`npm view failed: ${response?.error?.code ?? result.status}`);
console.log(`Allow ${name}@${version} with dist-tag ${tag}: npm reports E404`);
