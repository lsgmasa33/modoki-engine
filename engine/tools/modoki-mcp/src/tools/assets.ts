/** Asset schema introspection + validated authoring (particle/anim/timeline) + gesture capture.
 *
 *  Registered by `registerAllTools` (`../registerAll.ts`). Side-effect-free on import:
 *  nothing here runs until the register function is called, which is what lets a test
 *  build a context against a stub backend and call these handlers. See `../context.ts`.
 */

import { z } from 'zod';
import type { ToolDef } from '../toolDef.js';
import type { ToolContext } from '../context.js';
import { SAVE_PARAM } from '../shapes.js';

/** Every type the backend's `getAssetSchema` actually serves. ONE list, because three tools take
 *  it and they had drifted NARROWER than the backend: the enum was material|particle|animation
 *  while `assetSchemas.ts` defined five, so `modoki_asset_schema {type:'timeline'}` was rejected
 *  by zod — and `timeline_set`/`timeline_add_clip` both tell the agent to read exactly that. The
 *  timeline authoring loop had no reachable schema and no scaffolder.
 *
 *  ⚠️ **This is a hand-kept COPY of `ASSET_SCHEMA_TYPES` in the engine's
 *  `engine/packages/modoki/src/runtime/assets/assetSchemas.ts`, and it cannot be an import**: this
 *  package bundles standalone and imports nothing from the engine. It is also the copy that
 *  ENFORCES (a zod enum rejects before any request is made), so drift here is not a bad error
 *  message — it is a tool that refuses a type the backend serves. `engine/tests/tools/
 *  assetTypeParity.test.ts` compares the two lists and fails the build when they disagree. */
const ASSET_TYPES = ['material', 'particle', 'animation', 'spriteanim', 'timeline', 'rig2d'] as const;

export { ASSET_TYPES as ASSET_TYPES_FOR_TESTS };

