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
import { buildPixiShaderProgram } from '../rendering/pixiShaderBuilder';
import { resolveRefWarnOnce } from './modelGlbUrl';
import { createTeardownToken } from '../core/liveness';

const programs = new Map<string, PixiShaderProgram>(); // guid → resolved program
const loading = new Map<string, Promise<void>>();      // guid → in-flight compile
const waiters = new Map<string, Set<() => void>>();    // guid → onReady wakes awaiting the in-flight compile
const failed = new Set<string>();                      // guid → compile returned null (don't retry every frame)
// Teardown liveness, invalidated wholesale by `clearSpriteMaterialCache` — an in-flight compile
// captures it before starting and bails on resolve/reject if it no longer matches, so a compile
// superseded by a clear (world swap, or the editor's `invalidateShaderFile` on a `.shader.json`
// save) can't write a stale program back in, or worse, delete the map entries a NEW compile for
// the same guid installed after the clear.
// No per-key epoch here (unlike spriteAnimCache/particleCache): `clearSpriteMaterialCache` is
// always a full wholesale clear, never a per-key invalidation, so a single module-wide token is
// the complete answer — a per-key epoch would be unused machinery.
const liveness = createTeardownToken();
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
  const stillLive = liveness.capture();
  const p = buildPixiShaderProgram(path)
    .then((program) => {
      // Superseded by a clear mid-compile — a NEW compile for this guid may already own
      // `loading`/`waiters`; touching either here would delete the new one's in-flight entry
      // and orphan its waiters. Bail before any map write, and don't cache a program built
      // against source a clear (e.g. a `.shader.json` save) may have already made stale.
      if (!stillLive()) return;
      loading.delete(guid);
      const wakes = waiters.get(guid); waiters.delete(guid);
      if (program) { programs.set(guid, program); wakes?.forEach((cb) => cb()); }
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
