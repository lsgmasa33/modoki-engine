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

**What it does not catch:** a new deferring site that guards *nothing at all*. Detecting that needs
statement-order analysis — a deferral followed by a write to non-local state with no intervening
guarded exit. That check is buildable and was deliberately not built: it needs a reviewed-exception
list, and a frozen list of exceptions goes red whenever another clone adds an async owner, with both
branches green in isolation. It is the right next step if this class of defect recurs; it is not
worth its merge cost while the token vocabulary is doing the work.

So the ordinary path stays a human one: when you write a deferral in a function that later writes
shared state, pick a token from the table.

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
- [scene-loading.md](./scene-loading.md) — the scene load/swap lifecycle these guards protect.
- [architecture-layers.md](./architecture-layers.md) — why the helper lives in L0 `runtime/core/`.
