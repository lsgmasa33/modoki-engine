/** captureInstanceOverrides + the load's apply (`applyOverridesByLocalToEcs`) — round-trip in a
 *  hand-built world. */

import { describe, it, expect } from 'vitest';
import { getCurrentWorld, markOverride, findEntityById } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { getTraitByName } from '@modoki/engine/runtime';
import {
  instantiatePrefab,
  captureInstanceOverrides,
  type PrefabFile,
} from '@modoki/engine/editor';
import { applyOverridesByLocalToEcs } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';

registerAllTraits();

/** A recorded override map applied to instance `rootId` as a LOAD applies its scene entry's (`applyOverridesByLocalToEcs`,
 *  every value the writer's own, so recorded): the editor's twin of it, `applyOverridesByRootInstance`, had no caller
 *  left and was deleted in #1914 R8, so these cases run the path a load takes. */
function applyAsLoad(rootId: number, overrides: Record<number, Record<string, Record<string, unknown>>>): void {
  const pi = getTraitByName('PrefabInstance')!;
  const localToEcs = new Map<number, number>();
  getCurrentWorld().query(pi.trait).updateEach(([d], e) => {
    const data = d as { rootInstanceId?: number; localId?: number };
    if (data.rootInstanceId === rootId && data.localId) localToEcs.set(data.localId, e.id());
  });
  applyOverridesByLocalToEcs(getCurrentWorld(), localToEcs, overrides, overrides);
}

function makePrefab(): PrefabFile {
  return {
    version: 1,
    name: 'overrides-test',
    rootLocalId: 1,
    entities: [
      { localId: 1, name: 'Root', traits: {
        Transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
        Renderable3D: { mesh: 'root.mesh.json', material: '', isActive: true },
        EntityAttributes: { name: 'Root', parentId: 0, layer: '3d' },
      } },
      { localId: 2, name: 'Child', traits: {
        Transform: { x: 5, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
        Renderable3D: { mesh: 'child.mesh.json', material: 'base.mat.json', isActive: true },
        EntityAttributes: { name: 'Child', parentId: 1, layer: '3d' },
      } },
    ],
  };
}

function findChildEcsId(rootId: number): number {
  const piMeta = getTraitByName('PrefabInstance')!;
  let id = 0;
  getCurrentWorld().query(piMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    if (piData.rootInstanceId === rootId && piData.localId === 2) id = entity.id();
  });
  return id;
}

describe('captureInstanceOverrides', () => {
  it('returns empty when no fields differ from the prefab base', () => {
    const prefab = makePrefab();
    const rootId = instantiatePrefab(prefab);
    const captured = captureInstanceOverrides(rootId, prefab);
    expect(captured).toEqual({});
  });

  it('captures per-localId field overrides on the live instance', () => {
    const prefab = makePrefab();
    const rootId = instantiatePrefab(prefab);
    const childId = findChildEcsId(rootId);

    // Edit the child's Transform.x and Renderable3D.material
    const tfMeta = getTraitByName('Transform')!;
    const r3dMeta = getTraitByName('Renderable3D')!;
    getCurrentWorld().query(tfMeta.trait).updateEach(([tf], entity) => {
      if (entity.id() === childId) (tf as Record<string, unknown>).x = 99;
    });
    getCurrentWorld().query(r3dMeta.trait).updateEach(([r], entity) => {
      if (entity.id() === childId) (r as Record<string, unknown>).material = 'override.mat.json';
    });
    // Mark them, exactly as the editor's inspector/gizmo edits do — capture is
    // mark-based so a deliberate edit is distinguished from a base divergence.
    markOverride(findEntityById(childId)!, 'Transform', 'x');
    markOverride(findEntityById(childId)!, 'Renderable3D', 'material');

    const captured = captureInstanceOverrides(rootId, prefab);
    expect(captured[2]).toBeDefined();
    expect(captured[2].Transform.x).toBe(99);
    expect(captured[2].Renderable3D.material).toBe('override.mat.json');
    // Untouched fields should NOT appear
    expect(captured[2].Transform.y).toBeUndefined();
  });
});

describe('the load\'s apply of a captured map', () => {
  it('writes captured overrides back onto a freshly-instantiated tree', () => {
    const prefab = makePrefab();

    // First instance: edit a child field
    const rootA = instantiatePrefab(prefab);
    const childA = findChildEcsId(rootA);
    const tfMeta = getTraitByName('Transform')!;
    getCurrentWorld().query(tfMeta.trait).updateEach(([tf], entity) => {
      if (entity.id() === childA) (tf as Record<string, unknown>).x = 77;
    });
    markOverride(findEntityById(childA)!, 'Transform', 'x');
    const captured = captureInstanceOverrides(rootA, prefab);

    // Second instance: fresh, no edits
    const rootB = instantiatePrefab(prefab);
    const childB = findChildEcsId(rootB);
    let childBPreX = -1;
    getCurrentWorld().query(tfMeta.trait).updateEach(([tf], entity) => {
      if (entity.id() === childB) childBPreX = (tf as Record<string, number>).x;
    });
    expect(childBPreX).toBe(5); // prefab base

    // Apply captured overrides to instance B
    applyAsLoad(rootB, captured);

    let childBPostX = -1;
    getCurrentWorld().query(tfMeta.trait).updateEach(([tf], entity) => {
      if (entity.id() === childB) childBPostX = (tf as Record<string, number>).x;
    });
    expect(childBPostX).toBe(77);
  });

  it('silently skips overrides for unknown localIds', () => {
    // Skipped means NOWHERE: not.toThrow alone stayed green with localId 99's override written onto the root (#1670).
    const prefab = makePrefab();
    const rootId = instantiatePrefab(prefab);
    const childId = findChildEcsId(rootId);
    expect(() => applyAsLoad(rootId, { 99: { Transform: { x: 1 } } }))
      .not.toThrow();
    const tfMeta = getTraitByName('Transform')!;
    const xs = new Map<number, number>();
    getCurrentWorld().query(tfMeta.trait).updateEach(([tf], entity) => { xs.set(entity.id(), (tf as Record<string, number>).x); });
    expect([xs.get(rootId), xs.get(childId)]).toEqual([0, 5]);
  });
});
