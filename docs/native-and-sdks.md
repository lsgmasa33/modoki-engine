# Native Platform & SDKs

How the **modoki** prototype integrates native iOS/Android SDKs through Capacitor 8. All native SDKs ship as standalone, reusable Capacitor plugin packages — no Cordova, no CocoaPods for SDK frameworks.

See also [Architecture](./architecture.md).

## Standalone Capacitor Plugin Pattern (iOS SPM)

Every native SDK is wrapped in its own Capacitor plugin package. Post-#29 these live **per-game** under `games/<id>/packages/capacitor-*/` (e.g. `games/3d-test/packages/capacitor-applovin-max`, `games/3d-test/packages/capacitor-adjust`); engine-level plugins (`capacitor-game-debug`, `capacitor-litert-lm`) live under `engine/packages/`. A package contains:

- `Package.swift` — declares the native SDK as a **Swift Package Manager (SPM)** dependency (e.g. `AppLovin-MAX-Swift-Package`, `adjust/ios_sdk`).
- `*.podspec` — CocoaPods fallback manifest (SPM is the primary path).
- iOS Swift plugin — a class extending `CAPPlugin` and conforming to `CAPBridgedPlugin`.
- Android plugin — Java/Kotlin class.
- TypeScript definitions — the only public surface consumers import.

### The 6-step pattern

1. **Standalone package** (`games/<id>/packages/capacitor-*/`, or `engine/packages/` for engine plugins) — an npm package with `Package.swift` (SPM), a `*.podspec` fallback, the iOS Swift plugin, the Android plugin, and TS definitions.
2. **`Package.swift` declares the native SDK** as an SPM dependency.
3. **Plugin Swift class extends `CAPPlugin`** and conforms to the `CAPBridgedPlugin` protocol.
4. **Capacitor auto-discovers the plugin** via SPM — no manual registration needed (see the static-linking exception below).
5. **`AppDelegate.swift` initializes early-init SDKs** (AppLovin MAX, Firebase) before the WebView loads.
6. **TypeScript is the public API** — e.g. `import { ApplovinMax } from 'capacitor-applovin-max'`.

### Why not Cordova

Cordova plugins are broken with Capacitor 8 + SPM: they bundle ancient native SDKs, suffer placeholder-substitution bugs, and their native classes aren't registered in Capacitor 8's SPM plugin registry — so `cordova.exec()` calls fail silently.

### Why not CocoaPods for SDK frameworks

Mixing CocoaPods and SPM produces duplicate-framework conflicts. Any SDK that has an SPM package uses SPM. CocoaPods is reserved only for the AppLovin **mediation adapters**, which have no SPM support yet.

### iOS SPM static-linking gotcha

SPM static linking **strips plugin classes that have no external framework dependencies**. The class compiles and links, then is simply absent at runtime, so Capacitor reports `"GameDebug" plugin is not implemented on ios`. `capacitor-game-debug` and `capacitor-modoki-ota` both hit this — each must be registered manually in `MyViewController` (`bridge?.registerPluginInstance(...)`, which keeps the class alive), plus an Xcode file reference from the App target to the plugin source (project-relative path in the pbxproj, no copy). Edit the package source only.

⚠️ **Only the game-debug half is generated.** `engine/plugins/healNativeConfig.ts` writes the pbxproj reference and the fenced registration block for `GameDebugPlugin` in every project; it contains **no OTA wiring at all**. `capacitor-modoki-ota`'s pbxproj refs and its `ModokiOtaPlugin` registration are **hand-maintained, in `games/ota-test` only** — the heal is deliberately fenced rather than whole-file precisely because that project hand-extends `MyViewController.swift` with an OTA boot hook (see the comment at `healNativeConfig.ts:596`). So regenerating that project's iOS — `cap add ios`, or deleting `ios/` after a native-config problem — restores the GameDebug wiring and **silently drops OTA**. Re-add it by hand and verify the plugin registers.

⚠️ **Those plugins' `package.json` therefore declares `"capacitor": { "android": … }` with NO `ios` entry, and that is DELIBERATE.** The App target already compiles the `.swift` directly; adding an `ios` entry makes `cap sync ios` *also* add the SPM package, so the plugin class lands in two modules — **one `@objc` runtime class name with two implementations**. (What that then does at runtime has not been observed: the ObjC runtime resolves one name to one implementation, so expect a duplicate-class warning and a nondeterministic winner rather than, say, two `NWListener`s both binding :9095. The defect is the duplication; the symptom is unverified.)

**The reading that misleads:** `npx cap sync ios` reports one fewer plugin than `cap sync android` (5 vs 6 on a typical project), because the count cannot see the pbxproj road. That gap is expected, not a defect — it was filed as one in #368, where the proposed one-line fix would have broken every iOS build it meant to repair. Guarded by `engine/tests/architecture/capacitorPlatformDeclarations.test.ts`.

`capacitor-modoki-iap` is the contrasting case: it goes through SPM normally and correctly declares both platforms, and it is verified working (real store sandboxes on hardware, 2026-08-12). Note its own `Package.swift` header is deliberately agnostic about *why* — do not read it as a rule that "a system framework import is enough to keep the class"; that causal claim is untested.

`capacitor-litert-lm` is a THIRD case, and the one most easily got wrong. Its
`ios/Sources/LitertLmPlugin/LitertLmPlugin.swift` is a **complete ~380-line MediaPipe
implementation** (`import MediaPipeTasksGenAI`, real `LlmInference` model loading and streaming) —
**not a stub**, despite a stale comment at the top of its `Package.swift` still calling it one. What
actually blocks iOS is narrower: **`Package.swift` declares only `capacitor-swift-pm`, while
`CapacitorLitertLm.podspec` declares `MediaPipeTasksGenAI` + `MediaPipeTasksGenAIC`.** So an SPM
build of that target cannot resolve `import MediaPipeTasksGenAI` and fails to compile, and the
podspec is not a "fallback" here — it is the only iOS path whose dependencies resolve. Declaring
`"ios"` on this package without first adding the MediaPipe dependency to `Package.swift` turns a
green `npm run verify` into a broken `cap sync ios` build on `games/llm-test`.

### The SceneDelegate trap — a silently dead iOS debug bridge (#368)

`MyViewController` is what registers `GameDebugPlugin` into the bridge, and `Main.storyboard` names
it via `customClass="MyViewController"`. **A `SceneDelegate` that builds its window in code
overrides the storyboard entirely:**

```swift
window?.rootViewController = CAPBridgeViewController()   // ← storyboard never consulted
```

`MyViewController` is then never instantiated, the registration never runs, and the plugin — which
IS compiled into the binary via the pbxproj reference — is never wired in. Use `MyViewController()`.

**The failure is invisible everywhere you would look.** No crash, no render fault: the WebView loads
and the game draws perfectly. The only symptom is `[debug-bridge] startServer failed: "GameDebug"
plugin is not implemented on ios` in the JS console — which reaches **no device log**, because the
plugin logs via `print()` (stdout) and its single `NSLog` is inside `triggerFault`. From the host it
presents only as `ECONNREFUSED :9095`, indistinguishable from "the app is not running". Reading it
needs Xcode's console or `device_console_logs`, and the latter needs the very bridge that is down.

