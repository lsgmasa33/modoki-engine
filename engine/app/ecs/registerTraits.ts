/** Game-specific trait registrations — this is the only file a new game
 *  needs to modify to declare its traits to the editor. */

import { registerTrait, type FieldHint } from '@modoki/engine/runtime';
import {
  Transform, Renderable3D, SkinnedModel, SkinnedMeshRenderer, SkeletalAnimator, AnimationLibrary, BoneAttachment, Bone, SkinnedSprite2D, Bone2D, Billboard3D, FlatSprite3D, Zone3D, Zone2D, ZoneOccupant, OnZone3D, OnZone2D, Director, OnSequence, Renderable3DPrimitive, Renderable2D, Text3D, Text2D, TextAnimation, RenderableUI, Camera, CameraFrame, Time, Paused, Persistent, PrefabInstance, EntityAttributes, Light, Environment, Fog, ModelSource,
  UIElement, UIBinding, UIAction, UIFocusable, UIAnchor, Canvas2D, NPRPostFX, Rotate3D, Tint, MaterialInstance, ParticleEmitter, FlameMesh, Animator, SpriteAnimator,
  RigidBody2D, Collider2D, Physics2D, Joint2D, OnCollision2D, CharacterController2D, CharacterAnimator2D,
  RigidBody3D, Collider3D, Physics3D, OnCollision3D, Joint3D, CharacterController3D,
  AudioSource, AudioListener,
} from './traits';
import { getModelPostprocessorIds } from './loaders/modelPostprocessorRegistry';

// Shared inspector-field fragments — spread into both the 2D and 3D physics registrations
// (identical for both dimensions; keeps the two trait tables from drifting).
const COLLIDER_MATERIAL_FIELDS: Record<string, FieldHint> = {
  density: { type: 'number', min: 0, step: 0.1, group: 'Material' },
  friction: { type: 'number', min: 0, step: 0.05, group: 'Material' },
  restitution: { type: 'number', min: 0, max: 1, step: 0.05, group: 'Material', tooltip: 'Bounciness (0 = no bounce, 1 = perfectly elastic)' },
  isSensor: { type: 'boolean', tooltip: 'Trigger — detects overlap (emits sensor events) but applies no solver response' },
};
const COLLIDER_FILTER_FIELDS: Record<string, FieldHint> = {
  collisionGroups: { type: 'number', step: 1, section: 'Advanced Filter', sectionDefaultOpen: false, tooltip: 'Raw 16-bit membership bitmask — used only when Layer is empty/unknown' },
  collisionMask: { type: 'number', step: 1, section: 'Advanced Filter', tooltip: 'Raw 16-bit filter bitmask — used only when Layer is empty/unknown' },
};
const ONCOLLISION_FIELDS: Record<string, FieldHint> = {
  onEnter: { type: 'enum', optionsSource: 'uiActions', tooltip: 'UIAction dispatched when another collider enters this one (overlap begins). The other entity is the action target.' },
  onExit: { type: 'enum', optionsSource: 'uiActions', tooltip: 'UIAction dispatched when another collider exits this one (overlap ends). The other entity is the action target.' },
};
const ONZONE_FIELDS: Record<string, FieldHint> = {
  onEnter: { type: 'enum', optionsSource: 'uiActions', tooltip: 'UIAction dispatched when a ZoneOccupant entity enters this zone. The occupant is the action target.' },
  onExit: { type: 'enum', optionsSource: 'uiActions', tooltip: 'UIAction dispatched when a ZoneOccupant entity exits this zone. The occupant is the action target.' },
};
const ONSEQUENCE_FIELDS: Record<string, FieldHint> = {
  onStart: { type: 'enum', optionsSource: 'uiActions', tooltip: 'UIAction dispatched when this Director\'s timeline sequence starts. The Director entity is the action target.' },
  onEnd: { type: 'enum', optionsSource: 'uiActions', tooltip: 'UIAction dispatched when this Director\'s timeline sequence reaches its end (non-looping). The Director entity is the action target.' },
};

