/** debugHandles — whether this build may expose live-inspection handles on `window`.
 *
 *  Pushed from the app bootstrap (mirrors `setJournalEnabled` / `setDebugMenuEnabled`): true in
 *  the editor/dev and in a shipped game that opts in via `project.config.json` `build.debugBuild`.
 *
 *  It lives in L0 `core/` rather than L3 `debug/` for a layering reason: the handles are set by
 *  the RENDERER (`rendering/Scene3D.tsx` publishes `window.__3d`), and `rendering` importing
 *  `debug` closes a cross-folder cycle the layer ratchet rejects
 *  (`tests/architecture/noNewCycles.test.ts`). A core flag is a legal downward edge for both.
 *
 *  It is deliberately NOT folded into `isJournalEnabled()`: a shipped game can turn the journal
 *  off purely to drop per-event cost, and that should not also blind on-device debugging.
 *
 *  Why it exists at all: without a handle on the live scene, every on-device rendering experiment
 *  costs a full build + install + launch cycle (~3 min) instead of one `device_eval`. A release
 *  build still exposes nothing — the flag is false there. */

let _enabled = false;

/** Set by the app bootstrap. */
export function setDebugHandlesEnabled(enabled: boolean): void {
  _enabled = enabled;
}

/** Whether debug handles (e.g. `window.__3d`) may be published in this build. */
export function areDebugHandlesEnabled(): boolean {
  return _enabled;
}
