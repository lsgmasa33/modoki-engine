/** Engine + asset format versions — single source of truth (ELECTRON_PLAN Phase 4).
 *
 *  `ENGINE_VERSION` identifies the runtime/editor build (surfaced to tooling, the
 *  scaffold, and "About"). `SCENE_FORMAT_VERSION` is the version stamped into newly
 *  created SCENE JSON; older files are upgraded by the migration chain in
 *  `runtime/loaders/loadSceneFile.ts` (each `migrateVNtoVN+1` step). Bump
 *  SCENE_FORMAT_VERSION in lockstep with adding a new migration there.
 *
 *  ⚠️ **`PREFAB_FORMAT_VERSION` now lives HERE, and that REVERSES a recorded decision.** This
 *  docblock used to say the prefab constant belonged in `editor/scene/prefab.ts` "because prefab
 *  serialization is editor-only and nothing in `runtime/**` reads or writes it (#365, #379)". That
 *  premise was true and is no longer: #1468 gives prefabs a real format GATE, and a census of every
 *  path a `.prefab.json` can reach disk found **5 server-side writers with no client call at all**
 *  (the asset scanner's GUID heal, `/api/prefab-member-paths`, `/api/scene-mutate`,
 *  `duplicateAssetFile`, `/api/import-file`) plus 4 Node migration scripts. The gate has to be
 *  reachable from `engine/plugins/**`, which cannot import the editor scene module without dragging
 *  koota and the trait registry into the dev server. **Kept beside `SCENE_FORMAT_VERSION` rather
 *  than duplicated**, because a second copy of a format constant is the defect this file exists to
 *  prevent. `editor/scene/prefab.ts` re-exports it, so every existing importer is unchanged.
 *
 *  ⚠️ **The two numbers this note used to quote are GONE, deliberately.** It said "currently 3,
 *  where a scene is 13" and warned that they had already drifted once; by 2026-09-23 they had
 *  drifted again (4 and 15). A note that states a constant beside the constant will always rot —
 *  read `PREFAB_FORMAT_VERSION` and `SCENE_FORMAT_VERSION` below instead. The SIZE difference the
 *  numbers were there to convey survives without them: a scene has a migration ladder and a prefab
 *  has none, which is why the prefab gate can only ever refuse a NEWER file and must never demand
 *  an exact match (see docs/format-versioning.md).
 */

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
// v14: no-op passthrough — adds an optional path-keyed `nestedStructure` beside
// `nestedOverrides` on a prefab-instance entry (#1358) and on an added reference
// node (#1369) — never on a prefab row itself — carrying STRUCTURAL edits made
// inside a nested instance that expanded from a row. No existing field changes shape and no file
// carries the key yet, so there is nothing to migrate.
// ⚠️ The bump is still required. Scene's disposition is REFUSE
// (docs/format-versioning.md), so an OLDER build must refuse a v14 scene rather
// than read it, silently ignore the new key and drop it on the next save — which
// is the exact data loss #1358 fixes.
// v15: no-op passthrough — adds an optional `moved` map beside `added`/`removed`/`removedTraits` on a
// prefab-instance entry, a `nestedStructure` slot and an added reference node (#1437): a member moved to
// another parent inside its instance. Required for the same reason as v14 (REFUSE disposition).
// v16: no-op passthrough — adds an optional `members` map on a prefab-instance entry (#1468): one thin
// row per member, keyed by MINTED identity, holding the guid that used to be re-derived from the
// member's position on every load. Required for the same reason as v14 and v15, and the stakes are
// higher: an older build reading a v16 scene would ignore `members` and drop every stored member
// identity on the next save, which is the loss #1468 exists to stop arriving through the mechanism
// built to prevent it.
// ⚠️ The row shape also RESERVES the slots Phases 3 and 4 collapse the localId-keyed channels into
// (`parent`, `traits`, `removedTraits`, `removed`, `added`), so those phases are caller migrations
// and not two more irreversible bumps. See `SceneMemberRow` for why they are declared and not
// written, and the #1468 design record D2 (docs/prefab-structural-overrides.md) for the ruling.
// v17: no-op passthrough — a member row gains `own` (the scene's nodes, appended after the chain's) and
// `traitRemovals` (per-trait removals over the chain's list), and a template-added node gets a NODE row keyed
// `<frame chain>/a+<key>` (#1516). They let a scene edit one template node, or remove one more trait, without
// restating — and so pinning — everything beside it. Required for the REFUSE reason v14-v16 were: an older build
// would ignore the new channels and drop them on its next save.
export const SCENE_FORMAT_VERSION = 17;

