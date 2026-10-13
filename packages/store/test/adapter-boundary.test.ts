import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
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
describe('adapter publication ownership', () => {
  for (const file of ['default-store', 'obsidian-store']) {
    test(`${file} delegates file mutations to the transaction owner`, () => {
      const source = readFileSync(new URL(`../src/${file}.ts`, import.meta.url), 'utf8');
      expect(bypasses(source)).toEqual([]);
    });
  }
});
