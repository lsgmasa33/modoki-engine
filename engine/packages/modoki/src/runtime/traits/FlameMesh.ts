import { trait } from 'koota';

/**
 * A solid, glowing two-layer "flame" rendered as a MESH (not particles) — for ship
 * engine exhaust / gas-jet looks. It draws an OUTER cone (larger, softer, cooler) with
 * a brighter INNER cone nested inside (the hot core), giving the characteristic gas-flame
 * structure. Both are concave lathe cones with a TSL gradient + soft fresnel edges, and
 * read correctly from every angle.
 *
 * Each layer has its OWN base→tip color gradient, alpha and brightness, so the inner and
 * outer flames are fully independent. `flameMeshSync` renders it on the PARTICLE_LAYER
 * (composited after the NPR pass — no Sobel outline) unless `afterNPR` is off. Orient the
 * entity so its local +Y points backward from the nozzle (base = nozzle, tip = +Y).
 *
 * Length = `length × lengthScale`; game code drives `lengthScale` (e.g. engine throttle).
 */
export const FlameMesh = trait({
  /** radial segments of the cone mesh (resolution; higher = smoother silhouette) */
  radialSegments: 16,
  /** nozzle radius of the OUTER cone (local units) */
  radius: 0.17,
  /** base flame length along local +Y (local units) */
  length: 1.3,
  /** runtime length multiplier (1 = authored); driven by game code */
  lengthScale: 1,
  /** inner (hot core) cone radius as a fraction of the outer radius */
  innerScale: 0.5,
  /** inner cone length as a fraction of the outer length */
  innerLength: 0.62,
  /** edge softness, 0 = hard silhouette, 1 = very soft fresnel falloff */
  softness: 0.45,
  /** subtle vertical flicker / waver speed (0 = static) */
  flowSpeed: 1.5,
  /** color waver amount — animates the gradient up/down the length over time so the
   *  flame's color shimmers like a real flame (0 = steady, ~0.15 = gentle) */
  colorWaver: 0.15,
  /** additive blending (toward white) vs normal alpha blend */
  additive: false,
  /** render after the NPR post-process (true → no outline) vs through it (false) */
  afterNPR: true,

  // ── Outer flame ──
  /** outer flame color at the nozzle (hex) */
  outerColor: 0x1f8fff,
  /** outer flame color at the tip (hex) */
  outerTipColor: 0x2447c8,
  /** outer flame opacity (0..1) */
  outerAlpha: 0.4,
  /** outer flame brightness multiplier */
  outerIntensity: 1.2,

  // ── Inner flame (hot core) ──
  /** inner flame color at the nozzle (hex) */
  innerColor: 0xeaf6ff,
  /** inner flame color at the tip (hex) */
  innerTipColor: 0x4db4ff,
  /** inner flame opacity (0..1) */
  innerAlpha: 0.9,
  /** inner flame brightness multiplier */
  innerIntensity: 1.6,
});
