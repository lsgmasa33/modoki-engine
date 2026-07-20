/** ParticlePassNode — renders particles AFTER the NPR post-process.
 *
 *  Stage 2 of the two-stage NPR render (see NPRPostProcess). The geometry pass
 *  (stage 1) excludes the particle layer and produces a stylized color RTT plus a
 *  geometry depth texture. This pass reconstructs the opaque framebuffer in its OWN
 *  render target and forward-renders particles over it:
 *
 *    1. a fullscreen "prep" quad writes the stylized color to color AND the geometry
 *       device-depth to `@builtin(frag_depth)` (depthTest off → unconditional,
 *       depthWrite on) — i.e. NPR's depth reused as a pre-Z (validated by the spike).
 *    2. the particle layer is rendered over it with each particle's NATIVE blend mode
 *       (additive / alpha) and hardware depth-test on, depthWrite off — so particles
 *       blend over the real stylized color (no premultiplied gymnastics) and are
 *       correctly occluded by scene geometry.
 *
 *  The pass output (stylized + particles, in working space) is tone-mapped + encoded
 *  to the swapchain by stage 2's RenderPipeline (outputColorTransform = true).
 *
 *  WebGPU only (extends three's node PassNode). `scene.background` is nulled during
 *  the particle render — otherwise `renderer.render` repaints the background over the
 *  prefilled stylized color (the bug the spike chased down).
 */

import * as THREE from 'three';
import { PassNode, QuadMesh, MeshBasicNodeMaterial } from 'three/webgpu';
import { texture, screenUV, vec4 } from 'three/tsl';
import { PARTICLE_LAYER } from '../layers';

const _size = new THREE.Vector2();

interface RendererLike {
  getSize(v: THREE.Vector2): THREE.Vector2;
  getPixelRatio(): number;
  getRenderTarget(): THREE.RenderTarget | null;
  getMRT(): unknown;
  setRenderTarget(rt: THREE.RenderTarget | null): void;
  setMRT(m: unknown): void;
  autoClear: boolean;
  clear(): void;
  render(o: THREE.Object3D, c: THREE.Camera): void;
}

export class ParticlePassNode extends PassNode {
  private readonly prepQuad: QuadMesh;
  private readonly particleMask: number;

  /**
   * @param scene            the shared scene (particles live on PARTICLE_LAYER)
   * @param camera           the active camera (its layer mask is overridden per-render)
   * @param stylizedColorTex stage-1 stylized color (working space) to prefill the buffer
   * @param geometryDepthNode the geometry pass's depth texture node (raw device depth)
   */
  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera,
    stylizedColorTex: THREE.Texture,
    geometryDepthNode: unknown,
  ) {
    super((PassNode as unknown as { COLOR: never }).COLOR, scene, camera);
    const mask = new THREE.Layers();
    mask.set(PARTICLE_LAYER); // render ONLY particles
    this.particleMask = mask.mask;
    this.setLayers(mask);

    const prep = new MeshBasicNodeMaterial();
    prep.depthTest = false; // always pass → unconditionally stamp every pixel
    prep.depthWrite = true; // lay the geometry depth into our depth buffer
    prep.colorNode = vec4(
      (texture(stylizedColorTex, screenUV) as unknown as { rgb: unknown }).rgb as never,
      1.0,
    ) as never;
    prep.depthNode = (geometryDepthNode as { r: typeof prep.depthNode }).r;
    this.prepQuad = new QuadMesh(prep);
  }

  updateBefore(frame: Parameters<PassNode['updateBefore']>[0]): ReturnType<PassNode['updateBefore']> {
    const renderer = (frame as unknown as { renderer: unknown }).renderer as RendererLike;
    const scene = this.scene as unknown as THREE.Scene;
    const camera = this.camera as unknown as THREE.Camera & { layers: THREE.Layers };

    // Size our render target to the drawing buffer (mirrors PassNode.updateBefore).
    renderer.getSize(_size);
    (this as unknown as { _pixelRatio: number })._pixelRatio = renderer.getPixelRatio();
    this.setSize(_size.x, _size.y);

    const prevRT = renderer.getRenderTarget();
    const prevMRT = renderer.getMRT();
    const prevAutoClear = renderer.autoClear;
    const prevMask = camera.layers.mask;
    const prevBg = scene.background;
    const target = this.renderTarget as unknown as THREE.RenderTarget;

    // try/finally (F5): scene/camera/renderer are SHARED with the main forward path
    // and offscreen capture. If prepQuad.render or renderer.render throws (device
    // lost, shader compile error — plausible given first-compile fragility), the
    // restores MUST still run, or the next non-NPR frame renders with no background,
    // a particles-only layer mask, and a hijacked render target — corrupting the
    // whole renderer until reload.
    try {
      renderer.setRenderTarget(target);
      renderer.setMRT(null);
      renderer.autoClear = true;
      renderer.clear(); // fresh color + depth
      this.prepQuad.render(renderer as never); // stylized color + stamped geometry depth
      renderer.autoClear = false; // keep the prefilled color + depth for the particle render
      scene.background = null; // don't let renderer.render repaint over the stylized color
      camera.layers.mask = this.particleMask; // particles only
      renderer.render(scene, camera); // native blend, hardware depth-test vs geometry
    } finally {
      camera.layers.mask = prevMask;
      scene.background = prevBg;
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevRT);
      renderer.setMRT(prevMRT);
    }
    // Base PassNode.updateBefore returns nothing at runtime; @types/three types the
    // return as boolean, so satisfy the compiler without changing behavior.
    return undefined as never;
  }
}
