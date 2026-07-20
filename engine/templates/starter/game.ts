/** Flat single-game project entry — the engine opens this folder (File → Open
 *  Project, or MODOKI_PROJECT=<this folder>) and reads the exported `game`.
 *  The GameDefinition contract is owned by the engine (@modoki/engine/runtime).
 *
 *  This is the starter template: a minimal "hello world" project. Add your own
 *  systems in runtime/setup.ts and author the scene via the editor / Modoki MCP. */

import type { GameDefinition } from '@modoki/engine/runtime';

export const game: GameDefinition = {
  id: '__GAME_ID__',
  name: '__GAME_NAME__',
  loadConfig: () => import('./runtime/config').then((m) => m.config),
  registerSystems: () => import('./runtime/setup').then((m) => m.registerGameSystems()),
  unregisterSystems: () => import('./runtime/setup').then((m) => m.unregisterGameSystems()),
};
