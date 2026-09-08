/** Percept over the running game: journal, refs, actions, bounds, timescale, diagnose, watch.
 *
 *  Registered by `registerAllTools` (`../registerAll.ts`). Side-effect-free on import:
 *  nothing here runs until the register function is called, which is what lets a test
 *  build a context against a stub backend and call these handlers. See `../context.ts`.
 */

import { z } from 'zod';
import type { ToolDef } from '../toolDef.js';
import type { ToolContext } from '../context.js';
import { flatEntityAlias, foldEntityRef, precisionParam } from '../shapes.js';

export function registerRuntimeTools(tool: ToolDef, ctx: ToolContext): void {
  const { getJson, postJson, editorAction, fail } = ctx;

  // ════════════════════════════════════════════════════════════════════════════
  // Enable-Claude-more tools (semantic verification, numeric layout, asset authoring,
  // particle/anim editing, time, diagnostics, input feel). All relay through the same
  // backend → renderer bridge, so they work in dev AND the packaged DMG.
  // ════════════════════════════════════════════════════════════════════════════

  // ── Phase A: semantic verification ──
  tool(
    'modoki_journal',
    'RETURNS {count, total, ringTotal, byType, events}: `count` is what came back, `total` is what MATCHED your filter, and `ringTotal`+`byType` describe the WHOLE ring regardless of the filter — so a filtered read still shows you what else is in there. Read the tick-stamped game-event trace (events a game emits: match/score/win/…). The ' +
      'screenshot-free way to verify game LOGIC — assert on events, not pixels. Returns the ' +
      'LAST 100 events by default plus `byType` counts over the whole 10,000-event ring and ' +
      '`captures` (Tier-2 diagnostic state). Narrow with type= and/or level=, raise limit=N, pair ' +
      'with modoki_dispatch_action to drive the game.\n' +
      'LEVEL: every event carries a triage severity, `info` (default) / `warn` / `error` — set via ' +
      'the `gameJournal.ts` helpers (`journalWarn`/`journalError`) or emit()\'s 4th arg. ' +
      'level:"warn" returns warn AND error, skipping the normal-gameplay noise — the fastest way to ' +
      'start a bug hunt.\n' +
      'TIERS: lean events (semantic + @collision/@sensor/@zone transitions) are always recorded. ' +
      'High-frequency DIAGNOSTIC events (@contact) are WATCH-GATED — they record NOTHING until you ' +
      'open a capture and only from that point forward (this keeps the journal from being dominated ' +
      'by @contact). Open/close with action:"start"/"stop" + type:"@contact" BEFORE the moment you ' +
      'want to trace, then read, then stop.',
    {
      type: z.string().optional().describe('Read: only events of this type. With action: the watch-gated type to start/stop (e.g. "@contact").'),
      level: z.enum(['info', 'warn', 'error']).optional().describe('Read: only events at this severity OR ABOVE (e.g. "warn" returns warn + error).'),
      action: z.enum(['start', 'stop']).optional().describe('Open ("start") or close ("stop") a Tier-2 capture window for type=. Omit to just read.'),
      limit: z.number().optional().describe('Return the last N events (default 100). An explicit limit always wins.'),
      clear: z.boolean().optional().describe('Clear the journal after reading. REFUSED when combined with type=/level= — the ring has no selective clear, so clearing a FILTERED read would destroy every other event too. Read with the filter, then clear deliberately with a bare clear:true (which means ALL).'),
    },
    async ({ type, level, action, limit, clear }) => {
      const q = new URLSearchParams();
      if (type) q.set('type', type);
      if (level) q.set('level', level);
      if (action) q.set('action', action);
      if (limit != null) q.set('limit', String(limit));
      if (clear) q.set('clear', '1');
      const qs = q.toString();
      // A MUTATING read (`action=start|stop`, `clear=1`) is a "do this", so its `ok` is a success
      // flag and must be checked — a plain read's `ok` is not (see getJson's docblock). Measured
      // live: `{action:'start'}` with no `type` answers 200 {ok:false, reason:…} and was reported
      // as a successful call. (Phase 6)
      return getJson(`/api/journal${qs ? `?${qs}` : ''}`, undefined, !!action || !!clear);
    },
  );
  tool(
    'modoki_resolve_refs',
    'Resolve journal/contact refs (GUIDs and/or numeric ids from @contact/@collision/@sensor/@zone ' +
      'payloads) to entity display NAMES — the deliberate second hop that keeps names OUT of the ' +
      'journal stream (which is dominated by high-frequency contact events). Batch every ref you care ' +
      'about into one call. Names resolve even for entities that have since DESPAWNED (captured at emit ' +
      'time), which a live get_scene_state lookup cannot. Returns { resolved: { ref: {name, alive} }, ' +
      'unresolved: [...] }.',
    {
      refs: z.array(z.union([z.string(), z.number()])).describe('Refs to resolve — GUIDs and/or numeric ids.'),
    },
    async ({ refs }) => {
      const q = new URLSearchParams();
      q.set('refs', refs.map((r) => String(r)).join(','));
      return getJson(`/api/resolve-refs?${q.toString()}`);
    },
  );
  tool(
    'modoki_list_actions',
    'Discover what the game exposes: dispatchable UI/game action names (+ their param schemas) ' +
      'and live named read-values (e.g. canGoBack, timeSinceGameStart). Use before modoki_dispatch_action.',
    {},
    async () => getJson('/api/game-introspect'),
  );
  tool(
    'modoki_dispatch_action',
    'Trigger a game intent directly by name (no pixel-hunting a button) — e.g. a UIAction a button ' +
      'would fire. Only works while Playing (use modoki_play_control play first); returns ' +
      '{dispatched:false, reason} otherwise. Verify the effect with modoki_journal / modoki_get_scene_state.',
    {
      name: z.string().describe('Action name (from modoki_list_actions).'),
      payload: z.union([z.string(), z.number()]).optional()
        .describe('Single scalar argument, handed to the handler as `payload`. The UIAction convention for one value (a level id, a slot index).'),
      params: z.record(z.any()).optional()
        .describe('Structured arguments, handed to the handler as `params`. NOT an alternative to `payload` — the handler receives both fields separately (actionRegistry.ts def.handler({payload, params, …})).'),
      targetGuid: z.string().optional().describe('GUID of the entity the action targets.'),
    },
    async (p) => editorAction('dispatch-action', p),
  );
  tool(
    'modoki_play_clip',
    'Switch an entity\'s active animation clip BY NAME — the unified engine.playClip action, which ' +
      'drives whichever animator the entity carries (keyframe Animator, 2D SpriteAnimator, or GLB ' +
      'SkeletalAnimator). Only while Playing (modoki_play_control play first). This switches WHICH ' +
      'clip plays; it does NOT edit clip data — that is modoki_anim_set_clip. Discover the valid ' +
      'names from the `clipNames` field on the animator trait in modoki_get_scene_state; verify the ' +
      'switch with get_scene_state (the trait\'s activeClip / clip).',
    {
      guid: z.string().optional().describe('GUID of the animator entity. Required unless `entity` is given.'),
      entity: flatEntityAlias,
      clip: z.string().describe('Clip NAME to play (one of the target\'s clipNames).'),
    },
    async ({ guid, entity, clip }) => {
      const ref = foldEntityRef({ guid }, entity);
      if ('conflict' in ref) return fail({ code: 'AMBIGUOUS', what: 'play a clip on an entity', why: ref.conflict, expected: 'either `guid`, or `entity:{guid|name|id}` — not both' });
      // This op addresses the animator by GUID specifically — unlike duplicate/focus, an `id` does
      // not work either, so both the missing case and the id-only case are refused HERE rather than
      // sent on to fail less clearly downstream.
      if (!ref.guid) {
        return fail({
          code: 'NOT_FOUND',
          what: ref.id != null ? `play a clip on entity id ${ref.id}` : 'play a clip',
          why: ref.id != null
            ? 'engine.playClip addresses the animator by GUID, and only an id was given.'
            : 'no entity was addressed.',
          expected: 'guid:"…", or entity:{guid}',
          options: ['look the guid up with modoki_get_scene_state (name= or id=), then pass it here'],
        });
      }
      return editorAction('dispatch-action', { name: 'engine.playClip', targetGuid: ref.guid, params: { clip } });
    },
  );

  // ── Phase B: numeric layout/bounds ──
  tool(
    'modoki_get_layout_bounds',
    'NOTE `count` counts RECTS, not entities: every 3D entity is measured once PER MOUNTED VIEWPORT (Scene and Game each have their own camera), so with both open it is roughly doubled. `entityCount` is the distinct-entity number, and `surfaces`/`surfaceNote` appear whenever more than one is mounted. Numeric screen-space layout (viewport CSS px) — UI (true DOM/flexbox rects), 2D, and 3D ' +
      '(world AABB projected through the game camera). Use this INSTEAD of eyeballing a screenshot ' +
      'to check alignment, spacing, overlap, or clipping. CALLED BARE it returns COUNTS — count, ' +
      'layerCounts, overlapsCount — plus the cheap `offScreen` and `zeroSize` id lists. Those ids ' +
      'are usually the whole answer ("what is invisible / collapsed?"). For per-entity rects pass ' +
      '`ids` or `layer`; for the same-layer overlapping PAIRS (ancestor pairs excluded) pass ' +
      '`overlaps:true` — the pair list is O(n²) and was ~105k chars on a 241-entity scene, so it is ' +
      'opt-in. Cross-check against modoki_capture_viewport when unsure.',
    {
      layer: z.enum(['ui', '2d', '3d']).optional().describe('Limit to one layer. Implies per-entity rects.'),
      guids: z.array(z.string()).optional().describe('Stable guids to measure — PREFER these over ids, which are reassigned on every scene hot-reload. An address that matches nothing is echoed in `unresolved` rather than silently narrowing to an empty answer.'),
      name: z.string().optional().describe('Entities whose NAME contains this (case-insensitive) — the same filter as get_scene_state.'),
      ids: z.array(z.number()).optional().describe('Limit to these entity ids. Implies per-entity rects.'),
      entities: z.boolean().optional().describe('Force the per-entity rect list on an untargeted call. Large — prefer ids/layer.'),
      overlaps: z.boolean().optional().describe('Materialize the overlapping-pair list. Default false (only overlapsCount is reported) because it is O(n²) and dominated the response.'),
      limit: z.number().int().positive().optional().describe('Cap the returned per-entity rects; sets truncated + totalCount. Useful with layer= on a big scene.'),
      precision: precisionParam(),
    },
    async ({ layer, ids, guids, name, entities, overlaps, limit, precision }) => {
      const q = new URLSearchParams();
      if (layer) q.set('layer', layer);
      if (ids?.length) q.set('ids', ids.join(','));
      if (guids?.length) q.set('guids', guids.join(','));
      if (name) q.set('name', name);
      if (entities) q.set('entities', '1');
      if (overlaps) q.set('overlaps', '1');
      if (limit != null) q.set('limit', String(limit));
      if (precision != null) q.set('precision', String(precision));
      const qs = q.toString();
      return getJson(`/api/layout-bounds${qs ? `?${qs}` : ''}`);
    },
  );

  // ── Phase E: time-scale ──
  tool(
    'modoki_set_timescale',
    'Set the simulation time scale: 0 = pause, 0.3 = slow-motion, 1 = normal, 2 = fast-forward. ' +
      'Pair with modoki_render_sequence to inspect fast animations/particles frame-by-frame.',
    { scale: z.number().describe('Time scale (>= 0).') },
    async ({ scale }) => editorAction('set-timescale', { scale }),
  );

  // ── scene queries (#288 gap 1) ──
  tool(
    'modoki_scene_query',
    'Cast a ray, sweep a sphere/circle, or pick a point against the LIVE PHYSICS world — the ' +
      '"what is over there / would this fit / what is under this point" question, answered as ' +
      'DATA instead of from a screenshot. All six engine queries (raycast/shapecast/point, in 2D ' +
      'and 3D) behind one tool; every one is a pure read that writes nothing.\n\n' +
      'REQUIRES A RUNNING SIM. A Rapier world is built by the physics system on its first tick and ' +
      'freed on Stop, so a STOPPED editor has none and every query REFUSES with ' +
      'NOT_AVAILABLE_HERE — deliberately, because answering "nothing was hit" there would say the ' +
      'ray passed through empty space. Call modoki_play_control action:"play" first.\n\n' +
      'A MISS AND A REFUSAL ARE DIFFERENT ANSWERS, which the engine functions themselves cannot ' +
      'express — they return the same null for a clean miss, an absent physics world, and a ' +
      'zero-length direction. This tool rules the last two out BEFORE casting, so `ok:true` with ' +
      '`hit:null` genuinely means the query ran and found nothing.\n\n' +
      'Every hit reports `guid` and `name` alongside `entityId`. Use the GUID: runtime ids are ' +
      'reassigned on every scene reload, and a mutate triggers one. `entityId:-1` with a null guid ' +
      'means a collider with no ECS owner.\n\n' +
      'The coordinates here are a MEASUREMENT, not an aim — this is the one place raw numbers are ' +
      'the input, the same carve-out modoki_capture_gesture has.',
    {
      kind: z.enum(['raycast', 'shapecast', 'point'])
        .describe("REQUIRED. raycast: first collider along a ray. shapecast: same but sweeping a sphere/circle of `radius` — the \"would this fit\" query. point: which collider CONTAINS a point (the pick/hit-test)."),
      dim: z.enum(['2d', '3d'])
        .describe("REQUIRED. Which physics world to query. They are separate worlds — a 2d query never sees 3d colliders, and asking for a dimension the scene has no world for REFUSES rather than reporting a miss."),
      origin: z.array(z.number()).optional()
        .describe('Ray/sweep start, in ECS world coords. [x,y] for dim:2d, [x,y,z] for dim:3d. Required for raycast/shapecast.'),
      direction: z.array(z.number()).optional()
        .describe('Ray/sweep direction, same arity as origin. Need NOT be normalized, but must be non-zero — a zero vector describes no ray and is refused rather than reported as a miss. Required for raycast/shapecast.'),
      point: z.array(z.number()).optional()
        .describe('The point to test containment at, same arity as origin. Required for kind:point.'),
      radius: z.number().optional()
        .describe('Sphere/circle radius in world units. Required for kind:shapecast, and must be > 0.'),
      maxDistance: z.number().optional()
        .describe('Cap the cast length in world units. Default: unbounded (Infinity), matching the engine functions.'),
      solid: z.boolean().optional()
        .describe('raycast only. Default true (the engine default): a ray starting INSIDE a collider hits it at distance 0. Pass false to ignore the collider you start inside.'),
      exclude: z.string().optional()
        .describe("raycast only — a guid or an exact entity NAME (never a raw id) whose body is never reported as a hit. The self-hit case: a ground probe from a character's own position. An ambiguous name is REFUSED, not first-matched. Refused outright for kind:shapecast, whose engine function takes no exclusion filter — rather than accepted and silently ignored."),
      precision: precisionParam(),
    },
    async (args) => postJson('/api/scene-query', args, undefined, `${args.dim} ${args.kind} scene query`),
  );

  // ── PlayerPrefs (#288 gap 4) — split read/write per §7 ──
  tool(
    'modoki_player_prefs',
    'READ the engine\'s PlayerPrefs store — the durable per-key JSON save data a game writes ' +
      '(progress, settings, unlocks). Until now this was reachable only through modoki_eval + a ' +
      'dynamic import.\n\n' +
      'NOT modoki_persistence, which is the EDITOR\'s scene/asset save mode and is unrelated — ' +
      'that name collision is the confusion this description exists to stop.\n\n' +
      'CALLED BARE it returns the KEY INDEX (`keys`, `totalCount`) plus `pendingWrites`. ' +
      '`pendingWrites` is NOT a subset of `keys` — a key can be pending and absent from `keys` (a ' +
      'delete whose durable remove has not been accepted yet — rejected, or merely still ' +
      'debounced), so it may still be on disk. Pass ' +
      '`key` to get that key\'s `value`. Every reply names the `namespace` it read, and you should ' +
      'check it: the same game has SEPARATE stores depending on where it runs. The editor ' +
      'deliberately hydrates `<gameId>@editor` so playtest saves cannot reach a shipped build\'s ' +
      'store, so prefs read here are NOT the ones a web/native build sees.\n\n' +
      'An un-hydrated store REFUSES (NOT_AVAILABLE_HERE) instead of answering with an empty list. ' +
      'The cache is filled only by PlayerPrefs.init(), which runs during editor boot once a ' +
      'project is open — before that, "no keys" and "nobody looked" are the same empty array, and ' +
      'reporting the second as the first is not recoverable.\n\n' +
      'THIS IS A PURE READ — it hydrates nothing and schedules no write. Use ' +
      'modoki_write_player_prefs to change anything.',
    {
      key: z.string().optional()
        .describe('Read ONE key\'s value instead of the index. An absent key is an ANSWER (`present:false`), not an error — it also returns `keys` so a typo is obvious. `present` is explicit because a key holding JSON null is indistinguishable from a missing one otherwise.'),
    },
    async ({ key }) => getJson(`/api/player-prefs${key !== undefined ? `?key=${encodeURIComponent(key)}` : ''}`),
  );
  tool(
    'modoki_write_player_prefs',
    'WRITE the engine\'s PlayerPrefs store. The mutating twin of modoki_player_prefs, which is ' +
      'the read that VERIFIES anything done here.\n\n' +
      'Named `write` rather than `set` on purpose: three of its four actions are not a set, and ' +
      '`clear` wipes the whole namespace — a name that lies for most of its range costs an agent a ' +
      'wrong guess.\n\n' +
      'NOT UNDOABLE — a human\'s Cmd-Z does not reach it, because this is not scene data. ' +
      '`clear` therefore additionally requires confirm:true. Take that seriously on the device ' +
      'surface (device_write_player_prefs), where the target is a real installed app holding a ' +
      'real player\'s save data.\n\n' +
      '`set` and `delete` FLUSH before replying, so `saved:true` means the backend accepted the ' +
      'durable write — not merely that the in-memory cache changed. That distinction is real: a ' +
      'rejected write (quota, a native I/O error) keeps its value in the cache, so a read-back ' +
      'still shows it while nothing survives a restart. Such a write is reported as PARTIAL, never ' +
      'as success.\n\n' +
      'An un-hydrated store refuses every action, writes included: a set before PlayerPrefs.init() ' +
      'lands in a throwaway in-memory cache that init() then CLEARS.\n\n' +
      'ALL FOUR actions, flush included, are refused while a game/namespace swap is in flight ' +
      '(PlayerPrefs.isSwapInFlight()) — a write or flush that is still settling when the install ' +
      'runs can land in (or answer about) the OUTGOING namespace after this op has already moved ' +
      'on, so it cannot truthfully report where or whether it landed; retry once the swap ' +
      'finishes. modoki_player_prefs reads are NOT refused during the same window — a read ' +
      'answers truthfully about the (still fully hydrated) outgoing store.',
    {
      action: z.enum(['set', 'delete', 'clear', 'flush'])
        .describe('REQUIRED. set = write one key (needs key + value). delete = remove one key (needs key; a key that is not there is REFUSED with the real key list, not a silent no-op). clear = remove EVERY key in the namespace (needs confirm:true). flush = force pending debounced writes out and report any the backend rejected.'),
      key: z.string().optional().describe('The key, for action set/delete. Ignored by clear/flush.'),
      value: z.any().optional().describe('The JSON document to store, for action:"set". Any JSON value including null. Omitting it is REFUSED rather than treated as a delete — PlayerPrefs reads undefined as a delete, and that is a different operation here.'),
      confirm: z.boolean().optional().describe('Required (true) for action:"clear" only — it removes every key in the namespace and is not undoable. The refusal lists the keys it would have removed.'),
    },
    // Its OWN route, not the /api/editor-action relay: that relay's routing key is `action`, so a
    // tool with an `action` param has it silently dropped (measured — the op then ran with
    // `action: undefined`). editorAction() refuses that shape now; this is where the op lives.
    async ({ action, key, value, confirm }) => postJson('/api/player-prefs', {
      action,
      ...(key !== undefined ? { key } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(confirm !== undefined ? { confirm } : {}),
    }, undefined, `player prefs: ${action}`),
  );

  // ── Phase F: render/scene health diagnose ──
  tool(
    'modoki_diagnose',
    'Structured render/scene health report — turns "it renders black / looks wrong" into concrete ' +
      'causes: dangling/illegal asset refs, NaN or zero-scale transforms, missing camera, off-screen ' +
      'entities, and recent console errors. Run this FIRST when something is visually broken (before ' +
      'capture_viewport). Returns {ok, summary, refs, transforms, camera, offScreen, consoleErrors, ' +
      'errorWindowMs, olderErrors}. `consoleErrors` is NOT an absolute: it holds only the errors ' +
      'inside `errorWindowMs` (the ones that gate `ok`, so a fixed error stops failing the verdict). ' +
      'Everything older is COUNTED in `olderErrors {count, oldestTs, newestTs}` — read those with ' +
      'modoki_get_console_logs level=error. So an empty `consoleErrors` means "none recently", and ' +
      'the summary never claims "No issues detected" while older errors exist.\n\n' +
      'Pass video:true to ALSO get the downloaded-video cache index (used/budget bytes + per-clip ' +
      'entries). Opt-in because it answers a question most callers did not ask. When no cache is ' +
      'wired the reply says WHY — the video module compiled out (a playable-ad build) versus no ' +
      'Cache API (clips STREAM instead) — rather than reporting an empty cache, which those two ' +
      'are not.',
    {
      video: z.boolean().optional()
        .describe('Include the downloaded-video cache index. Default false. This is the only surface that can read it: the singleton lives behind the __MODOKI_MODULE_VIDEO__ flag, and reaching it through modoki_eval + an /@fs import yields a SECOND module instance whose slot is null — i.e. a confident "no cache" for a live one.'),
    },
    async ({ video }) => getJson(`/api/diagnose${video ? '?video=1' : ''}`),
  );

  // ── Profiler (#166 P6) — the editor half of a gap that existed on BOTH surfaces ──
  tool(
    'modoki_profiler',
    'Where did the frame go? — the Profiler surface (#138), which until now had NO typed tool on ' +
      'EITHER surface and was reachable only by an agent who knew to eval the op. Called bare it ' +
      'reads the live marker aggregate (the per-marker self-ms breakdown of a frame). ' +
      'capture-start/-stop/-read record real frames and rank the WORST by cost, not the most recent, ' +
      'so a hitch stays findable after it happened. gpu-on/gpu-off enable GPU timestamp queries — ' +
      'deliberately opt-in because enabling costs real time (two timestamps per pass) and the ' +
      'profiler must not change what it measures; where the backend cannot support them the status ' +
      'comes back "unsupported" with a reason and NO number is invented. reset clears markers and ' +
      'captures. boot reads the BOOT-PHASE timeline (#238) — always-on spans across scene load, ' +
      'asset acquire, shader prewarm and renderer init — and intersects them with the worst dropped ' +
      'frame, so a cold-boot freeze is attributed by measurement instead of guessed from the frame ' +
      'aggregate (which cannot see it: a stall is DROPPED from the percentiles by design). ' +
      'boot-reset re-arms that timeline; plain reset deliberately does NOT touch it. ' +
      '⚠️ A desktop editor frame is fast almost regardless — for a REAL perf question use ' +
      'device_profiler on the target phone; this is for finding which marker owns the frame, and for ' +
      'editor-side regressions. Read actions are GET, state-changing ones POST.',
    {
      action: z.enum(['read', 'capture-start', 'capture-stop', 'capture-read', 'capture-clear', 'gpu-on', 'gpu-off', 'reset', 'boot', 'boot-reset'])
        .optional().describe('Default "read" (the live aggregate). capture-* record/read frames; gpu-* toggle GPU timestamps; reset clears markers + captures; boot reads the boot-phase timeline; boot-reset re-arms it.'),
      markers: z.number().optional().describe('action:read only — how many marker rows to return (default 12).'),
      limit: z.number().optional().describe('action:capture-read (worst frames, default 5, max 20) or action:boot (rows per section, default 15, max 200).'),
      all: z.boolean().optional().describe('action:boot only — return EVERY recorded span, not just the stall overlap and the costliest. Large.'),
    },
    async ({ action, markers, limit, all }) => {
      const act = action ?? 'read';
      // A read-only filter passed to a state-changing action is REFUSED, not silently dropped —
      // the cross-action hazard the conventions doc closed for `watch` (S3.19) rather than splitting
      // the tool name. Silently ignoring `markers` on `reset` would read as "12 markers kept".
      // Collect ALL stray filters, not just the first: an if/else chain named only one, so an agent
      // that followed `expected` literally would omit it, resubmit, and hit a second unwarned
      // refusal for the other. A refusal's job is to be the caller's next move, once.
      const stray = [
        ...(act !== 'read' && markers !== undefined ? [{ param: 'markers', belongsTo: 'read' }] : []),
        ...(act !== 'capture-read' && act !== 'boot' && limit !== undefined ? [{ param: 'limit', belongsTo: 'capture-read' }] : []),
        ...(act !== 'boot' && all !== undefined ? [{ param: 'all', belongsTo: 'boot' }] : []),
      ];
      if (stray.length) {
        const names = stray.map((s) => `\`${s.param}\``).join(' and ');
        return fail({
          code: 'UNKNOWN_PARAM',
          tool: 'modoki_profiler',
          what: `run profiler action '${act}' with ${names}`,
          why: `${names} ${stray.length > 1 ? 'are read-side filters' : `is a read-side filter for action:'${stray[0].belongsTo}'`} and mean${stray.length > 1 ? '' : 's'} nothing for '${act}'. Silently dropping ${stray.length > 1 ? 'them' : 'it'} would read as though ${stray.length > 1 ? 'they had' : 'it had'} been applied.`,
          expected: `omit ${names}${stray.length > 1 ? '' : `, or use action:'${stray[0].belongsTo}'`}`,
          options: stray.map((s) => `${s.param} applies only to action:'${s.belongsTo}'`),
        });
      }
      if (act === 'read' || act === 'capture-read' || act === 'boot') {
        const qs = new URLSearchParams({ action: act });
        if (markers !== undefined) qs.set('markers', String(markers));
        if (limit !== undefined) qs.set('limit', String(limit));
        if (all !== undefined) qs.set('all', String(all));
        return getJson(`/api/profiler?${qs.toString()}`);
      }
      return postJson('/api/profiler', { action: act });
    },
  );

  // ── Percept Watch: numeric time-series over the live world ──
  tool(
    'modoki_watch',
    'Percept WATCH — a standing, change-detected numeric time-series over the live world. The way ' +
      'to see how a NUMBER moved over time (jump overshoot, spring settle, velocity decay, a bone ' +
      'trajectory) — the animation/physics feel questions you cannot judge from a screenshot. ' +
      'action:start opens a focused watch (one component, optional guid/NAME/field subset); a value ' +
      'is recorded only when it moves > epsilon (settled things record nothing). ' +
      'SCOPE by `names` (case-insensitive substrings) for a runtime-spawned, short-lived entity whose ' +
      'GUID changes every spawn (e.g. a projectile re-instantiated each launch): new matches AUTO-JOIN ' +
      'by name, so you do not need a stable guid, and the series cardinality cap is spent only on ' +
      'matches. `guids` scopes to exact guids (fails if all are stale). Neither = every entity with the ' +
      'component (movers are prioritized over static entities if the cap is hit). ' +
      'action:read returns per-field summary STATS (first/last/min/max/delta/settled) + each series\' ' +
      'entity `name` — usually the whole answer. Pass samples=true for the raw series when you need the ' +
      'curve shape; narrow a broad watch at read time with name=/guids=/limit=. ' +
      'action:list / action:clear manage them. Editor-only; press Play, watch, read, then clear. ' +
      'Params are per-ACTION: a read-time filter (name/limit/clear/samples) on a START call is ' +
      'REFUSED naming `names:[…]` rather than silently dropped (which would widen the watch to every ' +
      'entity with the component), and start-time params on a read/list/clear call are refused too.',
    {
      action: z.enum(['start', 'read', 'list', 'clear']).describe('start a watch | read its series+stats | list active watches | clear one/all'),
      component: z.string().optional().describe('(start) Component whose numeric fields to sample, e.g. Transform, RigidBody2D, SkeletalAnimator.'),
      guids: z.array(z.string()).optional().describe('(start) Restrict to these entity GUIDs (start FAILS if all are stale). (read) Filter the returned series to these guids. Omit both guids+names at start to watch EVERY entity with the component.'),
      names: z.array(z.string()).optional().describe('(start) Scope to entities whose authored NAME contains any of these (case-insensitive). New spawns matching a name AUTO-JOIN — the handle for a runtime-spawned entity whose GUID changes every launch (a fresh-guid projectile/puck). Does NOT fail on zero current matches (they may spawn later); the reply reports matchedNow.'),
      fields: z.array(z.string()).optional().describe('(start) Restrict to these numeric fields; omit for all numeric fields of the component.'),
      epsilon: z.number().optional().describe('(start) Change threshold — record only when a value moves more than this. Default 1e-4.'),
      everyNFrames: z.number().int().positive().optional().describe('(start) Sample every Nth frame (decimation). Default 1.'),
      maxSamples: z.number().int().positive().optional().describe('(start) Ring cap per series. Default 600.'),
      maxSeries: z.number().int().positive().optional().describe('(start) Cap on MOVING series — max distinct (entity,field) series that record movement. Default 512, max 4096. A static/never-moved entity does NOT consume this budget (its baseline is kept cheaply), so a screen of static tiles can\'t crowd out a late-joining mover (e.g. a projectile spawned mid-scene).'),
      expireFrames: z.number().int().nonnegative().optional().describe('(start) Auto-remove the watch after N observed frames (0 = never). Default 0.'),
      id: z.string().optional().describe('(read/clear) Watch id from start/list. Omit on clear to clear ALL.'),
      name: z.string().optional().describe('(read) Filter the returned series to entities whose name contains this (case-insensitive) — isolate one entity in a broad watch. `seriesTotal` still reports the full match count.'),
      limit: z.number().int().nonnegative().optional().describe('(read) Cap the number of series returned (sets seriesTruncated when it drops some). Pair with name=/guids= on a broad watch so the response does not blow the cap.'),
      clear: z.boolean().optional().describe('(read) Clear the series THIS CALL RETURNED (not the whole watch — a read is capped/filterable, so the ones you did not see keep their samples). The reply echoes `cleared` + `clearedScope`.'),
      samples: z.boolean().optional().describe('(read) Include the RAW time-series per field. Default false — read returns stats only. A full read is ~40 chars/sample and the caps allow 512 series x 5000 samples, so ask for samples only when the stats are not enough (e.g. plotting the curve shape).'),
      precision: precisionParam(),
    },
    async (args) => {
      const { action, component, guids, names, fields, epsilon, everyNFrames, maxSamples, maxSeries, expireFrames, id, name, limit, clear, samples, precision } = args;
      // S3.19 — CROSS-ACTION KEYS. All four actions share one flat shape (there is no way to
      // express "these params only with action:'start'" in a single zod object), so `.strict()`
      // cannot catch `name:'puck'` on a START call: it is a real param of this tool, just of the
      // READ half. The start branch forwarded only the start keys, so the scoping was DROPPED and
      // the caller got a watch over EVERY entity carrying the component, reported ok:true.
      //
      // This is an ALLOWLIST PER ACTION, not two "X-only" deny lists (independent review,
      // 2026-07-30). The deny-list form was asymmetric — READ_ONLY strays were checked only on
      // 'start', START_ONLY strays only on everything else — so any key in NEITHER list was
      // neither refused nor forwarded, i.e. silently dropped: the exact class S3.19 claims to
      // close. Four keys were in that gap. `names` on a read returned EVERY series with ok:true;
      // a read-side scope key on `clear` made a scoped clear into a clear-ALL, reported as
      // success. An allowlist cannot have a gap: a key is accepted by this action or refused.
      const ACCEPTS: Record<string, readonly string[]> = {
        start: ['component', 'guids', 'names', 'fields', 'epsilon', 'everyNFrames', 'maxSamples', 'maxSeries', 'expireFrames'],
        read: ['id', 'name', 'guids', 'limit', 'clear', 'samples', 'precision'],
        list: [],
        clear: ['id'],
      };
      const accepted = new Set<string>([...(ACCEPTS[action] ?? []), 'action']);
      const stray = Object.keys(args).filter((k) => (args as Record<string, unknown>)[k] !== undefined && !accepted.has(k));
      if (stray.length) {
        const where = (k: string) => Object.entries(ACCEPTS)
          .filter(([a, keys]) => a !== action && keys.includes(k))
          .map(([a]) => `action:'${a}'`);
        return ctx.fail({
          code: 'UNKNOWN_PARAM',
          what: action === 'start' ? `open a watch on ${component ?? 'a component'}` : `${action} a watch`,
          why:
            `${stray.join(', ')} ${stray.length > 1 ? 'are' : 'is'} not accepted by action:'${action}' — ` +
            `${stray.length > 1 ? 'they' : 'it'} would be silently dropped, and the call would ` +
            (action === 'start'
              ? 'watch EVERY entity carrying the component.'
              : action === 'clear'
                ? 'clear EVERY watch, not the scope you named.'
                : 'return EVERY series, unfiltered.'),
          got: Object.fromEntries(stray.map((k) => [k, (args as Record<string, unknown>)[k]])),
          expected: `action:'${action}' accepts: ${ACCEPTS[action]?.length ? ACCEPTS[action].join(', ') : '(no params beyond action)'}`,
          options: stray.map((k) => {
            // `name` vs `names` FIRST: they are the one genuine near-miss pair, and a caller who
            // passed the wrong one almost always wants this action's sibling, not the other action.
            // (Checked before the generic branch below, which would otherwise answer the less
            // useful "pass it on action:'read' instead" for `name` on a start.)
            if (k === 'name' && action === 'start') return 'names:["…"] — the START-time scope you meant (array, substring match, auto-joins new spawns)';
            if (k === 'names' && action === 'read') return 'name:"…" — the READ-time filter you meant (single substring)';
            const other = where(k);
            if (other.length) return `${k} — pass it on ${other.join(' or ')} instead`;
            return `${k} — not a parameter of this action`;
          }),
        });
      }
      if (action === 'start') return postJson('/api/watch/start', { component, guids, names, fields, epsilon, everyNFrames, maxSamples, maxSeries, expireFrames });
      if (action === 'read') {
        const q = new URLSearchParams({ id: id ?? '' });
        if (clear) q.set('clear', '1');
        if (samples) q.set('samples', '1');
        if (name) q.set('name', name);
        if (guids?.length) q.set('guids', guids.join(','));
        if (limit != null) q.set('limit', String(limit));
        if (precision != null) q.set('precision', String(precision));
        return getJson(`/api/watch/read?${q.toString()}`);
      }
      if (action === 'list') return getJson('/api/watch/list');
      return postJson('/api/watch/clear', { id });
    },
  );

  // ── Input WATCH: what the pointer actually did (#134) ──
  tool(
    'modoki_input_watch',
    'Input WATCH — a bounded record of what the POINTER actually did, and what it resolved to. ' +
      'The journal answers "what did the game do"; this answers "what did the finger do" — the ' +
      'question with the LEAST evidence when a gesture fails (a press that resolves to nothing ' +
      'emits no journal event, no commit, no coordinates). action:start opens the window; it ' +
      'RECORDS NOTHING BEFORE THAT CALL — no history, same contract as journal @contact capture. ' +
      'action:read returns the most-recent presses (down/up points, distance travelled, hold time, ' +
      'move-sample count, and what — if anything — the press resolved to). This is the ONLY tool ' +
      'that can tell "the press hit nothing" (`resolved.by:\'none\'` — an authority looked and found ' +
      'nothing there) apart from "nothing could answer" (`resolved.by:\'unknown\'` — nobody who ' +
      'could look was asked); everything else either infers from absence or conflates the two. ' +
      'action:stop closes the window but KEEPS what was recorded, so you can stop then read without ' +
      'racing your own probe. action:clear drops recorded presses without closing the window. ' +
      'Params are per-ACTION: a read-time filter on a START call (or `max` on anything but start) is ' +
      'REFUSED naming the right action rather than silently dropped.',
    {
      action: z.enum(['start', 'read', 'stop', 'clear']).describe('open the window | read presses | close (keeps presses) | drop recorded presses (window stays open if it was)'),
      max: z.number().int().positive().optional().describe('(start) Ring capacity — most recent N presses kept (default 40, ceiling 500).'),
      limit: z.number().int().positive().optional().describe('(read) Most-recent N presses to return (default 20).'),
      unresolvedOnly: z.boolean().optional().describe("(read) Keep only presses whose resolved.by is 'none' or 'unknown' — presses NOTHING could explain. THE diagnostic filter: this is the one question this tool exists to answer, so start here when a reported gesture apparently did nothing."),
      precision: precisionParam('x/y/upX/upY/maxD/heldMs'),
    },
    async (args) => {
      const { action, max, limit, unresolvedOnly, precision } = args;
      // Per-action allowlist (mirrors modoki_watch's S3.19 fix) — a key belonging to a DIFFERENT
      // action is refused BY NAME, never silently dropped (which would either widen a start to the
      // default ring size unexpectedly or ignore a read-time narrow).
      const ACCEPTS: Record<string, readonly string[]> = {
        start: ['max'],
        read: ['limit', 'unresolvedOnly', 'precision'],
        stop: [],
        clear: [],
      };
      const accepted = new Set<string>([...(ACCEPTS[action] ?? []), 'action']);
      const stray = Object.keys(args).filter((k) => (args as Record<string, unknown>)[k] !== undefined && !accepted.has(k));
      if (stray.length) {
        return ctx.fail({
          code: 'UNKNOWN_PARAM',
          what: `${action} the input watch`,
          why: `${stray.join(', ')} ${stray.length > 1 ? 'are' : 'is'} not accepted by action:'${action}'.`,
          got: Object.fromEntries(stray.map((k) => [k, (args as Record<string, unknown>)[k]])),
          expected: `action:'${action}' accepts: ${ACCEPTS[action]?.length ? ACCEPTS[action].join(', ') : '(no params beyond action)'}`,
          options: stray.map((k) => {
            const other = Object.entries(ACCEPTS).filter(([a, keys]) => a !== action && keys.includes(k)).map(([a]) => `action:'${a}'`);
            return other.length ? `${k} — pass it on ${other.join(' or ')} instead` : `${k} — not a parameter of this action`;
          }),
        });
      }
      if (action === 'start') return postJson('/api/input-watch/start', { max });
      if (action === 'stop') return postJson('/api/input-watch/stop', {});
      if (action === 'clear') return postJson('/api/input-watch/clear', {});
      const q = new URLSearchParams();
      if (limit != null) q.set('limit', String(limit));
      if (unresolvedOnly) q.set('unresolvedOnly', '1');
      if (precision != null) q.set('precision', String(precision));
      const qs = q.toString();
      return getJson(`/api/input-watch/read${qs ? `?${qs}` : ''}`);
    },
  );

  // ── Hit REGIONS: the shapes the hit-test uses (#139) ──
  tool(
    'modoki_hit_regions',
    'Hit REGIONS — the shapes a game\'s hitTest actually uses, which are AUTHORED NOWHERE: they are ' +
      'computed inside the hit-test from config, so no inspector, scene view or screenshot can show ' +
      'them. The companion to modoki_input_watch: that one says a press hit nothing, this one says ' +
      'WHAT it missed and BY HOW MUCH. action:read returns the regions as data (viewport CSS px — ' +
      'the same space the input watch records presses in, so they compare with no transform). ' +
      'action:show/hide toggles an on-screen overlay that draws the shapes AND plots the last few ' +
      'recorded presses, green inside a region and red outside — the two failure classes made ' +
      'visually distinct (a press outside every shape = targeting; a press inside the right shape ' +
      'that still did nothing = latching/frame-rate). Pass at:{x,y} to ask the question directly: ' +
      'it reports which regions contain that point, and when none do, the NEAREST region and its ' +
      'distance in px. A region may carry `drawnShape` when the game DRAWS a different shape than ' +
      'it hit-tests (a forgiving grab radius, a badge smaller than its ring) — that difference is ' +
      'usually the bug. READ `providers`: an empty region list with no provider registered means ' +
      'NOBODY COULD ANSWER, which is not the same as "there is nothing there". ' +
      '⚠️ A shape\'s `x`/`y` is its CENTRE on EVERY type, `rect` included — a rect is ' +
      '(centre, w, h), NOT (top-left, w, h), the opposite of get_layout_bounds\' `screen` rect ' +
      'and of a DOM rect. To aim at a region pass its `x`/`y` UNCHANGED; the reflex `x + w/2` ' +
      'lands half a cell down-right, which on a grid is exactly the boundary and resolves to the ' +
      'NEIGHBOURING cell.',
    {
      action: z.enum(['read', 'show', 'hide']).optional().describe("read the regions as data (default) | show the on-screen overlay | hide it"),
      provider: z.string().optional().describe('(read) Only this provider\'s regions (a game id, e.g. "court").'),
      kind: z.string().optional().describe('(read) Only this region kind — usually the same string the game\'s own hit-test reports, so it lines up with an input_watch record\'s resolved.kind.'),
      ids: z.array(z.string()).optional().describe('(read) Only these region ids.'),
      at: z.object({ x: z.number(), y: z.number() }).optional().describe('(read) A viewport CSS point to test. Returns hitsAt (regions containing it) and, when empty, nearest {id, kind, label, distancePx}. Feed a press coordinate straight from modoki_input_watch.'),
      limit: z.number().int().positive().optional().describe('(read) Max regions returned (default 60). A full board is many cells; filter by kind= first.'),
      precision: precisionParam(),
    },
    async (args) => {
      const { action = 'read', provider, kind, ids, at, limit, precision } = args;
      // Per-action allowlist, matching modoki_input_watch: a read-time filter on show/hide is
      // refused by name rather than silently dropped, which would read as "the filter applied".
      if (action !== 'read') {
        const stray = ['provider', 'kind', 'ids', 'at', 'limit', 'precision']
          .filter((k) => (args as Record<string, unknown>)[k] !== undefined);
        if (stray.length) {
          return ctx.fail({
            code: 'UNKNOWN_PARAM',
            what: `${action} the hit-region overlay`,
            why: `${stray.join(', ')} ${stray.length > 1 ? 'are' : 'is'} not accepted by action:'${action}' — it only toggles the overlay.`,
            got: Object.fromEntries(stray.map((k) => [k, (args as Record<string, unknown>)[k]])),
            expected: `action:'${action}' accepts no params beyond action`,
            options: [`pass ${stray.join(', ')} on action:'read' instead`],
          });
        }
      }
      const q = new URLSearchParams();
      q.set('action', action);
      if (provider) q.set('provider', provider);
      if (kind) q.set('kind', kind);
      if (ids?.length) q.set('ids', ids.join(','));
      if (at) { q.set('atX', String(at.x)); q.set('atY', String(at.y)); }
      if (limit != null) q.set('limit', String(limit));
      if (precision != null) q.set('precision', String(precision));
      // `show`/`hide` MUTATE (they flip the on-screen overlay), and this route is GET-only —
      // there is no POST branch to fall into (editorBackendRouter.ts, one `method === 'GET'` arm).
      // So `ok` is a SUCCESS FLAG for them, not an answer, and it has to be checked: without this
      // a refused toggle came back `200 {ok:false}` on a SUCCESSFUL tool call — the §0 rank-1 false
      // success — while both sibling mutating GETs (`journal`, `editor_journal`) already checked
      // theirs. It hid behind a `varies:'both'` declaration that was simply untrue, which exempted
      // this tool from all three of `mcpToolContracts.test.ts`'s mutating-GET guards.
      //
      // `action:'read'` keeps the default (no check): it is a plain read, where `ok` may be the
      // answer, and flipping that would break the C7 convention for it.
      return getJson(`/api/hit-regions?${q.toString()}`, undefined, action !== 'read');
    },
  );
}
