import type { GameConfig } from '@modoki/engine/runtime';
import sceneUrl from './assets/scenes/main.scene.json?url';

/** The game's runtime config. `scenePath` makes the editor load the authored
 *  scene file on startup (instead of calling initWorld). Flat layout: the asset
 *  root is <project>/runtime/assets, served at /assets/... */
export const config: GameConfig = {
  name: 'Testbed',
  sceneSetup: () => {},
  initWorld: () => {},
  scenePath: sceneUrl,
  preferWebGPU: 'force',
};
