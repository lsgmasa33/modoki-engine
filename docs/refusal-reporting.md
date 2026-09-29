# Refusal reporting

How a refusal travels from the place that decides it to the person or agent who asked. A refusal is an
operation that declined, failed, or only partly happened. This doc covers the editor's backend routes,
their client wrappers, and undo/redo steps.

See also: [Visual Editor](./editor.md) (§ "Undo / redo", and the `/api/write-file` seam under § "Asset
editors") · [MCP tool conventions](./mcp-tool-conventions.md) § 5 (the error envelope) ·
[MCP persistence](./mcp-persistence.md) · [Format versioning](./format-versioning.md) (its "refusal
channel is local" rule, which R5 below follows)

## Model and invariants

This section states the rules every refusal must obey, and names the function that owns each rule
today. It was recovered from the code for the #1824/#1823 design study (2026-09-29), on #1683's
template ([prefabs.md](./prefabs.md) § "Model and invariants"). If this section and the code disagree,
the code is right and this section is stale: fix it in the same change.

### The model: four hops

1. **The route decides, and says why in its body.** The routes are in
   `engine/plugins/backend/editorBackendRouter.ts`. Both hosts serve them: the Vite middleware and the
   Electron `backendServer.ts`. The streaming (SSE) routes are the exception: `/api/build`,
   `/api/add-native-target`, `/api/toolchain/install` and `/api/ota/publish` are host-owned, in
   `engine/plugins/vite-asset-scanner.ts`, and Electron's `backendServer.ts` proxies them.
2. **A client wrapper reads the answer into an outcome.** This happens in `editor/backend/editorBackend.ts`,
   `editor/panels/assetOps.ts` and the other wrappers listed below.
3. **The caller states the outcome to whoever asked.** There are three channels:
   - an agent op's reply: `OpRefusal`, turned into `{ok:false, code, error}` by `opReplyFor` (`app/debug/opRefusal.ts`)
   - the human's toast or dialog
   - inside an undo or redo step, the step's report
4. **An undo or redo step's outcome reaches `undoStep`** (`editor/undo/undoManager.ts`). Both triggers
   read it:
   - the human's Cmd+Z, menu and toolbar, through `runUndoCommand` (`undo/undoCommand.ts`)
   - the agent's `undo`/`redo` op, `undoOrRefuse` (`app/editor/agentEditorOps.ts`)

**The agent side already has hop 2's reader, with one distinction the client's must keep.** The MCP
servers decide success with `isFailureBody` and relay the code with `codeFromBody`
(`engine/tools/shared/errorCodes.ts`), and `agentBridge.ts` imports both. But `isFailureBody` is not
run on every answer. The modoki server's `getJson` (`engine/tools/modoki-mcp/src/context.ts`) runs it
only when the call opts in (`checkFailure`), for a GET whose `ok` is a success flag. On a read like
`diagnose`, `validate_scene` or `/api/validate-prefab`, `ok:false` *is the answer*, not a refusal. The
editor client is the half without a reader. `@modoki/engine` cannot import `tools/shared`:
its build is rooted at `packages/modoki/src`, as `EntityResolveCode`'s comment in
`runtime/scene/sceneMutate.ts` explains. So the client grew its own readers, one per wrapper. Only
`/api/write-file`'s reader (`readWriteRefusal`, #1811) is shared.

### Invariants

**Owner** is the function that answers the rule today. **Bypassed by** lists the places that answer the
same question for themselves. Each place in that column is a place the rule can break. The per-site
census, with each site's class and its reach, is on #1824 (routes) and #1823 (undo). It lives there
because it goes stale.

| # | Rule | Owner | Bypassed by |
|---|---|---|---|
| R1 | Every refusal a route sends carries a non-empty `error`: a sentence a person can act on. A machine token goes in `reason`, and a § 5 class goes in `code`. | The shared refusal builders in `editorBackendRouter.ts` (`unsavedRefusal`, `wrongKindRefusal`, `outsideAssetRoots`), and each host's `{error}` for 400/403/404/413/500. | `ifMatchRefusal` (the if-match 409 of `/api/write-file` and `/api/write-meta`) and `/api/write-file`'s if-none-match 409 carry `reason` only. `/api/save-dialog`'s 200 `{error:'outside-asset-roots'}` holds a token, not a sentence (its one caller, `chooseNewAssetPath` (`editor/utils/saveDialog.ts`), branches on the token and puts its own sentence on screen, so nobody is misled today). The pre-stream refusals of `/api/build` (its validation 400s) and `/api/ota/publish` are JSON bodies that an `EventSource` cannot read, so the dialog shows "Connection lost." `/api/toolchain/install` and `/api/build`'s job-lock refusal already open the stream first and send `FAILED:<reason>`, which is the shape to copy. |
| R2 | On a mutating route, where `ok` is a success flag, success and refusal are decided one way: `isFailureBody`'s. A non-2xx is a refusal. A 2xx is a refusal when its body says `ok:false`, or carries `errors` or an `error` without `ok:true`. A 2xx with `ok:true` and notes (`errors`, `failed`, `held`, `repairFailed`) is a partial success, not a refusal. A read whose `ok:false` is its answer is outside this rule (see above). | Agent side: `isFailureBody`, opted into per call. Editor client: **none**. Each wrapper decides for itself. | **False successes:** `reimportPaths` (`panels/assetViews/reimport.ts`) reads only `errors`, so a 404/409/422/503/500 that carries none is counted as re-imported and its caches are evicted. `importRiggedModel`'s derived-variant re-import (`scene/modelImport.ts`) does the same. `saveAiSettings` (`panels/aiSettingsModel.ts`) returns the cached settings on a refusal, which reads as a save. |
| R3 | A refusal's reason is read one way: the body's `error`, else `reason`, else its `errors`, else `HTTP <status>`. It is never empty. `code`, `options` and a precondition `conflict` travel with it. | `readWriteRefusal` (`editor/backend/editorBackend.ts`), for `/api/write-file` only. | Every other wrapper: `deleteAssetFile`, `deleteAssetFiles`, `duplicateAssetFileReport`, `createFolderApi`, `moveFileToStatus`/`moveFileTo`, `firstWritableAssetRoot` (`panels/assetOps.ts`); `writeMetaConditional` (`panels/assetViews/widgets.tsx`), which answers `HTTP <n>` and calls every 409 "changed on disk"; `writeSceneCopy`, `importedFileContent`, `repairPrefabMemberPaths` (`editorBackend.ts`); `writeLayoutJson` (`utils/layoutStore.ts`); `makeTexture2D`; `writeCollisionMeshAssets`; the re-import in the Texture, Font, Audio, Video, Atlas, Model and Environment asset views; and `modelImport.ts`'s three `/api/write-meta` posts. |
| R4 | A wrapper hands the reason to its caller as data. It does not log it and then return a bare boolean, `null` or `{ok:false}`. | The `/api/write-file` wrappers since #1811: `writeAssetFile` answers `{ok:false, error, options?}`, and `writeAssetFileGuarded` answers `'conflict'` or `'failed'` with the error. | The same list as R3. The "console, then `null`" shape (`importedFileContent`, `repairPrefabMemberPaths`, `duplicateAssetFileReport`) hides the most, because the log looks like handling. |
| R5 | The caller states the reason to whoever asked. **An agent** gets the route's `code`, relayed and never invented (`codeFromBody`'s rule), plus its `error`. **A human gesture** puts the reason on screen, not only in the console (#901, #1577). Which widget says it is the caller's choice: the channel is local, as it is in format-versioning.md. | Each caller. | Results thrown away: the post-import convert in `Assets.tsx` (`.catch(() => {})`), paste's cut and copy skips, `TextureBatchView`/`ModelBatchView`, all nine callers of `flushPendingMetaFor`, `BuildSupportDialog`'s toolchain settings, the layout autosave, and `writeCollisionMeshAssets`' meta write. For an agent, Apply to Prefab's result simply lacks `fileRepair` when `repairPrefabMemberPaths` failed. Human refusals that reach only the console: Duplicate or Paste of an asset with unsaved edits (`/api/duplicate-asset`'s unsaved gate refuses the human path by design), folder create/rename/delete, and a layout save. |
| U1 | An undo or redo step's outcome reaches `UndoStepResult`, the one result every trigger reads. The outcome is one of: applied; **applied in part** (`shortfall`); refused, with nothing applied; threw; **dropped** (`dropped`). | `runStep` / `undoStep` (`undo/undoManager.ts`): a throw since #1681; since #1823 (Owner B), every `reportUndoFailure` made inside the step's window (`undo/stepWindow.ts`) as `shortfall`, and a world swap under the step as `dropped`. | **Target misses found before anything is written** are not shortfalls: they are refusals, owned by `require` ([prefabs.md](./prefabs.md) I19, work-ai3). Until it lands, `writeTraitFieldWithUndo` and the rest of the I19 "silent no-op" list still answer `did:true`. A miss found AFTER a write is a shortfall and reports today (Create Prefab's redo rebuild and undo untag). `baseSceneUndo.ts`'s two reports are probably unreachable (SceneAssetView's `write` returns true since #831). |
| U2 | The agent's undo/redo reply says what the human is told. | `undoOrRefuse` (`app/editor/agentEditorOps.ts`): `PARTIAL` + `entry:'moved'` for a shortfall, `PARTIAL` + `entry:'dropped'` for a drop or a throw, `REFUSED_BY_OP` + `entry:'dropped'` for a refusal. The human gets one toast per step that fell short (`reportStepShortfall`, owner ruling F1 2026-09-29). `runSequential` (`undo/compositeAction.ts`) keeps each sub's class: all refused is a refusal, anything else a `CompositeStepError` naming each sub. | A dropped step's human side is still only a `console.warn`: a world switch waits for steps (`beginWorldSwitch`), so the drop is a backstop. |
| U3 | A shortfall report names the reason the step's helper had. | `reportUndoFailure`'s `detail`. Since #1823, `makeModelImportUndo`, `createPrefabFromEntity` and `makeRigPrefabAsset` name the write's `error`, and `makeDeleteUndo`'s collision line names the write failure its partial branch no longer reaches. | Every site whose helper had already dropped the reason (R4) cannot name it: `deleteAssetFiles`, `moveFileToStatus`, `createFolderApi`, `duplicateAssetFileReport`, `importedFileContent`. Owner A fixes those. |

### Steps are serialized against each other, not against the rest of the editor

`undoStep` runs every step through `serialize` (`undoManager.ts`), one `_inFlight` chain, so no two
steps' closures ever overlap. **Forward work still runs during a step's awaits.** A human gesture, an
agent op, or a debounced save proceeds while a step awaits a fetch. The browser has no async context to
tell the step's own calls from those. The comment above `_captureStack` says so for capture frames, and
`beginWorldSwitch`'s docblock says `isExecutingUndoRedo()` "reads true for a concurrent user gesture
too".

So "the step that is running" is a **time window**, not ownership. **`undo/stepWindow.ts` is its one
definition** (#1823, #1832): `runStep` opens and closes it, and `isExecutingUndoRedo()`, `pushAction`'s
and `pushSelectionChange`'s guards, and `reportUndoFailure`'s collector all read it. Anything keyed on it
attributes by time, so the rule is: **where the forward work is ours to schedule, keep it OUT of the
window, by refusing it rather than waiting for it.**
- **Reports.** A `reportUndoFailure` fired by forward work inside a step's window would land in that
  step. The only forward caller is `compositeAction`'s `rollback`, which undoes the subs of a forward
  batch that failed. It runs **on the step chain** (`runOnStepChain`): no window is open while it
  reports and none opens under it, so its reports stay console-only. Every other `reportUndoFailure`
  call runs inside an undo/redo closure (the study's review checked each; `rederiveBaseInstances` is
  reached only from Apply's undo and redo). Suspending collection during rollback was rejected: that is
  a time window too, and would swallow the real step's reports made during rollback's awaits.
- **Pushes (#1832, observed headlessly).** `pushAction` drops a push made inside the window, so a
  forward edit made while a step awaits applied with no undo entry. Even a kept push would clear the
  redo stack before the step pushed its entry there. **The agent half is closed by exclusion:** the
  editor's op gate (`agentStepGate`, asked by `runAgentOp`) refuses an op that records an undo entry
  (`app/editor/agentOpUndoClass.ts`, every op classified; `prefab` by action, so `edit-exit` still waits
  for the step as #1579 designed) while a step is queued or running, and while
  such an op runs it holds new steps off (`beginForwardEdit` → `undoRefusedReason`), because a step
  opening during the op's await drops its push the same way. `eval` is never gated, because it is how an
  agent looks at an editor whose step has stalled; its `modoki.composite` is gated and held like an op.
  A hold that never settles warns after 10s, as a stalled world switch does, and lets go after 30s
  (`FORWARD_EDIT_MAX_HOLD_MS`): an eval's timeout abandons its body without cancelling it, and an unbounded
  hold then refused every human undo until a reload. A dry-run Apply records nothing and is not gated. **The human half is open (#1833):** nothing can tell a closure's own echo push
  from a human forward edit, so every push in the window is still dropped until the echo pushes are
  measured live.

A report fired with **no** step open keeps its old console-only behaviour. That covers a rollback, a
forward path that runs a closure directly (`Hierarchy` applies a sibling renumber by calling its
`redo()`), and work a closure starts and does not await.

## Classification of the history

Every member fits a rule above, and none needs a new rule.

- **R1–R5, the transport half.**
  - #1811 created R3's owner, for `/api/write-file` only. #1776 was its observed symptom: `modoki_prefab create` answered `ok:false` with no reason.
  - #884 was an R2 partial-success body nothing read.
  - #901 and #903 set R5's human rule: on screen, not console-only.
  - #1212, #1211, #1013 and #1012 set R5's agent rule: relay the code, never stamp one. They are agent-side, and done.
  - #1574 and #1577 are R5 for Play, one per channel.
  - **#1824 is the remainder:** every route but `/api/write-file`. The census adds two false successes it did not list (`importRiggedModel`'s re-import and `saveAiSettings`), `writeMetaConditional`'s `HTTP <n>`, the SSE pre-stream refusals, and R1's route-side gaps.
- **U1–U3, the undo half.**
  - #308 swept the closures that ignored a helper's boolean, and settled "report, don't throw". #310 made a throw survivable.
  - #1681 created U1's owner for a throw.
  - #1668 took the throw route for Apply's failed write.
  - #1732 is U3 for a multi-file commit.
  - **#1823 is the remainder:** the step that reports and returns. The census adds the dropped step (`did:true`), `runSequential`'s flattening, and the silent target lookups (below).
- **Adjacent, owned elsewhere: only the raw-id fallback.** #1827 (work-ai3's study) owns the five creation-type undos that fall back to a raw ECS id and delete the wrong entity. That is an identity bug, not a reporting one. **The silent `ref.resolve()` early returns are NOT in #1827** (`writeTraitFieldWithUndo` and about six more in `entityActions.ts`). They are U1 bypasses, "did nothing, answered `did:true`", so they join #1823: each needs one line that reports, and Owner B carries the rest.
- **Ejected:** #1661. Apply skips an `applyExcluded` key without a `skipped` entry. That is an in-process skip list, with no transport and no step.

## Verdict: missing owners (Owner B built 2026-09-29, #1823; Owner A next, #1824)

**The model is right.** Where an owner exists, the rule holds: `/api/write-file` since #1811, and a
throwing step since #1681. Every open member is a site that answers the owner's question for itself.
Two owners are missing.

**Owner A: one reader of any route's answer.** It widens `readWriteRefusal` into a route-agnostic reader
in `editorBackend.ts`. It returns:
- `{ok:true, body}`, with a partial success's notes kept, or
- `{ok:false, error, code?, reason?, conflict, status, options?, body}`

The verdict (R2) and the reason (R3) come from it. **It applies `isFailureBody`'s rule to a mutating
route's answer, and it must keep the agent side's distinction:** a read whose `ok:false` is the answer
is not passed through the verdict, exactly as `getJson` does not opt such a read in. Otherwise the
first read routed through it turns an honest negative answer into a refusal. Each wrapper answers an
outcome that carries the reason (R4), and each caller states it on its own channel (R5).

**One definition, or two pinned together.** The package cannot import `tools/shared`. The fix session
first checks the other direction: can `errorCodes.ts`'s consumers take the predicate from package
source? They are both MCP bundles and the device-shipped `agentBridge.ts`, so it has to stay
dependency-free. If one definition is not possible, the two copies are pinned by a **behavioural**
parity test. `engine/tests` can import both, so that test runs a corpus of real route bodies through
each: the answers, the partial successes and each refusal shape above. The `EntityResolveCode` check
in `mcpErrorCodes.test.ts` is a textual subset check, and it is not this kind of test.

On the route side:
- `ifMatchRefusal` and the if-none-match refusal gain an `error` sentence.
- `/api/save-dialog`'s token gains a sentence beside it. Its status can stay; its caller is correct.
- The pre-stream refusals of `/api/build` and `/api/ota/publish` (`vite-asset-scanner.ts`) open the
  stream first and send `FAILED:<reason>`, as `/api/toolchain/install` already does.

**Absorbs:** #1824 and the unfiled sites above. **Size: L**, most of it in the per-caller R5 choices.

**Owner B: the step report. BUILT (#1823, work-qa, 2026-09-29)** as below, with the step window in
`undo/stepWindow.ts` and the rollback on the step chain. The silent target lookups went to `require`
instead (a pre-write miss is a refusal, [prefabs.md](./prefabs.md) I19); only post-write misses report
here. The design as proposed: `reportUndoFailure` records its detail into the running step, through a
collector `runStep` opens and closes. `UndoStepResult` gains the shortfall and `dropped`.
`runSequential` keeps each sub's classification and message. **The collector's window is a time window**
(above), so B must also close the one forward path that can report inside it. Its failures are
reported by `compositeAction`'s `rollback`, which is not a step. Two ways to close it:
- rollback reports through its own function, not `reportUndoFailure`, so the collector never sees it
- rollback suspends collection while it runs

Either way, a test pins "a rollback report during an awaiting step does not reach that step's result".

`undoOrRefuse` answers each outcome under § 5, which already decides the code, so nothing here is a
fork:
- **Applied in part:** `ok:false, code:'PARTIAL'`, naming what did not apply. § 5: "`PARTIAL` is a
  failure unless the tool documents partial success", and #1681 set the precedent.
- **Dropped** (a world swap during the step): also `PARTIAL`, since part of it may have applied to the
  world that left.

The two `PARTIAL`s leave the history in opposite states. A shortfall's entry **moved** to the other
stack as usual; a dropped step's entry is on **neither**. The next undo depends on which, so the reply
carries it as a field (for example `entry: 'moved' | 'dropped'`), not only in prose. #1681's throw
replies are the `dropped` case too.

**Absorbs:** #1823, and the silent lookups above, **without touching the 33 call sites** for the
channel. U3 adds about eight `detail` edits that put an in-hand reason into the text, and each silent
lookup gains one reporting line. **Size: M.**

**Order.** B does not depend on A. U3's reasons get richer once A has converted the asset helpers,
because `deleteAssetFiles` and the rest will return a reason to put in `detail`. They share one file,
`assetUndo.ts`, but touch different functions there. **B first:** it is smaller, and it is the half an
agent acts on.

### Owner fork

**F1. Does the human see a partial undo on screen?** Today only a collision toasts. That was ruled
deliberately in #291/#308: the "Why two levels" note in `undoFailure.ts` says a backend failure is
"not actionable", so it stays console-only, while a 409 collision is one the user caused and can fix.
The agent's reply (above) is decided by § 5 either way.
- **(a) Keep the ruling.** A partial undo from a backend failure stays console-only, so the agent is
  told more than the human.
- **(b) Reverse it for undo.** Toast every shortfall: "Undo of X did not fully apply — see the
  console". The case for it: `reportUndoThrew` already toasts every throw, as history loss worth
  interrupting for, whatever caused it. A partial undo leaves the disk short of what the history now
  claims, which is the same kind of loss.
- **Pick: (b).** It reverses a recorded ruling, which is why it is the owner's call.

## Gotchas for the fix

- **Changing a wrapper from a boolean to an object disarms its callers silently.** `tsc --strict`
  accepts `if (await moveFileTo(…))` when the call returns an object (checked 2026-09-29), and no lint
  rule here catches it. **Rename the function** when its return type changes, so every call site stops
  compiling and has to be read. `moveFileTo` has four such callers in `Assets.tsx`: three
  `const ok = await moveFileTo(…)` and the paste loop's `if (await moveFileTo(…))`.
- **A 2xx can be a partial success.** Examples: `/api/reimport`'s `{ok:true, errors}`,
  `/api/delete-asset`'s `{ok:true, failed}`, `/api/prefab-member-paths`' `held`/`changed`, and
  `/api/move-file`'s `repairFailed`. The reader returns these as success with notes, as `isFailureBody`
  does, not as a refusal. Treating them as refusals would report a 20-of-21 bake as a failed call.
- **`writeMetaConditional` calls every 409 "changed on disk".** It sends `rendererWrite`, so the park
  gate's 409 cannot reach it, and today the claim is right. But it is a guess. The reader's `conflict`
  makes it a reading.
- **A report fired with no step open stays console-only.** Don't make the collector throw on an
  unopened report: rollback is exactly where the stack must not be disturbed further.
- **A new agent op must be classified** in `app/editor/agentOpUndoClass.ts` (`agentOpStepGate.test.ts`
  fails otherwise). One that reaches `pushAction` goes in `UNDO_RECORDING_OPS`, or its entry is dropped
  whenever a human undo is awaiting.
- **Never run forward work on the step chain from inside a closure** (`runOnStepChain`): it waits for the
  chain it is part of.
- **"No step open" is not "not this step's".** Read § "Steps are serialized against each other, not
  against the rest of the editor" before keying anything on `_executing` or `isExecutingUndoRedo()`.
