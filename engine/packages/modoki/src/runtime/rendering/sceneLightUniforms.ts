/** Scene-light uniform feed for custom shaders. Bridges the pure picker
 *  (`sceneLightPicker.ts`) to `three/tsl` uniform nodes that custom `.shader.json`
 *  bodies and code-registered TSL shaders can read, so a custom shader lights
 *  itself from the scene's actual `Light` traits instead of baking in a fixed
 *  sun direction/color.
 *
 *  Shape: ONE module-level singleton set of uniform nodes, shared by every custom
 *  material (materials are shared/refcounted, so per-material light uniforms would
 *  fight that). `updateSceneLightUniforms(world)` refreshes their values once per
 *  frame from the picked light set; it runs at the end of `syncLights` so every
 *  render surface (runtime Scene3D + editor SceneView) feeds it and it re-runs the
 *  moment a light moves. The singleton is created lazily the first time a shader
 *  binds it — a scene with no custom shaders pays nothing.
 *
 *  Two consumption paths:
 *   - `getSceneLightUniforms()` — raw uniforms for a shader that wants to write its
 *     own (possibly stylized) lighting math (`keyLightDir`, `keyLightColor`,
 *     `ambientColor`, and per-slot point-light nodes).
 *   - `buildSceneDiffuseNode(nWorld, pWorld)` — a ready-made Lambert term (key N·L
 *     + windowed point-light sum) built from the singleton + a material's own
 *     per-fragment normal/position, for `albedo * (ambientColor + sceneDiffuse)`. */

import * as THREE from 'three';
import { uniform, normalize, max, dot, float, length, pow, clamp, renderGroup } from 'three/tsl';
import type { World } from 'koota';
import { Light } from '../../three/traits/Light';
import { worldTransforms, deactivatedEntities } from '../../three/systems/transformPropagationSystem';
import { MAX_SHADER_POINT_LIGHTS, pickSceneLights, type LightSample } from './sceneLightPicker';

type UniformNode = ReturnType<typeof uniform>;

export interface SceneLightUniforms {
  /** Unit vector toward the key directional light (world space). */
  keyLightDir: UniformNode;
  /** Key directional light: linear rgb × intensity. */
  keyLightColor: UniformNode;
  /** Summed ambient: linear rgb × intensity. */
  ambientColor: UniformNode;
  /** Per-slot point-light world positions. */
  pointPos: UniformNode[];
  /** Per-slot point-light linear rgb × intensity (zero = unused slot). */
  pointColor: UniformNode[];
  /** Per-slot 1/range (0 = infinite range → no falloff). */
  pointInvRange: UniformNode[];
}

let _u: SceneLightUniforms | null = null;

/** The shared singleton uniform nodes, created on first use.
 *
 *  Every one is `.setGroup(renderGroup)` — these are SCENE-GLOBAL values, and a bare
 *  `uniform()` lands in `objectGroup` (a per-render-object buffer) which is only
 *  re-uploaded when `NodeMaterialObserver.needsRefresh(renderObject)` is true — false
 *  forever for a static mesh. That would make a light change silently never reach a
 *  NON-ANIMATING custom-shader object while animated ones updated fine. (Latent here
 *  until now only because every shipped custom-shader object happens to animate —
 *  space-console's ship shakes and its planet spins, which trips `needsRefresh` for
 *  the unrelated world-matrix reason.) Same root cause as the height-fog staleness;
 *  see the uniform-group rule in docs/rendering.md "Fog". */
export function getSceneLightUniforms(): SceneLightUniforms {
  if (!_u) {
    _u = {
      keyLightDir: uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup),
      keyLightColor: uniform(new THREE.Vector3(0, 0, 0)).setGroup(renderGroup),
      ambientColor: uniform(new THREE.Vector3(0, 0, 0)).setGroup(renderGroup),
      pointPos: Array.from({ length: MAX_SHADER_POINT_LIGHTS }, () => uniform(new THREE.Vector3()).setGroup(renderGroup)),
      pointColor: Array.from({ length: MAX_SHADER_POINT_LIGHTS }, () => uniform(new THREE.Vector3()).setGroup(renderGroup)),
      pointInvRange: Array.from({ length: MAX_SHADER_POINT_LIGHTS }, () => uniform(0).setGroup(renderGroup)),
    };
  }
  return _u;
}

