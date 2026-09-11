# Post-await liveness

**The rule: capture a liveness token before the first deferral; re-check it immediately before every
write to state you do not exclusively own that happens after one. Not only before the deferral —
before every write after it.**

⚠️ **"Deferral" is wider than `await`.** A `.then()`, a `queueMicrotask`, a `setTimeout`, a
`requestAnimationFrame` and an event callback are all holes in time, and two of the tokens in this
engine guard exactly those rather than an `await` — `runtime/debug/consoleCapture.ts` guards a
`queueMicrotask`, `runtime/ui/bindings.ts` guards a promise-settle callback. Reading this rule as
"after an `await`" would let an unguarded `queueMicrotask` pass as compliant. It is not.

That sentence already existed in this engine, in one docblock, in one file
(`runtime/iap/purchaseService.ts`), where nothing else could see it. This doc is that rule promoted
to a convention, plus the vocabulary for expressing it.

## Why this doc exists

A deferral is a hole in time. The function resumes into a world that may have moved: a newer call of
the same function may have started and won, or the object that owns the operation may have been torn
down. Neither is visible at the resume point — the code reads exactly as it did when it was written,
and the defect surfaces only under a race.

Over a ten-day window this produced roughly twenty separate tickets across the scene loader, the mesh
and material caches, the manager registry, the shared-module registry, the app's game swap and the
editor's scene load. They were not twenty defects. They were one defect, found twenty times, because
**nothing in the engine re-checked "am I still the live session?" after an `await`** — and because
each fix invented its own way to start doing so.

Five different mechanisms grew up independently. That is the actual problem this doc solves: a sixth
site would have invented a sixth, and a convention nobody wrote down cannot be followed.

## The pattern

Invariant at every site, regardless of which token you use:

1. **Capture** the token before the first deferral, into a local.
2. **Re-check** it immediately after each deferral — at the top of the continuation — before any
   write to shared, module or instance state, and before any externally visible effect (an event, a
   journal entry, a console error, a persisted value).
3. **Bail** on a failed check. Return, or throw the abort the caller expects. Do not "finish
   quietly" — a superseded operation that half-completes is worse than one that stops.
4. Past the point of no return, the check becomes a **latch, not a re-test**.

Reads are not writes. A superseded operation may read freely; it is the writes and the visible
effects that corrupt the winner's state.

### The latch rule

Once an operation has passed the point where its work is externally committed — the atomic swap in
`SceneManager`, an installed binding, a completed native call — re-testing the token on each
subsequent line is wrong. The token can flip *between* two checks, so the tail would run half its
writes under one answer and half under the other, which is the corruption the guard was meant to
prevent.

**Latch the answer once, at the boundary, and use the latched value for the whole tail.**
`runtime/scene/SceneManager.ts` argues this at its post-swap checkpoint and is the reference
implementation.

## The five tokens

One pattern, five permitted tokens. Pick by what question the site actually needs answered — a token
that answers the wrong question is not a weaker guard, it is a guard that cannot fire.

| Token | Answers | Use when |
|---|---|---|
| **Monotonic epoch** (supersession) | *Did someone newer start?* | The operation can be re-entered and a newer call must win. Scene loads, asset loads, device-list refreshes, OTA checks. |
| **Generation counter** (teardown) | *Was the thing I am filling still there?* | A cache or registry can be cleared wholesale underneath an in-flight load. All the loader caches. Often paired with a per-key epoch, so clearing one key does not cancel an unrelated in-flight load. |
| **Owner-set membership** | *Am I still owned?* | Refcounted, scene-scoped resources. Answers what an epoch cannot: not "is this current" but "does anyone still want it". `meshTemplateCache` and its siblings. |
| **Identity against a captured reference** | *Is the thing I started on still the thing?* | The session, config or container is itself replaced rather than versioned. Comparing the object beats maintaining a number for it. |
| **`disposed` / `alive` boolean** | *Was I torn down?* | An instance owns an async operation and has a real `dispose()`. Cannot express supersession — use an epoch for that. |

### Choosing between them

- Can this operation be **started again while the first is in flight**? You need supersession — an
  epoch, or an identity check. A `disposed` boolean cannot see it: nothing was disposed.
