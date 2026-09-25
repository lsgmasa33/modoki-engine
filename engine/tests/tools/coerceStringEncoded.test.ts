/** String-encoded tool args are DECODED, not refused (#1560; docs/mcp-tool-conventions.md §1).
 *
 *  Agents send `"limit":"12"`, `"bounds":"1"` and `"entity":"{\"name\":…}"`, and each used to cost
 *  a refusal + a re-send. Covered at every layer the decoding has to reach:
 *  - the decoder and the schema-guided walk, in BOTH zod dialects (editor = 3, device = 4);
 *  - each server's registration installs it (the harnesses go through the same SDK seam);
 *  - `modoki_batch`'s pre-flight, which must hand the DECODED args to the step;
 *  - the real SDK, which must actually validate through the seam `installArgCoercion` wraps;
 *  - a game tool's op-side validator, the one path that has no zod schema. */

import { describe, it, expect, afterEach } from 'vitest';
import { z as z3 } from '../../tools/modoki-mcp/node_modules/zod';
import { z as z4 } from '../../tools/game-debug-mcp/node_modules/zod';
import { McpServer as McpServer3 } from '../../tools/modoki-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import { Client as Client3 } from '../../tools/modoki-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport as InMemory3 } from '../../tools/modoki-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { McpServer as McpServer4 } from '../../tools/game-debug-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import { Client as Client4 } from '../../tools/game-debug-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport as InMemory4 } from '../../tools/game-debug-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { coerceStringEncoded, decodeStringEncoded, installArgCoercion, NOT_DECODED } from '../../tools/shared/coerceArgs';
import { coerceAgentToolArgs, validateAgentToolArgs, registerAgentTool, unregisterAgentTool, type AgentToolDef } from '@modoki/engine/runtime';
import { runAgentOp } from '../../app/debug/agentBridge';
import { setDebugMenuEnabled, isDebugMenuEnabled } from '../../packages/modoki/src/runtime/debug/debugMenuRegistry';
import { loadSurface, type Surface } from './mcpSurface';
import { loadDeviceSurface, type DeviceSurface } from './deviceSurface';
import { runBatch } from '../../tools/modoki-mcp/src/batch';

let surface: Surface | undefined;
let device: DeviceSurface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; device?.restore(); device = undefined; });

describe('decodeStringEncoded — lossless cases only', () => {
  it.each([
    ['12', 'number', 12], ['-0.5', 'number', -0.5], ['1e3', 'number', 1000], [' 7 ', 'number', 7],
    ['true', 'boolean', true], ['false', 'boolean', false],
    ['{"name":"Btn"}', 'object', { name: 'Btn' }], ['[1,2]', 'array', [1, 2]],
    ['{"a":1}', 'unknown', { a: 1 }], ['3', 'unknown', 3],
  ] as const)('%j as %s → %j', (raw, want, out) => {
    expect(decodeStringEncoded(raw, want)).toEqual(out);
  });

  it.each([
    ['12abc', 'number'], ['', 'number'], ['12345678901234567890', 'number'], ['0x1f', 'number'], ['Infinity', 'number'], ['NaN', 'number'],
    ['yes', 'boolean'], ['1', 'boolean'], ['TRUE', 'boolean'],
    ['[1]', 'object'], ['{"a":1}', 'array'], ['{bad json', 'object'], ['null', 'object'], ['Btn', 'object'],
  ] as const)('%j as %s is NOT decoded', (raw, want) => {
    expect(decodeStringEncoded(raw, want)).toBe(NOT_DECODED);
  });
});

/** Both dialects typed as one — see unknownParamRefusal.test.ts for why the cast is compile-only. */
const DIALECTS = [['zod 3', z3], ['zod 4', z4 as unknown as typeof z3]] as const;

