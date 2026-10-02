/** #1962: a route's typed query params and the op behind it read ONE table (`tools/shared/opParams.ts`).
 *
 *  The route used to parse each number or flag by its own rule. It dropped a NaN, read a truthy string,
 *  accepted `'true'` only, or answered an uncoded 400. The op checked by another rule, or not at all. So
 *  `?since=abc` answered the default tail under a cursored framing, `?entities=0` turned the list ON, and
 *  `/api/eval {timeoutMs:"20000"}` sized its relay at 15s while the op ran for 20s.
 *
 *  These cases drive the ROUTE into the REAL op (`runAgentOp`, where `checkOpParams` runs), because a test
 *  of either half alone cannot see the two disagree. That gap is the defect. The guards at the bottom
 *  keep the router from growing a hand parser again. */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestWorld, type TestWorld } from '@modoki/engine/runtime';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { runAgentOp, registerAgentOp, listAgentOps } from '../../app/debug/agentBridge';
import { OP_PARAMS, checkOpParams, decodeOpQuery, decodeQueryFlag } from '../../tools/shared/opParams';
import { EDITOR_EVAL_MAX_TIMEOUT_MS, EVAL_RELAY_HEADROOM_MS } from '../../tools/shared/evalTiming';

const PROJECT = path.join(os.tmpdir(), 'op-params-proj');
const ENGINE = path.join(__dirname, '..', '..');
const ROUTER = path.join(ENGINE, 'plugins', 'backend', 'editorBackendRouter.ts');

type Call = { op: string; params: Record<string, unknown>; timeoutMs?: number };

/** A ctx whose relay runs the REAL op (or `reply`), recording what the route sent and its deadline. */
function makeCtx(reply: (op: string, params: Record<string, unknown>) => unknown = (op, p) => runAgentOp(op, p)) {
  const calls: Call[] = [];
  const ctx = {
    projectRoot: PROJECT,
    resolveAssetPath: () => null,
    absToAssetUrl: () => null,
    firstRootDir: () => path.join(PROJECT, 'runtime'),
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    requestBrowser: async (op: string, params: unknown, timeoutMs?: number) => {
      calls.push({ op, params: params as Record<string, unknown>, timeoutMs });
      return reply(op, params as Record<string, unknown>);
    },
    getSchema: () => undefined,
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
  return { ctx, calls };
}

const request = async (ctx: BackendContext, method: 'GET' | 'POST', urlPath: string, qs = '', body?: unknown) => await handleBackendRequest(ctx, {
  method, urlPath, query: new URLSearchParams(qs), body,
}) as { status?: number; body: Record<string, unknown> };

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; });

describe('a malformed number reaches the op and is REFUSED, coded — never dropped to the default (#1962 §1)', () => {
  // Runtime ops, through the real handler. Each case is one the route used to drop.
  it.each([
    ['/api/console-logs', 'since=abc', 'since'],
    ['/api/console-logs', 'limit=abc', 'limit'],
    ['/api/console-logs', 'sinceMs=abc', 'sinceMs'],
    ['/api/journal', 'limit=abc', 'limit'],
    ['/api/watch/read', 'id=w&limit=abc', 'limit'],
    ['/api/input-watch/read', 'limit=abc', 'limit'],
    ['/api/profiler', 'markers=abc', 'markers'],
    ['/api/layout-bounds', 'precision=abc', 'precision'],
    ['/api/layout-bounds', 'ids=1,x', 'ids'],
    ['/api/hit-regions', 'atX=5', 'at'],
    ['/api/scene-state', 'limit=-1', 'limit'],
  ])('%s ?%s is a 400 REFUSED_BY_OP naming %s', async (route, qs, key) => {
    game = createTestWorld();
    const { ctx } = makeCtx();
    const r = await request(ctx, 'GET', route, qs);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, code: 'REFUSED_BY_OP' });
    expect(String(r.body.error)).toContain(`${key} must be`);
  });

  // The editor ops are registered by the editor at startup, which this suite does not boot. The check
  // runs in `runAgentOp` BEFORE the handler, so a stub handler proves the refusal comes from the shared
  // table and that the op body never ran.
  it.each([
    ['/api/editor-journal', 'editor-journal', 'since=abc', 'since'],
    ['/api/editor-journal', 'editor-journal', 'sinceCap=abc', 'sinceCap'],
    ['/api/editor-journal', 'editor-journal', 'merged=yes', 'merged'],
    ['/api/wait-for-edit', 'wait-for-edit', 'since=abc', 'since'],
  ])('%s (op %s) ?%s is refused before the editor op runs, naming %s', async (route, op, qs, key) => {
    let ran = false;
    registerAgentOp(op, () => { ran = true; return { ok: true }; });
    const { ctx } = makeCtx();
    const r = await request(ctx, 'GET', route, qs);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain(`${key} must be`);
    expect(ran).toBe(false);
  });

  it('a well-formed value still reaches the op as a number', async () => {
    const { ctx, calls } = makeCtx(() => ({ ok: true }));
    await request(ctx, 'GET', '/api/console-logs', 'since=7&limit=3');
    expect(calls[0].params).toMatchObject({ since: 7, limit: 3 });
  });
});

