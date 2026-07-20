import { trait } from 'koota';

/** Light trait — defines a light source. Position comes from Transform. */
export const Light = trait({
  lightType: 'directional' as 'ambient' | 'directional' | 'point' | 'spot',
  color: 0xffffff as number,
  intensity: 1 as number,
  // Directional/spot: target to look at
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
});
