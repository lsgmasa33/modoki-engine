/** collectResourceRefs unit tests — resource extraction, deduplication, sorting. */

import { describe, it, expect } from 'vitest';
import type { SerializedEntity } from '../../../src/editor/scene/serialize';

async function getModule() {
  return import('../../../src/editor/scene/serialize');
}

function entity(name: string, traits: Record<string, Record<string, unknown> | boolean>, extra: Partial<SerializedEntity> = {}): SerializedEntity {
  return { id: 1, name, traits, ...extra };
}

describe('collectResourceRefs', () => {
  // References are GUID-only — fixtures use GUIDs (the collector stores the ref
  // verbatim, so the collected `path` is the GUID).
  const MESH_GUID = 'a0000000-0000-4000-8000-000000000001';
  const MAT_GUID = 'a0000000-0000-4000-8000-000000000002';
  const PRIM_MAT_GUID = 'a0000000-0000-4000-8000-000000000003';
  const SPRITE_GUID = 'a0000000-0000-4000-8000-000000000004';
  const IMG_GUID = 'a0000000-0000-4000-8000-000000000005';
  const MODEL_GUID = 'a0000000-0000-4000-8000-000000000010';
  const PREFAB_GUID = 'a0000000-0000-4000-8000-000000000011';
  const ENV_GUID = 'a0000000-0000-4000-8000-000000000012';

  it('extracts mesh refs from Renderable3D', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('hero', { Renderable3D: { mesh: MESH_GUID, material: '' } }),
    ]);
    expect(refs).toContainEqual({ type: 'mesh', path: MESH_GUID });
  });

  it('extracts material refs from Renderable3D', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('hero', { Renderable3D: { mesh: '', material: MAT_GUID } }),
    ]);
    expect(refs).toContainEqual({ type: 'material', path: MAT_GUID });
  });

  it('extracts material refs from Renderable3DPrimitive', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('prim', { Renderable3DPrimitive: { material: PRIM_MAT_GUID } }),
    ]);
    // Unregistered GUID → defaults to 'material'.
    expect(refs).toContainEqual({ type: 'material', path: PRIM_MAT_GUID });
  });

  it('collects a Renderable3DPrimitive material as TEXTURE when the GUID is a texture asset', async () => {
    // A primitive textured directly with a raw texture GUID must be collected
    // under 'texture' (else the material pipeline drops it and it never loads).
    const manifest = await import('../../../src/runtime/loaders/assetManifest');
    const TEX_GUID = 'a0000000-0000-4000-8000-0000000000aa';
    manifest.registerAsset(TEX_GUID, '/games/x/assets/textures/wood.png', 'texture');
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('prim', { Renderable3DPrimitive: { material: TEX_GUID } }),
    ]);
    expect(refs).toContainEqual({ type: 'texture', path: TEX_GUID });
    expect(refs).not.toContainEqual({ type: 'material', path: TEX_GUID });
  });

  it('extracts sprite (texture) refs from Renderable2D by GUID', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('sprite', { Renderable2D: { sprite: SPRITE_GUID } }),
    ]);
    expect(refs).toContainEqual({ type: 'texture', path: SPRITE_GUID });
  });

  it('extracts sprite refs from Renderable2D starting with http', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('sprite', { Renderable2D: { sprite: 'https://cdn.example.com/tile.png' } }),
    ]);
    expect(refs).toContainEqual({ type: 'texture', path: 'https://cdn.example.com/tile.png' });
  });

  it('ignores Renderable2D sprites that are primitive keywords', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('shape', { Renderable2D: { sprite: 'circle' } }),
    ]);
    expect(refs).toHaveLength(0);
  });

  it('extracts font refs from UIElement', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('label', { UIElement: { fontFamily: 'Roboto', imageSrc: '' } }),
    ]);
    expect(refs).toContainEqual({ type: 'font', path: 'Roboto' });
  });

  it('extracts image refs from UIElement', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('btn', { UIElement: { fontFamily: '', imageSrc: IMG_GUID } }),
    ]);
    expect(refs).toContainEqual({ type: 'texture', path: IMG_GUID });
  });

  it('extracts model refs from ModelSource with postprocessor', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('island', { ModelSource: { glbPath: MODEL_GUID, postprocessor: 'tropical-island' } }),
    ]);
    expect(refs).toContainEqual({ type: 'model', path: MODEL_GUID, postprocessor: 'tropical-island' });
  });

  it('falls back to "none" when ModelSource.postprocessor is empty', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('model', { ModelSource: { glbPath: MODEL_GUID, postprocessor: '' } }),
    ]);
    expect(refs).toContainEqual({ type: 'model', path: MODEL_GUID, postprocessor: 'none' });
  });

  it('extracts prefab refs from PrefabInstance trait', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('tree', { PrefabInstance: { source: PREFAB_GUID } }),
    ]);
    expect(refs).toContainEqual({ type: 'prefab', path: PREFAB_GUID });
  });

  it('extracts prefab refs from entry.prefab field', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('tree', {}, { prefab: PREFAB_GUID }),
    ]);
    expect(refs).toContainEqual({ type: 'prefab', path: PREFAB_GUID });
  });

  it('extracts environment refs from Environment.hdrPath', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('env', { Environment: { hdrPath: ENV_GUID } }),
    ]);
    expect(refs).toContainEqual({ type: 'environment', path: ENV_GUID });
  });

  it('skips a literal (non-GUID) ModelSource.glbPath', async () => {
    // Regression: glbPath must be a GUID; a literal path must never be baked
    // into resources[] (the loader's resolveRef rejects internal asset paths).
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('island', { ModelSource: { glbPath: '/games/x/assets/island.glb', postprocessor: 'none' } }),
    ]);
    expect(refs).toHaveLength(0);
  });

  it('extracts animation clip refs from the Animator.clips bank by GUID', async () => {
    const { collectResourceRefs } = await getModule();
    const CLIP_GUID = 'a0000000-0000-4000-8000-0000000000c1';
    const CLIP_GUID2 = 'a0000000-0000-4000-8000-0000000000c2';
    const refs = collectResourceRefs([
      // New shape: GUIDs live inside the JSON-string clips bank; every entry is collected.
      entity('rig', {
        Animator: {
          clips: JSON.stringify([{ name: 'idle', clip: CLIP_GUID }, { name: 'walk', clip: CLIP_GUID2 }]),
          clip: 'idle', time: 0, speed: 1, playing: true, loop: true,
        },
      }),
    ]);
    expect(refs).toContainEqual({ type: 'animation', path: CLIP_GUID });
    expect(refs).toContainEqual({ type: 'animation', path: CLIP_GUID2 });
  });

  it('ignores an empty Animator.clips bank', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('rig', { Animator: { clips: '[]', clip: '', time: 0 } }),
    ]);
    expect(refs).toHaveLength(0);
  });

  it('extracts the scalar AudioSource.clip by GUID', async () => {
    const { collectResourceRefs } = await getModule();
    const CLIP_GUID = 'a0000000-0000-4000-8000-0000000000a1';
    const refs = collectResourceRefs([
      entity('src', { AudioSource: { clip: CLIP_GUID, bus: 'music' } }),
    ]);
    expect(refs).toContainEqual({ type: 'audio', path: CLIP_GUID });
  });

  it('extracts every AudioSource.clips bank ref (the JSON-string key→GUID table)', async () => {
    // The whole point of the named bank: clips referenced only by key from
    // UIAction params still SHIP because their GUIDs live in the trait's JSON-string
    // bank, so the collector parses + picks them up (they survive an editor save;
    // UIAction params do not).
    const { collectResourceRefs } = await getModule();
    const A = 'a0000000-0000-4000-8000-0000000000b1';
    const B = 'a0000000-0000-4000-8000-0000000000b2';
    const C = 'a0000000-0000-4000-8000-0000000000b3';
    const refs = collectResourceRefs([
      entity('bank', { AudioSource: { clip: '', bus: 'sfx', clips: JSON.stringify([
        { key: 'click', ref: A }, { key: 'confirm', ref: B }, { key: 'select', ref: C },
      ]) } }),
    ]);
    expect(refs).toContainEqual({ type: 'audio', path: A });
    expect(refs).toContainEqual({ type: 'audio', path: B });
    expect(refs).toContainEqual({ type: 'audio', path: C });
  });

  it('ignores an empty / malformed AudioSource.clips bank string', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('a', { AudioSource: { clip: '', clips: '' } }),           // empty
      entity('b', { AudioSource: { clip: '', clips: 'not json {' } }), // malformed → []
      entity('c', { AudioSource: { clip: '', clips: JSON.stringify([{ key: 'x', ref: '' }]) } }), // blank ref
    ]);
    expect(refs).toHaveLength(0);
  });

  it('deduplicates refs with same type and path', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('a', { Renderable3D: { mesh: MESH_GUID, material: '' } }),
      entity('b', { Renderable3D: { mesh: MESH_GUID, material: '' } }),
    ]);
    const meshRefs = refs.filter(r => r.path === MESH_GUID);
    expect(meshRefs).toHaveLength(1);
  });

  it('sorts output by type then path', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('a', { Renderable3D: { mesh: '/z.mesh.json', material: '/b.mat.json' } }),
      entity('b', { Environment: { hdrPath: '/sky.hdr' } }),
      entity('c', { Renderable3D: { mesh: '/a.mesh.json', material: '' } }),
    ]);
    const types = refs.map(r => r.type);
    const sorted = [...types].sort();
    expect(types).toEqual(sorted);
  });

  it('skips empty paths', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('empty', { Renderable3D: { mesh: '', material: '' } }),
    ]);
    expect(refs).toHaveLength(0);
  });

  it('skips boolean trait values (tags)', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('tagged', { Renderable3D: true as unknown as Record<string, unknown> }),
    ]);
    expect(refs).toHaveLength(0);
  });

  it('returns empty array for no entities', async () => {
    const { collectResourceRefs } = await getModule();
    expect(collectResourceRefs([])).toEqual([]);
  });

  it('handles multiple resource types on one entity', async () => {
    const { collectResourceRefs } = await getModule();
    const refs = collectResourceRefs([
      entity('complex', {
        Renderable3D: { mesh: MESH_GUID, material: MAT_GUID },
        UIElement: { fontFamily: 'Roboto', imageSrc: IMG_GUID },
      }),
    ]);
    expect(refs).toHaveLength(4);
  });
});
