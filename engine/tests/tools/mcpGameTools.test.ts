/** The DYNAMIC tail of the MCP surface (#270) — tools a GAME registers, materialized by
 *  `gameTools.ts` from JSON declarations served over `/api/game-tools`.
 *
 *  The static surface is guarded by contract conformance (`mcpToolContracts`) and a live sweep.
 *  Neither can see this tail: a game tool has no contract (it is defined at runtime, by the open
 *  project) and the sweep needs an editor. So the guarantees have to be pinned HERE instead, and
 *  they are the ones that decide whether the seam is trustworthy:
 *
 *    - a declaration becomes a STRICT schema, so a typo is refused rather than silently dropped —
 *      the whole reason the static surface went strict in the first place;
 *    - an unrecognised param type refuses the WHOLE tool, and says so, rather than degrading to
 *      `z.any()` for the odd param;
 *    - the advertised surface never outlives the editor backing it;
 *    - a CHANGED schema actually reaches the client, which a plain add-if-absent would not do.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { z } from '../../tools/modoki-mcp/node_modules/zod';
import { createToolContext } from '../../tools/modoki-mcp/src/context';
import { createGameToolSync, shapeFromDecl, fingerprint } from '../../tools/modoki-mcp/src/gameTools';
import { registerAllTools } from '../../tools/modoki-mcp/src/registerAll';
import { clearRegistry, getTool, toolNames } from '../../tools/modoki-mcp/src/registry';
import { validateAgentToolArgs, type AgentToolDef } from '../../packages/modoki/src/runtime/debug/agentToolRegistry';

const STUB = 'http://stub.modoki.test';

type Decl = { name: string; description: string; mutates: boolean; requiresPlaying?: boolean; params?: Record<string, unknown> };

/** A harness whose `registerTool` returns a REAL removable handle — unlike `mcpSurface`'s fake,
 *  which never needs one because the static surface never unregisters. */
