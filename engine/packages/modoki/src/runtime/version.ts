/** Engine + asset format versions — single source of truth (ELECTRON_PLAN Phase 4).
 *
 *  `ENGINE_VERSION` identifies the runtime/editor build (surfaced to tooling, the
 *  scaffold, and "About"). `SCENE_FORMAT_VERSION` is the version stamped into newly
 *  created scene/prefab JSON; older files are upgraded by the migration chain in
 *  `runtime/loaders/loadSceneFile.ts` (each `migrateVNtoVN+1` step). Bump
 *  SCENE_FORMAT_VERSION in lockstep with adding a new migration there. */

// Keep in sync with packages/modoki/package.json "version".
export const ENGINE_VERSION = '0.1.0';

// The current scene/prefab JSON format version. Adding a migration step
// (loadSceneFile.ts) means bumping this so freshly-saved files carry the new tag.
// v9: renderable traits' `isActive` → `isVisible` (split per-renderer visibility from
// the entity on/off EntityAttributes.isActive).
export const SCENE_FORMAT_VERSION = 9;
