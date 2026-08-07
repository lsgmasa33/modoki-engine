/** WHICH tools the LIVE tier (T3) actually calls, and which it deliberately does not.
 *
 *  Lives in `src/` rather than inside `test-live-tools.ts` for one reason: the live script cannot
 *  run in CI (it needs a running editor), so if the buckets lived there, **nothing would notice a
 *  new tool escaping both of them until someone happened to run the script**. Here, a plain vitest
 *  guard (`engine/tests/tools/liveCoverage.test.ts`) asserts the split is TOTAL on every `npm test`,
 *  while the script does the actual calling.
 *
 *  That separation is the whole point of the audit's lesson 1: `modoki_prefab` 400'd on every call
 *  for months because no live call ever exercised it. A list of what is NOT live-covered is only
 *  useful if something keeps it honest.
 *
 *  Side-effect-free — see `context.ts`.
 */

/** MUTATING tools exercised live by `test-smoke.mjs`, which creates → verifies → cleans up.
 *  Each entry is a claim that a real case exists there — not an exemption. */
export const COVERED_BY_SMOKE: readonly string[] = [
  'modoki_batch', 'modoki_mutate_scene', 'modoki_set_transform', 'modoki_create_entity',
  'modoki_delete_entities', 'modoki_prefab', 'modoki_particle_set', 'modoki_save_all',
  'modoki_discard_asset_edits',
  'modoki_load_scene', 'modoki_set_selection', 'modoki_play_control', 'modoki_history',
  'modoki_tap', 'modoki_focus', 'modoki_dispatch_action', 'modoki_set_timescale', 'modoki_journal',
  'modoki_hit_regions', 'modoki_profiler',
];

/** MUTATING tools no live tier reaches, each with the reason it cannot be swept.
 *
 *  This is the honest ledger of the live tier's gaps. Every one of these is still covered by T1
 *  (registry + contract conformance) and T2 (real handler against a stub backend) — what is missing
 *  is the one thing only a live call proves: that the route on the other end still exists and still
 *  accepts this shape.
 *
 *  The bar for adding an entry is "calling this would damage or disrupt the human's open project",
 *  NOT "this is awkward to assert". It should shrink as the smoke suite grows. */
export const LIVE_UNCOVERED: Readonly<Record<string, string>> = {
  modoki_build: 'runs a real build (minutes) and writes dist/',
  modoki_add_native_target: "scaffolds ios/android folders into the human's project",
  modoki_ota_publish: 'PUBLISHES to a real bucket',
  modoki_ota_keygen: 'writes signing keys',
  modoki_new_scene: 'discards the live world',
  modoki_duplicate_entity: 'needs a target entity; smoke covers create/delete instead',
  modoki_reparent_entity: 'needs two target entities',
  modoki_import_file: 'copies a file into the project',
  modoki_reimport_asset: "rewrites an asset's import products",
  modoki_write_asset: 'overwrites an asset definition on disk',
  modoki_create_asset: 'creates an asset file',
  modoki_anim_set_clip: 'replaces a live animation clip',
  modoki_anim_add_key: 'edits a live animation clip',
  modoki_timeline_set: 'replaces a live timeline',
  modoki_timeline_add_clip: 'edits a live timeline',
  modoki_collider_edit: 'enters a viewport sub-mode the human is not in',
  modoki_gizmo: "changes the human's gizmo mode mid-session",
  modoki_scene_view_mode: "switches the human's viewport mode",
  modoki_open_particle_editor: "opens a panel over the human's layout",
  modoki_open_sprite_editor: "opens a panel over the human's layout",
  modoki_open_nine_slice_editor: "opens a panel over the human's layout",
  modoki_focus_entity: "moves the human's camera",
  modoki_set_playhead: 'scrubs a live animation/timeline',
  modoki_play_clip: 'plays a clip on a live entity',
  modoki_persistence: "changes the editor's persistence mode",
  modoki_project_settings: "action:'set' rewrites project.config.json in the human's open project (identity, signing, build flags). The action:'get' half IS swept — see minimalArgsMutates",
  modoki_editor_journal: "clear:true would destroy the human's activity buffer (the read form is safe, but the tool is declared mutating because of it)",
  modoki_drag: "a real drag on the human's viewport",
  modoki_pointer: 'leaves a pointer HELD across calls',
  modoki_hover: 'harmless, but there is nothing to assert without a target',
  modoki_scroll: "scrolls the human's panels",
  modoki_press_key: "sends a key into the human's editor",
  modoki_type_text: 'types into whatever holds focus',
  modoki_dnd: "a real drag-and-drop on the human's hierarchy",
  modoki_tap_handle: 'needs an open canvas editor with handles',
  modoki_drag_handle: 'needs an open canvas editor with handles',
  modoki_capture_gesture: 'a real drag, and requires the game Playing',
  modoki_menu: 'opens a native menu — modal, and only a human can dismiss one',
  modoki_eval: 'arbitrary code in the renderer',
  modoki_watch: "start leaves a standing watcher on the human's editor",
  modoki_input_watch: "start leaves a standing pointer-capture window open on the human's editor",
};
