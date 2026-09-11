/** Trait-spec builders for the "Create …" entities.
 *
 *  Extracted from Hierarchy.tsx's inline handlers so the Hierarchy context menus
 *  AND the agent op (engine/app/editor/agentEditorOps.ts → create-entity) build
 *  IDENTICAL entities — one source of truth, no drift. UI presets route through
 *  buildUiCreateSpecs (anchor-first authoring); everything else is here. Each
 *  builder returns the display `name` (used in both the label and EntityAttributes)
 *  plus the `specs` to hand to createEntityWithUndo.
 *
 *  Lives in `runtime/` (not `editor/`) since #166: the DEVICE `create-entity` op needs these
 *  builders, and the editor half of the package is stripped from a shipped game build. Nothing
 *  here touches the editor — it is pure spec construction. See
 *  docs/mcp-tool-conventions.md §9. */

import { buildUiCreateSpecs, type UiPreset } from '../ui/uiAuthoring';
import { hasDocKey } from '../core/docKeys';

/** One trait to put on a new entity. Defined HERE rather than in the editor's undo layer so both
 *  the undoable editor path and the undo-free runtime/device path name the same shape. */
export interface TraitSpec { name: string; data?: Record<string, unknown> }

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export type LightKind = 'ambient' | 'directional' | 'point' | 'spot';

const LIGHT_DEFAULTS: Record<LightKind, Record<string, unknown>> = {
  ambient: { lightType: 'ambient', color: 0xffffff, intensity: 0.3 },
  directional: { lightType: 'directional', color: 0xffffff, intensity: 1 },
  point: { lightType: 'point', color: 0xffffff, intensity: 1, distance: 10 },
  spot: { lightType: 'spot', color: 0xffffff, intensity: 1, distance: 10, angle: 0.5, penumbra: 0.2 },
};

export interface CreateSpecs { name: string; specs: TraitSpec[] }

export function emptySpecs(parentId: number): CreateSpecs {
  const name = 'New Entity';
  return { name, specs: [
    { name: 'Transform', data: {} },
    { name: 'EntityAttributes', data: { name, parentId } },
  ] };
}

export function primitiveSpecs(meshName: string, parentId: number): CreateSpecs {
  const name = cap(meshName);
  return { name, specs: [
    { name: 'Transform', data: {} },
    { name: 'EntityAttributes', data: { name, parentId, layer: '3d' } },
    { name: 'Renderable3DPrimitive', data: { mesh: meshName, size: 1, color: 0x888888, isVisible: true } },
  ] };
}

export function shape2DSpecs(shape: string, parentId: number): CreateSpecs {
  const name = `${cap(shape)} 2D`;
  return { name, specs: [
    { name: 'Transform', data: {} },
    { name: 'EntityAttributes', data: { name, parentId, layer: '2d' } },
    { name: 'Renderable2D', data: { sprite: shape, width: 20, height: 20, color: 0x3498db, isVisible: true } },
  ] };
}

/** A full-screen 2D canvas: the UI-layer host that Renderable2D children render into.
 *  Mirrors the hand-authored Canvas2D entities (RenderableUI + UIElement + UIAnchor +
 *  Canvas2D, layer 'ui'), stretched to fill its parent so 2D content covers the screen. */
export function canvas2DSpecs(parentId: number): CreateSpecs {
  const name = '2D Canvas';
  return { name, specs: [
    { name: 'EntityAttributes', data: { name, parentId, layer: 'ui' } },
    { name: 'RenderableUI', data: {} },
    { name: 'UIAnchor', data: { anchor: 'stretch', pivotX: 0, pivotY: 0 } },
    { name: 'UIElement', data: { width: 100, widthUnit: '%', height: 100, heightUnit: '%' } },
    { name: 'Canvas2D', data: {} },
  ] };
}

export function cameraSpecs(parentId: number): CreateSpecs {
  return { name: 'Camera', specs: [
    { name: 'Transform', data: { x: 0, y: 2, z: 10 } },
    { name: 'EntityAttributes', data: { name: 'Camera', parentId, layer: '3d' } },
    { name: 'Camera', data: {} },
  ] };
}

/** The valid `kind` values, DERIVED from the table rather than re-listed — same rule as
 *  `PRIMITIVE_NAMES` beside it and `COLLIDER_SHAPES` in particles/types.ts. */
