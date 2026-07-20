/** Scene-light picker — the pure, headless-testable core of the custom-shader
 *  lighting feed. Turns the scene's `Light` traits into a small fixed set of
 *  light values a custom shader can read (one key directional + N strongest
 *  point lights + summed ambient), with NO TSL / GPU dependency so it can be
 *  unit-tested on plain data. The `three/tsl` uniform wiring that consumes this
 *  lives in `sceneLightUniforms.ts`.
 *
 *  Why scene-global (not per-mesh): materials in this engine are shared +
 *  refcounted, so a true per-mesh "nearest lights to THIS object" pick would
 *  force per-entity material clones. Instead we pick one global set per frame,
 *  ranked camera-independently (by intensity) so the editor SceneView and the
 *  runtime GameView agree and lights don't pop as the camera moves. Per-mesh
 *  selection is a possible future extension. */

import * as THREE from 'three';

/** Max point lights fed to a custom shader. Lights beyond this (by intensity)
 *  are dropped — the "X close point lights" cap in the light-picker design. */
export const MAX_SHADER_POINT_LIGHTS = 4;

/** Plain-data snapshot of one scene light (Light trait + its world transform).
 *  `x/y/z` = world position; `rx/ry` = world Euler used to derive a directional
 *  light's aim (rz is ignored, matching `syncLights`). */
export interface LightSample {
  lightType: 'ambient' | 'directional' | 'point' | 'spot';
  color: number; // hex, sRGB (as authored on the trait)
  intensity: number;
  distance: number; // point/spot range; 0 = no attenuation (infinite)
  x: number; y: number; z: number;
  rx: number; ry: number;
}

export interface PickedPointLight {
  /** World position. */
  pos: [number, number, number];
  /** Linear rgb premultiplied by intensity. */
  color: [number, number, number];
  /** 1/range for windowed falloff, or 0 when the light has infinite range. */
  invRange: number;
}

export interface PickedLights {
  /** Unit vector pointing TOWARD the key directional light (what a shader dots
   *  with the surface normal). Defaults to straight up when there is none. */
  keyDir: [number, number, number];
  /** Key directional light: linear rgb × intensity (0 when none). */
  keyColor: [number, number, number];
  /** Summed ambient: linear rgb × intensity (0 when none). */
  ambient: [number, number, number];
  /** Up to MAX_SHADER_POINT_LIGHTS point/spot lights, strongest first. */
  points: PickedPointLight[];
}

/** sRGB hex → linear working-space rgb (matches how three feeds light colors
 *  into the shading pipeline when ColorManagement is enabled). */
export function linearFromHex(hex: number): [number, number, number] {
  const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
}

/** Direction TOWARD a directional/spot light from its world Euler, i.e. the
 *  negation of the light's -Z forward that `syncLights` aims at its target.
 *  forward = (-sin(ry)cos(rx), sin(rx), -cos(ry)cos(rx)); toward-light = -forward.
 *  Already unit length (it's a rotation of a unit axis). */
export function keyDirFromEuler(rx: number, ry: number): [number, number, number] {
  const cx = Math.cos(rx);
  return [Math.sin(ry) * cx, -Math.sin(rx), Math.cos(ry) * cx];
}

/** Pick the shader light set from all scene lights. Pure: same input → same
 *  output, no globals. Ambients are summed; the brightest directional becomes
 *  the key; point/spot lights are ranked by intensity and capped. */
export function pickSceneLights(lights: LightSample[]): PickedLights {
  const ambient: [number, number, number] = [0, 0, 0];
  let key: LightSample | null = null;
  const points: LightSample[] = [];

  for (const l of lights) {
    if (l.intensity <= 0) continue;
    switch (l.lightType) {
      case 'ambient': {
        const [r, g, b] = linearFromHex(l.color);
        ambient[0] += r * l.intensity;
        ambient[1] += g * l.intensity;
        ambient[2] += b * l.intensity;
        break;
      }
      case 'directional':
        if (!key || l.intensity > key.intensity) key = l;
        break;
      case 'point':
      case 'spot':
        points.push(l);
        break;
    }
  }

  let keyDir: [number, number, number] = [0, 1, 0];
  let keyColor: [number, number, number] = [0, 0, 0];
  if (key) {
    keyDir = keyDirFromEuler(key.rx, key.ry);
    const [r, g, b] = linearFromHex(key.color);
    keyColor = [r * key.intensity, g * key.intensity, b * key.intensity];
  }

  points.sort((a, b) => b.intensity - a.intensity);
  const picked: PickedPointLight[] = points.slice(0, MAX_SHADER_POINT_LIGHTS).map((l) => {
    const [r, g, b] = linearFromHex(l.color);
    return {
      pos: [l.x, l.y, l.z],
      color: [r * l.intensity, g * l.intensity, b * l.intensity],
      invRange: l.distance > 0 ? 1 / l.distance : 0,
    };
  });

  return { keyDir, keyColor, ambient, points: picked };
}
