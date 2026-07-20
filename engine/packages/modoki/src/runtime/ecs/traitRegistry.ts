/** Trait Registry — editor-facing metadata for ECS traits.
 *  Games register their traits here so the editor can auto-generate
 *  Inspector fields, serialize generically, and discover entities. */

import type { Trait } from 'koota';

export type FieldType = 'number' | 'string' | 'boolean' | 'color' | 'enum' | 'entityRef' | 'bindings' | 'materialOverrides';

export interface FieldHint {
  type: FieldType;
  step?: number;
  min?: number;
  max?: number;
  options?: string[];   // for enum/dropdown (static list)
  /** Named provider for DYNAMIC enum options resolved at inspector-render time:
   *  - 'uiActions'      → registered UIAction names (global)
   *  - 'animationClips' → clip names from THIS entity's SkinnedModel GLB (per-entity)
   *  - 'skeletonBones'  → bone names from the entity referenced by THIS entity's
   *                       BoneAttachment.target (per-entity)
   *  Stays a string so the field schema remains JSON/structured-clone safe when
   *  pushed to the validator. */
  optionsSource?: 'uiActions' | 'animationClips' | 'skeletonBones' | 'physicsLayers';
  readOnly?: boolean;
  /** Pure runtime state — recomputed every frame by the trait's system (e.g.
   *  Time.elapsed/frame). Excluded from scene serialization so a save doesn't
   *  bake a transient snapshot or churn the file every time; the loader/system
   *  re-derives it from the schema default. Independent of `readOnly` (a field
   *  can be read-only in the Inspector yet still authored/persisted). */
  runtimeOnly?: boolean;
  /** For a `color` field: the name of a sibling 0..1 number field that holds its
   *  alpha. The Inspector folds that field into the color picker as an A slider and
   *  hides it as a standalone row (e.g. UIElement.backgroundColor ↔ backgroundOpacity). */
  alphaField?: string;
  group?: string;       // fields with the same group render as Vec2/Vec3
  label?: string;       // explicit sub-label inside a VecField group (else derived from key by stripping the common prefix)
  display?: 'degrees';  // convert radians→degrees for display, degrees→radians on write
  accept?: string[];    // accepted file extensions for drag-drop (e.g. ['.mat.json', '.mesh.json'])
  /** For an asset-ref field (one with `accept`): the id of a registered editor panel
   *  that edits this asset kind. The Inspector renders an "Open" button on the field
   *  that selects the referenced asset AND docks/focuses that panel — the affordance
   *  that lets e.g. a FieldSource.level field jump straight into the game's Field
   *  Editor. Just a string (JSON/structured-clone safe, no editor import), so it can
   *  be declared from runtime trait registration. */
  editorPanel?: string;
  multiline?: boolean;  // string field renders as a resizable textarea (Enter inserts a newline)
  tooltip?: string;     // hover tooltip text for the field label
  showWhen?: Record<string, string[]>;  // field visible only when another field's value is in the list
  section?: string;     // collapsible sub-section within the trait (distinct from group which renders as VecField)
  sectionDefaultOpen?: boolean;  // whether this section starts expanded (default true)
  sectionDivider?: boolean;      // render a horizontal divider above this section
}

export interface TraitMeta {
  name: string;
  trait: Trait;
  category: 'component' | 'resource' | 'tag';
  fields: Record<string, FieldHint>;
  role?: 'camera';      // special roles the editor can key off
  priority?: number;    // lower = shown first in Inspector (default 100)
  /** UI grouping label for the Inspector "Add Component" dropdown
   *  (e.g. 'Rendering', 'UI', 'Lighting'). Distinct from the structural
   *  `category` above. Defaults to 'Misc' when omitted. */
  componentCategory?: string;
}

/** Fixed display order for `componentCategory` groupings — shared by the Inspector
 *  "Add Component" menu and the Hierarchy "Type ▾" filter so the two never drift.
 *  Categories not listed here sort alphabetically after these. */
export const COMPONENT_CATEGORY_ORDER = ['Transform', 'Rendering', 'Lighting', 'Camera', 'UI', 'Animation', 'Physics', 'Gameplay', 'Misc'];

// ── Entity display name transform (game-specific) ──────

let nameTransformFn: ((name: string) => string) | null = null;

export function setNameTransform(fn: (name: string) => string) {
  nameTransformFn = fn;
}

export function transformName(name: string): string {
  return nameTransformFn ? nameTransformFn(name) : name;
}

// ── Registry ────────────────────────────────────────────

const registry = new Map<Trait, TraitMeta>();
const byName = new Map<string, TraitMeta>();

export function registerTrait(meta: TraitMeta) {
  // On re-registration (script hot-reload re-imports a trait module → a NEW koota
  // Trait object with the SAME name), evict the prior object first. The registry
  // is keyed by Trait object, so without this getAllTraits() would accumulate
  // duplicate metas — one of them a stale, orphaned Trait — corrupting
  // serialization, the persistent-entity snapshot, and the Inspector.
  const prev = byName.get(meta.name);
  if (prev && prev.trait !== meta.trait) registry.delete(prev.trait);
  registry.set(meta.trait, meta);
  byName.set(meta.name, meta);
}

export function getTraitMeta(trait: Trait): TraitMeta | undefined {
  return registry.get(trait);
}

export function getTraitByName(name: string): TraitMeta | undefined {
  return byName.get(name);
}

export function getAllTraits(): TraitMeta[] {
  return Array.from(registry.values());
}

// ── Auto-inference from trait schema defaults ───────────

/** Infer editor field hints (type + default) from a koota trait's schema. PUBLIC API
 *  by design — exported from `@modoki/engine/runtime` for downstream game/editor tooling
 *  to introspect a trait without the engine pre-registering metadata. It intentionally
 *  has no internal callers (registration supplies explicit `meta.fields`); covered by
 *  `traitRegistry.test.ts`. Keep it on the public barrel. (ecs-core F9) */
export function inferFields(trait: Trait): Record<string, FieldHint> {
  const schema = (trait as any).schema;
  if (!schema || typeof schema !== 'object') return {};

  const fields: Record<string, FieldHint> = {};
  for (const [key, val] of Object.entries(schema)) {
    if (typeof val === 'number') {
      fields[key] = { type: 'number', step: 0.1 };
    } else if (typeof val === 'string') {
      fields[key] = { type: 'string' };
    } else if (typeof val === 'boolean') {
      fields[key] = { type: 'boolean' };
    }
  }
  return fields;
}
