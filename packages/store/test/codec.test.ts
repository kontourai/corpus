import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parseMarkdown, serializeMarkdown } from '../src/shared/frontmatter.js';
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
describe('old Kit writer scalar compatibility', () => {
  for (const scalar of ['1.10', 'null', 'true', '-']) {
    test(`preserves old Kit scalar ${scalar}`, () => {
      const text = readFileSync(join(fixtures, 'old-kit', `${scalar === '-' ? 'dash' : scalar}.md`), 'utf8');
      const { meta, body } = parseMarkdown(text);
      expect(meta.title).toBe(scalar);
      expect(meta.provenance).toEqual({ agent: scalar, note: scalar });
      expect(meta.tags).toEqual([scalar === '-' ? 'fixture' : scalar]);
      expect(meta.ttl_seconds).toBe(60);
      expect(body).toBe('Original old Kit body.');
    });
  }
  test('keeps unknown scalars textual while coercing only numeric TTL', () => {
    expect(parseMarkdown('---\nttl_seconds: 60\nfuture: 1.10\nflag: true\nempty: null\n---\n\nBody').meta).toEqual({ ttl_seconds: 60, future: '1.10', flag: 'true', empty: 'null' });
  });
  test('refuses malformed bare-dash YAML outside known legacy string positions', () => {
    expect(() => parseMarkdown('---\nunknown: -\n---\n\nBody')).toThrow();
    expect(() => parseMarkdown('---\nprovenance:\n  note: - # suspicious\n---\n\nBody')).toThrow();
  });
});
describe('Station serializer byte compatibility', () => {
  for (const file of readdirSync(join(fixtures, 'station'))) {
    test(`round-trips Station fixture ${file} byte for byte`, () => {
      const original = readFileSync(join(fixtures, 'station', file), 'utf8');
      const parsed = parseMarkdown(original);
      expect(serializeMarkdown(parsed.meta, parsed.body)).toBe(original);
    });
  }
});
