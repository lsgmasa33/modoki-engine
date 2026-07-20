/**
 * The particle backend the runtime + editor talk to. It's a thin router over two
 * {@link IParticleBackend} implementations — the CPU sim ({@link CpuTslBackend}, full
 * feature set + deterministic) and the GPU-compute sim ({@link GpuComputeBackend}, for
 * very high counts). The chosen implementation is picked per effect at create() from
 * `def.simulation`, and an effect transparently falls back to the CPU sim when GPU isn't
 * eligible (no WebGPU compute backend, no `emission.fillPool`, or it uses a feature the GPU
 * path doesn't cover: trails or sub-emitters). Forces, single-plane collision and mesh mode
 * ARE handled on the GPU.
 *
 * Each handle owns a stable wrapper Group; the chosen impl's Object3D is parented under
 * it. So if `setDef` flips the eligible backend, the inner sim is swapped beneath the
 * same wrapper the caller already added to the scene — no scene-graph re-wiring needed.
 */

import * as THREE from 'three';
import type { IParticleBackend, ParticleEffectDef, ParticleHandle } from './types';
import { gpuDefSupported } from './types';
import { CpuTslBackend } from './cpuTslBackend';
import { GpuComputeBackend } from './gpuComputeBackend';
import { getActiveRenderer } from '../loaders/textureResolver';

/** True when an effect should run on the GPU compute backend. */
function gpuEligible(def: ParticleEffectDef): boolean {
  if (def.simulation !== 'gpu') return false;
  const r = getActiveRenderer();
  const backend = (r as { backend?: { isWebGPUBackend?: boolean } } | null)?.backend;
  if (!backend?.isWebGPUBackend) return false; // compute needs the native WebGPU backend
  // Feature support (fillPool, no trails/sub-emitters, ≤MAX_GPU_FORCES forces) is the
  // renderer-independent half — kept pure in types.ts so it's unit-testable.
  return gpuDefSupported(def);
}

interface RouterEntry {
  wrapper: THREE.Group;
  impl: IParticleBackend;
  handle: ParticleHandle;
  /** Reused (not reallocated) each frame; `posed` tracks whether it's been set yet. */
  lastMatrix: THREE.Matrix4;
  posed: boolean;
}

class RouterParticleBackend implements IParticleBackend {
  private readonly cpu = new CpuTslBackend();
  private readonly gpu = new GpuComputeBackend();
  private nextId = 1;
  private readonly entries = new Map<number, RouterEntry>();
  private readonly warnedFallback = new Set<string>();

  private pick(def: ParticleEffectDef): IParticleBackend {
    // Evaluate eligibility once — it re-runs getActiveRenderer() + the full chain, and a
    // double-eval could in principle disagree between the warn branch and the return (F7).
    const eligible = gpuEligible(def);
    if (def.simulation === 'gpu' && !eligible) {
      // Warn once PER effect (not once globally) so a second misconfigured
      // effect isn't silently swallowed by the first one's warning.
      const key = def.id || def.name || '(unnamed)';
      if (!this.warnedFallback.has(key)) {
        this.warnedFallback.add(key);
        console.info(`[particles] effect "${key}" requested GPU sim but fell back to CPU (needs the native WebGPU compute backend + emission.fillPool, and must not use trails/sub-emitters).`);
      }
    }
    return eligible ? this.gpu : this.cpu;
  }

  create(def: ParticleEffectDef): ParticleHandle {
    const id = this.nextId++;
    const wrapper = new THREE.Group();
    wrapper.name = `fx:${id}`;
    const impl = this.pick(def);
    const handle = impl.create(def);
    wrapper.add(impl.getObject3D(handle));
    this.entries.set(id, { wrapper, impl, handle, lastMatrix: new THREE.Matrix4(), posed: false });
    return { id };
  }

  getObject3D(handle: ParticleHandle): THREE.Object3D {
    return this.req(handle).wrapper;
  }

  update(handle: ParticleHandle, dt: number): void {
    const e = this.entries.get(handle.id);
    if (e) e.impl.update(e.handle, dt);
  }

  setTransform(handle: ParticleHandle, matrix: THREE.Matrix4): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    e.lastMatrix.copy(matrix); // reuse — setTransform runs every frame per emitter
    e.posed = true;
    e.impl.setTransform(e.handle, matrix);
  }

  setDef(handle: ParticleHandle, def: ParticleEffectDef): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    const want = this.pick(def);
    if (want !== e.impl) {
      // Eligible backend flipped — swap the inner sim under the stable wrapper.
      e.wrapper.remove(e.impl.getObject3D(e.handle));
      e.impl.dispose(e.handle);
      e.impl = want;
      e.handle = want.create(def);
      e.wrapper.add(want.getObject3D(e.handle));
      if (e.posed) want.setTransform(e.handle, e.lastMatrix);
    } else {
      e.impl.setDef(e.handle, def);
    }
  }

  play(handle: ParticleHandle): void { const e = this.entries.get(handle.id); if (e) e.impl.play(e.handle); }
  pause(handle: ParticleHandle): void { const e = this.entries.get(handle.id); if (e) e.impl.pause(e.handle); }
  setSpeedScale(handle: ParticleHandle, scale: number): void { const e = this.entries.get(handle.id); if (e) e.impl.setSpeedScale?.(e.handle, scale); }
  restart(handle: ParticleHandle): void { const e = this.entries.get(handle.id); if (e) e.impl.restart(e.handle); }
  seek(handle: ParticleHandle, seconds: number): void { const e = this.entries.get(handle.id); if (e) e.impl.seek(e.handle, seconds); }

  dispose(handle: ParticleHandle): void {
    const e = this.entries.get(handle.id);
    if (!e) return;
    e.impl.dispose(e.handle);
    this.entries.delete(handle.id);
  }

  private req(handle: ParticleHandle): RouterEntry {
    const e = this.entries.get(handle.id);
    if (!e) throw new Error(`[particles] unknown handle ${handle.id}`);
    return e;
  }
}

/** Shared backend instance used by the ECS runtime and the editor preview. */
export const particleBackend: IParticleBackend = new RouterParticleBackend();
