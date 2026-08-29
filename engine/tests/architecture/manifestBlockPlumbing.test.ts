/** Every block on `AssetEntry` must actually be PLUMBED — written by `registerAsset`, forwarded
 *  by `loadManifestJson`, and emitted by `serializeManifest`.
 *
 *  WHY (QA-ASSET-0007). `textureType` was declared on `AssetEntry`, read in exactly one place
 *  (`resolveBrowserImageUrl` → `browserVariant`), and written by NOBODY: `loadManifestJson`
 *  passed `entry.texture` plus a hand-maintained extras object and simply omitted it, and
 *  `serializeManifest` dropped it on the way out. Nothing failed — TypeScript is perfectly happy
 *  with an optional property nobody assigns, and the ONE consumer treated `undefined` as a
 *  legitimate value ("infer the type from the format"), which silently resolved every `ui`-typed
 *  KTX2 texture to the source PNG production strips.
 *
 *  That failure is structural, not incidental: `registerAsset` takes each block EXPLICITLY, so a
 *  block added to the interface is opt-in at three separate sites and its absence is invisible at
 *  all three. This guard makes the omission loud instead.
 *
 *  A source scan rather than a round-trip, deliberately: a round-trip can only exercise a field it
 *  knows how to SET, so a newly-added block nobody plumbed is exactly the one it would skip. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';

const SRC = path.resolve(__dirname, '../../packages/modoki/src/runtime/loaders/assetManifest.ts');
const src = readFileSync(SRC, 'utf-8');
const strippedSrc = stripComments(src);
assertScanIsSane(src, strippedSrc, SRC);

/** Optional field names declared on an interface, comments stripped (shared scanner,
 *  @modoki/engine/testing, #419). */
function declaredFields(iface: string): string[] {
  const m = strippedSrc.match(new RegExp(`export interface ${iface}\\s*\\{([\\s\\S]*?)\\n\\}`));
  expect(m, `${iface} not found in assetManifest.ts`).toBeTruthy();
  const body = m![1];
  return [...new Set([...body.matchAll(/^\s*(\w+)\??:/gm)].map((x) => x[1]))];
}

/** The body of the single `guidToEntry.set(guid, {…})` literal — what registerAsset writes. */
const written = (() => {
  const m = src.match(/guidToEntry\.set\(guid, \{([\s\S]*?)\n {2}\}\);/);
  expect(m, 'guidToEntry.set literal not found').toBeTruthy();
  return new Set([...m![1].matchAll(/^\s*(\w+):/gm)].map((x) => x[1]).concat(['guid', 'path', 'type']));
})();

/** The `registerAsset(entry.guid, …)` call inside loadManifestJson — what it forwards. */
const forwarded = (() => {
  const m = src.match(/registerAsset\(entry\.guid[\s\S]*?entry\.hash\);/);
  expect(m, 'loadManifestJson registerAsset call not found').toBeTruthy();
  return new Set([...m![0].matchAll(/entry\.(\w+)/g)].map((x) => x[1]));
})();

/** The `assets.push({…})` literal in serializeManifest — what it emits. */
const emitted = (() => {
  const m = src.match(/assets\.push\(\{([\s\S]*?)\n {4}\}\);/);
  expect(m, 'serializeManifest assets.push literal not found').toBeTruthy();
  return new Set([...m![1].matchAll(/(\w+):/g)].map((x) => x[1]));
})();

describe('asset-manifest block plumbing', () => {
  it('registerAsset writes every field declared on AssetEntry', () => {
    expect(declaredFields('AssetEntry').filter((f) => !written.has(f))).toEqual([]);
  });

  it('serializeManifest emits every field declared on AssetEntry', () => {
    expect(declaredFields('AssetEntry').filter((f) => !emitted.has(f))).toEqual([]);
  });

  it('loadManifestJson forwards every AssetManifestEntry field the runtime entry carries', () => {
    // `name` is scanner/panel-only (no `AssetEntry.name`), and `path` is forwarded through the
    // `pathPrefix` local rather than as `entry.path` — everything else must be passed on.
    const runtimeFields = new Set(declaredFields('AssetEntry'));
    const missing = declaredFields('AssetManifestEntry')
      .filter((f) => runtimeFields.has(f) && f !== 'path' && !forwarded.has(f));
    expect(missing).toEqual([]);
  });

  it('finds the three sites at all — a rename must fail loudly, not vacuously pass', () => {
    // A guard that silently matches nothing is worse than no guard: it would have vouched for
    // exactly the bug it exists to catch. Pin non-trivial sizes so a regex that stops matching
    // shows up as a failure here rather than as three empty diffs above.
    expect(declaredFields('AssetEntry').length).toBeGreaterThan(10);
    expect(written.size).toBeGreaterThan(10);
    expect(forwarded.size).toBeGreaterThan(10);
    expect(emitted.size).toBeGreaterThan(10);
  });
});
