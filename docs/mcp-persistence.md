# MCP persistence — one live-world path + explicit save

**Status: landed** (all phases). This doc is the durable design reference the implementation
cites by path; the phased checklist that got it here is gone (git history has it) — see
`docs/doc-conventions.md`'s plan lifecycle for why this file exists instead of a deleted
`docs/plans/` tracker.

**Goal:** an agent can make a change that exists **only in the running editor's memory** —
try it, look at it, iterate, revert it — and the file on disk changes only when someone
explicitly saves. A human can **Cmd-Z an agent's edit** the same way they'd undo their own.

## 1. The problem this replaced

Persistence used to be an **accident of which backend route a tool happened to call**, not a
policy — two disjoint paths with no way to choose between them:

- **File-direct** — `modoki_mutate_scene`/`modoki_set_transform` → `/api/scene-mutate` →
  `writeJsonAtomic` → the file watcher hot-reloads the editor from disk. Particle/anim/timeline
  ops applied live then always persisted via `/api/asset-write`. Always saved. Never undoable.
- **Live-world** — `create_entity`/`duplicate_entity`/`delete_entities`/`reparent_entity`/
  `prefab` → `/api/editor-action` → `registerAgentOp` handlers → the in-memory ECS/editor
  store, via the same `*WithUndo` helpers the menus use. Never saved until `save_all`.

The two interlocked badly: `/api/scene-mutate` refused with a 409 whenever the editor had
*any* unsaved live work (a `create_entity` not yet saved), because writing the file would
hot-reload the scene and destroy that unsaved work. So the moment any live-only edit existed,
every file-direct tool started refusing.

## 2. The design

**One live-world path.** Every mutating MCP tool applies to the **in-memory editor world**
where it safely can, and pushes an undo entry. `modoki_save_all` remains the only thing that
writes scene state to disk.

**Two knobs:**

- **Session mode** — `modoki_persistence({mode?})`: `auto` (default, saves after each
  mutation) or `manual` (memory only). Set once per session; reported in
  `modoki_get_editor_state.persistenceMode`.
- **Per-call override** — a `save?: boolean` param exists on every mutating tool's schema,
  reserved for a future per-call override of the session mode. **Not yet honored** — landed as
  API surface so a later change doesn't need a schema migration, but only the session mode
  currently does anything.

**Every mutating tool's result carries `saved: true|false`** so an agent is never guessing
whether a change reached disk.

Full behavioural detail (the mode table, the `dirtyAssetPaths` field, which tools are
unaffected) lives in `docs/debug-tools-mcp.md`'s "Persistence modes" section — that's the
single source of truth for *what each tool does*; this doc is *why the mechanism works the way
it does*.

## 3. `mutate_scene`/`set_transform` — live path with a file-direct fallback

`modoki_mutate_scene`'s live path only exists when a renderer is connected **and** its active
scene matches the one the call targets — the live world only ever represents ONE scene, so
targeting a different scene file (or running headless, e.g. the documented curl-editing
workflow) falls back to the original file-direct write, unchanged. This fallback is not a
missing feature — CLAUDE.md documents `/api/scene-mutate` as a browser-free editing surface,
and breaking that would be a regression, not a improvement.

**`setBaseScene` has no live-world equivalent** — it changes what the scene *loads*, not any
live entity's state — so a call containing it always stays file-direct regardless of mode or
which scene is open. `agentEditorOps.ts`'s `apply-scene-ops` op refuses it defensively too
(belt-and-braces for any caller that reaches it some other way), but the router is what
actually keeps such a call off the live path.

## 4. The composite undo primitive (the hard part)

Collapsing an N-op `mutate_scene` call into ONE undo entry needed a real primitive, not the
pre-existing `coalesceKey` (time-windowed coalescing for repeated edits to the SAME field —
it advances the top entry's `redo` while keeping the FIRST action's `undo`, which is correct
for a slider drag and wrong for a heterogeneous batch: an `addEntity` + three `setTrait`s on
different entities would collapse into an entry whose undo reverts only the first op).

