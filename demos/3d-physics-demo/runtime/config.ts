/** 3D Physics Demo config — the scene is the source of truth (physics entities are
 *  authored in physics-showcase.json). No initWorld spawning, no custom systems beyond
 *  the sensor-zone reaction actions in game.ts. */

import type { GameConfig } from '@modoki/engine/runtime';
import sceneUrl from './assets/scenes/physics-showcase.scene.json?url';

export const physics3DDemoConfig: GameConfig = {
  name: '3D Physics Demo',
  sceneSetup: () => {},
  initWorld: () => {},
  scenePath: sceneUrl,
  assetManifest: '/assets.manifest.json',
};
