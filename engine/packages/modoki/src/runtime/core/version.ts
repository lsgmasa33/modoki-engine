/** Engine + asset format versions — single source of truth (ELECTRON_PLAN Phase 4).
 *
 *  `ENGINE_VERSION` identifies the runtime/editor build (surfaced to tooling, the
 *  scaffold, and "About"). `SCENE_FORMAT_VERSION` is the version stamped into newly
 *  created SCENE JSON; older files are upgraded by the migration chain in
 *  `runtime/loaders/loadSceneFile.ts` (each `migrateVNtoVN+1` step). Bump
 *  SCENE_FORMAT_VERSION in lockstep with adding a new migration there.
 *
 *  ⚠️ **Prefabs are NOT covered by this number.** `.prefab.json` carries its own, much smaller
 *  format version with its own constant — `PREFAB_FORMAT_VERSION` in
 *  `editor/scene/prefab.ts` — currently 2, where a scene is 12. This comment said
 *  "scene/prefab JSON" for a long time and was simply wrong; a prefab has never been stamped
 *  12. The prefab constant lives in `editor/` rather than here because prefab serialization is
 *  editor-only and nothing in `runtime/**` reads or writes it (#365, #379). */

// Keep in sync with packages/modoki/package.json "version".
export const ENGINE_VERSION = '0.1.0';

// The current SCENE JSON format version (prefabs have their own — see above). Adding a migration step
// (loadSceneFile.ts) means bumping this so freshly-saved files carry the new tag.
// v9: renderable traits' `isActive` → `isVisible` (split per-renderer visibility from
// the entity on/off EntityAttributes.isActive).
// v10: no-op passthrough — adds an optional top-level `baseScene` ref (base-scene
// persistence). Old files simply have no base; nothing about existing data changes.
// v11: no-op passthrough — `PrefabInstance.rootInstanceId` (and any other trait
// field a future FieldHint.entityId flags) is now written as a GUID string instead
// of a raw ecs id (scene-loading.md, Phase 2). The loader resolves
// either form; older files simply keep their numeric value, unaffected.
// v12: no-op passthrough — `serializeScene` stops writing the per-entity `id`
// field entirely (scene-loading.md, Phase 3). Nothing on disk
// references it any more; the loader synthesizes one (array index) for its own
// internal bookkeeping. An older file's `id` is simply ignored.
// v13: `UIAnchor.zIndex` is removed — the two fields wrote the same CSS
// `z-index` on the same DOM node, with the anchor value winning when truthy.
// A truthy `UIAnchor.zIndex` is migrated onto `UIElement.zIndex` (anchor wins,
// since that's what rendered before); the anchor field is then dropped
// unconditionally.
export const SCENE_FORMAT_VERSION = 13;

// The runtime ABI a dynamically-loaded OTA sub-game module is built against (OTA Phase 4,
// docs/ota-subgame-modules.md). A sub-game bundle stamps this value in at build time
// and the shell checks it for EXACT equality before registering the game — never `>=`, since
// a sub-game built against an older engine must refuse to load loudly, not crash mid-scene.
// `project.config.json`'s `ota.engineApi` (a separate, per-build-artifact field) must equal
// this constant; bump both together when the runtime surface a sub-game depends on changes.
export const ENGINE_API_VERSION = 1;