function harness(reply: () => { status?: number; body?: unknown }) {
  clearRegistry();
  const registered = new Map<string, { description: string; inputSchema: unknown }>();
  const calls: { path: string; method: string; body: unknown }[] = [];

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = String(input).slice(STUB.length);
    calls.push({ path, method: (init?.method ?? 'GET').toUpperCase(), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (path === '/api/game-tools') {
      const r = reply();
      return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, echoed: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));

  const server = {
    // Throws on a duplicate, because the REAL SDK does (`mcp.js`: "Tool ${name} is already
    // registered"). A permissive fake would let `defineTool` be reordered so the registry entry
    // is written before the transport one — leaving, in production, a registry tool the client
    // never sees — while this suite stayed green. That is the mock-drift that shipped a dead
    // trusted-input path once already (docs/trusted-device-input.md).
    registerTool: vi.fn((name: string, config: { description: string; inputSchema: unknown }) => {
      if (registered.has(name)) throw new Error(`Tool ${name} is already registered`);
      registered.set(name, config);
      return { remove: () => { registered.delete(name); } };
    }),
  } as never;

  const ctx = createToolContext({ backend: STUB });
  return { sync: createGameToolSync(server, ctx), registered, calls };
}

/** The static surface needs a server too, and it must share nothing with the harness's fake beyond
 *  being a valid sink — the assertions here are about the REGISTRY, which both write into. */
const server2 = (_h: ReturnType<typeof harness>) => ({ registerTool: () => ({ remove: () => {} }) }) as never;

afterEach(() => { vi.unstubAllGlobals(); clearRegistry(); });

const decl = (over: Partial<Decl> = {}): Decl => ({
  name: 'court_load_level',
  description: 'load a level',
  mutates: true,
  params: { levelId: { type: 'string', description: 'the guid' } },
  ...over,
});

describe('shapeFromDecl', () => {
  it('builds optional-by-default params of each supported type', () => {
    const shape = shapeFromDecl({
      s: { type: 'string', description: 'a' },
      n: { type: 'number', description: 'b' },
      b: { type: 'boolean', description: 'c' },
    })!;
    const parsed = z.object(shape).strict().safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('honours required', () => {
    const shape = shapeFromDecl({ s: { type: 'string', description: 'a', required: true } })!;
    expect(z.object(shape).strict().safeParse({}).success).toBe(false);
    expect(z.object(shape).strict().safeParse({ s: 'x' }).success).toBe(true);
  });

  it('enforces an enum', () => {
    const shape = shapeFromDecl({ t: { type: 'string', description: 'track', enum: ['easy', 'hard'] } })!;
    expect(z.object(shape).strict().safeParse({ t: 'hard' }).success).toBe(true);
    expect(z.object(shape).strict().safeParse({ t: 'brutal' }).success).toBe(false);
  });

  it('enforces int', () => {
    const shape = shapeFromDecl({ i: { type: 'number', description: 'idx', int: true } })!;
    expect(z.object(shape).strict().safeParse({ i: 3 }).success).toBe(true);
    expect(z.object(shape).strict().safeParse({ i: 3.5 }).success).toBe(false);
  });

  // The `z.any()` temptation. Degrading one unknown param would make a game tool the single place
  // on the surface where an unrecognised key sails through — reintroducing exactly the bug that
  // made every engine tool strict (`registerAll.ts`: `set_selection {name:…}` cleared the human's
  // selection and reported ok).
  it('refuses the WHOLE tool on an unrecognised param type', () => {
    expect(shapeFromDecl({ ok: { type: 'string', description: 'a' }, bad: { type: 'object', description: 'b' } as never })).toBeNull();
  });
});

// ── The declaration has TWO implementations, and they must agree ──────────────────────────
//
// `shapeFromDecl` rebuilds a zod shape (that is what puts a real schema in the tool list, and it
// is what the EDITOR MCP validates with); `validateAgentToolArgs` is the engine-side enforcement
// every OTHER caller inherits — curl, device_eval, the device relays. One declaration, two
// validators, no shared code: exactly the shape that drifts, and the drift would be invisible
// because each half is tested against itself. A call accepted on one path and refused on the
// other is the bug this table exists to catch.
describe('the zod rebuild and the op-side validator agree', () => {
  const DECL = {
    levelId: { type: 'string' as const, description: 'guid' },
    track: { type: 'string' as const, description: 'ladder', enum: ['easy', 'hard'] },
    index: { type: 'number' as const, description: 'position', int: true },
    ratio: { type: 'number' as const, description: 'any number' },
    settle: { type: 'boolean' as const, description: 'wait' },
    must: { type: 'string' as const, description: 'required', required: true },
  };
  const def = { name: 'court_x', description: 'd', mutates: false, params: DECL, handler: async () => ({}) } as AgentToolDef;
  const shape = shapeFromDecl(DECL as never)!;

  const CASES: Array<[string, Record<string, unknown>]> = [
    ['everything valid', { must: 'a', levelId: 'g', track: 'hard', index: 3, ratio: 1.5, settle: true }],
    ['only the required one', { must: 'a' }],
    ['required missing', {}],
    ['unknown key', { must: 'a', nope: 1 }],
    ['typo of a real key', { must: 'a', trak: 'hard' }],
    ['enum value not in the list', { must: 'a', track: 'brutal' }],
    ['int given a fraction', { must: 'a', index: 2.5 }],
    ['number given a string', { must: 'a', ratio: '1.5' }],
    ['boolean given a string', { must: 'a', settle: 'yes' }],
    ['string given a number', { must: 'a', levelId: 7 }],
    ['required given a number', { must: 7 }],
    ['NaN for a number', { must: 'a', ratio: Number.NaN }],
  ];

  it.each(CASES)('agrees on: %s', (_label, args) => {
    const zodOk = z.object(shape).strict().safeParse(args).success;
    const opOk = validateAgentToolArgs(def, args) === null;
    expect(opOk, `zod says ${zodOk ? 'accept' : 'reject'}, the op validator says ${opOk ? 'accept' : 'reject'}`).toBe(zodOk);
  });
});

describe('fingerprint', () => {
  it('is order-independent', () => {
    const a = decl({ name: 'court_a' }); const b = decl({ name: 'court_b' });
    expect(fingerprint([a, b] as never)).toBe(fingerprint([b, a] as never));
  });

  // Why it hashes declarations instead of trusting the renderer's `version`: that counter is
  // per-renderer and resets to 0 on the page reload that every game `.ts` save triggers, so a
  // genuine change can move it BACKWARDS.
  it('changes when a schema changes in place, with the name unchanged', () => {
    const before = fingerprint([decl()] as never);
    const after = fingerprint([decl({ params: { levelId: { type: 'string', description: 'the guid' }, index: { type: 'number', description: 'i' } } })] as never);
    expect(after).not.toBe(before);
  });
});

describe('sync', () => {
  it('registers a declared tool as a real, strict MCP tool', async () => {
    const h = harness(() => ({ body: { version: 1, tools: [decl()] } }));
    const r = await h.sync.refresh();
    expect(r.registered).toEqual(['court_load_level']);
    expect(toolNames()).toContain('court_load_level');

    // Strict: an unknown key is refused, not stripped.
    const schema = h.registered.get('court_load_level')!.inputSchema as z.ZodTypeAny;
    expect(schema.safeParse({ levelId: 'x' }).success).toBe(true);
    expect(schema.safeParse({ levelid: 'x' }).success).toBe(false);
  });

  it('marks provenance and mutation in the description the model reads', async () => {
    const h = harness(() => ({ body: { version: 1, tools: [decl(), decl({ name: 'court_level_info', mutates: false })] } }));
    await h.sync.refresh();
    expect(h.registered.get('court_load_level')!.description).toMatch(/game tool, MUTATES/);
    expect(h.registered.get('court_level_info')!.description).toMatch(/\[game tool\]/);
  });

  it('routes a call to /api/game-tool-call with the tool name and args', async () => {
    const h = harness(() => ({ body: { version: 1, tools: [decl()] } }));
    await h.sync.refresh();
    await getTool('court_load_level')!.handler({ levelId: 'abc' });
    const post = h.calls.find((c) => c.path === '/api/game-tool-call');
    expect(post).toBeDefined();
    expect(post!.method).toBe('POST');
    expect(post!.body).toEqual({ name: 'court_load_level', args: { levelId: 'abc' } });
  });

  it('refuses a tool whose param type it cannot build, and keeps the others', async () => {
    const h = harness(() => ({ body: { version: 1, tools: [decl(), decl({ name: 'court_bad', params: { x: { type: 'blob', description: 'b' } } })] } }));
    const r = await h.sync.refresh();
    expect(r.registered).toEqual(['court_load_level']);
    expect(Object.keys(r.refused)).toEqual(['court_bad']);
    expect(r.refused.court_bad).toMatch(/parameter type/);
  });

  it('refuses a duplicate name instead of dying, keeping the first', async () => {
    // `registerTool` throws on a duplicate — correct, and it must not take the whole poll with it.
    const h = harness(() => ({ body: { version: 1, tools: [decl(), decl({ name: 'court_dup' }), decl({ name: 'court_dup' })] } }));
    const r = await h.sync.refresh();
    expect(r.registered).toEqual(['court_load_level', 'court_dup']);
    expect(r.refused.court_dup).toMatch(/already registered|duplicate/i);
  });

  it('refuses a declaration that would SHADOW an engine tool', async () => {
    // The engine's own registry throws on a `modoki_` name, so this should be unreachable from a
    // well-behaved game — but this server also talks to older editors and to the device surface,
    // and "unreachable" is not a guarantee. The engine tool must win, and the game must be told.
    // Registering the static surface first is what makes the collision real rather than theoretical.
    const h = harness(() => ({ body: { version: 1, tools: [decl({ name: 'modoki_tap' })] } }));
    registerAllTools({ registerTool: () => ({ remove: () => {} }) } as never, createToolContext({ backend: STUB }));
    const r = await h.sync.refresh();
    expect(r.registered).toEqual([]);
    expect(r.refused.modoki_tap).toMatch(/already registered|duplicate/i);
    // And the ENGINE's tool is still the one on the registry.
    expect(getTool('modoki_tap')).toBeDefined();
  });

  // Hysteresis (#475, Phase 2): a page reload from a game-code edit takes the renderer down and
  // back within a handful of polls, and tearing down on the first miss turns that blip into a
  // `tools/list_changed` — which invalidates the whole prompt cache, since `tools` renders first
  // in the cache prefix. So teardown now waits for UNREACHABLE_GRACE_POLLS consecutive misses.
  it('does NOT drop game tools on a single unreachable poll', async () => {
    let up = true;
    const h = harness(() => (up ? { body: { version: 1, tools: [decl()] } } : { status: 504, body: { error: 'no renderer' } }));
    await h.sync.refresh();
    expect(h.sync.active()).toEqual(['court_load_level']);
    up = false;
    const r = await h.sync.refresh();
    // Still registered — this is the whole point of the grace window — and `registered` reports
    // the truth (still live), not a hardcoded [].
    expect(r.reachable).toBe(false);
    expect(r.registered).toEqual(['court_load_level']);
    expect(h.sync.active()).toEqual(['court_load_level']);
    expect(toolNames()).toContain('court_load_level');
  });

  it('drops every game tool after 3 consecutive unreachable polls', async () => {
    let up = true;
    const h = harness(() => (up ? { body: { version: 1, tools: [decl()] } } : { status: 504, body: { error: 'no renderer' } }));
    await h.sync.refresh();
    expect(h.sync.active()).toEqual(['court_load_level']);
    up = false;
    await h.sync.refresh(); // failure 1 — still held
    await h.sync.refresh(); // failure 2 — still held
    expect(h.sync.active()).toEqual(['court_load_level']);
    const r = await h.sync.refresh(); // failure 3 — teardown
    // A tool that stays advertised after its editor is gone answers 504 forever — worse than absent.
    expect(r.registered).toEqual([]);
    expect(h.sync.active()).toEqual([]);
    expect(toolNames()).not.toContain('court_load_level');
  });

  it('resets the grace counter on a success, so it takes 3 MORE misses to tear down', async () => {
    let mode: 'up' | 'down' = 'up';
    const h = harness(() => (mode === 'up' ? { body: { version: 1, tools: [decl()] } } : { status: 504, body: { error: 'no renderer' } }));
    await h.sync.refresh();
    mode = 'down';
    await h.sync.refresh(); // failure 1
    await h.sync.refresh(); // failure 2
    mode = 'up';
    await h.sync.refresh(); // a success — resets the counter
    expect(h.sync.active()).toEqual(['court_load_level']);
    mode = 'down';
    await h.sync.refresh(); // failure 1 (post-reset)
    await h.sync.refresh(); // failure 2 (post-reset)
    expect(h.sync.active()).toEqual(['court_load_level']);
    await h.sync.refresh(); // failure 3 (post-reset) — now it tears down
    expect(h.sync.active()).toEqual([]);
  });

  // Shrink-to-zero (#475 follow-up): a 200 carrying `{tools: []}` is a SUCCESS, not an unreachable
  // poll — measured on a live editor across a page reload, `reachable` never went false, but the
  // tool list briefly did. `onUnreachable()` alone never sees this case, because the fetch succeeds
  // and `decls` is just empty; it needs its own grace door.
  it('does NOT drop game tools on a single empty-200 poll', async () => {
    let empty = false;
    const h = harness(() => (empty ? { body: { version: 1, tools: [] } } : { body: { version: 1, tools: [decl()] } }));
    await h.sync.refresh();
    expect(h.sync.active()).toEqual(['court_load_level']);
    empty = true;
    const r = await h.sync.refresh();
    // Still registered, and reachable is TRUE — the backend answered, it just had nothing to say.
    expect(r.reachable).toBe(true);
    expect(r.registered).toEqual(['court_load_level']);
    expect(h.sync.active()).toEqual(['court_load_level']);
    expect(toolNames()).toContain('court_load_level');
  });

  it('drops every game tool after 3 consecutive empty-200 polls', async () => {
    let empty = false;
    const h = harness(() => (empty ? { body: { version: 1, tools: [] } } : { body: { version: 1, tools: [decl()] } }));
    await h.sync.refresh();
    expect(h.sync.active()).toEqual(['court_load_level']);
    empty = true;
    await h.sync.refresh(); // empty 1 — still held
    await h.sync.refresh(); // empty 2 — still held
    expect(h.sync.active()).toEqual(['court_load_level']);
    const r = await h.sync.refresh(); // empty 3 — teardown
    expect(r.registered).toEqual([]);
    expect(h.sync.active()).toEqual([]);
    expect(toolNames()).not.toContain('court_load_level');
  });

  it('a tool-bearing 200 inside the empty-window resets the counter', async () => {
    let mode: 'up' | 'empty' = 'up';
    const h = harness(() => (mode === 'up' ? { body: { version: 1, tools: [decl()] } } : { body: { version: 1, tools: [] } }));
    await h.sync.refresh();
    mode = 'empty';
    await h.sync.refresh(); // empty 1
    await h.sync.refresh(); // empty 2
    mode = 'up';
    await h.sync.refresh(); // a tool-bearing success — resets the counter
    expect(h.sync.active()).toEqual(['court_load_level']);
    mode = 'empty';
    await h.sync.refresh(); // empty 1 (post-reset)
    await h.sync.refresh(); // empty 2 (post-reset)
    expect(h.sync.active()).toEqual(['court_load_level']);
    await h.sync.refresh(); // empty 3 (post-reset) — now it tears down
    expect(h.sync.active()).toEqual([]);
  });

  // The end-to-end reload shape this whole fix exists for: 7 tools → 0 tools → 7 tools across
  // three consecutive polls (the setup() gap: renderer up, registerCourtAgentTools() not run yet).
  // Zero unregisters must happen anywhere in the sequence — that's what proves no
  // `tools/list_changed` would have fired mid-reload.
  it('survives a 7 tools → 0 tools → 7 tools reload with no teardown at any point', async () => {
    const seven = Array.from({ length: 7 }, (_, i) => decl({ name: `court_tool_${i}` }));
    let mode: 'full' | 'empty' = 'full';
    const h = harness(() => (mode === 'full' ? { body: { version: 1, tools: seven } } : { body: { version: 0, tools: [] } }));

    await h.sync.refresh();
    expect(h.sync.active().sort()).toEqual(seven.map((d) => d.name).sort());

    mode = 'empty';
    const r1 = await h.sync.refresh(); // the reload gap: 200, zero tools
    expect(r1.reachable).toBe(true);
    expect(h.sync.active().sort()).toEqual(seven.map((d) => d.name).sort());

    mode = 'full';
    const r2 = await h.sync.refresh(); // registerCourtAgentTools() has now run
    expect(r2.registered.sort()).toEqual(seven.map((d) => d.name).sort());
    // The INTERMEDIATE assertion is what proves this — `removeAll()` clears `registered`, so a
    // teardown-and-rebuild cannot leave the tools visible mid-sequence. Asserting only the final
    // state would pass vacuously, since a rebuild also ends at 7. (Handle IDENTITY is not checked.)
    for (const d of seven) expect(toolNames()).toContain(d.name);
  });

  // Guard against over-applying the grace: a non-empty schema CHANGE is not a shrink, and must
  // still reconcile on the very next poll.
  it('still reconciles a non-empty schema change immediately, without waiting on the grace window', async () => {
    let params: Record<string, unknown> = { levelId: { type: 'string', description: 'the guid' } };
    const h = harness(() => ({ body: { version: 1, tools: [decl({ params })] } }));
    await h.sync.refresh();
    expect((h.registered.get('court_load_level')!.inputSchema as z.ZodTypeAny).safeParse({ index: 2 }).success).toBe(false);
    params = { index: { type: 'number', description: 'i', int: true } };
    const r = await h.sync.refresh();
    expect(r.registered).toEqual(['court_load_level']);
    expect((h.registered.get('court_load_level')!.inputSchema as z.ZodTypeAny).safeParse({ index: 2 }).success).toBe(true);
  });

  it('stop() still tears down immediately, without waiting for the grace window', async () => {
    const h = harness(() => ({ body: { version: 1, tools: [decl()] } }));
    await h.sync.refresh();
    expect(h.sync.active()).toEqual(['court_load_level']);
    h.sync.stop();
    expect(h.sync.active()).toEqual([]);
    expect(toolNames()).not.toContain('court_load_level');
  });

  it('re-registers when a schema changes in place, so the client sees the new shape', async () => {
    let params: Record<string, unknown> = { levelId: { type: 'string', description: 'the guid' } };
    const h = harness(() => ({ body: { version: 1, tools: [decl({ params })] } }));
    await h.sync.refresh();
    expect((h.registered.get('court_load_level')!.inputSchema as z.ZodTypeAny).safeParse({ index: 2 }).success).toBe(false);
    params = { index: { type: 'number', description: 'i', int: true } };
    await h.sync.refresh();
    expect((h.registered.get('court_load_level')!.inputSchema as z.ZodTypeAny).safeParse({ index: 2 }).success).toBe(true);
  });

  it('does no work when nothing changed', async () => {
    const h = harness(() => ({ body: { version: 1, tools: [decl()] } }));
    await h.sync.refresh();
    const after = h.registered.get('court_load_level');
    await h.sync.refresh();
    // Same object ⇒ it was not torn down and rebuilt, so no spurious tools/list_changed storm.
    expect(h.registered.get('court_load_level')).toBe(after);
  });

  it('re-registers after stop() and start() — the surface is not permanently empty', async () => {
    // `stop()` tears the tail down; a later refresh must rebuild it. The fingerprint short-circuit
    // is what makes this fail if `lastPrint` outlives the registrations it describes: the
    // declarations have not changed, so "nothing to do" is exactly the wrong answer once the
    // tools have been removed.
    const h = harness(() => ({ body: { version: 1, tools: [decl()] } }));
    await h.sync.refresh();
    expect(h.sync.active()).toEqual(['court_load_level']);
    h.sync.stop();
    expect(h.sync.active()).toEqual([]);
    const r = await h.sync.refresh();
    expect(r.registered).toEqual(['court_load_level']);
    expect(toolNames()).toContain('court_load_level');
  });

  it('keeps reporting a refusal on later polls, not just the one that discovered it', async () => {
    // A caller asking "why is my tool missing?" polls refresh(). Reporting the reason only on the
    // poll that happened to notice makes every later answer an empty, and wrong, all-clear.
    const h = harness(() => ({ body: { version: 1, tools: [decl(), decl({ name: 'court_bad', params: { x: { type: 'blob', description: 'b' } } })] } }));
    expect(Object.keys((await h.sync.refresh()).refused)).toEqual(['court_bad']);
    expect(Object.keys((await h.sync.refresh()).refused)).toEqual(['court_bad']);
  });

  it('reports a malformed declaration rather than skipping it in silence', async () => {
    const h = harness(() => ({ body: { version: 1, tools: [decl(), { description: 'no name', mutates: false }] } }));
    const r = await h.sync.refresh();
    expect(r.registered).toEqual(['court_load_level']);
    expect(Object.keys(r.refused)).toHaveLength(1);
  });

  // #648 — a bare `null` element (distinct from the well-formed-but-nameless object case above)
  // used to reach `fingerprint()` BEFORE the per-element `!d` guard ever ran: `t.name` on `null`
  // threw a TypeError straight out of `refresh()`. Called directly (as here, not through `tick()`'s
  // own poll `catch`) that surfaces as a REJECTED promise — the whole surface died over one bad
  // element, breaking gameTools.ts's own stated contract ("a refused tool is reported, not dropped
  // quietly") for every well-formed declaration in the same reply.
  it('a bare null element does not take the whole poll down — valid tools still register', async () => {
    const h = harness(() => ({ body: { version: 1, tools: [decl(), null, decl({ name: 'court_b' })] } }));
    const r = await h.sync.refresh();
    expect(r.registered.sort()).toEqual(['court_b', 'court_load_level']);
    expect(Object.keys(r.refused)).toHaveLength(1);
    expect(h.sync.active().sort()).toEqual(['court_b', 'court_load_level']);
  });

  // #648 review follow-up — these two guard the FIX's own regressions, not the original bug. Both
  // need MORE THAN ONE refresh(), which is exactly why the single-call test above could not see
  // them: partitioning the malformed entries out made every downstream decision read a set that no
  // longer matched the one being reasoned about.
  it('keeps reporting a malformed declaration on a STEADY-STATE poll (it is not fingerprinted away)', async () => {
    // Fingerprinting `validDecls` alone meant a malformed element never changed the print, so the
    // `print === lastPrint` early return handed back `lastRefused` — and `refused` is rebuilt per
    // call and was never assigned. The bad declaration was therefore reported on NO poll, ever.
    let tools: unknown[] = [decl()];
    const h = harness(() => ({ body: { version: 1, tools } }));

    const first = await h.sync.refresh();
    expect(first.registered).toEqual(['court_load_level']);
    expect(Object.keys(first.refused)).toHaveLength(0);

    tools = [decl(), null];                       // the backend starts sending a bad element
    const second = await h.sync.refresh();
    expect(second.registered).toEqual(['court_load_level']);
    expect(Object.keys(second.refused), 'a malformed decl must be REPORTED, not silently dropped').toHaveLength(1);

    const third = await h.sync.refresh();         // and it must keep being reported while it persists
    expect(Object.keys(third.refused)).toHaveLength(1);

    tools = [decl()];                             // ...and stop once the backend stops sending it
    const fourth = await h.sync.refresh();
    expect(Object.keys(fourth.refused), 'a refusal must not outlive the declaration that caused it').toHaveLength(0);
    expect(fourth.registered).toEqual(['court_load_level']);
  });

  it('an ALL-malformed poll gets the shrink-to-zero grace, not an instant teardown', async () => {
    // The grace window still keyed on the raw `decls` while everything downstream keyed on
    // `validDecls`: `{tools:[null]}` has decls.length === 1, so the guard was skipped and a SINGLE
    // corrupt poll called removeAll() on every registered game tool. `{tools:[]}` would have been
    // given grace; the two are the same event as far as the usable set is concerned.
    let tools: unknown[] = [decl()];
    const h = harness(() => ({ body: { version: 1, tools } }));
    await h.sync.refresh();
    expect(h.sync.active()).toEqual(['court_load_level']);

    tools = [null];
    await h.sync.refresh();
    expect(h.sync.active(), 'one corrupt poll must not tear the surface down').toEqual(['court_load_level']);
  });

  it('two null elements are reported as TWO refusals, not collapsed into one', async () => {
    // `decls.indexOf(d)` returns the FIRST match for identical primitives, so both nulls wrote the
    // same `(malformed #0)` key and one of them vanished.
    const h = harness(() => ({ body: { version: 1, tools: [decl(), null, null] } }));
    const r = await h.sync.refresh();
    expect(r.registered).toEqual(['court_load_level']);
    expect(Object.keys(r.refused)).toHaveLength(2);
  });

  // The SEAM, and the one claim in gameTools.ts's own docblock that reading the code can only
  // make plausible: a game tool is supposed to have "a real place in modoki_batch". Batch resolves
  // a step through the REGISTRY (not CONTRACTS, which a game tool has no entry in) and re-parses
  // its args against that tool's own shape — so this is where the two halves either meet or don't.
  it('a game tool is callable INSIDE modoki_batch, and its args are validated there', async () => {
    const h = harness(() => ({ body: { version: 1, tools: [decl({ name: 'court_list_levels', mutates: false, params: { track: { type: 'string', description: 't', enum: ['easy', 'hard'] } } })] } }));
    registerAllTools(server2(h), createToolContext({ backend: STUB }));
    await h.sync.refresh();

    const ok = await getTool('modoki_batch')!.handler({ steps: [{ tool: 'court_list_levels', args: { track: 'hard' } }] });
    const okText = ok.content.map((c) => c.text).join('\n');
    expect(okText).not.toMatch(/unknown tool/);
    expect(h.calls.some((c) => c.path === '/api/game-tool-call')).toBe(true);

    // …and the batch pre-flight refuses a bad arg for a game tool exactly as it does for an engine
    // one — the strict shape came from the declaration, so this is the rebuilt schema doing work.
    const bad = await getTool('modoki_batch')!.handler({ steps: [{ tool: 'court_list_levels', args: { trak: 'hard' } }] });
    expect(bad.content.map((c) => c.text).join('\n')).toMatch(/trak|unrecognized|unknown/i);
  });

  it('treats an empty tool list as a normal answer, not a failure', async () => {
    const h = harness(() => ({ body: { version: 0, tools: [] } }));
    const r = await h.sync.refresh();
    expect(r.reachable).toBe(true);
    expect(r.registered).toEqual([]);
  });

  it('reports the backend as unreachable when it is, so the poll can back off', async () => {
    const h = harness(() => ({ status: 504, body: { error: 'no renderer' } }));
    expect((await h.sync.refresh()).reachable).toBe(false);
  });
});
