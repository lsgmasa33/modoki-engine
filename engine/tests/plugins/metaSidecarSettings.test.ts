/** #1696 — `sameImportSettings`: do two committed sidecars hold the same import settings? And the guard that keeps
 *  its list of bake-rewritten blocks complete.
 *
 *  A sidecar is rewritten with nobody editing anything — the scanner heals `id`, every write stamps `version`, every
 *  bake rewrites its cache block AND its settings block with resolved defaults — so the comparison ignores the first
 *  three and compares each settings block through the resolver its bake uses. The route's use of it is pinned in
 *  `deleteAssetPreconditions.test.ts`; this file pins the function and its completeness.
 *
 *  Mutations, each checked, red on the named cases only:
 *  - take `CACHE_BLOCKS` out of `SELF_WRITTEN_KEYS`: "a bake's rewrite of every kind" and the completeness guard
 *    (a bake writes `textureCache`, now a key nothing accounts for).
 *  - drop the `audio` entry from `BAKE_RESOLVED`: "a bake's rewrite of every kind" and the completeness guard.
 *  - compare raw instead of through the resolvers: "a bake's rewrite of every kind".
 *  - compare only the resolved blocks and skip the rest: "any other key is compared as a document". */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sameImportSettings, BAKE_WRITABLE_KEYS } from '../../plugins/meta-sidecar';
import { resolveTextureSettings, resolveTextureType } from '../../packages/modoki/src/runtime/loaders/textureSettings';
import { resolveModelSettings } from '../../packages/modoki/src/runtime/loaders/modelSettings';
import { resolveAudioSettings } from '../../packages/modoki/src/runtime/loaders/audioSettings';
import { resolveVideoSettings } from '../../packages/modoki/src/runtime/loaders/videoSettings';
import { resolveFontSettings } from '../../packages/modoki/src/runtime/core/fontSettings';
import { resolveEnvSettings } from '../../packages/modoki/src/runtime/core/environmentSettings';

describe('sameImportSettings (#1696)', () => {
  it('a bake\'s rewrite of every kind is not a change', () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ id: 'a', texture: { maxSize: 512 } }, { type: resolveTextureType({ texture: { maxSize: 512 } }), texture: resolveTextureSettings({ texture: { maxSize: 512 } }), textureCache: { hash: 'h' } }],
      [{ id: 'a' }, { model: resolveModelSettings({}), modelCache: { hash: 'h' } }],
      [{ id: 'a' }, { audio: resolveAudioSettings({}), audioCache: { hash: 'h' } }],
      [{ id: 'a' }, { video: resolveVideoSettings({}), videoCache: { hash: 'h' } }],
      [{ id: 'a' }, { font: resolveFontSettings({}), fontCache: { hash: 'h' } }],
      [{ id: 'a' }, { environment: resolveEnvSettings({}), environmentCache: { hash: 'h' } }],
    ];
    for (const [before, bake] of cases) expect(sameImportSettings(before, { ...before, ...bake, version: 2, id: 'b' }), JSON.stringify(bake)).toBe(true);
  });

  it('a changed value in a resolved block is a change', () => {
    expect(sameImportSettings({ texture: { maxSize: 512 } }, { texture: { maxSize: 256 } })).toBe(false);
    expect(sameImportSettings({ type: '2d' }, { type: 'ui' })).toBe(false);
  });

  it('any other key is compared as a document, key order ignored', () => {
    expect(sameImportSettings({ border: { l: 1, r: 2 } }, { border: { r: 2, l: 1 } })).toBe(true);
    expect(sameImportSettings({ border: { l: 1 } }, { border: { l: 2 } })).toBe(false);
    expect(sameImportSettings({}, { postprocessor: 'none' })).toBe(false);
  });

  it('a side that is not a document is never the same', () => {
    expect(sameImportSettings(null, {})).toBe(false);
    expect(sameImportSettings({}, [])).toBe(false);
  });
});

describe('every key a bake writes is one sameImportSettings knows about', () => {
  it('each reimport handler\'s `meta.<key> =` is ignored or compared through a resolver', () => {
    const dir = path.resolve(__dirname, '../../plugins');
    const handlers = fs.readdirSync(dir).filter((f) => /^reimport-(?!registry).*\.ts$/.test(f));
    expect(handlers.length).toBeGreaterThanOrEqual(7); // the corpus is really there
    const written = new Map<string, string>();
    for (const f of handlers) {
      for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/\bmeta\.(\w+)\s*=(?!=)/g)) written.set(m[1], f);
    }
    expect(written.size).toBeGreaterThan(0);
    const unknown = [...written].filter(([k]) => !BAKE_WRITABLE_KEYS.has(k));
    expect(unknown, `a bake writes ${unknown.map(([k, f]) => `${k} (${f})`).join(', ')} — add it to BAKE_RESOLVED or SELF_WRITTEN_KEYS in runtime/loaders/sidecarSettings.ts`).toEqual([]);
  });
});
