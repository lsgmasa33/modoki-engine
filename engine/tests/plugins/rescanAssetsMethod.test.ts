/** #1967: `/api/rescan-assets` heals GUID collisions and writes sidecars, so it is POST only. A GET (a prefetcher, an
 *  `<img src>`, or a caller that forgot its method) gets a 405 and runs no rescan. Through the real router. */

import { describe, it, expect } from 'vitest';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';

describe('/api/rescan-assets takes POST only (#1967)', () => {
  const run = async (method: string) => {
    let rebuilds = 0;
    const ctx = { projectRoot: '/nowhere', rebuildManifest: () => { rebuilds++; return { version: 2, assets: [] } as Manifest; } } as unknown as BackendContext;
    const r = await handleBackendRequest(ctx, { method, urlPath: '/api/rescan-assets', query: new URLSearchParams(), body: undefined });
    if (!r || r.kind !== 'json') throw new Error('no json reply');
    return { status: r.status ?? 200, rebuilds };
  };

  it.each(['GET', 'HEAD', 'PUT'])('%s is 405 and runs no rescan', async (method) => {
    expect(await run(method)).toEqual({ status: 405, rebuilds: 0 });
  });

  it('ACCEPT: POST rescans', async () => {
    expect(await run('POST')).toEqual({ status: 200, rebuilds: 1 });
  });
});
