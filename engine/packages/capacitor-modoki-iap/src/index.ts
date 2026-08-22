import { registerPlugin } from '@capacitor/core';

import type { ModokiIapPlugin } from './definitions';

const ModokiIap = registerPlugin<ModokiIapPlugin>('ModokiIap', {
  web: () => import('./web').then((m) => new m.ModokiIapWeb()),
});

export * from './definitions';
export { ModokiIap };
