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
import { resolveRef } from './assetManifest';

const programs = new Map<string, PixiShaderProgram>(); // guid → resolved program
const loading = new Map<string, Promise<void>>();      // guid → in-flight compile
const waiters = new Map<string, Set<() => void>>();    // guid → onReady wakes awaiting the in-flight compile
const failed = new Set<string>();                      // guid → compile returned null (don't retry every frame)

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

  const path = resolveRef(guid);
  if (!path) { failed.add(guid); return undefined; } // unresolved GUID — resolveRef already warned

  const set = new Set<() => void>();
  if (onReady) set.add(onReady);
  waiters.set(guid, set);
  const p = buildPixiShaderProgram(path)
    .then((program) => {
      loading.delete(guid);
      const wakes = waiters.get(guid); waiters.delete(guid);
      if (program) { programs.set(guid, program); wakes?.forEach((cb) => cb()); }
      else failed.add(guid); // missing body / wrong space / reserved-name — buildPixiShaderProgram warned
    })
    .catch((e) => {
      loading.delete(guid); waiters.delete(guid);
      failed.add(guid);
      console.warn(`[spriteMaterialCache] failed to build 2D material ${guid}: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    });
  loading.set(guid, p);
  return undefined;
}

/** Drop every cached program + in-flight/failed marker. Called on world swap and full
 *  teardown; entities re-`ensure` their material on the next frame. */
export function clearSpriteMaterialCache(): void {
  programs.clear();
  loading.clear();
  waiters.clear();
  failed.clear();
}
