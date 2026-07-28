/** Provider slot for the audio-asset lookup seam (P7 C12): `loaders/audioBufferCache.ts`
 *  (already imports `audio/audioContext`, so this direction already existed) +
 *  `loaders/assetManifest.ts`'s load-type classification. Consumed by
 *  `audio/{audioService,audioSystem}.ts`. Composed in `registerProviders.ts`. */

import { createProviderSlot } from '../core/providerSlot';

export interface AudioAssetProvider {
  getCachedAudioBuffer(ref: string): AudioBuffer | undefined;
  resolveAudioUrl(ref: string): string | undefined;
  retryFailedAudioDecodes(): void;
  getAudioLoadType(ref: string): 'buffer' | 'stream';
}

export const audioAssetProvider = createProviderSlot<AudioAssetProvider>('audioAssetProvider');
