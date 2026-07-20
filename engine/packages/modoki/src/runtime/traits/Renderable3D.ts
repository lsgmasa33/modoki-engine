import { trait } from 'koota';

export const Renderable3D = trait({
  mesh: '' as string,
  material: '' as string,
  /** Per-renderer visibility — hides just THIS renderable. Independent of the entity's
   *  on/off (`EntityAttributes.isActive`, which also cascades to children); both must be
   *  true to draw. */
  isVisible: true as boolean,
});

/** Mesh asset file format (*.mesh.json). `model` and `material` accept either
 *  a path (legacy) or a UUID resolved through the asset manifest. */
export interface MeshAsset {
  /** Stable UUID — written once at import, never changes across renames/moves. */
  id?: string;
  version: 1;
  model: string;        // GLB ref (guid or path)
  mesh: string;         // mesh name within the model, e.g., "boat"
  postprocessor: string; // model postprocessor ID, e.g., "island"
  material?: string;    // material ref (guid or path)
}

/** Material asset file format (*.mat.json) — the full `MeshStandardMaterial`
 *  authoring surface. All texture fields accept a guid or path. A map's colorspace
 *  is the texture's own concern (its `.meta.json` `colorspace`): color maps
 *  (base/emissive/light) are `srgb`, data maps (normal/rough/metal/ao/bump/
 *  displacement/alpha) must be `linear`. Note the THREE convention — a
 *  `roughnessTexture` is sampled from the green channel, `metalnessTexture` from
 *  blue — so a packed metallic-roughness map can be referenced by both fields.
 *  When a data map is present its scalar factor multiplies the map, so set
 *  `metalness`/`roughness` to 1 to let the map drive the value (a 0 metalness
 *  factor zeroes the map). `aoTexture`/`lightTexture` need a 2nd UV set (`uv1`)
 *  on the geometry — without one THREE samples them from the base `uv`. */
export interface MaterialAsset {
  /** Stable UUID — written once at import, never changes across renames/moves. */
  id?: string;
  version: 1;

  // ── Scalars / colors ──
  color?: number;
  roughness?: number;
  metalness?: number;
  /** Emissive color hex (default black = no emission). */
  emissive?: number;
  /** Emissive strength multiplier (THREE `emissiveIntensity`). Defaults to 1. */
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  side?: 'front' | 'double' | 'back';
  alphaTest?: number;
  envMapIntensity?: number;
  /** AO strength (THREE `aoMapIntensity`). Defaults to 1. */
  aoMapIntensity?: number;
  /** Light-map strength (THREE `lightMapIntensity`). Defaults to 1. */
  lightMapIntensity?: number;
  /** Bump-map strength (THREE `bumpScale`). Defaults to 1. */
  bumpScale?: number;
  /** Displacement amount (THREE `displacementScale`). Defaults to 1. */
  displacementScale?: number;
  /** Displacement offset (THREE `displacementBias`). Defaults to 0. */
  displacementBias?: number;
  /** Normal-map strength (THREE `normalScale`, both axes). Defaults to 1. */
  normalScale?: number;

  // ── Flags ──
  /** Faceted shading (THREE `flatShading`). Defaults to false. */
  flatShading?: boolean;
  /** Render edges only (THREE `wireframe`). Defaults to false. */
  wireframe?: boolean;
  /** Multiply by per-vertex colors (THREE `vertexColors`). Defaults to false. */
  vertexColors?: boolean;
  /** Flip texture V on upload (set false for KTX2/GLB bottom-origin maps). */
  flipY?: boolean;

  // ── Texture maps (guid or path) ──
  /** Base-color (albedo) map — srgb. */
  texture?: string;
  /** Alpha (opacity) map — linear; only the green channel is read. */
  alphaTexture?: string;
  /** Tangent-space normal map — linear. */
  normalTexture?: string;
  /** Bump (height) map — linear; grayscale perturbs normals. */
  bumpTexture?: string;
  /** Displacement (height) map — linear; physically moves vertices (needs subdivision). */
  displacementTexture?: string;
  /** Roughness map — linear; sampled from the green channel. */
  roughnessTexture?: string;
  /** Metalness map — linear; sampled from the blue channel. */
  metalnessTexture?: string;
  /** Emissive map — srgb; multiplied by `emissive` × `emissiveIntensity`. */
  emissiveTexture?: string;
  /** Ambient-occlusion map — linear; sampled from the red channel (needs `uv1`). */
  aoTexture?: string;
  /** Baked light map — srgb (needs `uv1`). */
  lightTexture?: string;
  /** Environment (reflection) map — an equirectangular texture used for reflections. */
  envTexture?: string;
}
