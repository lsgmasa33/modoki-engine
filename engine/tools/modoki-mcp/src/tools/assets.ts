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

  // ── Phase D: particle / animation first-pass editing (live + persisted) ──
  tool(
    'modoki_set_playhead',
    'Move the animation playhead (scrub) to a time in seconds — the INSERTION POINT for ' +
      'modoki_anim_add_key.\n\n' +
      'IT DOES NOT POSE THE RIG. This moves the editor\'s playhead VALUE; the human scrub path ' +
      'additionally opens a preview session and poses the skeleton, and this op does not. A ' +
      'render_sequence / capture_viewport taken afterwards shows the UNCHANGED pose — the reply ' +
      'says so (`posed:false`) and names the bound clip, or tells you none is bound. The value is ' +
      'clamped to the clip duration, like the panel does.',
    { t: z.number().describe('Playhead time in seconds.') },
    async ({ t }) => editorAction('set-playhead', { t }),
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
