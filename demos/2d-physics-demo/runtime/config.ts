/** 2D Physics Demo config — the scene is the source of truth (physics entities are
 *  authored in physics-playground.json). No initWorld spawning, no custom systems. */

import type { GameConfig } from '@modoki/engine/runtime';
import sceneUrl from './assets/scenes/physics-playground.scene.json?url';

export const physicsDemoConfig: GameConfig = {
  name: '2D Physics Demo',
  sceneSetup: () => {},
  initWorld: () => {},
  scenePath: sceneUrl,
  assetManifest: '/assets.manifest.json',
};
