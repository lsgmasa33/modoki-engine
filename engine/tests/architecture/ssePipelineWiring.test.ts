/**
 * #1259 wiring guard: the SSE routes in `vite-asset-scanner.ts` may not start a DETACHED async body
 * (an async IIFE whose promise nobody holds), and the plugin's middleware may not be registered as a
 * bare async function. Either shape drops a rejection on the floor, and on an SSE route that leaves
 * the dialog spinning — `runSsePipeline` / `catchMiddlewareRejection` (engine/plugins/ssePipeline.ts)
 * are the one way to write each. Behaviour is covered by ssePipeline.test.ts and
 * sseRouteRejection.test.ts; this file stops a route re-growing the LITERAL old shape.
 *
 * ⚠️ Scope, stated honestly: it recognises the literal IIFE and the literal async-function argument.
 * An equivalent detached body written another way passes it — a named `const run = async () => …;
 * run().finally(…)`, `Promise.resolve().then(async …)`, `setImmediate(async …)`, or a middleware
 * bound to a name first. The `runSsePipeline` census below catches a route that STOPS using the
 * helper; a brand-new fifth route in one of those shapes is caught by review, not by this file.
 *
 * Scope: `vite-asset-scanner.ts` is the only file that PRODUCES an SSE stream (Electron's
 * backendServer.ts proxies these same routes to it). Other async IIFEs in engine/plugins assign their
 * promise to an in-flight slot that callers await, which is not this defect.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { parseSource, findNodes, lineOf, ts } from '@modoki/engine/testing/sourceAst';
import { readScannedSource } from '@modoki/engine/testing';

const REPO = path.resolve(__dirname, '../../..');
const SCANNER = path.join(REPO, 'engine/plugins/vite-asset-scanner.ts');

function unparen(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

function isAsyncFunctionLiteral(e: ts.Expression): boolean {
  const u = unparen(e);
  return (ts.isArrowFunction(u) || ts.isFunctionExpression(u))
    && !!ts.getModifiers(u)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

/** An async IIFE whose promise is DISCARDED: the call (optionally through `.then/.catch/.finally`
 *  chains) is an expression statement, or the operand of `void`. Assigned or awaited IIFEs pass. A
 *  `.catch(…)` in the chain does NOT exempt it: `.catch(console.error)` handles the rejection and still
 *  leaves the stream open, which is the defect — the SSE shape is `runSsePipeline`, nothing else. */
function detachedAsyncIifes(sf: ts.SourceFile): number[] {
  const lines: number[] = [];
  for (const call of findNodes(sf, ts.isCallExpression)) {
    if (!isAsyncFunctionLiteral(call.expression)) continue;
    let top: ts.Node = call;
    while (
      ts.isPropertyAccessExpression(top.parent) && top.parent.expression === top
      && ts.isCallExpression(top.parent.parent) && top.parent.parent.expression === top.parent
    ) top = top.parent.parent;
    while (ts.isParenthesizedExpression(top.parent)) top = top.parent;
    if (ts.isExpressionStatement(top.parent) || ts.isVoidExpression(top.parent)) lines.push(lineOf(call));
  }
  return lines;
}

/** `x.middlewares.use(<async function literal>)` — registered without the rejection catch. */
function bareAsyncMiddlewares(sf: ts.SourceFile): number[] {
  return findNodes(sf, ts.isCallExpression)
    .filter((c) => ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === 'use'
      && ts.isPropertyAccessExpression(c.expression.expression) && c.expression.expression.name.text === 'middlewares')
    .filter((c) => c.arguments.some((a) => isAsyncFunctionLiteral(a)))
    .map(lineOf);
}

function callsNamed(sf: ts.SourceFile, name: string): number {
  return findNodes(sf, ts.isCallExpression).filter((c) => ts.isIdentifier(c.expression) && c.expression.text === name).length;
}

describe('#1259: SSE pipelines and the middleware go through ssePipeline.ts', () => {
  const sf = parseSource(readScannedSource(SCANNER).code, 'vite-asset-scanner.ts');

  it('starts no detached async IIFE', () => {
    expect(detachedAsyncIifes(sf), 'wrap the pipeline in runSsePipeline(res, headline, async () => …, onEnd)').toEqual([]);
  });

  it('registers no bare async middleware', () => {
    expect(bareAsyncMiddlewares(sf), 'wrap it in catchMiddlewareRejection(async (req, res, next) => …)').toEqual([]);
  });

  it('runs all four SSE pipelines through runSsePipeline and wraps the middleware once', () => {
    // build, OTA publish, add-native-target, toolchain install. A LOWER count means a route stopped
    // using the helper by a shape the two checks above do not recognise.
    expect(callsNamed(sf, 'runSsePipeline')).toBe(4);
    expect(callsNamed(sf, 'catchMiddlewareRejection')).toBe(1);
  });

  describe('the detectors (reject and accept side)', () => {
    const probe = (code: string) => parseSource(code, 'probe.ts');

    it('flags the pre-#1259 shapes', () => {
      expect(detachedAsyncIifes(probe('(async () => { await x(); })();'))).toHaveLength(1);
      expect(detachedAsyncIifes(probe('(async () => { await x(); })().finally(release);'))).toHaveLength(1);
      expect(detachedAsyncIifes(probe('void (async function () { await x(); })();'))).toHaveLength(1);
      // A logged rejection still leaves the dialog spinning — .catch is not the SSE shape.
      expect(detachedAsyncIifes(probe('(async () => { await x(); })().catch(console.error).finally(release);'))).toHaveLength(1);
      expect(bareAsyncMiddlewares(probe('server.middlewares.use(async (req, res, next) => { next(); });'))).toHaveLength(1);
    });

    it('passes the wrapped shapes and a held in-flight promise', () => {
      expect(detachedAsyncIifes(probe('void runSsePipeline(res, "h", async () => { await x(); }, release);'))).toEqual([]);
      expect(detachedAsyncIifes(probe('inFlight = (async () => { await x(); })();'))).toEqual([]);
      expect(detachedAsyncIifes(probe('const p = (async () => 1)(); await (async () => 2)();'))).toEqual([]);
      expect(detachedAsyncIifes(probe('(() => { x(); })();'))).toEqual([]);
      expect(bareAsyncMiddlewares(probe('server.middlewares.use(catchMiddlewareRejection(async (req, res, next) => { next(); }));'))).toEqual([]);
    });
  });
});
