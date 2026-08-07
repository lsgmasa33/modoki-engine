/** Phase 6 — QUERY-PARAM PARITY: every param a GET tool can send is actually READ by its route.
 *
 *  WHY THIS EXISTS. A route builds its params by allowlisting query keys (`query.get('trait')`, …),
 *  so a param the TOOL sends that the ROUTE never looks at is silently dropped: the call succeeds,
 *  the answer is the unfiltered one, and nothing anywhere says the filter was ignored. That is the
 *  worst shape of bug on this surface — a wrong answer reported as a right one — and it has shipped
 *  TWICE (S2.17 `get_layout_bounds`' `guids`/`name`; the `resources` flag before it). Reviewing the
 *  route and the tool side by side is exactly the manual diff that missed both.
 *
 *  HOW. For each GET tool: fill EVERY parameter with a synthesized value, call the real handler
 *  against a stub backend, take the query string it actually produced, then feed that query to the
 *  real router through a recording `URLSearchParams` — "read" means the route called `get`/`has`/
 *  `getAll` for that key. No source scanning, no hand-written table: both sides are observed.
 *
 *  Note what this does NOT prove: that the route USES the value correctly. It proves only that the
 *  key is not thrown away, which is the failure mode that hides.
 */

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import { z } from '../../tools/modoki-mcp/node_modules/zod';
import { CONTRACTS } from '../../tools/modoki-mcp/src/contracts';
import { getTool } from '../../tools/modoki-mcp/src/registry';
import { loadSurface, realRequests, type Surface } from './mcpSurface';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';

/** Routes NOT owned by `editorBackendRouter` — the long-running SSE endpoints live in
 *  `vite-asset-scanner.ts` / the Electron host, so this harness cannot reach them and their params
 *  are covered by their own tests. Shrink-only: a route that moves INTO the router should be
 *  deleted from here, and a new entry needs a reason. */
const NOT_ROUTER_OWNED = new Set<string>([
  '/api/build',
  '/api/add-native-target',
  '/api/ota/publish',
]);

/** A plausible value per zod type, so every optional param is exercised rather than defaulted
 *  away. A fixture that passes nothing tests nothing — the same rule `minimalArgs` follows, in
 *  reverse. */
function synth(t: unknown, depth = 0): unknown {
  const def = (t as { _def?: Record<string, unknown> })._def;
  switch (def?.typeName as string | undefined) {
    case 'ZodOptional': case 'ZodNullable': case 'ZodDefault':
      return synth((def as { innerType: unknown }).innerType, depth);
    case 'ZodString': return 'probe';
    case 'ZodNumber': return 1;
    case 'ZodBoolean': return true;
    case 'ZodEnum': return (def as { values: string[] }).values[0];
    case 'ZodArray': return depth > 2 ? [] : [synth((def as { type: unknown }).type, depth + 1)];
    case 'ZodObject': {
      const shape = (def as { shape: () => Record<string, unknown> }).shape();
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(shape)) out[k] = synth(v, depth + 1);
      return out;
    }
    case 'ZodUnion': return synth((def as { options: unknown[] }).options[0], depth);
    case 'ZodLiteral': return (def as { value: unknown }).value;
    case 'ZodRecord': return { probe: 'probe' };
    default: return 'probe';
  }
}

/** `URLSearchParams` that records which keys the route looked at. */
function recordingQuery(qs: string) {
  const real = new URLSearchParams(qs);
  const read = new Set<string>();
  const proxy = {
    get: (k: string) => { read.add(k); return real.get(k); },
    has: (k: string) => { read.add(k); return real.has(k); },
    getAll: (k: string) => { read.add(k); return real.getAll(k); },
    keys: () => real.keys(),
    values: () => real.values(),
    entries: () => real.entries(),
    forEach: (f: Parameters<URLSearchParams['forEach']>[0]) => real.forEach(f),
    toString: () => real.toString(),
    [Symbol.iterator]: () => real[Symbol.iterator](),
  } as unknown as URLSearchParams;
  return { proxy, read, keys: [...new Set([...real.keys()])] };
}

