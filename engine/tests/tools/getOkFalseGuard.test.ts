/** Phase 6 source guard — **a GET route must never answer a bare 200 with `{ok:false}`.**
 *
 *  WHY A SOURCE GUARD AND NOT A BEHAVIOURAL ONE. `getJson` deliberately does not run
 *  `isFailureBody`: for `diagnose` / `validate_scene`, `ok:false` IS the answer ("this scene is
 *  unhealthy"), and failing those calls would make an honest negative result look like a broken
 *  tool. That decision is right, and it has a cost — it means **the transport cannot tell a GET's
 *  answer from a GET's refusal**, so a route that reports a genuine failure as `200 {ok:false}` is
 *  invisible: the tool reports success and the agent believes the empty/negative payload.
 *
 *  The behavioural guards cover the routes a TOOL reaches (`mcpToolContracts.test.ts` — every
 *  mutating GET must fail on `ok:false`; `getParamParity.test.ts` — no param is silently dropped).
 *  What neither can see is a route added with no tool in front of it, or a NEW `ok:false` branch in
 *  an existing route. That is what this checks, at the only place the information exists: the route
 *  source.
 *
 *  THE RULE: any `json({… ok: false …})` a GET can reach — every one not under a route test that
 *  excludes GET (`excludesGet`) — must pass an explicit non-2xx status. The three routes that emit one today (`/api/watch/read` 404, `/api/ota/keys`
 *  400/500, `/api/ota/status` 400/500) all already do — this keeps it that way. The alternative
 *  fix for a new violation is equally acceptable: make the route a POST, or pass `checkFailure` at
 *  the tool's call site.
 *
 *  A source guard is normally the WEAK option here (`docs/mcp-tool-conventions.md` §9, and F2 in the
 *  ledger: a guard that loses its target fails OPEN). So this one parses the route files (#1179 — it
 *  was a text scan once) and asserts its own reach first — the route files must exist, and a minimum
 *  number of GET route gates must be found — and is mutation-tested below against synthetic violations.
 */

import { describe, it, expect } from 'vitest';
import path, { join } from 'node:path';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { assertDeclaredListIsComplete } from '../helpers/declaredList';
import { readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import {
  callsTo, findNodes, flatText, guardsOf, lineOf, objectLiteralKeys, parseSource, stringValueOf, ts,
  unwrapValue, type Guard,
} from '@modoki/engine/testing/sourceAst';

/** ⚠️ **This listed THREE files while a sibling guard over the same subject listed six (#830).**
 *  `routeCoverage.test.ts`'s `ROUTE_FILES` enumerates "every file that dispatches on an `/api/*` path" as six;
 *  this one scanned three, and nothing compared them. `electron/backendServer.ts` and
 *  `plugins/vite-asset-scanner.ts` both dispatch on `/api/` and were never read here — so a bare
 *  `200 {ok:false}` in either was invisible to the guard written to forbid exactly that.
 *
 *  Repo-relative now (they were `../../`-relative), so the completeness check below can compare
 *  them against a repo-wide marker without two path vocabularies. */
const REPO = path.resolve(__dirname, '../../..');

const ROUTE_FILES = [
  'engine/electron/backendServer.ts',
  'engine/electron/inputRoutes.ts',
  'engine/electron/main.ts',
  'engine/plugins/backend/editorBackendRouter.ts',
  'engine/plugins/vite-asset-scanner.ts',
];

/** A file that DISPATCHES on an `/api/*` path — it compares a request path against one, rather
 *  than merely naming a route it calls. That distinction is the whole marker: 35 files under
 *  `engine/` mention an `/api/` literal and almost all are CLIENTS. */
const DISPATCHES_ON_API = /(===|==|startsWith\()\s*'\/api\//;

const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken]);

