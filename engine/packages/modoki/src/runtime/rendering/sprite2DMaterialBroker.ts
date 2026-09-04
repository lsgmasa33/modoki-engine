/** sprite2DMaterialBroker — the 2D-material analog of `materialBroker` (3D). It lets
 *  `materialInstanceSystem` reach an entity's live PixiJS 2D-material `Shader`(s) to
 *  drive their uniforms, WITHOUT importing the heavy Scene2D module (which pulls in
 *  pixi.js) — keeping the driver's 3D path pixi-free.
 *
 *  Each live `Scene2DRenderer` registers its own `entityShaders` map here (GameView +
 *  SceneView run separate renderers over the same world, so an entity can have a Shader
 *  in each). The driver writes each uniform into EVERY registered map's Shader for the
 *  entity — the 2D twin of the broker reaching both 3D editor surfaces. */

import type { Shader } from 'pixi.js';

/** The registered per-renderer `entityId → Shader` maps (one per live Scene2DRenderer). */
const shaderMaps = new Set<Map<number, Shader>>();

/** Entities whose 2D-material uniform value ACTUALLY changed this frame — the driver
 *  (`materialInstanceSystem`) rebuilds this each frame (clears at the top of its pass,
 *  marks an entity only when a write differs from the current value). The 2D render pass
 *  reads it (without consuming — both live renderers must see the same signal) to gate its
 *  per-frame canvas redraw: a static-uniform material (no driver, or a driver at a constant
 *  value) stops forcing a GPU pass every running frame. Populated by the ECS pipeline
 *  (priority 0), read by the render callbacks (priority 20/40) later in the same frame. */
const dirtyEntities = new Set<number>();

/** Driver: flag that entity `id`'s 2D-material uniform changed this frame. */
export function markEntity2DMaterialDirty(id: number): void { dirtyEntities.add(id); }

/** Render pass: did a driver write a NEW uniform value for this entity this frame? */
export function isEntity2DMaterialDirty(id: number): boolean { return dirtyEntities.has(id); }

/** Driver: clear the per-frame dirty set (called once at the top of the driver's frame,
 *  BEFORE it re-marks changed entities — so the flags always reflect only this frame). */
export function clearEntity2DMaterialDirty(): void { dirtyEntities.clear(); }

/** Register a renderer's live entity→Shader map. Returns an unregister fn (call on stop). */
export function register2DMaterialShaderMap(map: Map<number, Shader>): () => void {
  shaderMaps.add(map);
  return () => { shaderMaps.delete(map); };
}

/** True once `s.destroy()` has run. Pixi's `Shader` has no PUBLIC destroyed flag — only the
 *  internal `_destroyed` (see its `.d.ts`, marked `@internal`) — and the class's public
 *  `destroy` EventEmitter event doesn't substitute: it only tells a listener attached BEFORE
 *  destruction, but the case this guards against is a shader destroyed in the same frame it
 *  was first handed to us, before we'd ever have attached one. So this deliberately reads the
 *  internal field rather than modelling destruction ourselves. Verified against the installed
 *  pixi.js 8.19.0 (`Shader._destroyed`, set `true` synchronously at the top of `destroy()`,
 *  before it nulls `resources`/`groups`/the programs) — re-verify on a pixi.js upgrade. */
function isShaderDestroyed(s: Shader): boolean {
  return (s as unknown as { _destroyed: boolean })._destroyed === true;
}

/** Every live 2D-material Shader an entity currently has, across all renderers. Skips a
 *  Shader that has been destroyed (a slot torn down between the render frame and this
 *  read) so the driver never writes into freed GPU state. */
export function getEntity2DMaterialShaders(id: number): Shader[] {
  const out: Shader[] = [];
  for (const map of shaderMaps) {
    const s = map.get(id);
    if (s && !isShaderDestroyed(s)) out.push(s);
  }
  return out;
}

/** True if any live renderer has a 2D-material Shader for this entity (the entity is
 *  currently rendered through a custom 2D material). */
export function hasEntity2DMaterial(id: number): boolean {
  for (const map of shaderMaps) {
    const s = map.get(id);
    if (s && !isShaderDestroyed(s)) return true;
  }
  return false;
}
