/**
 * Per-frame bridge between ECS ParticleEmitter entities and the PixiJS 2D particle backend — the 2D
 * twin of `particleSync.ts`. Called from Scene2D's `renderFrame` (after the sprite/mesh passes,
 * before the GPU render), it drives the emitters that render in 2D: those with a `Canvas2D` ancestor
 * (see `particle2DRouting` — the 3D `particleSync` owns the rest, and the two never overlap).
 *
 * For each 2D emitter it: creates a backend handle on first sight (adding its stable wrapper Container
 * to the emitter's Canvas2D `slot.container`), pushes live editor edits (`setDef`), positions the
 * wrapper from the entity's PROPAGATED 2D world transform (ref-pixel space, Y-down — same convention
 * as sprites), steps the sim on the visual delta, and marks the canvas dirty so it re-renders. A
 * end-of-pass sweep (`EntityTable` beginPass/touch/endPass) disposes handles for emitters that vanished or moved out of 2D.
 *
 * Scene2D owns the state + supplies the wiring via {@link ParticleSync2DCtx} (its own
 * `findCanvasAncestor`, pool slot lookup, dirty-set, and scale compensation) so this module stays a
 * separately-testable unit (drive it with a mock ctx + the injectable backend factory).
 */

import * as THREE from 'three';
import type { World } from 'koota';
import type { Container } from 'pixi.js';
import { Transform } from '../core/traits/Transform';
import { ParticleEmitter } from '../traits/ParticleEmitter';
import { getVisualDelta } from '../core/getTime';
import { takeParticleControl } from '../core/particleControlRegistry';
import { pixiParticleBackend, type IParticle2DBackend } from '../particles/pixiParticleBackend';
import type { ParticleHandle, ParticleEffectDef } from '../particles/types';
import { particleDefProvider } from '../particles/particleDefProvider';
import { getWorldTransform2DInto } from './renderUtils';
import { deactivatedEntities } from '../core/ecs/transformPropagationSystem';
import { EntityTable } from '../core/ecs/entityTable';

/** The Scene2D-side wiring this sync needs — all resolved against Scene2D's per-frame state. */
export interface ParticleSync2DCtx {
  /** Canvas2D ancestor id of an emitter, or null when it has none (→ not a 2D emitter). */
  canvasIdOf(entityId: number): number | null;
  /** The PixiJS Container for a Canvas2D's pool slot, or null if not allocated this frame. */
  slotContainer(canvasId: number): Container | null;
  /** Mark a Canvas2D as needing a GPU redraw this frame (particles animate every frame). */
  markDirty(canvasId: number): void;
  /** Non-uniform-stretch scale compensation for a canvas (`{x:1,y:1}` default). */
  compensate(canvasId: number): { x: number; y: number };
  /** The emitter's `GroupAlpha` ancestry product, or 1 when no ancestor fades it (#211).
   *  Emitters attach their wrapper straight onto the Canvas2D slot container, exactly like every
   *  other 2D display object, so they need the product applied here for the same reason: the Pixi
   *  tree is flat and inherits nothing. Without it a faded group would dim its sprites and leave
   *  its particles at full brightness — the trait claims the whole subtree. */
  groupAlphaOf(entityId: number): number;
}

interface Rec {
  handle: ParticleHandle;
  effect: string;
  /** The cached def the handle was last built/updated with — a reference change means "live edit". */
  def: ParticleEffectDef;
  /** The Canvas2D whose slot.container currently holds this emitter's wrapper. */
  canvasId: number;
}

export interface ParticleSync2DState {
  /** Generation-stamped (#868): a same-effect emitter respawned on a dead one's index between two
   *  frames used to inherit its handle and simulation state. `'owner-clears'`: Scene2D disposes it
   *  on a world swap and at stop (`disposeParticleSync2DState`). */
  recs: EntityTable<Rec>;
  backend: IParticle2DBackend;
  /** The ctx of the pass in progress, so an entry released DURING a pass redraws its canvas. */
  passCtx: ParticleSync2DCtx | null;
}

export function createParticleSync2DState(backend: IParticle2DBackend = pixiParticleBackend): ParticleSync2DState {
  const state: ParticleSync2DState = {
    backend,
    passCtx: null,
    recs: new EntityTable<Rec>({
      label: 'particleSync2D',
      worldSwap: 'owner-clears',
      dispose: (rec) => {
        backend.getContainer(rec.handle).removeFromParent();
        backend.dispose(rec.handle);
        state.passCtx?.markDirty(rec.canvasId); // the canvas must redraw without the emitter
      },
    }),
  };
  return state;
}

type TransformData = { x: number; y: number; rz: number; sx: number; sy: number };
type EmitterData = { effect: string; isVisible: boolean; playbackSpeed: number; playOnStart: boolean; speedScale: number };

