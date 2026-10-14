import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = resolve(process.argv[2] ?? join(tmpdir(), 'corpus-round2-faults'));
mkdirSync(output, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(git('status', '--porcelain'), '', 'Commit a clean baseline before injection');
const revision = git('rev-parse', 'HEAD');
const oldCodec = git('show', 'c0c44c7:packages/store/src/shared/frontmatter.ts') + '\n';
const focused = (pattern) => ['run','test','--workspace=@kontourai/corpus-store','--','test/round2.test.ts','-t',pattern];
const controls = [
  { id:'N1', file:'packages/store/src/shared/frontmatter.ts', mutate:()=>oldCodec, args:focused('following keys.*(literal|strip|folded)'), reason:/following keys[\s\S]*(literal|strip|folded)/ },
  { id:'N2', file:'packages/store/src/shared/frontmatter.ts', mutate:()=>oldCodec, args:focused('following keys.*kit-sequence'), reason:/mutation_log entries have an invalid shape/ },
  { id:'N3', file:'packages/store/src/shared/frontmatter.ts', mutate:()=>oldCodec, args:focused('every written record is standard YAML'), reason:/YAMLException|bad indentation/ },
  { id:'N4', file:'packages/store/src/services.ts', mutate:(s)=>s.replace(/  if \(typeof options\.coordinationIdentity[^\n]+\n/,'').replace('const recheck = options.coordinationIdentity();','const recheck = options.coordinationIdentity?.() ?? (() => {});'), args:focused('missing coordination identity'), reason:/missing coordination identity rejects/ },
  { id:'N4-types', file:'packages/store/src/services.ts', mutate:(s)=>s.replace('coordinationIdentity: () => (() => void);','coordinationIdentity?: () => (() => void);'), args:['run','verify:pack','--workspace=@kontourai/corpus-store'], build:true, reason:/Unused '@ts-expect-error' directive/ },
  { id:'N5', file:'docs/store-extraction.md', mutate:(s)=>s.replace('The expected-fail list is empty.','1 of the 1 expected failures are bound to ref/kind/expected/actual, and 0 to\nspecific error patterns.').replace(/^\d+ of the (\d+) expected failures are bound to ref\/kind\/expected\/actual, and \d+ to$/m,'$1 of the $1 expected failures are bound to ref/kind/expected/actual, and 0 to'), command:process.execPath,args:['--test','test/public-store-docs.test.mjs'],reason:/public expected-fail binding counts/ },
];
function run(label,args,success,command='npm') {
  const r=spawnSync(command,args,{cwd:repo,encoding:'utf8',timeout:240000});
  const log=(r.stdout??'')+(r.stderr??'');writeFileSync(join(output,label+'.log'),log);
  assert.equal(r.error,undefined);assert.equal(r.signal,null);
  if(success)assert.equal(r.status,0,log);else assert.notEqual(r.status,0,label+' must fail');
  console.log(`${label}: exit ${r.status}`);return {exit:r.status,log};
}
run('build-baseline',['run','build','--workspace=@kontourai/corpus-store'],true);
const results=[];
for(const c of controls) {
  const file=join(repo,c.file);const original=readFileSync(file,'utf8');
  const baseline=run(c.id+'-baseline',c.args,true,c.command);let injected;
  try {
    const changed=c.mutate(original);assert.notEqual(changed,original);writeFileSync(file,changed);
    if(c.build)run(c.id+'-build-injected',['run','build','--workspace=@kontourai/corpus-store'],true);
    injected=run(c.id+'-injected',c.args,false,c.command);assert.match(injected.log,c.reason);
  } finally {writeFileSync(file,original)}
  if(c.build)run(c.id+'-build-restored',['run','build','--workspace=@kontourai/corpus-store'],true);
  const restored=run(c.id+'-restored',c.args,true,c.command);
  results.push({id:c.id,baseline:baseline.exit,injected:injected.exit,restored:restored.exit});
  assert.equal(git('status','--porcelain'),'');
  writeFileSync(join(output,'results.json'),JSON.stringify({revision,node:process.version,results},null,2)+'\n');
}
