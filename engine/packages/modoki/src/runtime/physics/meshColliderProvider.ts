/** Provider slot for resolving a mesh-template GUID to its geometry, for trimesh/convex-hull
 *  3D colliders (P7 C14). Installed by `loaders/meshTemplateCache.ts`. Consumed by
 *  `physics/physics3DSystem.ts`. Typed against only the field this caller touches — the full
 *  `MeshTemplate` (material, name) stays loader-owned. */

import type * as THREE from 'three';
import { createProviderSlot } from '../core/providerSlot';

export interface MeshColliderProvider {
  resolveMeshGeometry(meshRef: string): THREE.BufferGeometry | undefined;
}

export const meshColliderProvider = createProviderSlot<MeshColliderProvider>('meshColliderProvider');