function routerCtx(): BackendContext {
  return {
    projectRoot: os.tmpdir(),
    resolveAssetPath: (p: string) => p,
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    requestBrowser: async () => ({ ok: true }),
    getSchema: () => undefined,
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

let surface: Surface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; });

type Row = { tool: string; route: string; sent: string[]; unread: string[] };

/** modoki_profiler cannot be measured by the generic sweep above, and the reason is worth stating:
 *  the synth strategy fills EVERY param, producing `{action:'read', markers:1, limit:1}` — and the
 *  tool's own (correct) cross-action guard refuses `limit` on action:'read' before any HTTP request
 *  happens. So it lands in `notReached` and `/api/profiler`'s query parsing is exercised by nothing.
 *
 *  A correct guard silently disabling a different guard is exactly the interaction this file exists
 *  to catch, so the per-action combinations are asserted explicitly here. Without this, a typo'd
 *  `query.get('makrers')` in the route would sail through `npm test`, `getParamParity`, AND the live
 *  smoke run (which asserts the shape of `worst`, not its length). Found in the #166 P6 close-out. */
describe('modoki_profiler: the route READS the params the tool sends (the sweep cannot reach it)', () => {
  for (const [label, args, expectRead] of [
    ['action:read + markers', { action: 'read', markers: 3 }, ['action', 'markers']],
    ['action:capture-read + limit', { action: 'capture-read', limit: 2 }, ['action', 'limit']],
    ['bare (defaults)', {}, ['action']],
  ] as Array<[string, Record<string, unknown>, string[]]>) {
    it(`${label}`, async () => {
      const s = (surface = loadSurface());
      s.requests.length = 0;
      await s.call('modoki_profiler', args);
      const req = realRequests(s).find((r) => r.path.split('?')[0] === '/api/profiler');
      expect(req, `modoki_profiler ${label} never reached /api/profiler`).toBeDefined();

      const qs = req!.path.split('?')[1] ?? '';
      const { proxy, read } = recordingQuery(qs);
      await handleBackendRequest(routerCtx(), { method: 'GET', urlPath: '/api/profiler', query: proxy, body: undefined });

      for (const k of expectRead) {
        expect(read.has(k), `the route never read \`${k}\` — the tool sends it, so it is silently dropped`).toBe(true);
      }
    });
  }

  it('a refusal names EVERY stray filter, so one fix is enough', async () => {
    // The refusal used to be an if/else chain naming only the first. An agent that follows
    // `expected` literally would omit `markers`, resubmit, and hit a second unwarned refusal for
    // `limit` — a refusal's job is to be the next move, once.
    const s = (surface = loadSurface());
    const r = await s.call('modoki_profiler', { action: 'reset', markers: 5, limit: 3 });
    const text = s.text(r);
    expect(r.isError).toBe(true);
    expect(text).toMatch(/markers/);
    expect(text, 'the second stray param was not named').toMatch(/limit/);
  });

  it('an UNKNOWN action is a 400 that does NOT claim the action mutates', async () => {
    // `?action=Read` (wrong case) used to be told it "MUTATES profiler state" — false, and it sends
    // the reader hunting the wrong fix. Unknown and mutating are different errors (§0/§5).
    const { proxy } = recordingQuery('action=Read');
    const res = await handleBackendRequest(routerCtx(), { method: 'GET', urlPath: '/api/profiler', query: proxy, body: undefined });
    expect(res?.status).toBe(400);
    // BackendResult is a discriminated union — narrow before reading `body`, or the assertion
    // compiles only by accident. (Test files ARE typechecked here; #23.)
    expect(res?.kind).toBe('json');
    const body = res?.kind === 'json' ? (res.body as { error?: string }) : undefined;
    expect(body?.error).toMatch(/unknown profiler action/i);
    expect(body?.error, 'an unknown action must not be described as mutating').not.toMatch(/MUTATES/);
  });

  it('a MUTATING action is refused by the route with 405, not served', async () => {
    // The §4 split is per-action here, so it has to be asserted per-action rather than inferred
    // from the contract's declared method.
    const { proxy } = recordingQuery('action=reset');
    const res = await handleBackendRequest(routerCtx(), { method: 'GET', urlPath: '/api/profiler', query: proxy, body: undefined });
    expect(res?.status).toBe(405);
  });
});