**`engine/packages/modoki/src/editor/undo/compositeAction.ts`** (+ the capture primitives in
`undoManager.ts`) is that primitive:

- `runAsCompositeAction(opts, body)` opens an undo-manager **capture frame**, runs `body`
  (which calls the existing `*WithUndo` helpers per op — reusing their guid-based
  re-resolution, prefab-override marking, and animation-record notification rather than
  re-deriving it), and pushes exactly ONE composite `UndoAction` wrapping everything the frame
  captured.
- **Where the divert happens**: inside `pushAction` itself, not `entityActions.ts`'s
  `setActionCallback` hook — that hook only covers `entityActions.ts`; prefab/gizmo/reorder
  actions call `pushAction` directly, so a capture installed anywhere else would silently miss
  them and half-revert a batch on Cmd-Z.
- **Ordering**: undo runs sub-actions in reverse, redo in forward order, each awaited before
  the next — sub-undos are async (a prefab-instantiate redo awaits), so sequencing is
  mandatory.
- **Re-entrancy**: a composite's own `undo`/`redo` run INSIDE an already-serialized
  `undoManager.undo()`/`redo()` call, so it must never call the exported `undo()`/`redo()` or
  try to re-acquire that lock — it's just a well-behaved single `UndoAction`.
- **Failure = nothing happened**: if `body` throws mid-batch, already-applied sub-actions roll
  back (reverse order, best-effort) and NO entry is pushed — a half-applied batch whose undo
  only covers the applied half is worse than either fully succeeding or fully failing.
- **Journal**: the batch emits exactly ONE editor-journal event (`!batch` by default); every
  sub-action's structured payload (`journalPayload`/`detail`) is folded into that one event's
  `ops` array (capped at 50, with an exact `count`) rather than being lost or replayed as N
  separate events — N `!edit` events for one Cmd-Z step would claim a granularity the undo
  stack doesn't have.

## 5. The dirty-asset registry (particle/anim/timeline in `manual` mode)

`particle_set`/`anim_set_clip`/`anim_add_key`/`timeline_set`/`timeline_add_clip` apply live
immediately either way, then either persist (auto) or park the pending doc in
`engine/packages/modoki/src/editor/scene/dirtyAssets.ts`'s `path -> doc` map (manual). `saveAll`
flushes it alongside the scene write (each entry via the same validated `/api/asset-write`
route); a failed flush leaves its entry pending rather than silently dropping it.
`hasUnsavedChanges()` and `get_editor_state`'s `dirtyAssetPaths` both account for it — a dirty
asset an agent can't see is the same silent-loss trap the original `unsavedChanges` field
exists to close for live scene edits.

The mode itself lives in the BACKEND process (Node), not the renderer — it fronts both the
file-direct routes (Node-side) and the live-world routes (relayed to the renderer). The
renderer doesn't otherwise know the session mode, so the backend's `/api/editor-action` relay
injects `_persistenceMode` into the params of exactly these five ops before forwarding them
(`ASSET_PERSISTENCE_ACTIONS` in `editorBackendRouter.ts`) — everything else is unaffected.

`write_asset`/`create_asset` are deliberately unaffected by the mode: they're explicit "write
this file" tools, not live-state edits.

## 6. Prior fix this generalizes

The prefab ops (`modoki_prefab` instantiate/create/detach) used to push **no** undo entry and
never bump `_editVersion`, so agent-instantiated prefabs were live-only yet reported
`unsavedChanges: false` — meaning `guardUnsaved` and the file-direct 409 both stayed silent and
the next hot-reload destroyed them while every tool reported `ok: true`. Fixed 2026-07-26 in
`agentEditorOps.ts` (+ `setPrefabSource` on instantiate). That fix — every live-world mutation
must push an undo entry, or the unsaved-work guards can't see it — is the pattern this whole
plan generalizes.