- Can the state you are filling be **wiped wholesale**? You need a generation counter. A per-scene
  release is *not* a wholesale wipe — that is the owner-set row.
- Both? Use both. `meshTemplateCache` deliberately runs an owner-set alongside a generation counter,
  because `releaseAllForScene` intentionally does not bump the generation: the owner-set answers
  supersession, the generation answers teardown, and neither substitutes for the other.

### The scope rule: a key-taking invalidator bumps exactly its own key

A `TeardownToken` has two halves — `invalidateAll()` and `invalidateKey(k)` — and the rule that
decides which one a call site gets is not a style preference:

> **A function handed ONE asset's key bumps exactly that key. Only a teardown bumps wholesale.**

Both ways of breaking it are silent, and both have shipped here:

| Direction | The call | What actually happens |
|---|---|---|
| **Overshoot** | `invalidateAll()` where `invalidateKey(k)` was meant | Every OTHER asset's in-flight load is superseded. Its result is computed *successfully* and thrown away. |
| **Undershoot** | neither half — the load captures keylessly | The asset's own in-flight load, carrying the PRE-import bytes, resolves after the eviction and re-caches itself on top of the fresh one. |

Overshoot is the more surprising one, because nothing errors and the damage lands on an asset
nobody touched. Its severity depends entirely on whether the victim retries: `fontAtlasLoader`
re-checks every frame, so a superseded font blanks and refetches, while `acquireAudio` runs only at
scene load — so a superseded decode meant that clip was **silently missing audio for the rest of the
scene**.

**The eviction half being correct tells you nothing about the liveness half.** In every instance
found so far the `.delete(key)` sitting next to the wrong call was already right. That is why the
guard checks the token, not the map.

### Why an owner-set check cannot stand in for the key

Two invalidators guard their post-await write with `owners.has(key)` and look covered. They are not:
each one deliberately **keeps** its owners so the next acquire re-fetches — `invalidateEnvironment`
("KEEPS the scene owners"), `invalidateRiggedModel` ("Owners are left intact"). So the check is true
by construction on exactly the path that needs it. It is answering the scene-release question from
the table above, which is a different question, and the two do not substitute for each other.

The third sanctioned shape is neither: `invalidateTexture` is correct with **no** key at all,
because its loader inserts into `texCache` synchronously **before any await** and identity-checks
every post-await write. Nothing can resolve back into a map it was never going to write to. That is
a real alternative, not an oversight — it is the one exemption the guard carries.

### The history, so the next reader does not re-derive it

This class has recurred three times, and each round fixed a subset:

- **#487** diagnosed the undershoot half and fixed five caches — and cited `fontLoader` /
  `fontAtlasLoader` as *"the correct precedent"* because they bump. They bumped **wholesale**: two
  of the overshoot bugs. Five other undershooting caches were never swept.
- **#852** fixed a fourth overshoot (`invalidateShader`) and added the granularity guard — scoped to
  the wired invalidator table, and checking only for the PRESENCE of per-key evidence.
- **#856 / #863** fixed the remaining three overshoot and five undershoot sites, and widened that
  guard to both directions over every loader invalidator whose module owns a token.

All five of #487's correctly-fixed sites still carry the comment *"Precedent:
fontLoader.invalidateFontFace"*. Those citations are true now; they were not when they were written.

⚠️ **A guard for one direction is blind to the other**, which is why the two were fixed as one
change. And it must run on **comment-blanked** source: a naive regex over the 16 key-taking
invalidators reports 9 violations, six of them correct implementations whose *comments* contain the
string `invalidateAll()` while explaining why they don't call it.

### An identity token can wear a number

`managerRegistry`'s `activationId` looks like an epoch and is not one. It is allocated per entry from
a counter, then compared as `actionOwner.get(name) !== entry.activationId` — against a value held
*somewhere else*, not against the counter's own current value. That makes it the identity token
expressed as an integer instead of an object reference, and it belongs in that row. The distinction
matters because it is exactly what separates the three shapes mechanically:

