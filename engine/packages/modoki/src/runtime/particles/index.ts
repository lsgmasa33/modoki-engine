/** Particle runtime — schema, CPU/TSL backend, and the pluggable backend interface. */
export type {
  ParticleEffectDef,
  IParticleBackend,
  IParticleBackendCore,
  ParticleHandle,
  EmitterShape,
  EmitterShapeType,
  BlendMode,
  Curve,
  CurvePoint,
  Gradient,
  ColorStop,
  AlphaStop,
  MinMax,
  RGB,
  RenderConfig,
  EmissionBurst,
} from './types';
export { defaultParticleEffect } from './types';
export { CpuTslBackend } from './cpuTslBackend';
export { particleBackend } from './particleBackend';
export { CpuParticleSim, type ParticleOutputs } from './cpuSimulator';
export {
  accumNoise,
  accumForce,
  dragFactor,
  annulusRadius,
  sphereRadius,
  type Vec3,
} from './simSpec';
export { resolveShape, samplePolyline, type ResolvedShape } from './emitterShapes';
export { createBillboard, type BillboardObject } from './spriteBillboard';
export { packColor, applyParticleOutputs, type MutableParticle, type ParticleMapOptions } from './pixiParticleMap';
export { createPixiParticles, type PixiParticleObject, type PixiParticleOptions } from './pixiParticleObject';
export { PixiParticleBackend, pixiParticleBackend, type IParticle2DBackend } from './pixiParticleBackend';
export {
  sampleCurve,
  sampleGradientColor,
  sampleGradientAlpha,
  makeRng,
  randRange,
  clamp01,
  lerp,
} from './curves';
