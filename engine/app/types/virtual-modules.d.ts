/** Ambient declaration for the project-config virtual module provided by the
 *  asset-scanner Vite plugin (resolves project.config.json over the defaults). */
declare module 'virtual:modoki-project-config' {
  const config: import('../../project-config').ProjectConfig;
  export default config;
}

/** Ambient declaration for the games virtual module provided by the asset-scanner
 *  Vite plugin — synthesizes the open project's game set from its `game.ts` (one
 *  project = one game). The engine imports games through this instead of a
 *  hard-coded path so it stays game-agnostic. */
declare module 'virtual:modoki-games' {
  type GameDefinition = import('@modoki/engine/runtime').GameDefinition;
  export const ALL_GAMES: GameDefinition[];
  export const GAMES: GameDefinition[];
}

/** ELECTRON_PLAN Phase 1: build-time flag marking a build where the visual
 *  editor + agent/backend APIs are present. Decoupled from `import.meta.env.DEV`
 *  and `import.meta.hot` so the packaged Electron editor (a *production* build)
 *  can enable them. Defined via Vite `define` in vite.config.ts. */
declare const __MODOKI_EDITOR__: boolean;

/** Percept — build-time flag: whether the event journal records in this build.
 *  On for the editor (folded with __MODOKI_EDITOR__ in app/main.tsx); for a
 *  shipped game build it follows the project's `build.enableJournal`. Defined via
 *  Vite `define` in vite.config.ts. */
declare const __MODOKI_ENABLE_JOURNAL__: boolean;

/** Debug menu — build-time flag: whether the in-game debug menu is present in this
 *  build. On for the editor (folded with __MODOKI_EDITOR__ in app/main.tsx); for a
 *  shipped game build it follows the project's `build.enableDebugMenu`. Gates both
 *  the runtime enablement flag AND the App.tsx lazy import (so it tree-shakes out
 *  when off). Defined via Vite `define` in vite.config.ts. */
declare const __MODOKI_ENABLE_DEBUG_MENU__: boolean;

/** Engine-module toggles — build-time flags: whether each heavy SDK is present in
 *  this build. On for editor/dev (all SDKs); for a game/playable build they follow
 *  the project's `build.modules` (resolved by plugins/detect-modules.ts). Flag-gate
 *  the module's lazy import so Rolldown DCEs the unused SDK. Defined via Vite
 *  `define` in vite.config.ts. See docs/playable-export.md. */
declare const __MODOKI_MODULE_RENDER3D__: boolean;
declare const __MODOKI_MODULE_RENDER2D__: boolean;
declare const __MODOKI_MODULE_PHYSICS2D__: boolean;
declare const __MODOKI_MODULE_PHYSICS3D__: boolean;
declare const __MODOKI_MODULE_NPR__: boolean;
declare const __MODOKI_MODULE_GPU_PARTICLES__: boolean;

/** Playable (Phase 5) — build-time flags: whether this is a single-file `playable` ad
 *  build (`VITE_PLAYABLE=1`), and the store URL its CTA routes to via `mraid.open`. False/''
 *  in every other build so the MRAID/CTA overlay import DCEs out. Defined via Vite `define`
 *  in vite.config.ts. See docs/playable-export.md. */
declare const __MODOKI_PLAYABLE__: boolean;
declare const __MODOKI_PLAYABLE_CLICK_URL__: string;
