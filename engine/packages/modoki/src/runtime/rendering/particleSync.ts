/**
 * Per-frame bridge between ECS ParticleEmitter entities and the particle backend —
 * the particle analogue of scene3DSync's syncRenderables. Called from the render phase
 * (after syncRenderables, before renderer.render) in both the runtime Scene3D and the
 * editor GameView. Creates a backend handle + adds its Object3D to the scene when an
 * emitter appears, steps the simulation each frame (delta from the Time trait, scaled by
 * playbackSpeed), syncs the emitter transform, and disposes handles for removed/inactive
 * emitters.
 *
 * v2 composes the emitter matrix from the entity's PROPAGATED WORLD transform
 * (`worldTransforms`, populated by transformPropagationSystem in the ECS pipeline before
 * the render phase), falling back to the local Transform when no world entry exists —
 * exactly as scene3DSync's applyTransform and flameMeshSync do. A nested emitter therefore
 * tracks a moving parent. (v1 used the local Transform only, so parented emitters didn't
 * follow their ancestor — see engine-review/runtime-particles.md "world-transform v2".)
 *
 * NOTE: despite living under rendering/, this is a PARTICLE-subsystem (Three.js) concern,
 * not a 2D/PixiJS one — it is reviewed under runtime-particles.md, not runtime-rendering-2d.md.
 */

import * as THREE from 'three';
import type { World } from 'koota';
import { Transform } from '../traits/Transform';
import { ParticleEmitter } from '../traits/ParticleEmitter';
import { getVisualDelta } from '../systems/getTime';
import { takeParticleControl } from '../systems/particleControlRegistry';
import { particleBackend } from '../particles/particleBackend';
import type { ParticleHandle, ParticleEffectDef } from '../particles/types';
import { getParticleEffect } from '../loaders/particleCache';
import { PARTICLE_LAYER } from './layers';
import { worldTransforms } from '../../three/systems/transformPropagationSystem';
import { buildCanvas2DRoute, emitterCanvasId, type Canvas2DRoute } from './particle2DRouting';

/** Put an emitter's whole object subtree on PARTICLE_LAYER so the NPR geometry
 *  pass can exclude it and the particle pass can render it alone. Layers don't
 *  propagate to children in three, so traverse. */
function tagParticleLayer(obj: THREE.Object3D): void {
  obj.traverse((o: THREE.Object3D) => o.layers.set(PARTICLE_LAYER));
}

interface EmitterRec {
  handle: ParticleHandle;
  effect: string;
  /** The cached def object the handle was last created/updated with. The editor
   *  reseeds the cache with a NEW object on every edit (setParticleEffect →
   *  normalizeParticleDef), so a reference change means "live-edit, push to backend". */
  def: ParticleEffectDef;
  /** Editor FX-preview only (forcePlay): seconds since the last restart, so a NON-looping
   *  one-shot effect re-fires each `duration` and previews continuously instead of playing once. */
  previewT?: number;
}

export interface ParticleSyncState {
  recs: Map<number, EmitterRec>;
}

