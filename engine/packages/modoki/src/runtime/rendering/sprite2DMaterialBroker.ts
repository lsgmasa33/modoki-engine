/** sprite2DMaterialBroker — the 2D-material analog of `materialBroker` (3D). It lets
 *  `materialInstanceSystem` reach an entity's live PixiJS 2D-material `Shader`(s) to
 *  drive their uniforms, WITHOUT importing the heavy Scene2D module (which pulls in
 *  pixi.js) — keeping the driver's 3D path pixi-free.
 *
 *  Each live `Scene2DRenderer` registers its own `entityShaders` map here (GameView +
 *  SceneView run separate renderers over the same world, so an entity can have a Shader
 *  in each). The driver writes each uniform into EVERY registered map's Shader for the
 *  entity — the 2D twin of the broker reaching both 3D editor surfaces.
 *
 *  ⚠️ **Every id here is koota's MASKED index, so every entry carries the entity's
 *  generation and every read checks it** (#848). `entity.id()` strips the generation and
 *  koota's free list is LIFO, so a despawn + same-shape respawn reclaims the exact freed
 *  index — and a bare-id entry would then hand the NEWCOMER the dead entity's Shader.
 *  Neither existing defence closes that: `isShaderDestroyed` only helps once the old
 *  Shader is actually destroyed, and Scene2D's purge runs at render priority 20/40 — AFTER
 *  the driver reads this at ECS priority 0.
 *
 *  ⚠️ **The window is NOT "one frame", and an earlier version of this comment said it was.**
 *  Two ways it outlives a frame: (a) `Scene2DRenderer.renderFrame` returns early when the sim
 *  is stopped and nothing is dirty, so the purge does not run every wall-clock frame; and,
 *  worse, (b) when the respawned entity resolves the SAME material and texture, the renderer
 *  REUSES the dead entity's slot and Shader, and the purge deliberately KEEPS that entry
 *  because the newcomer is rendering. So the producer must RE-STAMP on the reuse path, not
 *  only on a fresh build — see the re-stamp block in `Scene2D.tsx`'s material pass. Storing a
 *  generation and refusing on mismatch is only half of the shape `docs/engine-concepts.md`
 *  § Entity prescribes; "rebuilding on a mismatch" is the other half, and without it this
 *  guard turns a one-frame wrong uniform into a PERMANENTLY dead driver.
 *
 *  This is `docs/engine-concepts.md` § Entity's second sanctioned shape — *keep the id key
 *  and store the generation alongside it* — and not the first (key by `entity.valueOf()`),
 *  because the id here is a public ADDRESSING contract: `Scene2DRenderer` owns the
 *  registered map and keys it in the same space as its `slots` / `activeIds` / `last*Render`
 *  maps, which are deleted together in one sweep. Re-keying this map alone to a packed
 *  value would silently desync that sweep. Generation is 8-bit and WRAPS at 256 recycles.
 *  A fresh world restarts BOTH id and generation, so `(id 5, gen 0)` in one world is
 *  indistinguishable from `(id 5, gen 0)` in the next: the registered `entityShaders` maps are
 *  covered by the renderers' own `clear()` on teardown, and `dirtyEntities` — which no renderer
 *  owns — is cleared here on world swap for the same reason. */

import type { Shader } from 'pixi.js';
import { onWorldSwap } from '../core/ecs/world';

/** One renderer's live Shader for one entity, stamped with the koota generation of the
 *  entity it was built for. The stamp is the whole defence — see the module comment. */
export type Entity2DShaderEntry = { shader: Shader; gen: number };

/** The registered per-renderer `entityId → Shader` maps (one per live Scene2DRenderer). */
const shaderMaps = new Set<Map<number, Entity2DShaderEntry>>();

/** Entities whose 2D-material uniform value ACTUALLY changed this frame — the driver
 *  (`materialInstanceSystem`) rebuilds this each frame (clears at the top of its pass,
 *  marks an entity only when a write differs from the current value). The 2D render pass
 *  reads it (without consuming — both live renderers must see the same signal) to gate its
 *  per-frame canvas redraw: a static-uniform material (no driver, or a driver at a constant
 *  value) stops forcing a GPU pass every running frame. Populated by the ECS pipeline
 *  (priority 0), read by the render callbacks (priority 20/40) later in the same frame.
 *
 *  A `Map` id → generation rather than a `Set` of ids, for the reason in the module comment:
 *  the mark and the read sit on opposite sides of the same-frame window, so a recycled id
 *  would read the dead entity's mark. Consequence there is a redundant redraw rather than a
 *  wrong pixel — pinned anyway, because "benign today" is not a property a bare id keeps. */
const dirtyEntities = new Map<number, number>();

/** Driver: flag that entity `id` (at generation `gen`)'s 2D-material uniform changed. */
export function markEntity2DMaterialDirty(id: number, gen: number): void { dirtyEntities.set(id, gen); }

/** Render pass: did a driver write a NEW uniform value for THIS entity this frame? A mark
 *  left by a dead entity that shared the id reads as false — the generation discriminates. */
export function isEntity2DMaterialDirty(id: number, gen: number): boolean { return dirtyEntities.get(id) === gen; }

/** Driver: clear the per-frame dirty set (called once at the top of the driver's frame,
 *  BEFORE it re-marks changed entities — so the flags always reflect only this frame). */
export function clearEntity2DMaterialDirty(): void { dirtyEntities.clear(); }

// A world swap restarts id AND generation from zero, so a mark left by the outgoing world can
// match a live entity in the incoming one — the generation cannot discriminate across that
// boundary. Every sibling cache pairs its generation with an `onWorldSwap` clear for exactly this
// (`materialInstanceSystem`'s clocks, warn-once sets and `_defaultBaseCache`); this map was the
// one that did not, because the renderers clear the maps they own and nobody owns this one.
// The consequence was bounded — a spurious canvas redraw in the swap frame — so this closes an
// asymmetry rather than a visible bug.
onWorldSwap(() => { dirtyEntities.clear(); });

/** Register a renderer's live entity→Shader map. Returns an unregister fn (call on stop). */
export function register2DMaterialShaderMap(map: Map<number, Entity2DShaderEntry>): () => void {
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
 *  before it nulls `resources`/`groups`/the programs) — re-verify on a pixi.js upgrade.
 *
 *  Independent of, and NOT a substitute for, the generation check: this one answers "is this
 *  Shader still usable", the generation answers "is it even this entity's". */
function isShaderDestroyed(s: Shader): boolean {
  return (s as unknown as { _destroyed: boolean })._destroyed === true;
}

/** Every live 2D-material Shader THIS entity currently has, across all renderers. Skips an
 *  entry registered for a DIFFERENT generation of the same id (a dead entity whose index this
 *  one reclaimed — #848), and a Shader that has been destroyed (a slot torn down between the
 *  render frame and this read) so the driver never writes into freed GPU state. */
export function getEntity2DMaterialShaders(id: number, gen: number): Shader[] {
  const out: Shader[] = [];
  for (const map of shaderMaps) {
    const e = map.get(id);
    if (e && e.gen === gen && !isShaderDestroyed(e.shader)) out.push(e.shader);
  }
  return out;
}

/** True if any live renderer has a 2D-material Shader for THIS entity (the entity is
 *  currently rendered through a custom 2D material). Generation-checked, as above. */
export function hasEntity2DMaterial(id: number, gen: number): boolean {
  for (const map of shaderMaps) {
    const e = map.get(id);
    if (e && e.gen === gen && !isShaderDestroyed(e.shader)) return true;
  }
  return false;
}
