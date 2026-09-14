/** #1072 — a relayed route forwards an agent-supplied VOCABULARY value RAW, and the op that owns
 *  the table refuses it.
 *
 *  `/api/journal` copied `info|warn|error` and `start|stop`, `/api/editor-journal` and
 *  `/api/wait-for-edit` copied `human|agent` — and dropped anything else. So `?level=wran` returned
 *  the WHOLE ring under a filtered framing, `?action=strat` turned a capture toggle into a plain read,
 *  and `?source=agnet` made wait-for-edit park for the default `human`. The op-level refusal #993
 *  added for `level` could not fire from this route at all.
 *
 *  ⚠️ The MCP tools enum-validate these params, so no `modoki_*` call reaches the defect — that is
 *  why it survived. The dev-server curl API is a real surface (conventions §9), and it is the one
 *  these tests drive, through the ROUTE: the op already worked, and a test of the op alone cannot
 *  see a route that never delivers the value. */

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import {
  findNodes, flatText, lineOf, parseSource, printedText, stringValueOf, ts, unwrapValue,
} from '@modoki/engine/testing/sourceAst';
import { createTestWorld, emit, JOURNAL_LEVELS, type TestWorld } from '@modoki/engine/runtime';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { runAgentOp } from '../../app/debug/agentBridge';

const PROJECT = path.join(os.tmpdir(), 'route-vocab-proj');
const ROUTER = path.join(__dirname, '..', '..', 'plugins', 'backend', 'editorBackendRouter.ts');

type Call = { op: string; params: Record<string, unknown> };