/** `a === 'lit'` / `'lit' == a` where the literal passes `want` — the literal, or `undefined`. */
function comparedLiteral(n: ts.Node, want: (v: string) => boolean): string | undefined {
  if (!ts.isBinaryExpression(n) || !EQUALITY.has(n.operatorToken.kind)) return undefined;
  return [n.left, n.right].map(stringValueOf).find((v): v is string => v !== undefined && want(v));
}
const isApi = (v: string) => v.startsWith('/api/');
const NEGATING = new Set([ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

const VERBS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** The request's method, as every router here spells it: a `method` destructured from the request. A
 *  `q.method`, `init.method` or `req.method` is not read — a field that shares the name is not the verb. */
const readsMethod = (e: ts.Expression) => { const u = unwrapValue(e); return ts.isIdentifier(u) && u.text === 'method'; };

/** What `test` evaluates to for a request with HTTP method `verb` — `true`, `false`, or `undefined`
 *  when that depends on something else. Three-valued, through `!`, `&&`, `||` and parentheses. The only
 *  atoms it decides compare `method` with an HTTP VERB: `method === 'POST'`, `method !== 'GET'`,
 *  `['GET', 'HEAD'].includes(method)`. Everything else is undefined — the route (`urlPath === '/api/x'`),
 *  `q.method === 'POST'`, `m === 'GET'`, `(req.method || 'GET') === 'POST'`, `indexOf(method) === -1`,
 *  `includes(method, 1)`. */
function evaluate(test: ts.Expression, verb: string): boolean | undefined {
  const e = unwrapValue(test);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const v = evaluate(e.operand, verb);
    return v === undefined ? undefined : !v;
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      const [l, r] = [evaluate(e.left, verb), evaluate(e.right, verb)];
      const absorbing = op === ts.SyntaxKind.BarBarToken;
      if (l === absorbing || r === absorbing) return absorbing;
      return l === !absorbing && r === !absorbing ? !absorbing : undefined;
    }
    if (EQUALITY.has(op) || NEGATING.has(op)) {
      const lit = stringValueOf(e.right) ?? stringValueOf(e.left);
      const other = stringValueOf(e.right) !== undefined ? e.left : e.right;
      if (lit === undefined || !VERBS.has(lit) || !readsMethod(other)) return undefined;
      return EQUALITY.has(op) ? verb === lit : verb !== lit;
    }
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'includes'
    && e.arguments.length === 1 && readsMethod(e.arguments[0])) {
    const list = unwrapValue(e.expression.expression);
    const values = ts.isArrayLiteralExpression(list) ? list.elements.map((el) => stringValueOf(el)) : [];
    if (values.length > 0 && values.every((v) => v !== undefined && VERBS.has(v))) return values.includes(verb);
  }
  return undefined;
}

/** Whether a response under `guards` is PROVEN unreachable by a GET: some ROUTE test it runs under — one
 *  that compares against an `/api/*` literal, as `if (urlPath === '/api/x' && method === 'POST')` does —
 *  is decided, for a GET, against how it held. Anything else leaves the GET rule on.
 *
 *  ⚠️ **Proof of exclusion, never evidence of inclusion (#1179 P4, four review rounds).** Each reading
 *  that tried to RECOGNISE a GET route dropped what it did not recognise — `['GET', 'HEAD'].includes`,
 *  an aliased method, a second route literal — and each wider proof of exclusion was unsound in turn: a
 *  `q.method === 'POST'` nested in a GET route, and a one-hop "every caller excludes GET" that found
 *  callers by NAME in one file, so `hiddenWindowRefusal` (exported, also called from `main.ts`) was
 *  excluded by its one in-file caller. What is left is the router convention itself: the route and the
 *  method in the route's own test. A route whose method is checked anywhere else (`inputRoutes.ts`'s
 *  handler) is not inferred; its bare responses are ledger rows below, with the reason. */
function excludesGet(guards: Guard[]): boolean {
  return guards.some((g) => {
    if (!findNodes(g.test, ts.isBinaryExpression).some((b) => comparedLiteral(b, isApi) !== undefined)) return false;
    const v = evaluate(g.test, 'GET');
    return v !== undefined && v !== g.holds;
  });
}

/** The `/api/*` routes a file dispatches on, one per `if` whose test compares against a route literal
 *  — and whether that test leaves a GET possible (see `excludesGet`; #1179: the whole TEST, however it wraps,
 *  where this used to read the one line holding `urlPath === '…'`). */
