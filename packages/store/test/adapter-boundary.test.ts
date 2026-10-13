import { readFileSync, readdirSync } from 'node:fs';
import { expect, test } from 'vitest';
const mutation = '(?:appendFile|copyFile|cp|rename|rmdir|rm|truncate|unlink|writeFile)(?:Sync)?';
const fsModule = `['"](?:node:)?fs(?:/promises)?['"]`;
function bypasses(source: string): string[] {
  const named = new RegExp(`import\\s*\\{[^}]*?\\b(${mutation})\\b[^}]*\\}\\s*from\\s*${fsModule}`, 'g');
  const found = [...source.matchAll(named)].map((match) => match[1]);
  const bindings = new RegExp(`import\\s+(?:\\*\\s+as\\s+)?(\\w+)\\s+from\\s*${fsModule}`, 'g');
  for (const [, binding] of source.matchAll(bindings)) {
    const calls = new RegExp(`\\b${binding}(?:\\.promises)?\\.(${mutation})\\s*\\(`, 'g');
    found.push(...[...source.matchAll(calls)].map((match) => match[1]));
  }
  return found;
}
test('package adapters and helpers leave raw file mutations to their owners', () => {
  const root = new URL('../src/', import.meta.url);
  const owners = new Set(['shared/file-transactions.ts', 'standalone-lock.ts']);
  const found: string[] = [];
  for (const file of readdirSync(root, { recursive: true }).map(String)) {
    if (!file.endsWith('.ts') || owners.has(file.replaceAll('\\', '/'))) continue;
    const source = readFileSync(new URL(file, root), 'utf8');
    found.push(...bypasses(source).map((mutation) => `${file}: ${mutation}`));
  }
  expect(found).toEqual([]);
});
