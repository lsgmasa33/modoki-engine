# Trusted device input (`device_*` input fidelity)

**Issue #32, landed and hardware-verified on both platforms.** This is the feature doc that
replaced `docs/plans/trusted-device-input-plan.md` when the work landed.

`device_tap` / `device_drag` and friends used to dispatch **synthetic DOM events** — events the page
can tell apart from a real finger (`isTrusted: false`), which anything gated on `isTrusted` ignores
outright. The editor twins (`modoki_tap` …) never had that problem: Electron's
`webContents.sendInputEvent` is real OS-level injection. This closes the gap on device.

A page **cannot dispatch a trusted event to itself**, so injection has to happen HOST-SIDE. But only
the page can resolve an aim (a CSS selector, an entity, screenshot pixels → CSS point). That split
is the architecture: the host asks the page `resolve-aim`, then injects at the returned coordinates
over a platform-specific channel.

## What is actually trusted — per op, per platform

| Op | Android | iOS |
|---|---|---|
| `device_tap`, `device_drag` | **`trusted-cdp`** when a CDP session is reachable | **`trusted-wda`** when WebDriverAgent is reachable |
| `device_press_key`, `device_hover`, `device_scroll` | **`trusted-cdp`** when reachable | `synthetic` — **by design** (below) |
| `device_pointer`, `device_type_text` | `synthetic` | `synthetic` |

**Ask, don't assume**: `device_status` live-probes the WHOLE chain and reports the mechanism plus
`trustedOps`. Every reply also carries its own marker (` [input:trusted-cdp]` / ` [input:trusted-wda]`
/ ` [input:synthetic]`).

### Why iOS routes only tap and drag

Not an unfinished phase — three measured limits, and the owner's call (2026-08-02) was that keeping
these working *synthetically* beats stamping `trusted` on something weaker or dead:

- **`press_key`** — WDA accepts it and it *is* trusted, but reaches only a **focused** element.
  Measured: with the game canvas focused WDA answered `ok` and the page received **nothing**; with an
  `<input>` focused the same call delivered trusted `keydown`s and the field read `"hi"`. Routing it
  would silently break agent workflows that use it for debug-menu shortcuts.
- **`scroll`** — WDA rejects a `wheel` action outright: *"Only actions of '(pointer, key)' types are
  supported."* A trusted scroll could only be a touch **drag**, which on a game canvas is a real
  gameplay gesture (on `games/sling` it flings the puck).
- **`hover`** — a touchscreen has no hover state to deliver.

## The fallback is allowed, but never quiet

Synthetic remains the fallback (device testing must keep working everywhere), fronted by a LOUD
banner naming the cause and the consequence. It is a **prefix**, not a suffix: the older trailing
` [input:synthetic]` marker sat at the end of a long reply and was too easy to skim past — which is
exactly how an agent ends up believing a fidelity-sensitive check passed on a weaker mechanism.

Deliberately NOT following #15's precedent (an occluded aim is a refusal): an occluded aim cannot
deliver the input at all, whereas a synthetic fallback **can** — it is just weaker. So deliver it and
say so.

## The three channels