async function measure(): Promise<{ rows: Row[]; skipped: string[]; notReached: string[] }> {
  const s = (surface = loadSurface());
  const rows: Row[] = [];
  const skipped: string[] = [];
  const notReached: string[] = [];
  for (const [name, c] of Object.entries(CONTRACTS)) {
    if (c.method !== 'GET' || !c.route) continue;
    if (NOT_ROUTER_OWNED.has(c.route)) { skipped.push(name); continue; }
    const entry = getTool(name)!;
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry.shape)) args[k] = synth(v);
    // Only exercise args the tool's own schema accepts — a synthesized value it would refuse
    // describes a call that cannot happen (the harness must not manufacture states, per
    // `mcpSurface`'s docblock).
    if (!z.object(entry.shape).strict().safeParse(args).success) { notReached.push(`${name} (synth args invalid)`); continue; }
    s.requests.length = 0;
    let called = false;
    try { await s.call(name, args); called = true; } catch { /* a refusal is fine — we assert on I/O */ }
    const req = realRequests(s).find((r) => r.path.split('?')[0] === c.route);
    if (!req) { notReached.push(`${name} (${called ? 'took another route' : 'refused'})`); continue; }
    const qs = req.path.split('?')[1] ?? '';
    if (!qs) { notReached.push(`${name} (sends no query params)`); continue; }
    const { proxy, read, keys } = recordingQuery(qs);
    await handleBackendRequest(routerCtx(), { method: 'GET', urlPath: c.route, query: proxy, body: undefined });
    rows.push({ tool: name, route: c.route, sent: keys, unread: keys.filter((k) => !read.has(k)) });
  }
  return { rows, skipped, notReached };
}

describe('GET query-param parity (tool → route)', () => {
  it('no GET tool sends a query param its route never reads', async () => {
    const { rows } = await measure();
    const dropped = rows.filter((r) => r.unread.length)
      .map((r) => `${r.tool} → ${r.route} silently DROPS: ${r.unread.join(', ')}`);
    expect(dropped, 'a param the route never reads is a filter that is ignored while the call reports success').toEqual([]);
  });

  it('the check actually reaches the routes it claims to (a guard that measures nothing passes)', async () => {
    // The failure mode this pins: a synth/harness change makes every tool land in `notReached`,
    // the assertion above becomes vacuous, and the suite stays green. Assert real coverage.
    const { rows } = await measure();
    expect(rows.length, 'no GET route was exercised at all').toBeGreaterThanOrEqual(10);
    // …and that the params really were observed, not just collected.
    const totalSent = rows.reduce((n, r) => n + r.sent.length, 0);
    expect(totalSent).toBeGreaterThanOrEqual(30);
  });

  it('…and it CAN fail: a param no route reads is reported as dropped', async () => {
    // Mutation-test in-place, so the guard is known to observe the thing it exists for.
    const { proxy, read, keys } = recordingQuery('trait=Transform&nonsense__=1');
    await handleBackendRequest(routerCtx(), { method: 'GET', urlPath: '/api/scene-state', query: proxy, body: undefined });
    expect(keys.filter((k) => !read.has(k))).toEqual(['nonsense__']);
  });

  it('the not-router-owned skip list is exactly the long-running SSE routes', async () => {
    // Shrink-only, like MUTATING_GETS: a route that migrates into the router must leave this list
    // rather than sit here forever exempt.
    const { skipped } = await measure();
    expect(skipped.sort()).toEqual(['modoki_add_native_target', 'modoki_build', 'modoki_ota_publish']);
  });
});
