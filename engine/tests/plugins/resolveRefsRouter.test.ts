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

  it('a throwing requestBrowser yields a 504 error body', async () => {
    const ctx = makeCtx(async () => { throw new Error('renderer offline'); });
    const r = (await get(ctx, 'a')) as { status?: number; body: { error?: string } };
    expect(r.status).toBe(504);
    expect(r.body.error).toMatch(/renderer offline/);
  });
});
