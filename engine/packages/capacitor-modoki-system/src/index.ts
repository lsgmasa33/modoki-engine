import { registerPlugin } from '@capacitor/core';

import type { ModokiSystemPlugin } from './definitions';

const ModokiSystem = registerPlugin<ModokiSystemPlugin>('ModokiSystem', {
  web: () => import('./web').then((m) => new m.ModokiSystemWeb()),
});

export * from './definitions';
export { ModokiSystem };
