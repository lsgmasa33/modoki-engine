import { WebPlugin } from '@capacitor/core';

import type { AudioSessionCategory, ModokiAudioPlugin } from './definitions';

/**
 * Web (and, structurally, Android — see `android/…/ModokiAudioPlugin.java`) has no
 * `AVAudioSession` and no equivalent focus concept to bridge: this is a permanent no-op, not a
 * simulation. `shouldSilenceSecondaryAudio()` answering `false` is the honest default — nothing here
 * knows whether another app/tab is playing audio — and `secondaryAudioHint` is simply never
 * emitted.
 */
export class ModokiAudioWeb extends WebPlugin implements ModokiAudioPlugin {
  async configure(_options: { category: AudioSessionCategory }): Promise<void> {
    /* nothing to configure */
  }
  async shouldSilenceSecondaryAudio(): Promise<{ silence: boolean }> {
    return { silence: false };
  }
}
