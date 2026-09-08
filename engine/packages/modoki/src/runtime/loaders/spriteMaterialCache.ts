/** spriteMaterialCache — resolves a 2D-material GUID (`space:'2d'` `.shader.json`) to
 *  a compiled {@link PixiShaderProgram}, once, and hands the shared program to Scene2D
 *  so each entity can mint its own per-entity `Shader`. The 2D twin of the material
 *  half of `meshTemplateCache` (the 3D `resolveMaterial`).
 *
 *  Lifecycle: LAZY, and cleared wholesale on world swap — mirroring how Scene2D owns
 *  its sprite textures (`releaseSpriteTexture` + clear-on-swap), NOT the finer
 *  per-sceneId acquire that `meshTemplateCache` uses. A compiled program holds no GPU
 *  memory of its own (the per-entity `Shader`/`UniformGroup` do, and Scene2D disposes
 *  those with its slots; Pixi caches the underlying GlProgram/GpuProgram by source), so
 *  a program is cheap to drop and recompile — the scene-scoped-refcount "survive a
 *  swap" optimization isn't worth its bookkeeping here. (If 2D materials ever gain
 *  heavy per-program resources, promote this to the meshTemplateCache Set<sceneId>
 *  pattern + SceneManager pre-acquire.)
 *
 *  The draw path calls {@link ensureSpriteMaterial} every frame: it kicks off the async
 *  compile once and returns the program as soon as it's ready (undefined until then, so
 *  Scene2D falls back to the default texture/tint path — a brief pop-in, like sprites). */

import type { PixiShaderProgram } from '../rendering/pixiShaderBuilder';
import { buildPixiShaderProgram, invalidatePixiShaderProgram } from '../rendering/pixiShaderBuilder';
import { resolveRefWarnOnce } from './modelGlbUrl';
import { createTeardownToken } from '../core/liveness';
import { isGuid } from '../core/assetRefRules';
import { getGuidForPath, resolveRef } from './assetManifest';
import { emitAssetInvalidated } from '../core/assetInvalidation';
import { notifyListeners } from '../core/notifyListeners';

const programs = new Map<string, PixiShaderProgram>(); // guid → resolved program
const loading = new Map<string, Promise<void>>();      // guid → in-flight compile
const waiters = new Map<string, Set<() => void>>();    // guid → onReady wakes awaiting the in-flight compile
const failed = new Set<string>();                      // guid → compile returned null (don't retry every frame)
// Teardown liveness, KEYED BY GUID (#852) — same shape as spriteAnimCache/particleCache/etc. An
// in-flight compile captures it BY GUID before starting and bails on resolve/reject if either the
// whole-module generation OR that guid's own generation has moved, so a compile superseded by a
// wholesale clear (world swap, `Scene2D.stop()`) OR by a per-key `invalidateShader` for THIS guid
// (a `.shader.json` save for exactly this material) can't write a stale program back in, or worse,
// delete the map entries a NEW compile for the same guid installed after the invalidation.
// Per-key matters because #842 wired `invalidateShader` to the live-reload watcher too, which
// hands a per-PATH signal (one `.shader.json` changed) — routing that through the wholesale
// `clearSpriteMaterialCache()` dropped every OTHER compiled 2D material program in the scene for
// an edit to just one of them, flashing every material entity's fallback sprite for a frame
// (#852). Keying liveness by guid is what lets `invalidateShader` evict ONLY the edited guid's
// entry without superseding any other guid's in-flight compile.
const liveness = createTeardownToken<string>();
// Parity fix, close-out sweep of QA-ANIM-0018: `resolveRef` never warns for a validly-shaped
// guid simply absent from the manifest — the comment below claiming "resolveRef already warned"
// was wrong. Separate from `failed` above: this one forgets a guid once it resolves (so a LATER
// genuine break warns again), where `failed` intentionally stays sticky until a world swap.
const unknownGuidSeen = new Set<string>();

/** The resolved program for a material GUID, or undefined if not (yet) available. */
export function getSpriteMaterialProgram(guid: string): PixiShaderProgram | undefined {
  return programs.get(guid);
}

/** Ensure a material GUID's program is compiling/compiled and return it if ready.
 *  Starts the async build on first sight; returns undefined while loading or after a
 *  permanent failure (caller falls back to the default sprite shader).
 *
 *  `onReady` (optional) is invoked when an in-flight compile resolves to a usable program —
 *  the caller passes `() => markDirty()` so the idle whole-frame gate wakes and the entity
 *  swaps from its fallback sprite to the material Mesh even while the sim is stopped (mirrors
 *  makeSprite's Assets.load `.then(markDirty)` / the font-load pattern). EVERY waiting caller's
 *  `onReady` is kept and fired — not just the first — so with two live viewports (editor
 *  GameView + SceneView, each its own renderer + `markDirty`) BOTH wake when the program lands;
 *  keeping only the first left the second viewport drawing its fallback sprite until an
 *  unrelated dirty. */
