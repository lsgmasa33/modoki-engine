import { trait } from 'koota';

/**
 * Thin ECS trait that attaches a particle effect to an entity. The heavy effect
 * definition (emission, curves, gradients) lives in the referenced `.particle.json`
 * asset — mirroring how Renderable3D references `.mesh.json`/`.mat.json`. The
 * particleSystem reads this trait + Transform and drives an IParticleBackend handle.
 *
 * Effect-authoring concerns (looping, worldSpace, curves, …) belong to the asset and
 * are NOT duplicated here — the `.particle.json` is the single source of truth for them.
 * This trait carries only per-instance runtime concerns.
 */
export const ParticleEmitter = trait({
  /** Asset ref (GUID or path) to a `.particle.json` effect definition. */
  effect: '' as string,
  /** Begin emitting as soon as the entity exists. When false the system is created
   *  paused (ready, but not simulating) until something resumes it. */
  playOnStart: true as boolean,
  /** Time scale for this emitter. */
  playbackSpeed: 1,
  /** Runtime multiplier on new particles' launch speed (1 = authored). Drives
   *  plume/trail length without re-authoring the effect — e.g. a game system
   *  raises this on an engine emitter when the ship accelerates. Affects only
   *  new spawns, so changes ramp in over ~one particle lifetime. */
  speedScale: 1,
  /** Per-renderer visibility — false removes the rendered system. Independent of the
   *  entity's on/off (`EntityAttributes.isActive`, which also cascades to children);
   *  both must be true to render. */
  isVisible: true as boolean,
});
