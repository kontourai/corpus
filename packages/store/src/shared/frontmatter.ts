import { dump, FAILSAFE_SCHEMA, type LoadOptions, load } from 'js-yaml';

interface ParsedMarkdown { meta: Record<string, unknown>; body: string }

// The old Kit writer emitted bare dash text in these string-valued positions.
// Restrict repair to those positions; malformed YAML elsewhere remains an error.
const ROOT_STRINGS = new Set(['id', 'type', 'title', 'category', 'status', 'created_at', 'updated_at', 'expires_at']);
const NESTED_STRINGS: Record<string, Set<string>> = {
  provenance: new Set(['agent', 'session_id', 'note']),
  links: new Set(['target_id', 'kind', 'label']),
  mutation_log: new Set(['op', 'at', 'agent', 'note', 'rationale', 'new_id']),
};
const EVIDENCE_STRINGS: Record<string, Set<string>> = {
  propose: new Set(['concept_id', 'proposer_id', 'proposal']),
  apply: new Set(['proposer_id', 'rationale']),
  reject: new Set(['proposer_id', 'reason']),
  'superseded-by': new Set(['superseded_by_id']),
  retire: new Set(['targetStatus', 'rationale', 'implementedByRef', 'supersededByRef']),
};
function repairLegacyDash(source: string): string {
  let section = '';
  let op = '';
  return source.split('\n').map((line) => {
    const top = /^([A-Za-z_]+):/.exec(line);
    if (top) { section = top[1]; op = ''; }
    const operation = /^  - op: (\S+)\s*$/.exec(line);
    if (operation) op = operation[1];
    const pair = /^( *)(- )?([A-Za-z_]+): (-[^\r\n]*)$/.exec(line);
    if (!pair || pair[4].trim() !== pair[4] || /[:#\[\]{},&*?|<>=!%@`"'\r]/.test(pair[4]) || !/^-(?:[ \t].*)?$/.test(pair[4])) return line;
    const indent = pair[1].length + (pair[2] ? 2 : 0);
    const allowed = indent === 0 ? ROOT_STRINGS.has(pair[3])
      : section === 'provenance' && indent === 2 ? NESTED_STRINGS.provenance.has(pair[3])
      : ['links', 'mutation_log'].includes(section) && indent === 4 ? NESTED_STRINGS[section].has(pair[3])
      : section === 'mutation_log' && indent === 6 ? EVIDENCE_STRINGS[op]?.has(pair[3]) : false;
    return allowed ? `${pair[1]}${pair[2] ?? ''}${pair[3]}: ${JSON.stringify(pair[4])}` : line;
  }).join('\n');
}
export function parseMarkdown(text: string, options?: Pick<LoadOptions, 'maxDepth' | 'maxAliases' | 'maxTotalMergeKeys'>): ParsedMarkdown {
  if (!text.startsWith('---\n')) return { meta: {}, body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { meta: {}, body: text };
  const rawYaml = text.slice(4, end);
  const body = text.slice(end + 5).replace(/^\n+/, '');
  let value: unknown;
  try { value = load(rawYaml, { ...options, schema: FAILSAFE_SCHEMA }); }
  catch (error) {
    const repaired = repairLegacyDash(rawYaml);
    if (repaired === rawYaml) throw error;
    value = load(repaired, { ...options, schema: FAILSAFE_SCHEMA });
  }
  const meta = value ?? {};
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('Knowledge frontmatter must be a mapping');
  const record = meta as Record<string, unknown>;
  // TTL is the sole numeric record field. Unknown metadata and evidence stay text.
  if (typeof record.ttl_seconds === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(record.ttl_seconds)) record.ttl_seconds = Number(record.ttl_seconds);
  return { meta: record, body };
}
export function serializeMarkdown(meta: Record<string, unknown>, body: string): string {
  const frontmatter = dump(meta, { lineWidth: -1 }).trimEnd();
  return `---\n${frontmatter}\n---\n\n${body}`;
}