export function ensureSpriteMaterial(guid: string, onReady?: () => void): PixiShaderProgram | undefined {
  if (!guid) return undefined;
  const ready = programs.get(guid);
  if (ready) return ready;
  if (failed.has(guid)) return undefined;
  if (loading.has(guid)) {
    // Compile already in flight (another entity/viewport kicked it) — register this caller's
    // wake too so it re-runs the frame when the program lands.
    if (onReady) waiters.get(guid)?.add(onReady);
    return undefined;
  }

  const path = resolveRefWarnOnce(guid, 'spriteMaterialCache', unknownGuidSeen);
  if (!path) { failed.add(guid); return undefined; } // unresolved GUID — warned once above

  const set = new Set<() => void>();
  if (onReady) set.add(onReady);
  waiters.set(guid, set);
  const stillLive = liveness.capture(guid);
  const p = buildPixiShaderProgram(path)
    .then((program) => {
      // Superseded by a clear mid-compile — a NEW compile for this guid may already own
      // `loading`/`waiters`; touching either here would delete the new one's in-flight entry
      // and orphan its waiters. Bail before any map write, and don't cache a program built
      // against source a clear (e.g. a `.shader.json` save) may have already made stale.
      if (!stillLive()) return;
      loading.delete(guid);
      const wakes = waiters.get(guid); waiters.delete(guid);
      // Isolated per waiter (#888), and the ordering is why it matters: `waiters.delete(guid)`
      // above has already run, so a throwing waiter used to leave every waiter behind it parked
      // forever with nothing left to settle them. Same shape as `fontTexturePixi.settleWaiters`.
      if (program) { programs.set(guid, program); if (wakes) notifyListeners(wakes, 'spriteMaterialCache', []); }
      else failed.add(guid); // missing body / wrong space / reserved-name — buildPixiShaderProgram warned
    })
    .catch((e) => {
      console.warn(`[spriteMaterialCache] failed to build 2D material ${guid}: ${e instanceof Error ? e.stack || e.message : String(e)}`);
      if (!stillLive()) return; // superseded — see .then above
      loading.delete(guid); waiters.delete(guid);
      failed.add(guid);
    });
  loading.set(guid, p);
  return undefined;
}

/** Drop every cached program + in-flight/failed marker. Called on world swap and full
 *  teardown; entities re-`ensure` their material on the next frame. */
export function clearSpriteMaterialCache(): void {
  // Invalidating liveness supersedes every in-flight compile, and a superseded resolve/reject
  // (see the `!stillLive()` bails above) deliberately fires no `onReady` wake. That's fine
  // for a caller that re-dirties itself after clearing (world swap, `persistAssetEdit`) — but a
  // renderer still LIVE after the clear (`Scene2D.stop()` clears this shared cache while a
  // sibling viewport keeps drawing) loses the only signal that would make it re-`ensure`, and its
  // entities are stuck on the fallback sprite until some unrelated dirty. So snapshot the pending
  // waiters BEFORE invalidating/clearing, then fire them AFTER — a re-entrant `ensureSpriteMaterial`
  // from a wake sees a clean cache and the new liveness generation, not the one being torn down. (#523)
  const pending = [...waiters.values()].flatMap((set) => [...set]);
  liveness.invalidateAll();
  programs.clear();
  loading.clear();
  waiters.clear();
  failed.clear();
  for (const cb of pending) cb();
}

