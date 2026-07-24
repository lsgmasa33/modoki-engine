import { trait } from 'koota';

/** Fog trait — scene-wide fog (first active entity wins, same convention as
 *  Environment). `linear`/`exponential` drive the classic `scene.fog` object
 *  (`THREE.Fog`/`FogExp2`) — three's WebGPURenderer auto-converts it to TSL each
 *  render. `height` (density varying with world Y, e.g. fog pooling in valleys)
 *  has no classic-object equivalent and drives `scene.fogNode` directly via
 *  `exponentialHeightFogFactor`. See docs/rendering.md "Fog" for the full mechanism.
 *
 *  `density` is shared by `exponential` and `height` modes. Rule of thumb:
 *  `density ≈ 1 / typical viewing distance` — the default `0.02` is tuned for
 *  scenes spanning hundreds of units and reads as "no fog" in a small scene. */
export const Fog = trait({
  enabled: false,
  mode: 'linear' as 'linear' | 'exponential' | 'height',
  color: 0xa8b4c0 as number,
  near: 10 as number,
  far: 100 as number,
  density: 0.02 as number,
  height: 10 as number,
});
