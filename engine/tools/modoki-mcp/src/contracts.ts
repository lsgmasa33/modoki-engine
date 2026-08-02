/** The per-tool CONTRACT table — one machine-readable fact set per `modoki_*` tool.
 *
 *  WHY THIS EXISTS: four different consumers were each re-deriving the same facts about a tool,
 *  from source, by hand, and drifting: the batch pre-flight (which tools are refused), the docs
 *  (`docs/debug-tools-mcp.md`'s catalog), the conformance tests, and the GET/POST convention
 *  guard. A fact about a tool now lives HERE, once, and everything else reads it — the same rule
 *  the docs follow. Rationale + the findings it came out of: `docs/mcp-tool-conventions.md` §10 and
 *  `docs/reviews/2026-07-30-mcp-tool-audit.md`.
 *
 *  WHAT IS DECLARED vs WHAT IS OBSERVED: `method`/`route`/`op` are declared here AND asserted
 *  against what the handler actually sends (`engine/tests/tools/mcpToolContracts.test.ts` calls
 *  every tool against a stub backend). A declaration alone can lie; an observation alone has
 *  nothing to check against. Together, a tool that silently changes route fails the build.
 *
 *  `minimalArgs` is the SMALLEST VALID CALL — deliberately the ergonomic form, not a defensive
 *  one. That choice is load-bearing: all nine bugs the batch usability pass found hid behind the
 *  defensive form a test naturally writes (an explicit `path`, an explicit `{x,y}`, an explicit
 *  `result:'full'`). A fixture that passes everything tests nothing.
 *
 *  Side-effect-free — see `context.ts`.
 */

export type ToolKind =
  /** Answers a question about state. Must not change anything. */
  | 'read'
  /** Changes the scene/world/asset data. */
  | 'mutate'
  /** Trusted input injection (Enact). */
  | 'input'
  /** Drives the editor session (selection, play state, panels) without editing scene data. */
  | 'control'
  /** Reads or writes an asset definition. */
  | 'asset'
  /** Long-running toolchain work (build, native scaffold, OTA). */
  | 'build'
  /** Operates on the tool surface itself rather than the editor (`modoki_batch`). */
  | 'meta';

/** Where a successful call's effect ends up. `live` = the running world only, so it is undoable
 *  and is LOST on a scene swap; `file` = written to disk; `both` = live edit plus a disk write;
 *  `session` = EDITOR-SESSION state (selection, gizmo mode, view mode, watchers) — undoable and
 *  observable, but not scene data and never written to disk.
 *
 *  `session` exists because the first version of this table could not express `set_selection`:
 *  undoable, yet persisting nothing. Collapsing it into `none` would have made "undoable ⇒ has a
 *  live effect" unstateable, and that rule is how a mutating tool that forgot its undo entry gets
 *  caught. */
export type Persists = 'none' | 'live' | 'file' | 'both' | 'session';

/** What must be true for the call to work at all. A missing requirement should produce a NAMED
 *  refusal, never a timeout or a silent no-op. */
export type Requirement = 'editor' | 'renderer' | 'project' | 'scene' | 'electron';

/** How the tool is pointed at its target. `docs/enact.md`: aim by NAME, never by pixels. */
export type Aim = 'entity' | 'selector' | 'handle' | 'point' | 'asset' | 'none';

