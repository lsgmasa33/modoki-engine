/** Load a GLB model and spawn each mesh as an ECS entity, preserving parent-child hierarchy.
 *  If loadModelTemplates() was called first (the normal import path), spawns from the cached
 *  hierarchy — no second GLB parse, and fixupMesh is guaranteed to be applied. */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { getCurrentWorld, registerEntity } from '../ecs/world';
import { Transform, Renderable3D, EntityAttributes } from '../traits';
import { getModelPostprocessor } from './modelPostprocessorRegistry';
import { getModelHierarchy, findNearestMeshAncestor, decomposeLocalTransform, modelGlbUrl, sanitizeGeometryAttributes, type MeshHierarchyEntry } from './meshTemplateCache';
import { isGuid, resolveGuidToPath, getGuidForPath, registerAsset, newGuid } from './assetManifest';

/** Resolve the registered GUID for a freshly-built `.mesh.json` / `.mat.json`
 *  path. The import pipeline registers every mesh/material BEFORE spawning, so
 *  this always hits. The GUID-only invariant forbids storing a literal path
 *  (the runtime resolver rejects internal asset paths), so on a miss we mint +
 *  register a GUID and shout — never fall back to the path. A miss means an
 *  import-ordering regression, not normal operation. */
function preferGuid(refPath: string, type: 'mesh' | 'material'): string {
  const g = getGuidForPath(refPath);
  if (g) return g;
  console.error(`[loadGLB] no GUID registered for ${type} "${refPath}" — minting one; check that the import registers assets before spawning.`);
  const id = newGuid();
  registerAsset(id, refPath, type);
  return id;
}

/** Root transform applied to the entire model before baking */
interface RootTransform {
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
}

/**
 * Load a GLB and spawn an ECS entity for each mesh.
 * Preserves parent-child relationships from the GLB hierarchy.
 * Returns a promise that resolves to a map of entity ID → mesh name.
 */
export interface LoadGLBOptions {
  /** Directory containing *.mesh.json files (if set, Renderable.mesh uses asset paths) */
  meshDir?: string;
  /** Directory containing *.mat.json files */
  materialDir?: string;
  /** meshName → material asset path (for deduped materials) */
  materialMap?: Map<string, string>;
  /** Model postprocessor ID — if set, applies filterMesh + fixupMesh from
   *  the registered postprocessor. */
  postprocessorId?: string;
}

