/** Unit tests for the model-import hierarchy helpers (findNearestMeshAncestor +
 *  decomposeLocalTransform). These are the heart of the hierarchy-parenting fix
 *  (commit b48e983) — previously only covered transitively by the slow browser
 *  e2e. The renderer composes `parent.world × child.local`, so the import path
 *  must (a) keep sibling meshes under a shared group as siblings, not chain them,
 *  and (b) store parent-LOCAL transforms, not world-space. */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { findNearestMeshAncestor, decomposeLocalTransform } from '../../src/runtime/loaders/meshTemplateCache';

describe('findNearestMeshAncestor', () => {
  it('returns null for a top-level mesh (parents to the import root, not the model)', () => {
    const model = new THREE.Group();
    const mesh = new THREE.Mesh();
    model.add(mesh);
    const tracked = new Map<THREE.Object3D, string>();
    expect(findNearestMeshAncestor(mesh, model, tracked)).toBeNull();
  });

  it('keeps two siblings under a shared group as siblings (does NOT chain the 2nd onto the 1st)', () => {
    // model > group > { meshA, meshB }
    const model = new THREE.Group();
    const group = new THREE.Group();
    const meshA = new THREE.Mesh();
    const meshB = new THREE.Mesh();
    model.add(group);
    group.add(meshA, meshB);

    // Pre-order DFS: meshA is processed (and registered) before meshB.
    const tracked = new Map<THREE.Object3D, string>();
    expect(findNearestMeshAncestor(meshA, model, tracked)).toBeNull();
    tracked.set(meshA, 'A'); // only the MESH is registered, never the group

    // meshB must still resolve to null — it walks PAST the shared group looking
    // for a real mesh ancestor and finds none, so it stays a root sibling.
    expect(findNearestMeshAncestor(meshB, model, tracked)).toBeNull();
  });

  it('resolves a nested mesh to its nearest ancestor MESH, skipping intervening groups', () => {
    // model > meshParent > pivotGroup > meshChild
    const model = new THREE.Group();
    const meshParent = new THREE.Mesh();
    const pivotGroup = new THREE.Group();
    const meshChild = new THREE.Mesh();
    model.add(meshParent);
    meshParent.add(pivotGroup);
    pivotGroup.add(meshChild);

    const tracked = new Map<THREE.Object3D, string>();
    tracked.set(meshParent, 'P'); // group is NOT tracked

    const found = findNearestMeshAncestor(meshChild, model, tracked);
    expect(found).not.toBeNull();
    expect(found!.value).toBe('P');
    expect(found!.obj).toBe(meshParent);
  });

  it('stops at the model boundary (never returns a node above the model)', () => {
    const outer = new THREE.Group();
    const model = new THREE.Group();
    const mesh = new THREE.Mesh();
    outer.add(model);
    model.add(mesh);
    // outer is tracked but lives ABOVE the model — must be ignored.
    const tracked = new Map<THREE.Object3D, string>([[outer, 'OUTER']]);
    expect(findNearestMeshAncestor(mesh, model, tracked)).toBeNull();
  });
});

describe('decomposeLocalTransform', () => {
  it('returns the world transform unchanged when there is no parent mesh', () => {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh();
    mesh.position.set(4, 0, 0);
    root.add(mesh);
    root.updateMatrixWorld(true);

    const local = decomposeLocalTransform(mesh, null);
    expect(local.position[0]).toBeCloseTo(4, 5);
    expect(local.position[1]).toBeCloseTo(0, 5);
  });

  it('expresses a child relative to a translated parent mesh (parent +3x, child world +4x → local +1x)', () => {
    const root = new THREE.Group();
    const parent = new THREE.Mesh();
    const child = new THREE.Mesh();
    parent.position.set(3, 0, 0);
    child.position.set(1, 0, 0); // local +1 → world +4
    root.add(parent);
    parent.add(child);
    root.updateMatrixWorld(true);

    // Sanity: child world is +4x.
    const worldPos = new THREE.Vector3();
    child.getWorldPosition(worldPos);
    expect(worldPos.x).toBeCloseTo(4, 5);

    // Local (parent⁻¹ × childWorld) must recover +1x, NOT the world +4x.
    const local = decomposeLocalTransform(child, parent);
    expect(local.position[0]).toBeCloseTo(1, 5);
  });

  it('divides out a non-identity parent scale (parent scale 2, child world scale 2 → local scale 1)', () => {
    const root = new THREE.Group();
    const parent = new THREE.Mesh();
    const child = new THREE.Mesh();
    parent.scale.set(2, 2, 2);
    child.position.set(1, 0, 0); // local +1 under scale-2 parent → world +2
    root.add(parent);
    parent.add(child);
    root.updateMatrixWorld(true);

    const local = decomposeLocalTransform(child, parent);
    expect(local.position[0]).toBeCloseTo(1, 5); // parent-relative, not world (+2)
    expect(local.scale[0]).toBeCloseTo(1, 5);
    expect(local.scale[1]).toBeCloseTo(1, 5);
    expect(local.scale[2]).toBeCloseTo(1, 5);
  });
});