| Shape | Comparison | Example |
|---|---|---|
| Epoch / generation | captured value vs **the counter's own current value** | `gen !== generation` |
| Identity | captured value vs **a value stored elsewhere** | `actionOwner.get(n) !== entry.activationId` |
| Id generator (not a liveness token at all) | never compared — only incremented and read | `seq++` in the journal |

## The helper

`runtime/core/liveness.ts` implements the epoch/generation pair — the two tokens that are the same
machinery. Two constructors, because the distinction is the entire point and a comment is not strong
enough to carry it:

- `createSupersessionToken()` — `begin()` starts a new attempt and invalidates every earlier capture.
  Use where a newer call should win.
- `createTeardownToken()` — `capture(key?)` snapshots; `invalidateAll()` and `invalidateKey(k)` stale
  outstanding captures. Use where a clear or dispose should win.

Both hand back a predicate to call at the top of each continuation. Name the local `stillLive` (or a site-specific
`still…`) so the call site reads as a question.

**The helper is composed, not substituted.** A site with surrounding control flow — an in-flight
counter, an `AbortController`, a latch — sources its counter from the helper and keeps everything
else. `SceneManager` is the worked example: its generation comes from the helper, while the abort,
the in-flight count and the post-swap latch remain its own. The helper exists to remove duplicated
machinery, not to flatten sites that legitimately need more.

