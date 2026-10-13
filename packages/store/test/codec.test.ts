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
  test('unknown extensions use only lossless core-schema scalar conversions', () => {
    const { meta } = parseMarkdown('---\nttl_seconds: 60\nfuture: 1.10\nflag: true\nempty: null\ninteger: 3\ndash: -\n---\n\nBody');
    expect(meta).toMatchObject({ ttl_seconds: 60, future: '1.10', flag: true, empty: null, integer: 3, dash: '-' });
  });
  test('rejects other malformed scalar syntax', () => {
    expect(() => parseMarkdown('---\nprovenance:\n  note: [unterminated\n---\n\nBody')).toThrow();
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


test('Station mutation evidence keeps its complete typed field inventory', () => {
  const { meta } = parseMarkdown(readFileSync(join(fixtures, 'station', 'mutation-default.md'), 'utf8'));
  expect(meta.ttl_seconds).toBe(60);
  const log = meta.mutation_log as { op: string; evidence: Record<string, unknown>; at: string; agent: string; note: string }[];
  expect(log.find((entry) => entry.op === 'supersede')?.evidence.superseded_count).toBe(1);
  expect(log.find((entry) => entry.op === 'link')?.evidence.added).toEqual([{ target_id: 'source-record', kind: 'source', label: 'null' }]);
  expect(log.find((entry) => entry.op === 'update')?.evidence.fields).toEqual(['title', 'tags']);
  expect(log.find((entry) => entry.op === 'apply')?.evidence).toEqual({ proposer_id: 'proposer-record', rationale: 'null' });
  expect(log.find((entry) => entry.op === 'reject')?.evidence.reason).toBe('-');
  expect(log.every((entry) => entry.agent === 'true' && entry.note === '1.10' && typeof entry.at === 'string')).toBe(true);
});

test('unknown extension changes replace saved source instead of resurrecting old values', () => {
  const { meta, body } = parseMarkdown('---\nfuture: 1.10\nflag: true\n---\n\nBody');
  meta.future = 3;
  const rewritten = serializeMarkdown(meta, body);
  expect(rewritten).toContain('future: 3\n');
  expect(rewritten).not.toContain('1.10');
});


test('changed extension containers serialize their unchanged scalar siblings safely', () => {
  const { meta, body } = parseMarkdown('---\nfuture: { precise: 1.10, changed: 3, quoted: "true" }\n---\n\nBody');
  (meta.future as Record<string, unknown>).changed = 4;
  const rewritten = serializeMarkdown(meta, body);
  expect(rewritten).toContain("precise: '1.10'\n");
  expect(rewritten).toContain('changed: 4\n');
  expect(parseMarkdown(rewritten).meta.future).toMatchObject({ quoted: 'true' });
  const read = parseMarkdown(rewritten).meta.future;
  expect(read).toEqual({ precise: '1.10', changed: 4, quoted: 'true' });
});

test('unchanged extension blocks and sequences retain values through canonical serialization', () => {
  const extension = '"future": { values: [1.10, 3, true, null], quoted: "3" } # retain format\nfuture_body: |\n  exact body\n  second line\n';
  const original = `---\ntitle: Title\n${extension}---\n\nBody`;
  const { meta, body } = parseMarkdown(original);
  expect(meta.future).toEqual({ values: ['1.10', 3, true, null], quoted: '3' });
  const rewritten = serializeMarkdown(meta, body);
  expect(parseMarkdown(rewritten).meta).toMatchObject({ future: meta.future, future_body: meta.future_body });
});


test('operation-specific string fields do not capture unknown fields on other log operations', () => {
  const { meta, body } = parseMarkdown('---\nmutation_log:\n  - op: update\n    rationale: 3 # future update extension\n  - op: supersede\n    rationale: true\n---\n\nBody');
  const log = meta.mutation_log as Record<string, unknown>[];
  expect(log[0].rationale).toBe(3);
  expect(log[1].rationale).toBe('true');
  expect((parseMarkdown(serializeMarkdown(meta, body)).meta.mutation_log as Record<string, unknown>[])[0].rationale).toBe(3);
});
