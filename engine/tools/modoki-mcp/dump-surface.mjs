// Dump the modoki MCP tool surface to a compact fixture: name, sorted param names,
// required params, and a SHA-256 of the description. Ground truth for proving the E1
// split is behaviour-neutral (no tool lost, no schema or description changed).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const out = process.argv[2];
if (!out) throw new Error('usage: dump-tools.mjs <out.json>');

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', 'src/index.ts'],
  // No backend needed: listTools never touches it.
  env: { ...process.env, MODOKI_BACKEND: 'http://127.0.0.1:1' },
});
const client = new Client({ name: 'dump', version: '1.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// Recursively sums every `description` string BENEATH a JSON-Schema node, given a top-level
// param's own schema — the same containers `sumSchemaBytes` in
// `engine/tests/tools/mcpRegistry.test.ts` (#456) walks, kept in lockstep so the two cannot
// disagree about where a nested schema lives. Deliberately NOT the same measurement, though:
// that ledger also counts property NAMES, because it prices the whole advertised surface (a
// param name is bytes an agent is billed for too). `paramDocs` is about documentation prose
// specifically, so a property's own name is structure here, not narrated text, and is left out.
const sumDescriptionBytes = (node) => {
  if (Array.isArray(node)) return node.reduce((sum, v) => sum + sumDescriptionBytes(v), 0);
  if (!node || typeof node !== 'object') return 0;
  let bytes = typeof node.description === 'string' ? node.description.length : 0;
  if (node.properties && typeof node.properties === 'object') {
    for (const value of Object.values(node.properties)) bytes += sumDescriptionBytes(value);
  }
  if (node.patternProperties && typeof node.patternProperties === 'object') {
    for (const value of Object.values(node.patternProperties)) bytes += sumDescriptionBytes(value);
  }
  if (node.items) bytes += sumDescriptionBytes(node.items);
  if (node.prefixItems) bytes += sumDescriptionBytes(node.prefixItems);
  if (node.anyOf) bytes += sumDescriptionBytes(node.anyOf);
  if (node.oneOf) bytes += sumDescriptionBytes(node.oneOf);
  if (node.allOf) bytes += sumDescriptionBytes(node.allOf);
  if (node.not) bytes += sumDescriptionBytes(node.not);
  if (node.propertyNames) bytes += sumDescriptionBytes(node.propertyNames);
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    bytes += sumDescriptionBytes(node.additionalProperties);
  }
  return bytes;
};

const rows = tools
  .map((t) => {
    const props = t.inputSchema?.properties ?? {};
    return {
      name: t.name,
      params: Object.keys(props).sort(),
      required: (t.inputSchema?.required ?? []).slice().sort(),
      descSha: sha(t.description ?? ''),
      descLen: (t.description ?? '').length,
      // PER-PARAM description bytes — the FULL prose beneath each top-level param, itself
      // included, not just the param's own `.description`. Without recursing, this dump cannot
      // see a documentation change buried inside a nested object param at all: #456 edited
      // `entity.surface` and `entity.allowOccluded`, both nested one level inside `entity`, and
      // the old `(props[k]?.description ?? '').length` reported "descriptions changed: 0" for
      // both — the identical blindness `sumSchemaBytes` was fixed to remove in the ledger test,
      // found here one file later by #456's own close-out sweep. Same lesson as the comment this
      // extends: a verification tool blind to the thing being verified is worse than none. The
      // output SHAPE is unchanged (one entry per top-level param) so existing dumps stay
      // comparable — only what each entry MEASURES got deeper.
      paramDocs: Object.fromEntries(
        Object.keys(props).sort().map((k) => [k, sumDescriptionBytes(props[k])]),
      ),
      // Strictness is part of the advertised contract (conventions §1) — it shows up here as
      // `additionalProperties: false`, so a silent revert is visible in the diff.
      strict: t.inputSchema?.additionalProperties === false,
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(out, JSON.stringify({ toolCount: rows.length, tools: rows }, null, 2) + '\n');
console.log(`wrote ${rows.length} tools → ${out}`);
await client.close();
process.exit(0);
