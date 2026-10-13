import { standaloneFileMutationLock } from '../src/index.js';
import { join } from 'node:path';
import { KnowledgeFileTransactions as SourceTransactions, type KnowledgeFileTransactionHooks } from '../src/shared/file-transactions.js';
export function resolveHomeDir(): string {
  const home = process.env.CORPUS_TEST_HOME;
  if (!home) throw new Error('Isolated transaction test home is required');
  return home;
}
export class KnowledgeFileTransactions extends SourceTransactions {
  constructor(root: string, hooks: KnowledgeFileTransactionHooks = {}) {
    super(root, hooks, { coordinationIdentity: () => () => {}, lock: standaloneFileMutationLock, coordinationDirectory: join(resolveHomeDir(), 'coordination', 'knowledge-file-transactions') });
  }
}
