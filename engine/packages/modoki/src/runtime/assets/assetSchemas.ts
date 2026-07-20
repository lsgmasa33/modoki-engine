/** Asset field-schema layer — so Claude can author `.mat.json` / `.particle.json` /
 *  `.anim.json` WITHOUT guessing the JSON shape.
 *
 *  There is no trait-registry-style metadata for these asset files (they're plain
 *  TS types), so this module provides it: a field list (type/default/range/enum)
 *  plus a valid `example`, and a warn-but-write validator. Pure + import-light so
 *  it runs in the dev-server (Node) AND the browser, like sceneMutate.
 *
 *  Coverage is the editable surface the editor exposes (MaterialAssetView for
 *  materials; the documented top-level of ParticleEffectDef / AnimationClipDef).
 *  Nested structures (particle shape/emission/curves, animation tracks/keys)
 *  follow the `example` shape — call out in `notes`. */

import { defaultParticleEffect, type ParticleEffectDef } from '../particles/types';
import { defaultAnimationClip, normalizeAnimationClip, type AnimationClipDef } from '../animation/types';
import { defaultTimeline, normalizeTimeline, type TimelineDef } from '../timeline/types';
import { defaultSpriteClip } from '../traits/SpriteAnimator';
import { MATERIAL_TEXTURE_SLOTS } from './materialTextureSlots';

export type AssetSchemaType = 'material' | 'particle' | 'animation' | 'spriteanim' | 'timeline';

export type AssetFieldType =
  | 'number' | 'color' | 'boolean' | 'enum' | 'string' | 'ref' | 'curve' | 'gradient' | 'object' | 'array';

export interface FieldMeta {
  key: string;
  type: AssetFieldType;
  default?: unknown;
  min?: number;
  max?: number;
  enum?: readonly string[];
  note?: string;
}

export interface AssetSchema {
  type: AssetSchemaType;
  fields: FieldMeta[];
  /** A complete, valid example document of this type. */
  example: unknown;
  notes: string;
}

// ── Material (standard MeshStandardMaterial surface the editor writes) ──
const MATERIAL_FIELDS: FieldMeta[] = [
  { key: 'shader', type: 'enum', enum: ['builtin', 'unlit', 'file'], default: 'builtin', note: 'builtin = MeshStandardMaterial' },
  { key: 'color', type: 'color', default: 0xffffff },
  { key: 'roughness', type: 'number', default: 1, min: 0, max: 1 },
  { key: 'metalness', type: 'number', default: 0, min: 0, max: 1 },
  { key: 'transparent', type: 'boolean', default: false },
  { key: 'opacity', type: 'number', default: 1, min: 0, max: 1 },
  { key: 'side', type: 'enum', enum: ['front', 'double'], default: 'front' },
  { key: 'alphaTest', type: 'number', default: 0, min: 0, max: 1 },
  { key: 'envMapIntensity', type: 'number', default: 1 },
  { key: 'emissive', type: 'color', default: 0x000000 },
  { key: 'emissiveIntensity', type: 'number', default: 1 },
  { key: 'normalScale', type: 'number', default: 1 },
  { key: 'bumpScale', type: 'number', default: 1 },
  { key: 'aoMapIntensity', type: 'number', default: 1 },
  { key: 'lightMapIntensity', type: 'number', default: 1 },
  { key: 'displacementScale', type: 'number', default: 1 },
  { key: 'displacementBias', type: 'number', default: 0 },
  { key: 'flatShading', type: 'boolean', default: false },
  { key: 'wireframe', type: 'boolean', default: false },
  { key: 'vertexColors', type: 'boolean', default: false },
  { key: 'flipY', type: 'boolean', default: true },
  { key: 'textureRepeat', type: 'array', note: '[x,y] UV tiling applied to ALL maps (a single number = uniform). Needs the texture wrap set to repeat (the 3D default).' },
  { key: 'lineColor', type: 'color', note: 'NPR outline color' },
  { key: 'nprColorPreserve', type: 'boolean' },
  // Texture map slots — GUID refs (see Asset References: never a literal path).
  // Sourced from the single slot list (materialTextureSlots) shared with the runtime
  // loader + tree-shaker, so the editor's ref fields can't drift from what ships.
  ...MATERIAL_TEXTURE_SLOTS.map((key): FieldMeta => ({ key, type: 'ref', note: 'texture GUID' })),
];

function defaultMaterial(): Record<string, unknown> {
  return { shader: 'builtin', color: 0xffffff, roughness: 1, metalness: 0 };
}

