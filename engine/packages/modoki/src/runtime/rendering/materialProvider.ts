/** Provider slot for resolving a material GUID to a THREE.Material (P7 C14). Installed by
 *  `loaders/meshTemplateCache.ts`. Consumed by `rendering/materialInstanceSystem.ts`. */

import type * as THREE from 'three';
import { createProviderSlot } from '../core/providerSlot';

export interface MaterialProvider {
  resolveMaterial(materialRef: string): THREE.Material | undefined;
}

export const materialProvider = createProviderSlot<MaterialProvider>('materialProvider');