export function createParticleSyncState(): ParticleSyncState {
  return { recs: new Map() };
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();

type TransformData = { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number };
type EmitterData = { effect: string; isVisible: boolean; playbackSpeed: number; playOnStart: boolean; speedScale: number };

/**
 * @param dtOverride when provided (editor in-scene preview, which has no ticking Time
 *   trait), use this delta instead of reading the Time trait. Runtime callers omit it.
 *   Without an override, particles advance on the VISUAL delta (smoothed × timeScale)
 *   and freeze to 0 when the sim isn't running — so an in-game pause / time-stop
 *   (timeScale 0) stops particles the same frame.
 */
// Reusable routing snapshot so the per-frame Canvas2D-ancestor check allocates nothing.
const _route3d: Canvas2DRoute = { parentOf: new Map(), canvasIds: new Set() };

export function syncParticles(world: World, scene: THREE.Object3D, state: ParticleSyncState, dtOverride?: number, opts?: { forcePlay?: boolean }): void {
  const dt = dtOverride ?? getVisualDelta(world);
  const forcePlay = opts?.forcePlay === true; // editor FX preview: show every emitter PLAYING (ignore playOnStart)
  const seen = new Set<number>();
  // An emitter under a Canvas2D renders in the 2D (PixiJS) path — particleSync2D owns it. Skipping
  // it here (so it never enters `seen`) also disposes any stale 3D handle in the cleanup pass below
  // if the emitter was reparented under a Canvas2D. Exactly-one-path routing (see particle2DRouting).
  buildCanvas2DRoute(world, _route3d);

  world.query(Transform, ParticleEmitter).updateEach(([tf, pe]: [TransformData, EmitterData], entity) => {
    const id = entity.id();
    if (emitterCanvasId(_route3d, id) !== null) return; // has a Canvas2D ancestor → 2D path owns it
    if (!pe.isVisible || !pe.effect) return; // disposed by the cleanup pass below
    const def = getParticleEffect(pe.effect);
    if (!def) return; // asset still loading — retry next frame

    seen.add(id);
    let rec = state.recs.get(id);
    if (!rec || rec.effect !== pe.effect) {
      if (rec) {
        scene.remove(particleBackend.getObject3D(rec.handle));
        particleBackend.dispose(rec.handle);
      }
      const handle = particleBackend.create(def);
      const obj = particleBackend.getObject3D(handle);
      scene.add(obj);
      tagParticleLayer(obj);
      // playOnStart=false → created paused (ready but not simulating) until resumed. The editor FX
      // preview overrides this (forcePlay) so a control/game-triggered emitter still previews.
      if (pe.playOnStart === false && !forcePlay) particleBackend.pause(handle);
      rec = { handle, effect: pe.effect, def };
      state.recs.set(id, rec);
    } else if (rec.def !== def) {
      // Same effect path but the cached def changed → an editor live-edit reseeded
      // it. Push the new definition to the existing backend handle so scene emitters
      // (GameView / the running game) reflect edits immediately, not just after a
      // scene save+reload. Reference compare → no per-frame cost when nothing changed.
      particleBackend.setDef(rec.handle, def);
      rec.def = def;
    }
    // Re-tag each frame so objects the backend adds later (sub-emitters, a CPU/GPU
    // backend swap under the same wrapper) inherit the layer. Cheap — emitter
    // subtrees are tiny and there are few emitters.
    tagParticleLayer(particleBackend.getObject3D(rec.handle));

    // Timeline Control track (Phase E): a `particle` clip crossing its start/end queued a restart
    // (re-emit from t=0) / pause here — apply it before this frame's update so it takes effect now.
    const control = takeParticleControl(id);
    if (control === 'restart') particleBackend.restart(rec.handle);
    else if (control === 'pause') particleBackend.pause(rec.handle);

    // Compose from the propagated WORLD transform so a parented emitter follows a moving
    // ancestor; fall back to the entity's local Transform when it has no world entry
    // (no parent / not yet propagated) — mirrors scene3DSync.applyTransform + flameMeshSync.
    const wt = worldTransforms.get(id);
    _p.set(wt ? wt.x : tf.x, wt ? wt.y : tf.y, wt ? wt.z : tf.z);
    _e.set(wt ? wt.rx : tf.rx, wt ? wt.ry : tf.ry, wt ? wt.rz : tf.rz);
    _q.setFromEuler(_e);
    _s.set(wt ? wt.sx : tf.sx, wt ? wt.sy : tf.sy, wt ? wt.sz : tf.sz);
    _m.compose(_p, _q, _s);
    particleBackend.setTransform(rec.handle, _m);
    // Runtime length control (engine throttle, etc.) — cheap uniform/field set, so push
    // every frame; the backend ignores it when unchanged.
    particleBackend.setSpeedScale?.(rec.handle, pe.speedScale ?? 1);
    particleBackend.update(rec.handle, dt * (pe.playbackSpeed ?? 1));

    // FX preview: re-fire a NON-looping one-shot every `duration` so a burst previews continuously
    // (it would otherwise play once and stop). Looping effects self-repeat, so they're left alone.
    if (forcePlay && !rec.def.looping && rec.def.duration > 0) {
      rec.previewT = (rec.previewT ?? 0) + dt * (pe.playbackSpeed ?? 1);
      if (rec.previewT >= rec.def.duration) { particleBackend.restart(rec.handle); rec.previewT = 0; }
    }
  });

  for (const [id, rec] of state.recs) {
    if (!seen.has(id)) {
      scene.remove(particleBackend.getObject3D(rec.handle));
      particleBackend.dispose(rec.handle);
      state.recs.delete(id);
    }
  }
}

export function disposeParticleSyncState(state: ParticleSyncState, scene: THREE.Object3D): void {
  for (const rec of state.recs.values()) {
    scene.remove(particleBackend.getObject3D(rec.handle));
    particleBackend.dispose(rec.handle);
  }
  state.recs.clear();
}