// ── Particle (top-level ParticleEffectDef surface) ──
const PARTICLE_FIELDS: FieldMeta[] = [
  { key: 'version', type: 'number', default: 1, note: 'always 1' },
  { key: 'name', type: 'string' },
  { key: 'space', type: 'enum', enum: ['2d', '3d'], default: '3d', note: 'editor preview hint only (2d=PixiJS, 3d=Three.js); runtime routing is by Canvas2D ancestry, not this' },
  { key: 'duration', type: 'number', default: 5, note: 'loop period (s)' },
  { key: 'looping', type: 'boolean', default: true },
  { key: 'prewarm', type: 'boolean', default: false },
  { key: 'maxParticles', type: 'number', default: 1000 },
  { key: 'worldSpace', type: 'boolean', default: false },
  { key: 'simulation', type: 'enum', enum: ['cpu', 'gpu'], default: 'cpu' },
  { key: 'emission', type: 'object', note: '{ rateOverTime:number, bursts?:[{time,count}], fillPool?:boolean }' },
  { key: 'shape', type: 'object', note: '{ type:point|cone|sphere|box|circle|cylinder|polyline, radius?, angle?, size?, points?([[x,y],…] for polyline, 2D), … }' },
  { key: 'startLifetime', type: 'object', note: 'MinMax { min, max } (seconds)' },
  { key: 'startSpeed', type: 'object', note: 'MinMax { min, max }' },
  { key: 'startSize', type: 'object', note: 'MinMax { min, max }' },
  { key: 'startColor', type: 'object', note: 'RGB { r, g, b } in 0..1' },
  { key: 'startOpacity', type: 'number', default: 1, min: 0, max: 1 },
  { key: 'gravity', type: 'array', note: 'acceleration [x,y,z] (world units/s²), applied as-is. Legacy scalar g auto-migrates to [0,-g,0]. 2D: [0,+G,0] falls (PixiJS +Y is down), [0,-G,0] rises.' },
  { key: 'drag', type: 'number' },
  { key: 'sizeOverLife', type: 'curve', note: '{ points:[{t,v}], scale? } over normalized life 0..1' },
  { key: 'opacityOverLife', type: 'curve' },
  { key: 'colorOverLife', type: 'gradient', note: '{ colorStops:[{t,color:{r,g,b}}], alphaStops:[{t,alpha}] }' },
  { key: 'render', type: 'object', note: '{ blend:normal|additive|multiply|screen, mode?, texture?(GUID), tilesX?, tilesY?, alignToVelocity?(2D face-travel), renderOrder?(2D zIndex), … }' },
];

// ── Animation (AnimationClipDef top-level) ──
const ANIMATION_FIELDS: FieldMeta[] = [
  { key: 'id', type: 'string', note: 'stable GUID (mirrors .meta.json)' },
  { key: 'name', type: 'string', default: 'New Clip' },
  { key: 'duration', type: 'number', default: 1, note: 'seconds' },
  { key: 'frameRate', type: 'number', default: 60 },
  { key: 'loop', type: 'boolean', default: true },
  { key: 'tracks', type: 'array', note: '[{ path, trait, field, type:number|color|boolean|enum, keys:[{t,v,inTangent,outTangent}] }]' },
];

// ── Timeline (TimelineDef top-level — the `.timeline.json` sequencer payload) ──
const TIMELINE_FIELDS: FieldMeta[] = [
  { key: 'id', type: 'string', note: 'stable GUID (mirrors .meta.json)' },
  { key: 'name', type: 'string', default: 'New Timeline' },
  { key: 'duration', type: 'number', default: 5, note: 'seconds; the Director playhead clamps/loops against this' },
  { key: 'frameRate', type: 'number', default: 30, note: 'authoring snap only' },
  { key: 'tracks', type: 'array', note: 'each track has { id, name, target(relative name-path from the Director root, ""=root), muted?, type } + a per-type body: animation→clips:[{start,duration?,clip(NAME in the target animator bank),scrub?}] · signal→markers:[{t,action(UIAction name),params?}] · audio→cues:[{t,clip(audio GUID),bus?,volume?,pitch?}] · activation→spans:[{start,end}] · control→clips:[{start,duration?,prefab(prefab GUID),transform?({x,y,z,rx,ry,rz,sx,sy,sz} local override for the spawned root — blank fields keep the prefab pose)}] (spawn at start, destroy at start+duration) OR [{start,duration?,particle:true}] (restart the track target ParticleEmitter at start, pause at start+duration) OR [{start,duration?,subdirector:true}] (drive the track target Director/nested timeline synced to the clip — runtime Play only)' },
];

// ── SpriteAnim (a named set of flipbook clips — the `.spriteanim.json` payload) ──
const SPRITEANIM_FIELDS: FieldMeta[] = [
  { key: 'id', type: 'string', note: 'stable GUID (mirrors .meta.json)' },
  { key: 'clips', type: 'object', note: '{ <name>: { frames: sprite-slice GUID[], fps, mode:once|loop|pingpong, cycles } }' },
];

/** A fresh sprite-anim set with one empty "idle" clip ready to receive frames. */
function defaultSpriteAnimData(): { clips: Record<string, ReturnType<typeof defaultSpriteClip>> } {
  return { clips: { idle: defaultSpriteClip() } };
}

