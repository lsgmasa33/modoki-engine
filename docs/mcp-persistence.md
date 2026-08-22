# MCP persistence — manual-only

**A live edit never reaches disk on its own. `modoki_save_all` is the only thing that writes.**

## What this is, and what changed

There used to be two modes. `auto` (the default) made every live mutation ALSO save to disk;
`manual` parked it until an explicit save. **`auto` was removed on 2026-07-30** (owner decision), so
there is now exactly one behaviour.

**Why:** two modes meant the same tool call did different things depending on a flag set in an
earlier turn, and the agent-facing symptom — *"did that save or not?"* — could only be resolved by
asking. One predictable behaviour is worth more than the convenience of the other. `modoki_persistence`
is now a **read**; passing `mode` returns a 400 rather than being silently ignored, because a caller
who believes it re-enabled auto-save would lose work when nothing saved.

**The per-call `save?: boolean` param is GONE** (2026-08-22). It survived on 13 mutating tools'
schemas reading "IGNORED… Do not pass it", reserved for a phase that was never built — the mode knob
it waited for was deleted instead. Keeping it was justified as not breaking existing callers, which
does not apply on an agent surface: there are no legacy callers, only a model reading the schema
fresh each session. And with `.strict()` armed, removing it is strictly BETTER than keeping it — a
passed `save` is now a refusal naming the tool's real parameters instead of being silently accepted
and ignored.

## The contract

| Tools | Effect |
|---|---|
| `mutate_scene`, `set_transform` | apply to the LIVE world as **one undoable step** (a human can Cmd-Z the whole call); `saved:false` + a hint naming `save_all`. An `addEntity` op also returns `created:[{op, id, guid, name}]` (S3.12) — from BOTH the live and file paths — so the caller addresses what it just made by GUID instead of re-finding it by name, which this surface refuses when the name is ambiguous |
| `particle_set`, `anim_set_clip`, `anim_add_key`, `timeline_set`, `timeline_add_clip` | apply live, park the disk write in the **dirty-asset registry** (`get_editor_state.dirtyAssetPaths`); each is UNDOABLE, with `_isFileDirect` so an asset-only edit still does not dirty the scene (S2.27) |
| `create_entity`, `duplicate_entity`, `delete_entities`, `reparent_entity`, `prefab` | live-only — unchanged; this split predates the mode knob |
| `write_asset`, `create_asset`, `import_file`, `reimport_asset` | always write — explicit "write this file" tools |
| `save_all` | flushes every parked asset doc (ALWAYS, first) **and** serializes the live scene. ⚠️ It calls `saveAll` DIRECTLY, not the human Cmd+S command (`runSaveAll`), so it does NOT put a live preview envelope down for you: while the human's editor is scrubbing/previewing, `save_all` still reports the flat run-mode refusal for the scene half. Deliberate — ending someone's preview session from an agent call is not this tool's business. The two halves are independent: a scene save refused while scrubbing/previewing still writes the asset docs, and says so |
| `discard_asset_edits` | the counterpart to `save_all` for the registry: drops parked asset writes **without** writing them. Names `paths`, or `all:true`; a bare call is refused (dropping everything is unrecoverable — the `set_selection` lesson). Drops the WRITE, not the edit: the editor cache keeps the applied def until the asset reloads |

**`save_all` never silently drops a pending asset:** an entry that fails to write stays in the
registry (so `hasUnsavedChanges()` remains true) and is reported in `assets.failed`.

## The file-direct path is NOT `auto` coming back