/** A ctx that records what the route relays, and answers with `reply`. */
function makeCtx(reply: (op: string, params: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const root = path.join(PROJECT, 'runtime');
  const ctx = {
    projectRoot: PROJECT,
    resolveAssetPath: () => null,
    absToAssetUrl: () => null,
    firstRootDir: () => root,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    requestBrowser: async (op: string, params: unknown) => {
      calls.push({ op, params: params as Record<string, unknown> });
      return reply(op, params as Record<string, unknown>);
    },
    getSchema: () => undefined,
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
  return { ctx, calls };
}

const get = async (ctx: BackendContext, urlPath: string, qs: string) => await handleBackendRequest(ctx, {
  method: 'GET', urlPath, query: new URLSearchParams(qs), body: undefined,
}) as { status?: number; body: Record<string, unknown> };

const UNKNOWN = [
  { route: '/api/journal', op: 'journal-events', key: 'level', value: 'wran' },
  { route: '/api/journal', op: 'journal-events', key: 'action', value: 'strat' },
  { route: '/api/editor-journal', op: 'editor-journal', key: 'source', value: 'agnet' },
  { route: '/api/wait-for-edit', op: 'wait-for-edit', key: 'source', value: 'agnet' },
];

describe('routes forward an unknown vocabulary value RAW to the op that owns the table (#1072)', () => {
  it.each(UNKNOWN)('$route ?$key=$value reaches $op unchanged', async ({ route, op, key, value }) => {
    const { ctx, calls } = makeCtx(() => ({ ok: true }));
    await get(ctx, route, `${key}=${value}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe(op);
    expect(calls[0].params[key]).toBe(value);
  });

  // The accept side: forwarding raw must still deliver the values the route used to copy.
  it.each([
    { route: '/api/journal', key: 'level', value: 'warn' },
    { route: '/api/journal', key: 'action', value: 'start' },
    { route: '/api/editor-journal', key: 'source', value: 'agent' },
    { route: '/api/wait-for-edit', key: 'source', value: 'human' },
  ])('$route ?$key=$value (a valid value) still arrives', async ({ route, key, value }) => {
    const { ctx, calls } = makeCtx(() => ({ ok: true }));
    await get(ctx, route, `${key}=${value}`);
    expect(calls[0].params[key]).toBe(value);
  });

  it.each(UNKNOWN)('$op\'s coded refusal leaves $route as a 400 carrying its options', async ({ route, key, value }) => {
    const { ctx } = makeCtx(() => ({ ok: false, code: 'REFUSED_BY_OP', error: `unknown ${key}`, options: ['a', 'b'] }));
    const r = await get(ctx, route, `${key}=${value}`);
    // A 400, not a 200 with a failure body: `getJson` does not check a plain read's `ok`.
    expect(r.status).toBe(400);
    expect(r.body.options).toEqual(['a', 'b']);
  });
});

describe('the whole #1072 chain, with the REAL journal-events op behind the route', () => {
  let game: TestWorld | undefined;
  afterEach(() => { game?.dispose(); game = undefined; });

  it('?level=wran is a 400 naming the levels — not every event under a filtered framing', async () => {
    game = createTestWorld();
    emit('match', { n: 1 });
    const { ctx } = makeCtx((op, params) => runAgentOp(op, params));
    const r = await get(ctx, '/api/journal', 'level=wran');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('REFUSED_BY_OP');
    expect(r.body.options).toEqual([...JOURNAL_LEVELS]);
    expect(r.body.events).toBeUndefined();
  });

  it('?level=warn still reads (the accept side of the same chain)', async () => {
    game = createTestWorld();
    emit('match', { n: 1 });
    const { ctx } = makeCtx((op, params) => runAgentOp(op, params));
    const r = await get(ctx, '/api/journal', 'level=warn');
    expect(r.status ?? 200).toBe(200);
    expect(Array.isArray(r.body.events)).toBe(true);
  });
});

describe('hit-regions: the same mechanism at the OP (found by the #1072 close-out sweep)', () => {
  // The route already forwarded `action` raw; the op then ran anything that was not show/hide as a
  // READ — `?action=shwo` answered geometry and the overlay never appeared.
  it('?action=shwo is a 400 naming the verbs, through the route and the real op', async () => {
    const { ctx } = makeCtx((op, params) => runAgentOp(op, params));
    const r = await get(ctx, '/api/hit-regions', 'action=shwo');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('REFUSED_BY_OP');
    expect(r.body.options).toEqual(['read', 'show', 'hide']);
    expect(r.body.regions).toBeUndefined();
  });

  it('?action=read (and no action) still read', async () => {
    const { ctx } = makeCtx((op, params) => runAgentOp(op, params));
    for (const qs of ['action=read', '']) {
      const r = await get(ctx, '/api/hit-regions', qs);
      expect(r.status ?? 200, qs).toBe(200);
      expect(Array.isArray(r.body.regions), qs).toBe(true);
    }
  });
});

const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken]);

/** The one expression an `a === 'x' || a === 'y' || …` test compares against string literals (two or
 *  more operands, either spelling order), as the printer spells it — or `undefined` for any other test. */
function comparedSubject(test: ts.Expression): string | undefined {
  const operands: ts.Expression[] = [];
  const split = (e: ts.Expression): void => {
    const u = unwrapValue(e);
    if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.BarBarToken) { split(u.left); split(u.right); } else operands.push(u);
  };
  split(test);
  if (operands.length < 2) return undefined;
  const subjects = operands.map((o) => {
    if (!ts.isBinaryExpression(o) || !EQUALITY.has(o.operatorToken.kind)) return undefined;
    const [lit, other] = stringValueOf(o.right) !== undefined ? [o.right, o.left] : [o.left, o.right];
    return stringValueOf(lit) !== undefined && stringValueOf(other) === undefined ? printedText(unwrapValue(other)) : undefined;
  });
  return subjects.every((v) => v !== undefined && v === subjects[0]) ? subjects[0] : undefined;
}

/** Every VOCABULARY COPY in a file: an `if` whose test compares one value against string literals, and
 *  whose then-branch assigns THAT value onto a property — `if (x === 'a' || x === 'b') params.k = x`.
 *
 *  Node-based (#1179). The line regex this replaced needed the whole shape on one line with a bare
 *  identifier and `params.` spelled out, so a formatter's wrap, a braced branch, a `query.get('level')`
 *  subject, double quotes or `'a' === x` each hid a copy. A boolean PARSE of a flag assigns a constant,
 *  not the compared value, and is not one. Not seen either, before or now: `['a', 'b'].includes(x)`, a
 *  `switch`, a ternary. */
export function vocabularyCopies(code: string, label: string): string[] {
  const sf = parseSource(code, label);
  return findNodes(sf, ts.isIfStatement).flatMap((s) => {
    const subject = comparedSubject(s.expression);
    if (!subject) return [];
    return findNodes(s.thenStatement, (n): n is ts.BinaryExpression => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      .filter((a) => { const t = unwrapValue(a.left); return ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t); })
      .filter((a) => printedText(unwrapValue(a.right)) === subject)
      .map((a) => `${label}:${lineOf(a)}: ${flatText(a)}`);
  });
}

describe('guard: the router copies no vocabulary out of a request value', () => {
  it('editorBackendRouter.ts has no `if (x === \'a\' || x === \'b\') params.k = x` narrowing', () => {
    // Through `readScannedSource`, like every source-scanning guard here (#812).
    expect(vocabularyCopies(readScannedSource(ROUTER).code, 'editorBackendRouter.ts'),
      'Forward the raw value and let the op that owns the table refuse it, with options '
      + '(docs/mcp-tool-conventions.md §5). A copy here turns a typo into a wrong answer.').toEqual([]);
  });

  const copies = (body: string) => vocabularyCopies(`function route(query: URLSearchParams, params: Record<string, unknown>) {\n${body}\n}`, 'fixture.ts')
    .map((h) => h.replace(/^fixture\.ts:\d+: /, ''));

  it('recognises the exact shape #1072 removed (so an empty scan means something)', () => {
    expect(copies("if (level === 'info' || level === 'warn' || level === 'error') params.level = level;")).toEqual(['params.level = level']);
    expect(copies("if (source === 'human' || source === 'agent') params.source = source;")).toEqual(['params.source = source']);
    // A boolean PARSE of a flag is not a vocabulary copy, and must not trip the guard.
    expect(copies("if (query.get('clear') === '1' || query.get('clear') === 'true') params.clear = true;")).toEqual([]);
  });

  it('…however it is formatted or spelled (#1179: each of these passed the one-line regex)', () => {
    expect(copies(`if (level === 'info'
      || level === 'warn') {
      params.level = level;
    }
    if ("human" == source || 'agent' === source) out['source'] = (source as string);
    if (query.get('action') === 'start' || query.get('action') === 'stop') params.action = query.get('action');
    if (level === 'info' || level === 'warn') list.forEach(() => { params.level = level; });
    if (query.get(
      'kind') === 'a' || query.get('kind') === 'b') params.kind = query.get('kind');`))
      .toEqual(['params.level = level', "out['source'] = (source as string)", "params.action = query.get('action')", 'params.level = level',
        "params.kind = query.get('kind')"]);
  });

  it('…and only the compared value, assigned in that branch, counts', () => {
    expect(copies(`if (level === 'info' || level === 'warn') params.level = other;
    if (level === 'info' || other === 'warn') params.level = level;
    if (level === 'info') params.level = level;
    if (level === 'info' || level === 'warn') {} else params.level = level;
    if (level === 'info' || level.startsWith('w')) params.level = level;
    if (level !== 'info' || level !== 'warn') params.level = level;
    if ('info' === 'info' || 'info' === 'warn') params.level = 'info';
    if (level === 'info' || level === 'warn') local = level;`)).toEqual([]);
  });
});
describe('/api/device/request refuses an unknown input vocabulary value before any transport (#1076)', () => {
  // The inverse of the relayed routes above, and deliberately so: the device's tables are enforced on
  // the far side of a transport this route CHOOSES — CDP dispatches `press-key` itself and never reaches
  // the bridge handler, and an installed app may predate the handler's own refusal. So this dispatch,
  // which every transport passes first, is where it has to be caught. No lease is held in this test,
  // which is what makes it discriminating: a value that got past the check would answer with the LEASE
  // error instead.
  const request = async (method: string, params: Record<string, unknown>) => {
    const { ctx } = makeCtx(() => ({ ok: true }));
    return await handleBackendRequest(ctx, {
      method: 'POST', urlPath: '/api/device/request', query: new URLSearchParams(), body: { method, params },
    }) as { status?: number; body: Record<string, unknown> };
  };

  it.each([
    { method: 'pointer', params: { action: 'down', x: 1, y: 1, button: 'rigth' }, field: 'pointer button' },
    { method: 'pointer', params: { action: 'wiggle', x: 1, y: 1 }, field: 'pointer action' },
    { method: 'press-key', params: { key: 'z', modifiers: ['cmmd'] }, field: 'press-key modifiers' },
  ])('$method: $field', async ({ method, params, field }) => {
    const r = await request(method, params);
    expect(r.body.result).toMatch(new RegExp(`^Error: ${field}: unknown value .* — nothing was dispatched\\. Valid: `));
  });

  it('ACCEPT: a known value goes on to the lease (and fails there, with no lease held)', async () => {
    for (const [method, params] of [
      ['pointer', { action: 'down', x: 1, y: 1, button: 'middle' }],
      ['press-key', { key: 'z', modifiers: ['meta'] }],
    ] as const) {
      const r = await request(method, params);
      expect(JSON.stringify(r.body)).not.toMatch(/unknown value/);
    }
  });
});
