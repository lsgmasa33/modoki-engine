# Managers & Systems — the engine's logic roles

> **Status:** implemented. (The original phased rollout has fully landed; see git history
> for the retired `managers-rollout-plan.md` tracker.)
>
> **Historical note:** the `scene-selector` game used below as an example was the
> pre-#29 multi-game hub; it was removed in the one-project-per-game teardown. Its
> `navigateBack`/card-spawning are kept here only to illustrate the Manager roles —
> the Manager/System primitives themselves are unchanged.

## Why this exists

Game logic was leaking into per-game `setup.ts` (inline `registerUIAction`
closures) and `init.ts` (free functions like chess's `handleAITurn`,
scene-selector's `navigateBack`). The root cause is an **asymmetry**, not a
discipline problem:

- A **System** is first-class. `registerSystem(name, fn, priority, { actions })`
  gives per-frame logic a named home with an ordered tick, owned UIActions, and
  automatic cleanup. Nobody scatters per-frame logic, because it has an obvious
  place to go.
- A **Manager** had no equivalent. There was no `registerManager`. So
  event-driven logic (AI turns, navigation, "new game", card spawning) had
  nowhere to live and leaked into `init.ts`/`setup.ts` as loose functions.

The fix is to make **Manager a first-class registerable unit, symmetric to
System**. Then there is exactly one home per role, and `setup.ts` becomes a pure
manifest while `init.ts` disappears.

## The five roles

Don't force everything into two buckets. The codebase genuinely has five, and
naming them is what keeps logic from sprawling.

| Role | Ticks? | Driven by | Holds | Examples |
|------|--------|-----------|-------|----------|
| **System** | yes | the frame clock | per-frame transform of ECS state | `timeSystem`, `animationSystem`, `shipShakeSystem`, `transformPropagationSystem`, render sync, `chessBoardSystem` (canvas-remount poll), `gameStatsSystem` (ECS→store readback) |
| **Manager** | no | events (clicks, scene swaps, SDK callbacks) | long-lived state + a method surface | `SceneManager`, `actionRegistry`, `audio`, (new) `NavigationManager`, `TimeManager` |
| **Projection** | on change | store subscription (dirty flag) | mirrors state store→ECS, no logic | `uiTreeProjection`, `chessStateProjection` / `chessChatProjection`, `llmStateProjection` / `chatMessageProjection` |
| **Store** | no | mutations | Zustand state container | `gameStore`, `engineStore`, `debugStore`, `chessStore`, `llmStore` |
| **Trait / Service / Utility** | no | n/a | pure data / SDK wrapper / pure fn | `UIElement`, `ads`, `anchorLayout`, `render2DUtils` |

### The litmus test

> **Does the logic produce a different result on frame N+1 than frame N with no
> input change?** (easing, oscillation, physics, time accumulation)
> **Yes → System. No → Manager.**

A `navigationSystem` fails this test — navigation never reacts to time passing —
so navigation is a **Manager**, not a System. Time *passes* the test for clock
advance (System) but *fails* it for `timeSinceGameStart` (a derived read →
Manager). Many features are **both** — see [Time](#time-system--manager).

### Projections are a System sub-role, not game logic

Seven of the registered "systems" are projections: they tick only to *poll for
change* and mirror a store into ECS (or back). They're correctly Systems (they
tick), but six of them hand-roll per-frame change detection. `uiTreeProjection`
already solved this with a **dirty flag** (`markUIDirty`). `registerProjection(name, store, syncFn)`
(`runtime/core/projection.ts`) now generalizes that: it subscribes to the store and runs `syncFn`
only on change, turning a per-frame poller into an event-driven sync. It **shipped and is in use** —
`games/chess/runtime/setup.ts` and `games/llm-test/runtime/setup.ts` register four projections
through it between them. Converting any remaining hand-rolled pollers is mechanical.

## The Manager primitive

```ts
interface ManagerDef {
  name: string;
  scope?: 'app' | 'scene' | 'game';   // default 'scene'
  scenes?: string[];             // scene-scope only: path substrings; omit = every scene
  games?: string[];              // game-scope only: active-game ids; omit = every game
  actions?: Record<string, UIActionHandler | UIActionDef>;  // SAME shape systems use
  init?(ctx: ManagerContext): void | Promise<void>;
  dispose?(ctx?: ManagerContext): void;
}
interface ManagerContext { world: World; scenePath: string; }

registerManager(def)      // mirrors registerSystem
unregisterManager(name)   // drops owned actions, calls dispose()
```

**On `ctx`, and narrowing it away.** `init` receives a `ctx` because the registry always
has one to give, but most managers read nothing from it — they call `getCurrentWorld()`
themselves. It is not dead weight: `dispose(ctx?)` is where it earns its keep, since on a
scene swap it carries the OLD world (still alive until just after dispose runs), which is
what the zone / physics / timeline event buses use to clear their per-world state.

If a manager exports a **public interface** — `export interface Foo extends ManagerDef` —
and its implementation takes no `ctx`, redeclare `init(): void` / `dispose(): void` on that
interface. The exported singleton is typed as the *interface*, not the `Impl` class, so the
inherited wide signature is what every caller sees, and a direct `foo.init()` would have to
fabricate a `ManagerContext` that is then ignored (#37). `TimeManager` and `NavigationManager`
both do this. The registry is unaffected — it keeps calling through `ManagerDef` and keeps
passing a real `ctx`.

**`init` may return a promise, but no shipped manager does.** `disposeActiveSceneManagers`/
`disposeActiveGameManagers` track a returned promise (`Entry.initPromise`) and await it before
disposing, so an in-flight init is never torn down half-finished; `initSceneManagersFor`/
`initGameManagersFor` await it too, so `loadScene` doesn't resolve until init settles; and, since
#518, `registerManager`/`unregisterManager` honour it as well — but by *deferring* rather than
awaiting, via `deactivateWhenInitSettles`, because both are synchronous public API called from a
game's `setup.ts` and can't ripple an `await` into every game's setup. (Before #518 they called
`deactivate()` synchronously and could tear a manager down mid-init.) That ordering has **no
producer today**: every engine manager (`TimeManager`, `NavigationManager`,
`physics2DEventsManager`, `physics3DEventsManager`, `zone2DEventsManager`,
`zone3DEventsManager`, `timelineEventsManager`, `inputSourcesManager`) is synchronous, and the
two managers doing real async work — `games/chess/runtime/ChessManager.ts` and
`games/llm-test/runtime/LLMManager.ts` — declare `init(): void` and fire-and-forget
(`void this.initLLM()`) *deliberately*: returning that promise would block `loadScene` on an LLM
model download. So a manager that fires-and-forgets its async work is invisible to the dispose
ordering above — the registry has no way to know it's still initializing — and if it holds
world-bound state, its own async continuation must re-check "is my activation still current"
before touching that state, since a scene swap mid-flight can dispose it without waiting.
`disposeActiveSceneManagers`/`disposeActiveGameManagers` also each snapshot which activation of
an entry they own (`Entry.activationId`) before awaiting any pending init, so a manager
(re)activated *during* that await — belonging to the incoming scene/game — isn't swept into the
outgoing scene's/game's teardown (#487 item 5).

**The `registerManager`/`unregisterManager` deferral creates a contract worth stating plainly.**
Manager defs are module-level singletons passed to `registerManager` *by identity*
(`games/llm-test/runtime/setup.ts`, `games/chess/runtime/setup.ts`,
`games/space-console/runtime/setup.ts`, `engine/app/ecs/register.ts`), so on a re-register the
old entry and the new entry share ONE def object. Before #518, `dispose(old)` always ran before
`init(new)`; now, whenever `initPromise` is non-null, `dispose(old)` runs AFTER `init(new)` has
already completed — on the SAME instance, tearing down what the successor just built.
`actionOwner` (keyed on `Entry.activationId`) closes this for UIAction *names* only — a deferred
teardown releases only the names it still owns, not ones a newer activation has since claimed —
but nothing guards the manager's own fields or any other named global its `dispose()` releases
(`LLMManager.dispose()`'s `this.generation++; this.llmService = null; clearMessages()` is exactly
that shape). **A manager whose `init()` returns a promise must tolerate its own `dispose()`
running after a successor's `init()` on the same def instance.** Like the ordering above, this
has no live producer either — the sweep of shipped `ManagerDef`s above still holds — so #518 is
future-proofing this invariant ahead of the first async `init()`, not fixing an observed bug.

### Scope: three tiers — scene by default, game and app opt-in

Scene-default makes the safe choice the default — a Manager's state can't leak
across scenes unless you explicitly ask it to. Two coarser tiers opt in to longer
lifetimes, each keyed on a different thing:

| | **scene (default)** | **game (opt-in)** | **app (opt-in)** |
|---|---|---|---|
| Keyed on | active **scene path** (`scenes` filter) | active **game id** (`games` filter) | nothing — the whole session |
| `init()` fires | when a matching scene loads | when its game becomes active | once, at `registerManager` |
| `dispose()` fires | on every swap away, **before** the old world dies | when the **active game changes**, not on in-game swaps | only at `unregisterManager` |
| State | reset per scene — **cannot leak** | persists across a game's scenes | persists the whole session |
| Use for | per-screen controllers, card spawning, **single-scene controllers with an expensive init** (e.g. the chess / llm-test LLM download) | a controller genuinely spanning a game's scenes (e.g. the space-console camera across Station↔Warp) | engine infrastructure (Time, Navigation) and global cross-game actions (return-to-hub) |

**`activeGameId` is cleared when a game teardown STARTS, not just set when one succeeds (#539).**
`initGameManagersFor` writes it on success, and `disposeActiveGameManagers` clears it to `null` at
its own synchronous head. So `null` carries two meanings — "no game" (the menu, a prefab-edit
world) and "a teardown is in flight" — and both readers want the same answer for either: don't
auto-activate, and re-init on the next real game. Written only on success, it named the outgoing
game for the whole teardown window, which has real awaits in it (`fireSceneCallbacks` among them):
`registerManager` would activate a newly-registered manager into a world about to be destroyed, and
a re-entrant `loadScene` back to the outgoing game computed `gameChanged === false`, skipped
`initGameManagersFor`, and left that game running with its game-scoped managers **permanently
deactivated**. Same rule the app shell's `activeGameIdRef` follows one layer up
([architecture.md](architecture.md) § the `#516` ref table): *a marker read during teardown cannot
be written only on success.*

⚠️ **The re-entrant half is closed only for a load that NAMES its game.** `SceneManager` derives
`nextGameId` as `gameIdFromScenePath(path) ?? getActiveGameId()` and compares it against
`getActiveGameId()`, so a path yielding no game id makes `gameChanged` false by construction. The
app shell (always passes `opts.gameId`) and the editor are covered; `NavigationManager.loadScene`
passes none, and a shipped web build's hashed asset URL derives nothing. Such a load is no worse
than before the fix, and recovers on the next load that does name its game.

**The scene-scoped twin is an ACCEPTED trade — ruled, not merely unfixed (#554, owner,
2026-09-01).** `activeScenePath` has the identical shape and `disposeActiveSceneManagers` does
*not* clear it, so a `registerManager` landing inside its await activates against the OUTGOING
scene path.

**Why that is not worth the symmetric one-liner, when the game-scoped one was:** the stray manager
is caught by the very next swap, and — unlike the game tier — there is **no permanent dead state**
to be caught in. `initGameManagersFor` is gated on `gameChanged`, which is what let a re-entrant
A→B→A skip re-activation *for the rest of the session*; `initSceneManagersFor` has no such gate and
re-activates unconditionally on every swap, so the failure self-heals in one swap. Against that,
the fix would touch the hottest path in the registry (every scene swap in every game, not just a
game change) and would change the `scenePath` an app-scoped manager's `init()` receives mid-swap
from the outgoing path to `''` — a contract change for anything reading `ctx.scenePath`.

⚠️ **Do not "complete" #539 by fixing this one without a new ruling.** It looks like an obvious
loose end, and it is the loose end on purpose.

**Why `game` is keyed on the active game, not on register.** The editor registers
*every* game's systems up front, so "activate on register" would light up all
games' game-scoped managers at once — which is how an LLM download once fired just
from opening an unrelated scene. Keying on `activeGameId` (set on a real game
switch, derived from the scene path otherwise) means only the *active* game's
managers run, in both the editor and production. A single-scene controller with an
expensive init therefore belongs in `scene`, never `game`.

### Who owns the lifecycle: SceneManager

Because scene and game scope are both keyed on what's loaded, **`SceneManager`
owns Manager lifecycle** — which is also why navigation belongs there (same
owner). The hooks slot into the existing swap sequence in
`SceneManager.loadScene`, with no new machinery:

```
setCurrentWorld(new)
  → if the game changed: dispose old game-scoped managers   (their world is about to die)
  → dispose old scene-scoped managers                       (their world is about to die)
  → releaseAllForScene(old)
  → oldWorld.destroy()
  → if the game changed: init new game-scoped managers that match the game filter
  → init new scene-scoped managers that match the scene filter   (via initSceneManagersFor)
```

App-scoped managers are untouched by swaps — they init/dispose only at
`registerManager`/`unregisterManager`.

**App-scoped managers are never unregistered in production, and that is by design (#534).**

There is no `teardownAll()`. One was built — the exact inverse of `registerAll()`, dropping all
eight Managers, disposing audio in the order service → buffers → context, clearing the LateUpdate
registry and re-arming the latch — wired to `App`'s unmount cleanup, tested, and then **removed**,
because the measurement showed there is nothing for it to serve.

⚠️ **Every end-of-lifetime in this architecture is a REALM DEATH, not a teardown.** The OS kills
the process on mobile; the tab closes on web; restart and OTA go through `location.reload()`
(`engine.reload`, `runtime/actions/engineActions.ts`); and even the editor's project switch — the
most teardown-shaped thing here — is a `webContents.reload()` (`setProject`,
`engine/electron/main.ts`). None of those leave a realm behind, so none of them want a teardown.
There is one `createRoot` (`main.tsx`) and no `.unmount()` anywhere in the repo.

Two consequences worth stating, so neither is re-filed as a defect:

- **`APP_LIFETIME_BY_DESIGN` in `engine/tests/architecture/appManagerDisposeReachable.test.ts` is
  permanent**, not a backlog. `'Input'`, `'engine.time'` and `'engine.navigation'` have a `dispose`
  that production never reaches, and that is correct. Do not empty the list by wiring a new
  teardown path — that was tried, measured and reverted.
- **In-session teardown is a different problem and DOES belong here.** A scene swap or an editor
  world swap keeps the realm alive, so a missed `dispose` there is an ordinary leak. Two were fixed
  under #534 (3D video textures across the four `Scene3D`/`SceneView` teardown sites, and
  `ModelPreview`'s source models). Scene-scoped resources are covered by
  [scene-loading.md](scene-loading.md).
- **This ruling decides which liveness token a site needs.** Because app scope has no teardown, the
  `disposed`-boolean token is rarer here than it looks and a *supersession* epoch is usually the
  right answer; scene scope is where teardown is real, and both apply. The convention —
  capture before the first `await`, re-check before every write after one — and the five sanctioned
  tokens are in [async-lifetime.md](async-lifetime.md).

### Reload-on-resume — the trigger the ruling implies (#574)

If reload is the sanctioned restart, something has to *fire* it. `runtime/core/resumeReload.ts` +
`app/useResumeReload.ts` reload the app when it is resumed after a long background, so a stale
session is replaced rather than resumed. Off by default: **the threshold is authored data**
(`runtime.reloadAfterBackgroundMinutes` in `project.config.json`, in the editor's Project Settings),
because a reload only preserves what the GAME persists. Court and Wordweave each hand-rolled a
mid-level serializer; `sling`, `chess`, `space-invader` and `alien-animal` persist nothing and would
lose the session. Capped at 1 minute whenever `build.debugBuild` is on (owner, 2026-09-02) — a ten-minute wait per
iteration means the trigger is exercised once and assumed correct thereafter.

⚠️ **`games/court` commits `debugBuild: true`, so Court's EFFECTIVE threshold today is 1 minute,
not the authored 10** — and it becomes 10 the day that flag is turned off for a release. The cap is
deliberate and was the owner's call, but it means the authored number is not what runs, so a
perturbation test on that field ("edit it, watch the behaviour move") will read as inert. The boot
log says which value is armed whenever the two disagree; believe it over the config.

Four things about it are load-bearing, and each exists because of a measured trap:

- **`registerReloadBlocker` is NOT `registerUIBusySource`**, though the shape is identical. They
  fail in *opposite* directions on a throwing predicate: a UI-busy source degrades to "not busy"
  so one bad predicate cannot brick every button, while a reload blocker counts a throw as
  BLOCKED, because declining costs nothing and reloading over an unknown state can strand a
  purchase. Court's win screen is a blocker without being UI-busy.
- **Blockers are sampled when we go to BACKGROUND, not only on resume.** "Away for N minutes"
  cannot by itself tell *the player put the game down* from *the app deliberately sent the player
  out and is waiting* — a rewarded video opening the App Store, an OAuth hop through Safari. Those
  background the app by design and can exceed any threshold, and the SDK may have cleared its own
  in-flight flag by the time we look, so a resume-only check sees nothing pending and then
  destroys the realm its callback was about to land in.
- **The reload swallows the resume that triggered it.** `appStateChange` is emitted
  non-retained, and `bridge.reset()` clears every JS listener at navigation start — so the new
  realm never sees it, and Court's cloud-sync `'resume'` would never fire. Hence the
  `sessionStorage` breadcrumb (`markResumeReload`/`consumeResumeReload`). `App.getState()` cannot
  substitute: it reports "active now", equally true on a cold launch.
- **The EDITOR route never self-reloads** — it would discard unsaved scene edits with nobody
  watching. Gated on the route, not on `__MODOKI_EDITOR__`, so the game route under `npm run dev`
  stays testable.

**Device-verified on a Galaxy S22 (Android 14, 2026-09-02).** A 72s background/resume destroyed the
JS realm — an in-page marker was gone — while the native **PID was unchanged**, which is the
realm-dies/process-lives semantic this whole feature rests on, observed rather than inferred. The
control matters as much as the result: a **15s** cycle left the marker intact, ruling out Android
having trimmed the WebView and establishing that the reload is genuinely threshold-gated.

**Also verified on iOS** — iPad mini 5 (`iPad11,1`, iOS 26.6.1, 2026-09-03), over WiFi. Identical
result and identical control: 75s away destroyed the realm with Court's native PID unchanged
(24314 before and after), 15s away left it intact. So the behaviour is the same on both platforms,
which is worth knowing because the two get there through different Capacitor delegates.

⚠️ **The feature was invisible on Android until its log moved off the boot path — FIXED since (#591).**
At the time of this measurement the debug bridge installed its console capture from an async
dynamic import (`main.tsx`'s `import('./debug/bridge').then(...)`), so a boot-time log could miss
`device_console_logs` entirely — an absent line there read as "that code never ran" when it might
only have meant "it ran too early to be seen". Hence the armed-threshold line fired on the first
background edge, not at mount. **This is the measurement that motivated #591's fix**, kept here
because it is real device data, not a hazard still open: `main.tsx` now installs the device console
capture EAGERLY, via a side-effect import (`./installDeviceConsoleCapture`, in
`app/debug/deviceConsoleCapture.ts`) placed above `./App.tsx`, so it runs before React's mount
effects deterministically rather than racing them. Re-measured on the same S22 with a `games/sling`
debug build (2026-09-03), using a TEMPORARY probe line in the installer (the shipped build logs
nothing there): the probe preceded `[debug-bridge] Initializing native bridge`, and a mount-time
`console.info` was captured. So a mount-time line in a build made after #591 is evidence again, not
a coin flip.

⚠️ **One window stayed open, and it is not the one #574 hit.** A log emitted at MODULE-EVAL time
inside App.tsx's own graph is still missed — measured on the same run, a `console.info` at the top of
`games/sling/game.ts` never reached the ring. Source order in `main.tsx` does not survive bundling:
rolldown emits the installer in a shared chunk the entry imports after chunks from App.tsx's graph.
Mount-time and later is covered; "before React mounts" is not the same promise as "from the first
line of JS".

⚠️ **It was a RACE, not a platform quirk** — the same mount-time line that never appeared on the S22
*did* appear on the iPad. Two async things (the bridge chunk resolving, React mounting) with no
ordering between them, so the same build could log or not log depending on how fast the chunk
loaded. That is worse than a deterministic gap: a diagnostic you could not trust to be absent for a
reason. Do not read this historical entry as license to "fix" a missing device log by concluding
the code did not run on a build made after #591 — go verify instead.

⚠️ **A realm death is not a process death, and the guards in this repo confuse the two.** Every
existing double-init latch — `ads.ts`, `attribution.ts`, `LLMManager.ts` — is a module `let`, and
every comment reasoning about them reasons about StrictMode and game swaps. A reload destroys the
realm while the native process, and every native SDK in it, lives on. Where a once-per-process
guard is genuinely needed it must live **natively**; a `let` cannot see this. The defects that
follow from getting it wrong were filed as #584-#588, and all of them predate this trigger — three
shipped paths already reloaded before it (`engine.reload`, `EditorBootBoundary`, Court's post-wipe
restart).

**#584, #586, #587 and #588 are fixed on `work-ai2` (not yet merged to `main`); #585 (litert-lm) is open and iceboxed.** The native
half of this — what `bridge.reset()` does and does not clear, why retained events drain exactly
once, the per-process init each shipped game does, and a table of all five defects with their fixes
— lives in [native-and-sdks.md](native-and-sdks.md) § "What a webview reload does and does not
reset". Do not duplicate it here; this file owns the JS/realm side of the ruling, that one owns the
native side.

**When this would change:** only a **soft restart** — tearing down and re-registering in place
instead of reloading, e.g. to pick up new remote config without a visible reload. That is a real
feature if it is ever wanted, and the bar for it is exhaustiveness: anything the teardown misses
silently survives into the next session, which is a worse failure than the reload flash it saves.
The removed implementation is in git at `bc0fa7242` if it is ever wanted back.

**Scene lifetime is a separate lifetime**, and it is the one that genuinely gets torn down:
`SceneManager.unloadAll()` runs while the realm lives on. ⚠️ Anything that composes with it
inherits #535's "unload wins" semantic — a `loadScene` in flight when `unloadAll` starts **rejects
with `AbortError`** where it used to resolve, so the caller must swallow `AbortError` specifically,
never blanket-catch, following the precedent in `runtime/ui/bindings.ts`.

The `init new *-scoped managers` steps above only run while the load that reached
them is still the live primary — a superseded `loadScene` call skips them instead
of racing the newer one. See [scene-loading.md](./scene-loading.md) § "SceneManager API" step 9 for the
guard and its known residual.

### Method access: singleton, not service-locator

A Manager is a plain singleton; `registerManager` only wires its *lifecycle +
actions*. Other code calls its methods by importing it directly — no
`getManager(name)` lookup.

```ts
// chess/managers/ChessManager.ts — logic lives HERE
class ChessManager {
  name = 'chess';
  // Scene-scoped (single-scene game): the LLM download in init() is expensive,
  // so it must wait for the chess scene to actually load — NOT fire just because
  // the editor registered every game's systems up front.
  scope = 'scene' as const; scenes = ['chess'];
  actions = {
    'chess.newGame':    () => this.newGame(),
    'chess.boardClick': ({ payload }) => this.boardClick(payload),
  };
  init()   { this.startLLMDownload(); }
  dispose(){ this.cancelLLM(); }
  handleAITurn() { /* … */ }   // called from the move callback
  newGame()      { /* … */ }
}
export const chessManager = new ChessManager();
```

## Write side & read side: the two registries

Managers and Systems expose their surface to UI through two symmetric registries.

- **Write side — `actionRegistry`** (exists today). Named *actions* UI can call.
  `UIAction` bindings `kind:'call'` dispatch them. Owned by the
  Manager/System that registers them; gated by `isSimRunning()`.
- **Read side — `readSourceRegistry`** (new). Named *values* UI can bind.
  `registerReadSource(name, getter)` / `unregisterReadSource(name)`. The binding
  resolver (`bindingResolver.ts`) resolves `{name}` against **store state first,
  then registered getters**. No per-frame projection — values are read live at
  resolve time.

```ts
// any Manager, in init()
registerReadSource('timeSinceGameStart', () => timeManager.timeSinceGameStart);
registerReadSource('canGoBack',          () => navigationManager.canGoBack);
```

This is why we avoid copying Manager-derived values into a store via a per-frame
projection (option A) — it would re-introduce the exact poller smell we're
removing. The read-source registry keeps "values reach UI without a tick" and
generalizes: a HUD binds `Time: {timeSinceGameStart}`; a score manager registers
`{score}`; a Back button binds its VISIBILITY to `canGoBack`.

⚠️ That last one was written here as `disabled={!canGoBack}` for a long time, and no
such binding exists. A read source reaches a UI element through
`UIBinding.visibleBinding` / `textBinding` only (`runtime/ui/bindingResolver.ts`); the
one `disabled` field in the UI traits — `UIToggle.disabled` — is written by a `set`
binding, never read from the read-source registry. So the shipped shape is *hide*, not
*disable*. Kept as an aspiration if someone wants to build it; do not cite it as
existing.

## Engine-global Managers

Engine built-ins are the one thing outside the per-game manifest — registered
once at core startup (alongside `registerEngineActions`, in `app/ecs/register.ts`).
Every game inherits them.

### NavigationManager

The actual gap that started this design: navigation logic was scattered across
`engine.loadScene` (engine action), `scene-selector/init.ts` (its *own*
`navigateBack`/`selectGame`), and `App.tsx` hash routing — with **no back-stack
anywhere**.

`NavigationManager` owns the history stack (the missing piece — `back()` needs
it) and exposes `loadScene` / `back` / `canGoBack` / `replace`. It backs onto
`SceneManager` (which owns transitions). Built-ins become thin wrappers:

- actions: `engine.loadScene`, `engine.navigateBack`
- read source: `canGoBack`

`scene-selector` stops re-implementing `navigateBack` — it uses the engine
built-in.

**History is recorded at the WORLD SWAP, not in the navigation's own continuation
(#808).** `loadScene`/`back` only CLAIM their target path; `NavigationManager.onSwap`
records the transition if and when that swap commits, using one rule for both
directions — arriving at the entry we would `back()` into pops it (that is both the
back and the A→B→A oscillation collapse); anything else pushes the scene we left.
The pop is checked FIRST and unconditionally, maintaining the invariant *the current
scene is never the top of the back-stack*: a same-scene swap (A→A) is exactly when
that invariant is already broken, because something outside this manager — Play-stop
restore, prefab undo, an agent `load_scene` — landed us on the entry at the top, and
guarding on "we did not move" before the pop left it unconsumed forever.

A claim is per CALL, not per path. `replace()` claims too, but as SUPPRESSING — it
consumes its own swap and records nothing, so its "navigate without history" contract
holds even against a concurrent `loadScene` for the same scene. Every direct
`sceneManager.loadScene` (boot, hot-reload) claims nothing, which is what keeps "only
this manager's methods record history" true **for every case production can reach** —
strictly, an external swap onto a path that happens to have a live claim would consume
it, but a real direct load aborts the pending navigation first and clears that claim.

⚠️ **Two concurrent navigations to one scene with opposite intent are genuinely
ambiguous** — `onWorldSwap` does not say which call caused the swap — so the rule is a
tie-break, not an answer: the most recently STARTED claim wins, i.e. what the player
last asked for. Preferring the suppressing claim reads as safer and is not; a
`replace()` that was itself superseded, whose cleanup has not yet run, would disarm the
`loadScene` that actually committed and leave Back dead.

⚠️ **Five shapes preceded this one, and each looked obviously right.** ① the original
mutated `history` BEFORE its `await`, so a rejected load left the stack off by one;
② a snapshot restored in a `catch` — discards the work of whichever navigation
superseded this one; ③ that restore gated on a supersession epoch — answers *am I still
the latest?*, not *is my mutation still on the stack?*, and they diverge whenever the
superseding call mutates nothing; ④ deferring the write past the await — two
navigations that BOTH succeed interleave, because a load superseded by a newer LOAD
after its swap is no longer cancelled and RESOLVES, so its stale continuation runs after
the winner's (not absolute: a mid-flight `unloadAll()` still throws post-swap, #542);
⑤ swap-driven but with a `Set<path>` claim — see the next paragraph.

⚠️ **Supersession cuts both ways, and knowing only half of it cost a fifth round.** A
load superseded BEFORE its swap does *reject*, with `AbortError` — normal operation,
as `ui/bindings.ts` says in its own comment — so the LOSER settles first. That is why
a claim is per call: a `Set<path>` collapses two navigations to one scene into a single
entry, and the loser's cleanup then released it before the winner's swap arrived, so
the winner recorded nothing.

**The shared mechanism:** each repair had the navigation's own continuation decide what
to write by INSPECTING the stack after its `await` — and the stack is exactly what a
concurrent navigation may have changed by then. Every guard was a proxy for *did my
navigation actually win*, and each proxy failed on a different interleaving. The swap
is the authoritative, serialized answer, so no proxy is needed.

⚠️ **Testing this needs a real swap.** A mock that only resolves
`sceneManager.loadScene` exercises none of the above — that is precisely why four
repairs shipped or were proposed green. `tests/runtime/navigationManager.test.ts`
drives `setCurrentWorld`, and can put the swap and the promise resolution at DIFFERENT
points, which is the post-swap-tail window the interleavings live in.

Measured against the 32-test suite, every prior shape fails and no two fail the same
way — which is the property that makes it a regression test rather than a description
of the current code:

| shape | failures |
|---|---|
| ① mutate before the await | 9 |
| ② snapshot + restore | 6 |
| ③ restore gated on an epoch | 6 |
| ④ defer past the await | 2 |
| ⑤ swap-driven, `Set<path>` claims | 4 |
| ⑥ swap-driven, per-call claims (current) | **0** |

⚠️ **What the suite still cannot see: production never drives this.** No scene in
`games/**` or `demos/**` binds `engine.navigateBack` or the `canGoBack` read source,
and `replace()` has no callers at all — so `back()`, the pop and the oscillation
collapse have never run against a real Back button. That absence, not the mocking, is
the structural reason six shapes of this fix could each ship green. **That gap is now partly closed**:
`tests/runtime/navigationBackButton.integration.test.ts` authors a Back button into a
real scene, loads it through the real `SceneManager` (fetch stubbed, nothing else), and
presses it through `applyBindings` — so the whole chain from click to history pop to the
button's own visibility runs. ⚠️ It binds `visibleBinding`, not `disabled`, for the
reason given further up: the disabled form does not exist.

⚠️ **The visibility half only counts because it RENDERS the real `UINode` — and the reason
is the JOIN, not the gate.** It was first written asking `evalVisibility` directly, which with
an empty `visibleOp` reduces to the `getReadValue('canGoBack')` assertion on the line above it:
a copy of the decision, not the decision. But the obvious justification for fixing that
("nothing covered `UINode`'s gate") is ALSO false — `uiNode.test.tsx`'s *"a visibility
binding hides the element when evalVisibility is false"* pins the gate, and deleting it
reddens that file too. What nothing else covers is the join: `uiNode.test.tsx`
**mocks** `evalVisibility`, so no other test runs an authored scene through
`registerReadSource('canGoBack')` → the real resolver → the real gate. Measured: delete
`bindingResolver.ts`'s read-source fallback and this file goes 2/2 red while
`uiNode.test.tsx` + `uiRenderer.test.tsx` stay 188/188 green. The entity also has to carry
`RenderableUI` + `UIElement`, or `uiTreeStore` builds no node and the thing under test is not
a UI element at all.

⚠️ **It is not a substitute for the unit suite, measured:** that file fails on pre-#808
(1 of 2) and PASSES on the deferral shape that shipped and was wrong. It closes the
*chain* gap; the interleaving gap is closed by `navigationManager.test.ts`, which can
separate a swap from its promise resolution. What is still missing is an AUTHORED scene
in a real game — no `games/**` or `demos/**` scene binds these — so the editor-authoring
side of this remains unexercised.

**That last gap is deliberately recorded HERE and not in the tracker** (owner, 2026-09-07),
so it is not an oversight to be "corrected" by filing an issue for it. It is latent —
nothing binds these bindings today — and authoring a Back button into a real game is a UI
decision, not test infrastructure. The place it matters is this section, which is what
anyone touching `NavigationManager` reads.

### Time (System + Manager)

Time is the canonical case of a feature that is **both** roles, and they compose
rather than compete:

- **`timeSystem` (System, unchanged)** — advances one monotonic, pause-aware
  `Time.elapsed` every frame. The single source of "now"; every other system
  depends on it, so it is **never reset**.
- **`TimeManager` (Manager, new)** — captures event **anchors** (offsets into
  `elapsed`) and exposes derived reads. No tick.

```ts
class TimeManager {
  private anchors = new Map<string, number>();
  private now() { return getTime().elapsed; }              // pause-aware clock (System)

  init() {
    onPlayStateChange(s => { if (s === 'playing') this.mark('gameStart'); });
    onWorldSwap(() => this.mark('sceneLoad'));              // re-anchors every scene swap
  }

  // ── generic layer (open-ended; games invent their own) ──
  mark(name: string)      { this.anchors.set(name, this.now()); }
  timeSince(name: string) { return this.now() - (this.anchors.get(name) ?? this.now()); }

  // ── fixed accessors (sugar over the generic layer; never duplicate state) ──
  get deltaTime()          { return getTime().delta; }
  get timeSinceGameStart() { return this.timeSince('gameStart'); }
  get timeSinceSceneLoad() { return this.timeSince('sceneLoad'); }
}
```

Properties that fall out for free:

- **Anchors are offsets, never resets** — `timeSinceX = elapsed − anchorX`, so
  adding game-start time can't perturb rotate3D/animation.
- **Pause / editor Play-Stop work without special-casing** — derived from the
  already-pause-aware `Time.elapsed`; the `'playing'` transition re-stamps
  `gameStart`.
- **Generic + fixed both ship** — `mark('levelStart')`/`timeSince('levelStart')`
  gives games arbitrary stopwatches with zero new systems or traits; the fixed
  accessors let UI bind `{timeSinceGameStart}` without knowing a magic string.

The general lesson: **a System maintains a base quantity each frame; a Manager
captures event anchors and exposes the derived API on top of it.** Same shape
recurs — physics System integrates / Manager `raycast()`; animation System
advances / Manager `play(clip)`.

## The manifest model

`setup.ts` becomes a pure manifest — it declares *what* a game has, never *how it
behaves*. `init.ts` is deleted; its logic moves into named Manager singletons.

```ts
// space-console/setup.ts — wiring only, zero logic bodies
registerSystems([cameraDistanceSystem, stripeTimeSystem, shipShakeSystem, engineFlameSystem]);
registerManagers([cameraManager]);     // owns setCameraDistance action + debugStore writes
registerShaders([stripes, matcap, planet]);
```

| Today (scattered) | After (owned) |
|---|---|
| `chess/init.ts`: `handleAITurn`/`newGame`/`handlePlayerChat` + ad-hoc `registerUIAction` | `ChessManager` (scene scope) — methods + `actions` map |
| `scene-selector/init.ts`: private `navigateBack`/`selectGame` + `spawnGameCards` | nav → engine `NavigationManager`; cards → `SceneSelectorManager` (scene scope) |
| `space-console/setup.ts`: inline `setCameraDistance` closure | `CameraManager` owns it |

The final shape: three tiers, each with one obvious home.

- **System** (ticks) → `registerSystems`
- **Manager** (events; scene/game scope) → `registerManagers`
- **Engine Manager** (global) → registered by core once

## Decision log

1. Five roles are fine — don't force two.
2. Manager is first-class and **symmetric to System** (`registerManager`, owned
   actions, `init`/`dispose`).
3. Manager scope **defaults to scene**, **game-scoped is opt-in**.
4. **SceneManager owns** Manager lifecycle (rides the existing swap sequence).
5. Manager = plain **singleton**; method access by direct import, not a locator.
6. Engine built-in Managers (`NavigationManager`, `TimeManager`) registered
   **once at core startup**.
7. `setup.ts` = manifest; `init.ts` deleted; logic lives in named Managers.
8. Navigation is a **Manager**, backed by SceneManager, owning the **history
   stack**; `scene-selector` drops its private `navigateBack`.
9. Time = **`timeSystem` (System) + `TimeManager` (Manager)**; anchors are
   offsets into a never-reset `elapsed`.
10. TimeManager ships **generic anchors (`mark`/`timeSince`) with fixed accessors
    on top**.
11. UI reads Manager values via a **read-source registry** (option B) — the
    read-side mirror of `actionRegistry` — not a per-frame store projection.
