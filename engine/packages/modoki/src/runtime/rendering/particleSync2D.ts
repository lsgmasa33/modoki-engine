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
 * trailing `seen` sweep disposes handles for emitters that vanished or moved out of 2D.
 *
 * Scene2D owns the state + supplies the wiring via {@link ParticleSync2DCtx} (its own
 * `findCanvasAncestor`, pool slot lookup, dirty-set, and scale compensation) so this module stays a
 * separately-testable unit (drive it with a mock ctx + the injectable backend factory).
 */

import * as THREE from 'three';
import type { World } from 'koota';
import type { Container } from 'pixi.js';
import { Transform } from '../traits/Transform';
import { ParticleEmitter } from '../traits/ParticleEmitter';
import { getVisualDelta } from '../systems/getTime';
import { takeParticleControl } from '../systems/particleControlRegistry';
import { pixiParticleBackend, type IParticle2DBackend } from '../particles/pixiParticleBackend';
import type { ParticleHandle, ParticleEffectDef } from '../particles/types';
import { getParticleEffect } from '../loaders/particleCache';
import { getWorldTransform2DInto } from './renderUtils';

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
  recs: Map<number, Rec>;
  backend: IParticle2DBackend;
}

export function createParticleSync2DState(backend: IParticle2DBackend = pixiParticleBackend): ParticleSync2DState {
  return { recs: new Map(), backend };
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

/** Detach + dispose an emitter's wrapper/handle (removed, made invisible, or moved out of 2D). */
function disposeRec(state: ParticleSync2DState, id: number, rec: Rec, ctx: ParticleSync2DCtx): void {
  state.backend.getContainer(rec.handle).removeFromParent();
  state.backend.dispose(rec.handle);
  ctx.markDirty(rec.canvasId); // the canvas must redraw without the emitter
  state.recs.delete(id);
}

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
  const seen = new Set<number>();

  world.query(Transform, ParticleEmitter).updateEach(([tf, pe]: [TransformData, EmitterData], entity) => {
    const id = entity.id();
    const canvasId = ctx.canvasIdOf(id);
    if (canvasId === null) return; // no Canvas2D ancestor → the 3D particleSync owns this emitter
    if (!pe.isVisible || !pe.effect) return; // disposed by the cleanup pass below
    const def = getParticleEffect(pe.effect);
    if (!def) return; // asset still loading — retry next frame
    const slot = ctx.slotContainer(canvasId);
    if (!slot) return; // canvas not allocated yet — retry next frame

    seen.add(id);
    let rec = state.recs.get(id);
    if (!rec || rec.effect !== pe.effect) {
      if (rec) { backend.getContainer(rec.handle).removeFromParent(); backend.dispose(rec.handle); }
      const handle = backend.create(def);
      // playOnStart=false → created paused (ready but not simulating) until resumed.
      if (pe.playOnStart === false) backend.pause(handle);
      rec = { handle, effect: pe.effect, def, canvasId };
      state.recs.set(id, rec);
    } else if (rec.def !== def) {
      // Same effect path, cached def object changed → an editor live-edit reseeded it. Push it so
      // running-scene emitters reflect edits immediately (reference compare → no cost when unchanged).
      backend.setDef(rec.handle, def);
      rec.def = def;
    }

    // (Re)parent the wrapper under the correct Canvas2D slot — an emitter can be reparented to a
    // different Canvas2D; mark the OLD canvas dirty so it redraws without the emitter.
    const wrapper = backend.getContainer(rec.handle);
    if (wrapper.parent !== slot) {
      wrapper.removeFromParent();
      slot.addChild(wrapper);
      if (rec.canvasId !== canvasId) ctx.markDirty(rec.canvasId);
      rec.canvasId = canvasId;
    }

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
    const control = takeParticleControl(id);
    if (control === 'restart') backend.restart(rec.handle);
    else if (control === 'pause') backend.pause(rec.handle);

    backend.setSpeedScale?.(rec.handle, pe.speedScale ?? 1);
    backend.update(rec.handle, dt * (pe.playbackSpeed ?? 1));
    ctx.markDirty(canvasId); // animating → this canvas must GPU-render this frame
  });

  for (const [id, rec] of state.recs) {
    if (!seen.has(id)) disposeRec(state, id, rec, ctx);
  }
}

/** Dispose every emitter whose wrapper lives on a Canvas2D that is being released (the pool orphans
 *  but does NOT destroy children, so we must). Called from Scene2D's canvas-release pass. */
export function releaseCanvas2DEmitters(state: ParticleSync2DState, canvasId: number): void {
  for (const [id, rec] of state.recs) {
    if (rec.canvasId === canvasId) {
      state.backend.getContainer(rec.handle).removeFromParent();
      state.backend.dispose(rec.handle);
      state.recs.delete(id);
    }
  }
}

/** Tear down all emitter handles (world swap / Scene2D stop) so recycled entity ids can't alias
 *  stale emitters. */
export function disposeParticleSync2DState(state: ParticleSync2DState): void {
  for (const rec of state.recs.values()) {
    state.backend.getContainer(rec.handle).removeFromParent();
    state.backend.dispose(rec.handle);
  }
  state.recs.clear();
}