export const LIGHT_KINDS = Object.keys(LIGHT_DEFAULTS) as ReadonlyArray<LightKind>;

/** ⚠️ `hasDocKey`, and a THROW rather than a fallback (#993). `kind` is `spec.light` off the
 *  `create-entity` agent payload, and `LIGHT_DEFAULTS` is a code-declared literal — so
 *  `light: "constructor"` handed the inherited FUNCTION to the `Light` trait's `data`, the op
 *  answered `{ok: true}`, and the entity spawned with no light fields at all.
 *
 *  Loud, because that is what the two sibling fields in this same payload already do:
 *  `agentEditorOps.ts` rejects an unknown `spec.mesh`/`spec.shape` by name. Throwing HERE rather
 *  than adding a third check beside those two means every caller of `buildEntityCreateSpecs` is
 *  covered, not only the op — and it runs before anything is created, so "nothing was created"
 *  stays true. */
function lightDefaults(kind: LightKind): Record<string, unknown> {
  if (!hasDocKey(LIGHT_DEFAULTS, kind)) {
    throw new Error(`create-entity: unknown light kind "${kind}" — nothing was created. Valid: ${LIGHT_KINDS.join(', ')}.`);
  }
  return LIGHT_DEFAULTS[kind];
}

export function lightSpecs(kind: LightKind, parentId: number): CreateSpecs {
  // ⚠️ Validate BEFORE `cap(kind)` (#993 close-out § 2d). `cap` is `s.charAt(0)…`, so
  // `{kind:'light'}` with no `light` field — the obvious agent payload — died with a raw
  // "Cannot read properties of undefined (reading 'charAt')" and never reached the message that
  // names the valid values. `uiSpecs` did not have this problem because it goes straight to its
  // own lookup.
  const data = lightDefaults(kind);
  const name = `${cap(kind)} Light`;
  return { name, specs: [
    { name: 'Transform', data: kind === 'directional' ? { x: 5, y: 10, z: 5 } : {} },
    { name: 'EntityAttributes', data: { name, parentId, layer: '3d' } },
    { name: 'Light', data },
  ] };
}

export function environmentSpecs(parentId: number): CreateSpecs {
  const name = 'HDR Environment';
  return { name, specs: [
    { name: 'EntityAttributes', data: { name, parentId } },
    // hdrPath is left empty — assign a .hdr in the Inspector (drag from Assets).
    { name: 'Environment', data: {} },
  ] };
}

export function particleSpecs(parentId: number): CreateSpecs {
  return { name: 'Particle', specs: [
    { name: 'Transform', data: {} },
    { name: 'EntityAttributes', data: { name: 'Particle', parentId, layer: '3d' } },
    // effect is left empty — assign a .particle.json in the Inspector (drag from Assets).
    { name: 'ParticleEmitter', data: {} },
  ] };
}

export function uiSpecs(preset: UiPreset, parentId: number): CreateSpecs {
  return buildUiCreateSpecs(preset, parentId);
}

/** Discriminated request used by the agent `create-entity` op (and a single
 *  snapshot test) to reach any of the builders above by name. */
export type CreateEntitySpec =
  | { kind: 'empty' }
  | { kind: 'primitive'; mesh: string }
  | { kind: '2d'; shape: string }
  | { kind: 'canvas2d' }
  | { kind: 'ui'; preset: UiPreset }
  | { kind: 'camera' }
  | { kind: 'light'; light: LightKind }
  | { kind: 'environment' }
  | { kind: 'particle' };

export function buildEntityCreateSpecs(spec: CreateEntitySpec, parentId: number): CreateSpecs {
  switch (spec.kind) {
    case 'empty': return emptySpecs(parentId);
    case 'primitive': return primitiveSpecs(spec.mesh, parentId);
    case '2d': return shape2DSpecs(spec.shape, parentId);
    case 'canvas2d': return canvas2DSpecs(parentId);
    case 'ui': return uiSpecs(spec.preset, parentId);
    case 'camera': return cameraSpecs(parentId);
    case 'light': return lightSpecs(spec.light, parentId);
    case 'environment': return environmentSpecs(parentId);
    case 'particle': return particleSpecs(parentId);
  }
}
