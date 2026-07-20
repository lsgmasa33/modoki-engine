import { registerPlugin } from '@capacitor/core';
import type { LitertLmPlugin } from './definitions';

const LitertLm = registerPlugin<LitertLmPlugin>('LitertLm', {
  web: () => import('./web').then((m) => new m.LitertLmWeb()),
});

export * from './definitions';
export { LitertLm };