**How 9 projects got it at once.** The file comes from Capacitor's own iOS template — nothing here
CREATES one (`healIosSceneDelegateBridgeVC` only repoints an existing file, never writes a new one),
so `cap add ios` is what introduces it. `e2973d940` scaffolded native for **ten** projects in one
run and verified them **on Android hardware only** — iOS was generated and never launched — and
`games/iap-test` inherited it later.

⚠️ **The emission rule is NOT understood, and this doc will not pretend otherwise.** That single run,
same tool, produced a `SceneDelegate.swift` for eight projects and none for `demos/3d-physics-demo`
or `games/chess` (which also have no `UIApplicationSceneManifest`). Nor does that run account for
every file: there are **ten** tracked `SceneDelegate.swift` today — those eight, plus `games/iap-test`,
plus `demos/postfx-demo`, which predates the run entirely and is where the trap was first found and
fixed. Three separate origins, one unexplained split. Capacitor 8.5's templates — both
`ios-spm-template.tar.gz` and `ios-pods-template.tar.gz` — DO ship the file today, so new projects
get it and the heal covers them. But whatever made two projects in one batch differ is unexplained:
treat "which projects get a SceneDelegate" as an open question, and rely on the heal + guard rather
than on predicting it. Every *other* heal made them look correct: `healNativeConfig`
wrote a right `MyViewController.swift` and a right pbxproj ref into projects whose SceneDelegate
bypassed all of it.

`demos/postfx-demo` hit and fixed this locally on 2026-08-05 and left a comment predicting exactly
this spread. A per-project comment cannot enforce anything on projects that do not exist yet, so it
is now enforced in two places instead: **`healIosSceneDelegateBridgeVC` repoints it** on project
open / native build, and **`engine/tests/architecture/sceneDelegateBridgeVC.test.ts`** fails the gate
on committed state.

Measured on the iPhone 8 (iOS 16.7.16), 2026-08-27: with the base VC, port 9095 refused; after the
one-word change, `device_connect` succeeded, `getStatus` reported `running: true, port: 9095`, and
`getDeviceIp` returned the LAN IP. ⚠️ That last point matters — the debug menu's "WiFi is down" was
this same bug, not a network fault: `getDeviceIp()` was rejecting because the plugin was absent.
**So `wifiIPv4()`'s hardcoded `en0` is NOT the bug** — it returned the right address the moment the
plugin was registered, and an Android-parity rewrite of it was reasoned out and deliberately not
shipped. That is the verified claim, and the only one.

**Separately — now HARDENED, 2026-08-27.** `wifiIPv4()` used to force-dereference
`interface.ifa_addr.pointee`, and `getifaddrs(3)` may hand back an interface with NO address
(normal for `awdl0`, an unconfigured tunnel, a downed cellular link). Swift imports `ifa_addr` as an
implicitly-unwrapped optional, so that compiled cleanly and would have TRAPPED on such an entry —
crashing `getDeviceIp()`, which the debug menu's Device tab calls. The loop inspects every interface
before deciding which one it wants, so one address-less entry anywhere in the list was enough.

⚠️ **The obvious form of the fix HANGS**, which is why it is spelled out here. `wifiIPv4()` advances
its cursor on the LAST line of the loop body, so a bare `guard … else { continue }` never advances
and the `while let cur = ptr` spins forever — trading a crash for an unkillable hang, on precisely
the interface list that triggered it. The shipped form advances first:
`guard let addr = interface.ifa_addr else { ptr = interface.ifa_next; continue }`.

**What is and is not verified.** Verified on the iPhone 8: it compiles, and `getDeviceIp()` still
returns the LAN IP — so no regression on the path that is actually taken. NOT verified: the guarded
branch itself, including its cursor advance, because no device we have produces an address-less
interface. Its correctness rests on INSPECTION — both exits from the loop body assign
`ptr = interface.ifa_next` before leaving — not on measurement.

⚠️ **An earlier version of this paragraph claimed "five consecutive calls in 9 ms, so provably no
hang". That proved nothing and the wording is kept here as the correction.** The hang can only occur
on an interface with a NULL `ifa_addr`, which this device does not have, so the `else` branch never
executes: build the plugin with the BAD `guard … else { continue }` form and the same five calls
still return the same address in the same time. The observation is identical under both hypotheses —
a check that cannot fail is not evidence. Guarding a condition you cannot reproduce means accepting
an unexercised branch and SAYING so, rather than dressing inference as measurement.

Note the cost of touching this file at all: it moves the plugin's content hash and forces a
re-vendor across every consuming project (the `vendoredPluginFreshness` guard, #90 — that guard owns
the count, so it is not repeated here), so batch such edits rather than drip them.

## SDK Plugins

Current plugins and minimal usage:

### `capacitor-applovin-max` — AppLovin MAX

Banner, MREC, interstitial, and rewarded ads + the mediation debugger. The core SDK is provided via SPM (iOS) / Gradle (Android).

```typescript
import { ApplovinMax } from 'capacitor-applovin-max';

await ApplovinMax.showBanner({ adUnitId, position: 'bottom' });
await ApplovinMax.loadInterstitial({ adUnitId });
const { shown } = await ApplovinMax.showInterstitial();
await ApplovinMax.showMediationDebugger();
```

