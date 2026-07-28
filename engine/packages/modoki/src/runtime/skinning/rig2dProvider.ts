/** Provider slot for the rig2d cache lookup (P7 C13). Installed by `loaders/rig2dCache.ts`
 *  at composition time. Consumed by `skinning/skin2DSystem.ts`. */

import { createProviderSlot } from '../core/providerSlot';
import type { ParsedRig2D } from './rig2dTypes';

export interface Rig2DProvider {
  getRig2D(ref: string): ParsedRig2D | null;
}

export const rig2dProvider = createProviderSlot<Rig2DProvider>('rig2dProvider');
