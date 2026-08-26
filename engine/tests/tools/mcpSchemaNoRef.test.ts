/** Guard: no `modoki_*` tool's ADVERTISED inputSchema may contain a JSON Schema `$ref`.
 *
 *  `zod-to-json-schema` (what `zodToJsonSchema`/the MCP SDK's schema conversion uses to build
 *  the JSON the client actually sees) dedupes a zod schema object REUSED BY REFERENCE within one
 *  tool's shape into a `$ref` — even for a bare `z.boolean()`, not just objects (measured). A
 *  client that does not resolve `$ref` reads that field as untyped and can encode it wrong —
 *  this is exactly how `modoki_dnd` broke (`to` came back `{"$ref":"#/properties/from"}`, so a
 *  real object arg failed zod validation with "Expected object, received string at to") and how
 *  the SAME bug reappeared one field deeper in `modoki_drag`/`modoki_pointer`/etc. via the shared
 *  `pointSpec.allowOccluded` even after `pointSpec` itself became a per-call factory — the review
 *  that caught it found no test would have failed. This is that test: it walks every registered
 *  tool's REAL schema (not a rebuilt one) and fails loudly if a `$ref` shows up anywhere, so the
 *  next shared-const mistake is caught here instead of by a live MCP client mis-encoding a call. */

import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from '../../tools/modoki-mcp/node_modules/zod-to-json-schema';
import { loadSurface } from './mcpSurface';

function findRefs(node: unknown, path: string, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => findRefs(v, `${path}[${i}]`, out));
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === 'string') out.push(`${path}: $ref -> ${obj.$ref}`);
  for (const [k, v] of Object.entries(obj)) findRefs(v, `${path}.${k}`, out);
}

describe('every modoki_* tool schema is $ref-free', () => {
  it('zodToJsonSchema(tool.inputSchema) contains no $ref, for every registered tool', () => {
    const s = loadSurface();
    try {
      const offenders: string[] = [];
      for (const name of s.names) {
        const schema = s.schemaFor(name);
        if (!schema) continue; // a tool with no params has nothing to dedupe
        const json = zodToJsonSchema(schema as never);
        const refs: string[] = [];
        findRefs(json, name, refs);
        offenders.push(...refs);
      }
      expect(
        offenders,
        'A $ref means two sibling params share one zod schema OBJECT by reference — make the ' +
        'shared piece a factory (see makeEntitySpec/makePointSpec/makeDndEndpoint in shapes.ts) ' +
        'so every field, all the way down, is built fresh per call.',
      ).toEqual([]);
    } finally {
      s.restore();
    }
  });
});
