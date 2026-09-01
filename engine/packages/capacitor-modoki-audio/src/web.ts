import { WebPlugin } from '@capacitor/core';

import type { AudioSessionCategory, ModokiAudioPlugin } from './definitions';

/**
 * Web (and, structurally, Android — see `android/…/ModokiAudioPlugin.java`) has no
 * `AVAudioSession` and no equivalent focus concept to bridge: this is a permanent no-op, not a
 * simulation.
 */
export class ModokiAudioWeb extends WebPlugin implements ModokiAudioPlugin {
  async configure(_options: { category: AudioSessionCategory }): Promise<void> {
    /* nothing to configure */
  }
}
