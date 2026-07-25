/** Bloom Post-Process — TSL whole-scene HDR bloom for the plain (non-NPR) 3D path.
 *
 *  Pipeline: pass(scene, camera) → lit HDR color; `bloom()` extracts bright
 *  areas (threshold), blurs them across mip levels (radius) and scales (strength);
 *  the output node is `color + bloom`, then the RenderPipeline's default output
 *  color transform tone-maps + encodes to the swapchain. Particles ride
 *  PARTICLE_LAYER, which the camera enables, so `pass(scene, camera)` includes
 *  and blooms them.
 *
 *  Requires a WebGPURenderer (bloom's TSL won't compile on the WebGL2 backend —
 *  the caller gates on `isWebGPU` and falls back to plain renderer.render there). */

// HMR: TSL node instances bake into compiled WGSL pipelines. When this module
// hot-reloads, new node instances no longer match the cached compiled shaders
// (the same hazard the NPR module documents). Opt out with a full page reload.
if (import.meta.hot) import.meta.hot.invalidate();

import type * as THREE from 'three';
import { RenderPipeline } from 'three/webgpu';
import { pass, add } from 'three/tsl';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';

export interface BloomConfig {
  strength: number;
  radius: number;
  threshold: number;
}

/** Owner of the bloom RenderPipeline for one Scene3D instance. `render()`
 *  replaces `renderer.render(scene, camera)` on the plain path. */
export class BloomPostProcess {
  private readonly pipeline: RenderPipeline;
  private readonly bloomPass: ReturnType<typeof bloom>;

  constructor(renderer: unknown, scene: THREE.Scene, camera: THREE.Camera, cfg: BloomConfig) {
    const scenePass = pass(scene, camera);
    // 'output' is the plain pass's lit color target (matches the NPR + three
    // bloom-example wiring). Working/linear space — the pipeline's output
    // transform below applies tone map + encode once, after bloom.
    const color = scenePass.getTextureNode('output');
    this.bloomPass = bloom(color, cfg.strength, cfg.radius, cfg.threshold);

    this.pipeline = new RenderPipeline(renderer as ConstructorParameters<typeof RenderPipeline>[0]);
    // Whole-scene bloom: original color + bloom contribution.
    this.pipeline.outputNode = add(color, this.bloomPass) as never;
    // KEEP the default output color transform ON (tone map + sRGB encode) — unlike
    // NPRPostProcess, which disables it because its two stages hand-manage tone
    // mapping. Here the single pipeline owns the whole transform.
  }

  /** Render one frame → swapchain (tone-mapped). */
  render(): void {
    this.pipeline.render();
  }

  /** Push live config into the BloomNode's uniforms (no graph rebuild). */
  setConfig(cfg: BloomConfig): void {
    this.bloomPass.strength.value = cfg.strength;
    this.bloomPass.radius.value = cfg.radius;
    this.bloomPass.threshold.value = cfg.threshold;
  }

  dispose(): void {
    this.pipeline.dispose();
  }
}
