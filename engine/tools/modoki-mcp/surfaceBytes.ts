/** What the MCP tool surface COSTS, measured once and shared by everything that reports on it.
 *
 *  `DEFINITION_BYTES` in `engine/tests/tools/mcpRegistry.test.ts` is the gate: every agent that
 *  connects Claude Code to a packaged editor pays these bytes in its context window every session,
 *  before asking for anything, because `engine/electron/connectClaude.ts` writes this server into
 *  the user's `.mcp.json`. That guard stays exactly as it is.
 *
 *  This module exists for the OTHER half (#894): the gate is a single scalar, so it can say the
 *  surface grew but never WHO grew it — six clones each stay inside the 4,000-byte headroom alone
 *  and whoever crosses first inherits the union. `perToolBytes()` gives the per-tool breakdown a
 *  ledger needs.
 *
 *  ⚠️ **The ledger and the gate MUST measure identically**, or the ledger is a lie with a tooltip:
 *  rows that do not sum to the pinned number look authoritative while quietly disagreeing with the
 *  thing they explain. That is why the pin test drives `perToolBytes()` too rather than keeping its
 *  own inline loop — the same reasoning as `gen-tool-catalog.ts` sharing `renderCatalog()` with its
 *  sync guard (conventions §9): a second implementation is free to drift, and would.
 *
 *  ⚠️ Do NOT build this on `dump-surface.mjs`'s `sumDescriptionBytes`. That one deliberately
 *  EXCLUDES property names ("a property's own name is structure here, not narrated text") because
 *  it prices documentation prose; `DEFINITION_BYTES` INCLUDES them because it prices the whole
 *  advertised surface. The two answer different questions and must not be swapped.
 *
 *  Lives at the package root, not under `src/`, on purpose: `src/**` is what builds into the
 *  shipped `dist/index.js` that `mcpBundle.test.ts` pins byte-for-byte, and this is tooling. */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createToolContext } from './src/context.js';
import { registerAllTools } from './src/registerAll.js';
import { clearRegistry, getTool, toolNames } from './src/registry.js';

/** Recursively sums every `description` string AND every property NAME beneath a JSON-Schema node.
 *
 *  Both halves are bytes the agent is billed for, which is the measurement `DEFINITION_BYTES`
 *  wants. Moved here from `engine/tests/tools/mcpSurface.ts` (which now re-exports it) so the
 *  ledger and the gate cannot drift apart; the `sumSchemaBytes walk` describe-block in
 *  `mcpRegistry.test.ts` still drives the branches the real surface never exercises. */
export const sumSchemaBytes = (node: unknown): number => {
  if (Array.isArray(node)) {
    let bytes = 0;
    for (const v of node) bytes += sumSchemaBytes(v);
    return bytes;
  }
  if (!node || typeof node !== 'object') return 0;
  const n = node as Record<string, unknown>;
  let bytes = 0;
  if (typeof n.description === 'string') bytes += n.description.length;
  if (n.properties && typeof n.properties === 'object') {
    for (const [key, value] of Object.entries(n.properties as Record<string, unknown>)) {
      bytes += key.length + sumSchemaBytes(value);
    }
  }
  if (n.patternProperties && typeof n.patternProperties === 'object') {
    for (const [key, value] of Object.entries(n.patternProperties as Record<string, unknown>)) {
      bytes += key.length + sumSchemaBytes(value);
    }
  }
  if (n.items) bytes += sumSchemaBytes(n.items);
  if (n.prefixItems) bytes += sumSchemaBytes(n.prefixItems);
  if (n.anyOf) bytes += sumSchemaBytes(n.anyOf);
  if (n.oneOf) bytes += sumSchemaBytes(n.oneOf);
  if (n.allOf) bytes += sumSchemaBytes(n.allOf);
  if (n.not) bytes += sumSchemaBytes(n.not);
  if (n.propertyNames) bytes += sumSchemaBytes(n.propertyNames);
  if (n.additionalProperties && typeof n.additionalProperties === 'object') {
    bytes += sumSchemaBytes(n.additionalProperties);
  }
  return bytes;
};

/** One registered tool's cost: its description plus everything in its input schema. */
export function toolBytes(name: string): number {
  const entry = getTool(name);
  if (!entry) throw new Error(`no such tool in the registry: ${name}`);
  return entry.description.length + sumSchemaBytes(zodToJsonSchema(z.object(entry.shape)));
}

/** Register the whole surface and price every tool. Sorted by name so a ledger diff is stable.
 *
 *  ⚠️ Clears and repopulates the module-level registry, exactly as `loadSurface()` does. A caller
 *  inside vitest must therefore treat it like `loadSurface()` and not assume an unrelated
 *  registration survives it.
 *
 *  Registration alone touches no backend — handlers fetch, and none are called here — so this runs
 *  outside vitest with no stubbing, which is what lets `gen-surface-ledger.ts` be a plain script. */
export function perToolBytes(): Map<string, number> {
  clearRegistry();
  const ctx = createToolContext({ backend: 'http://127.0.0.1:1' });
  const server = {
    registerTool: () => {},
    tool: () => {
      throw new Error('registered via the legacy server.tool() overload — conventions §1');
    },
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, ctx);
  const out = new Map<string, number>();
  for (const name of [...toolNames()].sort()) out.set(name, toolBytes(name));
  return out;
}

/** The single number `DEFINITION_BYTES` pins — by construction the sum of the rows above. */
export function surfaceBytes(perTool: Map<string, number> = perToolBytes()): number {
  let total = 0;
  for (const bytes of perTool.values()) total += bytes;
  return total;
}