export function loadGLB(
  pathOrGuid: string,
  prefix: string,
  root: RootTransform = {},
  options: LoadGLBOptions = {},
): Promise<Map<number, string>> {
  // Resolve guid → path before touching the loader / hierarchy cache
  const path = isGuid(pathOrGuid) ? resolveGuidToPath(pathOrGuid) : pathOrGuid;
  if (!path) return Promise.resolve(new Map());

  // If loadModelTemplates already parsed this GLB, spawn from cached hierarchy.
  // This avoids re-parsing the GLB and ensures fixupMesh was applied.
  const hierarchy = getModelHierarchy(path);
  if (hierarchy) {
    return Promise.resolve(spawnFromHierarchy(hierarchy, prefix, options));
  }

  // Fallback: parse GLB directly (only hit if loadModelTemplates wasn't called first)
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load(modelGlbUrl(path), (gltf) => {
      const model = gltf.scene;

      // Apply root transform
      if (root.position) model.position.set(...root.position);
      if (root.rotation) model.rotation.set(...root.rotation);
      if (root.scale) model.scale.setScalar(root.scale);

      // Force world matrix update so we can bake transforms
      model.updateMatrixWorld(true);

      const entityMap = new Map<number, string>();
      // Map Three.js object → ECS entity ID (for parent lookups)
      const objectToEntityId = new Map<THREE.Object3D, number>();
      let meshIndex = 0;

      // Track meshes that were spawned as entities — anything else gets disposed
      // after traversal so the parsed GLB scene graph doesn't leak.
      const spawnedMeshes = new Set<THREE.Mesh>();

      const postprocessor = options.postprocessorId ? getModelPostprocessor(options.postprocessorId) : null;

      model.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        const mesh = child as THREE.Mesh;

        // Apply postprocessor's mesh filter (skip excluded meshes like ground planes)
        if (postprocessor?.filterMesh && !postprocessor.filterMesh(mesh)) return;

        // Apply postprocessor's mesh fixup (material/geometry fixes)
        if (postprocessor) postprocessor.fixupMesh(mesh);

        // Dequantize/normalize vertex attributes for the WebGPU NodeMaterial pipeline,
        // matching loadModelTemplates. Without this, a quantized GLB reaching the GPU via
        // this fallback path triggers the "Vertex format not supported yet" freeze. (F7)
        sanitizeGeometryAttributes(mesh.geometry);

        // Generate name
        const meshName = mesh.name || `mesh_${meshIndex}`;
        const spriteName = `${prefix}/${meshName}`;
        meshIndex++;

        // Resolve parent to the nearest ANCESTOR MESH entity (siblings under a
        // shared group stay siblings), then bake the transform LOCAL to it. The
        // renderer composes parent.world × child.local, so a world-space
        // transform double-applies the parent for non-identity hierarchies.
        const parentMesh = findNearestMeshAncestor(mesh, model, objectToEntityId);
        const parentId = parentMesh?.value ?? 0;
        const local = decomposeLocalTransform(mesh, parentMesh?.obj ?? null);
        const pos = { x: local.position[0], y: local.position[1], z: local.position[2] };
        const euler = { x: local.rotation[0], y: local.rotation[1], z: local.rotation[2] };
        const scl = { x: local.scale[0], y: local.scale[1], z: local.scale[2] };

        // Get material color
        const mat = mesh.material as THREE.MeshStandardMaterial;
        const color = mat?.color ? mat.color.getHex() : 0xffffff;

        // Build Renderable3D — use asset paths if available, else legacy sprite name
        const safeMeshName = meshName.replace(/[/\\:*?"<>|]/g, '_');
        const renderableData: Record<string, unknown> = {
          mesh: options.meshDir
            ? preferGuid(`${options.meshDir}/${safeMeshName}.mesh.json`, 'mesh')
            : spriteName,
          color,
          size: 1,
          isVisible: true,
        };
        if (options.materialMap?.has(meshName)) {
          renderableData.material = options.materialMap.get(meshName);
        } else if (options.materialDir) {
          renderableData.material = preferGuid(`${options.materialDir}/${safeMeshName}.mat.json`, 'material');
        }

        // Spawn entity with parentId in EntityAttributes + auto-increment sortOrder
        const entity = getCurrentWorld().spawn(
          Transform({
            x: pos.x, y: pos.y, z: pos.z,
            rx: euler.x, ry: euler.y, rz: euler.z,
            sx: scl.x, sy: scl.y, sz: scl.z,
          }),
          Renderable3D(renderableData as any),
          EntityAttributes({ name: meshName, sortOrder: entityMap.size, parentId, layer: '3d' }),
        );
        registerEntity(entity);

        const entityId = entity.id();
        entityMap.set(entityId, spriteName);
        spawnedMeshes.add(mesh);

        // Register only this mesh as a parent candidate. Do NOT stamp ancestor
        // group nodes — that made the next sibling resolve its parent to this
        // mesh (chaining siblings) instead of staying a sibling.
        objectToEntityId.set(mesh, entityId);
      });

      // Dispose any unspawned meshes (filtered out) — their geometries and
      // materials would otherwise leak with the parsed GLB scene graph.
      // Note: spawned meshes are referenced by Renderable3D and must stay live.
      model.traverse((child) => {
        const m = child as THREE.Mesh;
        if (!m.isMesh || spawnedMeshes.has(m)) return;
        m.geometry?.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) {
          for (const x of mat) x.dispose();
        } else if (mat) {
          (mat as THREE.Material).dispose();
        }
      });
      // Guarded for test mocks where `model` may not be a real Object3D.
      if (typeof (model as { clear?: () => void }).clear === 'function') (model as { clear: () => void }).clear();

      console.log(`[ECS] Loaded ${entityMap.size} meshes from ${path}`);
      resolve(entityMap);
    }, undefined, reject);
  });
}

/** Spawn ECS entities from pre-extracted hierarchy (no GLB re-parse needed). */
function spawnFromHierarchy(
  hierarchy: MeshHierarchyEntry[],
  prefix: string,
  options: LoadGLBOptions,
): Map<number, string> {
  const entityMap = new Map<number, string>();
  const nameToEntityId = new Map<string, number>();

  for (const entry of hierarchy) {
    const meshName = entry.name;
    const spriteName = `${prefix}/${meshName}`;

    const parentId = entry.parentName ? (nameToEntityId.get(entry.parentName) ?? 0) : 0;

    const safeMeshName = meshName.replace(/[/\\:*?"<>|]/g, '_');
    const renderableData: Record<string, unknown> = {
      mesh: options.meshDir
        ? preferGuid(`${options.meshDir}/${safeMeshName}.mesh.json`, 'mesh')
        : spriteName,
      color: entry.color,
      size: 1,
      isVisible: true,
    };
    if (options.materialMap?.has(meshName)) {
      renderableData.material = options.materialMap.get(meshName);
    } else if (options.materialDir) {
      renderableData.material = preferGuid(`${options.materialDir}/${safeMeshName}.mat.json`, 'material');
    }

    const entity = getCurrentWorld().spawn(
      Transform({
        x: entry.position[0], y: entry.position[1], z: entry.position[2],
        rx: entry.rotation[0], ry: entry.rotation[1], rz: entry.rotation[2],
        sx: entry.scale[0], sy: entry.scale[1], sz: entry.scale[2],
      }),
      Renderable3D(renderableData as any),
      EntityAttributes({ name: meshName, sortOrder: entityMap.size, parentId, layer: '3d' }),
    );
    registerEntity(entity);

    const entityId = entity.id();
    entityMap.set(entityId, spriteName);
    nameToEntityId.set(meshName, entityId);
  }

  console.log(`[ECS] Spawned ${entityMap.size} entities from cached hierarchy`);
  return entityMap;
}
