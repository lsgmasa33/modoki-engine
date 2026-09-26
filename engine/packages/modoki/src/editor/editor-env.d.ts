/** ELECTRON_PLAN Phase 1: build-time flag marking a build where the visual
 *  editor + agent/backend APIs are present. Decoupled from `import.meta.env.DEV`
 *  / `import.meta.hot` so the packaged Electron editor (a production build) can
 *  enable them. Supplied via the host's Vite `define`. */
declare const __MODOKI_EDITOR__: boolean;

/** Engine-module toggles (build.modules) — build-time flags: whether each heavy SDK
 *  is present in this build. Supplied via the host's Vite `define`; on for editor/dev
 *  and the package test env. Flag-gate the module's lazy import so the unused SDK is
 *  dead-code-eliminated. See docs/playable-export.md. */
declare const __MODOKI_MODULE_RENDER3D__: boolean;
declare const __MODOKI_MODULE_RENDER2D__: boolean;
declare const __MODOKI_MODULE_PHYSICS2D__: boolean;
declare const __MODOKI_MODULE_PHYSICS3D__: boolean;
declare const __MODOKI_MODULE_VIDEO__: boolean;

/** #1586: each KTX2 transcoder pair's content hash (`engine/plugins/transcoders.ts`), appended to its
 *  URLs as `?v=`. Blank strings in the editor, dev and playable builds. Supplied via the host's Vite
 *  `define`. */
declare const __MODOKI_TRANSCODER_VERSIONS__: { readonly basis: string; readonly pixiKtx: string };