describe.each(DIALECTS)('coerceStringEncoded (%s)', (_label, z) => {
  const schema = z.object({
    limit: z.number().int().optional(),
    world: z.boolean().optional(),
    name: z.string().optional(),
    ids: z.union([z.string(), z.array(z.string())]).optional(),
    entity: z.object({ name: z.string().optional(), guid: z.string().optional() }).strict().optional(),
    from: z.union([z.object({ x: z.number(), y: z.number() }).strict(), z.object({ selector: z.string() }).strict()]).optional(),
    tags: z.array(z.string()).optional(),
  }).strict();

  it('decodes a number, a boolean, an object, a union member and an array', () => {
    const out = coerceStringEncoded(schema, {
      limit: '12', world: 'true', entity: '{"name":"Btn"}', from: '{"x":1,"y":2}', tags: '["a","b"]',
    });
    expect(out).toEqual({ limit: 12, world: true, entity: { name: 'Btn' }, from: { x: 1, y: 2 }, tags: ['a', 'b'] });
    expect(schema.safeParse(out).success).toBe(true);
  });

  it('decodes INSIDE a decoded object (a nested encoded value takes a second pass)', () => {
    const outer = z.object({ from: z.object({ x: z.number(), y: z.number() }).strict() }).strict();
    expect(coerceStringEncoded(outer, { from: '{"x":"1","y":2}' })).toEqual({ from: { x: 1, y: 2 } });
  });

  it('never rewrites a field that TAKES a string — a plain string, or a string|array union', () => {
    const args = { name: '12', ids: '["a"]' };
    expect(coerceStringEncoded(schema, args)).toBe(args); // same reference: nothing touched
  });

  it('leaves an undecodable value for the strict parse to refuse — and the caller\'s object unmutated', () => {
    const args = { limit: '12abc', world: 'yes' };
    const out = coerceStringEncoded(schema, args);
    expect(out).toBe(args);
    expect(schema.safeParse(out).success).toBe(false);
  });

  it('a decoded object is still STRICT — a typo inside it is refused, not dropped', () => {
    const out = coerceStringEncoded(schema, { entity: '{"nme":"Btn"}' });
    expect(out).toEqual({ entity: { nme: 'Btn' } });
    const r = schema.safeParse(out);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/nme/);
  });

  it('decodes only the failing field, not its valid neighbours', () => {
    const args = { limit: 3, world: 'false' };
    const out = coerceStringEncoded(schema, args);
    expect(out).toEqual({ limit: 3, world: false });
    expect(args.world).toBe('false');
  });
});

describe('each server decodes on the wire', () => {
  it('editor: modoki_get_console_logs {limit:"12"} sends limit=12 (registerAllTools installs it)', async () => {
    const s = (surface = loadSurface());
    await s.call('modoki_get_console_logs', { limit: '12' });
    expect(s.last()!.path).toMatch(/[?&]limit=12(&|$)/);
  });

  it('device: device_get_scene_state {world:"true"} relays world:true (registerTools installs it)', async () => {
    const d = (device = await loadDeviceSurface((req) =>
      req.path === '/api/device/request' ? { body: { ok: true, result: { returnedCount: 0, totalCount: 0, entities: [] } } } : undefined));
    await d.call('device_get_scene_state', { name: 'Player', world: 'true' });
    const sent = d.real().find((r) => r.path === '/api/device/request');
    expect(sent?.body).toMatchObject({ method: 'scene-state', params: { name: 'Player', world: true } });
  });

  it('device: a JSON-encoded aim object validates as the object (the transcripts\' own shape)', async () => {
    const d = (device = await loadDeviceSurface());
    expect(d.validate('device_tap', { entity: '{"name":"Btn"}' })).toEqual({ ok: true });
  });

  // #1560 review: the raw-x/y ban ran on the ENCODED args, so `"100"` was not a number to it — the
  // step then decoded into exactly the raw-coordinate tap the rule refuses.
  it.each([
    ['modoki_tap', { x: '100', y: '200' }],
    ['modoki_drag', { from: '{"x":1,"y":2}', to: '{"x":30,"y":40}' }],
    ['modoki_tap', { entity: '{}', x: '100', y: '200' }],
  ] as const)('batch: an ENCODED raw x/y on %s is still refused, and nothing runs', async (tool, args) => {
    const s = (surface = loadSurface());
    const r = await runBatch({ steps: [{ tool, args: args as Record<string, unknown> }] }, { sleep: async () => {} });
    expect('rejected' in r && r.rejected).toMatch(/raw .* aiming is not allowed inside a batch/);
    expect(s.requests.filter((q) => q.path.startsWith('/api/input/'))).toEqual([]);
  });

  it('batch: an ENCODED endpoint holding two addresses is still AMBIGUOUS up front (#1556 × #1560)', async () => {
    const s = (surface = loadSurface());
    const r = await runBatch({ steps: [{ tool: 'modoki_drag', args: {
      from: '{"entity":{"name":"A","surface":"game-2d"},"selector":"#a"}', to: { selector: '#b' },
    } }] }, { sleep: async () => {} });
    expect('rejected' in r && r.rejected).toMatch(/AMBIGUOUS/);
    expect(s.requests.filter((q) => q.path.startsWith('/api/input/'))).toEqual([]);
  });

  it('batch: the wait pseudo-step decodes its ms too', async () => {
    surface = loadSurface();
    const slept: number[] = [];
    const r = await runBatch({ steps: [{ tool: 'wait', args: { ms: '5' } }] }, { sleep: async (ms: number) => { slept.push(ms); } });
    expect('rejected' in r).toBe(false);
    expect(slept).toEqual([5]);
  });

  it('batch: a step with an encoded number runs with the DECODED value', async () => {
    // A JSON-BODY param, not a query one: a query string stringifies the value either way, so a step
    // that ran on the raw "0.5" would send the same URL and this could not fail.
    const s = (surface = loadSurface());
    const r = await runBatch({ steps: [{ tool: 'modoki_set_timescale', args: { scale: '0.5' } }] }, { sleep: async () => {} });
    expect('rejected' in r).toBe(false);
    expect(s.last()!.body).toMatchObject({ action: 'set-timescale', scale: 0.5 });
  });
});