describe('/api/eval sizes its relay with the op\'s own clamp (#1962 §2)', () => {
  it('a string timeoutMs gets the budget the op will use, not the 5s default', async () => {
    const { ctx, calls } = makeCtx(() => 'done');
    await request(ctx, 'POST', '/api/eval', '', { code: 'return 1', timeoutMs: '20000' });
    expect(calls[0].params.timeoutMs).toBe(20_000);
    expect(calls[0].timeoutMs).toBe(20_000 + EVAL_RELAY_HEADROOM_MS);
  });

  it('an over-cap budget is clamped to the op\'s ceiling on both sides', async () => {
    const { ctx, calls } = makeCtx(() => 'done');
    await request(ctx, 'POST', '/api/eval', '', { code: 'return 1', timeoutMs: 99_999 });
    expect(calls[0].params.timeoutMs).toBe(EDITOR_EVAL_MAX_TIMEOUT_MS);
    expect(calls[0].timeoutMs).toBe(EDITOR_EVAL_MAX_TIMEOUT_MS + EVAL_RELAY_HEADROOM_MS);
  });
});

describe('a flag has ONE spelling: 1/true on, 0/false off, anything else refused (#1962 §3)', () => {
  it('/api/layout-bounds ?entities=0&overlaps=false is OFF (it used to be truthy, so ON)', async () => {
    const { ctx, calls } = makeCtx(() => ({ ok: true }));
    await request(ctx, 'GET', '/api/layout-bounds', 'entities=0&overlaps=false');
    expect(calls[0].params).toMatchObject({ entities: false, overlaps: false });
  });

  it('/api/layout-bounds ?entities=yes is refused by the op', async () => {
    game = createTestWorld();
    const r = await request(makeCtx().ctx, 'GET', '/api/layout-bounds', 'entities=yes');
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain('entities must be a boolean');
  });

  it('/api/profiler ?all=1 is ON (it used to accept only "true")', async () => {
    const { ctx, calls } = makeCtx(() => ({ ok: true }));
    await request(ctx, 'GET', '/api/profiler', 'action=boot&all=1');
    expect(calls[0].params).toMatchObject({ action: 'boot', all: true });
  });

  it('/api/find-references ?reachableOnly=bogus is a 400 before the graph walk', async () => {
    const ctx = { ...makeCtx().ctx, computeRefEdges: () => { throw new Error('the walk must not run'); } } as unknown as BackendContext;
    const r = await request(ctx, 'GET', '/api/find-references', 'target=x&reachableOnly=bogus');
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'REFUSED_BY_OP' });
  });

  it('decodeQueryFlag: the four spellings, absent, and the raw rest', () => {
    expect([decodeQueryFlag('1'), decodeQueryFlag('true'), decodeQueryFlag('0'), decodeQueryFlag('false')]).toEqual([true, true, false, false]);
    expect([decodeQueryFlag(null), decodeQueryFlag('')]).toEqual([undefined, undefined]);
    expect(decodeQueryFlag('yes')).toBe('yes');
  });
});

describe('checkOpParams / decodeOpQuery', () => {
  it('normalizes what it accepts: a decimal string, a floored count, a dropped null', () => {
    expect(checkOpParams('scene-state', { limit: '2.9', precision: 3, id: null, trait: 'T' }))
      .toEqual({ ok: true, params: { limit: 2, precision: 3, trait: 'T' } });
  });

  it('a seq cursor must be a whole number; a cap cursor need not be', () => {
    expect(checkOpParams('console-logs', { since: 1.5 }).ok).toBe(false);
    expect(checkOpParams('journal-events', { sinceCap: 1.5 }).ok).toBe(true);
  });

  it('an op with no table, and a param outside it, pass through untouched', () => {
    const p = { anything: 'abc' };
    expect(checkOpParams('no-such-op', p)).toEqual({ ok: true, params: p });
    expect(checkOpParams('scene-state', p)).toEqual({ ok: true, params: p });
  });

  it('decodeOpQuery forwards an undecodable value RAW and treats an empty one as absent', () => {
    expect(decodeOpQuery('console-logs', new URLSearchParams('since=abc&limit='))).toEqual({ since: 'abc' });
    expect(decodeOpQuery('hit-regions', new URLSearchParams('atX=1&atY=2'))).toEqual({ at: { x: 1, y: 2 } });
  });
});

describe('guards — the router cannot grow a hand parser back (#1962)', () => {
  const src = fs.readFileSync(ROUTER, 'utf8');

  it('no route drops a malformed number (`!Number.isNaN(Number(x))`)', () => {
    expect(src.match(/!Number\.isNaN\(Number\(/g) ?? []).toEqual([]);
  });

  it('no route reads a query flag by its own spelling (`=== \'1\'`, `=== \'true\'`, or truthy `if (query.get(…))` → true)', () => {
    const own = src.split('\n').filter((l) => /query\.get\([^)]*\)\s*===\s*'(1|true)'/.test(l) || /if \(query\.get\('[^']+'\)\) params\.\w+ = true/.test(l));
    expect(own).toEqual([]);
  });

  it('every op in OP_PARAMS is a registered op (a renamed op would silently skip its checks)', () => {
    const editorSrc = fs.readFileSync(path.join(ENGINE, 'app', 'editor', 'agentEditorOps.ts'), 'utf8');
    const runtime = new Set(listAgentOps());
    const missing = Object.keys(OP_PARAMS).filter((op) => !runtime.has(op) && !editorSrc.includes(`AgentOp('${op}'`));
    expect(missing).toEqual([]);
  });

  it('every OP_PARAMS op is decoded by some route (a table entry nothing reads is not a seam)', () => {
    const unread = Object.keys(OP_PARAMS).filter((op) => !src.includes(`decodeOpQuery('${op}'`));
    expect(unread).toEqual([]);
  });
});