export function routeGates(code: string, label: string): Array<{ route: string; get: boolean; proven: boolean; line: number }> {
  return findNodes(parseSource(code, label), ts.isIfStatement).flatMap((s) => {
    const route = findNodes(s.expression, ts.isBinaryExpression).map((b) => comparedLiteral(b, isApi)).find((v) => v !== undefined);
    if (!route) return [];
    // `proven`: a GET reaches it and a POST cannot — what the reach floor counts, so a scan that no longer
    // recognises GET routes cannot pass it on method-less routes alone.
    return [{
      route,
      get: !excludesGet([{ test: s.expression, holds: true, by: s }]),
      proven: evaluate(s.expression, 'POST') === false && evaluate(s.expression, 'GET') !== false,
      line: lineOf(s),
    }];
  });
}

const CAUSES = new Set(['error', 'errors', 'reason']);

export interface OkFalseResponse {
  /** The route literal of the nearest `if` that gates this call, or `'<no route>'` — a helper any
   *  route can return. For the message only: the rules read `get`. */
  route: string;
  /** No route test this call runs under excludes a GET (see `excludesGet`). */
  get: boolean;
  line: number;
  /** Its own LAST argument (not the body) names a 4xx/5xx or a `status`. */
  hasStatus: boolean;
  /** Its body's own top-level keys include `error`/`errors`/`reason` — what `isFailureBody` reads. */
  hasCause: boolean;
  snippet: string;
}

/** Every `json(…)` call whose body is an object literal with its OWN `ok: false` (#1179).
 *
 *  Classified by nodes, where it used to be a text scan: a block ran from one `urlPath === '…'` LINE
 *  to the next, GET-ness was `'GET'` on that line, and a hand-balanced paren count found each call. A
 *  route test wrapped after `&&` put a GET route under the POST rule, a `(` inside a message string
 *  unbalanced the count and dropped the call, and `error:` anywhere in the call — a nested object, a
 *  string, `why: reason` — counted as the cause. Now: the route and the method are the call's own
 *  gates (`guardsOf`, held), the status is its own last argument, the cause its body's own keys. */
export function okFalseResponses(code: string, label: string): OkFalseResponse[] {
  const out: OkFalseResponse[] = [];
  for (const call of callsTo(parseSource(code, label), 'json')) {
    const body = call.arguments[0] ? unwrapValue(call.arguments[0]) : undefined;
    if (!body || !ts.isObjectLiteralExpression(body)) continue;
    const okFalse = body.properties.some((p) => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
      && p.name.text === 'ok' && unwrapValue(p.initializer).kind === ts.SyntaxKind.FalseKeyword);
    if (!okFalse) continue;
    const guards = guardsOf(call);
    const route = guards.filter((g) => g.holds)
      .map((g) => findNodes(g.test, ts.isBinaryExpression).map((b) => comparedLiteral(b, isApi)).find((v) => v !== undefined))
      .find((v) => v !== undefined);
    const last = call.arguments.length > 1 ? flatText(call.arguments[call.arguments.length - 1]) : '';
    const flat = flatText(call);
    out.push({
      route: route ?? '<no route>',
      get: !excludesGet(guards),
      line: lineOf(call),
      hasStatus: /\b[45]\d\d\b|\bstatus\b/.test(last),
      hasCause: (objectLiteralKeys(body) ?? []).some((k) => CAUSES.has(k)),
      snippet: flat.slice(0, 160),
    });
  }
  return out;
}

/** The responses the GET rule applies to — every one a GET is not proven unable to reach. */
const underGetRule = (r: OkFalseResponse) => r.get;
/** The responses the cause rule applies to — EVERY one. It was the POST rule, and GET-ness decided who
 *  owed a cause; a misread method then skipped it (#1179 P4 re-review). Every GET response already names
 *  one (measured 2026-09-14: 6 of 6), so owing it everywhere costs nothing and cannot be skipped. */
const underCauseRule = (_r: OkFalseResponse) => true;

/** Bare `200 {ok:false}` responses on routes a GET cannot reach, where the proof is NOT in the route's own
 *  test and so `excludesGet` does not infer it. Spent per response: a new bare one on the same route is
 *  an offender. */