/** The ONE definition of "a `.shader.json` changed" (#842, made per-key by #852). Both the
 *  Inspector panel (`assetViews/persist.ts`) and the live-reload watcher (`agentBridge.ts`'s
 *  `ASSET_CACHE_INVALIDATORS`) must drive this one function, not spell the eviction out
 *  themselves — that duplication is exactly how `material`/`shader` went unwired from the
 *  watcher path while still working from the Inspector (#842).
 *
 *  `manifestPath` is a PATH — what the watcher and the Inspector both hand over — but the 2D
 *  program map above is keyed by GUID, so it has to be resolved before anything can be evicted.
 *  A resolved guid gets ONLY its own entry dropped: #852's fix for a wholesale
 *  `clearSpriteMaterialCache()` here dropping every OTHER compiled 2D material program in the
 *  scene for an edit to just one of them, flashing every entity's fallback sprite for a frame.
 *  An UNRESOLVED path — a brand-new `.shader.json` the manifest hasn't indexed yet — is
 *  "unknown", not "absent": a per-key evictor that silently no-ops on it would leave the edited
 *  shader's OWN stale program in place, which is worse than the flash this fixes and is exactly
 *  #523's symptom (an edit that silently doesn't take). So an unresolved path falls back to the
 *  wholesale `clearSpriteMaterialCache()` instead of a no-op.
 *  ⚠️ KNOWN NARROW GAP, and it is the price of going per-key: this resolves the path to whatever
 *  guid the manifest holds NOW. If a live `.shader.json`'s `id` is re-keyed (a hand edit, a
 *  delete-and-recreate, or a copy — copying an asset re-keys its GUID), `pathToGuid` re-points to
 *  the NEW guid, so this evicts an entry that was never there and the OLD guid's program stays
 *  cached while scene entities still name it in `Renderable2D.material`. They keep drawing the
 *  pre-edit program indefinitely. The wholesale clear used to mask this by dropping everything,
 *  which turned it into a visible fall-to-fallback-sprite instead of silent staleness. Judged
 *  PLAUSIBLE rather than demonstrated — no UI gesture that re-keys a LIVE shader's id was found
 *  — and fixing it needs the manifest to surface the outgoing guid, which it does not today.
 *  Note the unresolved-path fallback below does NOT cover this: a re-key resolves to a different
 *  guid, it does not fail to resolve.
 *  `invalidatePixiShaderProgram(manifestPath)` runs unconditionally either way — it's the
 *  optimisation on top (its own docblock says so): it evicts just the one path from
 *  `pixiShaderBuilder`'s module-level program cache instead of the whole thing, so a re-`ensure`
 *  doesn't recompile every OTHER shader's SOURCE too.
 *
 *  #864: this is also the ONLY wired invalidator (`invalidateModel`/`invalidateAudio`/
 *  `invalidateTexture`/`invalidateEnvironment` all do) that emitted nothing through the shared
 *  `assetInvalidation` registry — so a `space:'3d'` file shader had NO invalidation path at all:
 *  a 3D material built from it is cached in `meshTemplateCache`'s `materialCache` keyed by the
 *  `.mat.json` path, which nothing here can reach directly (and must not — see
 *  `assetInvalidation.ts`'s `shader` doc for why this stays an event edge, not an import).
 *  `emitAssetInvalidated('shader', …)` closes that: `meshTemplateCache` subscribes and evicts
 *  every material it recorded an edge for. Emit the resolved PATH on both branches below —
 *  never the guid — so a path-keyed subscriber isn't handed a guid from one branch and a path
 *  from the other. */
export function invalidateShader(manifestPath: string): void {
  const guid = isGuid(manifestPath) ? manifestPath : getGuidForPath(manifestPath);
  if (guid) {
    // `manifestPath` is already the path in the common (real) case — only a guid INPUT needs
    // resolving back to one.
    const shaderPath = isGuid(manifestPath) ? (resolveRef(manifestPath) ?? manifestPath) : manifestPath;
    // Emit BEFORE evicting, same ordering as invalidateModel/invalidateAudio/invalidateEnvironment
    // (#304) — a subscriber (meshTemplateCache's 3D reverse index) can still read what's about to
    // be dropped.
    emitAssetInvalidated('shader', shaderPath);
    // Snapshot this guid's waiters BEFORE evicting, fire them AFTER — the per-key mirror of
    // `clearSpriteMaterialCache`'s wake, and load-bearing for the same reason (#523). A
    // superseded compile's resolve/reject deliberately fires no `onReady`, so a renderer still
    // live across this invalidation (a sibling viewport, or the editor's GameView + SceneView)
    // would otherwise lose the only signal that makes it re-`ensure`, and its entities would sit
    // on the fallback sprite until some unrelated dirty. Dropping the set without firing it is
    // the flash this issue fixes, made PERMANENT for the one shader actually edited.
    const pending = [...(waiters.get(guid) ?? [])];
    liveness.invalidateKey(guid);
    programs.delete(guid);
    failed.delete(guid);
    loading.delete(guid);
    waiters.delete(guid);
    for (const cb of pending) cb();
  } else {
    // Unresolved guid — fail SAFE, not silent. See the docblock above: "unknown" must not be
    // treated as "absent", or an edit to a not-yet-indexed shader would silently not take.
    // `manifestPath` is already the path here (see the ternary above: this branch is only
    // reached when the input wasn't a guid), so it's the same shape as the branch above.
    emitAssetInvalidated('shader', manifestPath);
    clearSpriteMaterialCache();
  }
  invalidatePixiShaderProgram(manifestPath);
}