/** The harnesses prove the registration installs the hook; only the real SDK can prove the SDK
 *  validates THROUGH the method the hook wraps. Pinned per SDK copy, since each server bundles its own. */
describe.each([
  ['editor SDK + zod 3', McpServer3, Client3, InMemory3, z3],
  ['device SDK + zod 4', McpServer4, Client4, InMemory4, z4 as unknown as typeof z3],
] as const)('the real SDK validates through the wrapped seam (%s)', (_label, McpServer, Client, InMemory, z) => {
  async function roundTrip(args: Record<string, unknown>, install: boolean) {
    // One structural type for both SDK copies — a union of the two classes makes every method uncallable to tsc.
    const server = new McpServer({ name: 't', version: '0' }) as unknown as InstanceType<typeof McpServer3>;
    if (install) installArgCoercion(server);
    let seen: unknown;
    server.registerTool('t', { inputSchema: z.object({ n: z.number() }).strict() as never }, (async (a: unknown) => {
      seen = a;
      return { content: [{ type: 'text', text: 'ok' }] };
    }) as never);
    const [ct, st] = (InMemory as typeof InMemory3).createLinkedPair();
    const client = new Client({ name: 'c', version: '0' }) as unknown as InstanceType<typeof Client3>;
    await Promise.all([server.connect(st), client.connect(ct)]);
    const res = await client.callTool({ name: 't', arguments: args });
    await client.close();
    return { res: res as { isError?: boolean }, seen };
  }

  it('decodes {n:"12"} to 12 before the handler runs', async () => {
    const { res, seen } = await roundTrip({ n: '12' }, true);
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual({ n: 12 });
  });

  it('without the hook the same call is refused — so the pass above is the hook, not the SDK', async () => {
    const { res } = await roundTrip({ n: '12' }, false);
    expect(res.isError).toBe(true);
  });

  it('refuses loudly on a server with no validateToolInput', () => {
    expect(() => installArgCoercion({})).toThrow(/validateToolInput/);
  });
});

describe('a game tool\'s op-side validator decodes against its declaration', () => {
  const def = {
    name: 'demo_tool', description: 'd',
    params: { n: { type: 'number', int: true }, on: { type: 'boolean' }, label: { type: 'string' } },
    handler: () => ({}),
  } as unknown as AgentToolDef;

  it('"3" → 3 and "true" → true; a declared string is left alone', () => {
    const out = coerceAgentToolArgs(def, { n: '3', on: 'true', label: '12' });
    expect(out).toEqual({ n: 3, on: true, label: '12' });
    expect(validateAgentToolArgs(def, out)).toBeNull();
  });

  it('the game-tool-call op decodes before the handler runs (every caller, device_game_tool_call included)', async () => {
    let seen: unknown;
    const wasEnabled = isDebugMenuEnabled();
    setDebugMenuEnabled(true); // agent tools are suppressed with the debug menu off
    registerAgentTool({ ...def, name: 'coerce_probe', handler: (a: Record<string, unknown>) => { seen = a; return { ok: true }; } } as AgentToolDef);
    try {
      const reply = await runAgentOp('game-tool-call', { name: 'coerce_probe', args: { n: '4', on: 'false' } });
      expect(reply).toEqual({ ok: true });
      expect(seen).toEqual({ n: 4, on: false });
    } finally {
      unregisterAgentTool('coerce_probe');
      setDebugMenuEnabled(wasEnabled);
    }
  });

  it('an undecodable value still refuses, naming the param', () => {
    const args = { n: '3x' };
    expect(coerceAgentToolArgs(def, args)).toBe(args);
    expect(validateAgentToolArgs(def, args)).toMatch(/'n' must be a number/);
  });
});

/** The op-side decoder is a COPY (the MCP packages import nothing from the engine) — one table for both. */
describe('the op-side copy agrees with decodeStringEncoded', () => {
  const numDef = { name: 'x', description: 'd', params: { v: { type: 'number' } }, handler: () => ({}) } as unknown as AgentToolDef;
  const boolDef = { name: 'x', description: 'd', params: { v: { type: 'boolean' } }, handler: () => ({}) } as unknown as AgentToolDef;
  it.each(['12', '-0.5', '1e3', ' 7 ', '12abc', '', '0x1f', 'Infinity', '.5', '5.', '12345678901234567890', '9007199254740991'])('number %j', (raw) => {
    const shared = decodeStringEncoded(raw, 'number');
    expect(coerceAgentToolArgs(numDef, { v: raw }).v).toEqual(shared === NOT_DECODED ? raw : shared);
  });
  it.each(['true', 'false', 'yes', '1', 'TRUE', ' true '])('boolean %j', (raw) => {
    const shared = decodeStringEncoded(raw, 'boolean');
    expect(coerceAgentToolArgs(boolDef, { v: raw }).v).toEqual(shared === NOT_DECODED ? raw : shared);
  });
});
