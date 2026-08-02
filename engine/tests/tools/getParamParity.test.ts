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