With no renderer connected, or a call targeting a scene FILE that isn't the one open live, or an op
that is `setBaseScene` (no live-world equivalent — it changes what the scene *loads*, not any live
entity's state), the call writes the file. Not because a mode says so, but because **there is no
live world to hold the edit**. This keeps the browser-free curl-editing path working.

So `mutate_scene` still reports `saved: true` sometimes. Trust `saved` and `mode` in the result over
assuming which path a call took.

## Consequences of manual-only (accepted with the decision)

`unsavedChanges: true` is the normal state after any agent edit, and three gates key off it. All
three were rare under `auto` and are routine now:

- **`modoki_build` REFUSES** while unsaved — it reads the FILE, so the artifact would miss the work.
- **A file-direct `mutate_scene` 409s** while unsaved — its write hot-reloads the scene and would
  destroy live-only work.
- **A game-code (`.ts`) edit force-reloads the editor and DISCARDS unsaved scene edits** after a 5s
  countdown (CLAUDE.md). This is the sharpest one: accumulated unsaved work is more exposed than it
  was under `auto`.

Therefore: `save_all` before a build, before a scene swap, and before editing game code.

## Where it lives

- `PERSISTENCE_MODE` + the live-apply branch — `engine/plugins/backend/editorBackendRouter.ts`
- the dirty-asset registry — `engine/packages/modoki/src/editor/scene/dirtyAssets.ts`
- `persistOrMarkDirty` (always parks) — `engine/app/editor/agentEditorOps.ts`
- tests — `engine/tests/plugins/persistenceRouter.test.ts`, `engine/tests/editor/dirtyAssets.test.ts`,
  `engine/tests/editor/agentPersistence.test.ts`

## The composite undo primitive (the hard part)

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

## 5. The dirty-asset registry — the ONE path from an asset edit to disk

`particle_set`/`anim_set_clip`/`anim_add_key`/`timeline_set`/`timeline_add_clip` apply live
immediately, then park the pending doc in
`engine/packages/modoki/src/editor/scene/dirtyAssets.ts`'s `path -> doc` map. `saveAll`
flushes it (each entry via the same validated `/api/asset-write` route); a failed flush leaves its
entry pending rather than silently dropping it. `hasUnsavedChanges()` and `get_editor_state`'s
`dirtyAssetPaths` both account for it — a dirty asset an agent can't see is the same silent-loss
trap the original `unsavedChanges` field exists to close for live scene edits.

**The five asset PANELS park here too, as of #259 — there is no longer a second contract.** The
Particle, Animation, Timeline, Skin and SpriteAnim editors used to POST their document to disk on a
400 ms trailing debounce. That was a second way for one file to be written, and each half was right
locally: the agent op answered `saved:false` while the panel had already put bytes on disk. What it
cost, all three measured rather than argued:

- **The two collided.** `particle_set` parked v1, a panel write put v2 on disk, `dirtyAssetPaths`
  still listed the path, and `save_all` rewrote the file back to v1 — the human's panel edits gone.
- **It wrote committed files behind your back** (CLAUDE.md #18), from inside the editor, so a QA
  case whose cleanup relied on "nothing was saved" left a modified asset for someone else's
  `git add -A`.
- **There was no undo for it**: a debounced write lands with no undo entry, so a mis-drag on a
  curve was permanent the moment the timer fired.

Now every panel edit is a `markAssetDirty(path, type, doc, 'panel')` and **Cmd+S is the write**. Two
consequences worth knowing:

- **Parking is synchronous** (`editor/panels/useParkedAssetDoc.ts`). The debounce was not merely
  unnecessary once the write became a `Map.set` — it was actively harmful: the old hook cancelled
  its pending timer on unmount, so closing a panel tab within 400 ms of an edit dropped it, and a
  re-open then marked the never-written document as the SAVED baseline.
- **Origin is recorded per entry** (`'panel' | 'agent'`), because the flush is not identical for the
  two. A panel is a full-document editor where deleting a field is a legitimate action, so its
  writes carry `replace:true` past `/api/asset-write`'s drop-key guard — concretely, the first
  "+ Add Part" on a v1 rig runs `ensurePartsArray` and drops four top-level keys. An agent's
  read-modify-write flow carries every key back, so its writes keep the guard. Both are marked as
  the editor's own write (`selfWrite`), because everything in the registry was already applied to
  the live cache: without that, the flush's own watcher event comes back ~150 ms later and
  `dropParkedWriteFor` discards whatever the human parked in the meantime.

**A save ALWAYS flushes the registry, whatever the scene does.** The flush used to live inside
`saveScene`, after the scene write had succeeded, so five refusals silently swallowed it: run-mode
not `stopped`, a prefab-edit world, no scene path, a cancelled Save-As, and a failed scene write.
While the panels autosaved that was invisible. With them parking, four of those five are "I pressed
Cmd+S and my edit was not saved" — so the flush moved up into `saveAll`, first and unconditional,
and the toast reports both halves (`editor/scene/saveCommand.ts`). The scene's own guards are
unchanged: they exist to keep a preview pose or a physics-settled position out of an authored
scene, and none of that reasoning reaches a `.particle.json` the panel owns. Moving it up also
stopped two non-Save-All callers of `saveScene` — Create Scene, and an Apply-to-Prefab **undo** —
from committing every parked asset doc as a side effect.

**A parked write is keyed by PATH, so deleting or renaming the asset has to repair it.** The
registry outlives both the panel binding and the panel itself, so a delete would otherwise leave a
write that the next save turns back into the file you deleted, and a rename would leave the old path
parked and fork the asset (#186's measured failure, one layer down). `applyMovesToParkedAssets`
(`editor/panels/assetEditorBindings.ts`) moves the parked doc with a renamed asset — the edit is
still valid, only its location changed — and drops it for a deleted one, loudly.

**Opening the asset's PANEL must not resurrect the file (QA-CTX-0008).** A parked write means the
doc on disk is the PRE-edit one, and every asset editor opened by fetching that file — which
re-seeded the live cache with it. Measured on `games/3d-test`: `timeline_add_clip` reported
`{ok:true, tracks:1}` and `read_asset_def` agreed, and the moment the Timeline Editor was opened on
that asset the live def read `tracks: []`, while the parked write and `unsaved:true` both stayed —
so the panel displayed a document that disagreed with what `save_all` would have written, and the
edit was gone from everything that reads the cache. The Timeline / Particle / Animation panels now
ask `pendingAssetDoc(path, type)` (`editor/panels/pendingAssetDoc.ts`) first and open the parked doc
when there is one, falling back to the file otherwise. It is marked as the panel's SAVED baseline
deliberately: the write is parked, not written, so opening must not commit what the human never
chose to save — verified live, the file stayed at `tracks: []` while the panel and the cache both
showed the edit.

Since #259 this covers all five panels (`SkinEditor` and `SpriteAnimEditor` were added), and it
stopped being an agent-only concern: the panel parks its OWN edits now, so without this, closing and
reopening a panel would silently discard the human's unsaved work.

**A file the editor writes DIRECTLY must drop any parked write for it.** `dropParkedWriteFor`
(agentBridge) states this rule for an EXTERNAL change, but it rides the file watcher and cannot see
the editor's own writes: `/api/write-file` fingerprints its bytes via `markEditorWrite` precisely so
the editor does not react to itself. So the writer says so directly, via `assetWrittenToDisk(path)`.

Since #259 the panels' EDITING path no longer writes directly, so what is left is their one-shot
CREATE/REGENERATE writes — a new file has to exist on disk for `registerAsset` and the manifest to
see it. Of those, `SkinEditor`'s auto-rig is the one that matters: it derives `<sprite>.rig2d.json`,
so re-rigging the same sprite regenerates over a rig that may already have unsaved edits parked.

The collision this rule was written for was measured on the old panel autosave: `particle_set`
parked v1, a panel-shaped `/api/write-file` put v2 on disk, `dirtyAssetPaths` still listed the path,
and `save_all` rewrote the file back to **v1** with no warning. That whole class is gone now that
the panel and the agent park in the same place — which is what #259 was for.

The mode itself lives in the BACKEND process (Node), not the renderer — it fronts both the
file-direct routes (Node-side) and the live-world routes (relayed to the renderer). The
renderer doesn't otherwise know the session mode, so the backend's `/api/editor-action` relay
injects `_persistenceMode` into the params of exactly these five ops before forwarding them
(`ASSET_PERSISTENCE_ACTIONS` in `editorBackendRouter.ts`) — everything else is unaffected.

`write_asset`/`create_asset` are deliberately unaffected by the mode: they're explicit "write
this file" tools, not live-state edits.

### Abandoning a parked write — `discard_asset_edits`

The registry originally had exactly ONE exit, `saveAll`, so an exploratory asset edit could not be
backed out. The obvious workaround — re-apply the previous def — **is not an undo**, and both ways
it differs were measured on `confetti.particle.json`:

- it **re-parks a write**, so the doc stays dirty and the next `save_all` commits it; and
- the def a caller can read back is the **migrated** one, so a committed legacy `"gravity": 6` is
  rewritten as `[0,-6,0]`.

That is how the live smoke suite (`test-smoke.mjs` UC6) came to modify a committed game asset while
reporting that it had restored it — its check compared only the field it had changed, and the
residue surfaced one `save_all` later. `discardDirtyAssets` is the missing exit, and UC6 now uses
it, so running the live gate leaves the working tree unchanged the way the e2e suite does.

Scope is deliberately narrow: it drops the pending WRITE, not the edit. The panel and viewport are
already showing the applied def and snapping them back would be a second surprise, so the live cache
keeps it until the asset reloads. To revert the value too: apply the previous def, **then** discard
the write that re-parked.

## The unsaved-work refusal names WHICH kind (S3.11)

`load_scene` / `new_scene` swap the world, so they refuse while `hasUnsavedChanges()` is true. That
function has **two independent causes** — a dirty scene edit-version and a pending asset write — and the
refusal used to blame only the first, naming `create_entity`/`duplicate_entity`/`prefab`. An agent whose
only unsaved work was a parked particle edit went looking for live entities it had never created. The
message is now built from `unsavedChangeCauses()` and lists `getDirtyAssetPaths()` when non-empty, so
`discardUnsaved:true` tells you what it would discard. Both causes still clear with one `save_all`.

## 6. Prior fix this generalizes

The prefab ops (`modoki_prefab` instantiate/create/detach) used to push **no** undo entry and
never bump `_editVersion`, so agent-instantiated prefabs were live-only yet reported
`unsavedChanges: false` — meaning `guardUnsaved` and the file-direct 409 both stayed silent and
the next hot-reload destroyed them while every tool reported `ok: true`. Fixed 2026-07-26 in
`agentEditorOps.ts` (+ `setPrefabSource` on instantiate). That fix — every live-world mutation
must push an undo entry, or the unsaved-work guards can't see it — is the pattern this whole
plan generalizes.