| | Android | iOS |
|---|---|---|
| Module | `engine/plugins/backend/deviceCdp.ts` | `engine/plugins/backend/deviceWda.ts` |
| Transport | CDP `Input.dispatchTouchEvent` over `adb forward` to the WebView's devtools socket | WebDriverAgent W3C Actions, `POST /session/{id}/actions`, over Wi-Fi `:8100` |
| Needs | adb + a debuggable WebView (true for this repo's debug builds) | WDA provisioned (Build Support) + launched |

Shared by both: **`deviceAim.ts`** — the aim decode, the failure meanings, and the `RouteOutcome`
shape. It is one module on purpose; see "the seam that killed Phase 1" below.

The router (`editorBackendRouter.ts`, `/api/device/request`) tries **CDP → WDA → synthetic**, and
fronts the synthetic reply with the banner when a trusted route was possible in principle.

### Failure handling differs, deliberately

- **CDP**: a gesture is several sends. A failure *after* one landed leaves a finger DOWN, so falling
  back would deliver a second complete gesture on top of a stuck one. It **refuses** and says the
  device may be mid-touch.
- **WDA**: a gesture is ONE actions call, and W3C defines `DELETE /actions` to release stuck
  pointers. So it releases, then **allows** the synthetic fallback — the user still gets their input.

## WebDriverAgent lifecycle

**Provisioned** (`engine/toolchain/wdaProvision.ts`) and **running** (`wdaLauncher.ts`) are different
states, because WDA's HTTP server exists only while its `xcodebuild test-without-building` process
does. Provisioning is a Build Support item — see
[docs/editor-toolchain.md](editor-toolchain.md) § "WebDriverAgent — the one BUILT tool" for the
build, the per-machine signing, and the expiry rule.

- **Lazy launch** — the FIRST iOS input op starts the agent (~6s cold, ~0.6s once cached).
  `device_status` deliberately does **not**: a status read must not start a 30-second agent.
- **Torn down with the lease** — one lease owns both channels, so there is exactly one answer to
  "who holds this device", and disconnecting can never strand a signed agent on the phone. Losing WDA
  **degrades input; it does not drop the lease** — screenshots and Percept reads keep working.
- **One-time config on a Mac with several paired iPhones**: set `MODOKI_IOS_DEVICE_UDID`. Auto-launch
  refuses to guess which phone to run a signed agent on.
- **STARTING one is macOS-only** (it is an `xcodebuild` run, matching
  `isInstallable('webdriveragent')`). **USING one is not**: the agent answers over the LAN, so a
  Windows/Linux editor can drive an agent a Mac started — which is why the reachability probe runs
  before the platform check.

## WDA also captures the screen — the out-of-app screenshot (#102)

The iOS **native** capture (`GameDebug.captureScreen`, the default path) is faithful, but it is the
**app's own** capture, so it can only ever show the app. A system permission/ATT prompt is a
different window: the native capture returns the app *underneath* it, which reads as a perfectly
good screenshot of the wrong thing. Same for springboard after a background or a crash.

`device_screenshot {source:'wda'}` takes `GET /session/{id}/screenshot` instead — the whole device
screen. Two triggers, because each covers what the other misses:

- **explicit `source:'wda'`** — the only way to reach the dialog case, since that case does not make
  the native capture *fail*. Pays the lazy agent launch if WDA is not up yet (**measured: ~28s
  cold**, on a Mac with the agent provisioned).
- **automatic fallback** when the native capture fails — *either* way it can fail: the device answers
  an error string, **or** the lease is gone and the proxy throws. Deliberately does **not**
  auto-launch: a screenshot that silently costs a ~30s spin-up because the app died is worse than one
  that says why it could not help. The reply then carries `nativeCaptureFailed`; if WDA is unreachable
  too, the NATIVE error is returned (it is what the caller asked for) with `wdaFallbackUnavailable`.

**It is gated on having the device's ADDRESS, not on the lease being `connected`** — and that
distinction is the whole feature. Measured on the iPhone Air (2026-08-03): **pressing home SUSPENDS
the app, so the lease drops to `reconnecting` and the native capture 502s** — which is exactly when
the springboard picture is wanted. WDA needs no lease at all (it answers host-side on `:8100`), and
`target` is retained while reconnecting, so the capture still works. A first revision gated on
`state === 'connected'` and therefore refused the feature in its motivating case; **only a live run
could show that**, which is why this route is not unit-tests-only. Deliberately NOT falling back to
`lastTarget`: that survives an explicit `disconnect`, and reaching for a device the user has
*released* is a different act from photographing one whose app is merely suspended.

Verified end-to-end on the iPhone Air against `games/sling` (2026-08-03): the app-foreground capture
came back **1260×2736** — the full device screen — against the native path's **600×1303** page
capture of the same moment, and with the app backgrounded it returned the springboard while
`device_screenshot` with no `source` 502'd.

⚠️ **Its pixels are DEVICE-SCREEN coordinates, not page coordinates.** Screenshot pixels are an aim
space — `device_tap {x,y}` scales through the mapping a *native* capture establishes — and a WDA
image includes the status bar and any system UI. So every WDA capture carries a loud coordinate
warning **and** drops the "use these pixel coordinates for device_tap" hint the native path prints.
Aim by `selector`/`entity`, or take a normal capture first. A tap aimed off a WDA image would be
wrong in the quiet, plausible way this whole document exists to prevent.

## Measured facts — do not re-derive these

Each was established on hardware, and several contradict the obvious implementation.

- **The coordinate transform is IDENTITY on both platforms.** Android: `css(180,353)` → `clientX:180,
  clientY:353` on a 360×705 dpr:3 viewport. iOS: `(210,473)` → `clientX:210, clientY:473` on 420×912
  dpr:3. No DPR, safe-area or letterbox math. **Do not add one.**
- **WDA reaches the device over Wi-Fi on `:8100`.** No libimobiledevice, `iproxy` or Appium —
  `devicectl` has no port-forward subcommand, but WDA binds `0.0.0.0`, so the LAN address the lease
  already uses works.
- **WDA input is W3C Actions.** The legacy `/wda/tap/0` every older guide names is gone.
- **WDA supports only `pointer` and `key` action types** — `wheel` is rejected.
- **WDA interpolates a drag itself**: one durated `pointerMove` produced 14 trusted intermediate
  `pointermove`s, finer than the synthetic path's manual stepping.
- **A WDA session with NO `bundleId` does not restart the app.** Passing one ACTIVATES the app, which
  restarts it and rebinds the debug bridge's port out from under the lease.

## Traps that produce a confident wrong answer

Every one of these looked like success:

- **A wrong WDA endpoint returns HTTP 200 with the error in the BODY.** `res.ok` is not evidence —
  decode every reply. This cost three no-op taps before the body was read.
- **WDA silently CLAMPS out-of-viewport coordinates** rather than erroring (a drag aimed off-screen
  landed at 86,795).
- **`devicectl --json-output /dev/stdout` never parses** — devicectl writes its human-readable table
  to stdout too, so the JSON is interleaved. It presents as *"no iOS device is connected"* with the
  phone sitting right there. Write to a real file.
- **Filtering devices on `tunnelState === 'connected'` is TOO STRICT.** `xcodebuild` launched WDA fine
  on a device reporting `disconnected` — it opens its own connection. Tunnel state is a tie-breaker,
  not a gate.
- **The seam that killed Phase 1.** The device transport returns JSON **strings**; the routing tests
  mocked `proxy` returning an **object**. `'error' in aim` then ran `in` on a primitive, which THROWS,
  so every trusted dispatch fell into the catch and silently fell back to synthetic. `device_status`
  claimed `trusted-cdp` while every tap came back `[input:synthetic]` — unit-green, dead in
  production. Hence `decodeAimReply` lives in ONE module with WIRE SHAPE tests, and **any test that
  fakes `proxy` must return a string.**
- **A half-chain probe lies.** `device_status` originally checked only for a CDP session, not whether
  the app could answer `resolve-aim` — so it announced a fidelity the next call would not deliver.
  Both probes now round-trip the whole chain.
- **Consistent literals are not consistent REPORTING.** The backend answered `trusted-wda` while
  `device_status` printed "synthetic", because the MCP knew only two literals and fell through its
  else-branch. `deviceInputMechanismParity.test.ts` now asserts each mechanism is *used*, not just
  declared.

## Verifying a change here

Unit tests cover routing, refusal and mechanism selection; **the injection itself can only be
validated on hardware** — say so rather than faking coverage.

```bash
# Android: adb + a debug build, then a device_tap should report [input:trusted-cdp]
# iOS: WDA provisioned via Build Support; the first tap launches it
MODOKI_BACKEND=http://127.0.0.1:<port> npm run test:mcp:live   # after touching engine/tools/** or /api/*
```

The honest check for any claim here is the one this whole feature is about: **did you observe it, or
infer it?** Three separate defects in this work were invisible to a green suite and appeared only on
a phone.

## Non-goals

- iOS Simulator support (the device lease is built around a physical target).
- `device_pointer` / `device_type_text` trusted routing — issue #31 territory, synthetic by
  construction.
