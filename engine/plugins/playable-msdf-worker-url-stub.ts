/** Playable build stub for `@zappar/msdf-generator/worker?worker&url` (#1356). Aliased in for a
 *  `VITE_PLAYABLE` build only (see vite.config.ts), with the `?worker&url` query SWALLOWED by the
 *  alias, so this resolves as a plain module rather than being built as a worker — a worker bundle
 *  is a separate `.js` file, which the single-file inliner refuses. No URL: a playable uses
 *  pre-baked atlases, and `playable-msdf-stub.ts`'s generator throws before any worker is needed. */
export default undefined;