const SCHEMAS: Record<AssetSchemaType, () => AssetSchema> = {
  material: () => ({ type: 'material', fields: MATERIAL_FIELDS, example: defaultMaterial(), notes: 'Texture slots are GUID refs, never literal paths. shader:"file" uses a custom shader (params block).' }),
  particle: () => ({ type: 'particle', fields: PARTICLE_FIELDS, example: defaultParticleEffect(), notes: 'Nested objects (emission/shape/MinMax/curves/render) follow the example shape. id assigned on save if absent.' }),
  animation: () => ({ type: 'animation', fields: ANIMATION_FIELDS, example: defaultAnimationClip('', 'New Clip'), notes: 'Tracks bind by relative name-path from the Animator root. Use modoki_anim_add_key to add keyframes.' }),
  timeline: () => ({ type: 'timeline', fields: TIMELINE_FIELDS, example: defaultTimeline('', 'New Timeline'), notes: 'A sequencer asset played by a Director trait. Tracks target descendants of the Director root by relative name-path. Animation-track clips are NAMES in the target animator bank; audio cues are audio GUIDs; signal markers dispatch UIActions.' }),
  spriteanim: () => ({ type: 'spriteanim', fields: SPRITEANIM_FIELDS, example: defaultSpriteAnimData(), notes: 'A named set of flipbook clips. Each clip\'s `frames` are sprite-slice GUID refs (never literal paths). Referenced by SpriteAnimator.clipSet + an active clip name.' }),
};

export function getAssetSchema(type: AssetSchemaType): AssetSchema | null {
  return SCHEMAS[type]?.() ?? null;
}

/** A valid default document for `create-asset`. `id` is injected by the caller. */
export function defaultAssetData(type: AssetSchemaType): unknown {
  if (type === 'material') return defaultMaterial();
  if (type === 'particle') return defaultParticleEffect();
  if (type === 'spriteanim') return defaultSpriteAnimData();
  if (type === 'timeline') return defaultTimeline('', 'New Timeline');
  return defaultAnimationClip('', 'New Clip');
}

const TS_TYPEOF: Partial<Record<AssetFieldType, string>> = { number: 'number', color: 'number', boolean: 'boolean', string: 'string', ref: 'string', enum: 'string' };

/** Warn-but-write validation: hard `errors` block the write (malformed doc);
 *  `warnings` (field type mismatch, out-of-range, unknown enum) are surfaced but
 *  don't block — mirrors sceneMutate / validate-scene. */
export function validateAssetData(type: AssetSchemaType, data: unknown): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { errors: [`${type} data must be a JSON object`], warnings };
  }
  const obj = data as Record<string, unknown>;
  const schema = getAssetSchema(type)!;
  const byKey = new Map(schema.fields.map((f) => [f.key, f] as const));

  // Per-type required-field sanity (hard errors only for fundamentals).
  if (type === 'particle' && (obj.version !== 1)) warnings.push('particle.version should be 1');
  if (type === 'animation' && !Array.isArray(obj.tracks) && obj.tracks !== undefined) {
    errors.push('animation.tracks must be an array');
  }
  if (type === 'timeline' && !Array.isArray(obj.tracks) && obj.tracks !== undefined) {
    errors.push('timeline.tracks must be an array');
  }
  if (type === 'spriteanim') {
    if (obj.clips === undefined || obj.clips === null || typeof obj.clips !== 'object' || Array.isArray(obj.clips)) {
      errors.push('spriteanim.clips must be an object keyed by clip name');
    } else {
      for (const [name, clip] of Object.entries(obj.clips as Record<string, unknown>)) {
        const frames = (clip as { frames?: unknown })?.frames;
        if (frames !== undefined && !Array.isArray(frames)) warnings.push(`spriteanim.clips.${name}.frames must be an array of sprite GUIDs`);
      }
    }
  }

  // Scalar field checks against the schema (skip nested object/array/curve fields).
  for (const [key, value] of Object.entries(obj)) {
    const f = byKey.get(key);
    if (!f || value === undefined || value === null) continue;
    const want = TS_TYPEOF[f.type];
    if (want && typeof value !== want) {
      warnings.push(`${key}: expected ${f.type} (${want}), got ${typeof value}`);
      continue;
    }
    if (f.type === 'number' && typeof value === 'number') {
      if (f.min != null && value < f.min) warnings.push(`${key}: ${value} below min ${f.min}`);
      if (f.max != null && value > f.max) warnings.push(`${key}: ${value} above max ${f.max}`);
    }
    if (f.type === 'enum' && f.enum && typeof value === 'string' && !f.enum.includes(value)) {
      warnings.push(`${key}: '${value}' not one of ${f.enum.join('|')}`);
    }
  }
  return { errors, warnings };
}

/** Coerce/normalize an authored doc before writing (animation gets full normalize). */
export function normalizeAssetData(type: AssetSchemaType, data: unknown): unknown {
  if (type === 'animation') return normalizeAnimationClip((data ?? {}) as Partial<AnimationClipDef>);
  if (type === 'timeline') return normalizeTimeline((data ?? {}) as Partial<TimelineDef>);
  return data;
}

// Re-export the concrete types so callers can import from one place.
export type { ParticleEffectDef, AnimationClipDef, TimelineDef };
