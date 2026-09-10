/** Router-level test for GET /api/resolve-refs — the CSV `refs` parse (trim + drop empties) that
 *  feeds the resolve-refs op, and the 504 error branch. Mirrors aiSettingsRouter.test.ts: a stubbed
 *  BackendContext whose requestBrowser records (or throws on) the args it received. */

import { describe, it, expect } from 'vitest';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';

function makeCtx(requestBrowser: (op: string, params: unknown) => Promise<unknown>): BackendContext {
  return {
    projectRoot: '/tmp/x',
    resolveAssetPath: (p: string) => p,
    getSchema: () => undefined,
    firstRootDir: () => null,
    invalidateProjectConfig: () => {},
    requestBrowser,
  } as unknown as BackendContext;
}
const get = (ctx: BackendContext, refs: string) =>
  handleBackendRequest(ctx, { method: 'GET', urlPath: '/api/resolve-refs', query: new URLSearchParams({ refs }), body: undefined });

describe('/api/resolve-refs', () => {
  it('trims and drops empty entries from the CSV before calling the op', async () => {
    let seen: unknown;
    const ctx = makeCtx(async (_op, params) => { seen = params; return { resolved: {} }; });
    await get(ctx, 'a, ,244,');
    expect(seen).toEqual({ refs: ['a', '244'] }); // spaces trimmed, empties (from ', ,' and trailing ',') dropped
  });

  it('passes the op result through as JSON', async () => {
    const ctx = makeCtx(async () => ({ resolved: { a: { name: 'Alpha', alive: true } } }));
    const r = (await get(ctx, 'a')) as { body: unknown };
    expect(r.body).toEqual({ resolved: { a: { name: 'Alpha', alive: true } } });
  });

  /** ⚠️ **This used to assert that ANY throw yields a 504, and that expectation was wrong** (#1013).
   *  `requestBrowser` rejects identically whether the RELAY died or the OP threw, so a blanket 504
   *  told the agent `NOT_AVAILABLE_HERE` — "the editor is unreachable" — for a refusal the editor
   *  had deliberately raised. The status now comes from `relayFailureStatus`, and both directions
   *  are pinned here rather than one.
   *
   *  The old fixture is itself the reason it read as settled: `'renderer offline'` is not a string
   *  any host sends. `isRelayTransportFailure` matches `no renderer` / `renderer went away` /
   *  `renderer reloading` — never `offline` — so the invented message exercised the DEFAULT branch
   *  while looking like it was exercising the transport one. A test that supplies its own error
   *  text can only prove its own spelling. */
  it('classifies a thrown relay error: the op answering is 400', async () => {
    const ctx = makeCtx(async () => { throw new Error('resolve-refs: guid "abc" matched no live entity'); });
    const r = (await get(ctx, 'a')) as { status?: number; body: { error?: string } };
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/matched no live entity/);
  });

  it('classifies a thrown relay error: the relay itself failing keeps the 504', async () => {
    // A real signature from `failPendingRenderer`, not an invented one.
    const ctx = makeCtx(async () => { throw new Error('project changed — renderer reloading'); });
    const r = (await get(ctx, 'a')) as { status?: number; body: { error?: string } };
    expect(r.status).toBe(504);
    expect(r.body.error).toMatch(/renderer reloading/);
  });
});
