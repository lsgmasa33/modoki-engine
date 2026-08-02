/**
 * Shared generator for the SCOPED tsconfig shape used by both `build-web.mjs` (one
 * active project, for a real build) and `typecheck-projects.mjs` (one project at a
 * time, for the CI sweep — see #24). Kept in one place so the two never drift.
 *
 * A generated `include` REPLACES the base config's, and TypeScript does not merge
 * `exclude` from an extended config either — so the base's tools/ exclusion has to be
 * restated here. Without it a project's build-time Node scripts (fs/path/process) get
 * typechecked against the browser settings and fail on `Cannot find module 'node:fs'`,
 * even though the wide `npm run typecheck` passes. Keep in sync with
 * engine/tsconfig.app.json's `exclude`.
 */

/** @type {readonly string[]} */
export const SCOPED_EXCLUDE = ['../games/*/tools', '../demos/*/tools'];

/**
 * @param {readonly string[]} include - paths relative to `engine/` (where the
 *   generated config is written), e.g. `['app', '../games/court']`.
 */
export function scopedTsconfigContent(include) {
  return { extends: './tsconfig.app.json', include, exclude: SCOPED_EXCLUDE };
}
