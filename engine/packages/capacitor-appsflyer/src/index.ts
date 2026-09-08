import { registerPlugin } from '@capacitor/core';

import type { AppsFlyerPlugin } from './definitions';

const AppsFlyerCap = registerPlugin<AppsFlyerPlugin>('AppsFlyerCap', {
  web: () => import('./web').then((m) => new m.AppsFlyerWeb()),
});

export * from './definitions';
export { AppsFlyerCap };
