/** buildPrefabEditScene turns a prefab into an isolated, *visible* synthetic
 *  scene: the prefab's entities become plain scene entities (localId → id), the
 *  root is stamped with the sentinel guid the save path looks up, and throwaway
 *  lights + an HDR environment are appended so the prefab renders. */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildPrefabEditScene, PREFAB_EDIT_ROOT_GUID, PREFAB_EDIT_HDR_GUID, SCAFFOLD_PREFIX,
} from '../../src/editor/scene/prefabEdit';
import { registerAsset, clearManifest } from '../../src/runtime/loaders/assetManifest';
import type { SceneData } from '../../src/runtime/loaders/loadSceneFile';
import type { PrefabFile } from '../../src/editor/scene/prefab';

const MESH = 'aaaaaaaa-0000-4000-8000-000000000001';
const MAT = 'aaaaaaaa-0000-4000-8000-000000000002';

const prefab: PrefabFile = {
  id: 'aaaaaaaa-0000-4000-8000-0000000000ff',
  version: 1,
  name: 'Ship',
  rootLocalId: 1,
  entities: [
    { localId: 1, name: 'Ship', traits: { EntityAttributes: { name: 'Ship', parentId: 0, guid: '' } } },
    {
      localId: 2, name: 'Hull',
      traits: {
        EntityAttributes: { name: 'Hull', parentId: 1, guid: '' },
        Renderable3D: { mesh: MESH, material: MAT, isActive: true },
      },
    },
  ],
};

describe('buildPrefabEditScene', () => {
  // The HDR scaffold is only added when its guid resolves in the manifest, so register
  // it here (as a project that ships the HDR would). The absent case is covered below.
  let scene: SceneData;
  beforeAll(() => {
    clearManifest();
    registerAsset(PREFAB_EDIT_HDR_GUID, '/assets/hdr/prefab-edit.hdr', 'environment');
    scene = buildPrefabEditScene(prefab);
  });

  it('maps each prefab entity to a scene entity (id = localId) plus 3 scaffolds', () => {
    expect(scene.entities).toHaveLength(2 + 3);
    expect(scene.entities.find((e) => e.id === 1)?.name).toBe('Ship');
    expect(scene.entities.find((e) => e.id === 2)?.name).toBe('Hull');
    const scaffolds = scene.entities.filter((e) => (e.name || '').startsWith(SCAFFOLD_PREFIX));
    expect(scaffolds).toHaveLength(3);
  });

  it('stamps the sentinel guid on the root only (so save can locate it)', () => {
    const root = scene.entities.find((e) => e.id === 1)!;
    const hull = scene.entities.find((e) => e.id === 2)!;
    expect((root.traits.EntityAttributes as Record<string, unknown>).guid).toBe(PREFAB_EDIT_ROOT_GUID);
    expect((hull.traits.EntityAttributes as Record<string, unknown>).guid).toBe('');
  });

  it('does NOT mutate the source prefab (root guid stays empty in the file)', () => {
    expect((prefab.entities[0].traits.EntityAttributes as Record<string, unknown>).guid).toBe('');
  });

  it('provides scaffold lighting: a directional key light, an ambient, and an HDR env', () => {
    const lights = scene.entities.filter((e) => e.traits.Light);
    const types = lights.map((e) => (e.traits.Light as Record<string, unknown>).lightType).sort();
    expect(types).toEqual(['ambient', 'directional']);
    const env = scene.entities.find((e) => e.traits.Environment);
    expect((env!.traits.Environment as Record<string, unknown>).hdrPath).toBe(PREFAB_EDIT_HDR_GUID);
  });

  it('collects the prefab mesh/material + scaffold HDR as scene resources', () => {
    const refs = new Set(scene.resources!.map((r) => `${r.type}:${r.path}`));
    expect(refs.has(`mesh:${MESH}`)).toBe(true);
    expect(refs.has(`material:${MAT}`)).toBe(true);
    expect(refs.has(`environment:${PREFAB_EDIT_HDR_GUID}`)).toBe(true);
  });
});

describe('buildPrefabEditScene — HDR guid not in the manifest', () => {
  // The engine can't assume every project ships the scaffold HDR. When the guid does
  // not resolve, the HDR entity is omitted (no "[MeshCache] Unknown asset guid" warning);
  // KeyLight + Ambient still light the preview.
  let scene: SceneData;
  beforeAll(() => {
    clearManifest(); // PREFAB_EDIT_HDR_GUID unregistered
    scene = buildPrefabEditScene(prefab);
  });

  it('omits the HDR scaffold — only the two lights remain', () => {
    const scaffolds = scene.entities.filter((e) => (e.name || '').startsWith(SCAFFOLD_PREFIX));
    expect(scaffolds).toHaveLength(2);
    const lights = scene.entities.filter((e) => e.traits.Light);
    expect(lights).toHaveLength(2);
    expect(scene.entities.find((e) => e.traits.Environment)).toBeUndefined();
  });

  it('does not list the HDR as a scene resource', () => {
    expect(scene.resources!.some((r) => r.type === 'environment')).toBe(false);
  });
});