// Inspector ordering convention (component category only — resources/tags are
// listed separately). Components sort ascending by `priority`, so LOWER = higher
// up the panel. Engine-level components occupy the < 100 band defined below;
// game-level traits (AnimatePosition, ShipShake, …) omit `priority` and default
// to 100, so they always render beneath the engine components. Bands are spaced
// by 10 to leave room for future engine components without renumbering.
//   0    EntityAttributes (rendered separately at the very top)
//   10   Transform
//   20   Camera
//   30s  Rendering (Renderable3D/Primitive/2D, ModelSource, ParticleEmitter, Tint)
//   40s  Lighting (Light, Environment, Fog)
//   50   Animation (Rotate3D)
//   60s  UI (UIElement, UIAnchor, UIBinding, UIAction, Canvas2D)
//   70s  Audio (AudioSource, AudioListener)
//   90   PrefabInstance (Misc — near the bottom)
//   100+ game-level traits (default)
export function registerAllTraits() {
  registerTrait({
    name: 'Transform', trait: Transform, category: 'component', componentCategory: 'Transform',
    priority: 10, // show first among components (right after EntityAttributes)
    fields: {
      x: { type: 'number', step: 0.1, group: 'Position' },
      y: { type: 'number', step: 0.1, group: 'Position' },
      z: { type: 'number', step: 0.1, group: 'Position' },
      rx: { type: 'number', step: 1, group: 'Rotation', display: 'degrees' },
      ry: { type: 'number', step: 1, group: 'Rotation', display: 'degrees' },
      rz: { type: 'number', step: 1, group: 'Rotation', display: 'degrees' },
      sx: { type: 'number', step: 0.1, group: 'Scale' },
      sy: { type: 'number', step: 0.1, group: 'Scale' },
      sz: { type: 'number', step: 0.1, group: 'Scale' },
    },
  });

  registerTrait({
    name: 'Renderable3D', trait: Renderable3D, category: 'component', componentCategory: 'Rendering',
    priority: 30,
    fields: {
      mesh: { type: 'string', accept: ['.mesh.json'] },
      material: { type: 'string', accept: ['.mat.json'] },
      isVisible: { type: 'boolean', tooltip: 'Show this renderer. Independent of the entity on/off (EntityAttributes.isActive, which also cascades to children).' },
    },
  });

  registerTrait({
    name: 'SkinnedModel', trait: SkinnedModel, category: 'component', componentCategory: 'Rendering',
    priority: 33,
    fields: {
      model: { type: 'string', accept: ['.glb', '.gltf'], tooltip: 'Rigged GLB (keeps skeleton + animation clips). Pair with SkeletalAnimator to play clips.' },
      isVisible: { type: 'boolean', tooltip: 'Show this renderer. Independent of the entity on/off (EntityAttributes.isActive, which also cascades to children).' },
    },
  });

  registerTrait({
    name: 'SkinnedMeshRenderer', trait: SkinnedMeshRenderer, category: 'component', componentCategory: 'Rendering',
    priority: 34,
    fields: {
      node: { type: 'string', readOnly: true, tooltip: 'GLB mesh node this renderer drives (set by import). Materials below override this node\'s slots.' },
      visible: { type: 'boolean', tooltip: 'Hide/show this mesh node without affecting the rest of the model.' },
      // `materials` (per-slot override map) is edited by a custom Inspector section.
    },
  });

  registerTrait({
    name: 'SkeletalAnimator', trait: SkeletalAnimator, category: 'component', componentCategory: 'Animation',
    priority: 51,
    fields: {
      animSet: { type: 'string', accept: ['.animset.json'], tooltip: 'Animation set (.animset.json) supplying per-clip defaults (speed/loop/fade). Empty = none; the fields below are then used directly. When set, speed/loop/fade below override only when changed from their defaults.' },
      clip: { type: 'enum', optionsSource: 'animationClips', tooltip: 'Active animation clip (from this entity\'s GLB). Empty = first clip.' },
      playing: { type: 'boolean' },
      speed: { type: 'number', step: 0.1, tooltip: 'Playback rate (1 = authored, negative = reverse). Default 1 inherits the animset\'s per-clip speed.' },
      loop: { type: 'boolean', tooltip: 'Repeat vs. play-once-and-clamp. Default (on) inherits the animset\'s per-clip loop.' },
      fadeDuration: { type: 'number', min: 0, step: 0.05, tooltip: 'Crossfade seconds when the clip changes (0 = instant). Default 0 inherits the animset\'s per-clip fade.' },
      activeClip: { type: 'string', group: 'Read-back', readOnly: true, runtimeOnly: true, tooltip: 'Resolved clip actually playing (clip || first clip) — read-back from the mixer' },
      time: { type: 'number', group: 'Read-back', readOnly: true, runtimeOnly: true, tooltip: 'Playhead seconds — read-back' },
      normalizedTime: { type: 'number', group: 'Read-back', readOnly: true, runtimeOnly: true, tooltip: 'Playhead as 0..1 of clip duration — read-back' },
      weight: { type: 'number', group: 'Read-back', readOnly: true, runtimeOnly: true, tooltip: 'Effective blend weight of the active clip — read-back' },
      effectivePaused: { type: 'boolean', group: 'Read-back', readOnly: true, runtimeOnly: true, tooltip: 'Action effectively paused (incl. global stop/pause) — read-back' },
    },
  });

  registerTrait({
    name: 'AnimationLibrary', trait: AnimationLibrary, category: 'component', componentCategory: 'Animation',
    priority: 52,
    fields: {
      // `animSets` (the .animset.json GUID list) is edited by a custom Inspector
      // section (AnimationLibrarySection) — like SkinnedMeshRenderer.materials —
      // since there's no built-in asset-list field type. It still serializes via
      // the AoS path (live keys) and survives prefab instantiation.
      retarget: { type: 'boolean', tooltip: 'Retarget library clips onto this rig (for a source skeleton that is NOT bone-name identical). Off = bind directly by name (cheaper; correct when the rigs share bone names).' },
    },
  });

  registerTrait({
    name: 'BoneAttachment', trait: BoneAttachment, category: 'component', componentCategory: 'Animation',
    priority: 53,
    fields: {
      target: { type: 'entityRef', tooltip: 'Entity carrying the SkinnedModel to attach to' },
      bone: { type: 'enum', optionsSource: 'skeletonBones', tooltip: 'Bone in the target skeleton (this entity follows it; its Transform is a local offset)' },
    },
  });

  registerTrait({
    name: 'Bone', trait: Bone, category: 'component', componentCategory: 'Animation',
    priority: 54,
    fields: {
      name: { type: 'string', tooltip: 'Bone name in the skeleton of the nearest SkinnedModel ancestor. This entity IS that bone: the animation poses it (read-back), code/Animator can override it in LateUpdate, and entities parented under it ride the bone.' },
    },
  });

  registerTrait({
    name: 'SkinnedSprite2D', trait: SkinnedSprite2D, category: 'component', componentCategory: 'Rendering',
    priority: 33,
    fields: {
      rig: { type: 'string', accept: ['.rig2d.json'], tooltip: '2D skinning rig (.rig2d.json) — deformable mesh + bind-pose bones + per-vertex weights. Author child Bone2D entities (names matching the rig) to pose it.' },
      color: { type: 'color', tooltip: 'Tint multiplied over the sprite texture' },
      opacity: { type: 'number', min: 0, max: 1, step: 0.01, tooltip: 'Alpha (0..1)' },
      flipX: { type: 'boolean', tooltip: 'Mirror horizontally about the rig origin (render-only; does not touch the transform)' },
      flipY: { type: 'boolean', tooltip: 'Mirror vertically about the rig origin (render-only)' },
      isVisible: { type: 'boolean', tooltip: 'Show this renderer. Independent of the entity on/off (EntityAttributes.isActive, which also cascades to children).' },
    },
  });

  registerTrait({
    name: 'Billboard3D', trait: Billboard3D, category: 'component', componentCategory: 'Rendering',
    priority: 33.5,
    fields: {
      mode: { type: 'enum', options: ['cylindrical', 'spherical'], tooltip: 'cylindrical (Y-locked): sprite yaws to face the camera but stays upright on the ground — the 2.5D character look. spherical (full-face): always faces the camera on every axis, like a particle (pickups/markers).' },
      alphaTest: { type: 'number', min: 0, max: 1, step: 0.01, tooltip: 'Alpha cutout threshold. Fragments below this alpha are discarded, giving a hard silhouette; the sprite is depth-tested so 3D geometry in front occludes it (2.5D). 0.5 is a good default.' },
      pixelsPerUnit: { type: 'number', min: 1, step: 1, tooltip: 'World units per rig-texture pixel. 100 ⇒ a 200px-tall sprite is 2 units tall. Match your scene scale.' },
      anchor: { type: 'enum', options: ['bottom', 'center'], tooltip: 'Vertical pivot. bottom (feet): the sprite’s lowest bind-pose vertex sits at the entity origin, so y=0 stands ON the ground and it yaws about its feet — grounded characters. center: pivots about its mid-point — floating pickups/orbs.' },
    },
  });

  registerTrait({
    name: 'FlatSprite3D', trait: FlatSprite3D, category: 'component', componentCategory: 'Rendering',
    priority: 33.6,
    fields: {
      alphaTest: { type: 'number', min: 0, max: 1, step: 0.01, tooltip: 'Alpha cutout threshold. Fragments below this alpha are discarded, giving a hard silhouette; the sprite is depth-tested so 3D geometry in front occludes it. 0.5 is a good default.' },
      pixelsPerUnit: { type: 'number', min: 1, step: 1, tooltip: 'World units per rig-texture pixel. 100 ⇒ a 200px sprite spans 2 units. Match your scene scale.' },
    },
  });

  registerTrait({
    name: 'Zone3D', trait: Zone3D, category: 'component', componentCategory: 'Gameplay',
    priority: 33.7,
    fields: {
      shape: { type: 'enum', options: ['sphere', 'circle', 'cylinder', 'capsule', 'box', 'plane'], tooltip: 'Editor-only zone volume shape. sphere/circle/cylinder/capsule: radius = uniform scale (sx); box/plane: size = scale. circle & plane lie flat in the ground plane. Drag to move the centre, scale to resize. Invisible in the built game; game systems read the Transform.' },
      color: { type: 'color', tooltip: 'Wireframe colour of the zone gizmo in the editor.' },
    },
  });

  registerTrait({
    name: 'Zone2D', trait: Zone2D, category: 'component', componentCategory: 'Gameplay',
    priority: 33.8,
    fields: {
      shape: { type: 'enum', options: ['circle', 'box', 'capsule'], tooltip: 'Editor-only 2D zone area shape. circle/capsule: radius = sx; box: size = scale. Drag to move the centre, scale to resize. Invisible in the built game; the zone2D trigger system tests ZoneOccupant entities against it.' },
      color: { type: 'color', tooltip: 'Wireframe colour of the zone gizmo in the editor.' },
    },
  });

  registerTrait({
    name: 'ZoneOccupant', trait: ZoneOccupant, category: 'component', componentCategory: 'Gameplay',
    priority: 33.9,
    fields: {},
  });

  registerTrait({
    name: 'OnZone3D', trait: OnZone3D, category: 'component', componentCategory: 'Gameplay',
    priority: 33.71,
    fields: { ...ONZONE_FIELDS },
  });

  registerTrait({
    name: 'OnZone2D', trait: OnZone2D, category: 'component', componentCategory: 'Gameplay',
    priority: 33.81,
    fields: { ...ONZONE_FIELDS },
  });

  registerTrait({
    name: 'Bone2D', trait: Bone2D, category: 'component', componentCategory: 'Animation',
    priority: 55,
    fields: {
      name: { type: 'string', tooltip: 'Bone name — must match a bone in the nearest SkinnedSprite2D ancestor\'s rig (.rig2d.json). This entity IS that bone: its Transform poses the mesh (gizmo/Inspector, or keyframed via Animator).' },
    },
  });

  registerTrait({
    name: 'ParticleEmitter', trait: ParticleEmitter, category: 'component', componentCategory: 'Rendering',
    priority: 34,
    fields: {
      effect: { type: 'string', accept: ['.particle.json'], tooltip: 'Particle effect asset (.particle.json)' },
      playOnStart: { type: 'boolean', tooltip: 'Auto-play on spawn; off = created paused' },
      playbackSpeed: { type: 'number', min: 0, step: 0.1 },
      speedScale: { type: 'number', min: 0, step: 0.1, tooltip: 'Runtime launch-speed multiplier (1 = authored). Lengthens/shortens the plume & trails; driven by game code (e.g. engine thrust).' },
      isVisible: { type: 'boolean', tooltip: 'Show this renderer. Independent of the entity on/off (EntityAttributes.isActive, which also cascades to children).' },
    },
  });

  registerTrait({
    name: 'FlameMesh', trait: FlameMesh, category: 'component', componentCategory: 'Rendering', priority: 36,
    fields: {
      radialSegments: { type: 'number', min: 3, step: 1, tooltip: 'Mesh resolution (radial segments). 16 ≈ smooth; lower = cheaper' },
      radius: { type: 'number', min: 0, step: 0.01, tooltip: 'Outer cone nozzle radius' },
      length: { type: 'number', min: 0, step: 0.05, tooltip: 'Base flame length along local +Y' },
      lengthScale: { type: 'number', min: 0, step: 0.1, tooltip: 'Runtime length multiplier (driven by game code, e.g. engine thrust)' },
      innerScale: { type: 'number', min: 0, max: 1, step: 0.05, tooltip: 'Inner (hot core) radius as a fraction of the outer radius' },
      innerLength: { type: 'number', min: 0, max: 1, step: 0.05, tooltip: 'Inner cone length as a fraction of the outer length' },
      softness: { type: 'number', min: 0, max: 1, step: 0.05, tooltip: 'Edge softness (fresnel falloff)' },
      flowSpeed: { type: 'number', step: 0.1, tooltip: 'Vertical flicker / waver speed (0 = static)' },
      colorWaver: { type: 'number', min: 0, max: 1, step: 0.02, tooltip: 'Color waver amount — shimmers the gradient up/down over time (0 = steady)' },
      additive: { type: 'boolean', tooltip: 'Additive blend (toward white, good on dark backdrops) vs normal alpha' },
      afterNPR: { type: 'boolean', tooltip: 'Render after the NPR post-process (no outline). Off = render through NPR (gets Sobel-outlined + grayscaled).' },
      outerColor: { type: 'color', tooltip: 'Outer flame color at the nozzle', section: 'Outer Flame' },
      outerTipColor: { type: 'color', tooltip: 'Outer flame color at the tip', section: 'Outer Flame' },
      outerAlpha: { type: 'number', min: 0, max: 1, step: 0.05, tooltip: 'Outer flame opacity', section: 'Outer Flame' },
      outerIntensity: { type: 'number', min: 0, step: 0.05, tooltip: 'Outer flame brightness', section: 'Outer Flame' },
      innerColor: { type: 'color', tooltip: 'Inner flame color at the nozzle', section: 'Inner Flame' },
      innerTipColor: { type: 'color', tooltip: 'Inner flame color at the tip', section: 'Inner Flame' },
      innerAlpha: { type: 'number', min: 0, max: 1, step: 0.05, tooltip: 'Inner flame opacity', section: 'Inner Flame' },
      innerIntensity: { type: 'number', min: 0, step: 0.05, tooltip: 'Inner flame brightness', section: 'Inner Flame' },
    },
  });

  registerTrait({
    name: 'Tint', trait: Tint, category: 'component', componentCategory: 'Rendering',
    priority: 35,
    fields: {
      color: { type: 'color', tooltip: 'Team/highlight color washed over the NPR fill' },
      amount: { type: 'number', min: 0, max: 1, step: 0.05, tooltip: 'Tint strength (0 = none, 1 = full color)' },
    },
  });

  // MaterialInstance — private, parameter-overridable material view (Unity .material /
  // Unreal MID). The `overrides` array (target + kind + source per channel) is edited by
  // the dedicated `materialOverrides` Inspector widget (MaterialOverridesField).
  registerTrait({
    name: 'MaterialInstance', trait: MaterialInstance, category: 'component', componentCategory: 'Rendering',
    priority: 36,
    fields: {
      overrides: { type: 'materialOverrides', tooltip: 'Per-channel material parameter drivers (target + source)' },
    },
  });

  registerTrait({
    name: 'Renderable3DPrimitive', trait: Renderable3DPrimitive, category: 'component', componentCategory: 'Rendering',
    priority: 31,
    fields: {
      mesh: { type: 'enum', options: ['cube', 'box', 'sphere', 'cylinder', 'cone', 'plane', 'torus', 'capsule'] },
      // A mesh renderer references a MATERIAL, never a texture directly — textures
      // live on the .mat.json. Empty = the engine default material.
      material: { type: 'string', accept: ['.mat.json'] },
      color: { type: 'color' },
      size: { type: 'number', step: 1 },
      isVisible: { type: 'boolean', tooltip: 'Show this renderer. Independent of the entity on/off (EntityAttributes.isActive, which also cascades to children).' },
    },
  });

  registerTrait({
    name: 'Renderable2D', trait: Renderable2D, category: 'component', componentCategory: 'Rendering',
    priority: 32,
    fields: {
      // Sprites-only: a 2D sprite ref must be a `sprite` GUID (a slice, or a
      // texture's auto whole-image sprite), never a raw texture — so it carries a
      // rect/pivot and is atlas-able. Primitive keywords (circle/square/triangle)
      // still pass via the validator's PRIMITIVE_SPRITES allowance.
      sprite: { type: 'string', accept: ['sprite'] },
      material: { type: 'string', accept: ['.shader.json'], tooltip: 'Optional custom 2D material (a space:"2d" .shader.json). Empty = default texture/tint. When set, the sprite renders through the shader and a MaterialInstance can drive its uniforms.' },
      color: { type: 'color', alphaField: 'opacity' },
      opacity: { type: 'number', min: 0, max: 1, step: 0.01, tooltip: "Alpha (the color's A channel) — shown as a slider on the Color picker." },
      width: { type: 'number', step: 1, group: 'Size' },
      height: { type: 'number', step: 1, group: 'Size' },
      pivotX: { type: 'number', step: 0.05, min: 0, max: 1, group: 'Pivot' },
      pivotY: { type: 'number', step: 0.05, min: 0, max: 1, group: 'Pivot' },
      keepAspect: { type: 'boolean' },
      flipX: { type: 'boolean', tooltip: 'Mirror horizontally (facing) about the pivot — pure render, does not touch the transform or the collider' },
      flipY: { type: 'boolean', tooltip: 'Mirror vertically about the pivot' },
      blendMode: { type: 'enum', options: ['normal', 'add', 'multiply', 'screen'], tooltip: 'Compositing mode. add = additive glow (on dark backdrops); multiply = darken; screen = lighten; normal = source-over alpha.' },
      isVisible: { type: 'boolean', tooltip: 'Show this renderer. Independent of the entity on/off (EntityAttributes.isActive, which also cascades to children).' },
    },
  });

  // SDF text — shared field set (Text3D adds billboard; Text2D adds orderInLayer).
  // Effects (weight/outline/glow) live in a collapsible section; layout in another.
  const TEXT_FIELDS = {
    text: { type: 'string' as const, multiline: true, tooltip: 'The string to render. Enter inserts a line break.' },
    font: { type: 'string' as const, accept: ['.ttf', '.otf', '.woff', '.woff2'], tooltip: 'A font asset imported + baked via the Font Inspector.' },
    color: { type: 'color' as const, alphaField: 'opacity' },
    align: { type: 'enum' as const, options: ['left', 'center', 'right'] },
    maxWidth: { type: 'number' as const, min: 0, step: 1, section: 'Layout', tooltip: 'Wrap width (0 = no wrapping).' },
    lineSpacing: { type: 'number' as const, min: 0, step: 0.05, section: 'Layout' },
    letterSpacing: { type: 'number' as const, step: 0.01, section: 'Layout' },
    anchorX: { type: 'number' as const, min: 0, max: 1, step: 0.05, group: 'Anchor', section: 'Layout' },
    anchorY: { type: 'number' as const, min: 0, max: 1, step: 0.05, group: 'Anchor', section: 'Layout' },
    weight: { type: 'number' as const, min: 0, max: 0.25, step: 0.01, section: 'Effects', tooltip: 'Extra faux-bold on top of the font’s own weight (0 = as-drawn). Dilates the glyph within the distance field, so past ~0.25 counters close and strokes bleed — for genuinely heavier text import the font’s Bold weight (or bake a larger pxRange). For LIGHTER text, import the Light/Regular weight — eroding a bold glyph (negative) only fakes it and nicks sharp corners, so it’s disabled.' },
    outlineColor: { type: 'color' as const, alphaField: 'outlineOpacity', section: 'Effects' },
    outlineWidth: { type: 'number' as const, min: 0, max: 1, step: 0.02, section: 'Effects', tooltip: 'Outline band width, 0 = off … 1 = widest (stays seam-free — mapped to the field\'s safe budget).' },
    glowColor: { type: 'color' as const, section: 'Effects' },
    glowSize: { type: 'number' as const, min: 0, max: 1, step: 0.02, section: 'Effects', tooltip: 'Soft glow spread, 0 = off … 1 = widest (stays seam-free — mapped to the field\'s safe budget).' },
    glowStrength: { type: 'number' as const, min: 0, max: 2, step: 0.05, section: 'Effects' },
    shadowColor: { type: 'color' as const, alphaField: 'shadowOpacity', section: 'Effects' },
    shadowOpacity: { type: 'number' as const, min: 0, max: 1, step: 0.01, section: 'Effects', tooltip: 'Drop-shadow opacity (0 = off).' },
    shadowOffsetX: { type: 'number' as const, step: 0.01, group: 'Shadow offset', section: 'Effects', tooltip: 'em, +right' },
    shadowOffsetY: { type: 'number' as const, step: 0.01, group: 'Shadow offset', section: 'Effects', tooltip: 'em, +down' },
    shadowSoftness: { type: 'number' as const, min: 0, max: 0.4, step: 0.01, section: 'Effects', tooltip: 'Shadow blur (0 = crisp).' },
    isVisible: { type: 'boolean' as const, tooltip: 'Show this renderer. Independent of the entity on/off (EntityAttributes.isActive).' },
  };

  registerTrait({
    name: 'Text3D', trait: Text3D, category: 'component', componentCategory: 'Rendering',
    priority: 33,
    fields: {
      text: TEXT_FIELDS.text,
      font: TEXT_FIELDS.font,
      fontSize: { type: 'number', min: 0, step: 0.1, tooltip: 'World units per em.' },
      color: TEXT_FIELDS.color,
      align: TEXT_FIELDS.align,
      billboard: { type: 'boolean', tooltip: 'Face the camera (screen-aligned label).' },
      maxWidth: TEXT_FIELDS.maxWidth,
      lineSpacing: TEXT_FIELDS.lineSpacing,
      letterSpacing: TEXT_FIELDS.letterSpacing,
      anchorX: TEXT_FIELDS.anchorX,
      anchorY: TEXT_FIELDS.anchorY,
      weight: TEXT_FIELDS.weight,
      outlineColor: TEXT_FIELDS.outlineColor,
      outlineWidth: TEXT_FIELDS.outlineWidth,
      glowColor: TEXT_FIELDS.glowColor,
      glowSize: TEXT_FIELDS.glowSize,
      glowStrength: TEXT_FIELDS.glowStrength,
      shadowColor: TEXT_FIELDS.shadowColor,
      shadowOpacity: TEXT_FIELDS.shadowOpacity,
      shadowOffsetX: TEXT_FIELDS.shadowOffsetX,
      shadowOffsetY: TEXT_FIELDS.shadowOffsetY,
      shadowSoftness: TEXT_FIELDS.shadowSoftness,
      isVisible: TEXT_FIELDS.isVisible,
    },
  });

  registerTrait({
    name: 'Text2D', trait: Text2D, category: 'component', componentCategory: 'Rendering',
    priority: 34,
    fields: {
      text: TEXT_FIELDS.text,
      font: TEXT_FIELDS.font,
      fontSize: { type: 'number', min: 0, step: 1, tooltip: 'Pixels per em.' },
      color: TEXT_FIELDS.color,
      align: TEXT_FIELDS.align,
      orderInLayer: { type: 'number', step: 1, tooltip: 'Draw order within the 2D layer (higher = in front).' },
      maxWidth: TEXT_FIELDS.maxWidth,
      lineSpacing: TEXT_FIELDS.lineSpacing,
      letterSpacing: TEXT_FIELDS.letterSpacing,
      anchorX: TEXT_FIELDS.anchorX,
      anchorY: TEXT_FIELDS.anchorY,
      weight: TEXT_FIELDS.weight,
      outlineColor: TEXT_FIELDS.outlineColor,
      outlineWidth: TEXT_FIELDS.outlineWidth,
      glowColor: TEXT_FIELDS.glowColor,
      glowSize: TEXT_FIELDS.glowSize,
      glowStrength: TEXT_FIELDS.glowStrength,
      shadowColor: TEXT_FIELDS.shadowColor,
      shadowOpacity: TEXT_FIELDS.shadowOpacity,
      shadowOffsetX: TEXT_FIELDS.shadowOffsetX,
      shadowOffsetY: TEXT_FIELDS.shadowOffsetY,
      shadowSoftness: TEXT_FIELDS.shadowSoftness,
      isVisible: TEXT_FIELDS.isVisible,
    },
  });

  registerTrait({
    name: 'TextAnimation', trait: TextAnimation, category: 'component', componentCategory: 'Animation',
    priority: 35,
    fields: {
      effect: { type: 'enum', options: ['none', 'typewriter', 'wave', 'bounce', 'jitter', 'fade', 'rainbow'], tooltip: 'Per-glyph animation. Plays while the game is Playing; freezes when Stopped (like skeletal). Works on any string, including dynamic/CJK. Motion: typewriter/wave/bounce/jitter. Colour: fade (per-glyph fade-in), rainbow (hue cycle).' },
      speed: { type: 'number', min: 0, step: 0.1, tooltip: 'Time scale: waves/sec (wave, bounce), glyphs/sec (typewriter), shake rate (jitter), fade rate, hue-cycle rate (rainbow).' },
      amplitude: { type: 'number', min: 0, step: 0.01, tooltip: 'Motion size in em, scaled by fontSize (ignored by typewriter/fade/rainbow).' },
      frequency: { type: 'number', step: 0.1, tooltip: 'Per-glyph phase across the string — wavelength (wave) / stagger (bounce, jitter, fade) / hue offset (rainbow).' },
      loop: { type: 'boolean', tooltip: 'Loop the one-shot effects (typewriter). Periodic effects (wave/bounce/jitter) always loop.' },
      fadeIn: { type: 'boolean', tooltip: 'Typewriter on UI text: fade each glyph in (on) vs pop it in instantly (off, more mechanical). No effect on other effects or on 2D/3D text.' },
    },
  });

  registerTrait({ name: 'RenderableUI', trait: RenderableUI, category: 'tag', fields: {} });

  // ── 2D Physics (Rapier) ──
  registerTrait({
    name: 'RigidBody2D', trait: RigidBody2D, category: 'component', componentCategory: 'Physics',
    priority: 70,
    fields: {
      bodyType: { type: 'enum', options: ['dynamic', 'static', 'kinematic'], tooltip: 'dynamic = moved by the solver (gravity/forces); static = never moves; kinematic = moved by code/animation, pushes dynamics' },
      vx: { type: 'number', step: 1, group: 'Velocity', readOnly: true, runtimeOnly: true, tooltip: 'Linear velocity X (world units/s) — read-back from the solver' },
      vy: { type: 'number', step: 1, group: 'Velocity', readOnly: true, runtimeOnly: true },
      angularVel: { type: 'number', step: 0.1, group: 'Velocity', readOnly: true, runtimeOnly: true, display: 'degrees' },
      isSleeping: { type: 'boolean', group: 'Velocity', readOnly: true, runtimeOnly: true, tooltip: 'Solver has put this body to sleep (at rest) — read-back from the solver' },
      linearDamping: { type: 'number', min: 0, step: 0.05, group: 'Damping' },
      angularDamping: { type: 'number', min: 0, step: 0.05, group: 'Damping' },
      gravityScale: { type: 'number', step: 0.1, tooltip: 'Per-body gravity multiplier (0 = float)' },
      fixedRotation: { type: 'boolean', tooltip: 'Lock rotation — the body slides but never spins (top-down characters)' },
      ccd: { type: 'boolean', tooltip: 'Continuous collision detection — for fast/thin bodies that would tunnel' },
      canSleep: { type: 'boolean', tooltip: 'Let the body sleep when at rest (cheaper)' },
    },
  });

  registerTrait({
    name: 'Collider2D', trait: Collider2D, category: 'component', componentCategory: 'Physics',
    priority: 71,
    fields: {
      shape: { type: 'enum', options: ['circle', 'box', 'capsule', 'polygon', 'polyline', 'concave'], tooltip: 'circle/box/capsule = primitives; polygon = convex hull of points (any body); polyline = static open edge chain (terrain/walls); concave = points decomposed into convex pieces (dynamic concave solid)' },
      radius: { type: 'number', min: 0, step: 1, tooltip: 'circle/capsule radius (world units)' },
      halfW: { type: 'number', min: 0, step: 1, group: 'Box', tooltip: 'box half-width (world units)' },
      halfH: { type: 'number', min: 0, step: 1, group: 'Box', tooltip: 'box half-height (world units); for a capsule this is the segment half-height (true height adds radius)' },
      points: { type: 'string', tooltip: 'polygon/polyline/concave point list — inline JSON [[x,y],…] in world units (e.g. [[-50,-50],[50,-50],[0,50]]). Edit visually via the ⬟ Points tool.' },
      ...COLLIDER_MATERIAL_FIELDS,
      physicsLayer: { type: 'enum', optionsSource: 'physicsLayers', tooltip: 'Collision layer (Project Settings → Physics Layers). Drives what this collider hits via the collision matrix. Set empty to use the raw bitmasks below.' },
      ...COLLIDER_FILTER_FIELDS,
    },
  });

  registerTrait({
    name: 'Physics2D', trait: Physics2D, category: 'resource',
    fields: {
      gravityX: { type: 'number', step: 0.1, group: 'Gravity', tooltip: 'Gravity X (m/s²)' },
      gravityY: { type: 'number', step: 0.1, group: 'Gravity', tooltip: 'Gravity Y (m/s², +down). Default 9.81' },
      pixelsPerMeter: { type: 'number', min: 1, step: 1, tooltip: 'World units per physics meter (default 100). Change before Play.' },
    },
  });

  registerTrait({
    name: 'Joint2D', trait: Joint2D, category: 'component', componentCategory: 'Physics',
    priority: 72,
    fields: {
      type: { type: 'enum', options: ['spring', 'revolute', 'prismatic', 'fixed', 'rope'], tooltip: 'spring = soft distance; revolute = hinge; prismatic = slider; fixed = weld; rope = max distance' },
      entityA: { type: 'entityRef', tooltip: 'Body A (RigidBody2D entity)' },
      entityB: { type: 'entityRef', tooltip: 'Body B (RigidBody2D entity)' },
      anchorAX: { type: 'number', step: 1, group: 'Anchors', tooltip: 'Anchor on A, local X (world units)' },
      anchorAY: { type: 'number', step: 1, group: 'Anchors' },
      anchorBX: { type: 'number', step: 1, group: 'Anchors', tooltip: 'Anchor on B, local X (world units)' },
      anchorBY: { type: 'number', step: 1, group: 'Anchors' },
      length: { type: 'number', min: 0, step: 1, tooltip: 'spring rest length / rope max length (world units)' },
      stiffness: { type: 'number', min: 0, step: 1, group: 'Spring', label: 'Spring Stiffness', tooltip: 'spring stiffness' },
      damping: { type: 'number', min: 0, step: 0.1, group: 'Spring', label: 'Spring Damping', tooltip: 'spring damping' },
      axisX: { type: 'number', step: 0.1, group: 'Prismatic', tooltip: 'slide axis X (prismatic)' },
      axisY: { type: 'number', step: 0.1, group: 'Prismatic' },
      limitsEnabled: { type: 'boolean', tooltip: 'Enable revolute/prismatic travel limits' },
      limitMin: { type: 'number', step: 1, group: 'Limits', tooltip: 'revolute: angle (deg); prismatic: distance (world units)' },
      limitMax: { type: 'number', step: 1, group: 'Limits' },
      motorEnabled: { type: 'boolean', tooltip: 'Drive revolute/prismatic. Position drive if stiffness>0, else velocity drive.' },
      motorTargetPos: { type: 'number', step: 1, group: 'Motor', tooltip: 'target angle (deg) / distance (world units)' },
      motorTargetVel: { type: 'number', step: 1, group: 'Motor' },
      motorStiffness: { type: 'number', min: 0, step: 1, group: 'Motor' },
      motorDamping: { type: 'number', min: 0, step: 0.1, group: 'Motor' },
    },
  });

  registerTrait({
    name: 'OnCollision2D', trait: OnCollision2D, category: 'component', componentCategory: 'Physics',
    priority: 73,
    fields: {
      ...ONCOLLISION_FIELDS,
    },
  });

  // ── 3D Physics (Rapier) ──
  registerTrait({
    name: 'RigidBody3D', trait: RigidBody3D, category: 'component', componentCategory: 'Physics',
    priority: 75,
    fields: {
      bodyType: { type: 'enum', options: ['dynamic', 'static', 'kinematic'], tooltip: 'dynamic = moved by the solver (gravity/forces); static = never moves; kinematic = moved by code/animation, pushes dynamics' },
      vx: { type: 'number', step: 1, group: 'Velocity', readOnly: true, runtimeOnly: true, tooltip: 'Linear velocity (world units/s) — read-back from the solver' },
      vy: { type: 'number', step: 1, group: 'Velocity', readOnly: true, runtimeOnly: true },
      vz: { type: 'number', step: 1, group: 'Velocity', readOnly: true, runtimeOnly: true },
      avx: { type: 'number', step: 0.1, group: 'Angular Velocity', readOnly: true, runtimeOnly: true, display: 'degrees' },
      avy: { type: 'number', step: 0.1, group: 'Angular Velocity', readOnly: true, runtimeOnly: true, display: 'degrees' },
      avz: { type: 'number', step: 0.1, group: 'Angular Velocity', readOnly: true, runtimeOnly: true, display: 'degrees' },
      isSleeping: { type: 'boolean', group: 'Velocity', readOnly: true, runtimeOnly: true, tooltip: 'Solver has put this body to sleep (at rest) — read-back from the solver' },
      linearDamping: { type: 'number', min: 0, step: 0.05, group: 'Damping' },
      angularDamping: { type: 'number', min: 0, step: 0.05, group: 'Damping' },
      gravityScale: { type: 'number', step: 0.1, tooltip: 'Per-body gravity multiplier (0 = float)' },
      fixedRotation: { type: 'boolean', tooltip: 'Lock ALL rotation axes — the body translates but never spins' },
      lockRotX: { type: 'boolean', group: 'Lock Rotation', tooltip: 'Freeze spin about the world X axis (ignored if Fixed Rotation is on)' },
      lockRotY: { type: 'boolean', group: 'Lock Rotation' },
      lockRotZ: { type: 'boolean', group: 'Lock Rotation' },
      lockTransX: { type: 'boolean', group: 'Lock Translation', tooltip: 'Freeze motion along the world X axis' },
      lockTransY: { type: 'boolean', group: 'Lock Translation', tooltip: 'Freeze motion along the world Y axis (e.g. a body that slides but never falls)' },
      lockTransZ: { type: 'boolean', group: 'Lock Translation' },
      ccd: { type: 'boolean', tooltip: 'Continuous collision detection — for fast/thin bodies that would tunnel' },
      canSleep: { type: 'boolean', tooltip: 'Let the body sleep when at rest (cheaper)' },
    },
  });

  registerTrait({
    name: 'Collider3D', trait: Collider3D, category: 'component', componentCategory: 'Physics',
    priority: 76,
    fields: {
      shape: { type: 'enum', options: ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'convex', 'trimesh'], tooltip: 'Primitives (capsule/cylinder/cone extend along local +Y). convex = convex hull of a mesh (dynamic-safe); trimesh = raw triangle mesh (exact but STATIC-only).' },
      mesh: { type: 'string', accept: ['.mesh.json'], showWhen: { shape: ['convex', 'trimesh'] }, tooltip: 'convex/trimesh: optional SEPARATE collision mesh (a low-poly proxy). Empty = use this entity\'s Renderable3D mesh.' },
      radius: { type: 'number', min: 0, step: 0.1, tooltip: 'sphere/capsule/cylinder/cone radius (world units)' },
      halfW: { type: 'number', min: 0, step: 0.1, group: 'Box', tooltip: 'box half-extent X (world units)' },
      halfH: { type: 'number', min: 0, step: 0.1, group: 'Box', tooltip: 'box half-extent Y (world units)' },
      halfD: { type: 'number', min: 0, step: 0.1, group: 'Box', tooltip: 'box half-extent Z (world units)' },
      halfHeight: { type: 'number', min: 0, step: 0.1, tooltip: 'capsule/cylinder/cone segment half-height along +Y (world units); for a capsule the true height adds radius' },
      ...COLLIDER_MATERIAL_FIELDS,
      physicsLayer: { type: 'enum', optionsSource: 'physicsLayers', tooltip: 'Collision layer (Project Settings → Physics Layers). Set empty to use the raw bitmasks below.' },
      ...COLLIDER_FILTER_FIELDS,
    },
  });

  registerTrait({
    name: 'Physics3D', trait: Physics3D, category: 'resource',
    fields: {
      gravityX: { type: 'number', step: 0.1, group: 'Gravity', tooltip: 'Gravity X (m/s²)' },
      gravityY: { type: 'number', step: 0.1, group: 'Gravity', tooltip: 'Gravity Y (m/s², +up). Default -9.81 (down)' },
      gravityZ: { type: 'number', step: 0.1, group: 'Gravity', tooltip: 'Gravity Z (m/s²)' },
      unitsPerMeter: { type: 'number', min: 0.0001, step: 0.1, tooltip: 'World units per physics meter (default 1). Change before Play.' },
    },
  });

  registerTrait({
    name: 'OnCollision3D', trait: OnCollision3D, category: 'component', componentCategory: 'Physics',
    priority: 77,
    fields: {
      ...ONCOLLISION_FIELDS,
    },
  });

  registerTrait({
    name: 'Joint3D', trait: Joint3D, category: 'component', componentCategory: 'Physics',
    priority: 78,
    fields: {
      type: { type: 'enum', options: ['spring', 'spherical', 'revolute', 'prismatic', 'fixed', 'rope'], tooltip: 'spring = soft distance; spherical = ball (3-axis free); revolute = hinge (1 axis); prismatic = slider; fixed = weld; rope = max distance' },
      entityA: { type: 'entityRef', tooltip: 'Body A (RigidBody3D entity)' },
      entityB: { type: 'entityRef', tooltip: 'Body B (RigidBody3D entity)' },
      anchorAX: { type: 'number', step: 0.1, group: 'Anchor A', tooltip: 'Anchor on A, local (world units)' },
      anchorAY: { type: 'number', step: 0.1, group: 'Anchor A' },
      anchorAZ: { type: 'number', step: 0.1, group: 'Anchor A' },
      anchorBX: { type: 'number', step: 0.1, group: 'Anchor B', tooltip: 'Anchor on B, local (world units)' },
      anchorBY: { type: 'number', step: 0.1, group: 'Anchor B' },
      anchorBZ: { type: 'number', step: 0.1, group: 'Anchor B' },
      length: { type: 'number', min: 0, step: 0.1, tooltip: 'spring rest length / rope max length (world units)' },
      stiffness: { type: 'number', min: 0, step: 1, group: 'Spring', tooltip: 'spring stiffness' },
      damping: { type: 'number', min: 0, step: 0.1, group: 'Spring', tooltip: 'spring damping' },
      axisX: { type: 'number', step: 0.1, group: 'Axis', tooltip: 'revolute hinge / prismatic slide axis (normalized)' },
      axisY: { type: 'number', step: 0.1, group: 'Axis' },
      axisZ: { type: 'number', step: 0.1, group: 'Axis' },
      limitsEnabled: { type: 'boolean', tooltip: 'Enable revolute/prismatic travel limits' },
      limitMin: { type: 'number', step: 0.1, group: 'Limits', tooltip: 'revolute: angle (rad); prismatic: distance (world units)' },
      limitMax: { type: 'number', step: 0.1, group: 'Limits' },
      motorEnabled: { type: 'boolean', tooltip: 'Drive revolute/prismatic. Position drive if stiffness>0, else velocity drive.' },
      motorTargetPos: { type: 'number', step: 0.1, group: 'Motor', tooltip: 'target angle (rad) / distance (world units)' },
      motorTargetVel: { type: 'number', step: 0.1, group: 'Motor' },
      motorStiffness: { type: 'number', min: 0, step: 1, group: 'Motor' },
      motorDamping: { type: 'number', min: 0, step: 0.1, group: 'Motor' },
    },
  });

  registerTrait({
    name: 'CharacterController3D', trait: CharacterController3D, category: 'component', componentCategory: 'Physics',
    priority: 79,
    fields: {
      speed: { type: 'number', min: 0, step: 0.5, tooltip: 'Horizontal move speed (world units/s)' },
      jumpSpeed: { type: 'number', min: 0, step: 0.5, tooltip: 'Initial upward jump speed (world units/s)' },
      gravityScale: { type: 'number', step: 0.1, tooltip: 'Per-character gravity multiplier' },
      maxSlopeClimbDeg: { type: 'number', min: 0, max: 90, step: 1, group: 'Slopes', tooltip: 'Steepest walkable slope (degrees)' },
      minSlopeSlideDeg: { type: 'number', min: 0, max: 90, step: 1, group: 'Slopes', tooltip: 'Slopes steeper than this make a grounded character slide' },
      autostepHeight: { type: 'number', min: 0, step: 0.05, group: 'Autostep', tooltip: 'Max step height auto-climbed (world units; 0 = off)' },
      autostepMinWidth: { type: 'number', min: 0, step: 0.05, group: 'Autostep', tooltip: 'Min free width required after a step (world units)' },
      snapToGroundDist: { type: 'number', min: 0, step: 0.05, tooltip: 'Snap to ground within this distance off a ledge (world units; 0 = off)' },
      skin: { type: 'number', min: 0.001, step: 0.005, tooltip: 'Collision skin gap (world units; small & non-zero)' },
      moveX: { type: 'number', step: 0.1, group: 'Input', readOnly: true, runtimeOnly: true, tooltip: 'Input X axis, -1..1 (set by input/actions)' },
      moveZ: { type: 'number', step: 0.1, group: 'Input', readOnly: true, runtimeOnly: true, tooltip: 'Input Z axis, -1..1' },
      jump: { type: 'boolean', readOnly: true, runtimeOnly: true, tooltip: 'Jump requested this frame (consumed when grounded)' },
      grounded: { type: 'boolean', group: 'Readback', readOnly: true, runtimeOnly: true, tooltip: 'Standing on ground this frame' },
      velY: { type: 'number', group: 'Readback', readOnly: true, runtimeOnly: true, tooltip: 'Vertical velocity (world units/s, +up)' },
      readbackReady: { type: 'boolean', group: 'Readback', readOnly: true, runtimeOnly: true },
    },
  });

  registerTrait({
    name: 'CharacterController2D', trait: CharacterController2D, category: 'component', componentCategory: 'Physics',
    priority: 74,
    fields: {
      speed: { type: 'number', min: 0, step: 10, tooltip: 'Horizontal move speed (world units/s), scaled by moveX' },
      jumpSpeed: { type: 'number', min: 0, step: 10, tooltip: 'Initial upward speed of a jump (world units/s)' },
      gravityScale: { type: 'number', step: 0.1, tooltip: 'Multiplier on world gravity for this character' },
      maxSlopeClimbDeg: { type: 'number', min: 0, max: 90, step: 1, group: 'Slopes', tooltip: 'Steepest slope (deg) the character can walk up' },
      minSlopeSlideDeg: { type: 'number', min: 0, max: 90, step: 1, group: 'Slopes', tooltip: 'Slopes steeper than this (deg) make a grounded character slide down' },
      autostepHeight: { type: 'number', min: 0, step: 1, group: 'Autostep', tooltip: 'Max step height auto-climbed (world units; 0 = off)' },
      autostepMinWidth: { type: 'number', min: 0, step: 1, group: 'Autostep', tooltip: 'Min free width required after a step (world units)' },
      snapToGroundDist: { type: 'number', min: 0, step: 1, tooltip: 'Snap to ground within this distance off a ledge (world units; 0 = off)' },
      skin: { type: 'number', min: 0, step: 0.5, tooltip: 'Collision skin gap kept around the character (world units)' },
      moveX: { type: 'number', runtimeOnly: true, tooltip: 'INPUT: horizontal axis -1..1 (set by input/actions)' },
      jump: { type: 'boolean', runtimeOnly: true, tooltip: 'INPUT: request a jump this frame' },
      grounded: { type: 'boolean', runtimeOnly: true, readOnly: true, tooltip: 'READBACK: standing on ground this frame' },
      velY: { type: 'number', runtimeOnly: true, readOnly: true, tooltip: 'READBACK: vertical velocity (units/s, down+)' },
      readbackReady: { type: 'boolean', runtimeOnly: true, readOnly: true, tooltip: 'READBACK: physics has written grounded/velY at least once since spawn' },
    },
  });

  registerTrait({
    name: 'CharacterAnimator2D', trait: CharacterAnimator2D, category: 'component', componentCategory: 'Animation',
    priority: 87,
    fields: {
      idleClip: { type: 'string', tooltip: 'SpriteAnimator track played when grounded & still' },
      walkClip: { type: 'string', tooltip: 'SpriteAnimator track played when grounded & moving' },
      jumpClip: { type: 'string', tooltip: 'SpriteAnimator track played while airborne' },
      moveThreshold: { type: 'number', min: 0, max: 1, step: 0.01, tooltip: '|moveX| above this counts as moving' },
      flip: { type: 'boolean', tooltip: 'Mirror the sprite by move direction (Transform.sx sign; sheet faces right)' },
    },
  });

  registerTrait({
    name: 'Camera', trait: Camera, category: 'component', role: 'camera', componentCategory: 'Camera',
    priority: 20,
    fields: {
      projection: { type: 'enum', options: ['perspective', 'orthographic'], tooltip: 'Lens type. Perspective uses fov; orthographic uses orthoSize (no foreshortening).' },
      fov: { type: 'number', step: 1, showWhen: { projection: ['perspective'] }, tooltip: 'Vertical field of view (degrees).' },
      orthoSize: { type: 'number', step: 0.5, min: 0.1, showWhen: { projection: ['orthographic'] }, tooltip: 'Half the visible world-height (world units). Overridden if a CameraFrame drives this camera.' },
      near: { type: 'number', step: 0.01, group: 'Clip' },
      far: { type: 'number', step: 10, group: 'Clip' },
      overlayDistance: { type: 'number', step: 0.1 },
      clearColor: { type: 'color' },
    },
  });

  registerTrait({
    name: 'CameraFrame', trait: CameraFrame, category: 'component', componentCategory: 'Camera',
    priority: 21,
    fields: {
      active: { type: 'boolean', tooltip: 'Is this the active frame? One per scene — the camera fits it.' },
      mode: { type: 'enum', options: ['contain', 'fitWidth', 'fitHeight'], tooltip: 'contain = whole box visible; fitWidth/fitHeight = fill that axis (may crop the other).' },
      autoAim: { type: 'boolean', tooltip: 'Recenter the box into the margined rect (owns lateral camera position). Off = keep authored aim, dolly for size only.' },
      anchorV: { type: 'enum', options: ['off', 'bottom', 'center', 'top'], section: 'Anchor', tooltip: 'Pin a box edge to an exact screen line (overrides vertical centering). e.g. fitWidth + bottom + anchorPosV 0.2 = biggest width AND near edge exactly 20% up (reserve a fixed bottom UI band).' },
      anchorPosV: { type: 'number', min: 0, max: 1, step: 0.01, section: 'Anchor', showWhen: { anchorV: ['bottom', 'center', 'top'] }, tooltip: 'Viewport fraction where the vertical anchored edge lands (0 = screen bottom, 1 = top).' },
      anchorH: { type: 'enum', options: ['off', 'left', 'center', 'right'], section: 'Anchor', tooltip: 'Horizontal twin of the vertical anchor — pin a box edge to an exact screen column (overrides horizontal centering). e.g. reserve a fixed side band.' },
      anchorPosH: { type: 'number', min: 0, max: 1, step: 0.01, section: 'Anchor', showWhen: { anchorH: ['left', 'center', 'right'] }, tooltip: 'Viewport fraction where the horizontal anchored edge lands (0 = screen left, 1 = right).' },
      continuous: { type: 'boolean', tooltip: 'Refit every frame (moving box/camera) vs only on load + resize.' },
      // showGizmo is NOT a field — it's an editor-only display preference (editorStore.cameraGizmoShown,
      // localStorage per guid), toggled via the Inspector's CameraFrameGizmoToggle. See CameraFrame.ts.
      marginTop: { type: 'number', min: 0, max: 0.45, step: 0.01, section: 'Margins', tooltip: 'Top padding (viewport fraction). Bump to reserve HUD/notch space.' },
      marginBottom: { type: 'number', min: 0, max: 0.45, step: 0.01, section: 'Margins' },
      marginLeft: { type: 'number', min: 0, max: 0.45, step: 0.01, section: 'Margins' },
      marginRight: { type: 'number', min: 0, max: 0.45, step: 0.01, section: 'Margins' },
      blendTime: { type: 'number', min: 0, step: 0.05, section: 'Blend', tooltip: 'Seconds to blend INTO this frame at runtime (0 = instant cut).' },
      blendEase: { type: 'enum', options: ['linear', 'quadIn', 'quadOut', 'quadInOut', 'cubicInOut'], section: 'Blend' },
    },
  });


  registerTrait({
    name: 'AudioSource', trait: AudioSource, category: 'component', componentCategory: 'Audio',
    priority: 70,
    fields: {
      clip: { type: 'string', accept: ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac'], tooltip: 'Audio clip (GUID). Buffer-vs-stream is set on the clip asset, not here.' },
      bus: { type: 'enum', options: ['master', 'music', 'sfx', 'ui'], tooltip: 'Mix bus — grouped volume control.' },
      volume: { type: 'number', min: 0, max: 1, step: 0.05 },
      pitch: { type: 'number', min: 0.1, max: 4, step: 0.05, tooltip: 'Playback rate (1 = normal).' },
      loop: { type: 'boolean' },
      autoplay: { type: 'boolean', tooltip: 'Play automatically when the game starts.' },
      crossfadeSec: { type: 'number', min: 0, step: 0.1, tooltip: 'Crossfade duration (s) when the clip changes while playing. 0 = hard cut.' },
      playOnCue: { type: 'string', tooltip: 'Named cue that fires this as a one-shot (raised via cueSound). Empty = none.' },
      spatial: { type: 'boolean', tooltip: '3D positional audio — attenuates by distance from the AudioListener.' },
      refDistance: { type: 'number', min: 0, step: 0.5, section: 'Spatial', showWhen: { spatial: ['true'] }, tooltip: 'Distance at which volume is full.' },
      maxDistance: { type: 'number', min: 0, step: 1, section: 'Spatial', showWhen: { spatial: ['true'] }, tooltip: 'Distance beyond which volume stops dropping.' },
      rolloff: { type: 'number', min: 0, step: 0.1, section: 'Spatial', showWhen: { spatial: ['true'] }, tooltip: 'How quickly volume falls with distance.' },
      playing: { type: 'boolean', readOnly: true, runtimeOnly: true },
    },
  });

  registerTrait({
    name: 'AudioListener', trait: AudioListener, category: 'component', componentCategory: 'Audio',
    priority: 71,
    fields: {
      enabled: { type: 'boolean', tooltip: 'The scene\'s "ears" — put one on the active camera.' },
    },
  });

  registerTrait({
    name: 'Time', trait: Time, category: 'resource',
    fields: {
      // Pure runtime state — recomputed each frame by timeSystem, so runtimeOnly
      // keeps them out of the serialized scene (no save churn). `timeScale` is
      // the one authored knob and is intentionally NOT marked → it persists.
      delta: { type: 'number', readOnly: true, runtimeOnly: true },
      elapsed: { type: 'number', readOnly: true, runtimeOnly: true },
      frame: { type: 'number', readOnly: true, runtimeOnly: true },
      smoothedDelta: { type: 'number', readOnly: true, runtimeOnly: true },
      smoothedElapsed: { type: 'number', readOnly: true, runtimeOnly: true },
    },
  });

  registerTrait({ name: 'Paused', trait: Paused, category: 'tag', fields: {} });

  registerTrait({
    name: 'Persistent', trait: Persistent, category: 'tag', priority: 1, fields: {},
  });

  // Transient is deliberately UNREGISTERED — a pure runtime marker checked by trait identity
  // (`entity.has(Transient)`), never by name. serializeScene skips a Transient entity + its whole
  // subtree by identity. (Registering a trait named 'Transient' previously crashed the renderer via
  // a stale saved layout — see electron/main.ts. See Transient.ts.)

  registerTrait({
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component', componentCategory: 'Misc',
    priority: 0, // show first in Inspector
    fields: {
      name: { type: 'string' },
      isActive: { type: 'boolean' },
      sortOrder: { type: 'number', step: 1 },
      parentId: { type: 'number', step: 1 },
      layer: { type: 'enum', options: ['', '3d', '2d', 'ui'] },
      guid: { type: 'string', readOnly: true },
    },
  });

  registerTrait({
    name: 'Environment', trait: Environment, category: 'component', componentCategory: 'Lighting',
    priority: 41,
    fields: {
      hdrPath: { type: 'string', accept: ['.hdr'], tooltip: 'HDR environment map (.hdr). Drag one from the Assets panel — the engine ships a plain "white" HDR under the Engine section.' },
      intensity: { type: 'number', step: 0.1 },
      showAsBackground: { type: 'boolean' },
      backgroundIntensity: { type: 'number', step: 0.1 },
      backgroundBlurriness: { type: 'number', step: 0.05 },
    },
  });

  registerTrait({
    name: 'Fog', trait: Fog, category: 'component', componentCategory: 'Lighting',
    priority: 42,
    fields: {
      enabled: { type: 'boolean', tooltip: 'Enable fog for this scene (first active Fog entity wins).' },
      mode: { type: 'enum', options: ['linear', 'exponential', 'height'], tooltip: 'linear = fades between Near/Far distances. exponential = density-based falloff (denser = fades sooner). height = density-based falloff below a world-Y ceiling (fog pools in low ground, clear above).' },
      color: { type: 'color', tooltip: 'Fog color, blended over distant/fogged surfaces.' },
      near: { type: 'number', step: 1, min: 0, showWhen: { mode: ['linear'] }, tooltip: 'Distance (world units) where fog starts.' },
      far: { type: 'number', step: 1, min: 0, showWhen: { mode: ['linear'] }, tooltip: 'Distance (world units) where fog reaches full color.' },
      density: { type: 'number', step: 0.001, min: 0, max: 1, showWhen: { mode: ['exponential', 'height'] }, tooltip: 'Fog thickness. Higher = fog closes in sooner. Rule of thumb: density ≈ 1 / typical viewing distance — a small scene (a few world units) needs a much higher density than the 0.02 default, which is tuned for scenes spanning hundreds of units. In height mode this is EXTRA sensitive: the fog factor scales with (viewing distance × depth below Height), so a camera 20+ units out saturates fully even at density 0.3 — start much lower (~0.02–0.05) and raise slowly.' },
      height: { type: 'number', step: 0.5, showWhen: { mode: ['height'] }, tooltip: 'World-Y fog ceiling. Geometry BELOW this height fogs (denser the lower + farther); geometry above it stays clear. Requires a Y-up scene.' },
    },
  });

  registerTrait({
    name: 'Light', trait: Light, category: 'component', componentCategory: 'Lighting',
    priority: 40,
    fields: {
      lightType: { type: 'enum', options: ['ambient', 'directional', 'point', 'spot'] },
      color: { type: 'color' },
      intensity: { type: 'number', step: 0.1 },
      targetX: { type: 'number', step: 0.1, group: 'Target' },
      targetY: { type: 'number', step: 0.1, group: 'Target' },
      targetZ: { type: 'number', step: 0.1, group: 'Target' },
      distance: { type: 'number', step: 1 },
      angle: { type: 'number', step: 0.01, display: 'degrees' },
      penumbra: { type: 'number', step: 0.1, min: 0, max: 1 },
      castShadow: { type: 'boolean' },
      showShadowFrustum: { type: 'boolean', group: 'Shadow', tooltip: 'Editor-only: outline this directional light’s shadow-camera coverage box in the viewport. Anything poking outside the box gets no shadow (it clips) — raise Shadow Camera Size until the box encloses the whole scene.' },
      shadowCameraSize: { type: 'number', step: 1, min: 1, group: 'Shadow', tooltip: 'Ortho half-extent (world units) the directional shadow covers. Must enclose the scene or shadows clip at the box edge. Bigger = softer/lower-res shadows for a fixed map size.' },
      shadowMapSize: { type: 'number', step: 512, min: 256, group: 'Shadow', tooltip: 'Shadow depth-map resolution (px). Higher = crisper shadow edges but more GPU memory — 2048 is mobile-safe, 4096 is heavy on mobile.' },
      shadowRadius: { type: 'number', step: 1, min: 0, group: 'Shadow', tooltip: 'Shadow edge softness (PCF blur radius).' },
      shadowBias: { type: 'number', step: 0.0001, group: 'Shadow', tooltip: 'Depth bias fighting shadow acne. Too negative → peter-panning (shadow detaches from the caster).' },
      shadowNormalBias: { type: 'number', step: 0.001, group: 'Shadow', tooltip: 'Normal-offset bias; softens acne on surfaces angled to the light.' },
    },
  });

  registerTrait({
    name: 'ModelSource', trait: ModelSource, category: 'component', componentCategory: 'Rendering',
    priority: 33,
    fields: {
      glbPath: { type: 'string', readOnly: true },
      postprocessor: { type: 'enum', options: getModelPostprocessorIds() },
      prefix: { type: 'string', readOnly: true },
    },
  });

  registerTrait({
    name: 'PrefabInstance', trait: PrefabInstance, category: 'component', componentCategory: 'Misc',
    priority: 90,
    fields: {
      source: { type: 'string', readOnly: true },
      localId: { type: 'number', readOnly: true },
      rootInstanceId: { type: 'number', readOnly: true },
      parentLocalId: { type: 'number', readOnly: true },
    },
  });

  // ── UI Traits ──

  const S = (section: string, extra?: Partial<FieldHint>) => ({ section, ...extra });

  registerTrait({
    name: 'UIElement', trait: UIElement, category: 'component', componentCategory: 'UI',
    priority: 60,
    fields: {
      // ── Top-level (always visible, most important) ──
      isVisible: { type: 'boolean', tooltip: 'Show or hide this element and all its children' },
      opacity: { type: 'number', step: 0.1, min: 0, max: 1, tooltip: 'Overall element opacity' },

      // ── Layout section (self-placement + size) ──
      // How THIS element sits in its parent. grow/shrink/align-self are
      // self-placement and get disabled when the element is anchored (an anchor
      // positions it absolutely); width/height disable only on a stretched axis.
      // See uiAuthoring.SELF_PLACEMENT_PROPS + the AnchorLayoutNote banner.
      width: { type: 'number', step: 1, tooltip: 'Element width. 0 = auto (sized by content/flexbox)', ...S('Layout') },
      widthUnit: { type: 'enum', options: ['px', '%', 'vw', 'vh', 'vmin', 'vmax'], ...S('Layout') },
      height: { type: 'number', step: 1, tooltip: 'Element height. 0 = auto (sized by content/flexbox)', ...S('Layout') },
      heightUnit: { type: 'enum', options: ['px', '%', 'vw', 'vh', 'vmin', 'vmax'], ...S('Layout') },
      flexGrow: { type: 'number', step: 1, tooltip: 'How much this element grows to fill available space.\n0 = don\'t grow, 1 = take equal share', ...S('Layout') },
      flexShrink: { type: 'number', step: 1, tooltip: 'How much this element shrinks when parent overflows.\n0 = don\'t shrink, 1 = shrink equally', ...S('Layout') },
      alignSelf: { type: 'enum', options: ['auto', 'flex-start', 'center', 'flex-end', 'stretch'], tooltip: 'Override parent alignItems for this element', ...S('Layout') },
      overflow: { type: 'enum', options: ['visible', 'hidden', 'scroll'], tooltip: 'What happens when children exceed bounds.\nvisible = no clipping, hidden = clip, scroll = scrollbar', ...S('Layout') },
      zIndex: { type: 'number', step: 1, tooltip: 'Stacking order among siblings', ...S('Layout') },

      // ── Child Layout section (Unity LayoutGroup — arranges THIS element's children) ──
      // Container-level flexbox. Independent of this element's own anchor, so it
      // stays LIVE even when anchored — needed to stack a runtime-variable list
      // (leaderboard/inventory) you can't hand-anchor. Do NOT fold back into Layout.
      flexDirection: { type: 'enum', options: ['row', 'column'], tooltip: 'Layout direction for children.\nrow = horizontal, column = vertical', ...S('Child Layout', { sectionDivider: true }) },
      justifyContent: { type: 'enum', options: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around'], tooltip: 'How children are distributed along the main axis', ...S('Child Layout') },
      alignItems: { type: 'enum', options: ['flex-start', 'center', 'flex-end', 'stretch'], tooltip: 'How children are aligned on the cross axis', ...S('Child Layout') },
      gap: { type: 'number', step: 1, tooltip: 'Space (px) between children', ...S('Child Layout') },

      // ── Padding section (collapsed by default) ──
      paddingTop: { type: 'number', step: 1, tooltip: 'Inner spacing top', ...S('Padding', { sectionDefaultOpen: false }) },
      paddingTopUnit: { type: 'enum', options: ['px', '%', 'vw', 'vh', 'vmin', 'vmax'], ...S('Padding') },
      paddingRight: { type: 'number', step: 1, tooltip: 'Inner spacing right', ...S('Padding') },
      paddingRightUnit: { type: 'enum', options: ['px', '%', 'vw', 'vh', 'vmin', 'vmax'], ...S('Padding') },
      paddingBottom: { type: 'number', step: 1, tooltip: 'Inner spacing bottom', ...S('Padding') },
      paddingBottomUnit: { type: 'enum', options: ['px', '%', 'vw', 'vh', 'vmin', 'vmax'], ...S('Padding') },
      paddingLeft: { type: 'number', step: 1, tooltip: 'Inner spacing left', ...S('Padding') },
      paddingLeftUnit: { type: 'enum', options: ['px', '%', 'vw', 'vh', 'vmin', 'vmax'], ...S('Padding') },

      // ── Style section ──
      backgroundColor: { type: 'color', alphaField: 'backgroundOpacity', tooltip: 'Background fill color', ...S('Style') },
      backgroundOpacity: { type: 'number', step: 0.1, min: 0, max: 1, tooltip: 'Background opacity. 0 = transparent, 1 = solid', ...S('Style') },
      borderRadius: { type: 'number', step: 1, tooltip: 'Corner rounding (px)', ...S('Style') },
      borderWidth: { type: 'number', step: 1, tooltip: 'Border thickness (px). 0 = no border', ...S('Style') },
      borderColor: { type: 'color', alphaField: 'borderOpacity', tooltip: 'Border color', ...S('Style') },
      borderOpacity: { type: 'number', step: 0.01, min: 0, max: 1, tooltip: 'Border color alpha', ...S('Style') },

      // ── Text section ──
      text: { type: 'string', tooltip: 'Text content. Supports {storeField} templates', ...S('Text'), sectionDivider: true },
      fontSize: { type: 'number', step: 1, tooltip: 'Text size (px)', ...S('Text') },
      fontWeight: { type: 'enum', options: ['normal', 'bold'], tooltip: 'Text weight', ...S('Text') },
      fontStyle: { type: 'enum', options: ['normal', 'italic'], tooltip: 'Text style', ...S('Text') },
      textColor: { type: 'color', alphaField: 'textOpacity', tooltip: 'Text color', ...S('Text') },
      textOpacity: { type: 'number', step: 0.01, min: 0, max: 1, tooltip: 'Text color alpha', ...S('Text') },
      textAlign: { type: 'enum', options: ['left', 'center', 'right'], tooltip: 'Horizontal text alignment', ...S('Text') },
      fontFamily: { type: 'string', tooltip: 'Font family name or drag a font asset. Empty = system default', accept: ['.ttf', '.otf', '.woff', '.woff2'], ...S('Text') },
      lineHeight: { type: 'number', step: 0.1, tooltip: 'Line height multiplier. 0 = auto', ...S('Text') },
      letterSpacing: { type: 'number', step: 0.5, tooltip: 'Letter spacing (px)', ...S('Text') },
      textOverflow: { type: 'enum', options: ['clip', 'ellipsis'], tooltip: 'How to handle text overflow', ...S('Text') },
      maxLines: { type: 'number', step: 1, tooltip: 'Max visible lines. 0 = unlimited', ...S('Text') },

      // ── Text Shadow (collapsed by default) ──
      textShadowColor: { type: 'color', alphaField: 'textShadowOpacity', tooltip: 'Shadow color', ...S('Text Shadow', { sectionDefaultOpen: false }) },
      textShadowOpacity: { type: 'number', step: 0.01, min: 0, max: 1, tooltip: 'Shadow color alpha', ...S('Text Shadow') },
      textShadowOffsetX: { type: 'number', step: 1, tooltip: 'Horizontal offset (px)', ...S('Text Shadow') },
      textShadowOffsetY: { type: 'number', step: 1, tooltip: 'Vertical offset (px)', ...S('Text Shadow') },
      textShadowBlur: { type: 'number', step: 1, tooltip: 'Blur radius (px)', ...S('Text Shadow') },

      // ── Text Stroke (collapsed by default) ──
      textStrokeColor: { type: 'color', alphaField: 'textStrokeOpacity', tooltip: 'Stroke/outline color', ...S('Text Stroke', { sectionDefaultOpen: false }) },
      textStrokeOpacity: { type: 'number', step: 0.01, min: 0, max: 1, tooltip: 'Stroke color alpha', ...S('Text Stroke') },
      textStrokeWidth: { type: 'number', step: 0.5, tooltip: 'Stroke width (px)', ...S('Text Stroke') },

      // ── Image section (collapsed by default) ──
      imageSrc: { type: 'string', accept: ['sprite'], tooltip: 'Image asset (GUID) — a sprite (a texture\'s whole-image sprite or a slice). Rendered as a CSS background. Drag a sprite here', ...S('Image', { sectionDefaultOpen: false }) },
      imageMode: { type: 'enum', options: ['cover', 'contain', 'fill', 'none'], tooltip: 'How the image fills the element', ...S('Image') },

      // ── Size Constraints section (collapsed by default) ──
      minWidth: { type: 'number', step: 1, tooltip: 'Minimum width (px). 0 = none', ...S('Size Constraints', { sectionDefaultOpen: false }), sectionDivider: true },
      maxWidth: { type: 'number', step: 1, tooltip: 'Maximum width (px). 0 = none', ...S('Size Constraints') },
      minHeight: { type: 'number', step: 1, tooltip: 'Minimum height (px). 0 = none', ...S('Size Constraints') },
      maxHeight: { type: 'number', step: 1, tooltip: 'Maximum height (px). 0 = none', ...S('Size Constraints') },

      // ── Margin section (collapsed by default) ──
      marginTop: { type: 'number', step: 1, tooltip: 'Outer spacing top', ...S('Margin', { sectionDefaultOpen: false }) },
      marginTopUnit: { type: 'enum', options: ['px', '%', 'vw', 'vh', 'vmin', 'vmax'], ...S('Margin') },
      marginRight: { type: 'number', step: 1, tooltip: 'Outer spacing right', ...S('Margin') },
      marginRightUnit: { type: 'enum', options: ['px', '%', 'vw', 'vh', 'vmin', 'vmax'], ...S('Margin') },
      marginBottom: { type: 'number', step: 1, tooltip: 'Outer spacing bottom', ...S('Margin') },
      marginBottomUnit: { type: 'enum', options: ['px', '%', 'vw', 'vh', 'vmin', 'vmax'], ...S('Margin') },
      marginLeft: { type: 'number', step: 1, tooltip: 'Outer spacing left', ...S('Margin') },
      marginLeftUnit: { type: 'enum', options: ['px', '%', 'vw', 'vh', 'vmin', 'vmax'], ...S('Margin') },

      // ── Input section (collapsed by default) ──
      elementType: { type: 'enum', options: ['div', 'input', 'range'], tooltip: 'div: plain container. input: text input (pair with UIBinding.inputBinding + a UIAction change/submit binding). range: slider (pair with UIBinding.inputBinding + a UIAction change binding; payload is a number).', ...S('Input', { sectionDefaultOpen: false }), sectionDivider: true },
      placeholder: { type: 'string', tooltip: 'Placeholder text shown when an input is empty', ...S('Input') },
      rangeMin: { type: 'number', step: 1, tooltip: 'Slider minimum value (elementType=range)', ...S('Input') },
      rangeMax: { type: 'number', step: 1, tooltip: 'Slider maximum value (elementType=range)', ...S('Input') },
      rangeStep: { type: 'number', step: 0.1, tooltip: 'Slider step increment (elementType=range)', ...S('Input') },
    },
  });

  registerTrait({
    name: 'UIBinding', trait: UIBinding, category: 'component', componentCategory: 'UI',
    priority: 62,
    fields: {
      textBinding: { type: 'string' },
      inputBinding: { type: 'string', tooltip: 'Store field for two-way input value (e.g. "inputText")' },
      visibleBinding: { type: 'string', section: 'Visibility', sectionDefaultOpen: false, sectionDivider: true, tooltip: 'Store field that gates visibility (in addition to UIElement.isVisible). Empty = no override. E.g. "gameOver" or "hearts".' },
      visibleOp: { type: 'enum', options: ['', '==', '!=', '>', '>=', '<', '<='], section: 'Visibility', tooltip: 'Empty = show when the field is truthy; otherwise compare the field against the value below.' },
      visibleValue: { type: 'string', section: 'Visibility', tooltip: 'Value compared against the store field (number-coerced when numeric), e.g. "2".' },
      highlightTarget: { type: 'entityRef', section: 'Active Highlight', sectionDefaultOpen: false, sectionDivider: true, tooltip: 'Entity whose live property decides if this element is "active" (e.g. the animated entity carrying SkeletalAnimator)' },
      highlightComponent: { type: 'string', section: 'Active Highlight', tooltip: 'Trait on the target to read, e.g. "SkeletalAnimator"' },
      highlightProperty: { type: 'string', section: 'Active Highlight', tooltip: 'Field on that trait to compare, e.g. "clip"' },
      highlightValue: { type: 'string', section: 'Active Highlight', tooltip: 'Value that marks THIS element active (e.g. this button\'s clip name)' },
      highlightColor: { type: 'color', section: 'Active Highlight', tooltip: 'Background color while active. Clear the Target above to disable the highlight.' },
      highlightTextColor: { type: 'color', section: 'Active Highlight', tooltip: 'Text color while active (e.g. invert to white over a black active fill). Leave unset to keep the normal text color.' },
    },
  });

  registerTrait({
    name: 'UIAction', trait: UIAction, category: 'component', componentCategory: 'UI',
    priority: 63,
    fields: {
      // One unified list of event→response bindings. Each row picks an event
      // (click/change/submit) and a kind: 'set' (declarative property write on a
      // target entity) or 'call' (dispatch a named system/engine action with
      // typed params). Edited via the Inspector's UIActionBindingsField.
      bindings: { type: 'bindings', tooltip: 'Event→response bindings: set a property or call an action on click/change/submit' },
    },
  });

  registerTrait({
    name: 'UIFocusable', trait: UIFocusable, category: 'component', componentCategory: 'UI',
    priority: 63.5,
    fields: {
      focusable: { type: 'boolean', tooltip: 'Reachable by controller/keyboard focus navigation' },
      focusOrder: { type: 'number', tooltip: 'Tie-break order within a scope (lower = earlier); seeds autofocus' },
      autoFocus: { type: 'boolean', tooltip: 'Focus lands here first when this scope activates (lowest focusOrder wins)' },
      focusScope: { type: 'string', tooltip: 'Scope key grouping a screen/menu/modal — focus stays within the active scope' },
      navUp: { type: 'entityRef', tooltip: 'Explicit up-nav target (UI entity); empty → spatial nearest' },
      navDown: { type: 'entityRef', tooltip: 'Explicit down-nav target (UI entity); empty → spatial nearest' },
      navLeft: { type: 'entityRef', tooltip: 'Explicit left-nav target (UI entity); empty → spatial nearest' },
      navRight: { type: 'entityRef', tooltip: 'Explicit right-nav target (UI entity); empty → spatial nearest' },
    },
  });

  registerTrait({
    name: 'Canvas2D', trait: Canvas2D, category: 'component', componentCategory: 'UI',
    priority: 64,
    fields: {
      referenceWidth: { type: 'number', step: 1, tooltip: 'Design resolution width. Content is authored at this width and scaled to fit.' },
      referenceHeight: { type: 'number', step: 1, tooltip: 'Design resolution height. Content is authored at this height and scaled to fit.' },
      scaleMode: { type: 'enum', options: ['fitW', 'fitH', 'contain', 'cover', 'fill', 'none'], tooltip: 'fitW = match width (crop vertical), fitH = match height (crop horizontal), contain = fit entirely inside (letterbox), cover = cover area (crop), fill = stretch to fill, none = 1:1 pixels' },
    },
  });

  registerTrait({
    name: 'Rotate3D', trait: Rotate3D, category: 'component', componentCategory: 'Animation',
    priority: 50,
    fields: {
      axis: { type: 'enum', options: ['x', 'y', 'z'] },
      speed: { type: 'number', step: 0.1, tooltip: 'Radians per second' },
    },
  });

  registerTrait({
    name: 'Director', trait: Director, category: 'component', componentCategory: 'Animation',
    priority: 52,
    fields: {
      timeline: { type: 'string', accept: ['.timeline.json'], tooltip: 'Timeline sequence (.timeline.json) — tracks/clips that drive descendants by relative name-path. Drag one from the Assets panel; double-click the asset to edit it.' },
      time: { type: 'number', step: 0.05, min: 0, tooltip: 'Playhead (seconds)' },
      speed: { type: 'number', step: 0.1, tooltip: 'Playback rate multiplier' },
      playing: { type: 'boolean' },
      loop: { type: 'boolean', tooltip: 'Repeat vs. clamp at the timeline duration' },
      lastTime: { type: 'number', group: 'Read-back', readOnly: true, runtimeOnly: true, tooltip: 'Previous frame\'s playhead (edge detection) — read-back' },
      started: { type: 'boolean', group: 'Read-back', readOnly: true, runtimeOnly: true, tooltip: 'Whether the sequence-start fan-out has fired this playthrough — read-back' },
    },
  });

  registerTrait({
    name: 'OnSequence', trait: OnSequence, category: 'component', componentCategory: 'Animation',
    priority: 53,
    fields: { ...ONSEQUENCE_FIELDS },
  });

  registerTrait({
    name: 'Animator', trait: Animator, category: 'component', componentCategory: 'Animation',
    // Sorts the Animator section LOW in the Inspector (below UIElement/UIAnchor/
    // Canvas2D at 59-64, just above PrefabInstance at 90) so it doesn't dominate the
    // top of a UI/Canvas2D entity above its primary editor.
    priority: 85,
    fields: {
      // The named clip bank (`clips`, JSON-string) + the active `clip` NAME are owned by the
      // custom Inspector section (AnimatorClipsSection): a row editor + an active-clip dropdown.
      // Both persist (koota-schema fields) but are omitted here so the generic renderer skips
      // them. Only the global playhead controls are generic.
      time: { type: 'number', step: 0.01, min: 0, tooltip: 'Current playhead (seconds)' },
      speed: { type: 'number', step: 0.1, tooltip: 'Playback rate multiplier (a per-clip speed overrides)' },
      playing: { type: 'boolean' },
      loop: { type: 'boolean', tooltip: 'Loop vs. clamp (a per-clip loop overrides)' },
      fadeDuration: { type: 'number', step: 0.05, min: 0, tooltip: 'Crossfade seconds when the active clip changes (0 = instant cut). A per-clip fadeDuration overrides this.' },
      activeClip: { type: 'string', group: 'Read-back', readOnly: true, runtimeOnly: true, tooltip: 'Resolved clip actually playing (active name || first) — read-back' },
      fadeFrom: { type: 'string', group: 'Read-back', readOnly: true, runtimeOnly: true, tooltip: 'Outgoing clip name during a crossfade (empty = no fade) — read-back' },
      fadeFromTime: { type: 'number', group: 'Read-back', readOnly: true, runtimeOnly: true, tooltip: 'Outgoing clip playhead during a crossfade — read-back' },
      fadeElapsed: { type: 'number', group: 'Read-back', readOnly: true, runtimeOnly: true, tooltip: 'Seconds into the current crossfade — read-back' },
    },
  });

  registerTrait({
    name: 'SpriteAnimator', trait: SpriteAnimator, category: 'component', componentCategory: 'Animation',
    priority: 86,
    fields: {
      // `clipSet` is the PREFERRED source: a GUID ref to a reusable `.spriteanim.json`
      // asset (edited in the dockable SpriteAnim Editor). Rendered as an AssetRefField.
      clipSet: { type: 'string', accept: ['.spriteanim.json'], tooltip: 'Sprite-animation clip set (.spriteanim.json) — a reusable named set of flipbook clips. Takes precedence over the legacy inline clips. Drag one from the Assets panel, or use locate; double-click the asset to edit it.' },
      // The active `clip` name + the legacy inline `clips` (named tracks, frame list,
      // fps / mode / cycles) are owned by the custom Inspector section
      // (SpriteAnimatorSection): a clip dropdown (from the clipSet asset, or the legacy
      // inline map when clipSet is empty). Only the global playhead controls are generic.
      time: { type: 'number', step: 0.01, min: 0, tooltip: 'Current playhead (seconds) of the active track' },
      playing: { type: 'boolean' },
    },
  });

  registerTrait({
    name: 'NPRPostFX', trait: NPRPostFX, category: 'resource',
    fields: {
      enabled: { type: 'boolean', tooltip: 'Route 3D rendering through the NPR edge-detection composer' },
      fillMode: { type: 'enum', options: ['flat', 'grayscale'], tooltip: 'flat = white sheet, grayscale = lit luminance remap' },
      depthThreshold: { type: 'number', step: 0.001, min: 0, max: 0.05, section: 'Edge Thresholds', tooltip: 'View-space depth Sobel threshold for silhouettes. Larger = fewer lines.' },
      normalThreshold: { type: 'number', step: 0.01, min: 0, max: 1, section: 'Edge Thresholds', tooltip: 'Normal Sobel threshold for crease edges' },
      colorThreshold: { type: 'number', step: 0.01, min: 0, max: 1, section: 'Edge Thresholds', tooltip: 'Luminance Sobel threshold for texture/color edges' },
      lineThickness: { type: 'number', step: 1, min: 1, max: 2, section: 'Lines', tooltip: 'Sobel sample radius in pixels' },
      lineStrength: { type: 'number', step: 0.05, min: 0, max: 1, section: 'Lines', tooltip: 'Multiplier on the line mask. 1 = full black, 0 = no lines.' },
      grayscaleGamma: { type: 'number', step: 0.05, min: 0.1, max: 2, section: 'Grayscale Fill', tooltip: 'Luminance remap exponent. <1 lifts midtones toward highlights.', showWhen: { fillMode: ['grayscale'] } },
      grayscaleLift: { type: 'number', step: 0.05, min: 0, max: 1, section: 'Grayscale Fill', tooltip: 'Black lift. Higher pushes shadows toward white.', showWhen: { fillMode: ['grayscale'] } },
      fxaa: { type: 'boolean', section: 'FXAA', tooltip: 'Post-process antialiasing on the composite output. Reduces silhouette aliasing during rotation.' },
      fxaaEdgeThreshold: { type: 'number', step: 0.005, min: 0, max: 0.5, section: 'FXAA', tooltip: 'Relative-contrast threshold. Higher = AA only on stronger edges. Typical 0.05–0.25.', showWhen: { fxaa: ['true'] } },
      fxaaEdgeThresholdMin: { type: 'number', step: 0.001, min: 0, max: 0.1, section: 'FXAA', tooltip: 'Absolute luma floor — pixels below this are treated as flat. Typical 0.01–0.05.', showWhen: { fxaa: ['true'] } },
      fxaaBlendStrength: { type: 'number', step: 0.5, min: 0, max: 16, section: 'FXAA', tooltip: 'Blur strength multiplier on detected edges. Typical 2–8.', showWhen: { fxaa: ['true'] } },
      superSampleScale: { type: 'number', step: 1, min: 1, max: 4, section: 'Supersampling', tooltip: 'Supersample factor on MRT + composite RTT. 1 = native, 2 = 4× pixels (default), 4 = 16× pixels (overkill). Changing this rebuilds the pipeline.' },
    },
  });

  registerTrait({
    // Anchor first among UI traits (priority 59 < UIElement's 60) — placement is
    // the RectTransform-equivalent users reach for before styling, so it sits at
    // the top of the Inspector. Keep < 60 to stay above UIElement.
    name: 'UIAnchor', trait: UIAnchor, category: 'component', priority: 59, componentCategory: 'UI',
    fields: {
      anchor: { type: 'enum', options: ['stretch', 'top', 'top-stretch', 'bottom', 'bottom-stretch', 'left', 'left-stretch', 'right', 'right-stretch', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center', 'h-stretch', 'v-stretch'],
        tooltip: 'Screen anchor preset. Sets position: absolute.\nstretch = fill parent\ntop/bottom/left/right = pin to edge\n*-stretch = pin to edge + stretch the cross axis\nh-stretch/v-stretch = stretch one axis, center the other\ncorners = pin to corner\ncenter = centered with translate' },
      top: { type: 'number', step: 1, tooltip: 'Offset from top edge (or inset for stretch)' },
      topUnit: { type: 'enum', options: ['px', '%', 'vw', 'vh', 'vmin', 'vmax'] },
      left: { type: 'number', step: 1, tooltip: 'Offset from left edge (or inset for stretch)' },
      leftUnit: { type: 'enum', options: ['px', '%', 'vw', 'vh', 'vmin', 'vmax'] },
      right: { type: 'number', step: 1, tooltip: 'Offset from right edge (or inset for stretch)' },
      rightUnit: { type: 'enum', options: ['px', '%', 'vw', 'vh', 'vmin', 'vmax'] },
      bottom: { type: 'number', step: 1, tooltip: 'Offset from bottom edge (or inset for stretch)' },
      bottomUnit: { type: 'enum', options: ['px', '%', 'vw', 'vh', 'vmin', 'vmax'] },
      pivotX: { type: 'number', step: 0.1, tooltip: 'Horizontal pivot (0 = left edge, 0.5 = center, 1 = right edge).\nShifts which point of this element sits at the anchor position.' },
      pivotY: { type: 'number', step: 0.1, tooltip: 'Vertical pivot (0 = top edge, 0.5 = center, 1 = bottom edge).\nShifts which point of this element sits at the anchor position.' },
      safeArea: { type: 'boolean', tooltip: 'Add padding for device notch, Dynamic Island, and home indicator bar' },
      zIndex: { type: 'number', step: 1, tooltip: 'Stacking order. Higher values render on top' },
    },
  });
}