// Reusable scratch (allocation-free hot path), mirroring particleSync.ts.
const _wt = { x: 0, y: 0, rz: 0, sx: 1, sy: 1 };
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * @param dtOverride editor in-scene preview (no ticking Time) passes its own delta; the runtime
 *   omits it and advances on the visual delta (0 when the sim isn't running → particles freeze).
 */
export function syncParticles2D(
  world: World,
  ctx: ParticleSync2DCtx,
  state: ParticleSync2DState,
  dtOverride?: number,
): void {
  const dt = dtOverride ?? getVisualDelta(world);
  const backend = state.backend;
  state.passCtx = ctx;
  state.recs.beginPass();

  world.query(Transform, ParticleEmitter).updateEach(([tf, pe]: [TransformData, EmitterData], entity) => {
    const id = entity.id();
    if (deactivatedEntities.has(id)) return; // entity (or an ancestor) is inactive — disposed by the cleanup pass below
    const canvasId = ctx.canvasIdOf(id);
    if (canvasId === null) return; // no Canvas2D ancestor → the 3D particleSync owns this emitter
    if (!pe.isVisible || !pe.effect) return; // disposed by the cleanup pass below
    const def = particleDefProvider.get()?.getParticleEffect(pe.effect) ?? null;
    if (!def) return; // asset still loading — retry next frame
    const slot = ctx.slotContainer(canvasId);
    if (!slot) return; // canvas not allocated yet — retry next frame

    let rec = state.recs.get(entity);
    if (!rec || rec.effect !== pe.effect) {
      // `set` below disposes what it replaces: the previous effect's handle, or a dead entity's.
      const handle = backend.create(def);
      // playOnStart=false → created paused (ready but not simulating) until resumed.
      if (pe.playOnStart === false) backend.pause(handle);
      rec = { handle, effect: pe.effect, def, canvasId };
      state.recs.set(entity, rec);
    } else if (rec.def !== def) {
      // Same effect path, cached def object changed → an editor live-edit reseeded it. Push it so
      // running-scene emitters reflect edits immediately (reference compare → no cost when unchanged).
      backend.setDef(rec.handle, def);
      rec.def = def;
    }
    state.recs.touch(entity); // kept this pass; anything not reached here is swept by endPass

    // (Re)parent the wrapper under the correct Canvas2D slot — an emitter can be reparented to a
    // different Canvas2D; mark the OLD canvas dirty so it redraws without the emitter.
    const wrapper = backend.getContainer(rec.handle);
    if (wrapper.parent !== slot) {
      wrapper.removeFromParent();
      slot.addChild(wrapper);
      if (rec.canvasId !== canvasId) ctx.markDirty(rec.canvasId);
      rec.canvasId = canvasId;
    }

    // Group fade (#211) — same product the sprite/mesh/text paths apply. Written every frame like
    // the transform below: particles animate continuously, so there is no snapshot to invalidate.
    wrapper.alpha = ctx.groupAlphaOf(id);

    // Position from the propagated 2D world transform (ref-pixel space, Y-down) so a parented emitter
    // follows a moving ancestor and lines up with sprites; comp keeps scale un-stretched under `fill`.
    getWorldTransform2DInto(_wt, id, tf);
    const comp = ctx.compensate(canvasId);
    _p.set(_wt.x, _wt.y, 0);
    _e.set(0, 0, _wt.rz);
    _q.setFromEuler(_e);
    _s.set(_wt.sx * comp.x, _wt.sy * comp.y, 1);
    _m.compose(_p, _q, _s);
    backend.setTransform(rec.handle, _m);

    // Timeline Control track (Phase E): apply a queued particle restart / pause before this frame's
    // update (mirrors the 3D path) so a `particle` control clip re-emits the 2D emitter on its beat.
    const control = takeParticleControl(entity);
    if (control === 'restart') backend.restart(rec.handle);
    else if (control === 'pause') backend.pause(rec.handle);

    backend.setSpeedScale?.(rec.handle, pe.speedScale ?? 1);
    backend.update(rec.handle, dt * (pe.playbackSpeed ?? 1));
    ctx.markDirty(canvasId); // animating → this canvas must GPU-render this frame
  });

  try {
    state.recs.endPass();
  } finally {
    state.passCtx = null;
  }
}

/** Dispose every emitter whose wrapper lives on a Canvas2D that is being released (the pool orphans
 *  but does NOT destroy children, so we must). Called from Scene2D's canvas-release pass. */
export function releaseCanvas2DEmitters(state: ParticleSync2DState, canvasId: number): void {
  state.recs.retain((rec) => rec.canvasId !== canvasId);
}

/** Tear down all emitter handles (world swap / Scene2D stop) so recycled entity ids can't alias
 *  stale emitters. */
export function disposeParticleSync2DState(state: ParticleSync2DState): void {
  state.recs.clear();
}
