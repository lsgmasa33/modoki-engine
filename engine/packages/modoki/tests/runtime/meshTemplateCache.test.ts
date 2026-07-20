/** meshTemplateCache unit tests — synchronous cache lookups on an empty/fresh cache. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Reset module cache before each test so the caches are fresh
beforeEach(() => {
  vi.resetModules();
});

async function getCache() {
  return import('../../../src/runtime/loaders/meshTemplateCache');
}

describe('meshTemplateCache', () => {
  describe('resolveMeshTemplate', () => {
    it('returns undefined for an unknown legacy sprite key', async () => {
      const { resolveMeshTemplate } = await getCache();
      expect(resolveMeshTemplate('island/nonexistent')).toBeUndefined();
    });

    it('returns undefined for an unknown .mesh.json path (triggers async fetch)', async () => {
      // fetch will fail in node but resolveMeshTemplate returns undefined synchronously
      const { resolveMeshTemplate } = await getCache();
      expect(resolveMeshTemplate('models/foo.mesh.json')).toBeUndefined();
    });
  });

  describe('resolveMaterial', () => {
    it('returns undefined for an unknown material ref', async () => {
      const { resolveMaterial } = await getCache();
      expect(resolveMaterial('materials/unknown.mat.json')).toBeUndefined();
    });

    it('returns undefined for empty string', async () => {
      const { resolveMaterial } = await getCache();
      expect(resolveMaterial('')).toBeUndefined();
    });

    it('returns undefined for non-.mat.json path', async () => {
      const { resolveMaterial } = await getCache();
      expect(resolveMaterial('texture.png')).toBeUndefined();
    });
  });

  describe('resolveMaterialForMesh', () => {
    it('returns undefined when no explicit material and no mesh asset', async () => {
      const { resolveMaterialForMesh } = await getCache();
      expect(resolveMaterialForMesh('', '')).toBeUndefined();
    });

    it('returns undefined for unknown explicit material path', async () => {
      const { resolveMaterialForMesh } = await getCache();
      expect(resolveMaterialForMesh('materials/missing.mat.json', '')).toBeUndefined();
    });

    it('returns undefined for unknown mesh ref with material field', async () => {
      const { resolveMaterialForMesh } = await getCache();
      expect(resolveMaterialForMesh('', 'models/missing.mesh.json')).toBeUndefined();
    });
  });

  describe('registerRuntimeMeshTemplate (Phase 6a — runtime-mesh hook)', () => {
    // A hand-built unit quad (2 tris) — stands in for a procedurally-generated field mesh.
    async function makeQuad() {
      const THREE = await import('three');
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(
        [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      return { THREE, g };
    }

    it('resolves a runtime-registered geometry via its synthetic legacy key', async () => {
      const { THREE, g } = await makeQuad();
      const { registerRuntimeMeshTemplate, resolveMeshTemplate, meshStatsFromTemplate } = await getCache();
      const mat = new THREE.MeshStandardMaterial();
      registerRuntimeMeshTemplate('sling:field:test', g, mat);

      const tmpl = resolveMeshTemplate('sling:field:test');
      expect(tmpl).toBeDefined();
      expect(tmpl!.geometry).toBe(g);
      expect(tmpl!.material).toBe(mat);
      // The renderer draws template.geometry directly, so the counts must survive.
      expect(meshStatsFromTemplate(tmpl!)).toMatchObject({ vertices: 4, triangles: 2 });
    });

    it('unregister removes the entry (and disposes the geometry)', async () => {
      const { THREE, g } = await makeQuad();
      const { registerRuntimeMeshTemplate, unregisterRuntimeMeshTemplate, resolveMeshTemplate } = await getCache();
      const disposed = vi.spyOn(g, 'dispose');
      registerRuntimeMeshTemplate('sling:field:test', g, new THREE.MeshStandardMaterial());
      unregisterRuntimeMeshTemplate('sling:field:test');
      expect(resolveMeshTemplate('sling:field:test')).toBeUndefined();
      expect(disposed).toHaveBeenCalled();
    });

    it('re-registering the same key disposes the previous geometry (idempotent rebuild)', async () => {
      const { THREE, g } = await makeQuad();
      const { registerRuntimeMeshTemplate, resolveMeshTemplate } = await getCache();
      const disposed = vi.spyOn(g, 'dispose');
      registerRuntimeMeshTemplate('sling:field:test', g, new THREE.MeshStandardMaterial());
      const g2 = new THREE.BufferGeometry();
      registerRuntimeMeshTemplate('sling:field:test', g2, new THREE.MeshStandardMaterial());
      expect(disposed).toHaveBeenCalled(); // old geometry freed
      expect(resolveMeshTemplate('sling:field:test')!.geometry).toBe(g2);
    });

    it('rejects a GUID or *.mesh.json key (would not route through the legacy-key path)', async () => {
      const { THREE, g } = await makeQuad();
      const { registerRuntimeMeshTemplate, resolveMeshTemplate } = await getCache();
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      registerRuntimeMeshTemplate('models/foo.mesh.json', g, new THREE.MeshStandardMaterial());
      registerRuntimeMeshTemplate('1543405a-60a4-4e6d-a357-8e5ee335cc2d', g, new THREE.MeshStandardMaterial());
      expect(err).toHaveBeenCalledTimes(2);
      expect(resolveMeshTemplate('models/foo.mesh.json')).toBeUndefined();
      err.mockRestore();
    });
  });

  describe('getTemplatesForModel', () => {
    it('returns empty map for unknown model path', async () => {
      const { getTemplatesForModel } = await getCache();
      const result = getTemplatesForModel('/models/nonexistent.glb');
      expect(result.size).toBe(0);
    });
  });

  describe('deriveTemplateName', () => {
    it('uses mesh.name when userData.name is set (gltf-transform: real authored name on the leaf)', async () => {
      const THREE = await import('three');
      const { deriveTemplateName } = await getCache();
      const model = new THREE.Group();
      const mesh = new THREE.Mesh();
      mesh.name = 'Plane173';
      mesh.userData.name = 'Plane.173'; // THREE's signal that the name is real
      model.add(mesh);
      expect(deriveTemplateName(mesh, model, 0)).toBe('Plane173');
    });

    it('walks up to the nearest userData-named ancestor when mesh has a synthetic name (gltfpack)', async () => {
      const THREE = await import('three');
      const { deriveTemplateName } = await getCache();
      const model = new THREE.Group();
      // gltfpack pattern: named parent "Plane173" (userData set) -> unnamed
      // dequant carrier -> leaf with THREE-synthesized "mesh_0" name
      const parent = new THREE.Group();
      parent.name = 'Plane173';
      parent.userData.name = 'Plane.173';
      const dequantCarrier = new THREE.Group(); // no name, no userData
      const leaf = new THREE.Mesh();
      leaf.name = 'mesh_0'; // synthetic — userData.name NOT set
      model.add(parent);
      parent.add(dequantCarrier);
      dequantCarrier.add(leaf);
      expect(deriveTemplateName(leaf, model, 0)).toBe('Plane173');
    });

    it('skips the model root when walking — only inner ancestors count', async () => {
      const THREE = await import('three');
      const { deriveTemplateName } = await getCache();
      const model = new THREE.Group();
      model.name = 'ModelRoot';
      model.userData.name = 'ModelRoot'; // would shadow everything if the walk didn't stop
      const leaf = new THREE.Mesh();
      leaf.name = 'mesh_7'; // synthetic
      model.add(leaf);
      expect(deriveTemplateName(leaf, model, 7)).toBe('mesh_7');
    });

    it('falls back to mesh_<idx> when no ancestor has a userData-real name', async () => {
      const THREE = await import('three');
      const { deriveTemplateName } = await getCache();
      const model = new THREE.Group();
      const a = new THREE.Group(); a.name = 'a'; // .name set but userData.name NOT — synthetic
      const b = new THREE.Group();
      const leaf = new THREE.Mesh();
      leaf.name = 'mesh_3';
      model.add(a); a.add(b); b.add(leaf);
      expect(deriveTemplateName(leaf, model, 3)).toBe('mesh_3');
    });
  });

  describe('getMeshTemplate', () => {
    it('returns undefined for unknown key', async () => {
      const { getMeshTemplate } = await getCache();
      expect(getMeshTemplate('island/rock')).toBeUndefined();
    });

    it('returns undefined for empty key', async () => {
      const { getMeshTemplate } = await getCache();
      expect(getMeshTemplate('')).toBeUndefined();
    });
  });

  describe('disposeAllCachedResources', () => {
    it('does not throw on empty cache', async () => {
      const { disposeAllCachedResources } = await getCache();
      expect(() => disposeAllCachedResources()).not.toThrow();
    });

    it('can be called multiple times safely', async () => {
      const { disposeAllCachedResources } = await getCache();
      disposeAllCachedResources();
      disposeAllCachedResources();
      // No assertion needed — just verifying no crash
    });
  });

  describe('invalidateModel', () => {
    it('does not throw for unknown model path', async () => {
      const { invalidateModel } = await getCache();
      expect(() => invalidateModel('/models/nonexistent.glb')).not.toThrow();
    });
  });

  describe('invalidateMaterial', () => {
    it('does not throw for unknown material path', async () => {
      const { invalidateMaterial } = await getCache();
      expect(() => invalidateMaterial('materials/unknown.mat.json')).not.toThrow();
    });

    it('can be called multiple times for the same path', async () => {
      const { invalidateMaterial } = await getCache();
      invalidateMaterial('materials/foo.mat.json');
      invalidateMaterial('materials/foo.mat.json');
      // No assertion needed — verifying no crash
    });
  });

  describe('material (re)build wakes the render loop', () => {
    it('fires the dirty signal when a material finishes building', async () => {
      // Regression: a LIVE material edit invalidates + async-rebuilds the instance.
      // If the rebuild lands after the Inspector's one-shot dirty grace window, an
      // idle scene never re-applies it (meshes stay stale until reload). fetchMaterial
      // must fire the dirty signal on completion so syncMaterial re-binds deterministically.
      const cache = await getCache();
      const { registerBuiltinMaterialTypes } = await import('../../../src/runtime/loaders/materialPresets');
      const { addDirtyListener } = await import('../../../src/runtime/ecs/entityUtils');
      registerBuiltinMaterialTypes();

      // Minimal textureless pbr material so the build is synchronous (no KTX2 decode).
      const matDoc = { id: 'test-guid', type: 'pbr', color: 0xffffff, roughness: 0.5 };
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => matDoc })));
      const dirty = vi.fn();
      const unsub = addDirtyListener(dirty);
      try {
        // First resolve is a cache miss → kicks off the async fetch, returns undefined.
        expect(cache.resolveMaterial('materials/test.mat.json')).toBeUndefined();
        await vi.waitFor(() => expect(cache.resolveMaterial('materials/test.mat.json')).toBeDefined());
        expect(dirty).toHaveBeenCalled();
      } finally {
        unsub();
        vi.unstubAllGlobals();
      }
    });
  });
});
