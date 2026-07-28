/** Provider slot for looking up a `.particle.json` effect definition by ref (P7 C8). Installed
 *  by `loaders/particleCache.ts` (the scene-scoped refcounted cache stays in `loaders/` per the
 *  plan's rejection of pushing caches down into L2 — only the LOOKUP is injected). Consumed by
 *  `rendering/{particleSync,particleSync2D}.ts` (via the declared rendering→particles
 *  L2_ALLOWED edge) and `particles/cpuTslBackend.ts` directly. */

import { createProviderSlot } from '../core/providerSlot';
import type { ParticleEffectDef } from './types';

export interface ParticleDefProvider {
  getParticleEffect(ref: string): ParticleEffectDef | null;
}

export const particleDefProvider = createProviderSlot<ParticleDefProvider>('particleDefProvider');
