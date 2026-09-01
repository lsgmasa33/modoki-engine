import { registerPlugin } from '@capacitor/core';

import type { ModokiAudioPlugin } from './definitions';

const ModokiAudio = registerPlugin<ModokiAudioPlugin>('ModokiAudio', {
  web: () => import('./web').then((m) => new m.ModokiAudioWeb()),
});

export * from './definitions';
export { ModokiAudio };
