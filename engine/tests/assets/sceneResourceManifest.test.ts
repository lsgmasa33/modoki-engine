/**
 * Guard for #135's "Also worth deciding" item: a scene's stored `resources` manifest
 * going STALE relative to what the engine's own collector would derive from its
 * entities right now — previously detectable only by accident, during a periodic
 * editor re-save sweep (#124), never by a test.
 *
 * What "stale" costs — read this before treating a failure here as a load-bearing
 * bug, because #135's own framing overstates it:
 *   - The RUNTIME does not depend on the stored manifest being complete.
 *     `SceneManager.collectSceneResourceRefs` UNIONS the stored `resources` with a
 *     FRESH `collectResourceRefsFromEntities` walk, so a MISSING file entry
 *     self-heals at load ("resources is a hint, not the authority" —
 *     docs/scene-loading.md).
 *   - The BUILD does not depend on it either. `asset-tree-shaker.ts` reads
 *     `resources` but also walks entities regardless, specifically to catch
 *     "fields not yet in resources[]".
 *   - So what a stale manifest actually costs is REVIEW NOISE — an incidental save
 *     produces a large diff that buries real edits — plus a stored fact that lies to
 *     the next reader who trusts it without re-deriving.
 * The real hazard was always a BLIND WALKER (#123: a ref the collector itself cannot
 * see), not a stale FILE — and this guard cannot see that class at all, because it
 * compares the file against the SAME walker. A ref invisible to the walker is
 * invisible to both sides of this comparison. A guard that overstated its own reach
 * would be worse than no guard, so: this one only catches drift BETWEEN a committed
 * file and the collector that produced it (or should have), never a walker that is
 * itself blind to some field.
 *
 * Compared by the pair (type, path) in BOTH directions, not by count — a count is
 * exactly the property a 1-for-1 wrong swap preserves (the #135 example: a stored
 * `deriveGuid('sprite:'+texture)` sprite guid where the collector emits the
 * underlying TEXTURE guid — same count, wrong entry on both sides).
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { findAssetRoots, readAssetGuid, detectType, type AssetRoot } from '../../plugins/vite-asset-scanner';
import { registerAsset, deriveGuid, type AssetType } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { collectResourceRefsFromEntities, type SceneResourceRef, type SceneEntityEntry } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { hasAnyProject } from '../helpers/repoLayout';

// engine/tests/assets/ → repo root (games/ + demos/ + engine/packages/modoki live there).
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const hasProjectAssets = hasAnyProject();

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function urlFor(abs: string, roots: AssetRoot[]): string | null {
  for (const r of roots) {
    if (abs.startsWith(r.absDir + path.sep)) {
      return (r.urlPrefix + '/' + path.relative(r.absDir, abs).replace(/\\/g, '/')).normalize('NFC');
    }
  }
  return null;
}

/** Collect (url, type, abs) for every shippable asset under the real project roots —
 *  same approach as assetRefIntegrity.test.ts, deliberately not reinvented. */
function collectAssets() {
  const roots = findAssetRoots(PROJECT_ROOT);
  const assets: { url: string; type: string; abs: string }[] = [];
  for (const r of roots) {
    for (const abs of walk(r.absDir)) {
      const url = urlFor(abs, roots);
      if (!url) continue;
      const ext = path.extname(url).toLowerCase();
      const type = detectType(url, ext);
      if (!type) continue;
      assets.push({ url, type, abs });
    }
  }
  return { roots, assets };
}

const { assets } = collectAssets();

// The one hard prerequisite: collectResourceRefsFromEntities's generic game-trait
// sweep (and the Renderable2D/Renderable3DPrimitive dynamic-type checks) call
// getAssetType(guid) from assetManifest.ts. With an EMPTY manifest that silently
// under-collects — an unknown guid maps to `undefined` and the sweep SKIPS it
// rather than erroring — which would flood this guard with false STALE reports
// instead of real ones. So populate the manifest from disk, at module scope,
// before any scene is walked.
for (const a of assets) {
  const guid = readAssetGuid(a.abs, a.type);
  if (!guid) continue;
  registerAsset(guid, a.url, a.type as AssetType);
  registerSpritesOf(a.abs, guid);
}

/** Register the SPRITE guids a texture owns but does not carry as its own id — mirroring
 *  `vite-asset-scanner.ts`, which emits a `'sprite'` sub-entry per slice (guid listed in the
 *  parent texture's `.meta.json` `sprites[]`, no file of its own) and, for an UNSLICED 2D/UI
 *  texture, one auto whole-image sprite under `deriveGuid('sprite:' + textureGuid)`.
 *
 *  Measured, not anticipated: without this the guard reported `STALE texture:7b5534ab…` on
 *  games/space-invader/main.scene.json — a real sub-sprite of catvader.png (whose sidecar `id` is
 *  a different guid), referenced from the game trait `SpaceInvaderAssets.catvaderSprite`. The
 *  collector's generic game-trait sweep types a ref by `getAssetType(guid)`, so an unregistered
 *  guid is SKIPPED rather than mistyped — which surfaces as a false STALE on a manifest entry
 *  that is in fact correct. (Confirmed correct: the editor's own re-save left that scene alone.)
 *
 *  Over-registering here is SAFE and under-registering is not, which is why the derived
 *  whole-image guid is registered without re-deriving the scanner's exact dimension/type
 *  preconditions: a guid no scene references has no effect on any comparison, whereas a guid the
 *  scanner knows and this file does not becomes a false finding. */
function registerSpritesOf(abs: string, textureGuid: string): void {
  let meta: { sprites?: Array<{ guid?: string }>; type?: string };
  try { meta = JSON.parse(fs.readFileSync(abs + '.meta.json', 'utf-8')); } catch { return; }
  const slices = Array.isArray(meta.sprites) ? meta.sprites : [];
  if (slices.length > 0) {
    for (const s of slices) if (s.guid) registerAsset(s.guid, `${abs}#${s.guid}`, 'sprite');
    return;
  }
  if (meta.type === '2d' || meta.type === 'ui') {
    registerAsset(deriveGuid('sprite:' + textureGuid), `${abs}#sprite`, 'sprite');
  }
}

const scenes = assets.filter((a) => a.type === 'scene');

describe('scene resources manifest matches the live collector (real assets)', () => {
  it.skipIf(!hasProjectAssets)('populates the asset manifest before walking any scene (sanity: the scan actually found assets)', () => {
    // Mirrors assetRefIntegrity.test.ts's own sanity check: asserts the SCAN + the
    // manifest population worked, not that any particular asset kind exists. A silent
    // no-op here would make every per-scene assertion below pass vacuously.
    expect(assets.length).toBeGreaterThan(0);
    expect(scenes.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasProjectAssets)('every scene\'s stored resources[] equals what collectResourceRefsFromEntities derives from its entities', () => {
    const findings: string[] = [];
    for (const s of scenes) {
      const json = JSON.parse(fs.readFileSync(s.abs, 'utf-8')) as {
        entities?: SceneEntityEntry[];
        resources?: SceneResourceRef[];
      };
      const entities = json.entities ?? [];
      const stored = new Set((json.resources ?? []).map((r) => `${r.type}:${r.path}`));
      const derived = new Set(collectResourceRefsFromEntities(entities).map((r) => `${r.type}:${r.path}`));

      for (const key of derived) {
        if (!stored.has(key)) findings.push(`${s.url}: MISSING ${key}`);
      }
      for (const key of stored) {
        if (!derived.has(key)) findings.push(`${s.url}: STALE ${key}`);
      }
    }
    expect(findings).toEqual([]);
  });
});
