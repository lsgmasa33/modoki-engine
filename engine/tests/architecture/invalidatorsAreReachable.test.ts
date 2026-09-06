/**
 * Every exported `invalidate<Something>` cache-invalidator has a real production caller (#74).
 *
 * `liveReloadKinds.test.ts` (this file's sibling) cross-checks the PRODUCER union (`LiveReloadKind`
 * + `classifySceneChange` in `engine/plugins/vite-asset-scanner.ts`) against the CONSUMER union
 * (`SceneChangedKind` + `ASSET_CACHE_INVALIDATORS` in `engine/app/debug/agentBridge.ts`). That guard
 * has a blind spot: a kind missing from BOTH unions passes, because the two sides agree with each
 * other while agreeing on the wrong set — exactly how `animset` (a real shipped asset kind that
 * `detectType` classifies correctly) went unmentioned by either union without either test noticing.
 *
 * This guard is reachable independently of both unions: it enumerates every exported
 * `invalidate<Something>` function under `runtime/loaders/*.ts` directly from the loader source,
 * and requires each one to be either wired into `ASSET_CACHE_INVALIDATORS` (the live-reload path)
 * or named in an explicit allowlist below with a verified real caller. It encodes the actual defect
 * — "an exported invalidator nothing in production calls" — rather than one symptom of it.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';

const REPO = path.resolve(__dirname, '../../..');
const LOADERS_DIR = path.join(REPO, 'engine/packages/modoki/src/runtime/loaders');
const consumerSrc = readScannedSource(path.join(REPO, 'engine/app/debug/agentBridge.ts')).code;

/** Every `export function invalidate<Something>(` across the loader modules, with the file that
 *  defines it (for a failure message that doesn't force a repo-wide grep). */
function findInvalidators(): Array<{ name: string; file: string }> {
  const out: Array<{ name: string; file: string }> = [];
  for (const entry of fs.readdirSync(LOADERS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const src = readScannedSource(path.join(LOADERS_DIR, entry.name)).code;
    for (const m of src.matchAll(/export function (invalidate[A-Za-z0-9]+)\s*\(/g)) {
      out.push({ name: m[1], file: entry.name });
    }
  }
  return out;
}

/** Identifiers used as VALUES in the `ASSET_CACHE_INVALIDATORS` object literal, e.g.
 *  `animation: invalidateAnimationClip,` → `invalidateAnimationClip`. Same slicing idiom as
 *  liveReloadKinds.test.ts's `tableBody` extraction. */
function invalidatorTableValues(src: string): string[] {
  const start = src.indexOf('const ASSET_CACHE_INVALIDATORS');
  if (start === -1) throw new Error('could not find "const ASSET_CACHE_INVALIDATORS" — did it move or get renamed?');
  const table = src.slice(start);
  const body = table.slice(0, table.indexOf('};'));
  return [...body.matchAll(/:\s*(invalidate[A-Za-z0-9]+)\s*[,}]/g)].map((m) => m[1]);
}

const INVALIDATORS = findInvalidators();
const WIRED = new Set(invalidatorTableValues(consumerSrc));

/**
 * Invalidators NOT wired into `ASSET_CACHE_INVALIDATORS` (the live-reload watcher path), each with
 * the REAL production caller that drives it by a different mechanism instead — verified by reading
 * the call site, not assumed. This is a list of invalidators driven by a DIFFERENT mechanism, NOT a
 * list of exemptions: adding a name here without a verified caller defeats the entire guard, because
 * it makes the test green while the underlying defect (an invalidator nothing calls) still exists.
 */
const ALLOWLIST: Record<string, string> = {
  // Driven by the agent/editor "invalidate-assets" op (agentBridge.ts registerAgentOp) and directly
  // by editor asset-view panels on manual re-import/edit — not by the live-reload file watcher.
  invalidateTexture: 'agentBridge.ts registerAgentOp(\'invalidate-assets\') + makeTexture2D.ts, TextureAssetView.tsx, assetViews/reimport.ts, editor/scene/modelImport.ts',
  invalidateAudio: 'agentBridge.ts registerAgentOp(\'invalidate-assets\') + assetViews/reimport.ts, AudioAssetView.tsx',
  invalidateModel: 'agentBridge.ts registerAgentOp(\'invalidate-assets\') + assetViews/reimport.ts, ModelAssetView.tsx, editor/scene/modelImport.ts',
  invalidateEnvironment: 'agentBridge.ts registerAgentOp(\'invalidate-assets\') + assetViews/reimport.ts, EnvironmentAssetView.tsx',
  // Font invalidation has its OWN channel: assetManifest.ts's onFontInvalidated(...) fires these
  // directly (module-load subscriptions in fontAtlasLoader.ts / fontLoader.ts) whenever a font
  // re-import or Font-Inspector mode flip changes the manifest hash — not via the scene-change path.
  invalidateFont: 'assetManifest.ts onFontInvalidated(...) fires it — subscribed at module load in fontAtlasLoader.ts',
  invalidateFontFace: 'assetManifest.ts onFontInvalidated(...) fires it — subscribed at module load in fontLoader.ts',
  // Materials/prefabs/rigged models are edited through their own Inspector asset-view panels
  // (editor/panels/assetViews/persist.ts wraps the invalidator per asset kind) or the prefab
  // apply/instantiate flow — not the live-reload watcher.
  //
  // ⚠️ `invalidateAnimSet` is deliberately NOT here: it has an Inspector caller too, but that
  // serves only edits made INSIDE the editor. It is wired into ASSET_CACHE_INVALIDATORS as well,
  // so an external write (an agent tool, or a plain file Write) invalidates it. An Inspector
  // caller is not on its own enough to allowlist a kind whose files are also written from outside.
  invalidateMaterial: 'editor/scene/modelImport.ts + meshTemplateCache.ts\'s own retired-texture sweep, and assetViews/persist.ts\'s invalidateMaterialFile called from MaterialAssetView.tsx / MaterialBatchView.tsx',
  invalidatePrefab: 'editor/scene/prefab.ts (prefab apply/instantiate flow)',
  invalidateRiggedModel: 'editor/scene/modelImport.ts (rigged-model re-import step)',
};

describe('every invalidator is reachable from production (#74)', () => {
  it('found a plausible number of invalidators (sanity: the parse works, so a pass means something)', () => {
    expect(INVALIDATORS.length).toBeGreaterThan(10);
    expect(WIRED.size).toBeGreaterThan(2);
  });

  it('every exported invalidator is wired into ASSET_CACHE_INVALIDATORS or verified in the allowlist', () => {
    const unreachable = INVALIDATORS.filter(
      (inv) => !WIRED.has(inv.name) && !(inv.name in ALLOWLIST),
    );
    expect(
      unreachable,
      'These invalidators (name + defining file) have no caller in ASSET_CACHE_INVALIDATORS and no ' +
        'verified allowlist entry here. The silent symptom: the asset cache holds its PRE-EDIT ' +
        'contents forever, which reads as "my change was ignored" rather than as a stale cache, and ' +
        'a read_asset_def → write_asset round-trip reverts the file that was just written (the read ' +
        'reports the live cache as authoritative). Fix it one of two ways: (1) wire the invalidator ' +
        'into ASSET_CACHE_INVALIDATORS in engine/app/debug/agentBridge.ts, or (2) if it is genuinely ' +
        'driven by a different mechanism, add it to the ALLOWLIST above with a one-line reason naming ' +
        'the REAL caller you verified by reading the call site — never add a name here on assumption.',
    ).toEqual([]);
  });
});