export function registerAssetTools(tool: ToolDef, ctx: ToolContext): void {
  const { getJson, postJson, editorAction } = ctx;

  // ── Phase C: asset schema introspection + validated authoring ──
  tool(
    'modoki_asset_schema',
    'Get the field schema (types, defaults, ranges, enums) + a valid example for an asset type ' +
      '(material / particle / animation / spriteanim / timeline / rig2d), so you can author the JSON ' +
      'correctly. Read this BEFORE ' +
      'modoki_write_asset. Texture/effect refs must be GUIDs (use modoki_list_assets).',
    { type: z.enum(ASSET_TYPES)
      .describe('Which asset type\'s schema to return (field types, defaults, ranges, enums + a valid example).') },
    async ({ type }) => getJson(`/api/asset-schema?type=${type}`),
  );
  tool(
    'modoki_create_asset',
    'Scaffold a new asset (material/particle/animation/spriteanim/timeline/rig2d) with sensible defaults + a fresh GUID at ' +
      'the given path. Then edit it with modoki_write_asset or (for live preview) the particle/anim ops. ' +
      'Always writes the file directly, regardless of persistence mode (modoki_persistence) — this is ' +
      'an explicit "write this file" tool, not a live-state edit.',
    {
      type: z.enum(ASSET_TYPES)
        .describe('Asset type to create — decides the file extension and the default contents. Read modoki_asset_schema first.'),
      path: z.string().describe('Asset-root URL, e.g. /games/x/assets/fx/spark.particle.json'),
      save: SAVE_PARAM,
    },
    async ({ type, path }) => postJson('/api/create-asset', { type, path }),
  );
  tool(
    'modoki_write_asset',
    'Write an asset JSON file with validation (warn-but-write — hard errors block, warnings are ' +
      'returned). Preserves the existing file\'s id if `data` omits one.\n\n' +
      'THIS IS A FULL REPLACE, NOT A MERGE: any top-level field absent from `data` is DELETED. ' +
      'A write that would drop fields the file currently has is REFUSED (409, nothing written) ' +
      'and names them — pass replace:true to delete them deliberately. `data:{}` is refused ' +
      'outright. The intended flow is read-modify-write: modoki_read_asset_def, change what you ' +
      'need, write the WHOLE object back. ' +
      'Always writes the file directly, regardless of persistence mode (modoki_persistence) — this is ' +
      'an explicit "write this file" tool, not a live-state edit. For a LIVE particle/animation preview ' +
      'while tuning, prefer modoki_particle_set / modoki_anim_set_clip.',
    {
      path: z.string().describe('Asset-root URL of the file to WRITE, e.g. /assets/particles/spark.particle.json. Must already exist — use modoki_create_asset for a new one.'),
      type: z.enum(ASSET_TYPES)
        .describe('The asset type `data` conforms to; picks the validator applied before the write.'),
      data: z.record(z.any()).describe('The asset document IN FULL (see modoki_asset_schema for the shape). Fields you omit are DELETED — this is a replace, not a merge.'),
      replace: z.boolean().optional().describe('Acknowledge that this write DELETES top-level fields the existing file has. Without it, such a write is refused (409) and lists them.'),
      save: SAVE_PARAM,
    },
    async ({ path, type, data, replace }) => postJson('/api/asset-write', { path, type, data, ...(replace ? { replace } : {}) },
      undefined, `write the ${type} asset ${path} (FULL REPLACE)`),
  );

  tool(
    'modoki_delete_asset',
    'Move asset FILES to the OS trash (recoverable from there, not from the editor). The cleanup ' +
      'half of modoki_create_asset / modoki_import_file — without it an agent that scaffolds a ' +
      'probe asset has no way to remove it and has to shell out to `rm`.\n\n' +
      'IT IS NOT UNDOABLE, and it is NARROWER than the Assets panel\'s Delete. The panel sweeps a ' +
      'model\'s GENERATED products — the .mesh.json / .mat.json / textures it produced on import, ' +
      'plus every .meta.json sidecar — and records a restore snapshot so Cmd-Z brings them back. ' +
      'This tool trashes EXACTLY the paths you name and records nothing. So deleting a .glb ' +
      'through it ORPHANS every mesh and material generated from it, with no way back except the ' +
      'OS trash. Name the sidecars and generated files yourself, or delete through the panel.\n\n' +
      'It also does NOT evict the renderer\'s scene-scoped caches (mesh/material/prefab/particle): ' +
      'an asset already loaded into the open scene stays live until the next scene swap, even ' +
      'though its file is gone. The panel\'s delete has the same limit — this is not a difference ' +
      'between them.\n\n' +
      'A path that is not on disk is REPORTED in `missing`, not an error — so a list carrying ' +
      'maybe-absent sidecars is safe, and `trashed` counts only files that really existed. ' +
      'Verify with modoki_list_assets — NOT modoki_resolve_refs, which resolves ENTITY refs and ' +
      'never answers about an asset GUID at all. The asset manifest is rebuilt ' +
      'BEFORE the reply (`manifestRebuilt:true`), so a check issued straight after — including in ' +
      'the same modoki_batch — sees the deletion. `manifestRebuilt:false` means the rebuild did ' +
      'not run and the manifest is still catching up via the file watcher.',
    {
      paths: z.array(z.string()).min(1)
        .describe('Asset-root URLs to trash, e.g. ["/games/x/assets/fx/probe.particle.json"]. Trashed in ONE OS call (one trash sound). Include the .meta.json sidecars yourself — nothing expands the list for you.'),
    },
    async ({ paths }) => postJson('/api/delete-asset', { paths },
      undefined, `move ${paths.length} asset file(s) to the OS trash`),
  );

  // ── Phase D: particle / animation first-pass editing (live + persisted) ──
  tool(
    'modoki_set_playhead',
    'Move the animation playhead (scrub) to a time in seconds — the INSERTION POINT for ' +
      'modoki_anim_add_key.\n\n' +
      'IT DOES NOT POSE THE RIG. This moves the editor\'s playhead VALUE; the human scrub path ' +
      'additionally opens a preview session and poses the skeleton, and this op does not. A ' +
      'render_sequence / capture_viewport taken afterwards shows the UNCHANGED pose — the reply ' +
      'says so (`posed:false`) and names the bound clip, or tells you none is bound. The value is ' +
      'clamped to the clip duration, like the panel does.\n\n' +
      'modoki_pose_clip is the tool that DOES pose the rig — it moves the playhead too, so reach ' +
      'for it whenever you want the world to change. Use this one only to set the keyframe ' +
      'INSERTION POINT without disturbing the live world.',
    { t: z.number().describe('Playhead time in seconds.') },
    async ({ t }) => editorAction('set-playhead', { t }),
  );
  tool(
    'modoki_list_creatable_assets',
    'The "New X" kinds the Assets panel can create RIGHT NOW — the discovery step for ' +
      'modoki_create_registered_asset. Read this first: the registry is dynamic and ' +
      'game-extensible (a game registers its own as "<gameId>.<name>" — sling has level and wave), ' +
      'and it COMES AND GOES WITH THE OPEN PROJECT, so the tool catalog cannot list the kinds and ' +
      'neither can anything else static.\n\n' +
      'Each row reports `agentCreatable`. A kind with that false is a full create OVERRIDE that ' +
      'runs editor code rather than writing a document — `scene` DISCARDS the live world — and is ' +
      'refused by the create tool with a pointer to the right one. Knowing that before you build a ' +
      'batch is the point of reporting it here rather than only in the refusal.',
    {},
    async () => getJson('/api/creatable-assets'),
  );
  tool(
    'modoki_create_registered_asset',
    'Create one of the Assets panel\'s "New X" assets at a path you supply. The agent-reachable ' +
      'half of that surface: the panel\'s own flow opens the native save dialog FIRST, and on ' +
      'macOS that is a BLOCKING osascript panel, so the whole "New X" surface was unreachable ' +
      'from here. Passing the path routes around it; the human\'s dialog is untouched.\n\n' +
      'DIFFERENT FROM modoki_create_asset, which takes a fixed enum of six engine asset types. ' +
      'This drives the live, game-extensible registry — read modoki_list_creatable_assets for what ' +
      'is available in the OPEN project.\n\n' +
      'A create-OVERRIDE kind is REFUSED, `scene` above all: its override discards the live world, ' +
      'and the save dialog is what made cancelling safe — supplying a path is exactly what removes ' +
      'that guard. Use modoki_new_scene, which refuses with REQUIRES_SAVE when there is unsaved ' +
      'work.\n\n' +
      'Writes the file directly and registers its GUID. Verify with modoki_list_assets (a `name` ' +
      'filter finds it in one call); edit the new document with modoki_write_asset; remove it with ' +
      'modoki_delete_asset. NOT modoki_resolve_refs — that resolves ENTITY refs from journal ' +
      'payloads and never answers about an asset GUID.',
    {
      kind: z.string().describe('A `kind` id from modoki_list_creatable_assets (e.g. "material", "animation", "sling.level"). An unknown kind is refused with the live list.'),
      path: z.string().describe("Asset-root URL for the new file, e.g. /assets/materials/rock.mat.json. The kind's extension is appended if you leave it off, so the manifest cannot classify the file as something other than the kind you asked for."),
    },
    async ({ kind, path }) => editorAction('create-registered-asset', { kind, path }),
  );
  tool(
    'modoki_open_animation_editor',
    'Open a .anim.json in the Animation editor and BIND it to the entity that plays it — the ' +
      'double-click-in-Assets path, and the PREREQUISITE for modoki_pose_clip, ' +
      'modoki_set_playhead and modoki_anim_add_key. All three read the editor\'s currently open ' +
      'clip, and nothing else on this surface can set it: modoki_set_selection {asset} selects the ' +
      'asset in the Assets panel and does NOT open its editor.\n\n' +
      'Binding resolves by matching the clip against entities carrying an Animator trait in the ' +
      'OPEN scene. It can succeed at opening and fail at binding, so the reply reports `bound` ' +
      'separately — an unbound clip opens fine and leaves modoki_pose_clip with nothing to pose.\n\n' +
      'It WAITS for the clip document to load and refuses if it does not, rather than reporting a ' +
      'clip it has not got: the document is fetched by the Animation PANEL, and FlexLayout mounts ' +
      'only the selected tab, so a docked-but-unselected panel never loads it. Check ' +
      'modoki_get_editor_state.openPanels if it refuses.',
    {
      path: z.string().describe('Asset-root URL of the clip, e.g. /assets/animations/walk.anim.json. Must be an animation asset — another type is refused.'),
      name: z.string().optional().describe('Display name for the editor tab. Defaults to the filename without its .anim.json suffix.'),
    },
    async ({ path, name }) => editorAction('open-animation-editor', { path, ...(name !== undefined ? { name } : {}) }),
  );
  tool(
    'modoki_pose_clip',
    'Pose the bound rig at a time in the open animation clip — the thing modoki_set_playhead ' +
      'deliberately does NOT do. This is the human scrub gesture, driven by the same code: it ' +
      'moves the playhead AND samples the clip into the live world, so a render or capture taken ' +
      'afterwards shows the posed rig.\n\n' +
      'It poses INSIDE the editor\'s preview envelope, opening one if needed. That matters: the ' +
      'envelope\'s snapshot is what "⏹ Exit Preview" reverts to, and its run-mode is what stops a ' +
      'scene save baking the pose into the scene FILE. A pose outside it is both unrevertible and ' +
      'unguarded — measured, and it cost the owner authored data once.\n\n' +
      'NOT AN UNDO ENTRY. Cmd-Z does not reach it; the envelope reverts on exit instead. That is a ' +
      'deliberate deviation from "one call = one undo entry", because a preview pose is not a ' +
      'scene edit.\n\n' +
      'It needs a clip OPEN and BOUND to an entity — the two are separate refusals, because the ' +
      'fixes differ (open a .anim.json with modoki_open_animation_editor, versus bind it to ' +
      'something carrying an Animator). The POSE itself needs no Animation panel mounted; opening ' +
      'the clip does, because the panel is what fetches the document.\n\n' +
      'A pose that applies ZERO channels is reported as a FAILURE, not a quiet success — usually ' +
      'the clip\'s track paths do not resolve against the bound entity.\n\n' +
      'VERIFY BY PERTURBING: read a posed trait back (modoki_get_scene_state) at TWO different `t` ' +
      'values and assert they DIFFER. A single read can coincide with the authored value, and then ' +
      'it cannot tell "posed" from "ignored".',
    { t: z.number().describe('Time in seconds to pose at. Clamped to the clip duration, like the panel does; the reply reports `clampedFrom` when that happened.') },
    async ({ t }) => editorAction('pose-clip', { t }),
  );
  tool(
    'modoki_exit_pose_envelope',
    'Close the animation preview envelope that modoki_pose_clip opens: revert the posed world back ' +
      'to its authored values and return the editor run-mode to stopped. This is the ⏹ Exit ' +
      'Preview button.\n\n' +
      'CALL IT WHEN YOU ARE DONE POSING. While the envelope is open the run-mode is `scrub`, and ' +
      'that is precisely what BLOCKS a scene save — so a posed editor left behind is one the human ' +
      'cannot Cmd+S until they press ⏹ themselves.\n\n' +
      'It refuses when the TIMELINE panel owns the envelope rather than the Animation side. That is ' +
      'deliberate: ending the Timeline\'s session would revert its world mid-run, which is worse ' +
      'than refusing.\n\n' +
      'IT ALWAYS RESTORES — there is no way to keep the posed values. Every path in the editor\'s ' +
      'own UI restores too, and the only thing a keep-the-pose option would do is bake a preview ' +
      'frame into the authored world, which is exactly what the envelope exists to prevent. If you ' +
      'want a posed value AUTHORED, read it back while posed and write it deliberately with ' +
      'modoki_set_transform / modoki_mutate_scene — that route is undoable and this one is not.',
    {},
    async () => editorAction('exit-pose-envelope'),
  );

  // ── read_asset_def — the READ half of the asset-editor tools ──
  tool(
    'modoki_read_asset_def',
    'Read an asset DEFINITION back: a .particle.json, .anim.json, .timeline.json, .spriteanim.json ' +
      'or .rig2d.json, from the LIVE cache (not the file). The companion to modoki_particle_set / ' +
      'modoki_anim_set_clip / modoki_timeline_set, which all take a FULL definition — this is how ' +
      'you GET one to modify, and how you VERIFY an edit by DATA instead of judging it from a ' +
      'rendered frame. ' +
      'LIVE, not the file, is the point: persistence is manual, so an unsaved edit exists only in ' +
      'the live cache and a file read would report the pre-edit value — making a successful edit ' +
      'look like a no-op. `unsaved:true` means there is a pending write for it (modoki_save_all ' +
      'flushes). Errors if nothing in the open scene has loaded the asset yet.',
    {
      path: z.string().describe('Asset-root URL, e.g. /assets/particles/spark.particle.json'),
      type: z.enum(['particle', 'animation', 'timeline', 'spriteanim', 'rig2d']).optional()
        .describe('Only needed when the filename does not carry the usual .particle/.anim/.timeline/.spriteanim/.rig2d suffix.'),
    },
    async ({ path, type }) => {
      const q = new URLSearchParams({ path });
      if (type) q.set('type', type);
      return getJson(`/api/asset-def?${q.toString()}`);
    },
  );

  tool(
    'modoki_particle_set',
    'Replace a particle effect definition — applies LIVE (you see it immediately). Persistence is ' +
      'MANUAL: the .particle.json write is PARKED in a dirty-asset registry — visible via ' +
      'modoki_get_editor_state `dirtyAssetPaths` — until modoki_save_all flushes it. So a tune you ' +
      'do not save is discarded by the next reload, and nothing you do here touches disk on its ' +
      'own. Get the shape ' +
      'from modoki_asset_schema particle. Tune emission/lifetime/size, then judge motion with ' +
      'modoki_render_sequence (the human refines the final feel).',
    {
      path: z.string().describe('Asset-root URL of the .particle.json'),
      def: z.record(z.any()).describe('Full ParticleEffectDef (see modoki_asset_schema particle).'),
      save: SAVE_PARAM,
    },
    async ({ path, def }) => editorAction('particle-set', { path, def }),
  );
  tool(
    'modoki_anim_set_clip',
    'Replace a whole animation clip — normalized, applied LIVE. Persistence is MANUAL: the ' +
      '.anim.json write is PARKED in the dirty-asset registry (see get_editor_state ' +
      '`dirtyAssetPaths`) until modoki_save_all.',
    {
      clipPath: z.string().describe("Asset-root URL of the .anim.json clip, e.g. '/assets/anim/walk.anim.json'."),
      clip: z.record(z.any()).describe('Full AnimationClipDef (see modoki_asset_schema animation).'),
      save: SAVE_PARAM,
    },
    async ({ clipPath, clip }) => editorAction('anim-set-clip', { clipPath, clip }),
  );
  tool(
    'modoki_anim_add_key',
    'Add/update ONE keyframe on a clip track (creates the track if absent) — the granular way to ' +
      'rough-in timing. Applies live; the write is PARKED in the dirty-asset registry (persistence ' +
      'is manual) until modoki_save_all. `path` is the relative entity name-path from ' +
      'the Animator root ("" = root). `type` defaults to number (use color/boolean/enum for those fields).',
    {
      clipPath: z.string().describe("Asset-root URL of the .anim.json clip, e.g. '/assets/anim/walk.anim.json'."),
      trait: z.string().describe('e.g. "Transform"'),
      field: z.string().describe('e.g. "y" or "rz"'),
      time: z.number().describe('Key time in seconds.'),
      value: z.union([z.number(), z.string(), z.boolean()]).describe('Value (encoded per track type).'),
      path: z.string().optional().describe('Relative name-path from the Animator root (default "").'),
      type: z.enum(['number', 'color', 'boolean', 'enum']).optional(),
      save: SAVE_PARAM,
    },
    async (p) => editorAction('anim-add-key', p),
  );
  tool(
    'modoki_timeline_set',
    'Replace a whole timeline sequence — normalized, applied LIVE (panel + runtime). Saved to the ' +
      '.timeline.json write PARKED in the dirty-asset registry (persistence is manual) until ' +
      'modoki_save_all. Tracks target descendants of the Director root by ' +
      'relative name-path.',
    {
      timelinePath: z.string().describe("Asset-root URL of the .timeline.json, e.g. '/assets/timelines/intro.timeline.json'."),
      timeline: z.record(z.any()).describe('Full TimelineDef (see modoki_asset_schema timeline).'),
      save: SAVE_PARAM,
    },
    async ({ timelinePath, timeline }) => editorAction('timeline-set', { timelinePath, timeline }),
  );
  tool(
    'modoki_timeline_add_clip',
    'Add ONE item to a timeline track (creates the track if absent) — the granular way to build a ' +
      'cutscene. `trackType` picks the lane; `item` is the per-kind body: animation → ' +
      '{start,duration?,clip(NAME in the target animator bank),scrub?} · signal → {t,action(UIAction),params?} · ' +
      'audio → {t,clip(audio GUID),bus?,volume?,pitch?} · activation → {start,end} · ' +
      'control → {start,duration?,prefab(GUID)|particle:true|subdirector:true} · ' +
      'video → {start,duration?,clip(video GUID)} (the target needs a VideoPlayer; a video clip is ' +
      'started at `start` and paused at start+duration, never scrubbed). Applies live; saves ' +
      'the write PARKED in the dirty-asset registry (persistence is manual) until ' +
      'modoki_save_all.',
    {
      timelinePath: z.string().describe("Asset-root URL of the .timeline.json, e.g. '/assets/timelines/intro.timeline.json'."),
      trackType: z.enum(['animation', 'signal', 'audio', 'activation', 'control', 'video']),
      target: z.string().optional().describe('Relative name-path from the Director root (default "" = root).'),
      item: z.record(z.any()).describe('The per-kind item body (see description).'),
      save: SAVE_PARAM,
    },
    async (p) => editorAction('timeline-add-clip', p),
  );

  // ── find_references (#284) ──
  tool(
    'modoki_find_references',
    'What references this? Walks the reverse asset/entity reference graph from a target — ' +
      'direct AND indirect chains (e.g. texture ← material ← mesh ← entity), including implicit ' +
      'edges no single file records (a UI imageSrc holding the auto-emitted whole-image sprite ' +
      "guid rather than the texture's own). Use before deleting/renaming an asset, or to find " +
      'every entity that would be affected by changing a shared material/prefab. ' +
      'Reads FILES ON DISK, not the live world — an unsaved edit in the running scene is not ' +
      'reflected here; modoki_save_all first if you just changed something. ' +
      'Returns {target, direct, indirect, returnedCount, totalCount, truncated, ' +
      'unresolvedRefsFromTarget, warnings} — direct/indirect are hop-1 vs hop>1 referrer chains.',
    {
      target: z.string().describe('What to find references TO: an asset GUID, an entity GUID (EntityAttributes.guid, or a prefab instance\'s own guid), or a virtual asset path starting with "/" (e.g. /assets/textures/wood.png).'),
      limit: z.number().int().positive().optional().describe('Cap the returned referrer entries (default 50, max 1000). Sets truncated + totalCount.'),
      maxDepth: z.number().int().positive().optional().describe('How many reference hops back to walk (default 6, max 20). 1 = direct referrers only.'),
      reachableOnly: z.boolean().optional().describe('Count only references that survive a production build (reachable from a scene root) — drops references living in dead/unreferenced files.'),
    },
    async ({ target, limit, maxDepth, reachableOnly }) => {
      const q = new URLSearchParams({ target });
      if (limit != null) q.set('limit', String(limit));
      if (maxDepth != null) q.set('maxDepth', String(maxDepth));
      if (reachableOnly) q.set('reachableOnly', '1');
      return getJson(`/api/find-references?${q.toString()}`);
    },
  );

  // ── Phase G: input-feel capture (Electron editor only) ──
  tool(
    'modoki_capture_gesture',
    'Run a trusted drag from→to while SAMPLING an entity\'s Transform each frame, returning the ' +
      'trajectory (position over time). Use to tune input FEEL numerically — drag a draggable object ' +
      'and see how it tracks/eases/lags, then adjust thresholds/damping. Requires the Electron editor ' +
      'and the game Playing (so the drag drives game logic). Prefer sampleGuid (stable across ' +
      'hot-reloads). For sampling ANY component over time WITHOUT a drag, use modoki_watch instead.',
    {
      from: z.object({ x: z.number(), y: z.number() }),
      to: z.object({ x: z.number(), y: z.number() }),
      sampleGuid: z.string().optional().describe('Entity GUID whose Transform is sampled each frame (preferred — survives hot-reloads).'),
      sampleEntityId: z.number().optional().describe('Entity numeric id to sample (fallback; churns across hot-reloads — prefer sampleGuid).'),
      steps: z.number().optional().describe('Intermediate sample count (default 12).'),
    },
    async ({ from, to, sampleGuid, sampleEntityId, steps }) => postJson('/api/capture-gesture', { from, to, sampleGuid, sampleEntityId, steps }, 60_000),
  );
}
