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
  /** Declared exceptions to the "a boolean filter always EXPANDS the response" heuristic that
   *  `mcpToolContracts.test.ts` guards `filters` with.
   *
   *  That heuristic held for the whole surface until `modoki_input_watch.unresolvedOnly` — every
   *  narrowing param carried a value (an id, a name, a cap) and every boolean added something, so
   *  "boolean ⇒ expanding" was a reliable tell rather than a rule. It is a heuristic, and this is
   *  where an exception is DECLARED rather than dodged by omitting the filter: leaving the flag out
   *  of `filters` would have kept the guard green while removing the tool's most useful narrowing
   *  param from the over-cap hint — a silently worse answer for the agent, which is the outcome
   *  §6 exists to prevent. Listing one here is a deliberate act that shows up in review; it is not
   *  a way to bless an expanding flag. */
  narrowingFlags?: string[];
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
  'A RESOLVABLE aim covered by something else is REFUSED (400, `OCCLUDED`), naming the cover: the '
  + 'input would land on that instead, and reporting ok for it is the false success §0 ranks worst. '
  + 'This binds BOTH resolvable aims — `entity` and `selector` — and matches the device surface, '
  + 'which has always refused a covered selector. Raw `{x,y}` is never refused: a coordinate is '
  + 'exactly what was asked for. `allowOccluded:true` dispatches anyway (per-endpoint on `drag`); '
  + "on `pointer` it applies to `action:'down'` only, since a move/up is delivered to whatever "
  + 'captured the press. An `entity` aim at a 2D/3D target additionally reports how far the check '
  + "could see: `occlusionScope:'entity'` is the surface's own hit-test (so 'click the character' "
  + 'fails if the game would not select that character), while a surface with no pick provider '
  + "keeps the honest `occlusionScope:'canvas'` fallback — entity-vs-entity occlusion inside the "
  + 'canvas is NOT checked there. See `docs/enact.md`.';

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
  modoki_find_references: {
    kind: 'read', method: 'GET', route: '/api/find-references', requires: ['project'], aim: 'asset',
    filters: ['limit', 'maxDepth', 'reachableOnly'],
    // `reachableOnly` NARROWS (drops references that don't survive a production build), it
    // does not expand — same shape as `modoki_input_watch.unresolvedOnly`. See `narrowingFlags`.
    narrowingFlags: ['reachableOnly'],
    // A plausible path, not a guaranteed one — most projects have a `main.scene.json`,
    // and one that does not answers NOT_FOUND, which the live sweep already classifies
    // as an ENV code for exactly this case. Deliberately NOT a path that resolves
    // unconditionally: an unknown target is a refusal here, because answering
    // `unreferenced: true` for a file that does not exist reads as "safe to delete".
    minimalArgs: { target: '/assets/scenes/main.scene.json' },
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
    notes: 'The ONLY input tool that cannot be aimed by entity, because HTML5 DnD is a '
      + "DOM-element protocol (the source element's own dragstart handler fills the DataTransfer). "
      + 'Its endpoints are strict + refined instead of the shared pointSpec for that reason (S3.6). '
      + 'It goes through the action relay rather than /api/input/*, but that no longer costs it the '
      + 'shared matched/hitTarget/occluded provenance — both endpoints carry it (#260). It is still '
      + 'the one aimed input tool that does NOT refuse a covered aim: dispatchEvent bypasses '
      + 'hit-testing so the drop genuinely lands, and it warns instead — a covered drop is one no '
      + 'human could perform, which is a fidelity problem, not a delivery one.',
  },
  modoki_handles: {
    kind: 'read', method: 'GET', route: '/api/enact-handles', requires: ['editor'],
    // All THREE filters, not just `kind` — the over-cap hint is built from this list, so a missing
    // one is a filter the agent is never told about (S3.10). (This comment used to claim the docs
    // catalog reads `filters` too. It does not — `renderCatalog` emits Tool/Endpoint/Effect/Needs/
    // Aim/Smallest-call and no filters column. Naming a consumer that does not exist is how a
    // declaration gets trusted for a job nothing is doing.)
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
    notes: '#19: code runs as an ASYNC function body (`await` is allowed, #145) with the injected `modoki` object as its '
      + 'sole parameter — that object gives full op-registry + '
      + 'backendFetch access (see modoki_eval_api for the surface). Escape hatch, unvalidated by design; the older '
      + '"dynamic import yields 19 of 55 ops" half-support this replaced is gone. `timeoutMs` bounds the whole body '
      + '(default 5000, max 25000, clamped): the route sizes the relay deadline from it and the client sizes its abort '
      + 'from that, so all three stay ordered. Until they did, the relay\'s 3000ms default was SMALLER than the eval\'s '
      + 'own 5000ms budget and capped every editor eval at 3s.',
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
      + "persists:'both' because action:'create' and 'apply' WRITE the .prefab.json "
      + "(writePrefabFile / applyToPrefabWithUndo) while instantiate/detach/overrides/revert are "
      + "live-only; the undo entry covers the live tagging/rebuild only, never a file write "
      + '(undoing an overwrite would destroy an asset the agent never created — apply is the one '
      + "exception: its undo DOES restore the pre-apply .prefab.json, because that write IS the op). "
      + "'overrides' is READ-only discovery — it walks the SAME override-key enumeration "
      + "'apply'/'revert' consume (collectInstanceOverrideKeys) and hands back the exact key "
      + "strings, so an agent can pick `keys` without guessing the "
      + '`"localId.trait.field"` / `"+added.<guid>"` / `"-removed.<localId>"` / '
      + '`"-trait.<localId>.<name>"` shapes. `apply`/`revert` act on ALL current overrides when '
      + '`keys` is omitted, and throw (never a silent ok:true) if ANY given key matches no '
      + 'override — a partial apply/revert would read as a success. An EXPLICIT empty `keys` '
      + 'array is refused rather than treated as omitted: a caller-side filter that matched '
      + 'nothing means "act on nothing", and falling through to "act on everything" is the '
      + 'destructive reading. Not every override is applyable, either — a scene-only/runtime-only '
      + 'field (EntityAttributes.editorFolder) is revertable but is skipped by a template write, '
      + 'so apply refuses it when named and reports it as `skippedKeys` when not. '
      + "The edit-* actions drive PREFAB-EDIT MODE: 'edit-open' swaps the world for a synthetic "
      + 'prefab scene (world-destructive, so it takes `force` like load-scene, and it saves the '
      + "current scene on the way in), 'edit-save' re-serializes the .prefab.json, 'edit-exit' "
      + 'reloads the return scene. None of the three is undoable — they are scene swaps and a '
      + 'file write, matching load-scene and create respectively.',
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
  modoki_scene_query: {
    kind: 'read', method: 'POST', route: '/api/scene-query', requires: ['editor', 'scene'], aim: 'point',
    minimalArgs: { kind: 'point', dim: '3d', point: [0, 0, 0] },
    notes: "All six engine scene queries (#288 gap 1) behind one tool — §7-legal because no argument changes the method, the route, or whether anything is written; every kind is a pure read. POST despite being a read for the same reason capture_viewport/render_scene are: the input is nested vectors. Its substance is the REFUSAL taxonomy — the engine functions collapse 'no physics world', 'zero-length direction' and a genuine miss onto one null, so the first two are ruled out BEFORE casting and only what is left is reported as hit:null. The raw coordinates are a MEASUREMENT, not an aim (the capture_gesture carve-out), so this must never be added to batch.ts's XY_AIMED map.",
  },
  modoki_player_prefs: {
    kind: 'read', method: 'GET', route: '/api/player-prefs', requires: ['editor'],
    filters: ['key'],
    notes: "The READ half of PlayerPrefs (#288 gap 4); the write half is a separate tool on a separate route+op, so the §7 'a read never mutates' promise holds structurally rather than by review. Unrelated to modoki_persistence (the editor's scene/asset save mode) despite the name. Refuses NOT_AVAILABLE_HERE when the cache is un-hydrated rather than answering with an empty key list.",
  },
  modoki_write_player_prefs: {
    kind: 'mutate', method: 'POST', route: '/api/player-prefs',
    mutating: true, persists: 'file', requires: ['editor'],
    minimalArgs: { action: 'flush' },
    notes: "persists:'file' means the PLATFORM prefs store (localStorage / @capacitor/preferences), not a project file — it is the only Persists value that says 'survives the session', which is the fact that matters. set/delete flush before replying, so saved:true means the backend ACCEPTED the write; a rejected one is reported PARTIAL rather than ok, because the value stays in the cache and a read-back cannot see the failure. action is REQUIRED (§1) and action:'clear' additionally requires confirm:true (§8). On its OWN route rather than the /api/editor-action relay: that relay's routing key is `action`, and it strips it before relaying, so a tool with an `action` param has it silently DROPPED — measured here, and now refused outright by editorAction().",
  },
  modoki_set_timescale: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'set-timescale',
    mutating: true, requires: ['editor', 'renderer'],
    minimalArgs: { scale: 1 },
  },
  modoki_diagnose: {
    kind: 'read', method: 'GET', route: '/api/diagnose', requires: ['editor', 'scene'],
    notes: 'C7: `ok:false` is an ANSWER (your scene is unhealthy), not a failed call. The `video` param is deliberately NOT declared in `filters`: §6 filters are params that NARROW a response, and this one EXPANDS it (an opt-in video-cache index) — which is what the boolean heuristic already expects, so listing it would be the exact misuse `narrowingFlags` warns against, "a way to bless an expanding flag". Opt-in matters anyway, because diagnose is a swept read: a per-clip index would grow every caller\'s payload to answer a question almost none of them asked. It is the only surface that can read the downloaded-video cache (#288 Phase 6) — the singleton sits behind the __MODOKI_MODULE_VIDEO__ flag, and an /@fs import in modoki_eval yields a second module instance whose slot is null.',
  },
  modoki_profiler: {
    // `varies:'method'`, not 'both': every action uses the SAME route (`/api/profiler`) and only
    // the method moves. Over-declaring the route as varying is harmless today, but `varies` is
    // what the mutating-GET guards exclude on, so it is a field that must say exactly what is
    // true — see modoki_hit_regions above for what an untrue one costs.
    kind: 'control', method: 'GET', route: '/api/profiler', varies: 'method',
    mutating: true, persists: 'session', requires: ['editor', 'renderer'],
    filters: ['markers'],
    minimalArgs: {},
    notes: 'Read actions (read / capture-read / boot) are GET; the state-changing ones (capture-*, gpu-*, reset, boot-reset) are POST, so §4 holds per action. A read-side filter passed to a mutating action is REFUSED, not dropped (the `watch` S3.19 hazard). action:boot reads the always-on boot-phase timeline (#238) intersected with the worst dropped frame — the only read that can attribute a cold-boot stall, which the frame aggregate drops from its percentiles by design.',
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
  modoki_input_watch: {
    kind: 'control', method: 'GET', route: '/api/input-watch/read', varies: 'both',
    mutating: true, persists: 'session', requires: ['editor', 'renderer'],
    filters: ['limit', 'unresolvedOnly', 'precision'],
    // `unresolvedOnly` is the surface's first NARROWING boolean — it keeps only the presses that
    // resolved to nothing, which is the whole diagnostic question here. See `narrowingFlags`.
    narrowingFlags: ['unresolvedOnly'],
    minimalArgs: { action: 'read' },
    minimalArgsMutates: false, // action:'read' only reads; start/stop/clear are the mutating halves
    notes: "Four ops under one name: action start→POST /api/input-watch/start (opens the recorder, " +
      "records nothing before this call), read→GET /api/input-watch/read (default action), " +
      "stop→POST /api/input-watch/stop (closes it, KEEPS recorded presses), clear→POST " +
      "/api/input-watch/clear (drops recorded presses, window stays open if it was). Declared kind " +
      "is 'control', not 'read', because start/stop/clear change recorder state.",
  },

  modoki_hit_regions: {
    kind: 'control', method: 'GET', route: '/api/hit-regions',
    // NO `varies` — and its absence is the point. This tool declared `varies:'both'` while
    // varying in NEITHER: `/api/hit-regions` has exactly one arm (`method === 'GET'`) and all
    // three actions were OBSERVED going `GET /api/hit-regions?action=…`. That untrue word was
    // load-bearing in the worst way: every mutating-GET guard filters on `!c.varies`, so one
    // declaration exempted this tool from the violator list, the mutating-args fixture, AND the
    // behavioural "a 200 ok:false is a FAILURE" assertion — and a refused show/hide reached the
    // agent as a successful call. Declaring the truth puts it back in all three.
    mutating: true, persists: 'session', requires: ['editor', 'renderer'],
    filters: ['provider', 'kind', 'ids', 'limit', 'precision'],
    minimalArgs: { action: 'read' },
    // action:'read' only reads; show/hide flip the on-screen overlay, which is session state.
    minimalArgsMutates: false,
    notes: "Three actions under one name: action read (default) returns the regions as DATA, " +
      "action show/hide toggles the on-screen SVG overlay. Declared kind is 'control', not 'read', " +
      "because show/hide change overlay state. `at:{x,y}` answers the miss question directly — it " +
      "reports which regions contain that point and, when none do, the NEAREST region with its " +
      "distance in px. Returns `providers` alongside `regions` so an empty list can be read " +
      "correctly: no provider registered is 'nobody could answer', not 'nothing is there'.",
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
  modoki_delete_asset: {
    kind: 'mutate', method: 'POST', route: '/api/delete-asset',
    mutating: true, persists: 'file', requires: ['project'], aim: 'asset',
    minimalArgs: { paths: ['/assets/particles/probe.particle.json'] },
    notes: 'NOT undoable and deliberately narrower than the Assets panel\'s Delete, which also sweeps a model\'s generated meshes/materials/sidecars and records a restore snapshot. Trashes exactly the paths named. The route rebuilds the asset manifest INLINE (`manifestRebuilt`) so modoki_list_assets verifies it immediately, rather than racing the watcher\'s 150ms debounce. NOT resolve_refs, which resolves ENTITY refs and never answers about an asset guid — measured, and it was named here in error at first.',
  },
  modoki_list_creatable_assets: {
    kind: 'read', method: 'GET', route: '/api/creatable-assets',
    notes: "Discovery for modoki_create_registered_asset. A SIBLING read, not a list mode on the mutating tool — §7 forbids the latter and this surface already has four such siblings. Justified more strongly than usual: the registry is dynamic, game-extensible, and comes and goes with the OPEN PROJECT, so no static catalog can carry it, and discovery-by-refusal would mean issuing a deliberately failing mutating call to learn the kinds. On its OWN GET route rather than the editor-action relay: the circularity guard flags mutating:false + a POST to a write route, and it is right to — that combination is how an under-declared write gets swept as safe AND exempted from the ledger. The honest fix was the method.",
  },
  modoki_create_registered_asset: {
    kind: 'mutate', method: 'POST', route: '/api/editor-action', op: 'create-registered-asset',
    mutating: true, persists: 'file', requires: ['editor', 'project'], aim: 'asset',
    minimalArgs: { kind: 'material', path: '/assets/materials/probe.mat.json' },
    notes: "Routes around the panel's native save dialog (a BLOCKING osascript panel on darwin) by taking an explicit path, which is what made the whole 'New X' surface agent-unreachable (#288 gap 5). Separate from modoki_create_asset, whose `type` is a fixed enum while this registry is dynamic and game-extensible. REFUSES create-override kinds: `scene`'s override discards the live world, and the dialog it normally goes through IS the guard an explicit path removes — modoki_new_scene has the REQUIRES_SAVE check instead.",
  },
  modoki_open_animation_editor: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'open-animation-editor',
    mutating: true, persists: 'session', requires: ['editor', 'scene'], aim: 'asset',
    minimalArgs: { path: '/assets/animations/probe.anim.json' },
    notes: 'The PREREQUISITE the clip-authoring tools were missing (#288 Phase 4): pose_clip / set_playhead / anim_add_key all read the editor\'s open clip, and nothing could set it — set_selection {asset} selects in the Assets panel without opening the editor (measured). Mirrors open-particle-editor. Reports `bound` separately from the open, because a clip can open and bind to nothing.',
  },
  modoki_pose_clip: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'pose-clip',
    mutating: true, persists: 'live', requires: ['editor', 'scene'],
    minimalArgs: { t: 0 },
    notes: "The pose modoki_set_playhead deliberately does NOT do (#288 gap 2). undoable:false with persists:'live' is a deliberate deviation from §8's one-call-one-undo-entry: the pose lives inside the editor's preview envelope and reverts on exit rather than through the undo stack, because a preview pose is not a scene edit. Editor-only by construction — a device build has no preview session and nothing to revert a pose to — which is the 'recorded as deliberate' half of §9, not a parity gap.",
  },
  modoki_exit_pose_envelope: {
    kind: 'control', method: 'POST', route: '/api/editor-action', op: 'exit-pose-envelope',
    mutating: true, persists: 'live', requires: ['editor', 'scene'],
    notes: "The way OUT of the envelope modoki_pose_clip opens — not optional scope, since the envelope pins the run-mode at 'scrub' and that is exactly what blocks the human's Cmd+S. Refuses when the TIMELINE panel owns the envelope: ending its session would revert its world mid-run.",
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
    // undoable:true — asserted against the op, not just declared. All five call `pushAssetUndo`
    // (agentEditorOps.ts § "Make an agent asset-def edit UNDOABLE"), a deliberate owner decision
    // from 2026-07-30 (audit S2.27) that closed the asymmetry with the panels, which already
    // pushed to the same global undoManager for the identical edit.
    //
    // They were declared `false` here — by omission, which is how a contract field goes wrong
    // quietly — for as long as that fix has existed. The cost landed on the AGENT: the generated
    // catalog said "not undoable" for all five, and none of their descriptions mentioned undo, so
    // the recovery path from a bad write was invisible and the obvious next reach is
    // `modoki_discard_asset_edits` — which drops the parked WRITE and leaves the applied def live,
    // i.e. not the thing you wanted.
    mutating: true, undoable: true, persists: 'live', requires: ['editor'], aim: 'asset',
    minimalArgs: { path: '/assets/particles/probe.particle.json', def: {} },
    notes: 'Requires a FULL def — read it back with modoki_read_asset_def first.',
  },
  modoki_anim_set_clip: {
    kind: 'asset', method: 'POST', route: '/api/editor-action', op: 'anim-set-clip',
    mutating: true, undoable: true, persists: 'live', requires: ['editor'], aim: 'asset',
    minimalArgs: { clipPath: '/assets/anim/probe.anim.json', clip: {} },
  },
  modoki_anim_add_key: {
    kind: 'asset', method: 'POST', route: '/api/editor-action', op: 'anim-add-key',
    mutating: true, undoable: true, persists: 'live', requires: ['editor'], aim: 'asset',
    minimalArgs: { clipPath: '/assets/anim/probe.anim.json', trait: 'Transform', field: 'x', time: 0, value: 1 },
  },
  modoki_timeline_set: {
    kind: 'asset', method: 'POST', route: '/api/editor-action', op: 'timeline-set',
    mutating: true, undoable: true, persists: 'live', requires: ['editor'], aim: 'asset',
    minimalArgs: { timelinePath: '/assets/timelines/probe.timeline.json', timeline: {} },
  },
  modoki_timeline_add_clip: {
    kind: 'asset', method: 'POST', route: '/api/editor-action', op: 'timeline-add-clip',
    mutating: true, undoable: true, persists: 'live', requires: ['editor'], aim: 'asset',
    minimalArgs: { timelinePath: '/assets/timelines/probe.timeline.json', trackType: 'animation', item: {} },
  },
  // ── the six routes that had no tool (2026-08-21 audit F6, owner: expose all six) ──
  // Each was reachable only through modoki_eval + modoki.api(). Two of them were DOCUMENTED as
  // existing for the agent, which is how a route ends up promised and unreachable at the same time.
  modoki_validate_prefab: {
    kind: 'read', method: 'GET', route: '/api/validate-prefab', requires: ['project'], aim: 'asset',
    minimalArgs: { path: '/assets/prefabs/probe.prefab.json' },
    notes: "The prefab twin of modoki_validate_scene. C7: `ok:false` is an ANSWER (this prefab has problems), not a failed call. Consults NO trait schema — hence no schemaAvailable, unlike its scene sibling, and no renderer requirement.",
  },
  modoki_unused_assets: {
    kind: 'read', method: 'GET', route: '/api/unused-assets', requires: ['project'],
    notes: "The single owner of 'what would the build DROP?' — it runs the real tree-shaker from the scene seeds, so it answers about what SHIPS. A `?unreferenced=1` mode on find_references was measured against it and DELETED (docs/build.md): its answer was a strict subset on every committed project, and weaker where they differed. Scoped to the project's own assets; the engine's shared /modoki/assets root is excluded as engine-owned.",
  },
  modoki_write_asset_meta: {
    kind: 'asset', method: 'POST', route: '/api/write-meta',
    mutating: true, persists: 'file', requires: ['project'], aim: 'asset',
    minimalArgs: { path: '/assets/textures/probe.png', meta: {} },
    notes: "The write half of modoki_get_asset_meta, which is its verification read (§8). REPLACES the sidecar rather than merging, so a partial post drops every omitted setting. Writing settings does not re-convert — modoki_reimport_asset does.",
  },
  modoki_duplicate_asset: {
    kind: 'asset', method: 'POST', route: '/api/duplicate-asset',
    mutating: true, persists: 'file', requires: ['project'], aim: 'asset',
    minimalArgs: { from: '/assets/particles/probe.particle.json', to: '/assets/particles/probe-copy.particle.json' },
    notes: 'Not a file copy: it MINTS a fresh guid for the duplicate, because two assets sharing one guid breaks every ref that resolves through the manifest. Refuses an existing destination (409) rather than clobbering.',
  },
  modoki_move_asset: {
    kind: 'asset', method: 'POST', route: '/api/move-file',
    mutating: true, persists: 'file', requires: ['project'], aim: 'asset',
    minimalArgs: { from: '/assets/particles/probe.particle.json', to: '/assets/particles/moved.particle.json' },
    notes: "Refs survive the move — they are GUIDs resolved through the manifest and the guid travels with the file. Refuses an existing destination (409) and a missing source (404). A CASE-ONLY rename is allowed: on a case-insensitive FS the two paths are the same inode, which is not a collision.",
  },
  modoki_create_folder: {
    kind: 'asset', method: 'POST', route: '/api/create-folder',
    mutating: true, persists: 'file', requires: ['project'], aim: 'asset',
    minimalArgs: { path: '/assets/probe-folder' },
    notes: 'The prerequisite for modoki_import_file `destFolder` and modoki_create_asset `path`, neither of which creates its destination. Not recursive; refuses an existing folder (409).',
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