export type ToolContract = {
  kind: ToolKind;
  /** null ⇒ makes no backend call of its own (`modoki_batch` delegates; `modoki_identity`
   *  answers from the once-per-process identity probe). */
  method: 'GET' | 'POST' | null;
  route: string | null;
  /** The `/api/editor-action` op name, when the route is the action relay. Omitted when the op is
   *  CALLER-SUPPLIED (`modoki_play_control`, `modoki_history` pass their zod-restricted `action`
   *  straight through as the op) — see `opVaries`. */
  op?: string;
  /** The op name comes from an argument, so there is no single op to declare or assert. */
  opVaries?: boolean;
  /** The method and/or route depend on an ARGUMENT, so `method`/`route` above describe only what
   *  `minimalArgs` produces. Declared so the variance is a documented fact rather than a surprise
   *  — a caller reading the table must not conclude a tool is GET-only when `action:'set'` makes
   *  it a POST. */
  varies?: 'method' | 'route' | 'both';
  mutating: boolean;
  /** A human's Cmd-Z unwinds this as ONE step. */
  undoable: boolean;
  persists: Persists;
  requires: Requirement[];
  aim: Aim;
  /** Params that NARROW the response. A `read` tool with a large payload must have at least one
   *  (`docs/mcp-response-budget.md`: summary-first, and the hint names the filter to reach for). */
  filters: string[];
  /** Smallest VALID call. `{}` when every param is optional. */
  minimalArgs: Record<string, unknown>;
  /** Does the `minimalArgs` form ITSELF mutate? Defaults to `mutating`.
   *
   *  `mutating` answers "does this tool have a mutating form"; the live sweep needs the different
   *  question "is the smallest call safe to make against the human's open editor". They diverge for
   *  a tool with a read half and a write half — `modoki_project_settings` (`action:'get'` is a GET,
   *  `action:'set'` rewrites project.config.json) and `modoki_watch` (`action:'list'` reads,
   *  `start`/`clear` change watcher state).
   *
   *  Keeping one flag for both made the partition CIRCULAR (independent review, 2026-07-30): the
   *  sweep took `!mutating` as "safe", and the coverage ledger only partitions `mutating` tools —
   *  so `modoki_project_settings`, declared non-mutating despite writing to disk, was swept as safe
   *  AND structurally exempt from the ledger. Its write half was in no bucket and no guard could
   *  see the hole. Splitting the questions means an honest `mutating:true` no longer costs the tool
   *  its safe-form sweep coverage, so there is no incentive to under-declare. */
  minimalArgsMutates?: boolean;
  /** The call shape in which `filters` actually APPLY, when that is not `minimalArgs`.
   *
   *  Only multi-action tools need it: `modoki_watch`'s smallest call is `action:'list'`, but the
   *  action that can over-cap — and so the one whose filters the narrow-hint advertises — is
   *  `read`. Without this the filter guard would probe the wrong action and either pass
   *  vacuously or fail on a correct declaration. Omit for single-shape tools. */
  filterArgs?: Record<string, unknown>;
  notes?: string;
};

type Defaulted = 'mutating' | 'undoable' | 'persists' | 'requires' | 'aim' | 'filters' | 'minimalArgs';
type Decl = Omit<ToolContract, Defaulted> & Partial<Pick<ToolContract, Defaulted>>;

/** Read-only, editor-bound, unaimed, no-op-on-disk — the common case, so it is the default and
 *  only the exceptions are spelled out below. */
const norm = (d: Decl): ToolContract => ({
  mutating: false,
  undoable: false,
  persists: 'none',
  requires: ['editor'],
  aim: 'none',
  filters: [],
  minimalArgs: {},
  ...d,
});

/** Shared by every `entitySpec`-aimable input tool (tap/drag/pointer/hover/scroll) — one string so
 *  the occlusion-scope behaviour can't drift per tool description (F15, docs/enact.md). */
const TARGET_ENTITY_OCCLUSION_NOTE =
  "An `entity` aim at a 2D/3D target on a surface with a registered pick provider "
  + "(`occlusionScope:'entity'`) is REFUSED (400) when the surface's own hit-test says something "
  + 'else is in front of it — "click the character" fails if the game would not select that '
  + "character. Pass `entity.allowOccluded:true` to dispatch anyway and see what happens. A "
  + "surface with no pick provider keeps the honest `occlusionScope:'canvas'` fallback (entity-vs-"
  + 'entity occlusion inside the canvas is NOT checked there) — see `docs/enact.md`.';