⚠️ **A site can ask the INVERSE question, and then a `capture()` is the wrong tool — `sync/coordinator.ts`
is the example** (#658). Three of its continuations take an ordinary `capture()`: *is my session still
live?* Its coalescing bit does not — a trigger that arrived AFTER a reset is owed its sync precisely
*because* the run resuming to dispatch it is dead, so substituting `stillLive()` there inverts the
answer (measured: it reddens two tests). **Do not "simplify" a raw `.generation` read into a
`capture()` without first asking which of the two questions the site is asking.**

⚠️ **But be precise about what carries that, because the obvious reading is wrong.** What makes the
follow-up survive is that it is judged by a *different variable* than the staleness check — **not**
the `again.gen === generation` comparison beside it, which is a defensive **tautology**:
`invalidateAll()` is the only writer of the counter and the reset nulls the bit in the same
synchronous block, so a non-null bit always carries the current generation. Deleting that comparison
reddens nothing, and no test can be written that makes it fail. It is kept because it keeps the
distinction visible, and `again.gen` is therefore a field that is written and never decisive — worth
knowing before you write a test for a branch that cannot be false.

The other three tokens are **hand-rolled by convention**, exposed as a named predicate so they are
greppable: `stillActive()`, `stillOurs()`, `isSuperseded()`. Name yours `still*` or `is*Superseded`,
and do not inline the comparison at a dozen call sites.

### Carrying a check across a call boundary: pass the check, never the counter

When the continuation lives in another function, hand it the `LivenessCheck` — not the captured
number for the callee to re-compare. `app/debug/schemaPusher.ts` is the worked example: `start()`
calls `runTick(pushEpoch.begin())` and each rescheduled tick re-passes the same closure, so the
check travels as one value with no second copy of the comparison to keep in sync.

This is also the one shape that can defeat the guard below. A raw number threaded through a
parameter and compared in the callee is a liveness token that no per-file scan can see, because the
capture and the comparison live in different functions. Three instances existed when this
convention landed — `schemaPusher`, `SceneManager.collectSceneResourceRefs`, and
`rendering/frameDriver.ts`'s rAF chain — and all three now thread the check.

⚠️ **The third one is why this rule is stated as a rule and not as an observation.** `frameDriver`
was missed by the sweep that found the other two, precisely because the guard cannot see this shape
— and it was cited *by name* as the precedent in two modules that had already been migrated
(`gpuTimings`, `liveCompileGate`), so the next author following the trail arrived at the one file
still hand-rolling it. A blind spot that also advertises itself as the house style is the worst
case, and the only defence is the convention, not the test.

### Not every liveness token guards an `await`

`consoleCapture`'s guards a `queueMicrotask` drain; `bindings`' guards a promise-settle callback.
Both are the generation token doing its ordinary job — the continuation just is not spelled `await`.
When you are looking for sites that need a token, grep for the deferral, not for the keyword.

### A fifth shape: a deliberate PRE-await write, where no liveness token can be right (#887)

Every token above assumes the writes happen *after* the deferral, so a loser can be told to bail
before it touches anything. `editor/scene/serialize.ts`'s `newScene()` breaks that assumption on
purpose, and the two halves of that one file are the clearest statement of the rule:

| | writes the four editor globals | so its token is |
|---|---|---|
| `serialize.loadScene` | **after** its `await`, behind `stillLive()` | a supersession epoch — a newer open wins |
| `serialize.newScene` | **before** its `await`, by design | a **lock**: the second call is refused |

`newScene` sets `setCurrentScenePath` / `setCurrentBaseScene` first because `setCurrentWorld` fires
`onWorldSwap` synchronously and the Hierarchy's restore reads `getCurrentScenePath()` a frame
later — and `aSceneSwapIsHappening()` is false on that path, so nothing waits for the state to
settle. Writing first removes an ordering dependency instead of racing it.

That makes supersession **unusable**, not merely awkward: a loser bailing in its tail has already
stomped the path and cannot roll it back, and moving the write after the `await` to make bailing
possible reopens the exact race the pre-write closes. So the question the site actually asks is not
*am I still live?* but *may I start at all?* — and the answer is a plain in-flight boolean plus a
typed refusal, released in a `finally` so one rejected swap does not brick the operation for the
session. `editor/scene/playMode.ts`'s `enterPlay` (#470) is the same shape and the precedent to
copy.

**The test to apply before reaching for an epoch: does this function write anything the caller can
observe BEFORE its first deferral?** If yes, a liveness token is guarding the wrong half of it.

⚠️ Neither guard sees this. `livenessTokenIsShared` looks for a counter, and there is none; nothing
looks for "an async function with pre-await writes and no mutual exclusion" — that is the same
statement-order analysis § Enforcement declines to build.

### A fourth shape the helper does NOT cover: capture, and let a THIRD PARTY consume it

Every token above answers *am I still live?* from inside the continuation. `NavigationManager` (#808)
needed a different question — *did MY operation actually commit?* — and no token can answer it,
because the continuation cannot see which of several concurrent navigations the engine ended up
performing. Three repairs tried anyway (a snapshot restored in a `catch`, a supersession epoch, and
deferring the write past the `await`), and each failed on a different interleaving.

The shape that works: the operation registers a **claim** before its `await`, and an authoritative,
serialized EVENT handler — `onWorldSwap`, in that case — consumes one claim and does the work. The
claim is released in a `finally` for the case where the event never comes.

Two rules fall out, both learned the expensive way:

- **Key the claim per CALL, never by a value two callers can share.** A `Set<path>` collapsed two
  navigations to one scene into a single entry, and the LOSER's `finally` released it before the
  winner's event arrived, so the winner's work never happened. `runtime/video/videoSystem.ts` is the
  correct precedent — its map is keyed by a recyclable entity id, but the continuation checks
  `rec.cancelled` on the record OBJECT it captured, so identity is the real token.
- **Where two concurrent claims for one key have opposite intent, you are choosing a tie-break, not
  computing an answer.** Say so at the site. `NavigationManager.takeClaim` takes the most recently
  started claim — what the player last asked for — and its docblock states that it is a tie-break.

⚠️ **`livenessTokenIsShared.test.ts` does not see this shape**, because nothing is compared against a
counter. Do not read a green guard as "there is no lifetime question here".

### The precondition the claim shape hides: the consumer must be an event that ACTUALLY fires

The shape above is *register a claim, let an authoritative event consume it*. Its unstated
precondition is that the event **arrives**. #789 and #839 are the two ways that fails, and both
were shipped, green, for months — because a mechanism that cannot fire breaks nothing a test asserts.

- **#789 — the work is reachable only from a path a swap never takes.** `space-console`'s three
  systems and `3d-test`'s stats readback keep per-frame state in module-scope maps keyed by koota
  entity id. `resetShipShakeSystem` / `resetCameraDistanceSystem` / `resetEngineFlameSystem` all
  existed and all did the right thing — and their only non-test caller was `unregisterGameSystems`,
  which a world swap does not call. koota recycles entity ids, so the new world's ship read the old
  world's offset as its own: `baseX = tf.x - prev.dx` recovers a base pose that is off by the
  previous world's displacement, and the next frame recomputes the base from the already-displaced
  transform, so the bias is **permanent**, not a one-frame blip.
- **#839 — the claim is consumed by a FOREIGN event.** The Hierarchy recorded "this swap needs a
  collapse restore" on `onWorldSwap` and left the consuming to `onStructureDirtyCoalesced`.
  Structure-dirty fires on `registerEntity`; `loadSceneFile` registers the incoming scene's entities
  into the **staging** world *before* the swap, and `SceneManager` marks nothing dirty after
  `setCurrentWorld`. So for a scene loaded after boot no settled refresh ever followed the swap: the
  collapse set was never restored **and** — because the same claim gated the save — never persisted,
  for the rest of that scene. Measured, not reasoned: reverting the fix turns
  `editor-hierarchy-collapse.spec.ts` red on both halves.

**The rule.** Before trusting a claim/teardown, trace the edge from `setCurrentWorld` to the work.
If no edge exists, the mechanism cannot fire, and the code reads correct at every line.

Two corollaries, each the cheaper half of the fix:

- **Own the trigger you depend on.** If the work must happen after a swap, schedule it from the swap
  handler — do not hand it to an event that merely *usually* follows. A foreign event is a
  backstop, never the primary path.
- **Key a swap-scoped claim by IDENTITY, never by an unkeyed boolean.** #839's `restoreNeededRef`
  was a `Set`-of-one degenerated to a flag: two swaps collapse into one claim, and nothing
  distinguishes *"restored"* from *"never had anything to restore"*. Re-keyed on the scene path the
  set was restored FOR, an unconsumed claim costs one skipped save instead of a permanently shut
  gate — the gate answers from the current path rather than waiting to be cleared. This is the same
  correction as "key the claim per CALL" above, one level down: a boolean is what a `Set<path>`
  degrades to when there is only ever one key.

  ⚠️ **Pick the identity the ids actually belong to.** #839's first fix keyed the claim on the
  scene PATH, which looks equivalent and is not: `saveScene()` re-points the path with no swap and
  no structural change, so a plain **File → Save As** read as "needs restore" and the next
  structural change collapsed the whole tree and persisted that over the arrangement the user had
  just saved. The set is owned by the WORLD whose entity ids it holds; the path is only where it
  gets written. A world identity also needs no clearing on the swap — a new world simply is not
  the old one — which a flag nulled on every swap EVENT gets wrong the moment `stepSimulation`
  swaps the world out and back.

⚠️ **A docblock is not an edge.** `cameraDistanceSystem`'s said "world-swap teardown goes through
`resetCameraDistanceSystem` which clears everything" while no world-swap path to it existed. That is
worse than no comment: it stops the next reader looking. When you assert a wiring in prose, name the
file and the registration, so the claim is checkable.

### Scope: module and instance, not components

The helper and its guard cover module-scoped and instance-scoped state. An editor panel that runs the
same epoch through a `useRef(0)` — `AIPanel`, `DeviceConnectSection` and `OtaKeysDialog` each do — is
a **sanctioned variant, not an exception**: the pattern and the latch rule apply unchanged, but the
ref dies with its component and cannot leak across the app, so it stays in React and out of the
helper. That containment is the whole argument — the blast radius of getting it wrong is one
component, not the app — so the helper's module/instance scoping buys nothing there.

(Do not read this as "panels are untestable". [editor.md](./editor.md) rules the opposite: a panel's
decisions belong in a plain `.ts` module beside it, and that module is where its tests go. If a
supersession epoch ever moves out of a panel into such a module, it moves onto the helper with it.)

## Enforcement, and what it does not cover

`engine/tests/architecture/` asserts the helper is the **only** implementation of the epoch/generation
token: a counter captured and compared across a deferral must come from `runtime/core/liveness.ts`.
The three-way table above is what makes that checkable without flow analysis — identity comparisons
and id generators are separable syntactically.

**What it catches:** a sixth hand-rolled epoch. That is the failure mode that produced this doc.

**A second guard covers the scope rule above.** `engine/tests/architecture/invalidatorGranularity.test.ts`
holds every `export function invalidate<X>(key)` under `runtime/loaders/` whose module constructs
its own `createTeardownToken` — 16 functions across 13 modules — to BOTH directions at once: the
body must call `.invalidateKey(`, and must never call `.invalidateAll(`. Checking one direction is
what let the class recur three times, so it deliberately does not.

Two properties of that guard are load-bearing rather than incidental, and a future edit should not
quietly drop either:
- it reads **comment-blanked** source (`readScannedSource`, #419). On raw text it reports the
  opposite verdict for six correct implementations, whose comments contain the literal string
  `invalidateAll()` while explaining why the body does not call it.
- its enumeration is **floored**, so a scan that collapses to nothing fails instead of passing
  vacuously.

`invalidateTexture` is its one exemption, and the exemption set is asserted to be *exactly* that —
so adding a member is a visible edit to the guard, not a quiet regex change. A new exemption owes
the same standard of proof the existing one carries: a named alternative mechanism, cited at
file:line.

**What it does not catch:** a new deferring site that guards *nothing at all*. Detecting that needs
statement-order analysis — a deferral followed by a write to non-local state with no intervening
guarded exit. That check is buildable and was deliberately not built: it needs a reviewed-exception
list, and a frozen list of exceptions goes red whenever another clone adds an async owner, with both
branches green in isolation. It is the right next step if this class of defect recurs; it is not
worth its merge cost while the token vocabulary is doing the work.

So the ordinary path stays a human one: when you write a deferral in a function that later writes
shared state, pick a token from the table.

## The other half: what still belongs to the operation you gave up on

Liveness answers *"am I still current?"*. It does not answer the question a **timeout** raises, which
is the mirror image: *"what still belongs to the operation I stopped waiting for?"*

A timeout REJECTS the caller. It does not CANCEL the callee — and in this engine it cannot, because
none of the operations we bound accepts an `AbortSignal`: a Pixi `Application.init()`, a worker's
`generateAtlas()`, a WebGPU `onSubmittedWorkDone()`, a `readRenderTargetPixelsAsync()`, a
`createRenderer()`. The abandoned operation keeps running, and whatever it holds stays held.

`withTimeout` was hand-rolled **six** times before this was decided — four named helpers
(`canvas2DPool`, `gpuClock`, `rampProbeRunner`, `msdfGenerate`) and two inline copies (`Scene3D`,
`app/debug/bridgeHelpers`) — and half of them never asked the question. Five defects, one shape:

| # | The abandoned operation still held | What went wrong |
|---|---|---|
| #801 | the slot, while the *cure* sat on the caller's success path | a late `init()` brought up a live renderer nothing revalidated — a blank frame behind a healthy context |
| #817 | the worker, while `genQueue` was released | the next generation entered `loadFont` on a different font — silent wrong-typeface glyphs |
| #818 | the `MSDF` instance the timeout stopped us recording | a Worker + wasm orphaned beyond `dispose`'s reach — **partially fixed only**, see below |
| #819 | the pooled `captureRT` the readback was still reading | the next capture rendered into it underneath |
| #820 | the renderer, and both detacher handles | a superseded bring-up assigned them anyway |

⚠️ **#801 and #820 both answer with `adopt`, and that is not incidental.** Bounding an operation
whose late result you then THROW AWAY is strictly worse than not bounding it: a slow-but-alive
bring-up that used to succeed at 8.5 s instead exhausts its retries and leaves a permanently black
surface. Both sites therefore route the late arrival back into the same success path the on-time one
takes — `initSlotApp`'s cure for 2D, `adopt` in `rendering/viewportBringUp.ts` for 3D — with a
supersession token deciding whether it is still wanted. **If you add a bound, say where the late
result goes before you add it.**

⚠️ **A fix that lives in a component closure is a fix nothing pins.** #819 and #820 landed inside
`Scene3D.tsx`'s effect; deleting all three changes (the bound, the token, the retirement) left 18,116
tests passing (#824). They were extracted to `viewportBringUp.ts` — `boot()`/`rebuild()`,
`boundedCaptureReadback` — and `viewportBringUp.test.ts` now pins each, including a
`rendererRecovery` run where every attempt hangs and the LAST late renderer is adopted.
⚠️ **Extraction moves the gap one layer out, it does not close it on its own**: the module's tests
cannot see how `Scene3D.tsx` wires it, and the close-out review measured `rebuild: bringUp.boot` and
a no-op capture slot leaving 144 tests green. `tests/architecture/viewportBringUpWired.test.ts`
source-scans that wiring; pair any future extraction with the same.
⚠️ **The editor's `SceneView.tsx` had the same shape until #1052**: its context-loss rebuild re-ran
the whole viewport setup with no bound, so a hung WebGPU init latched recovery exactly as #820 did.
It now goes through the same module, renamed from `scene3DBringUp.ts` to `viewportBringUp.ts` for
it. The editor needed three seams Scene3D does not use: `createRenderer(kind)`, an async
`install(r, stillCurrent)`, and a lease-aware `discard(r, reason)`. The wiring guard scans both
callers. **The late result's destination was, as above, the hard part.** A renderer that arrives
after UNMOUNT must go back through SceneView's container lease, because a StrictMode remount may be
re-acquiring it. A SUPERSEDED one's lease was already dropped by the rebuild that overtook it, so
releasing it would decrement the successor's hold — which is why `adopt` decides superseded FIRST.
⚠️ **A live trigger was attempted and could not be driven.** `GPUDevice.destroy()` reads as an
orderly teardown to `makeViewportLossPolicy` (`reason: 'destroyed'` is filtered). The fix is
therefore verified by the module's fake-timer tests and the wiring guard, not by a live before/after.

### The rule

**`runtime/core/abandonment.ts` is the one `withTimeout`, and the disposition is a REQUIRED argument.**

```ts
await withTimeout(p, ms, 'what', { discard: 'why the late value owns nothing' });
```

Three answers, and you must write one down:

| Disposition | Means | Example |
|---|---|---|
| `{ adopt: why }` | a late settlement is handled on its OWN path | `canvas2DPool` — `initSlotApp` cures whichever attempt wins |
| `{ discard: why }` | the late value owns nothing reclaimable | `gpuClock`'s stale duration; `handleEval`'s uncancellable agent code |
| `{ onSettled }` | it holds something that must be released | `viewportBringUp` disposing a superseded late renderer; `msdfGenerate` disposing a late worker |

`adopt` and `discard` are both runtime no-ops. The distinction is type-level and load-bearing **at the
source line**: the string is a written justification the next author gets for free instead of
reconstructing — or, as happened five times, not reconstructing and getting it wrong.

⚠️ **`onSettled` only fires on SETTLEMENT, so it cannot clean up after an operation that never
settles at all.** #818 is the honest example: `MSDF.initialize()` creates its Worker synchronously
before its own `await`, and the failure its timeout exists for — a 404'd worker script or wasm —
is one where the comlink reply *never arrives*. The disposition fixes the slow-but-alive case and
does nothing for the never-settles case, where the Worker is created, orphaned, and unreachable
exactly as before. No fix is available with that library: `MSDF.dispose()` awaits a round-trip into
the worker before `terminate()`, so `terminate()` cannot be reached. Say so rather than implying
coverage — this is a real hole in the family, not a solved member.

⚠️ **Sometimes the right disposition is to retire the EXECUTOR, not the value.** `msdfGenerate` cannot
wait for the abandoned generation (that restores the wedge the timeout exists to remove) and cannot
cancel it (`MSDF.dispose()` awaits a comlink round-trip *before* `terminate()`, so it queues behind
the very call that is stuck). It retires the generator instead: the next call builds a fresh Worker,
and the window is per-worker. `Scene3D` does the same with its pooled render target
(`boundedCaptureReadback` in `viewportBringUp.ts`).

### When a hand-rolled deadline is the RIGHT answer

The mirror of "wire an `AbortSignal` at the call site" below: **a site that already HAS a
cancellation primitive should keep its own deadline, and migrating it onto `withTimeout` is a
regression.** Measured 2026-09-07 while working #830, which listed three engine files as unmigrated
hand-rolls and treated that as debt.

The discriminator is *who owns the promise*:

| | Use `withTimeout` | Keep the hand-rolled deadline |
|---|---|---|
| The promise | handed to you, opaque | you construct it, and hold its `resolve`/`reject` |
| At the deadline | nothing can be stopped | deregister / destroy / close — a real reclaim |
| Late settlement | may arrive and own something → `onSettled` | cannot arrive: you already dropped the registration |

`electron/main.ts`'s `requestRenderer`, `plugins/backend/deviceCdp.ts`'s `connect`/`send` and
`plugins/backend/deviceConnection.ts`'s `open`/`rpc` are all in the right-hand column: each keys a
request into a `pending` map and its timer calls `pending.delete(id)` / `socket.destroy()` /
`ws.close()` before rejecting. `withTimeout` cannot express that — per the ⚠️ above, `onSettled`
fires on settlement, and a wedged device never settles anything, so the entry would be held for the
life of the link. The reclaim is the whole point, and it is the half a timeout test usually forgets:
all four existing timeout tests in `deviceConnection.test.ts` asserted only that the caller was
rejected, and stayed green against an implementation that leaked every entry.

Both halves are now pinned — behaviourally in `tests/plugins/deviceConnection.test.ts` for the site
reachable over a real socket, and statically across all five in the architecture guard.

⚠️ The import objection that originally deferred this is void: `@modoki/engine/runtime/core/abandonment`
is a dedicated deep export of a single file with **zero imports**, so using it from the Electron Node
main process pulls nothing browser-oriented in. The reason these stay is the reclaim, not the import.

### Enforcement

`engine/tests/architecture/abandonmentIsShared.test.ts`, the sibling of the liveness guard and built
the same way — a paired detector (a `new Promise` rejector, and a `setTimeout` that calls *that*
identifier), a census floor, and fixture tests so narrowing it is visible. Its blind spots are stated
in its header; the load-bearing one is that a rejection routed through a **named function** needs the
call graph and is not matched.

⚠️ It found the sixth copy itself. The sweep that designed the family scanned
`engine/packages/modoki/src` and missed `engine/app/debug/bridgeHelpers.ts`.

### Deliberately not solved

- **Cancellation.** Nothing here cancels. If a real `AbortSignal` becomes available for one of these
  operations, wire it at that call site rather than leaning harder on this helper.
- **Knowing your timeout is too tight.** The primitive never logs "the thing you gave up on finished
  anyway, 400 ms later" — so it cannot tell you a bound is wrong, only let you clean up after it. A
  caller that wants that signal builds it into its own `onSettled`.

## Deliberate gaps

Two places do not follow the rule, on purpose. Neither is a defect to re-file.

- **`SceneManager.unloadAll()` writes its tail unconditionally.** Teardown wins by design: a load in
  flight when an unload starts rejects, rather than the unload yielding to it. Guarding the
  teardown's own writes would invert that.
- **`meshTemplateCache`, model templates loaded inside `acquireMesh`'s first await**, can leave
  owner-less resident geometry. Documented in place as a known, accepted hole.

## Related

- [managers-and-systems.md](./managers-and-systems.md) — why this app has no app-level teardown path,
  and why the `disposed`-boolean token is rarer here than it looks. Every end-of-lifetime at app scope
  is a realm death; scene scope is where teardown is real.
- [scene-loading.md](./scene-loading.md) — the scene load/swap lifecycle these guards protect,
  including § "The promote's notification cannot abort the promoter" (#888). That is the THIRD
  guard in this family — `engine/tests/architecture/notifyIsShared.test.ts` over
  `runtime/core/notifyListeners.ts`, built like the two above and carrying the same shape of
  stated blind spots. It is a different question (an exception escaping a synchronous fan-out,
  not a stale continuation), so nothing here covers it and it does not belong in this doc's body.
- [architecture-layers.md](./architecture-layers.md) — why the helper lives in L0 `runtime/core/`.
- [rendering.md](./rendering.md) § "The 2D path needs the same recovery" — the renderer-side
  story behind #801, and why a recovery's cure must sit on the same success path as its bring-up.