⚠️ **A blank `adUnitId` is a CRASH, not a no-op** (#510). Loading or showing an ad with an
empty id throws on the native **main thread** — outside any JS `try/catch` — and terminates the app.
So a game's ad wrapper must gate on **the unit id it is about to pass**, per entry point; gating on
the SDK key alone is not enough, because a configured key with unfilled unit ids is exactly the
half-configured state that reaches the SDK.

⚠️ **Check the plugin signature — not every ad call takes an id, and the rule only bites on the
ones that do.** **Read the plugin's `definitions.ts` for the call you are adding** rather than trusting a list
here — this one has already been wrong once, and a hand-maintained enumeration in a doc whose
thesis is "check the signature" is precisely what goes stale. As of writing, `loadInterstitial`,
`loadRewardedAd`, `showBanner` and `showMRec` take an `adUnitId`, and those guards are crash
guards; `showInterstitial`/`showRewardedAd` take only `{ placement }` and
`hideBanner`/`showMediationDebugger` take nothing at all, so no blank id can reach the SDK through
them — guarding those on the unit id is still right, but it is a *behavioural* "we never loaded
one, so there is nothing to show", not a crash guard. Stating it as one (this doc did, briefly)
teaches the next wrapper author to look for the wrong thing. `games/court/packages/app-services/src/ads.ts` is the
reference shape (a `unit(kind)` accessor + a guard on every call that takes an id);
`games/3d-test`'s had the warning in its banner and the check on the key only, which is how #510
was filed. `hideBanner`/`showMediationDebugger` take no id and need no such guard.

### `capacitor-adjust` — Adjust (SDK v5)

Attribution, event tracking, ad-revenue, IDFA/ADID, ATT, purchase verification.

```typescript
import { AdjustCap } from 'capacitor-adjust';

await AdjustCap.initialize({ appToken, environment: 'sandbox' });
await AdjustCap.trackEvent({ eventToken, revenue: 1.99, currency: 'USD' });
await AdjustCap.trackAdRevenue({ source: 'applovin_max_sdk', revenue: 0.012, currency: 'USD' });
const { idfa } = await AdjustCap.getIdfa();
```

### `@capacitor-firebase/analytics` + `@capacitor-firebase/crashlytics`

Official Capacitor plugins for Firebase Analytics and Crashlytics. Firebase is an early-init SDK (initialized in `AppDelegate.swift` / the Android `Application` before the WebView loads). A game's thin wrappers live in its app-service package — `games/3d-test/packages/app-services/src/analytics.ts` (`logEvent`, `setUserProperty`, `setCurrentScreen`, `setEnabled`) and `crashlytics.ts` (`recordError`, `log`, `setCustomKey`, `crash`, `setEnabled`).

**Native-only, gated per-call.** Every wrapper opens with `if (!Capacitor.isNativePlatform()) return;`. Off native — the editor, web preview, and tests — there is no initialized Firebase app, so an ungated call throws `app/no-app` and spams the console. The check is deliberately **per-call, not a module-level const**, so a test can exercise both the native and web paths without module-cache tricks. Beyond the gate, each call is wrapped in try/catch and downgrades any SDK failure to a `console.warn` — analytics/crashlytics is best-effort telemetry and must never break gameplay. The engine reaches Crashlytics through the app-service registry (`appServices().crashlytics?.recordError/log`), never by importing the plugin directly — see [App-service registry](#app-service-registry).

### `capacitor-game-debug` — native debug bridge

Runs a TCP server on the device (no Bonjour/mDNS — connection is Modoki's deliberate lease by IP/adb); consumed by the `game-debug` MCP server. See [Debug Bridge & MCP](#debug-bridge--mcp).

```typescript
import { GameDebug } from 'capacitor-game-debug';

await GameDebug.startServer({ port: 9095 });
const { running, connected } = await GameDebug.getStatus();
```

### `capacitor-modoki-audio` — `AVAudioSession` category (#548, open)

Engine-level plugin under `engine/packages/` (like `capacitor-game-debug`/`capacitor-litert-lm`,
not per-game). Sets the `AVAudioSession` category so other apps' audio (Music, podcasts) isn't
killed the instant ours starts. Its auto-ducking half was removed (device testing showed the
signal it relied on can't distinguish another app's audio from our own WKWebView-owned session).
Full mechanism and device-verification status: [audio-plan.md](./audio-plan.md) § "iOS audio
session".

```typescript
import { ModokiAudio } from 'capacitor-modoki-audio';

await ModokiAudio.configure({ category: 'ambient' }); // or 'playback'
```

**Android/web are permanent no-ops.** Not a stub to fill in later: Android audio is 100% WebView
with no audio-focus concept to bridge (measured for #548, see the doc above).

⚠️ **The SPM static-linker question this plugin's own `Package.swift` header raises is
UNTESTED.** It imports only `AVFoundation`, a system framework — the same dependency-free shape
that got `capacitor-game-debug` stripped by SPM's static linker (see above). `capacitor-modoki-iap`
imports `StoreKit`, also a system framework, and resolves fine, but nothing has confirmed *why*, so
this package's header explicitly declines to assume a system-framework import is enough to survive
linking. **This can only be settled by a device build.** If the plugin class turns out to be
stripped, the fallback is the same one `capacitor-game-debug` uses: compile the plugin directly
into the App target with manual registration in `MyViewController.swift`, rather than via SPM.

### `capacitor-litert-lm` — on-device LLM

On-device LLM inference (used by the `llm-test` game), with **one TS surface, two engines behind it**: Capacitor's `registerPlugin` routes each call to the native Android implementation (`LitertLmPlugin.kt` — LiteRT-LM Kotlin SDK) or, on web, to `LitertLmWeb` (`src/web.ts` — MediaPipe `@mediapipe/tasks-genai`, Gemma running via WebGPU). The definitions (`src/definitions.ts`) are the contract both sides implement.

```typescript
import { LitertLm } from 'capacitor-litert-lm';

await LitertLm.downloadModel({ url, filename });        // Android only; progress via 'loadProgress'
await LitertLm.loadModel({ modelPath, maxTokens: 1024 }); // topK/temperature/randomSeed optional
const { conversationId } = await LitertLm.createConversation();
await LitertLm.sendMessage({ conversationId, message }); // tokens stream via 'tokenReceived'
```

**Status machine:** `getStatus()` returns `idle | loading | ready | generating | error` + `modelName` + `errorMessage`; the JS callers poll it after a `{ ok: false }` result to surface the real error message.

**Streaming.** `sendMessage` resolves only when generation completes; the actual output arrives token-by-token through the `'tokenReceived'` listener (`{ conversationId, token, done }`). `games/llm-test/runtime/services/CapacitorLLMService.ts` is the app-side wrapper — it registers the `tokenReceived` listener (filtered by `conversationId`) **before** calling `sendMessage`, forwards each token to an `onToken(token, done)` callback, and removes the listener in a `finally`. It similarly attaches a `loadProgress` listener around `loadModel` and multicasts to a `Set` of progress callbacks.

**Model download is split by platform** (`games/llm-test/runtime/services/ModelDownloader.ts`): on **Android** `LitertLm.downloadModel` fetches via `HttpURLConnection` into app internal storage and returns the local file path (skipped if `isModelDownloaded` reports it present); on **web** the plugin's `downloadModel`/`isModelDownloaded` are no-ops — the game instead `fetch`es the model with a streaming reader for progress, stores it in the `caches.open('llm-models')` Cache API, and hands MediaPipe a `URL.createObjectURL(blob)`. Web's `loadModel` lazy-imports `@mediapipe/tasks-genai` (and its wasm fileset from jsdelivr) so the bundle isn't paid for off-web.

## Removing a plugin listener — `remove()` is NOT idempotent

⚠️ **Calling `.remove()` twice on one `PluginListenerHandle` silently evicts somebody ELSE's
listener.** `@capacitor/core`'s `WebPlugin.removeListener` is, verbatim:

```js
const index = listeners.indexOf(listenerFunc);
this.listeners[eventName].splice(index, 1);
```

There is no `index === -1` guard, so a stale remove does `splice(-1, 1)` — which deletes the
**last** entry in that event's array. Nothing throws and nothing logs. The victim is whichever
listener registered most recently, i.e. usually the newest one, i.e. the one somebody is
actively waiting on.

**This bites the moment a handle has two paths to removal**, which is exactly what a teardown
that can reach an in-flight operation creates: `dispose()` removes the handle, and then the
operation's own `finally` removes it again. Concretely (#525): a dispose lands mid-load, a fresh
service starts a new load and registers its `loadProgress` listener, the first load's promise
then settles and its `finally` evicts the NEW listener — and that load's progress sits at 0 for
a multi-GB download with nothing erroring anywhere.

**The shape that is safe** — the Set membership is the arbiter, so the two paths are mutually
exclusive, and `games/llm-test/runtime/services/CapacitorLLMService.ts` is the worked example:

```ts
private activeListeners = new Set<PluginListenerHandle>();
// ... register:  this.activeListeners.add(handle);
// ... teardown:  for (const h of this.activeListeners) h.remove(); this.activeListeners.clear();
// ... finally:   if (this.activeListeners.delete(handle)) handle.remove();
```

Two rules follow, and the second is the one that gets skipped:

1. **Never remove a handle a teardown can also reach without a membership check.** A bare
   `handle.remove()` in a `finally` is correct only while nothing else can remove that handle.
2. **Every listener a class registers goes in the same registry.** The asymmetric version —
   one kind of listener tracked, another kept as a bare local — is its own defect with the
   polarity reversed: `dispose()` cannot reach the untracked one, so a teardown mid-operation
   leaves it registered until that operation settles. Fixing that by adding it to the registry
   while leaving its `finally` unconditional trades the leak for the double-remove above.

A repo-wide sweep (2026-09-01) found no remaining reachable double-remove. The near misses are
single-path only by accident and are worth knowing: `games/court/packages/app-services/src/auth.ts`'s
`onAuthChanged` unsubscriber and `games/court/runtime/cloudSyncWiring.ts`'s registered closures both
do a bare `void handle.remove()` with no guard and no null-out — safe today because each has exactly
one caller that drains exactly once, and unsafe the moment a second caller appears.

## App-service registry

Analytics, crashlytics, ads, and attribution are **app/game concerns, not engine concerns** — they wrap native SDKs (Firebase, AppLovin MAX, Adjust) that the engine must never depend on. So the engine ships only a tiny hook surface and lets each project plug its own implementations in. This is the seam that keeps the SDK code out of the engine bundle (and out of games that don't want ads).

### Key files

- `engine/packages/modoki/src/runtime/core/appServices.ts` — the registry: `registerAppServices(services)` (merge-registers), `appServices()` (read the current set), `clearAppServices()` (tear down and drop them on game swap — see below). Interfaces `CrashlyticsService` (`recordError`/`log`), `AdsService` (`init`/`cleanup`), `AttributionService` (`init`).
- `engine/packages/modoki/src/runtime/core/gameDefinition.ts` — the `GameDefinition.registerAppServices?()` hook a project implements.
- `games/3d-test/packages/app-services/src/index.ts` — a game's implementation: `register()` calls `registerAppServices({ crashlytics, ads, attribution })`, wiring its own `crashlytics.ts` / `ads.ts` / `attribution.ts` into the engine surface.
- `engine/app/App.tsx` — the shell that drives the lifecycle.
- `engine/packages/modoki/src/runtime/core/globalErrors.ts` + `engine/app/installErrorCapture.ts` — the engine's **global JS error capture** (#275). The largest caller of `crashlytics`, and the one a shipped build most depends on — see below.
- `engine/app/ui/components/ErrorBoundary.tsx` (via `reportReactError`) and `runtime/store/gameStore.ts` (screen breadcrumbs) — the other two engine-side callers.

### How it works

The engine sees only the **small hook surface** — `crashlytics.recordError/log`, `ads.init/cleanup`, `attribution.init`. A game's package keeps its full API (`showInterstitial`, `logEvent`, `setUserProperty`, …) for the game itself to import and call directly; the engine never sees those. On game bootstrap `App.tsx` calls, in order: `def.registerAppServices()` (the game populates the registry), then — **only on `Capacitor.isNativePlatform()`** — `appServices().attribution?.init()` and `appServices().ads?.init()`. Ads are cleaned up (`appServices().ads?.cleanup()`) on unmount. Crashlytics is pull-driven: `gameStore` logs screen breadcrumbs via `appServices().crashlytics?.log(...)`, `ErrorBoundary` reports a React subtree crash through `reportReactError`, and the global capture below reports everything else.

**Every hook is optional and every unregistered hook is a silent no-op** (callers use `?.`) — which is also the correct web/editor behaviour, since the underlying Capacitor plugins stub out off-device anyway. On a game switch `App.tsx` calls `clearAppServices()` **before** the next game's `registerAppServices()`, so a previous game's ad/attribution SDKs don't leak into the next game. ⚠️ **That sentence described an intention, not the code, until #511**: `clearAppServices()` was `registered = {}` and nothing more, while the only caller of `AdsService.cleanup()` was `App.tsx`'s `[]`-deps *unmount* effect — so a swap dropped the registry and left the outgoing game's AppLovin MAX listeners live under the next game, double-counting ad revenue. It now captures the outgoing `ads`, clears the registry **first** (so a cleanup that throws or re-enters finds it empty, never half-cleared), then calls `cleanup()` inside a `try/catch` — a game's teardown must never break the swap. A game's `cleanup()` must therefore be **idempotent**, because the unmount effect can still run after a swap already cleaned up. The lesson generalises: **a teardown hook that exists and is called by nothing is indistinguishable from no hook at all** (same family as #506's `stopCloudSync`). Native SDK init is no longer wired in `main.tsx` — that comment there points here. The game package is also the dogfood stand-in for a future Modoki-hosted npm package (see `docs/modoki-package-manager.md`).

### Global JS error capture (#275)

**A shipped build had none.** `window.addEventListener('error'|'unhandledrejection')` existed in four
files and every one is a debug or editor surface a release build does not carry — `agentBridge.ts`
and `hmrStaleness.ts` behind `if (__MODOKI_EDITOR__)`, `bridge.ts` behind `build.debugBuild`, and
`src/editor/consoleCapture.ts` by location. So an uncaught throw outside a React subtree, an async
failure in a system, or a rejected asset load reached nothing at all in production. `globalErrors.ts`
closes that, and it is **deliberately ungated** — the same reason analytics may not ride the event
journal, which `setJournalEnabled` switches off in a release build.

- **`console.error` → `recordError` (a non-fatal ISSUE); `console.warn` → `log` (a BREADCRUMB).**
  Two different Crashlytics concepts: an issue is grouped and alerted on, a breadcrumb is visible
  only inside somebody else's report. A game warns on ordinary paths, and promoting those to alerting
  issues buries the one report that is a real crash.
- ⚠️ **It is installed by a SIDE-EFFECT IMPORT above `./App.tsx`, not by a call.** ES imports are
  hoisted and evaluated before any statement of the importing module, so the installer written as
  `main.tsx`'s first statement still ran after App.tsx's whole module graph — leaving a top-level
  throw there uncovered, which reaches a player as a blank screen on launch reporting nothing.
  `engine/tests/architecture/errorCaptureInstallOrder.test.ts` parses the import list (a text match
  would be satisfied by the comment explaining the rule) and fails if the order moves.
- **Events raised before a game registers its services are QUEUED**, then flushed on
  `onAppServicesRegistered` — a crash during boot is the one worth most and the one a
  fire-and-forget handler loses.
- **Rate limiting, three layers, and their ORDER is load-bearing**: per-message dedupe first (it
  counts attempts), then the session cap, then the burst window — charged only for a message about
  to be sent. Charging the burst window first meant a deduped per-frame warning could exhaust it
  with attempts that never reached the SDK, and the next unrelated first-ever crash was dropped.
- ⚠️ **Both Capacitor and React `console.error` an error they are already reporting**, so one fault
  arrived as two issues until the capture learned to defer a lone-`Error` console report by a
  microtask and let the richer report claim the object first.
- The **re-entrancy latch is synchronous and a real service is async**, so what bounds the
  report-the-report bounce is the game wrapper's own once-per-message latch. Measured at two
  messages and pinned by a test.

### Deliberate native fault triggers (#278)

The sibling of the above, for everything that does **not** originate in JavaScript.
`GameDebug.triggerFault({ kind })` (`capacitor-game-debug`) raises a real `SIGSEGV` /
`EXC_BAD_ACCESS`, an uncaught Java exception, or a 15 s block of Android's main looper, exposed as
the **Faults** section of the debug menu's Device tab. The reasoning, the platform asymmetry, and
the three ways a run can report nothing while working correctly are in
[debug-menu.md](debug-menu.md) § "Faults".

Two facts belong here rather than there, because they are about the native plugin:

- **iOS had no native gate before this.** Android refuses every `GameDebugPlugin` method unless the
  manifest meta-data is on; the Swift half checked nothing, and stayed out of shipped games only
  because JS never called `startServer`. Harmless for a server nobody starts, not harmless for a
  method that kills the app — hence the `ModokiDebugBuild` Info.plist key, written both ways by
  `healNativeConfig` and read by `isDebugBuildEnabled()`.
- **The gate is deliberately NOT retrofitted onto `startServer`** in the same change. It fails
  closed, so every project would lose the iOS bridge at once, on a heal nobody has run yet.

### Android native crashes — the NDK artifact (#279)

The Android sibling of the dSYM gap, and it has the same shape: the report arrives, and it is
useless. `firebase-crashlytics` alone installs a JAVA handler, which never sees a signal — so a
genuine `SIGSEGV` produced only the `ApplicationExitInfo reason=5 (APP CRASH(NATIVE))` row
Crashlytics reconstructs on the next launch, with no stack.

`games/court/android/app/build.gradle` now carries
`com.google.firebase:firebase-crashlytics-ndk`, pinned to the same version
`@capacitor-firebase/crashlytics` resolves (they are a matched pair, and a mismatch fails at
runtime rather than at resolution — i.e. silently). Verified with #278's `crash` probe on an S22:
`libcrashlytics-handler.so` ships in the APK, and logcat goes from `convertApplicationExitInfo` to
`Minidump file exists` → `Finalizing native report for session …`. The full before/after is in
[debug-menu.md](debug-menu.md) § Faults.

Deliberately NOT enabled: `nativeSymbolUploadEnabled`. It uploads symbols for the app's own
unstripped `.so` files, and Court ships none — a crash in libc or libart is symbolicated by neither
setting. The artifact is what makes the crash REPORTED at all; symbol upload would only sharpen a
stack we do not have. Turn it on if a project ever ships its own native code.

### iOS symbolication — dSYMs (#279)

An iOS crash report without a dSYM is a list of raw addresses. Court's dashboard read **"This app
has 8 unprocessed crashes. Upload 1 dSYM file to process them."** — while a build phase named
`Upload Crashlytics dSYMs` had been sitting in its pbxproj since #275, doing nothing.

**Why it did nothing, and why that is the interesting part.** The phase gated itself on
`DEBUG_INFORMATION_FORMAT = dwarf-with-dsym` and said, in a comment, that a skip was *"expected in
Debug"*. It was — Xcode's Debug default is plain `dwarf`, which produces no dSYM at all. But **Debug
is the configuration every device build we test with uses**, including the crash probes, so the
phase was armed only in the configuration nobody debugs with. It reported its own skip correctly on
every build and nobody read the line.

`healNativeConfig` now owns both halves, for any project depending on
`@capacitor-firebase/crashlytics`:

- `DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym"` in **every** configuration — rewriting the ones
  that name `dwarf` and adding the key to the ones that omit it.
- The upload phase itself, generalized out of Court's hand-edited pbxproj (deferred from #275,
  which is why `games/3d-test` never had it). Strip-and-reinsert on every heal, so editing the
  script text updates existing projects instead of pinning them to whatever they were healed with.

**The manual tool** — `npm run upload:dsyms -- <projectDir> [--upload] [--dsym <path>]` — covers
what a build phase cannot: crashes already in the console, an `.xcarchive` from TestFlight, a dSYM
that arrived some other way.

⚠️ **It LISTS by default and uploads only on `--upload`, and that asymmetry is deliberate.** The
first version had it the other way round, with `--dry-run` to preview — and
`npm run upload:dsyms games/court --dry-run` **silently loses the flag**, because `--dry-run` is one
of npm's own options. Measured: npm echoed `node engine/scripts/upload-dsyms.mjs games/court` and
the tool uploaded for real. A safety flag the runner can swallow is worse than none, so the
destructive direction carries the word.

⚠️ **Its load-bearing detail is picking the right DerivedData.** Every Capacitor project's Xcode
project is literally named `App`, so `~/Library/Developer/Xcode/DerivedData/App-*` matches every
game on the machine — and with several clones of this repo it matches the same game several times
(measured: three `App-*` dirs whose workspace is `<clone>/games/court/ios/App/App.xcodeproj`). The
tool matches the absolute `WorkspacePath` in each candidate's `info.plist`. A newest-wins or
substring heuristic would upload a sibling clone's symbols and **fail silently**: Crashlytics
accepts them, and the crash stays unsymbolicated because the UUIDs do not match.

Two limits worth knowing:

- **The 8 already-unprocessed crashes are probably unrecoverable.** They came from builds whose
  dSYM never existed, so there is nothing to upload for those UUIDs. This fixes everything from the
  next build onward.
- **Crashlytics does not record a crash while a debugger is attached** — and on iOS ≤16 the only
  automatable launch is `idevicedebug run`, which attaches one. So verifying an iOS crash REPORT on
  the iPhone 8 needs the app started by tapping its icon; the crash TRIGGER can be verified either
  way (the plugin call and the process death are both visible over the bridge).

A worked example of a game filling the slot — including the Firebase wrapper, the Proxy-thenable
trap, the gradle/dSYM wiring and the on-device verification — is
[games/court/attribution.md](../games/court/attribution.md) § "Phase 7 — Crashlytics".

## AppLovin MAX Mediation (12 networks)

This is the **reference production pattern** (matching Word Mystery production) for wiring 12 mediation networks — Amazon, BidMachine, DT Exchange, Facebook, Google AdMob, Google Ad Manager, InMobi, Liftoff/Vungle, Moloco, Smaato, Unity Ads, Verve — **not** something any `games/<id>` currently ships: no game bundles the adapters, the SKAdNetwork IDs, or the stub podspec yet. The file paths below (`ios/App/…`, `app/build.gradle`) are the **pre-#29 repo-root-relative** layout; a self-contained game would carry the equivalents under its own `games/<id>/ios` + `games/<id>/android`.

### iOS — stub podspec pattern (SPM core + CocoaPods adapters)

The core AppLovin MAX SDK comes from SPM (`capacitor-applovin-max/Package.swift`). The mediation adapters are **CocoaPods-only** (no SPM support yet). Each adapter podspec declares `s.dependency 'AppLovinSDK'`, which would otherwise pull a duplicate SDK through CocoaPods. A **local stub podspec** at `ios/App/local_pods/AppLovinSDK/` satisfies that dependency without providing the real framework:

- Stub must set `s.static_framework = true` — otherwise CocoaPods generates a dynamic `AppLovinSDK.framework` that conflicts with the SPM one.
- Stub needs a source file (`Sources/AppLovinSDKStub.swift`) to pass CocoaPods validation.
- Use `:path =>` (development pod), not `:podspec =>`, to avoid source-download issues.
- Adapters ship as pre-compiled xcframeworks — they only need AppLovinSDK symbols at link time, which SPM provides.
- **Amazon APS** must be added as a separate pod (`AmazonPublisherServicesSDK`).
- **Moloco** ships a revoked signing certificate → `codesign --remove-signature` in `post_install`, with `ENABLE_LIBRARY_VALIDATION = NO`.

### Android — Gradle dependencies

- 12 adapter deps in `app/build.gradle` (e.g. `com.applovin.mediation:google-adapter:[24.5.0.0]`).
- Amazon requires separate `com.amazon.android:aps-sdk` + `com.iabtcf:iabtcf-decoder` deps.
- Extra Maven repos required: BidMachine (`artifactory.bidmachine.io`), Smaato (`s3.amazonaws.com/smaato-sdk-releases`), Verve (`verve.jfrog.io`), Amazon (`aws.oss.sonatype.org`).
- Google AdMob requires `com.google.android.gms.ads.APPLICATION_ID` in `AndroidManifest.xml` — the app crashes at startup without it.
- Gradle heap must be raised (e.g. `org.gradle.jvmargs=-Xmx4096m`) — 12 adapters exceed the default. (Games currently ship the stock `-Xmx1536m`, since none bundle the adapters yet.)

### SKAdNetwork

258 SKAdNetwork IDs in `ios/App/App/Info.plist` (a superset of AppLovin's official 152 —
measured 2026-08-19, the endpoint returns exactly 152).

⚠️ **`https://skadnetwork-ids.applovin.com/v1/skadnetworkids.json` is NOT a consolidated list**,
though it is easy to read as one. AppLovin states it covers **their own network only** — "this
is not the case for the other ad networks that AppLovin mediates". The other ~106 ids in the
258 come from the individual mediation adapters' own documentation. So a script that populates
`SKAdNetworkItems` from that endpoint alone produces a list that **looks complete and silently
omits every mediated network** — the ads still serve, and the attribution for those networks
just never arrives.

## Debug Bridge & MCP

`capacitor-game-debug` runs a TCP server (default port 9095) on the device, paired with the `game-debug` MCP server so Claude Code can screenshot, tap, drag, eval JS, and read logs on physical devices.

| Feature | iOS | Android |
|---|---|---|
| Transport | NWListener (TCP), manual IP (no Bonjour) | ServerSocket (TCP) over `adb forward tcp:9095` (USB) |
| Screenshot | `captureScreen` via `drawHierarchy` (captures WebGL) | `adb screencap` |
| Tap/Drag | PixiJS EventSystem calls | PixiJS EventSystem calls |
| Native logs | OSLogStore (iOS 15+) | logcat |
| Debug gate | `modoki:game-debug-*` fenced registration in `MyViewController.swift` | `com.modokiengine.gamedebug.DEBUG_BUILD` manifest `<meta-data>` |

**Both gates are written from the ONE project flag `build.debugBuild`** (Project Settings →
Developer) by `healNativeConfig`, not from the Xcode/Gradle configuration (#112) — so
`debugBuild: true` + a Release configuration is a *working* debug build, which is what a TestFlight
QA build is. Reopen the project after flipping the flag so the heal runs. Absent Android meta-data
reads as false. Detail:
[debug-tools-mcp.md](./debug-tools-mcp.md) § "Native Debug Bridge" (the "Debug vs Release — ONE flag decides" note).

### MCP tools

The MCP server at `engine/tools/game-debug-mcp/` is a **thin client** of Modoki's device lease — every tool
proxies through the editor backend's `/api/device/request`. Full device tool catalog:
[debug-tools-mcp.md](./debug-tools-mcp.md).

**Connection is a deliberate, Modoki-owned lease** — the human clicks *Connect a Device* in the
editor's AI panel (IP or adb); the backend holds one socket + the lease GUID (which never leaves the
backend) per clone. No `target` param, no Bonjour, no auto-connect. **Coordinates:** take a
`device_screenshot`, then pass its pixel coordinates to `device_tap`/`device_drag`. The device TCP
server accepts only **one client** (first wins).

Connection setup + full guide: `engine/tools/game-debug-mcp/CONNECTION.md`; lease design:
`docs/debug-tools-mcp.md`.

**Lease parity harness (golden vectors).** The device-side lease arbiter is hand-ported from the TS
`DeviceLeaseAuthority` (`engine/plugins/backend/deviceLease.ts`) into Swift + Java, so it can drift.
`capacitor-game-debug/test-vectors/lease-golden-vectors.json` is one shared contract (grant / busy /
resume-in-grace / expiry+takeover / not-owner / non-owner-drop-doesn't-re-arm) that
`engine/tests/plugins/deviceLeaseGoldenVectors.test.ts` pins the TS authority to, and the
`LeaseCoreTests.swift` / `LeaseCoreTest.java` templates replay against a pure `LeaseCore` port.
**Both native replays now RUN** (#376) — before that neither ever had, and the Swift one's fixture
path was off by one directory, which is what an unrunnable test cannot tell you. They are wired to
`npm run test:native` (`engine/scripts/test-native.mjs`), an **on-demand** gate: `npm run verify` is
vitest and can run neither XCTest nor gradle, so their silence there is deliberate and each file's
header says so.

| replay | runner |
|---|---|
| `engine/tests/plugins/deviceLeaseGoldenVectors.test.ts` | vitest — in `npm run verify` |
| `LeaseCoreTests.swift` | `swift test --package-path` the standalone `capacitor-game-debug/ios/Tests/Package.swift` |
| `LeaseCoreTest.java` | gradle on `capacitor-game-debug/android/test-harness` (plain JVM — no AGP, no SDK, no emulator) |

Both harnesses live **outside** the plugin's packed fileset on purpose, so adding them did not move
the content hash or force a re-vendor. The iOS one is a separate package rather than a `testTarget`
in the plugin's `Package.swift` because that package is iOS-only and pulls in capacitor-swift-pm —
`swift test` cannot run it from a terminal at all — and because `ios/Tests/` is unshipped, so a
`testTarget` in the shipped manifest would name a path the vendored tarball does not contain.

⚠️ **A green native run proves the PORTS agree with the vectors, not the plugin.** `LeaseCore` still
lives inside each test file while `GameDebugPlugin` keeps its own lease state behind a platform timer
(`DispatchWorkItem` / `Handler.postDelayed`). **Follow-up:** extract `LeaseCore` into the shipping
sources and have `evaluateLease`/`startLeaseGrace` delegate to it, which also lets the native grace
drop its timer for the spec's timer-free lazy expiry — a behavioural native change, so it needs
device verification, and #376 deliberately stopped short of it.

## Heal-on-open & project deps

Opening a project in the Electron editor runs two idempotent "make it just work" passes so a fresh clone/worktree builds and debugs without a manual checklist. Both run on **every** open (launch AND Open Project) from `engine/electron/main.ts`; the native heal is dep-independent and runs **first**, `ensureProjectDeps` second.

### Native-config heal (`engine/plugins/healNativeConfig.ts`)

`healNativeConfig(projectRoot)` is deterministic + idempotent — it writes only when something is missing or detectably wrong, never clobbering hand edits. It heals the machine-local / derivable bits that a fresh `cap add` (or a fresh clone) leaves missing:

- **`android/local.properties`** → `sdk.dir` (gitignored, machine-specific; without it Gradle fails "SDK location not found"). Discovered from `$ANDROID_HOME`/`$ANDROID_SDK_ROOT` then the common install dirs.
- **iOS `DEVELOPMENT_TEAM`** → written from `build.appleTeamId` into a **gitignored `ios/modoki.local.xcconfig`**, and **stripped out of the tracked pbxproj**, so an owner-private value never reaches git (the source value lives in the gitignored `project.user.json` — [engine-oss-publishing.md](./engine-oss-publishing.md) § "Private build fields", which carries the full rationale and the measurements). Debug picks it up via an optional `#include?` appended to Capacitor's own `ios/debug.xcconfig`; **Release needs its own tracked `ios/modoki.xcconfig` wrapper**, because Capacitor attaches `debug.xcconfig` to the Debug configs only and would otherwise leave the shipping configuration unsigned. Still scoped to the **App target's** build configs only (via `appBuildConfigUUIDs` — never touches a separate extension/widget/watch target's team). Removal is deliberate rather than blanking: a target's `buildSettings` beat its `baseConfigurationReference`, so a leftover `DEVELOPMENT_TEAM = "";` would shadow the include.

  <a id="cocoapods-and-the-team-id-xcconfig"></a>
  ⚠️ **CocoaPods and the Team ID xcconfig.** `pod install` reassigns each configuration's `baseConfigurationReference` to the generated Pods xcconfig, which would orphan `modoki.xcconfig` and silently drop the team from Release builds. No project here has a Podfile today. A project that gains CocoaPods adapters (see [AppLovin mediation](#applovin-max-mediation-adapters), the one pattern that needs them) must add `#include? "modoki.local.xcconfig"` to the Pods xcconfig instead — and the tell is a signing failure that appears only in Release.
- **iOS orientation + status bar** and **Android `screenOrientation`** → patched into `Info.plist` / `AndroidManifest.xml` to match `capacitor.orientation` / status-bar settings.
- **Android immersive fullscreen** → when `capacitor.statusBarHidden` is set, a marker-fenced block is patched into **`MainActivity.java`** hiding `systemBars()` via `WindowInsetsControllerCompat`, re-applied in `onWindowFocusChanged`. Three things about this are load-bearing. It hides **both** bars (status *and* navigation) even though the flag is named for the status bar: iOS has no second bar, so `statusBarHidden` there already means "the game owns the screen", and leaving Android's nav bar up would honour the name while missing the intent. It has to be **Java, not a theme** — `android:windowFullscreen` reaches the status bar only. And it must re-apply on focus regain, because the bars return after a notification shade / permission dialog / task switch, so hiding once in `onCreate` silently decays. A MainActivity with custom code (non-empty class body, no marker) is left alone and reported rather than rewritten; clearing the flag removes the block and its imports.

  ⚠️ **A fourth thing, and it is the one that shipped broken: the block must also set
  `layoutInDisplayCutoutMode = SHORT_EDGES`.** `WindowCompat.setDecorFitsSystemWindows(false)`
  opts out of fitting the system **bars** and says nothing about the display cutout, so without
  it the window is laid out BENEATH the cutout — measured on a Galaxy A23 as a frame of
  `[0,59][720,1560]` inside a 1560px display. With the bars hidden nothing draws in that strip,
  so the window background shows through as a **59px black band**. The same fact also makes
  `env(safe-area-inset-*)` report `0` on Android, because a window that never reaches the cutout
  has no inset to tell CSS about — which is how "Android has no safe-area insets" briefly got
  recorded as a platform fact instead of a symptom. With the flag: frame `[0,0][720,1560]`, no
  band, and `env()` reports the real cutout (28dp on an A23, 27dp on an S22).
- **game-debug wiring** (only when the project depends on `capacitor-game-debug`): adds the `NSLocalNetworkUsageDescription` + `NSBonjourServices` Info.plist keys (iOS 14+ gates the device's inbound-LAN TCP listener behind the **Local Network permission**, prompted via these keys). *(`NSBonjourServices` predates the Bonjour removal and is likely now vestigial — the lease connects by direct IP, no mDNS — but it hasn't been re-verified on-device, so it's left in for now.)* Also writes `MyViewController.swift` + points the storyboard's bridge VC at it + adds the pbxproj file-refs that compile `MyViewController.swift` and the engine's `GameDebugPlugin.swift` into the App target (the SPM static-linking workaround — see the [iOS SPM static-linking gotcha](#ios-spm-static-linking-gotcha)). The Local Network keys and the plugin registration both track `build.debugBuild` **in both directions** — flip it off and the next heal removes them, so an App Store build ships without a Local Network prompt. (Pre-#112 the keys were added unconditionally and stripped from the BUILT plist by a `CONFIGURATION == Release` build phase; that phase is retired, and the heal deletes it from any project that still carries it.)

It is called explicitly on open — **not** buried inside `ensureProjectDeps` — so it runs even for a flat game with native folders but no `package.json`, can't be silently skipped by a dep-install refactor, and always logs (a "already up to date" line included).

### Dep + engine-plugin heal (`ensureProjectDeps` in `main.ts`)

`ensureProjectDeps(projectRoot)` makes "Open Project" work for a project opened from **outside** the repo (or an in-repo game never installed). The repo root install only links in-repo game workspaces via `bootstrap-game-deps.mjs`; a standalone project needs its own `npm install` to create `node_modules` + workspace symlinks (e.g. `@<game>/app-services`), else Vite 500s on the unresolved import. It also **vendors engine-provided Capacitor plugins** (`capacitor-game-debug`, …) into the project as tarball COPIES packed from the editor's own engine (no symlink → DMG-safe), which can rewrite `package.json` (migrating off the old `file:../../engine` dir-symlink) and regenerate the gitignored tarball. It reinstalls when `node_modules` is absent, the vendored plugin copies are stale, or one of the project's OWN `workspaces` packages (a game's own native plugin, e.g. `capacitor-applovin-max`) has no symlink inside an otherwise-present `node_modules` (`hasStaleWorkspaceLink`, `projectDeps.ts` — porting `bootstrap-game-deps.mjs`'s "don't trust node_modules existing" posture into this on-open heal), then also runs the project's `build:plugins` script if it declares one (non-fatally) — an install alone only restores the symlink, not a game-owned plugin's gitignored `dist/`. Prefers `npm ci` unless vendoring just rewrote `package.json` (then `npm install`, since the lockfile is behind). Skips the editor's own tree and projects with nothing to install.

### Pinned transitive deps — `overrides` for a vulnerability upstream won't fix

When a security alert lands on a **transitive** dep that no upstream release will clear, the fix is
an npm `overrides` entry in the owning project's `package.json`. Two live cases:

| Pin | Where | Pulled in by |
|---|---|---|
| `"uuid": "^11.1.1"` | every project that depends on `@capacitor/cli` — all of `games/*`, `demos/*`, and the repo root | `@capacitor/cli` → `xcode` → `uuid@^7.0.3` |
| `"nanoid": "^3.3.17"` | the repo root and `site/` | `vite`/`vitest`/`@vitejs/plugin-react`/`@vitest/coverage-v8` (root) and `vitepress` (site), each → `postcss` → `nanoid@^3.3.16` |

**Add the pin as soon as the project exists, not when the alert fires.** Both of these were caught
by Dependabot *failing*, not by anyone noticing the gap: a `security_update_not_possible` job exits
1, so the workflow goes red and reads like broken tooling rather than "your tree needs an override".
Seven projects (`games/{skin-test,space-console,llm-test,text_demo,timeline-demo}`,
`demos/{forest-camp,particle-demo}`) were missing the `uuid` pin while this section claimed every
project had it — the drift was invisible because the doc asserted the invariant instead of the
re-check command below proving it (#177).

#### `uuid`

It is **not** a dep these projects use — it exists to pin a transitive one, and in most of them it
is currently **inert**.

`@capacitor/cli` **8.5.0** added a dependency on `xcode@^3.0.1`, which depends on `uuid@^7.0.3` —
vulnerable (GitHub Dependabot, medium; fixed in 11.1.1). Upstream will not resolve it: `xcode@latest`
still pins `uuid ^7`. The `xcode` dep did not exist in 8.4.x, so only projects whose lockfile has
floated to 8.5.0 actually resolve `uuid` today; the rest inherit it the moment their lockfile is
refreshed, since they all declare a floating `^8.x` range. The override is applied everywhere so
that refresh is a non-event rather than a new alert.

Safe because `xcode` calls `require('uuid').v4()` and takes the string result
(`pbxProject.generateUuid`); `uuid@11` still ships a CJS build, and the call site uses no removed
API. Adding an override that matches nothing in the tree does **not** desync `npm ci`
(npm does not record `overrides` in the lockfile root), so the inert copies cost no lockfile churn.

#### `nanoid`

`postcss@8.5.25` requires `nanoid@^3.3.16`, and 3.3.16 is vulnerable (high — a custom generator can
loop forever when `size` is 0; fixed in 3.3.17). `^3.3.17` satisfies postcss's own range, so the pin
is a straight resolution bump with no peer risk. Dependabot could not do it itself: at the root the
only top-level owners are the test/build toolchain, and in `site/` the sole path npm found was
**downgrading vitepress 1.6.4 → 0.22.4**, which it correctly refused.

#### Re-checking the set

Do this rather than trusting the table — that is the lesson of #177. Every lockfile at once:

```bash
for f in $(git ls-files '*package-lock.json'); do
  node -e 'const j=require("./"+process.argv[1]);
    for (const [k,v] of Object.entries(j.packages||{})) {
      const n=k.split("node_modules/").pop();
      if (n==="uuid"   && v.version && parseInt(v.version) < 11) console.log(process.argv[1], k, v.version);
      if (n==="nanoid" && /^3\.3\.(?:[0-9]|1[0-6])$/.test(v.version||"")) console.log(process.argv[1], k, v.version);
    }' "$f"
done
```

Silence is a pass. Per project, `npm ls uuid` / `npm ls nanoid` answers the same question. After
adding a pin, refresh the lock with `npm install --package-lock-only --ignore-scripts` — it rewrites
only the affected entry (measured: 3 lines per lockfile).

Full build/deploy commands live in [build.md](./build.md) and the project `CLAUDE.md`.

## App Identity & Build

**Per-game identity (#29).** There is no single shared app identity — each flat project
owns its own `appId`/`appName` in `games/<id>/project.config.json` + `capacitor.config.json`,
and its OWN `games/<id>/ios` + `games/<id>/android` native folders. Examples:

| Project | Bundle ID | App Name |
|---|---|---|
| `3d-test` | `com.modokiengine.tropicalisland` | Tropical Island |
| `alien-animal` | `com.modokiengine.alienanimal` | Alien Animal |

**Per-game signing (#29).** Each game sets its OWN **Apple Team ID** at the `build.appleTeamId`
key path, whose value lives in the gitignored `games/<id>/project.user.json`
([engine-oss-publishing.md](./engine-oss-publishing.md) § "Private build fields") — empty on games
not yet signed, e.g. `particle`,
`skin-test`, `text_demo`); healed into the iOS project's `DEVELOPMENT_TEAM` on open + before
each build, then Xcode auto-signs (`-allowProvisioningUpdates`). The signed-in games happen to
share a single Team ID, but the mechanism is per-game. (The old single
`com.modokiengine.prototype` / "Puzzle Prototype" / App Store ID `6761316443` was the
pre-#29 identity, retained only for historical reference.)

The full, authoritative build/deploy commands live in the project `CLAUDE.md` (**Build &
Deploy** section). Builds are steered by `MODOKI_PROJECT=games/<id>` (web compile runs at
the repo root → `games/<id>/dist`; `cap sync` + the native build run **from the project
dir**, where its config + native folders live). Essentials:

**Web**
```bash
MODOKI_PROJECT=games/<id> npm run build -- --target web     # TypeScript check + Vite build → games/<id>/dist
```

**iOS (Simulator or Device)**
```bash
MODOKI_PROJECT=games/<id> npm run build -- --target native
(cd games/<id> && npx cap sync ios)
# SPM-only game (e.g. 3d-test, Firebase via SPM) → build -project App.xcodeproj.
# A game pulling CocoaPods mediation adapters gets App.xcworkspace → build -workspace.
# Device builds use -allowProvisioningUpdates for auto-signing.
```
Notes: first build is slow (SPM downloads all SDK frameworks); use exact device IDs in `-destination`; if SPM errors with "already exists in file system", clear `~/Library/Caches/org.swift.swiftpm/artifacts/*`. First device install requires trusting the developer profile (Settings → General → VPN & Device Management → Trust).

**Android**
```bash
MODOKI_PROJECT=games/<id> npm run build -- --target native
(cd games/<id> && npx cap sync android)
eval "$(node engine/scripts/print-toolchain-env.mjs)"   # JAVA_HOME + ANDROID_HOME, resolved as the editor does
games/<id>/android/gradlew -p games/<id>/android assembleDebug
adb install games/<id>/android/app/build/outputs/apk/debug/app-debug.apk
```
Notes: requires **JDK 21** (Capacitor 8 / AGP); Gradle heap is the stock **`-Xmx1536m`** (raise it, e.g. to 4GB, only when a game bundles the 12 mediation adapters); the device must show as `device` (not `unauthorized`) in `adb devices`. A game with no `ios/`/`android/` yet must scaffold it first (`cd games/<id> && npx cap add ios|android`).
