/**
 * Over-life LUT baking for the GPU backend. The CPU sim samples size/opacity curves
 * and the color/alpha gradient per particle each frame; on the GPU we instead bake
 * them once into two small 1-D textures and sample by normalized lifetime (`t`) in the
 * render shader. Re-baked on every def edit (cheap — 64 samples).
 *
 * Pure THREE-core (no three/webgpu, no three/tsl) so it stays importable in tests.
 */

import * as THREE from 'three';
import type { ParticleEffectDef } from './types';
import { sampleCurve, sampleGradientAlpha, sampleGradientColor } from './curves';

export const LUT_WIDTH = 64;

export interface OverLifeLUT {
  /** RGBA: R=size mult, G=opacity mult, B=gradient alpha, A=1 */
  scalarTex: THREE.DataTexture;
  /** RGB=gradient color, A=1 */
  colorTex: THREE.DataTexture;
  /** Re-sample the def's curves/gradient into the existing texture data. */
  update(def: ParticleEffectDef): void;
  dispose(): void;
}

function makeTex(): THREE.DataTexture {
  // HalfFloat (rgba16float) is linearly filterable under WebGPU; FloatType (rgba32float)
  // is NOT without the optional `float32-filterable` feature — sampling it with
  // LinearFilter silently reads 0, which would zero out size/opacity (invisible particles).
  const tex = new THREE.DataTexture(new Uint16Array(LUT_WIDTH * 4), LUT_WIDTH, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace; // linear data, not color
  return tex;
}

export function createOverLifeLUT(def: ParticleEffectDef): OverLifeLUT {
  const scalarTex = makeTex();
  const colorTex = makeTex();
  const lut: OverLifeLUT = {
    scalarTex,
    colorTex,
    update(d) {
      const s = scalarTex.image.data as Uint16Array;
      const c = colorTex.image.data as Uint16Array;
      const h = THREE.DataUtils.toHalfFloat;
      const col = { r: 1, g: 1, b: 1 };
      for (let i = 0; i < LUT_WIDTH; i++) {
        const t = i / (LUT_WIDTH - 1);
        s[i * 4] = h(sampleCurve(d.sizeOverLife, t));
        s[i * 4 + 1] = h(sampleCurve(d.opacityOverLife, t));
        s[i * 4 + 2] = h(sampleGradientAlpha(d.colorOverLife, t));
        s[i * 4 + 3] = h(1);
        sampleGradientColor(d.colorOverLife, t, col);
        c[i * 4] = h(col.r); c[i * 4 + 1] = h(col.g); c[i * 4 + 2] = h(col.b); c[i * 4 + 3] = h(1);
      }
      scalarTex.needsUpdate = true;
      colorTex.needsUpdate = true;
    },
    dispose() {
      scalarTex.dispose();
      colorTex.dispose();
    },
  };
  lut.update(def);
  return lut;
}
