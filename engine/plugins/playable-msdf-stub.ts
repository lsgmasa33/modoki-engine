/** Playable build stub for `@zappar/msdf-generator` (Phase 5). Aliased in for a
 *  `VITE_PLAYABLE` build only (see vite.config.ts). The real lib self-resolves a Web
 *  Worker + wasm via `new URL(..., import.meta.url)`, which the single-file inliner can't
 *  fold into the one HTML — the worker would be emitted as a separate ~40 KB chunk that
 *  404s (and trips the inliner's single-chunk guard). A playable MUST use PRE-BAKED font
 *  atlases (Font Inspector → Apply), never runtime MSDF generation, so this stub keeps the
 *  import resolvable + lets the worker DCE out; constructing it (a game that tried runtime
 *  font-gen) throws a clear, actionable error. */

export type MSDFAtlas = unknown;

export class MSDF {
  constructor() {
    throw new Error(
      '[playable] Runtime MSDF font generation is unavailable in a single-file playable build. ' +
      'Pre-bake the font atlas (Font Inspector → Apply) so the playable ships a static atlas instead.',
    );
  }
}