const DECLS: Record<string, Decl> = {
  // ── meta ──
  modoki_batch: {
    kind: 'meta', method: null, route: null, mutating: true, persists: 'live',
    minimalArgs: { steps: [{ tool: 'wait', args: { ms: 1 } }] },
    notes: 'Delegates to each step; its own effect is whatever the steps do. Undo is PER STEP, not per batch.',
  },

  // ── scene + asset read/write ──
  modoki_get_scene_state: {
    kind: 'read', method: 'GET', route: '/api/scene-state',
    requires: ['editor', 'scene'],
    filters: ['id', 'guid', 'name', 'trait', 'where', 'limit'],
  },
  modoki_mutate_scene: {
    kind: 'mutate', method: 'POST', route: '/api/scene-mutate',
    mutating: true, undoable: true, persists: 'live', requires: ['editor', 'scene'], aim: 'entity',
    minimalArgs: { ops: [{ op: 'addEntity', name: 'ContractProbe', parentId: 0 }] },
    notes: 'Path defaults to the ACTIVE scene via activeScenePath (reads /api/editor-state first).',
  },
  modoki_set_transform: {
    kind: 'mutate', method: 'POST', route: '/api/scene-mutate',
    mutating: true, undoable: true, persists: 'live', requires: ['editor', 'scene'], aim: 'entity',
    minimalArgs: { entity: { name: 'ContractProbe' }, space: 'local', position: [1, 2, 3] },
    notes: "Routes a prefab-instance edit into its overrides, where a plain setTrait is ignored. `space` is REQUIRED (no default): it was documented as 'World' while writing LOCAL fields, and a default would relocate that mistake into the caller's head rather than removing it.",
  },
  modoki_validate_scene: {
    kind: 'read', method: 'GET', route: '/api/validate-scene', requires: ['project'], aim: 'asset',
    minimalArgs: { path: '/assets/scenes/main.scene.json' },
    notes: 'C7: reports findings in `warnings`; `ok:false` is an ANSWER (unhealthy scene), not a failed call.',
  },
  modoki_list_traits: {
    kind: 'read', method: 'GET', route: '/api/trait-schema', filters: ['name'],
  },
  modoki_list_assets: {
    kind: 'read', method: 'GET', route: '/api/scan-assets', requires: ['project'],
    filters: ['type', 'name', 'folder', 'limit'],
  },
  modoki_get_asset_meta: {
    kind: 'read', method: 'GET', route: '/api/read-meta', requires: ['project'], aim: 'asset',
    minimalArgs: { path: '/assets/textures/probe.png' },
  },
  modoki_reimport_asset: {
    kind: 'asset', method: 'POST', route: '/api/reimport',
    mutating: true, persists: 'file', requires: ['project'], aim: 'asset',
    minimalArgs: { path: '/assets/textures/probe.png' },
    notes: 'Partial success is a 200 with a non-empty errors[] — deliberately NOT a failed call.',
  },

  // ── visual capture ──
  modoki_capture_viewport: {
    kind: 'read', method: 'POST', route: '/api/capture-viewport', requires: ['editor', 'electron'],
    notes: 'FORCES a render, so it MASKS render-on-demand + stale-frame bugs. Use CDP for a true framebuffer.',
  },
  modoki_render_scene: {
    kind: 'read', method: 'POST', route: '/api/render-scene', requires: ['editor', 'renderer', 'scene'],
  },
  modoki_render_sequence: {
    kind: 'read', method: 'POST', route: '/api/render-sequence', requires: ['editor', 'renderer', 'scene'],
  },

  // ── Enact: trusted input ──
  modoki_tap: {
    kind: 'input', method: 'POST', route: '/api/input/tap', mutating: true, requires: ['editor', 'electron'], aim: 'entity',
    minimalArgs: { selector: '#probe' },
    notes: TARGET_ENTITY_OCCLUSION_NOTE,
  },
  modoki_drag: {
    kind: 'input', method: 'POST', route: '/api/input/drag', mutating: true, requires: ['editor', 'electron'], aim: 'entity',
    minimalArgs: { from: { selector: '#a' }, to: { selector: '#b' } },
    notes: TARGET_ENTITY_OCCLUSION_NOTE,
  },
  modoki_pointer: {
    kind: 'input', method: 'POST', route: '/api/input/pointer', mutating: true, requires: ['editor', 'electron'], aim: 'entity',
    minimalArgs: { action: 'down', selector: '#probe' },
    notes: TARGET_ENTITY_OCCLUSION_NOTE,
  },
  modoki_hover: {
    kind: 'input', method: 'POST', route: '/api/input/hover', mutating: true, requires: ['editor', 'electron'], aim: 'entity',
    minimalArgs: { selector: '#probe' },
    notes: TARGET_ENTITY_OCCLUSION_NOTE,
  },
  modoki_scroll: {
    kind: 'input', method: 'POST', route: '/api/input/scroll', mutating: true, requires: ['editor', 'electron'], aim: 'entity',
    minimalArgs: { selector: '#probe' },
    notes: TARGET_ENTITY_OCCLUSION_NOTE,
  },
  modoki_press_key: {
    kind: 'input', method: 'POST', route: '/api/input/key', mutating: true, requires: ['editor', 'electron'], aim: 'none',
    minimalArgs: { key: 'Escape' },
  },
  modoki_focus: {
    kind: 'input', method: 'POST', route: '/api/input/focus', mutating: true, requires: ['editor', 'electron'], aim: 'selector',
    minimalArgs: { selector: '#probe' },
  },
  modoki_type_text: {
    kind: 'input', method: 'POST', route: '/api/input/type', mutating: true, requires: ['editor', 'electron'], aim: 'none',
    minimalArgs: { text: 'probe' },
  },
  modoki_dnd: {
    kind: 'input', method: 'POST', route: '/api/editor-action', op: 'dom-dnd',
    mutating: true, requires: ['editor', 'electron'], aim: 'selector',
    minimalArgs: { from: { selector: '#a' }, to: { selector: '#b' } },
    notes: 'INCONSISTENT (documented, not fixable): the only input tool that goes through the action '
      + 'relay rather than /api/input/*, so it carries none of the shared matched/hitTarget/occluded '
      + 'provenance — and the ONLY input tool that cannot be aimed by entity, because HTML5 DnD is a '
      + "DOM-element protocol (the source element's own dragstart handler fills the DataTransfer). "
      + 'Its endpoints are strict + refined instead of the shared pointSpec for that reason (S3.6).',
  },
  modoki_handles: {
    kind: 'read', method: 'GET', route: '/api/enact-handles', requires: ['editor'],
    // All THREE filters, not just `kind` — the over-cap hint and the docs catalog are both built
    // from this list, so a missing one is a filter the agent is never told about (S3.10).
    filters: ['editor', 'kind', 'ids'],
  },
  modoki_tap_handle: {
    kind: 'input', method: 'POST', route: '/api/input/tap-handle',
    mutating: true, requires: ['editor', 'electron'], aim: 'handle',
    minimalArgs: { id: 'probe-handle' },
  },
  modoki_drag_handle: {
    kind: 'input', method: 'POST', route: '/api/input/drag-handle',
    mutating: true, requires: ['editor', 'electron'], aim: 'handle',
    minimalArgs: { id: 'probe-handle', to: { x: 10, y: 10 } },
  },
  modoki_menu: {
    kind: 'control', method: 'POST', route: '/api/menu', mutating: true, persists: 'session', requires: ['editor', 'electron'],
  },
  modoki_eval: {
    kind: 'control', method: 'POST', route: '/api/eval', mutating: true, requires: ['editor', 'renderer'],
    minimalArgs: { code: 'return 1 + 1;' },
    notes: '#19: code runs as `new Function("modoki", code)` — the injected `modoki` object gives full op-registry + '
      + 'backendFetch access (see modoki_eval_api for the surface). Escape hatch, unvalidated by design; the older '
      + '"dynamic import yields 19 of 55 ops" half-support this replaced is gone.',
  },
  modoki_eval_api: {
    kind: 'read', method: 'GET', route: '/api/eval-api', requires: ['editor', 'renderer'],
    notes: 'Discovery for modoki_eval — lists every op as its generated modoki.<camelCase>(params) method, plus call/ops/api/composite.',
  },

  // ── editor session + scene/entity ops ──
  modoki_get_editor_state: { kind: 'read', method: 'GET', route: '/api/editor-state' },
  modoki_persistence: {
    kind: 'control', method: 'POST', route: '/api/persistence', mutating: true,
  },
  modoki_editor_journal: {
    kind: 'read', method: 'GET', route: '/api/editor-journal',
    mutating: true, persists: 'session',
    filters: ['type', 'source', 'since', 'limit'],
    notes: 'IMPURE READ, and a mutating GET: clear:true empties the editor-activity buffer via GET.',
  },
  modoki_wait_for_edit: {
    kind: 'read', method: 'GET', route: '/api/wait-for-edit',
    filters: ['type', 'source', 'since'],
    minimalArgs: { timeoutMs: 50 },
    notes: 'BLOCKS for up to timeoutMs (default 30s, max 120s) — minimalArgs pins timeoutMs=50 '
      + 'so the live sweep returns almost immediately instead of stalling on a quiet editor. '
      + 'A timeout is a normal {timedOut:true} answer, not a failure.',
  },
  modoki_set_selection: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'set-selection',
    mutating: true, undoable: false, persists: 'session', aim: 'entity',
    notes: 'A bare call CLEARS the selection — the shape that made a misspelled arg key destructive. '
      + 'NOT undoable: the agent path writes selection RAW (agentEditorOps.ts setSelectionRaw) so an '
      + 'agent selecting does not pollute the human undo stack — unlike the HUMAN Hierarchy click, '
      + "which DOES push one (CLAUDE.md's \"selection changes push individual undo entries\" is about that path).",
  },
  modoki_play_control: {
    kind: 'control', method: 'POST', route: '/api/editor-action', opVaries: true,
    mutating: true, persists: 'session',
    minimalArgs: { action: 'stop' },
    notes: 'The op IS the caller-supplied action (play|stop|pause|resume|step), zod-restricted at the boundary.',
  },
  modoki_history: {
    kind: 'control', method: 'POST', route: '/api/editor-action', opVaries: true,
    mutating: true, persists: 'live',
    minimalArgs: { action: 'undo' },
    notes: 'The op IS the caller-supplied action (undo|redo).',
  },
  modoki_list_scenes: { kind: 'read', method: 'GET', route: '/api/scenes', requires: ['project'] },
  modoki_load_scene: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'load-scene',
    mutating: true, persists: 'live', requires: ['editor', 'project'], aim: 'asset',
    minimalArgs: { path: '/assets/scenes/main.scene.json' },
    notes: 'SWAPS THE WORLD: refuses while unsaved live changes exist (they would be destroyed). force to discard.',
  },
  modoki_new_scene: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'new-scene',
    mutating: true, persists: 'live', requires: ['editor', 'project'],
    notes: 'Same unsaved-work refusal as load-scene.',
  },
  modoki_save_all: {
    kind: 'mutate', method: 'POST', route: '/api/editor-action', op: 'save-all',
    mutating: true, persists: 'file',
    notes: 'The ONLY route from a live edit to disk — persistence is manual.',
  },
  modoki_discard_asset_edits: {
    kind: 'mutate', method: 'POST', route: '/api/editor-action', op: 'discard-asset-edits',
    mutating: true, undoable: false, persists: 'session', requires: ['editor'],
    minimalArgs: { all: true },
    notes: 'The counterpart to save_all for PARKED ASSET WRITES — drops them instead of persisting. '
      + 'NOT undoable: the pending doc is gone, which is why a bare call is refused and the caller '
      + 'must name `paths` or say `all:true`. Drops the WRITE, not the edit — the editor cache keeps '
      + 'the applied def until the asset reloads.',
  },
  modoki_create_entity: {
    kind: 'mutate', method: 'POST', route: '/api/editor-action', op: 'create-entity',
    mutating: true, undoable: true, persists: 'live', requires: ['editor', 'scene'],
    minimalArgs: { kind: 'empty' },
  },
  modoki_duplicate_entity: {
    kind: 'mutate', method: 'POST', route: '/api/editor-action', op: 'duplicate-entity',
    mutating: true, undoable: true, persists: 'live', requires: ['editor', 'scene'], aim: 'entity',
  },
  modoki_delete_entities: {
    kind: 'mutate', method: 'POST', route: '/api/editor-action', op: 'delete-entities',
    mutating: true, undoable: true, persists: 'live', requires: ['editor', 'scene'], aim: 'entity',
  },
  modoki_reparent_entity: {
    kind: 'mutate', method: 'POST', route: '/api/editor-action', op: 'reparent-entity',
    mutating: true, undoable: true, persists: 'live', requires: ['editor', 'scene'], aim: 'entity',
  },
  modoki_prefab: {
    kind: 'mutate', method: 'POST', route: '/api/editor-action', op: 'prefab',
    mutating: true, undoable: true, persists: 'both', requires: ['editor', 'scene'], aim: 'entity',
    minimalArgs: { action: 'instantiate', path: '/assets/prefabs/probe.prefab.json' },
    notes: 'Sends `prefabAction` on the wire: the relay STRIPS a param named `action`. '
      + "persists:'both' because action:'create' WRITES the .prefab.json (writePrefabFile) while "
      + 'instantiate/detach/apply/revert are live-only; the undo entry covers the live tagging only, '
      + 'never the file write (undoing an overwrite would destroy an asset the agent never created).',
  },
  modoki_gizmo: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'set-gizmo', mutating: true, persists: 'session',
  },
  modoki_scene_view_mode: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'set-scene-view-mode', mutating: true, persists: 'session',
    minimalArgs: { mode: '3d' },
  },
  modoki_collider_edit: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'set-collider-edit', mutating: true, persists: 'session',
    minimalArgs: { on: true },
  },
  modoki_open_particle_editor: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'open-particle-editor',
    mutating: true, aim: 'asset', minimalArgs: { path: '/assets/particles/probe.particle.json' },
  },
  modoki_open_sprite_editor: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'open-sprite-editor',
    mutating: true, aim: 'asset', minimalArgs: { path: '/assets/textures/probe.png' },
  },
  modoki_open_nine_slice_editor: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'open-nine-slice-editor',
    mutating: true, aim: 'asset', minimalArgs: { path: '/assets/textures/probe.png' },
  },
  modoki_focus_entity: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'focus-entity',
    mutating: true, requires: ['editor', 'scene'], aim: 'entity',
  },

  // ── project / toolchain ──
  modoki_identity: {
    kind: 'read', method: null, route: null,
    notes: 'Answers from the once-per-process identity probe. Call it FIRST when edits seem to vanish.',
  },
  modoki_get_console_logs: {
    kind: 'read', method: 'GET', route: '/api/console-logs', filters: ['level', 'limit', 'since'],
    notes: 'The clean comparison for the two journals: same job, purely a read, no clear mode.',
  },
  modoki_project_settings: {
    kind: 'control', method: 'GET', route: '/api/project-settings', varies: 'method',
    // `mutating` is about the tool, not the smallest call: action:'set' rewrites
    // project.config.json on disk. It was declared false, which both swept it as "safe" and
    // exempted it from the live-coverage ledger — see `minimalArgsMutates`.
    mutating: true, persists: 'file',
    minimalArgsMutates: false,
    requires: ['project'], minimalArgs: { action: 'get' },
    notes: "The ONLY tool whose HTTP METHOD depends on an argument: action:'get' is a GET, " +
      "action:'set' is a POST that mutates project.config.json — so half of it is a read and " +
      'half is a file write under one name.',
  },
  modoki_import_file: {
    kind: 'asset', method: 'POST', route: '/api/import-file',
    mutating: true, persists: 'file', requires: ['project'],
    minimalArgs: { srcPath: '/tmp/probe.png', destFolder: '/assets/textures' },
  },
  modoki_build: {
    kind: 'build', method: 'GET', route: '/api/build',
    mutating: true, persists: 'file', requires: ['project'],
    minimalArgs: { platform: 'web' },
    notes: 'A MUTATING op behind GET, DELIBERATELY (Phase 6 decision): it is an SSE stream, and the browser/EventSource + curl ergonomics that make a live build log readable are GET-only. the F3 concern does NOT apply — these tools never touch `getJson`; `consumeBuildStream` reads the stream and fails on a non-2xx open, an `event:status FAILED`, a mid-run break, AND a close with no final DONE/FAILED (outcome unknown is a failure, not a success). Also DENIED inside modoki_batch (a 30-min step cannot be bounded between steps).',
  },
  modoki_add_native_target: {
    kind: 'build', method: 'GET', route: '/api/add-native-target',
    mutating: true, persists: 'file', requires: ['project'],
    minimalArgs: { platform: 'ios' },
    notes: 'A MUTATING op behind GET, DELIBERATELY (Phase 6 decision): it is an SSE stream, and the browser/EventSource + curl ergonomics that make a live build log readable are GET-only. the F3 concern does NOT apply — these tools never touch `getJson`; `consumeBuildStream` reads the stream and fails on a non-2xx open, an `event:status FAILED`, a mid-run break, AND a close with no final DONE/FAILED (outcome unknown is a failure, not a success). 15-min SSE; also DENIED inside modoki_batch.',
  },
  modoki_ota_publish: {
    kind: 'build', method: 'GET', route: '/api/ota/publish',
    mutating: true, persists: 'file', requires: ['project'],
    minimalArgs: { version: '1.0.0' },
    notes: 'A MUTATING op behind GET, DELIBERATELY (Phase 6 decision): it is an SSE stream, and the browser/EventSource + curl ergonomics that make a live build log readable are GET-only. the F3 concern does NOT apply — these tools never touch `getJson`; `consumeBuildStream` reads the stream and fails on a non-2xx open, an `event:status FAILED`, a mid-run break, AND a close with no final DONE/FAILED (outcome unknown is a failure, not a success). It PUBLISHES, so it is the member of this set most worth watching: also DENIED inside modoki_batch.',
  },
  modoki_ota_status: { kind: 'read', method: 'GET', route: '/api/ota/status', requires: ['project'] },
  modoki_ota_keygen: {
    kind: 'build', method: 'POST', route: '/api/ota/keygen',
    mutating: true, persists: 'file', requires: ['project'],
  },

  // ── Percept over the running game ──
  modoki_journal: {
    kind: 'read', method: 'GET', route: '/api/journal',
    mutating: true, persists: 'session', requires: ['editor', 'renderer'],
    filters: ['type', 'level', 'limit'],
    notes: "IMPURE READ, and a mutating GET: action:'start'/'stop' opens/closes a Tier-2 capture " +
      'window and clear:true empties the 10,000-event ring — both via GET, so isFailureBody never ' +
      'checks them. No `since` filter, unlike modoki_editor_journal.',
  },
  modoki_resolve_refs: {
    kind: 'read', method: 'GET', route: '/api/resolve-refs', requires: ['project'],
    minimalArgs: { refs: ['00000000-0000-0000-0000-000000000000'] },
  },
  modoki_list_actions: {
    kind: 'read', method: 'GET', route: '/api/game-introspect', requires: ['editor', 'renderer'],
  },
  modoki_dispatch_action: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'dispatch-action',
    mutating: true, requires: ['editor', 'renderer'],
    minimalArgs: { name: 'probe' },
    notes: 'F1: declares BOTH `payload` and `params`, neither documented. Likely a real dedupe.',
  },
  modoki_play_clip: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'dispatch-action',
    mutating: true, requires: ['editor', 'renderer'], aim: 'entity',
    minimalArgs: { guid: '00000000-0000-0000-0000-000000000000', clip: 'Idle' },
    notes: 'Routes through the GENERIC dispatch-action op rather than one of its own.',
  },
  modoki_get_layout_bounds: {
    kind: 'read', method: 'GET', route: '/api/layout-bounds',
    requires: ['editor', 'renderer'], filters: ['guids', 'name', 'ids', 'layer', 'limit', 'precision'],
    notes: 'One row PER PROVIDER: an entity on screen in both Scene and Game panels reports twice.',
  },
  modoki_set_timescale: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'set-timescale',
    mutating: true, requires: ['editor', 'renderer'],
    minimalArgs: { scale: 1 },
  },
  modoki_diagnose: {
    kind: 'read', method: 'GET', route: '/api/diagnose', requires: ['editor', 'scene'],
    notes: 'C7: `ok:false` is an ANSWER (your scene is unhealthy), not a failed call.',
  },
  modoki_watch: {
    kind: 'control', method: 'GET', route: '/api/watch/list', varies: 'both',
    mutating: true, persists: 'session', requires: ['editor', 'renderer'],
    filters: ['name', 'guids', 'limit', 'precision'],
    minimalArgs: { action: 'list' },
    minimalArgsMutates: false, // action:'list' only reads; start/clear are the mutating halves
    // The filters above are READ-time; `list` (the smallest call) takes no params at all.
    filterArgs: { action: 'read', id: 'w1' },
    notes: "Three tools under one name: action start→POST /api/watch/start (creates a watcher), " +
      "read→samples, list→GET /api/watch/list, clear→POST /api/watch/clear (destroys watchers). " +
      "Declared kind is 'control', not 'read', because start/clear change watcher state.",
  },

  // ── asset schema + authoring ──
  modoki_asset_schema: {
    kind: 'read', method: 'GET', route: '/api/asset-schema', minimalArgs: { type: 'particle' },
  },
  modoki_create_asset: {
    kind: 'asset', method: 'POST', route: '/api/create-asset',
    mutating: true, persists: 'file', requires: ['project'], aim: 'asset',
    minimalArgs: { type: 'particle', path: '/assets/particles/probe.particle.json' },
  },
  modoki_write_asset: {
    kind: 'asset', method: 'POST', route: '/api/asset-write',
    mutating: true, persists: 'file', requires: ['project'], aim: 'asset',
    minimalArgs: { path: '/assets/particles/probe.particle.json', type: 'particle', data: {} },
    notes: 'F1: `path` and `type` — its two primary args — are undocumented. Can RE-MINT the asset id.',
  },
  modoki_read_asset_def: {
    kind: 'read', method: 'GET', route: '/api/asset-def', requires: ['editor'], aim: 'asset',
    minimalArgs: { path: '/assets/particles/probe.particle.json' },
    notes: 'Reads the LIVE cache, not the file — an unsaved edit exists only live.',
  },
  modoki_set_playhead: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'set-playhead',
    mutating: true, persists: 'session', minimalArgs: { t: 0 },
  },
  modoki_particle_set: {
    kind: 'asset', method: 'POST', route: '/api/editor-action', op: 'particle-set',
    mutating: true, persists: 'live', requires: ['editor'], aim: 'asset',
    minimalArgs: { path: '/assets/particles/probe.particle.json', def: {} },
    notes: 'Requires a FULL def — read it back with modoki_read_asset_def first.',
  },
  modoki_anim_set_clip: {
    kind: 'asset', method: 'POST', route: '/api/editor-action', op: 'anim-set-clip',
    mutating: true, persists: 'live', requires: ['editor'], aim: 'asset',
    minimalArgs: { clipPath: '/assets/anim/probe.anim.json', clip: {} },
  },
  modoki_anim_add_key: {
    kind: 'asset', method: 'POST', route: '/api/editor-action', op: 'anim-add-key',
    mutating: true, persists: 'live', requires: ['editor'], aim: 'asset',
    minimalArgs: { clipPath: '/assets/anim/probe.anim.json', trait: 'Transform', field: 'x', time: 0, value: 1 },
  },
  modoki_timeline_set: {
    kind: 'asset', method: 'POST', route: '/api/editor-action', op: 'timeline-set',
    mutating: true, persists: 'live', requires: ['editor'], aim: 'asset',
    minimalArgs: { timelinePath: '/assets/timelines/probe.timeline.json', timeline: {} },
  },
  modoki_timeline_add_clip: {
    kind: 'asset', method: 'POST', route: '/api/editor-action', op: 'timeline-add-clip',
    mutating: true, persists: 'live', requires: ['editor'], aim: 'asset',
    minimalArgs: { timelinePath: '/assets/timelines/probe.timeline.json', trackType: 'animation', item: {} },
  },
  modoki_capture_gesture: {
    kind: 'input', mutating: true, method: 'POST', route: '/api/capture-gesture', requires: ['editor', 'electron'], aim: 'point',
    minimalArgs: { from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
    notes: 'The one tool whose aim is legitimately a raw point: it MEASURES a gesture path. Declared kind:input/mutating — it DISPATCHES a real trusted drag against a running game, so classing it as a non-mutating read made the §7 "a read never mutates" guard pass vacuously for the only tool that could have violated it.',
  },
};

export const CONTRACTS: Record<string, ToolContract> = Object.fromEntries(
  Object.entries(DECLS).map(([name, d]) => [name, norm(d)]),
);

export function contractFor(name: string): ToolContract | undefined {
  return CONTRACTS[name];
}
