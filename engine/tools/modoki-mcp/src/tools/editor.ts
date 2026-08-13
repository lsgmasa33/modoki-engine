/** Editor session state + scene/entity/prefab operations + editor-surface control.
 *
 *  Registered by `registerAllTools` (`../registerAll.ts`). Side-effect-free on import:
 *  nothing here runs until the register function is called, which is what lets a test
 *  build a context against a stub backend and call these handlers. See `../context.ts`.
 */

import { z } from 'zod';
import type { ToolDef } from '../toolDef.js';
import type { ToolContext } from '../context.js';
import { SAVE_PARAM } from '../shapes.js';

export function registerEditorTools(tool: ToolDef, ctx: ToolContext): void {
  const { getJson, postJson, editorAction } = ctx;

  // ── get_editor_state — "see everything a human sees" ──
  tool(
    'modoki_get_editor_state',
    'Read the WHOLE editor UI state in one call: current scene path, play state ' +
      '(stopped/playing/paused), gizmo mode/space, FPS, entity count, current selection ' +
      '(entity ids + selected asset), the editor viewport camera pose, undo/redo ' +
      'availability + labels, and `persistenceMode` (always \'manual\' — see modoki_persistence). ' +
      'The companion to get_scene_state (which reads the ECS world): this reads the EDITOR. ' +
      'Requires a connected editor renderer.',
    {},
    async () => getJson('/api/editor-state'),
  );

  // ── persistence — the MCP persistence-mode knob (mcp-persistence.md) ──
  tool(
    'modoki_persistence',
    'Report the persistence contract and whether there is unsaved work. Persistence is ' +
      'MANUAL-ONLY, so there is no mode to set — this is a READ. Returns `mode:"manual"` plus ' +
      '`unsavedChanges` (null if no editor is connected).\n\n' +
      'THE CONTRACT: modoki_mutate_scene / modoki_set_transform apply as ONE undoable step to the ' +
      'RUNNING world and do NOT touch the scene file; the particle/anim/timeline ops park their ' +
      'write in a dirty-asset registry (see modoki_get_editor_state `dirtyAssetPaths`). Both reach ' +
      'disk only via modoki_save_all. The live-world entity/prefab tools (create/duplicate/delete/' +
      'reparent) were always live-only. modoki_write_asset/modoki_create_asset are explicit ' +
      '"write this file" tools and always write.\n\n' +
      'SO: call modoki_save_all before anything that reads the scene FILE — modoki_build refuses ' +
      'while unsaved, and a file-direct mutate (a scene that is NOT the one open, or setBaseScene) ' +
      '409s while unsaved. A game-code edit force-reloads the editor and DISCARDS unsaved scene ' +
      'edits, so do not let unsaved work pile up.\n\n' +
      'The former \'auto\' mode (save on every mutation) was REMOVED so a tool\'s effect never ' +
      'depends on invisible session state. Passing `mode` is refused with a 400, not ignored.',
    {},
    async () => postJson('/api/persistence', {}),
  );

  // ── editor_journal — the human-activity stream (Editor Percept) ──
  tool(
    'modoki_editor_journal',
    'Read the EDITOR-ACTIVITY stream — what is being done in the editor session (Editor Percept). ' +
      'Event TYPES: !edit, !mutate, !select, !create, !delete, !duplicate, !reparent, !transform, ' +
      '!undo, !redo, !play, !pause, !stop, !scene-load, !save, !gizmo. ' +
      '⚠️ **!mutate is what YOUR OWN modoki_mutate_scene / modoki_set_transform produce** (label ' +
      '"Mutate Scene (N ops)"); !edit is the HUMAN Inspector-field path. This list omitted !mutate, ' +
      'and a QA case that trusted it asserted !edit and failed against a perfectly healthy engine — ' +
      'assert on what the journal returns, not on a remembered name. A !mutate is a COMPOSITE, so ' +
      'its payload is `{count, ops:[{kind, label, …that op\'s own payload, detail?}], truncated?}` — ' +
      'the entity guids are inside `ops[]`, one line per sub-op, not at the top level. ' +
      'Structural events carry guids: !create/!duplicate ' +
      '`{entity, parent, source?}`, !delete `{entities:[guid]}`, !reparent `{entity, from, to, reorder}` ' +
      '(from/to are parent guids, "root" for scene root), !transform `{entity, before, after}` (a gizmo ' +
      'drag — before/after hold only the TRS fields that moved, e.g. {x,y,z}; a MULTI-SELECT drag is ' +
      'ONE event shaped `{entities:[guid], members:[{entity, before, after}]}` instead, so read ' +
      '`members` — `payload.entity` is undefined there). !scene-load `{path, ' +
      'entityCount}`, !save `{path, entities}`, !gizmo `{mode|space}`. ' +
      'A trait-field !edit ALSO carries a structured `detail: {trait, field, entities[guid], old[], ' +
      'new[]}` (index-aligned arrays; length-1 for a single edit, N for a multi-select — so "zeroed ' +
      'gravityScale on 3 crates" is machine-readable, not just a label). !undo/!redo echo the ' +
      'detail/payload of the action they traversed. `detail.new` is the value at the edit\'s first commit — exact for discrete edits ' +
      '(text-blur/checkbox/dropdown, which commit once); a continuous drag reports its first frame, ' +
      'so read the FINAL value live from get_scene_state. Compound multi-field edits (e.g. SpriteAnimator ' +
      'clip/track ops) are label-only (no detail). Each event has a ' +
      '`source`: "human" (the person) or "agent" (YOUR own edits via these MCP ops) — filter to see ' +
      'only what the human did, so you don\'t attribute your own edits to them. Captured at COMMIT ' +
      'points (not per drag frame); wall-clock + monotonic `seq` stamped — pass the last `seq` as ' +
      '`since` to poll only new EDITOR events. `merged:true` also returns the game journal under ' +
      '`game` (raw, tick-stamped) AND a `timeline`: a SINGLE-AXIS interleave of editor + game events ' +
      'ordered by a shared `cap` capture counter, each tagged `stream:"editor"|"game"` — the one ' +
      'ordered story ("pressed Play → set timeScale 0.3 → @match on tick 84 → paused"). `type`/`source`/' +
      '`since` shape ONLY the `editor` array; the `timeline` is the full correlated story, windowed by ' +
      'its own `sinceCap` cursor — poll it incrementally by passing the returned `nextCap` as `sinceCap` ' +
      '(a cursored poll returns the OLDEST events after the cursor, so it is contiguous and never skips). ' +
      'Every stream returns the LAST 100 events by default plus `byType`/`gameByType` counts over the ' +
      'whole ring (a busy session is ~54–126k tokens of editor events, and the game ring far more); ' +
      'raise limit=N, or cursor precisely with since=/sinceCap=. ' +
      'Editor-only. This is how you PAIR: see the human\'s edits and line them up against what the game did.',
    {
      type: z.string().optional().describe('Only editor events of this type: !edit | !select | !create | !delete | !duplicate | !reparent | !transform | !undo | !redo | !play | !pause | !stop | !scene-load | !save | !gizmo. (Filters the `editor` array only.)'),
      source: z.enum(['human', 'agent']).optional().describe('Only events by the human at the keyboard, or by the agent (your MCP ops). Omit for both. (Filters the `editor` array only.)'),
      since: z.number().optional().describe('Forward cursor for the `editor` array: returns the OLDEST events with seq greater than this (contiguous, oldest-first) + a `nextSeq` when truncated. Advance with `nextSeq` each poll — a cursored poll NEVER skips events (unlike the bare newest-last call). Does NOT window the merged timeline (use sinceCap).'),
      sinceCap: z.number().optional().describe('Forward cursor for the merged `timeline`: returns the OLDEST interleaved events with cap greater than this (contiguous, oldest-first) + a `nextCap` when truncated. Advance with `nextCap` each poll to fetch newer events with no gap.'),
      merged: z.boolean().optional().describe('Also include the game journal under `game` (raw) AND the interleaved `timeline`. Both are tailed too — cursor with sinceCap for a precise incremental slice.'),
      limit: z.number().optional().describe('Return the last N events per stream (default 100). An explicit limit always wins.'),
      clear: z.boolean().optional().describe('Clear the editor-activity buffer after reading.'),
    },
    async ({ type, source, since, sinceCap, merged, limit, clear }) => {
      const q = new URLSearchParams();
      if (type) q.set('type', type);
      if (source) q.set('source', source);
      if (since != null) q.set('since', String(since));
      if (sinceCap != null) q.set('sinceCap', String(sinceCap));
      if (merged) q.set('merged', '1');
      if (limit != null) q.set('limit', String(limit));
      if (clear) q.set('clear', '1');
      const qs = q.toString();
      // `clear=1` makes this a "do this", so its `ok` is a success flag and gets checked — a plain
      // read's `ok` is not (see getJson's docblock, and the journal twin). (Phase 6)
      return getJson(`/api/editor-journal${qs ? `?${qs}` : ''}`, undefined, !!clear);
    },
  );

  // ── wait_for_edit — the long-poll twin of editor_journal (#28) ──
  tool(
    'modoki_wait_for_edit',
    'PARK and be WOKEN the moment the human does something in the editor, instead of polling ' +
      'modoki_editor_journal in a loop. Returns IMMEDIATELY if a matching event already happened ' +
      'after `since` (never makes you wait for something that already occurred); otherwise blocks ' +
      'until a matching event arrives or `timeoutMs` elapses. A timeout is a NORMAL result ' +
      '(`{events:[], timedOut:true, nextSeq}`), not an error — just call again with `since:nextSeq` ' +
      'to keep watching. `source` defaults to "human" (the whole point is noticing what the HUMAN ' +
      'did, not your own MCP-driven edits). Same event shape/types as modoki_editor_journal, same ' +
      'forward `since`/`nextSeq` cursor (advance with the returned `nextSeq`, never re-use a stale ' +
      'one). `timeoutMs` defaults to 30s and is capped at 120s server-side — for a longer watch, ' +
      'call again. This BLOCKS the tool call for up to that long; do not set a short client-side ' +
      'timeout expectation around it.',
    {
      type: z.string().optional().describe('Only wake for this editor event type, e.g. !edit, !select, !transform. Omit to wake on any type.'),
      source: z.enum(['human', 'agent']).optional().describe('Who must have done it. Defaults to "human" — pass "agent" only if you specifically want to notice your own MCP-driven edits.'),
      since: z.number().optional().describe('Forward cursor (a prior `seq`/`nextSeq`). Omit to wait for the NEXT event from now, not to replay history.'),
      timeoutMs: z.number().optional().describe('How long to park, in ms. Default 30000, clamped to [50, 120000].'),
    },
    async ({ type, source, since, timeoutMs }) => {
      const q = new URLSearchParams();
      if (type) q.set('type', type);
      if (source) q.set('source', source);
      if (since != null) q.set('since', String(since));
      if (timeoutMs != null) q.set('timeoutMs', String(timeoutMs));
      const qs = q.toString();
      // Client-side transport timeout must clear the SERVER's own deadline (clamped to
      // 120s there) with headroom, or this fetch aborts before the backend answers and a
      // legitimate long park reads as "backend unreachable" instead of the real result.
      const clampedServerTimeout = Math.max(50, Math.min(120_000, timeoutMs ?? 30_000));
      const transportTimeoutMs = clampedServerTimeout + 15_000;
      return getJson(`/api/wait-for-edit${qs ? `?${qs}` : ''}`, transportTimeoutMs);
    },
  );

  // ── set_selection ──
  tool(
    'modoki_set_selection',
    'Set the editor selection (what the Inspector/gizmo act on). Select entities by guid ' +
      '(PREFER — stable) or id, OR select an asset. A ref that matches no live entity is skipped ' +
      '(reported in `skipped`); if NONE resolve the call fails, so selection is never silently ' +
      'confirmed on a stale id. No refs at all = clear. Does NOT push an undo entry. Returns the new editor state.',
    {
      entityId: z.number().nullable().optional().describe('Primary entity id to select (null clears). Prefer guid.'),
      entityIds: z.array(z.number()).optional().describe('Multi-selection set by id. Prefer guids.'),
      guid: z.string().optional().describe('Entity guid to select (preferred — stable across hot-reloads).'),
      guids: z.array(z.string()).optional().describe('Multi-selection set by guid (preferred).'),
      asset: z.object({ path: z.string(), type: z.string(), name: z.string() }).nullable().optional()
        .describe('Select an asset instead of entities.'),
    },
    async (p) => editorAction('set-selection', p),
  );

  // ── play_control — Play/Stop/Pause/Resume/Step the live game ──
  tool(
    'modoki_play_control',
    'Drive the editor transport bar: play (snapshot + run), stop (revert to the authored ' +
      'snapshot), pause (freeze), resume, or step (advance exactly one frame while paused). ' +
      'PRECONDITIONS, refused rather than silently done: `pause` needs PLAYING, `resume` and ' +
      '`step` need PAUSED. In particular `resume` from stopped is NOT a play — it is refused, ' +
      'because running one would discard the state you were inspecting. ' +
      'This is how you TEST the game like a human pressing Play. After play, exercise it with ' +
      'modoki_tap/drag, read modoki_get_scene_state, then stop to revert. Returns editor state.',
    { action: z.enum(['play', 'stop', 'pause', 'resume', 'step'])
      .describe("Transport command. 'step' advances ONE fixed-dt frame while paused. This IS the editor-action op name on the wire.") },
    async ({ action }) => editorAction(action),
  );

  // ── history — undo / redo ──
  tool(
    'modoki_history',
    'Undo or redo the last editor action (same stack as Cmd+Z / Cmd+Shift+Z). Your own ' +
      'create/duplicate/delete/reparent edits are undoable; selection changes are not. ' +
      'Returns {did, ...editorState}. `did=false` means the stack END was reached — there was ' +
      'nothing to undo. `did=true` means an entry was POPPED and its closure ran; it is NOT a ' +
      'guarantee that the world now looks as it did before, because an entry captured against a ' +
      'PREVIOUS world (anything from before a scene hot-reload, which any file write triggers) ' +
      'undoes against entities that no longer exist. So verify with modoki_get_scene_state rather ' +
      'than trusting `did` — the same rule as every other mutation on this surface.',
    { action: z.enum(['undo', 'redo']).describe('Which direction to move the undo stack. This IS the editor-action op name on the wire.') },
    async ({ action }) => editorAction(action),
  );

  // ── scene management ──
  tool(
    'modoki_list_scenes',
    'List the project\'s scene assets (path + guid) so you know what to load.',
    {},
    async () => getJson('/api/scenes'),
  );
  tool(
    'modoki_load_scene',
    'Switch the editor to a scene (returns to Stopped first, like opening a scene). Verify ' +
      'with modoki_get_editor_state / modoki_get_scene_state afterwards. REFUSES when the ' +
      'editor has unsaved live-world changes (it swaps the world, destroying them) — save_all ' +
      'first, or pass force:true.',
    {
      force: z.boolean().optional().describe('Discard unsaved live-world changes (they are destroyed — from the world, the file, AND the undo stack).'),
      path: z.string().describe('Asset-root URL of the scene file.') },
    async ({ path, force }) => editorAction('load-scene', { path, ...(force ? { force } : {}) }),
  );
  tool(
    'modoki_new_scene',
    'Start a fresh untitled scene (clears all entities, spawns a default Camera). Unsaved ' +
      'until you modoki_save_all({path}) — it has no path yet, so save_all REQUIRES one. ' +
      'WARNING: this DISCARDS the live world; anything created and not saved is gone (it ' +
      'refuses if there are unsaved changes — pass force:true to discard them deliberately).',
    { force: z.boolean().optional().describe('Discard unsaved live-world changes deliberately.') },
    async ({ force }) => editorAction('new-scene', force ? { force } : {}),
  );
  tool(
    'modoki_save_all',
    'Save the current scene to disk (File → Save All). Blocked during Play. REQUIRED before ' +
      'any tool that edits the scene FILE (set_transform / mutate_scene) can see entities made ' +
      'by the live-world tools (create_entity / duplicate_entity / prefab) — those do NOT save. ' +
      'FAILS LOUDLY if the write does not land, so a success here really means it is on disk. ' +
      'After new_scene there is no path yet: pass `path` (the Save-As panel needs a human and ' +
      'would hang an agent call).',
    {
      path: z.string().optional().describe(
        'Save to this path instead of the current one, e.g. "/assets/scenes/my-scene.json". ' +
        'Required for a scene from new_scene (which has no path yet); the scene keeps it for later saves.',
      ),
    },
    async ({ path }) => editorAction('save-all', path ? { path } : {}),
  );
  tool(
    'modoki_discard_asset_edits',
    'ABANDON parked asset writes — the counterpart to modoki_save_all for the dirty-asset registry '
      + '(the pending particle/anim/timeline defs listed as `dirtyAssetPaths` by '
      + 'modoki_get_editor_state). Persistence is manual, and until now a save was the ONLY exit: an '
      + 'exploratory modoki_particle_set / anim_set_clip / timeline_set could not be backed out.\n\n'
      + 'DO NOT "undo" one by re-applying the old def — that is not equivalent and the difference '
      + 'bites: it re-parks a write (so the doc is still dirty and the next save_all commits it), and '
      + 'the def you can read back is the MIGRATED one, so a legacy `gravity: 6` is rewritten as '
      + '`[0,-6,0]`. Discard the write instead.\n\n'
      + 'SCOPE: this drops the pending WRITE, not the edit. The editor cache keeps the applied def '
      + 'until the asset is reloaded, so reading it back still shows your change — that is not a '
      + 'failed discard. To revert the VALUE too, apply the previous def first, then discard.\n\n'
      + 'A bare call is REFUSED and lists what is pending: dropping everything is unrecoverable, so '
      + 'name `paths`, or say `all:true`.',
    {
      paths: z.array(z.string()).optional().describe(
        'The asset paths to abandon, e.g. ["/assets/particles/confetti.particle.json"]. Read them '
        + 'from modoki_get_editor_state `dirtyAssetPaths`. A path that is not pending is reported '
        + 'under `notPending` rather than counted as discarded.',
      ),
      all: z.boolean().optional().describe('Drop EVERY pending asset write. Required (with no `paths`) to make the destructive form explicit.'),
    },
    async ({ paths, all }) => editorAction('discard-asset-edits', { ...(paths ? { paths } : {}), ...(all ? { all } : {}) }),
  );

  // ── entity create / duplicate / delete / reparent (undoable, like the menus) ──
  tool(
    'modoki_create_entity',
    'Create an entity exactly like the Hierarchy "Create ▸" menu (undoable). Kinds: empty, ' +
      'primitive (mesh: sphere/cylinder/cone/plane/…), 2d (shape: square/circle/triangle), ' +
      'canvas2d (full-screen 2D canvas host for Renderable2D children), ui ' +
      '(preset: view/text/image/button/input/slider), camera, light (light: ambient/directional/' +
      'point/spot), particle. Returns {id, name, guid} — carry the GUID (runtime ids are ' +
      'reassigned on every hot-reload). LIVE-world only: NOT saved to disk — run modoki_save_all ' +
      'to persist (a file tool like set_transform/mutate_scene/build can\'t see it until you do).',
    {
      kind: z.enum(['empty', 'primitive', '2d', 'canvas2d', 'ui', 'camera', 'light', 'particle'])
        .describe('What to create — which traits the new entity gets. Drives the default name and, for primitive/2d, the shape/mesh fields.'),
      parentId: z.number().optional().describe('Parent entity id (default 0 = root).'),
      parentGuid: z.string().optional().describe('Parent entity guid — PREFER over parentId (stable across hot-reloads). Wins when both are given.'),
      mesh: z.string().optional().describe('For kind=primitive. One of: cube, box, sphere, cylinder, cone, plane, torus, capsule (default sphere). An unknown name is REFUSED — it would otherwise create an entity whose renderer resolves to nothing.'),
      shape: z.string().optional().describe('For kind=2d. One of: circle, square, triangle (default square). An unknown name is REFUSED. For an image sprite, create the entity then set Renderable2D.sprite to a texture GUID.'),
      preset: z.enum(['view', 'text', 'image', 'button', 'input', 'slider']).optional().describe('For kind=ui.'),
      light: z.enum(['ambient', 'directional', 'point', 'spot']).optional().describe('For kind=light.'),
      save: SAVE_PARAM,
    },
    async ({ kind, parentId, parentGuid, mesh, shape, preset, light }) => {
      // Build the discriminated CreateEntitySpec the renderer op expects.
      let spec: Record<string, unknown>;
      switch (kind) {
        // Defaults are applied by the OP (agentEditorOps `create-entity`), so the MCP tool and a
        // direct curl call behave identically — they used to differ, and the direct path crashed.
        case 'primitive': spec = { kind, ...(mesh ? { mesh } : {}) }; break;
        case '2d': spec = { kind, ...(shape ? { shape } : {}) }; break;
        case 'ui': spec = { kind, preset: preset ?? 'view' }; break;
        case 'light': spec = { kind, light: light ?? 'point' }; break;
        default: spec = { kind };
      }
      return editorAction('create-entity', { spec, parentId, parentGuid });
    },
  );
  tool(
    'modoki_duplicate_entity',
    'Duplicate an entity and its subtree (undoable, like Cmd+D). Address it by `guid` (PREFER — ' +
      'stable) or `id`. Returns {id, guid} of the new copy — carry the guid. LIVE-world only: NOT ' +
      'saved to disk (run modoki_save_all to persist).',
    { id: z.number().optional().describe('Runtime id — reassigned on hot-reload. Prefer guid.'), guid: z.string().optional().describe('Stable entity guid (preferred). Wins over id.'), save: SAVE_PARAM },
    async ({ id, guid }) => editorAction('duplicate-entity', { id, guid }),
  );
  tool(
    'modoki_delete_entities',
    'Delete one or more entities and their subtrees (undoable). Address them by `guids` (PREFER — ' +
      'stable) or `ids`. A recycled id after a hot-reload can hit the WRONG entity, so pass guids ' +
      'when you have them. LIVE-world only: NOT saved to disk (run modoki_save_all to persist).',
    {
      ids: z.array(z.number()).optional().describe('Runtime ids — reassigned on hot-reload; a recycled id deletes the wrong entity. Prefer guids.'),
      id: z.number().optional().describe('Singular form of `ids`, for deleting one entity.'),
      guids: z.array(z.string()).optional().describe('Stable entity guids (preferred).'),
      guid: z.string().optional().describe('Singular form of `guids` — the preferred way to delete ONE entity.'),
      save: SAVE_PARAM,
    },
    async ({ ids, id, guids, guid }) => editorAction('delete-entities', { ids, id, guids, guid }),
  );
  tool(
    'modoki_reparent_entity',
    'Move an entity under a new parent (0 = root), optionally setting sortOrder. Preserves ' +
      'world transform (undoable). Address the entity AND the parent by `guid`/`parentGuid` ' +
      '(PREFER — stable) or `id`/`parentId`. LIVE-world only: NOT saved to disk (run modoki_save_all).',
    {
      id: z.number().optional().describe('Runtime id of the entity to move. Prefer guid.'),
      guid: z.string().optional().describe('Stable guid of the entity to move (preferred). Wins over id.'),
      parentId: z.number().optional().describe('New parent runtime id (0 or omitted = root). Prefer parentGuid.'),
      parentGuid: z.string().optional().describe('New parent guid (preferred). Wins over parentId.'),
      sortOrder: z.number().optional(),
      save: SAVE_PARAM,
    },
    async ({ id, guid, parentId, parentGuid, sortOrder }) => editorAction('reparent-entity', { id, guid, parentId, parentGuid, sortOrder }),
  );

  // ── prefab ops ──
  tool(
    'modoki_prefab',
    'Prefab actions: instantiate a .prefab.json into the scene (path + optional parent), ' +
      'create a prefab FROM an entity (entity + destination path), or detach an instance (entity, ' +
      '"unpack completely"). detach FAILS if the entity is not a prefab instance (nothing to unpack). ' +
      'Persistence: instantiate/detach are LIVE-world only. create writes the .prefab.json to disk ' +
      'AND tags the source entities as a PrefabInstance in the LIVE world (unsaved) — run ' +
      'modoki_save_all to persist that linkage into the scene, or a reload discards it. ' +
      'Address the entity/parent by guid (PREFER — stable) or id. ' +
      'PREFAB-EDIT MODE (edit-open / edit-save / edit-exit) is how you edit the TEMPLATE itself: ' +
      'edit-open swaps the world for a synthetic scene holding the prefab in isolation (so it ' +
      'refuses on unsaved work like load_scene does, and SAVES the current scene on the way in), ' +
      'you mutate its entities with the normal tools, edit-save re-serializes the .prefab.json, ' +
      'and edit-exit reloads the scene you came from so its instances re-expand from the new file. ' +
      'While in that mode modoki_save_all REFUSES — edit-save is the save.',
    {
      action: z.enum(['instantiate', 'create', 'detach', 'edit-open', 'edit-save', 'edit-exit'])
        .describe("instantiate: spawn a prefab into the scene. create: turn an existing entity INTO a prefab asset. detach: break an instance's link to its prefab. edit-open/edit-save/edit-exit: enter, write, and leave prefab-edit mode on the template itself. Sent on the wire as `prefabAction` — the relay strips a param named `action`."),
      path: z.string().optional().describe('instantiate / edit-open: prefab asset path. create: destination .prefab.json path.'),
      force: z.boolean().optional().describe('edit-open: discard unsaved live work instead of refusing (edit-open swaps the world, like load_scene).'),
      parentId: z.number().optional().describe('instantiate: parent entity id (default root). Prefer parentGuid.'),
      parentGuid: z.string().optional().describe('instantiate: parent entity guid (preferred; wins over parentId).'),
      entityId: z.number().optional().describe('create/detach: the entity id. Prefer entityGuid.'),
      entityGuid: z.string().optional().describe('create/detach: the entity guid (preferred; wins over entityId).'),
      save: SAVE_PARAM,
    },
    // `prefabAction`, NOT `action`: /api/editor-action spends `action` on the op name and strips it
    // before relaying, so a param called `action` cannot reach the op. The MCP-facing parameter stays
    // `action` — this is a wire-name fix, not an API change.
    async ({ action, ...rest }) => editorAction('prefab', { ...rest, prefabAction: action }),
  );

  // ── gizmo / focus ──
  tool(
    'modoki_gizmo',
    'Set the SceneView transform gizmo mode (translate/rotate/scale) and/or space (world/local).',
    {
      mode: z.enum(['translate', 'rotate', 'scale']).optional(),
      space: z.enum(['world', 'local']).optional(),
    },
    async (p) => editorAction('set-gizmo', p),
  );
  tool(
    'modoki_scene_view_mode',
    "Set the SceneView viewport mode: '3d' (Three.js) or 'ui' (the 2D/UI overlay). The " +
      "toolbar selector is a native <select> that trusted input can't drive, so use this. " +
      "'ui' mode is REQUIRED to edit Collider2D vertices (with set-collider-edit) and to see " +
      'their interaction handles (modoki_handles editor=collider2d). Returns editor state.',
    { mode: z.enum(['3d', 'ui']) },
    async ({ mode }) => editorAction('set-scene-view-mode', { mode }),
  );
  tool(
    'modoki_collider_edit',
    'Toggle Collider2D vertex-edit mode (the toolbar "Points" button) for the selected ' +
      "entity. Pair with modoki_scene_view_mode 'ui' + a selected entity that has an editable " +
      'collider (polygon/polyline/concave); then modoki_handles editor=collider2d lists its ' +
      'draggable vertices. Returns editor state.',
    { on: z.boolean().describe('true enters collider vertex-edit mode on the selected entity, false leaves it.') },
    async ({ on }) => editorAction('set-collider-edit', { on }),
  );
  tool(
    'modoki_open_particle_editor',
    'Open the Particle Editor dock panel on a .particle.json asset (normally a double-click ' +
      'in Assets). This MOUNTS the Size/Opacity curve editors + the color/alpha gradient editor, ' +
      'so their interaction handles then appear (modoki_handles editor=particle — kinds ' +
      "'curve-point' / 'gradient-stop'). Pass the asset's served path (e.g. " +
      "'/assets/particles/fire.particle.json'). Returns editor state.",
    { path: z.string().describe("The asset's served path, e.g. '/assets/particles/fire.particle.json'."),
      name: z.string().optional().describe('Display label for the panel tab (default: the filename stem).') },
    async ({ path, name }) => editorAction('open-particle-editor', { path, name }),
  );
  tool(
    'modoki_open_sprite_editor',
    'Open the Sprite slicer modal on a texture (the Texture Inspector "Sprite Editor" button). ' +
      'Selects the texture + opens the modal, so its slice-handle providers appear ' +
      "(modoki_handles editor=sprite — the selected sprite's 8 corner/edge handles + pivot). " +
      "Pass the texture's served path (e.g. '/assets/textures/sheet.png'). Returns editor state.",
    { path: z.string().describe("The texture's served path, e.g. '/assets/textures/ui.png'."),
      name: z.string().optional().describe('Display label for the editor (default: the filename stem).') },
    async ({ path, name }) => editorAction('open-sprite-editor', { path, name }),
  );
  tool(
    'modoki_open_nine_slice_editor',
    'Open the 9-slice border editor modal on a UI texture (the Texture Inspector "Edit ' +
      'visually…" button — only for type=ui textures). Its 4 guide knobs then appear ' +
      '(modoki_handles editor=nineslice). Pass the texture\'s served path. Returns editor state.',
    { path: z.string().describe("The texture's served path, e.g. '/assets/textures/ui.png'."),
      name: z.string().optional().describe('Display label for the editor (default: the filename stem).') },
    async ({ path, name }) => editorAction('open-nine-slice-editor', { path, name }),
  );
  tool(
    'modoki_focus_entity',
    'Frame an entity in the SceneView orbit camera (the F-key / "Focus" action). Address it by ' +
      '`guid` (PREFER — stable) or `id`. Fails if the entity does not resolve, or if no SceneView ' +
      'is mounted to frame it in (so a "framed it" report always means the camera moved).',
    { id: z.number().optional().describe('Runtime id. Prefer guid.'), guid: z.string().optional().describe('Stable entity guid (preferred). Wins over id.') },
    async ({ id, guid }) => editorAction('focus-entity', { id, guid }),
  );
}
