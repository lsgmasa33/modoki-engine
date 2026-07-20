/** Trait-spec builders for the "Create …" entities.
 *
 *  Extracted from Hierarchy.tsx's inline handlers so the Hierarchy context menus
 *  AND the agent op (engine/app/editor/agentEditorOps.ts → create-entity) build
 *  IDENTICAL entities — one source of truth, no drift. UI presets route through
 *  buildUiCreateSpecs (anchor-first authoring); everything else is here. Each
 *  builder returns the display `name` (used in both the label and EntityAttributes)
 *  plus the `specs` to hand to createEntityWithUndo. */

import type { TraitSpec } from './undo/entityActions';
import { buildUiCreateSpecs, type UiPreset } from './uiAuthoring';

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

export function lightSpecs(kind: LightKind, parentId: number): CreateSpecs {
  const name = `${cap(kind)} Light`;
  return { name, specs: [
    { name: 'Transform', data: kind === 'directional' ? { x: 5, y: 10, z: 5 } : {} },
    { name: 'EntityAttributes', data: { name, parentId, layer: '3d' } },
    { name: 'Light', data: LIGHT_DEFAULTS[kind] },
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
