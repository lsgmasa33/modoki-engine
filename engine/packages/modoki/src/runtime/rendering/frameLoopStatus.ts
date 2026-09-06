/** `FrameLoopHealth.status`'s union, split out of `frameDriver.ts` into its own DOM-free module.
 *
 *  `frameDriver.ts` itself references `document`/`requestAnimationFrame`/`DOMHighResTimeStamp` at
 *  module scope, so importing anything from it — even `import type` — pulls the WHOLE file into
 *  whichever TS program reaches it, and that program must then carry the `"DOM"` lib or every one
 *  of those references fails to resolve. `editorBackendRouter.ts` (the editor backend router) is
 *  reachable from `engine/electron/backendServer.ts`, which is compiled under `tsconfig.node.json`
 *  — deliberately `lib: ["ES2023"]` only, no DOM, because it is Node/Electron-main code (see that
 *  config's own comment on issue #24: folding browser ambient types into Node-side code, or vice
 *  versa, is the exact leak this project split its tsconfigs to prevent). So the router — which
 *  only needs the STRING UNION to type its wire-shaped `InputDeliverabilityReply.frameLoop.status`
 *  field against (#682 close-out round 3, BLOCKER 2) — imports this leaf instead of `frameDriver.ts`
 *  directly, and stays out of the DOM-lib program entirely.
 *
 *  Keep this in sync with `frameDriver.ts`'s own `status`-branch comment if the meaning of any
 *  member changes; the literal values themselves are now the ONE place a rename would need to
 *  touch — `frameDriver.ts` imports this type rather than declaring its own copy. */
export type FrameLoopStatus = 'running' | 'hidden' | 'idle' | 'stalled';