const POST_ONLY_ELSEWHERE: ReadonlyArray<{ item: string; count?: number; reason: string }> = [
  {
    item: 'engine/electron/inputRoutes.ts::/api/input/type',
    count: 2,
    reason: 'dispatchInput is called only by inputRoutes() below `if (!urlPath.startsWith(\'/api/input/\') || '
      + 'method !== \'POST\') return null` — only a POST reaches it, and postJson\'s isFailureBody reads the ok:false.',
  },
];

const scanned = ROUTE_FILES.map((rel) => {
  const code = readScannedSource(join(REPO, rel)).code;
  return { rel, gates: routeGates(code, rel), responses: okFalseResponses(code, rel) };
});

describe('a GET route never answers a bare 200 with ok:false', () => {
  const responses = scanned.flatMap(({ rel, responses: rs }) => rs.map((r) => ({ rel, ...r })));

  it('ROUTE_FILES covers every file that dispatches on /api/ (#830)', () => {
    assertDeclaredListIsComplete({
      label: 'ROUTE_FILES in getOkFalseGuard.test.ts',
      declared: ROUTE_FILES,
      population: repoFiles({ under: 'engine', match: /\.(ts|mjs)$/, floor: 100 })
        .map(({ rel }) => rel)
        .filter((rel) => !/\/tests?\//.test(rel))
        .filter((rel) => DISPATCHES_ON_API.test(readScannedSource(join(REPO, rel)).code)),
      floor: 5,
      fix: 'A new /api/* router must be listed here, or a bare 200 {ok:false} in it is invisible '
        + 'to the guard that exists to forbid one.',
    });
  });

  it('the scan has real targets (a text guard that finds nothing passes silently)', () => {
    // F2's lesson, applied to this guard: assert reach BEFORE asserting compliance.
    const getGates = scanned.flatMap((f) => f.gates).filter((g) => g.proven);
    expect(getGates.length, 'no GET route gates were found — the scan lost its targets').toBeGreaterThanOrEqual(15);
    // Two routes AUTHOR an `ok:false` body literally (`/api/ota/keys`, `/api/ota/status`).
    // `/api/watch/read` is compliant by a different route: it FORWARDS a body it did not author
    // (`if (result.ok === false) return json(result, 404)`), so there is no literal to find — a
    // pattern this scan cannot police and does not need to, since the status is explicit.
    const withOkFalse = new Set(responses.filter((r) => r.get).map((r) => r.route));
    expect(withOkFalse.size, 'no ok:false GET response found at all — the parser is not seeing them').toBeGreaterThanOrEqual(2);
  });

  it('every ok:false a GET route emits carries an explicit non-2xx status', () => {
    assertExemptionLedger({
      label: 'POST_ONLY_ELSEWHERE in getOkFalseGuard',
      population: responses.filter((r) => underGetRule(r) && !r.hasStatus)
        .map((r) => ({ item: `${r.rel}::${r.route}`, site: `${r.rel}:${r.line} ${r.route} → ${r.snippet}` })),
      exempt: POST_ONLY_ELSEWHERE,
      scanned: responses.length,
      floor: 20,
      fix: 'a GET\'s ok:false at status 200 is invisible to getJson (which cannot tell a GET\'s ANSWER '
        + 'from its REFUSAL), so the tool reports success. Give it a 4xx/5xx, make the route a POST in its '
        + 'own route test (`urlPath === … && method === \'POST\'`), or pass checkFailure at the tool\'s call site.',
    });
  });

  const scan = (body: string) => okFalseResponses(`async function handle(urlPath: string, method: string) {\n${body}\n}`, 'fixture.ts')
    .map(({ route, get, hasStatus }) => ({ route, get, hasStatus }));

  it('…and the parser CAN fail — it flags a synthetic bare-200 violation', () => {
    // Mutation test in-place: a guard never seen to fail is not known to work.
    expect(scan(`if (urlPath === '/api/thing' && method === 'GET') {
      return json({ ok: false, error: 'nope' });
    }`)).toEqual([{ route: '/api/thing', get: true, hasStatus: false }]);
    expect(scan(`if (urlPath === '/api/thing' && method === 'GET') {
      return json({ ok: false, error: 'nope' }, 404);
    }`)).toEqual([{ route: '/api/thing', get: true, hasStatus: true }]);
  });

  it('the parser is not fooled by a NESTED object before the status argument', () => {
    expect(scan(`return json({ ok: false, error: 'x', got: { a: 1, b: { c: 2 } } }, 400);`))
      .toEqual([expect.objectContaining({ hasStatus: true })]);
    expect(scan(`return json({ ok: false, got: { a: 1, b: { c: 2 } }, status: 400 });`))
      .toEqual([expect.objectContaining({ hasStatus: false })]); // a `status` KEY in the body is not a status
  });

  it('ignores a helper whose name merely ends in json, and an ok:false that is not the body\'s own', () => {
    expect(scan(`writeJsonAtomic({ ok: false }); return json({ ok: true, inner: { ok: false }, note: 'ok: false' });`)).toEqual([]);
  });

  it('finds the body however it is spelled — a quoted key, a cast, a method, a `(` inside a message (#1179)', () => {
    // The paren-counting scanner ended the call at the `)` that closes `(see`'s missing partner —
    // or never — and dropped it; a quoted key never matched `ok:\s*false`.
    expect(scan(`
      json({ ok: false, error: 'bad (see the docs' });
      json({ 'ok': false });
      json({ ok: false as const });
      res.json({ ok: false });
      json(({ ok: false }) as Body);`).map((r) => r.route)).toEqual(['<no route>', '<no route>', '<no route>', '<no route>', '<no route>']);
  });

  it('reads GET from the route\'s own gate, however it wraps — never from a neighbouring route (#1179)', () => {
    // The line reader saw `'GET'` only on the line holding `urlPath === '…'`: this wrap put a GET
    // route under the POST rule, where its bare 200 was never checked.
    expect(scan(`if (urlPath === '/api/thing'
      && method === 'GET') {
      return json({ ok: false, error: 'nope' });
    }`)).toEqual([{ route: '/api/thing', get: true, hasStatus: false }]);
    // A GET route's block above does not make the POST route below it a GET.
    expect(scan(`if (urlPath === '/api/a' && method === 'GET') { return json({ ok: true }); }
    if (urlPath === '/api/b' && method === 'POST') { return json({ ok: false, error: 'x' }); }`))
      .toEqual([{ route: '/api/b', get: false, hasStatus: false }]);
    // Code AFTER a route's block is not that route's: the block splitter filed it under /api/a.
    expect(scan(`if (urlPath === '/api/a' && method === 'GET') { prep(); }
    return json({ ok: false, error: 'x' });`)).toEqual([{ route: '<no route>', get: true, hasStatus: false }]);
    // Either spelling order and quote; a route that admits GET among others is a GET route, however
    // the method test is spelled; a route that EXCLUDES GET is not one (the line reader counted any 'GET').
    expect(scan(`if ("/api/c" == urlPath && (method === 'GET' || method === 'POST')) return json({ ok: false, error: 'x' });
    if (urlPath === '/api/d' && method !== 'GET') return json({ ok: false, error: 'x' });
    if (urlPath === '/api/f' && ['GET', 'HEAD'].includes(method)) return json({ ok: false, error: 'x' });
    if (urlPath === '/api/g' && !(method === 'GET')) return json({ ok: false, error: 'x' });
    if (urlPath === '/api/h' && !['GET'].includes(method)) return json({ ok: false, error: 'x' });
    if (urlPath === '/api/i' && !(method !== 'GET')) return json({ ok: false, error: 'x' });`))
      .toEqual([
        { route: '/api/c', get: true, hasStatus: false }, { route: '/api/d', get: false, hasStatus: false },
        { route: '/api/f', get: true, hasStatus: false }, { route: '/api/g', get: false, hasStatus: false },
        { route: '/api/h', get: false, hasStatus: false }, { route: '/api/i', get: true, hasStatus: false },
      ]);
    // A test this cannot decide leaves the GET rule ON: `(req.method || 'GET')`, an alias, `indexOf`, a
    // field that merely shares the name, a second route literal. Only a comparison of a `method` with a
    // verb decides — and a route with no method test is reachable by GET.
    expect(scan(`if (urlPath === '/api/j' && (req.method || 'GET') === 'POST') return json({ ok: false }, 400);
    if (urlPath === '/api/k' && method === 'POST' && log('GET')) return json({ ok: false }, 400);
    if (urlPath === '/api/l' && !(method === 'GET' && cached)) return json({ ok: false, error: 'x' });
    if (urlPath === '/api/m' && ['GET'].indexOf(method) === -1) return json({ ok: false, error: 'x' });
    if (urlPath === '/api/n') { if (method !== 'GET') return json({ ok: false, error: 'x' }, 405); return json({ ok: false, error: 'x' }); }
    if (urlPath === '/api/o' && method === 'GET') { return json({ ok: true }); }
    if (urlPath === '/api/p') return json({ ok: false, error: 'x' });
    if (urlPath === '/api/q' && method === 'GET') { if (q.method === 'screenshot') return json({ ok: false, error: 'x' }); }
    if (urlPath === '/api/r' && m === 'POST') return json({ ok: false, error: 'x' });
    if (urlPath === '/api/s' && method === 'GET') { if (next === '/api/y') return json({ ok: false, error: 'x' }); }
    if (urlPath === '/api/t' && method === 'POST' || urlPath === '/api/u' && method === 'GET') return json({ ok: false, error: 'x' });
    if (urlPath === '/api/v' && ['POST', 'PUT'].includes(method)) return json({ ok: false, error: 'x' });
    if (urlPath === '/api/w' && req.method === 'POST') return json({ ok: false, error: 'x' });
    if (urlPath === '/api/x2' && !['GET', 'POST'].includes(method, 1)) return json({ ok: false, error: 'x' });
    if (urlPath === '/api/y2' && method === 'GET') { send((method: string) => { if (method === 'POST') return json({ ok: false, error: 'x' }); }); }`).map(({ get }) => get))
      // n: an exit on the method that is not the ROUTE test proves nothing; w: `req.method` is not read.
      .toEqual([true, false, true, true, true, true, true, true, true, true, true, false, true, true, true]);
    // The method gate need not be the route's own `if`: an enclosing GET-only branch makes it GET too.
    expect(scan(`if (method === 'GET') {
      if (urlPath === '/api/e') return json({ ok: false, error: 'x' });
    }`)).toEqual([{ route: '/api/e', get: true, hasStatus: false }]);
  });

  it('the cause rule is owed by a GET route\'s response too', () => {
    const [r] = okFalseResponses(`function h(urlPath: string, method: string) { if (urlPath === '/api/x' && method === 'GET') return json({ ok: false }, 404); }`, 'fixture.ts');
    expect([r.get, r.hasCause, underCauseRule(r)]).toEqual([true, false, true]);
  });

  it('an unrouted helper answers to the GET rule, whoever calls it', () => {
    const [r] = okFalseResponses(`function refuse() { return json({ ok: false, error: 'x' }); }`, 'fixture.ts');
    expect(r.route).toBe('<no route>');
    expect([underGetRule(r), underCauseRule(r)]).toEqual([true, true]);
    // inputRoutes.ts's shape: the POST check is in the handler that CALLS the route table. Not inferred —
    // callers found by name miss an export and a reference — so those responses are ledger rows.
    expect(okFalseResponses(`function make() {
      const handler = async function inputRoutes(req: Req) {
        const { method, urlPath } = req;
        if (!urlPath.startsWith('/api/input/') || method !== 'POST') return null;
        return dispatchInput(req);
      };
      async function dispatchInput({ urlPath }: Req) {
        if (urlPath === '/api/input/tap') return json({ ok: false, error: 'x' });
      }
      return handler;
    }`, 'fixture.ts').map((x) => x.get)).toEqual([true]);
  });

  it('routeGates reads the whole test of each route `if`', () => {
    expect(routeGates(`if (urlPath === '/api/a'
      && method === 'GET') {}
    if ((urlPath === '/api/b' || urlPath === '/api/b2') && method === 'POST') {}
    if (other === '/not-api') {}
    if (urlPath === '/api/c') {}`, 'fixture.ts').map(({ route, get, proven }) => ({ route, get, proven })))
      // `proven` (a GET, not a POST) is what the reach floor counts: a method-less route is GET-reachable
      // but proves nothing about the scan recognising GET routes.
      .toEqual([{ route: '/api/a', get: true, proven: true }, { route: '/api/b', get: false, proven: false }, { route: '/api/c', get: true, proven: false }]);
  });
});

/** The POST half, which this file did not have (independent review, 2026-07-30).
 *
 *  The rule above covers every response a GET can reach, because a GET's `ok:false` is ambiguous to the
 *  transport. POST is not the same problem — `postJson` DOES run `isFailureBody`, and
 *  that helper flags any object body carrying `ok:false` — so a POST failure is correctly classified.
 *
 *  What it is NOT guaranteed to carry is a CAUSE. `isFailureBody` falls back to the literal string
 *  "the operation reported ok:false" when there is no `error`/`errors`/`reason`, which is the §5
 *  violation in miniature: the agent is told the call failed and nothing about why, on the trusted-
 *  input routes where a miss is least self-evident (a tap that hit nothing looks exactly like a tap
 *  that worked). The electron routes gained several new `200 + {ok:false}` bodies this day — short
 *  insert, blocked handle, focus miss — and nothing checked that any of them said why.
 *
 *  So: the same responses — ALL of them, since #1179 P4's re-review (see `underCauseRule`) — and a
 *  different rule: a failure body must name its cause. */
describe('every ok:false says WHY', () => {
  const responses = scanned.flatMap(({ rel, responses: rs }) => rs.map((r) => ({ rel, ...r })));

  it('reaches the POST routes at all (a text guard that lost its target fails OPEN)', () => {
    expect(scanned.flatMap((f) => f.gates).filter((g) => !g.get).length,
      'no POST route gates found — did the route dispatch shape change?').toBeGreaterThan(5);
    const withOkFalse = new Set(responses.filter((r) => !r.get && r.route !== '<no route>').map((r) => r.route));
    expect(withOkFalse.size, 'no ok:false POST body found — the parser is not seeing them').toBeGreaterThanOrEqual(3);
  });

  it('every ok:false a route emits carries an error/errors/reason', () => {
    // Without one, `isFailureBody` reports the bare fallback "the operation reported ok:false" for a
    // POST — a failure with no cause, which §5 calls a bug by definition — and a GET's reader gets less.
    const offenders = responses.filter((r) => underCauseRule(r) && !r.hasCause)
      .map((r) => `${r.rel}:${r.line} ${r.route} → ${r.snippet.slice(0, 120)}`);
    expect(offenders,
      'this route answers ok:false with no cause, so the agent is told only THAT it failed. Add an '
      + '`error` (or `errors`/`reason`) naming what was attempted and what to do instead.').toEqual([]);
  });

  it('…and that check CAN fail — mutation-tested against a causeless body', () => {
    const cause = (body: string) => okFalseResponses(`function h() { ${body} }`, 'fixture.ts').map((r) => r.hasCause);
    expect(cause(`return json({ ok: false, typed: 0 });`)).toEqual([false]);
    expect(cause(`return json({ ok: false, typed: 0, error: 'nothing focused' });`)).toEqual([true]);
    // shorthand counts, and so does a cause long after the display cut
    expect(cause(`return json({ ok: false, errors, warnings }, 400);`)).toEqual([true]);
    expect(cause(`return json({ ok: false, a: '${'x'.repeat(200)}', reason: 'late' });`)).toEqual([true]);
    // #1179: the call text matching `error:` is not the body naming a cause — a nested object, a
    // string, and a VALUE spelled `reason` all passed the text check, and none is what isFailureBody reads.
    expect(cause(`return json({ ok: false, detail: { error: 'x' }, note: 'error: y', why: reason });`)).toEqual([false]);
  });
});
