/** assetFetch — dev-only no-store cache policy for asset-content fetches.
 *
 *  Guards the "editor loads a stale level" bug: in the editor (dev) a scene/prefab/
 *  asset re-fetched after a file change MUST read fresh, not a browser-cached copy.
 *  In a production build the default HTTP cache is kept (immutable assets). */

import { describe, it, expect } from 'vitest';
import { assetFetchInit } from '../../src/runtime/loaders/assetFetch';

describe('assetFetchInit', () => {
  it('bypasses the HTTP cache in dev (editor) — no-store', () => {
    expect(assetFetchInit(true)).toEqual({ cache: 'no-store' });
  });

  it('keeps the default cache in a production build', () => {
    expect(assetFetchInit(false)).toEqual({});
  });

  it('returns a value spreadable into fetch() options without clobbering others', () => {
    const signal = new AbortController().signal;
    const dev = { signal, ...assetFetchInit(true) };
    expect(dev).toEqual({ signal, cache: 'no-store' });
    const prod = { signal, ...assetFetchInit(false) };
    expect(prod).toEqual({ signal });
  });
});
