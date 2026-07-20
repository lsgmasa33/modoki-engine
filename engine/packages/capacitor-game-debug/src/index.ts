import { registerPlugin } from '@capacitor/core';
import type { GameDebugPlugin } from './definitions';

const GameDebug = registerPlugin<GameDebugPlugin>('GameDebug', {
  web: () => import('./web').then((m) => new m.GameDebugWeb()),
});

export * from './definitions';
export { GameDebug };
