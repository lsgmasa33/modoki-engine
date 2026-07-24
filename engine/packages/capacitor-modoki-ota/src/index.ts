import { registerPlugin } from '@capacitor/core';
import type { ModokiOtaPlugin } from './definitions';

const ModokiOta = registerPlugin<ModokiOtaPlugin>('ModokiOta', {
  web: () => import('./web').then((m) => new m.ModokiOtaWeb()),
});

export * from './definitions';
export { ModokiOta };
