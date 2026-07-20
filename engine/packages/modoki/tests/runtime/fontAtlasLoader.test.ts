/** fontAtlasLoader lifecycle tests — scene-scoped refcount (acquire/release/dispose)
 *  + the generation guard that prevents a fetch resolving AFTER its scene was
 *  released from re-inserting an owner-less provider (the leak the spine review
 *  flagged). manifest + assetUrl + fetch are mocked so it's pure. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  resolveRef: (g: string) => (g.startsWith('font-') ? `/fonts/${g}.ttf` : undefined),
  getAssetEntry: () => ({ hash: 'h1' }),
  isGuid: (g: unknown) => typeof g === 'string' && g.startsWith('font-'),
  onFontInvalidated: () => () => {},
}));
vi.mock('../../src/runtime/loaders/assetUrl', () => ({
  assetUrl: (p: string) => p,
  withCacheBust: (u: string, h?: string) => (h ? `${u}?v=${h}` : u),
}));

import {
  acquireFont, releaseFontsForScene, getLoadedFont, getFontOwnerCounts, disposeAllFonts,
} from '../../src/runtime/rendering/text/fontAtlasLoader';

const METRICS = {
  atlas: { type: 'mtsdf', distanceRange: 4, width: 64, height: 64, size: 48, yOrigin: 'top' },
  metrics: { emSize: 1, lineHeight: 1.2, ascender: -0.8, descender: 0.2 },
  glyphs: [{ unicode: 65, advance: 0.5 }],
  kerning: [],
};

function mockFetchOnce(json: unknown, deferred?: { resolve: () => void }) {
  const gate = deferred ? new Promise<void>((r) => { deferred.resolve = r; }) : Promise.resolve();
  vi.stubGlobal('fetch', vi.fn(async () => {
    await gate;
    return { ok: true, json: async () => json } as Response;
  }));
}

beforeEach(() => {
  disposeAllFonts();
  vi.unstubAllGlobals();
});

describe('fontAtlasLoader refcount', () => {
  it('acquires once, shares across scenes, disposes at last release', async () => {
    mockFetchOnce(METRICS);
    const p1 = await acquireFont(1, 'font-a');
    expect(p1).not.toBeNull();
    expect(getLoadedFont('font-a')).toBe(p1);
    expect(getFontOwnerCounts()['font-a']).toBe(1);

    const p2 = await acquireFont(2, 'font-a');
    expect(p2).toBe(p1); // same cached provider
    expect(getFontOwnerCounts()['font-a']).toBe(2);

    releaseFontsForScene(1);
    expect(getLoadedFont('font-a')).toBe(p1); // scene 2 still holds it

    releaseFontsForScene(2);
    expect(getLoadedFont('font-a')).toBeUndefined(); // last owner gone → disposed
  });

  it('returns null for an unresolvable / non-guid ref', async () => {
    mockFetchOnce(METRICS);
    expect(await acquireFont(1, 'not-a-font')).toBeNull();
  });
});

describe('fontAtlasLoader generation guard (scene-swap race)', () => {
  it('does NOT re-insert a provider whose scene was released mid-fetch', async () => {
    const deferred = {} as { resolve: () => void };
    mockFetchOnce(METRICS, deferred);

    const pending = acquireFont(1, 'font-b'); // fetch is gated (in flight)
    expect(getFontOwnerCounts()['font-b']).toBe(1);

    releaseFontsForScene(1);                    // scene released before fetch resolves
    deferred.resolve();                         // now let the fetch complete
    const result = await pending;

    expect(result).toBeNull();                  // guard refused to cache
    expect(getLoadedFont('font-b')).toBeUndefined(); // no orphaned provider
    expect(getFontOwnerCounts()['font-b']).toBeUndefined();
  });
});
