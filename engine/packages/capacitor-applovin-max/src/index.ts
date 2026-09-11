import { registerPlugin } from '@capacitor/core';

import type { ApplovinMaxPlugin } from './definitions';

const ApplovinMax = registerPlugin<ApplovinMaxPlugin>('ApplovinMax', {
  web: () => import('./web').then((m) => new m.ApplovinMaxWeb()),
});

export * from './definitions';
export { ApplovinMax };
