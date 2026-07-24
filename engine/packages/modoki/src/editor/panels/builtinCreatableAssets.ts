/** The engine's own "Create X" entries for the Assets panel, registered through the
 *  creatable-asset registry (creatableAssets.ts). `order` 0..7 matches the create menu's
 *  historical hardcoded order (Scene, Material, Animation, Animset, Sprite Animation,
 *  2D Rig, Particle, Atlas) — kept stable so existing muscle memory doesn't move.
 *
 *  Called once from `createEditor()`; idempotent (registerCreatableAsset replaces by
 *  id), so a second call — e.g. a second `createEditor()` in the same session — is safe. */

import { registerCreatableAsset } from './creatableAssets';
import { defaultAnimationClip } from '../../runtime/animation/types';
import { defaultParticleEffect } from '../../runtime/particles/types';
import { defaultAssetData } from '../../runtime/assets/assetSchemas';
import { findEntity } from '../../runtime/ecs/entityUtils';
import { getTraitByName } from '../../runtime/ecs/traitRegistry';
import { newScene, saveScene, setCurrentScenePath } from '../scene/serialize';
import { useEditorStore } from '../store/editorStore';

export function registerBuiltinCreatableAssets(): void {
  registerCreatableAsset({
    id: 'scene',
    label: 'Create Scene',
    ext: '.json',
    defaultName: 'New Scene',
    assetType: 'scene',
    prompt: 'Create Scene',
    defaultFolder: '/assets/scenes',
    order: 0,
    // Full override: default content (Camera + white-HDR Environment) comes from
    // newScene(), persisted via saveScene() — this replaces the old File → New Scene
    // flow. Dialog first so a cancel leaves the current world untouched.
    create: async (path) => {
      newScene();
      useEditorStore.getState().selectEntity(null);
      setCurrentScenePath(path);
      await saveScene();
    },
  });

  registerCreatableAsset({
    id: 'material',
    label: 'Create Material',
    ext: '.mat.json',
    defaultName: 'New Material',
    assetType: 'material',
    prompt: 'Create Material',
    order: 1,
    // `id` first so a fresh guid is stamped even though defaultMaterial() has no id.
    body: (guid) => ({ id: guid, ...(defaultAssetData('material') as Record<string, unknown>) }),
    onCreated: ({ path, name }) => useEditorStore.getState().selectAsset({ path, type: 'material', name }),
  });

  registerCreatableAsset({
    id: 'animation',
    label: 'Create Animation',
    ext: '.anim.json',
    defaultName: 'New Animation',
    assetType: 'animation',
    prompt: 'Create Animation Clip',
    order: 2,
    body: (guid, name) => defaultAnimationClip(guid, name),
    // Open immediately, bound to the currently-selected Animator entity if any.
    onCreated: ({ path, name }) => {
      const animMeta = getTraitByName('Animator');
      const sel = useEditorStore.getState().selectedEntityId;
      const ent = sel != null ? findEntity(sel) : null;
      const rootId = ent && animMeta && ent.has(animMeta.trait) ? sel : null;
      useEditorStore.getState().openAnimationEditor({ path, type: 'animation', name }, rootId);
    },
  });

  registerCreatableAsset({
    id: 'animset',
    label: 'Create Animset',
    ext: '.animset.json',
    defaultName: 'New Animset',
    assetType: 'animset',
    prompt: 'Create Animset',
    order: 3,
    body: (guid) => ({ id: guid, clips: [] }),
    onCreated: ({ path, name }) => useEditorStore.getState().selectAsset({ path, type: 'animset', name }),
  });

  registerCreatableAsset({
    id: 'spriteanim',
    label: 'Create Sprite Animation',
    ext: '.spriteanim.json',
    defaultName: 'New Sprite Animation',
    assetType: 'spriteanim',
    prompt: 'Create Sprite Animation',
    order: 4,
    body: (guid) => ({ id: guid, ...(defaultAssetData('spriteanim') as Record<string, unknown>) }),
    onCreated: ({ path, name }) => useEditorStore.getState().openSpriteAnimEditor({ path, type: 'spriteanim', name }),
  });

  registerCreatableAsset({
    id: 'rig2d',
    label: 'Create 2D Rig',
    ext: '.rig2d.json',
    defaultName: 'New Rig',
    assetType: 'rig2d',
    prompt: 'Create 2D Rig',
    order: 5,
    // Seeds a single `root` bone + empty mesh (same minimal shape as the Skin Editor's
    // own "New Rig").
    body: (guid) => ({
      id: guid, sprite: '', bones: [{ name: 'root', parent: -1, x: 0, y: 0, rot: 0 }],
      mesh: { verts: [], uvs: [], tris: [] }, skinIndices: [], skinWeights: [],
    }),
    onCreated: ({ path, name }) => useEditorStore.getState().openSkinEditor({ path, type: 'rig2d', name }),
  });

  registerCreatableAsset({
    id: 'particle',
    label: 'Create Particle',
    ext: '.particle.json',
    defaultName: 'New Particle',
    assetType: 'particle',
    prompt: 'Create Particle Effect',
    order: 6,
    body: (guid) => ({ ...defaultParticleEffect(), id: guid }),
    onCreated: ({ path, name }) => useEditorStore.getState().openParticleEditor({ path, type: 'particle', name }),
  });

  registerCreatableAsset({
    id: 'atlas',
    label: 'Create Atlas',
    ext: '.atlas.json',
    defaultName: 'New Atlas',
    assetType: 'atlas',
    prompt: 'Create Sprite Atlas',
    order: 7,
    body: (guid) => ({ id: guid, version: 1, members: [], pageSize: 1024, padding: 2, extrude: 1 }),
    onCreated: ({ path, name }) => useEditorStore.getState().selectAsset({ path, type: 'atlas', name }),
  });
}
