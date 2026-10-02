/** #2054 — a move carries the asset's conversion cache with it.
 *
 *  Every conversion cache stores its content-hashed entry UNDER the source's url path, and the hash travels with the
 *  file in its sidecar. Before #2054 nothing moved the cache, so a moved texture or model missed at its new path and the
 *  serve path re-encoded bytes it already had. Paths here are built with each cache's OWN path function
 *  (`cachePathFor`, `processedCachePath`, `atlasPageUrlPath`), so the test follows the real layout, not a copy of it.
 *
 *  Mutations, each checked red here:
 *  - drop the route's `moveConversionCaches` call: "the move route carries…".
 *  - drop the `~` sibling loop: "an atlas's page entries…"; match any `~` suffix (drop the `~page<N>` test): the same case,
 *    by its live `hud.atlas.json~1.png`.
 *  - drop the stale-destination `rmSync`: "an entry left at the destination by a dead asset…".
 *  - drop a getter from `conversionCacheDirs`: "every .cache/modoki-* conversion cache is carried".
 *  - `sameEntry` always false: "a case-only rename keeps the entry" — on a case-FOLDING disk only (macOS/Windows), where
 *    the destination IS the source; on a case-sensitive disk the two are distinct and that case passes either way. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { moveConversionCaches, conversionCacheDirs } from '../../plugins/asset-fs-ops';
import { cachePathFor, getCacheDir } from '../../plugins/texture-cache';
import { processedCachePath, getModelCacheDir } from '../../plugins/model-cache';
import { atlasPageUrlPath } from '../../plugins/atlas-cache';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

let root: string;
beforeEach(() => { root = makeScratchDir('modoki-move-cache-'); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const HASH = '0123456789abcdef';
const put = (abs: string, bytes = 'x') => { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, bytes); };
const texVariant = (url: string) => cachePathFor(getCacheDir(root), url, HASH, 'webp');

describe('moveConversionCaches', () => {
  it('a moved texture`s variants are found at its new url path, and nothing is left at the old one', () => {
    put(texVariant('/assets/a/wood.png'), 'encoded');
    moveConversionCaches(root, '/assets/a/wood.png', '/assets/b/wood.png', false);
    expect(fs.readFileSync(texVariant('/assets/b/wood.png'), 'utf-8')).toBe('encoded');
    expect(fs.existsSync(path.join(getCacheDir(root), 'assets/a/wood.png'))).toBe(false);
  });

  it('a moved model`s processed GLB is found at its new url path', () => {
    put(processedCachePath(getModelCacheDir(root), '/assets/m/cone.glb', HASH));
    moveConversionCaches(root, '/assets/m/cone.glb', '/assets/cone.glb', false);
    expect(fs.existsSync(processedCachePath(getModelCacheDir(root), '/assets/cone.glb', HASH))).toBe(true);
  });

  it('a folder rename carries every entry inside it', () => {
    put(texVariant('/assets/old/x.png'));
    put(texVariant('/assets/old/deep/y.png'));
    moveConversionCaches(root, '/assets/old', '/assets/new', true);
    expect(fs.existsSync(texVariant('/assets/new/x.png'))).toBe(true);
    expect(fs.existsSync(texVariant('/assets/new/deep/y.png'))).toBe(true);
  });

  it('an atlas`s page entries (cached BESIDE it, at `<url>~page<N>`) move with a file move', () => {
    const page = (url: string, n: number) => texVariant(atlasPageUrlPath(url, n));
    put(page('/assets/ui/hud.atlas.json', 0));
    put(page('/assets/ui/hud.atlas.json', 1));
    // Siblings that merely share the prefix are other assets' entries and stay: no `~`, or a `~` that is not a page.
    put(texVariant('/assets/ui/hud.atlas.json2'));
    put(texVariant('/assets/ui/hud.atlas.json~1.png'));
    moveConversionCaches(root, '/assets/ui/hud.atlas.json', '/assets/hud2.atlas.json', false);
    expect(fs.existsSync(page('/assets/hud2.atlas.json', 0))).toBe(true);
    expect(fs.existsSync(page('/assets/hud2.atlas.json', 1))).toBe(true);
    expect(fs.existsSync(texVariant('/assets/ui/hud.atlas.json2'))).toBe(true);
    expect(fs.existsSync(texVariant('/assets/ui/hud.atlas.json~1.png'))).toBe(true);
  });

  it('an entry left at the destination by a dead asset is replaced, not merged into', () => {
    put(texVariant('/assets/a/wood.png'), 'live');
    const stale = cachePathFor(getCacheDir(root), '/assets/b/wood.png', 'fedcba9876543210', 'webp');
    put(stale, 'dead');
    moveConversionCaches(root, '/assets/a/wood.png', '/assets/b/wood.png', false);
    expect(fs.readFileSync(texVariant('/assets/b/wood.png'), 'utf-8')).toBe('live');
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('a case-only rename keeps the entry (same directory on a case-folding disk)', () => {
    put(texVariant('/assets/Sprites/a.png'), 'kept');
    moveConversionCaches(root, '/assets/Sprites', '/assets/sprites', true);
    expect(fs.readFileSync(texVariant('/assets/sprites/a.png'), 'utf-8')).toBe('kept');
  });

  it('an asset with no cache entry is a no-op, and never throws', () => {
    expect(moveConversionCaches(root, '/assets/a.png', '/assets/b.png', false)).toEqual([]);
  });

  it('every .cache/modoki-* conversion cache is carried', () => {
    // The caches that lay entries out under the url path are the `*-cache.ts` modules naming a
    // `.cache/modoki-<kind>` directory. A new one must join `conversionCacheDirs`, or its entries strand on a move.
    const pluginsDir = path.join(__dirname, '../../plugins');
    const declared = fs.readdirSync(pluginsDir)
      .filter((f) => f.endsWith('-cache.ts'))
      .flatMap((f) => [...fs.readFileSync(path.join(pluginsDir, f), 'utf-8').matchAll(/'\.cache',\s*'(modoki-[a-z]+)'/g)].map((m) => m[1]))
      .sort();
    expect(declared.length).toBeGreaterThanOrEqual(6);
    expect(conversionCacheDirs(root).map((d) => path.basename(d)).sort()).toEqual(declared);
  });
});

describe('/api/move-file', () => {
  function ctx(): BackendContext {
    return {
      projectRoot: root,
      resolveAssetPath: (p: string) => path.join(root, p),
      rebuildManifest: () => ({ version: 2, assets: [], folders: [] }),
      getManifest: () => ({ version: 2, assets: [], folders: [] }),
      absToAssetUrl: (abs: string) => `/${path.relative(root, abs).split(path.sep).join('/')}`,
      requestBrowser: async (op: string, params: unknown) => (op === 'resolve-unsaved'
        ? { ok: true, holds: [], discarded: [], covers: (params as { registries?: string[] }).registries ?? [] }
        : { ok: true, notes: [] }),
      getSchema: () => undefined,
      firstRootDir: () => null,
      invalidateProjectConfig: () => {},
      markEditorWrite: () => {},
    } as unknown as BackendContext;
  }

  it('the move route carries the cache, so the serve at the new path hits', async () => {
    put(path.join(root, 'assets/a/wood.png'));
    put(path.join(root, 'assets/a/wood.png.meta.json'), JSON.stringify({ version: 2, id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee2054' }));
    put(texVariant('/assets/a/wood.png'), 'encoded');
    const r = await handleBackendRequest(ctx(), {
      method: 'POST', urlPath: '/api/move-file', query: new URLSearchParams(),
      body: { from: '/assets/a/wood.png', to: '/assets/b/wood.png' },
    }) as { body: Record<string, unknown> };
    expect(r.body).toMatchObject({ ok: true });
    expect(fs.readFileSync(texVariant('/assets/b/wood.png'), 'utf-8')).toBe('encoded');
  });
});