/** A ready-made diffuse (Lambert) term from the scene lights, evaluated at the
 *  material's own per-fragment world normal + position. Returns a vec3 node. */
export function buildSceneDiffuseNode(nWorldNode: unknown, pWorldNode: unknown): unknown {
  const u = getSceneLightUniforms();
  const N = normalize(nWorldNode as never);
  // Key directional term.
  let acc = (u.keyLightColor as never as { mul: (n: unknown) => never })
    .mul(max(dot(N, u.keyLightDir as never), float(0)));
  // Point-light terms with a windowed distance falloff: (1 - (d/range)^4)^2,
  // which collapses to 1 (no attenuation) when invRange is 0 (infinite range).
  for (let i = 0; i < MAX_SHADER_POINT_LIGHTS; i++) {
    const toLight = (u.pointPos[i] as never as { sub: (n: unknown) => never }).sub(pWorldNode);
    const dist = length(toLight as never);
    const Ldir = (toLight as never as { div: (n: unknown) => never }).div(max(dist, float(1e-4)));
    const ndl = max(dot(N, Ldir as never), float(0));
    const x = (dist as never as { mul: (n: unknown) => never }).mul(u.pointInvRange[i]);
    const win = clamp(float(1).sub(pow(x as never, float(4))), 0, 1);
    const atten = (win as never as { mul: (n: unknown) => never }).mul(win);
    const contrib = (u.pointColor[i] as never as { mul: (n: unknown) => never }).mul(ndl);
    acc = (acc as never as { add: (n: unknown) => never })
      .add((contrib as never as { mul: (n: unknown) => never }).mul(atten));
  }
  return acc;
}

/** Snapshot every active scene light into plain LightSample data (read-only —
 *  plain query iteration, so it never dirties the Light trait). */
function collectLightSamples(world: World): LightSample[] {
  const out: LightSample[] = [];
  for (const entity of world.query(Light)) {
    if (deactivatedEntities.has(entity.id())) continue;
    const l = entity.get(Light);
    if (!l) continue;
    const wt = worldTransforms.get(entity.id());
    out.push({
      lightType: l.lightType,
      color: l.color,
      intensity: l.intensity,
      distance: l.distance,
      x: wt ? wt.x : 0, y: wt ? wt.y : 0, z: wt ? wt.z : 0,
      rx: wt ? wt.rx : 0, ry: wt ? wt.ry : 0,
    });
  }
  return out;
}

/** Refresh the singleton uniforms from the current scene lights. No-op until a
 *  shader has bound the uniforms (so lightless scenes pay nothing). Called at the
 *  end of `syncLights`, once per rendered frame. */
export function updateSceneLightUniforms(world: World): void {
  if (!_u) return;
  const picked = pickSceneLights(collectLightSamples(world));
  (_u.keyLightDir.value as THREE.Vector3).set(...picked.keyDir);
  (_u.keyLightColor.value as THREE.Vector3).set(...picked.keyColor);
  (_u.ambientColor.value as THREE.Vector3).set(...picked.ambient);
  for (let i = 0; i < MAX_SHADER_POINT_LIGHTS; i++) {
    const p = picked.points[i];
    if (p) {
      (_u.pointPos[i].value as THREE.Vector3).set(...p.pos);
      (_u.pointColor[i].value as THREE.Vector3).set(...p.color);
      _u.pointInvRange[i].value = p.invRange;
    } else {
      (_u.pointColor[i].value as THREE.Vector3).set(0, 0, 0);
      _u.pointInvRange[i].value = 0;
    }
  }
}
