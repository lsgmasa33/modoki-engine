import { trait } from 'koota';

/** Light trait — defines a light source. Position comes from Transform. */
export const Light = trait({
  lightType: 'directional' as 'ambient' | 'directional' | 'point' | 'spot',
  color: 0xffffff as number,
  intensity: 1 as number,
  // Directional/spot: the WORLD-space point to aim at. When any of the three is non-zero
  // the light points here and its Transform rotation is ignored; ALL-ZERO means UNSET, and
  // the aim falls back to the light's rotation (its local -Z forward). All-zero is "unset"
  // rather than "aim at the world origin" so every scene authored before these fields were
  // wired up — they all serialize 0,0,0 — keeps aiming exactly as it did. To aim at the
  // origin, nudge one axis (e.g. targetY 0.001). Read by `syncLights` (runtime/rendering/
  // scene3DSync.ts).
  targetX: 0 as number,
  targetY: 0 as number,
  targetZ: 0 as number,
  // Point/spot: range
  distance: 0 as number,
  // Spot: cone angle (radians) and penumbra (0-1)
  angle: 0.5 as number,
  penumbra: 0 as number,
  castShadow: false as boolean,
  // Shadow tuning (used only when castShadow + a directional/spot light). Defaults give a
  // clean papercraft drop shadow. shadowCameraSize = ortho half-extent (world units) the
  // directional shadow covers — must enclose the scene. bias/normalBias fight acne/peter-panning.
  shadowMapSize: 2048 as number,
  shadowCameraSize: 16 as number,
  shadowBias: -0.0003 as number,
  shadowNormalBias: 0.008 as number,
  shadowRadius: 4 as number,
  // Editor-only: outline the shadow-camera coverage box in the SceneView so you
  // can see whether the scene fits inside `shadowCameraSize` (runtime ignores it).
  showShadowFrustum: false as boolean,
  // A directional shadow camera otherwise stays anchored wherever the light was authored, so
  // its ortho box covers a fixed patch of ground — a subject that walks away from that patch
  // loses its shadow. Measured in demos/forest-camp: the Sun at (5,10,4) with shadowCameraSize
  // 16 covers ground around (7.8, 12.5) while the player walks near (5.6, -0.5); 9m of walking
  // north puts the player outside the box. When true, the box recentres on the active camera's
  // view each frame (see snapShadowCenter/viewGroundFocus in runtime/rendering/shadowFollow.ts).
  // Off pins the box to the light's authored position, for a scene that deliberately wants a
  // fixed box.
  shadowFollowCamera: true as boolean,
  // Entity GUID to centre the shadow box on, instead of the view. Empty = follow what the view
  // is looking at (the runtime derives a ground point from the camera; the editor uses its orbit
  // target). Pointing this at the player is strictly better where one exists: measured in
  // demos/forest-camp the view-derived point trails the character by 2.8-3.7m, so a quarter of
  // the box's radius is spent on ground nobody is looking at. Centred on the subject,
  // `shadowCameraSize` can be smaller for the same coverage — and texel size is 2*size/mapSize,
  // so shrinking it is the cheapest way to sharpen the shadow. A stale guid falls back to the
  // view focus rather than pinning the box at the origin.
  shadowFollowTarget: '' as string,
  // Rendering-layer mask (#136) — this light affects a renderer only when their masks
  // INTERSECT (bitwise AND non-zero). Defaults to layer 0 on both sides, so an unauthored
  // scene has every light hitting every renderer and the whole path stays inert. Use it to
  // give an object its own key light instead of paying for every light in the scene: forward
  // shading evaluates ALL lights per fragment, and the cost is superlinear on mobile (measured
  // 689 ms → 98 ms on a Galaxy A23 by restricting materials to 2 lights). Note a light kept by
  // even ONE renderer still renders its full shadow map. See runtime/rendering/
  // lightMaskVariants.ts.
  renderingLayerMask: 1 as number,
});
