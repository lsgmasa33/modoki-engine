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

**The five asset PANELS park here too, as of #259.** The Particle, Animation, Timeline, Skin and
SpriteAnim editors used to POST their document to disk on a 400 ms trailing debounce. That was a
second way for one file to be written, and each half was right locally: the agent op answered
`saved:false` while the panel had already put bytes on disk. What it cost, all three measured
rather than argued:

- **The two collided.** `particle_set` parked v1, a panel write put v2 on disk, `dirtyAssetPaths`
  still listed the path, and `save_all` rewrote the file back to v1 — the human's panel edits gone.
- **It wrote committed files behind your back** (CLAUDE.md #18), from inside the editor, so a QA
  case whose cleanup relied on "nothing was saved" left a modified asset for someone else's
  `git add -A`.
- **There was no undo for it**: a debounced write lands with no undo entry, so a mis-drag on a
  curve was permanent the moment the timer fired.

⚠️ **That claim used to end "— there is no longer a second contract", and it was false for as long
as it stood (#831).** #259 fixed the five panels it named and left the Inspector's asset VIEWS
— Material, MaterialBatch, Shader and AnimSet — POSTing `/api/write-file` on every keystroke through
`persistAssetEdit`, while `get_editor_state` reported `persistenceMode:'manual'` and
`unsavedChanges:false`. The second contract was still there; only its owner had changed. The lesson
is the one #830's family is about: **a fix scoped to the instances someone listed reads afterwards
as a fix to the class**, and the sentence claiming completeness is what stops anyone re-checking.
Those four views park through the same registry as of #831 (`markAssetDirty(path, type, data,
'panel')`), and `AtlasAssetView` — the fifth, which reached disk through its own compare-and-swap
queue rather than `persistAssetEdit` — joined them in the same issue. So the claim is now stated as
a measurement rather than a flourish: **ten surfaces park, and `grep -rn "persistAssetEdit(" `
names five of them.**

### A parked doc's staleness guarantee depends on the kind being watched

A parked write is dropped as stale the moment its file changes on disk — `dropParkedWriteFor`
(`engine/app/debug/agentBridge.ts`), triggered off the `modoki:scene-changed` broadcast. That
broadcast fires only for a file whose kind has a `LiveReloadKind`
(`classifySceneChange`, `engine/plugins/vite-asset-scanner.ts`); a kind with none never broadcasts,
so a park for it is never dropped no matter what happens to the file underneath. `material` and
`shader` had no `LiveReloadKind` between #831 (when their Inspector views started parking) and
#842 (when the two kinds were added) — so for that whole window a stale parked material/shader
edit could silently overwrite a newer on-disk write at the next Cmd+S, with nothing to catch it.
See [editor.md](./editor.md) § "The asset Inspector — six rules that have each failed
repeatedly", rule 6, for the two-mechanism picture this is one half of.

### Wiring a kind into the table is only HALF the job — the invalidator must USE the path

`ASSET_CACHE_INVALIDATORS` (`engine/app/debug/agentBridge.ts`) maps each `SceneChangedKind` to a
`(urlPath: string) => void`. The signature hands every invalidator the path of the ONE file that
changed. **An invalidator that ignores it and clears its whole cache is wired and still wrong**:
the reload fires, the edit takes, and every unrelated entity pays for it.

That was `invalidateShader` for the length of #842's window (#852). One `.shader.json` write — an
agent's `write_asset`, an Inspector edit, a `git pull` touching one file — called
`clearSpriteMaterialCache()`, so every compiled 2D material program in the scene was dropped and
every material entity drew its fallback sprite for a frame while its Mesh + Shader slot was
re-minted. Nothing errored, the edit *did* take, and the only symptom was a flash on entities that
had nothing to do with the file.

The seven other entries were already per-key on the shared pattern —
`createTeardownToken<K>()` (`runtime/core/liveness.ts`), `capture(key)` before the await,
`invalidateKey(key)` in the evictor — and #852 converted the eighth. Two rules fall out, and
`engine/tests/architecture/invalidatorGranularity.test.ts` now guards the first:

- **Evict per-key, never wholesale.** A wholesale `clear*Cache()` belongs to teardown (world swap,
  renderer stop), not to "one file changed". Where the cache's key is not the path — the 2D program
  map is keyed by GUID — resolve it (`isGuid(p) ? p : getGuidForPath(p)`, the precedent is
  `agentEditorOps.ts`'s read-asset-def shader arm) rather than giving up and clearing everything.
- **An unresolved key means UNKNOWN, not absent — fail safe.** A per-key evictor that no-ops on a
  path it cannot resolve (a brand-new asset the manifest has not indexed) leaves the edited asset's
  own stale entry live, which is the author's edit silently not taking — #523's symptom, and worse
  than the over-eviction being fixed. Fall back to the wholesale clear.
- **Fire the waiters you evict.** A superseded in-flight load deliberately fires no `onReady`, so
  dropping a key's waiter set without invoking it strands any renderer still live across the
  invalidation (a sibling viewport; the editor's GameView + SceneView) on its fallback until some
  unrelated dirty. `clearSpriteMaterialCache` snapshots-then-fires for this reason; a per-key
  evictor owes the same, for its one key.

⚠️ **`AtlasAssetView` needed one thing the registry did not have, and it is worth knowing before
the next surface parks.** Nothing tells that panel its file changed underneath — `atlas` is not a
`SceneChangedKind`, so `dropParkedWriteFor` never fires for it — so it carries a compare-and-swap
baseline on the entry (`DirtyAsset.ifMatch`), which the flush sends as `/api/asset-write`'s write
precondition. Parking made that window LONGER, not shorter: the read-to-write gap used to be one
keystroke and is now however long the human takes to press Cmd+S. Mechanism and the conflict UX:
[editor.md](./editor.md) § 6.

⚠️ **`SceneAssetView` is manual too, and it is the one surface that does NOT park here.** It sets
one field (`baseScene`) on a `.scene.json`, which is a single-field MUTATION rather than a document
write — this registry is not its shape, because a scene file is also what the live world serializes
INTO on save and a whole-file overwrite would destroy unsaved live-world changes. It has its own
one-field registry, `editor/scene/pendingBaseScene.ts`, flushed by the same `saveAll`. Two things
about it are worth knowing before touching either:

- **The OPEN scene does not go through that registry at all.** `serializeScene` emits `baseScene`
  from `setCurrentBaseScene`'s module state, so for the active scene the panel applies the ref
  THERE and the ordinary scene save writes it. That is also a bug fix: `_currentBaseScene` was only
  ever set at LOAD, so setting a base on the open scene put the ref in the file and the next Cmd+S
  serialised the stale module value straight back over it.
- **Its flush runs LAST in `saveAll`, and takes its entries before issuing anything.**
  `/api/scene-mutate` refuses while `hasUnsavedChanges()` is true, and these entries are part of
  that report — so a flush that ran first, or that left them parked while calling, would 409
  against the very save trying to persist it. Both halves are asserted
  (`tests/architecture/baseSceneEditIsManual.test.ts`, `tests/editor/pendingBaseScene.test.ts`).

It is the FOURTH cause `unsavedChangeCauses()` names, for the S3.11 reason: a refusal driven by it
alone used to name no cause at all.

⚠️ **The Inspector's import-settings controls (texture compression, LOD ratios, …) are manual too,
and they are a SECOND surface that does not fit this registry (#845).** Their target is a
`.meta.json` SIDECAR, not one of the eight `ASSET_SCHEMA_TYPES` documents — it is hard-keyed to
`AssetSchemaType` throughout (the route, the MCP zod enums, `assetTypeParity.test.ts`, the watcher
classification), so widening the registry to carry a ninth, differently-shaped document would leak
into all of them. They get their OWN sibling registry instead, `editor/scene/pendingMeta.ts`,
flushed alongside the dirty-asset registry (no ordering constraint — `/api/write-meta` carries no
unsaved-work refusal, unlike `/api/scene-mutate` above). Two things worth knowing:

- **There is no live branch and therefore no `activeFlushMarkers`.** `pendingBaseScene.ts` needs
  one because the OPEN scene bypasses its park entirely; every `.meta.json` field change parks,
  full stop, so its plain `!pending.has(path)` re-park guard is already sufficient.
- **A re-import reads the sidecar off DISK**, both to know what to convert with and to report back
  what it baked — so every call site that fires one flushes ITS path first
  (`flushPendingMetaFor`), or the conversion would run against the OLD settings while the panel
  already shows the new ones, and the stale park would go on to overwrite the reimport's own fresh
  write at the next Cmd+S.

- **Every reader of `/api/read-meta` owes recording what the response TAUGHT it — including a
  reader exempt from `readMetaPreferringPark`** (#871). `noteMetaReadResult` is the one place that
  does it, and it records two things: the CAS baseline (the SERVER's hash) on success, and the
  READ-FAILED flag on anything else — the flag that stops a panel parking a document built on the
  `{}` fallback, which would write an id-less sidecar and let the scanner mint a fresh GUID.
  ⚠️ **The two halves are recorded on DIFFERENT conditions, and collapsing them reopens the GUID
  destruction.** The read-failed flag is armed on *every* non-ok response; the baseline is skipped
  while a park is live (the parked doc came from older bytes, so a hash taken from disk now is a
  claim it cannot support), and a `passive` read — the agent surface — records neither. Gating the
  FLAG on the live park too shipped for one release and reopened the hole: the helper checks the
  park before its `await` and records after, so a park landing in between hides the failure from a
  DIFFERENT component whose own read failed and which is now showing the `{}` fallback.

  ⚠️ **That closes ONE interleaving, not the class — #880.** The flag is keyed by PATH and the
  hazard is keyed by COMPONENT, so a successful read still clears it for a reader that is not the
  one holding `{}`: reverse the order of those two responses and the id-less park is accepted
  exactly as before. The same root makes the armed state a WEDGE — `readMetaPreferringPark` returns
  early on a park and never reaches the network, so nothing clears the flag until the park is
  flushed AND the asset re-read (the refusal message says so). Both faces need identity the API
  does not carry, which is why #880 is filed rather than patched.

  ⚠️ **Both halves live in one function for the same reason, and the second one is why it is named
  for the response rather than for the baseline.** The `readFailed` half was added to that block
  independently, after it had been extracted; taking only the baseline half would have left the
  exempted video reader recording a baseline and not the failure — the same trap one field down,
  on the one asset type with no other reader. ⚠️ `VideoAssetView` is a *declared* exemption from the read helper, for a
  reason that is true and stays true — it keeps a third state (`applied`) that must reflect DISK, so
  it cannot use a helper that skips the network whenever a park exists. That reason vouches for
  **which document the panel displays** and for nothing else, and it was read as vouching for the
  file generally: its raw fetch dropped the header, so `baselines` had no entry for any `.mp4`, the
  flush passed `undefined` as `ifMatch`, and `ifMatchRefusal` reads an absent `ifMatch` as *proceed*
  — the #845 precondition was **inert for that whole asset type** while looking present. The
  exemption map now carries a declared `baseline: 'seeds' | 'none'` and
  `metaReadPreferringPark.test.ts` checks it both ways, because a prose reason cannot carry that
  distinction.
- **A wholesale editor write FORGETS the baseline it invalidated** (#874). Make-2D, a 9-slice or
  Sprite Save, a model import and the collision-mesh write all replace the sidecar while a panel is
  mounted on the same path. Leaving the old hash made the human's very next Cmd+S 409 under
  *"changed on disk since it was read"* — true of the file, a lie about the cause, and #844's class.
  Forget rather than advance: these callers never read the reply's `sha256`, an absent baseline
  correctly means unconditional, and the next panel read re-seeds it.

  ⚠️ **Two functions do it, and the difference is the whole defect** — do not collapse them.
  - `writeMetaWholesale` (the three explicit-action writers) does the write **and forgets ONLY IF
    it landed**. A failed write changed nothing on disk, so the baseline is still accurate;
    dropping it there turns every later flush for that path unconditional and an external change
    is silently clobbered instead of 409'd. That fail-open shipped once, because the rule was
    copied to three sites and two of them guarded it while one did not. One function now, one
    test, both directions.
  - `metaWrittenToDisk` (the callers that post the document themselves and report it in) drops the
    baseline **first and unconditionally** — including in the superseded case, where it returns
    `false` for the *park*. Two maps, two questions: *"did this write incorporate the park I
    read?"* can legitimately be no; *"does this editor still know what is on disk?"* after a
    confirmed write is always no. It is unconditional only because every one of its call sites is
    already behind a confirmed-ok write.

  `forgetMetaBaseline` itself is **module-private**: an exported bare "forget" invites the call
  that has no write behind it, which is exactly the fail-open above.
- **The teardown is the RELOAD, and that is deliberate.** `clearPendingMeta`/`clearMetaBaselines`
  are test-only and stay so: opening a project hard-reloads the renderer
  (`webContents.reloadIgnoringCache()` in `electron/main.ts`'s `setProject`, reached by all three
  of its callers), which destroys the module. The sibling registries' `clearDirtyAssets` and
  `clearPendingBaseScenes` have no production caller for the same reason. ⚠️ A **soft** project
  switch — re-rooting the asset tree without a reload — would make all three real, and `pending`
  would matter more than `baselines`. (#871 was filed on the reading that a baseline survives a
  project switch; it does not.)
- **The park is visible in the panel that made it** (#870). `useMetaDirty(path | paths)` +
  `<UnsavedMetaBadge>` in all eight parking asset views — the **conditional** `Unsaved ● ⌘S` marker
  `SceneAssetView` already used, not `useParkedAssetDoc`'s persistent `Unsaved ● ⌘S`/`Saved ✓` span,
  which belongs to panels owning a whole document. The subscription is the load-bearing part: a
  bare `isMetaDirty` read is right when the edit is made and wrong afterwards, because a Cmd+S
  flush and an agent `discard_asset_edits` both empty the registry without touching panel state.
  `metaDirtyIndicator.test.ts` asserts every parking **`.tsx` under `panels/`** both renders the
  badge and calls `useMetaDirty` — a badge rendered from a constant is dark forever, and a
  subscription nothing renders tells the human nothing. ⚠️ Its scan is `.tsx`-only, so a
  `parkMetaEdit` caller in a plain `.ts` module (`assetEditorBindings.ts`) is outside it.
- **The agent surface reads AND writes through the registry now** (#872 read half, #872/#882 write
  half). `modoki_get_asset_meta` goes to `/api/asset-meta` → the `read-asset-meta` op → the
  renderer, and reports `source: 'parked' | 'disk'`; with no renderer it falls back to disk and says
  `editorConnected:false` rather than passing a pre-edit file off as the answer.

  The write half is **one gate on three routes**, `metaParkGate` in `editorBackendRouter.ts`, asking
  the new `resolve-meta-park` op. The rule it generalises is worth more than the three fixes:
  **a registry that lives in the RENDERER is invisible to a NODE route, and consulting it is a
  round trip nobody makes unless a specific bug forces them to** — which is why this arrived one
  route at a time, each site individually correct.

  | Route | What a parked edit costs it | §8 consequence → hatch |
  |---|---|---|
  | `/api/write-meta` | replaces the sidecar wholesale; the park then flushes back over the write | **DESTROYED** → `discardUnsaved` |
  | `/api/reimport` | every handler reads the sidecar off DISK, so the bake uses the PRE-EDIT values | **un-included** → `force` |
  | `/api/duplicate-asset` | seeds the copy's sidecar from the source's FILE | **un-included** → `force` |

  Four things a reader should not have to re-derive:

  - ⚠️ **The gate lives on the ROUTE; the rule it enforces is an AGENT-surface rule. That gap
    broke the human editor** (#872 review). `/api/write-meta` is not agent-only: the Sprite Editor,
    the 9-slice editor and the Inspector's postprocessor row all POST through
    `writeMetaConditional`, and all three LOAD via `readMetaPreferringPark` and call
    `metaWrittenToDisk` after — so their document already CONTAINS the parked edit and the write is
    what legitimately retires it. Gating them 409'd a human's save, and `writeMetaConditional`
    reports a 409 as *"the file changed on disk"* — a wrong diagnosis of a file that did not change,
    with the slices unsaveable. `rendererWrite: true` exempts the one renderer POST definition, and
    the flag asserts something about the **calling process**, not about the document: a write issued
    from the renderer is never blind to a registry it owns. The Assets panel's Duplicate is the same
    class with a quieter symptom — it flushes the source's park first (the click is consent, as
    `assetViews/reimport.ts` already does) rather than being refused with the reason discarded.
  - ⚠️ **`unknown agent op` does NOT mean "no renderer" over this transport.** `ws.send`
    BROADCASTS to every HMR client and `createBrowserRequestRegistry` is first-reply-wins;
    `initAgentBridge()` runs on any editor-flagged page but `registerEditorAgentOps()` only from
    `editor/setup.ts`. So a second tab on the dev server's runtime route answers *"unknown agent
    op"* instantly and beats the editor tab that actually holds the park — and reading that as
    "absent" let the write through while telling the caller there was no renderer. One client's
    "I do not have that op" says nothing about whether another client does; it is "could not look".
    (`applyMovesInRenderer` may still treat it as absent — it is best-effort repair, not a guard.)
  - ⚠️ **The discard follows a SUCCESSFUL write, it does not ride along with the probe.** Doing
    both in one op is tighter against a concurrent park, and it bought that by destroying the
    human's edit before `writeMetaSidecar` could still fail — a read-only sidecar or ENOSPC left
    the edit gone and nothing written. The window the split reopens is the opposite way round and
    strictly smaller.
  - ⚠️ **Gate on the CANONICAL asset URL** (`normalizeAssetUrl`, shared with `resolveAssetPath`).
    A raw request string like `assets/x.png` or `/my%20tex.png` resolves to a real file while the
    park is filed under the canonical form, so the check missed and the write destroyed the park it
    had just looked for.
  - ⚠️ **The gate must not fail OPEN, and that is the hard part.** `requestBrowser` rejects on a
    timeout, and *"the renderer did not answer"* is not *"there is no park"* (§5). It reuses
    `applyMovesInRenderer`'s classifier rather than a second copy — `isRelayTransportFailure` minus
    `isRelayTimeout`. A definitively-absent renderer PROCEEDS (a park is renderer-only state, so
    with no renderer there is none) and says `editorConnected:false`; a **silent** one REFUSES with
    `NO_RENDERER`. Reading a timeout as "clear" would be #872 rebuilt inside its own fix, and every
    test that stubs a working renderer passes either way.
  - **The probe uses `peekPendingMeta`, never `readMetaPreferringPark`** — the same correction the
    read half carries as `passive`. An observer must not disarm the guard it observes, and a WRITE
    gate has more power to get that wrong than a read, not less.
  - **Probe and discard are ONE op**, so a park cannot land between the check and the write.
  - **A discard deliberately leaves `readFailed` ARMED.** Clearing it would let a component still
    holding the `{}` fallback park an id-less document, which is the GUID destruction that flag
    exists to prevent — so an agent `discardUnsaved` can still leave a path wedged for the panel.
    That is #880's second face, reachable by one more route, and it is not papered over.

  - ⚠️ **The gate cannot see the EDITOR'S OWN save, and no flag makes it — `flushPendingMeta`
    takes the batch out and `pending.clear()`s it BEFORE issuing any request**. By the time
    `/api/write-meta` asks `resolve-meta-park`, the registry is empty for every path in that flush,
    so the probe honestly answers `clear` and the write proceeds. The clear-first ordering is
    correct for its own reason (a `flushPendingMetaFor` landing mid-flush must not see a document
    this flush is about to overwrite), and `rendererWrite:true` is not what is doing the work here
    — the gate would pass even without it. **So the gate covers the AGENT reaching past a human's
    parked edit; it does not and cannot cover a poisoned document the human saves themselves**
    (verified against #890/#891's repro, `work-qa` 2026-09-07). Read together with the first bullet
    above, the two say the same thing from both ends: this is a route-shaped guard on a
    process-shaped rule, and the human's own save is outside it by construction. Whatever fixes
    `family/unscoped-panel-state` has to stop the document being POISONED — refusing the write
    downstream is a place the check cannot reach.

  ⚠️ **It refuses rather than flushing**, which is the one place the agent surface deliberately
  differs from the UI. `assetViews/reimport.ts` flushes the park before re-importing, because the
  human clicked Re-import in the panel where they made the edit and that click IS consent to
  persist it. An agent has no such mandate, and §8's settled precedent (`modoki_build` refuses
  rather than auto-saving) is the agent-surface answer.

  ⚠️ Still true, and still the reason all of this is needed: nothing reconciles a sidecar the way
  the watcher reconciles an asset doc — `.meta.json` is invisible to `detectType`, so
  `dropParkedWriteFor` never fires for one. That is the `LiveReloadKind`-vs-CAS rule in
  [editor.md](./editor.md) for a third time.

  ⚠️ **`modoki_discard_asset_edits` does NOT cover this registry** and never has. It owns the
  dirty-asset registry only, so `all:true` reads as a clean slate it does not deliver; it now
  REPORTS the parked sidecar edits it did not touch (`remainingImportSettings`) rather than
  widening what it destroys. The named exits from a park are `modoki_save_all` and
  `modoki_write_asset_meta {discardUnsaved:true}`.

  ⚠️ **The class is wider than this registry, and the remaining member is filed.** The mechanism
  — *a Node route reads a file while a renderer registry holds a newer unsaved version of it* — is
  not specific to `pendingMeta`. `duplicateAssetFile`'s JSON branch reads the source asset **doc**
  off disk with no `dirtyAssets` consult, so duplicating a `.mat.json` with a parked panel edit
  produces a copy built from pre-edit bytes. Four instances across two registries says the missing
  abstraction is ONE "what unsaved state exists for these paths" probe spanning all four renderer
  registries, not a fourth gate; that is the design call in the issue, not something a finishing
  pass gets to widen into.

  Guarded three ways: `plugins/metaParkGate.test.ts` (both sides of every route),
  `framework/resolveMetaParkOp.test.ts` (the op's non-recording contract), and
  `architecture/metaParkGateCoverage.test.ts` — the corpus guard that fails when a FOURTH route
  touches a sidecar without gating or declaring why it cannot be in the way. Live: smoke UC14
  asserts the probe actually reaches the renderer (`editorConnected:false` while an editor is
  attached means the gate has silently gone inert); the REFUSAL side has no agent equivalent to
  park an edit, so it is hand-verified.

It is the FIFTH cause `unsavedChangeCauses()` names (`pendingImportSettings`), for the same S3.11
reason as the fourth.

Now every panel edit is a `markAssetDirty(path, type, doc, 'panel')` and **Cmd+S is the write**.
Three consequences worth knowing:

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
- **`replace:true` means the normalizer's OUTPUT is the whole file — spread the source at EVERY
  level it rebuilds, not just the top (#821).** `normalizeTimeline`/`normalizeAnimationClip`/
  `normalizeSpriteAnim` each rebuild their document from an enumerated field list; the top level
  of all three carried a `...json` spread already, but the `.map()`s that rebuild a nested entry
  (a timeline clip/marker/cue/span, an animation track/deform-track/deform-keyframe, a
  sprite-anim clip) did not, so a key none of them named survived a top-level round-trip and was
  silently deleted from a nested one on the first panel save. The fix spreads the source entry
  FIRST in each rebuilt object literal, named/normalized fields after — "a key this build
  understands wins over a stale copy of itself," the same invariant `mergeUnknownFields` enforces
  at the top level — which also preserves each unknown key's original POSITION in the object
  wherever the rebuild spreads the source directly (`{ ...c, ... }`, `{ ...m, ... }`, etc.).
  **The general property: a key's ORIGINAL POSITION survives wherever the rebuild spreads the
  source object itself; it does NOT survive at a site that destructures owned keys out and
  spreads `...rest` instead** — those owned keys move to the end whenever the entry carries an
  extra key. Two sites do this today: the control-clip branch (`start`/`duration`/`prefab`/
  `transform`) and `normalizeTrack`'s track-level destructure (`type`/`clips`/`markers`/`cues`/
  `spans`) — an authored `id,type,futureField,clips,name` normalizes to
  `id,futureField,name,target,muted,type,clips`. Treat this as a property of the shape, not a
  closed list: any future site built the same way (destructure-and-`...rest`) inherits it. A per-
  entry `known`-list keyed to `mergeUnknownFields`/`collectUnknownFields`
  was considered and rejected; those are whole-document one-shots and would need a distinct list
  per branch for no benefit over the spread. Two documents that LOOK like the same shape are not
  members of this defect: `normalizeParticleDef` already spreads at every level (a working
  counterexample, not a fix target), and `normalizeRig2D`/`normalizePart`/`coerceRigBones` share
  the shape but sit off the `replace:true` write path — `SkinEditor.tsx` parks the raw
  `Rig2DFile`, not this normalizer's output — and `normalizeAnimSet` is dead code on this path:
  `AnimSetAssetView.tsx` never calls it and doesn't use `useParkedAssetDoc`. Tests:
  `tests/runtime/assetDocPassthrough.test.ts`.
  - ⚠️ **Spread the keys you do NOT own — a blanket `...source` resurrects what the normalizer
    just decided to discard.** "Preserve unknown keys" is not "preserve everything", and the
    difference bites wherever a rebuild deliberately re-decides a NAMED key. Caught in review on
    the control-clip branch: its documented precedence (*prefab > particle > subdirector*) exists
    to make an over-specified clip come out prefab-ONLY, and `transform` is omitted precisely
    when `normalizeControlTransform` REJECTS it — a blanket `...c` put both back, so the clip kept
    two discriminants and a malformed transform that had just failed validation. The shape that
    works is to destructure the owned keys out and spread the `...rest`. **A passthrough test
    cannot catch this** — an unknown key survives either way — so a rebuild that drops or
    re-decides anything needs a second test asserting the DROP still happens, alongside the one
    asserting the carry-through.

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

### The bytes a save writes

**`assetJsonBytes` (`engine/plugins/backend/editorBackendRouter.ts`) is the one definition of what
an asset JSON write puts on disk** — `JSON.stringify(doc, null, 2)` **plus a trailing newline**.
`writeJsonAtomic` and both self-write FINGERPRINT sites read it, and
`tests/plugins/assetJsonBytesAgree.test.ts` asserts they cannot drift.

⚠️ **The fingerprint is why this is one function and not three call sites.** `markEditorWrite(abs,
sha1(bytes))` is how the file watcher skips the editor's own save; a hash that does not match what
actually landed **fails OPEN** — the change event returns ~150 ms later, is read as an EXTERNAL
edit, and `dropParkedWriteFor` discards whatever the human had parked. Getting the newline right at
two of three sites would have been worse than leaving the bug.

Two sibling writers share it (both fixed in #831 after the live check caught them): the asset
scanner's guid **heal**, which rewrites any doc written without an `id` ~150 ms later, and
`asset-fs-ops.ts`'s asset **copy**. `scripts/migrate-assets.mjs` carries the same byte as a literal
(it is `.mjs` and cannot import the `.ts`), with a comment saying so — its old comment justified
*omitting* the newline by matching the editor, and would have produced exactly the churn it was
written to prevent once the editor changed.

This used to cover the SERVER seam only — scenes, prefabs, and the panels' create paths serialise
**client-side** and POST the finished string, so `assetJsonBytes` was not in their path and they
dropped the newline. #835 gave the client the same byte producer (`jsonFileBody` in
`editor/backend/editorBackend.ts`) and a single write wrapper every client JSON site routes
through — see `docs/editor.md` § "The client write seam" for that half. (`AtlasAssetView` was
already off this seam before #835: since #831 it parks an OBJECT and the bytes are
`assetJsonBytes`' like every other asset doc.)

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

**The same collapsed-boolean defect existed on two more refusal surfaces, fixed in #844.**
`/api/scene-mutate`'s file-direct fallback 409 (`editorBackendRouter.ts`) and the MCP-side
`unsavedChangesWarning()` (`modoki-mcp/src/context.ts`, serving `modoki_build`,
`modoki_add_native_target`, `modoki_ota_publish`) both used to build their refusal from the same
flat `unsavedChanges` boolean the `guardUnsaved` fix above replaced — so both still blamed
`create_entity`/`duplicate_entity`/`prefab` even when the actual cause was a dirty asset (a
Material slider drag parks one the same way, since #831). Both now read the same
`unsavedCauses`/`unsavedChangeCauses()` shape and name the dirty asset paths.

**The durable lesson, which is the point of this section and not the instance list: a refusal
message derived from a collapsed boolean names whatever cause existed when the message was
written, and then stays green forever afterwards** — nothing tests a refusal's *reason*, only
whether it fires. `engine/tests/tools/unsavedGate.test.ts` is the cheap tell that makes #844's fix
actually verifiable: it asserts the message NAMES the dirty asset path AND does **not** contain
`create_entity`. The negative half is what makes the test bite — a naive positive-only assertion
would have passed against the old fixed string too, since the old string happened to still be
present as a fallback.

**Still open, same family, needing a different shape of fix (#850):** `hmrStaleness.ts`'s
unsaved-work banner/warning messages are all built from `DirtyProbe`'s single collapsed boolean
(`initHmrStaleness`, `engine/app/debug/hmrStaleness.ts`) rather than from `unsavedChangeCauses()`,
so they carry the same generic wording regardless of which kind of unsaved work triggered them.
Because that seam is a boolean-returning callback rather than a call site that can simply be
swapped for a richer one, fixing it means widening the `DirtyProbe` seam itself, not just
changing what a caller passes.

## 6. Prior fix this generalizes

The prefab ops (`modoki_prefab` instantiate/create/detach) used to push **no** undo entry and
never bump `_editVersion`, so agent-instantiated prefabs were live-only yet reported
`unsavedChanges: false` — meaning `guardUnsaved` and the file-direct 409 both stayed silent and
the next hot-reload destroyed them while every tool reported `ok: true`. Fixed 2026-07-26 in
`agentEditorOps.ts` (+ `setPrefabSource` on instantiate). That fix — every live-world mutation
must push an undo entry, or the unsaved-work guards can't see it — is the pattern this whole
plan generalizes.
