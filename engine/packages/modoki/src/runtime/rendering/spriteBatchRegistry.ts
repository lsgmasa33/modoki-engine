/**
 * Sprite batches — the registry (pixi-free, so it is exported from `@modoki/engine/runtime`; the drawing is
 * `spriteBatch2D.ts`).
 *
 * Sprite batches — many short-lived 2D sprites drawn WITHOUT an entity each (debris, sparks, confetti).
 *
 * A game registers a batch: an `anchor` entity that says WHERE it draws (the Canvas2D above it, and its paint
 * rank among that canvas's sprites: author it as an invisible `Renderable2D` with the `orderInLayer` the batch
 * should take), and `sprites(world)`, this frame's sprites as plain data. The primary `Scene2D` draws them into
 * one Pixi container of pooled `Sprite`s, its own render group.
 *
 * Why it exists (#1926, Ice Reef, measured on an iPhone Air): a clear's debris as one pooled ECS sprite per piece
 * cost 25-30 ms of CPU a frame in a long cascade — the game writing two traits per piece, transform
 * propagation, and Scene2D's per-entity sync, for every piece, every frame. Here a piece is a few numbers the
 * game rewrites, and the renderer copies them onto a Sprite.
 *
 * Contract:
 *  - `sprites` is read once per rendered frame, after the ECS frame. Objects may be reused frame to frame.
 *  - Fields mean what they mean on `Renderable2D`: `width`/`height` are HALF extents, the pivot is 0..1,
 *    `rotation` is radians, `color` is a tint. `x`/`y` are in the anchor's canvas's design space (the batch has
 *    no parent transform).
 *  - `sprite` is a texture ref as `Renderable2D.sprite` takes it (a GUID, or a sheet frame), or `square`
 *    (white) / `circle` (a soft dot). A ref that has not loaded yet is skipped until it has.
 *  - Drawn as Pixi `ParticleContainer`s, one per texture SOURCE: pack a batch's art into one atlas and the whole
 *    batch is one draw. An item with `opacity` 0 is not drawn at all (no quad), and does not keep the canvas
 *    redrawing. Draw order is by source group (first seen first), then item order.
 *  - Runtime only: the editor SceneView does not draw batches (they are play-time effects, like particles).
 */
import type { Entity, World } from 'koota';

export interface BatchSprite2D {
  sprite: string;
  x: number;
  y: number;
  /** Half extents, as on `Renderable2D`. */
  width: number;
  height: number;
  rotation: number;
  color: number;
  opacity: number;
  pivotX: number;
  pivotY: number;
}

export interface SpriteBatch2D {
  /** The entity that places the batch: its Canvas2D ancestor is where it draws, its paint rank its depth. */
  anchor(world: World): Entity | undefined;
  /** This frame's sprites, back to front. */
  sprites(world: World): readonly BatchSprite2D[];
}

const batches = new Map<string, SpriteBatch2D>();

/** The registered batches (the renderer's view). */
export function spriteBatches2D(): ReadonlyMap<string, SpriteBatch2D> {
  return batches;
}

/** Whether any batch is registered (Scene2D skips the pass, and its texture cache, when none is). */
export function hasSpriteBatches2D(): boolean {
  return batches.size > 0;
}

/** Register (or replace) the batch under `key`. */
export function registerSpriteBatch2D(key: string, batch: SpriteBatch2D): void {
  batches.set(key, batch);
}

export function unregisterSpriteBatch2D(key: string): void {
  batches.delete(key);
}

