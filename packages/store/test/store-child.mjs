import { input, createStore } from './conformance-harness.mjs';
const [profile, root, coordinationDirectory, mode, value] = process.argv.slice(2);
const adapter = createStore(profile, root, coordinationDirectory);
if (mode === 'create') await adapter.create(input(value));
else if (mode === 'update') await adapter.update('shared-record', { tags: [value] }, { agent: value });
else if (mode === 'crash') {
  // Ported transaction crash seam, kept internal; never exposed as public /storage.
  let publications = 0;
  let entries = 0;
  adapter.files.hooks.afterJournalWrite = (journal) => {
    entries = journal.entries.length;
    if (value === 'prepared' && journal.phase === 'prepared') process.exit(23);
  };
  adapter.files.hooks.afterFilePublish = () => {
    publications++;
    if (value === 'first-publish' && publications === 1 || value === 'final-publish' && publications === entries) process.exit(23);
  };
  adapter.files.hooks.afterCommitMarker = () => { if (value === 'committed') process.exit(23); };
  await adapter.create(input('crashed-record', { aliases: ['engineering/crashed'] }));
  throw new Error('Crash injection did not run');
} else if (mode === 'crash-purge' || mode === 'crash-purge-proposal') {
  // value is `<phase>,<id>`: a record id for `crash-purge`, a proposal id for `crash-purge-proposal`.
  // Same internal hooks as `crash`, aimed at a purge or a proposal erasure.
  const [phase, id] = value.split(',');
  let publications = 0;
  let entries = 0;
  adapter.files.hooks.afterJournalWrite = (journal) => {
    entries = journal.entries.length;
    if (phase === 'prepared' && journal.phase === 'prepared') process.exit(23);
  };
  adapter.files.hooks.afterFilePublish = () => {
    publications++;
    if (phase === 'first-publish' && publications === 1 || phase === 'final-publish' && publications === entries) process.exit(23);
  };
  adapter.files.hooks.afterCommitMarker = () => { if (phase === 'committed') process.exit(23); };
  const evidence = { agent: 'privacy-officer', rationale: 'crash drill' };
  if (mode === 'crash-purge') await adapter.purge([id], evidence);
  else await adapter.purgeProposal(id, evidence);
  throw new Error('Crash injection did not run');
} else throw new Error(`Unknown child mode ${mode}`);