/** The version stamped into newly written PREFAB JSON. Moved here from `editor/scene/prefab.ts`
 *  by #1468 — see the reversal note at the top of this file for why the editor-only premise no
 *  longer holds. `editor/scene/prefab.ts` re-exports it, so importing from either place is fine.
 *
 *  ⚠️ **Prefabs have NO migration ladder** (unlike scenes, above). Every authored prefab in the
 *  repo is already BELOW this number and loads correctly, so a gate on this constant must refuse
 *  only a STRICTLY NEWER document and accept every older one — `version > PREFAB_FORMAT_VERSION`,
 *  never `!==`. Measured 2026-09-23: an exact-match gate would refuse all 105 authored prefabs.
 *
 *  v4: an optional top-level `moved` map (#1437 P3-b).
 *
 *  v5: a minted `nodeGuid` on every entity row (#1468), beside — not instead of — `localId`. It is the
 *  first prefab bump that adds identity rather than a payload, and the first one an older build can
 *  actively damage: a v4 serializer re-saving a v5 file drops every `nodeGuid` it does not know about,
 *  and the guids cannot be recovered, because minting them again would produce different ones. That is
 *  what the write gate exists for (`plugins/prefabWriteGuard.ts`), and it is why the gate had to land
 *  BEFORE this bump rather than alongside it. Still no migration ladder and still nothing version-gated
 *  on the loading path: a row with no `nodeGuid` is one the next SAVE mints for.
 *
 *  v6: an optional `members` map on a nested-instance row (#1533) — the scene's member rows, so an outer
 *  prefab states the structure of a nested frame per member and per node rather than as one whole
 *  `nestedStructure` slot, which pinned everything an inner prefab put in that frame. An older build
 *  OPENS a v6 file (the loading path still reads no version, by owner ruling) and shows the inner
 *  template through for those frames; the write gate stops it SAVING over the file, which would drop
 *  the rows. No migration: the committed corpus had no row using the slot when this landed.
 *
 *  v7: an optional `templateMoved` map on a template REFERENCE node (#1543) — the moves the node states inside its own
 *  frame, in the shape of the document-level `moved`. An older build opens a v7 file without applying them, and would
 *  save the node with the moves gone, so the write gate stops it. No migration: no committed prefab held a template
 *  reference node when this landed. */
export const PREFAB_FORMAT_VERSION = 7;

// The runtime ABI a dynamically-loaded OTA sub-game module is built against (OTA Phase 4,
// docs/ota-subgame-modules.md). A sub-game bundle stamps this value in at build time
// and the shell checks it for EXACT equality before registering the game — never `>=`, since
// a sub-game built against an older engine must refuse to load loudly, not crash mid-scene.
// `project.config.json`'s `ota.engineApi` (a separate, per-build-artifact field) must equal
// this constant; bump both together when the runtime surface a sub-game depends on changes.
export const ENGINE_API_VERSION = 1;

/** FORMAT version of a sub-game's `subgame.json` document — how the file is laid out.
 *  Distinct from ENGINE_API_VERSION, which is a COMPATIBILITY version (what the bundle
 *  needs from the host). Checked by subgameLoader BEFORE any other manifest field,
 *  because a schema bump can change what those fields mean. */
export const SUBGAME_MANIFEST_SCHEMA_VERSION = 1;
