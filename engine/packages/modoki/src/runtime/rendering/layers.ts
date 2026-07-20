/**
 * Three.js render-layer assignments shared across the runtime + editor.
 *
 * Particles live on their own layer so the NPR post-process can render scene
 * geometry and particles in SEPARATE passes — the geometry MRT pass excludes
 * the particle layer (so particles aren't Sobel-outlined / grayscaled), and a
 * later particle pass renders ONLY that layer, composited over the stylized
 * frame and occluded by the geometry depth (see ParticlePassNode / docs).
 *
 * Engine-wide implication: because particles move OFF the default layer 0, every
 * camera that should see them (`Scene3D`, editor `SceneView`) must `enable(PARTICLE_LAYER)`,
 * and every punctual light must `enable(PARTICLE_LAYER)` too (three lights are
 * layer-gated — a light only illuminates objects sharing a layer, so lit mesh
 * particles would render black otherwise). When NPR is off this is net-zero
 * change: the camera renders layers 0 + PARTICLE together in one forward pass.
 */

/** Default layer everything starts on (Three.js convention). */
export const DEFAULT_LAYER = 0;

/** Dedicated layer for particle emitter objects. */
export const PARTICLE_LAYER = 1;
