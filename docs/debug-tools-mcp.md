# Debug Tools (MCP) — the agent-facing debug surface

The full reference for the MCP servers an agent uses to see and drive Modoki: the
device bridge (`game-debug`), the Electron editor bridge (`modoki`), the Chrome fast
loop, and the dev-server `curl` API. `CLAUDE.md`'s "Debug Tools" section is the
in-context summary; this is the detail.

Companion design docs: [enact.md](./enact.md) (the
Enact trusted-input layer), [mcp-response-budget.md](./mcp-response-budget.md) (the
response-budget design), [connect-claude-code.md](./connect-claude-code.md).

## Device debugging (device MCP + Modoki lease)

Device debugging is a **deliberate, Modoki-owned lease**, NOT auto-discovery. The human clicks
**Connect a Device** in the editor's AI panel (types the IP shown in the game's debug menu → Device
tab, or checks *Use adb (USB)* for Android); the editor backend holds one TCP socket to the device,
mints + holds a lease GUID (`.modoki/device-guid`), pings, and auto-reconnects across game relaunches
(5s grace). One backend per clone → **one device per clone**. Full guide + connection diagram:
[`engine/tools/game-debug-mcp/CONNECTION.md`](../engine/tools/game-debug-mcp/CONNECTION.md).

The `game-debug` MCP (`engine/tools/game-debug-mcp/`) is a **thin client**: every `device_*` tool
`POST`s to its clone's `MODOKI_BACKEND /api/device/request {method,params}`, which forwards over the
held socket. **The GUID never leaves the backend** (controlled comms). The MCP owns no connection —
no Bonjour, no adb, no discovery. There is **no `target` param** and no platform in the tool name;
the lease already picks the single device. Opening the lease is **deliberate** — the human clicks
*Connect a Device* in the AI panel, or an agent calls **`device_connect`** (`ip=` / `useAdb:true`, or
bare to reconnect the last target) — NOT the removed Bonjour auto-connect, and the lease is first-wins
so an explicit connect can't storm a device another editor holds. If nothing is connected, the
data-plane tools error and point at `device_connect`.

The device surface is **full Percept + Enact parity with the editor**, not just eval + screenshot.
Grouped:

- **Utility:** `device_status` (lease state / how to connect — call it when a tool errors) ·
  `device_connect` (open the lease — `ip`/`useAdb`, or bare to reconnect the last target) ·
  `device_disconnect` · `device_eval` (compact, size-capped JSON; survives a circular result;
  `code` sees an injected `modoki` scripting object — the live agent-op registry, generated per op)
  · `device_eval_api` (discovery: what that object exposes — **and what it does not**) ·
  `device_screenshot` ·
  `device_console_logs` · `device_native_logs` (both default `limit:50`; see "Two sources of
  native logs" below) · `device_crash_reports` (iOS crash + jetsam reports — the only surface that
  explains a death that already happened).
- **Percept (read-by-data):** `device_get_scene_state` · `device_diagnose` · `device_journal` ·
  `device_resolve_refs` · `device_introspect` · `device_game_tools` (what TOOLS the connected
  game registers — [agent-tools.md](agent-tools.md); invoke one with `device_game_tool_call`) ·
  `device_layout_bounds` · `device_watch` ·
  `device_profiler` (where did the frame go — the phone is the only place that question is real;
  `action:'boot'` answers the different question "where did the BOOT go", reading the always-on
  boot-phase timeline against the worst dropped frame — see
  [profiler.md](plans/profiler.md) § Phase 2) ·
  `device_handles`.
- **Authoring (live-world WRITES, #166):** `device_mutate_scene` (set trait fields over a
  `where` filter / `guid[]` / `name` / `id` — `dryRun` first if the selector is broad) ·
  `device_create_entity` · `device_duplicate_entity` (**includes descendants**, `count` up to 1000 —
  the "spawn N more and watch the frame" experiment) · `device_delete_entities` ·
  `device_load_scene` (swap level, no rebuild) · `device_set_timescale` (0 = pause) ·
  `device_step` (advance a PAUSED world N frames, then re-freeze) · `device_invalidate_assets` ·
  `device_read_asset_def` (what the RUNNING build resolved — not what the file on your disk says;
  peeks the live cache, never fetches).
  ⚠️ **Put a frame boundary between a write and a renderer read.** `diagnose`'s renderer stats
  (`calls`/`triangles`) describe the LAST RENDERED frame, so reading them in the same `device_eval`
  body as the mutation reports the PRE-mutation numbers — measured: restoring 114 renderables and
  reading in the same body returned the old `calls:4`, which reads exactly like a failed write.
  `device_step` is that boundary; a separate call also works.

  **All of it is live-world only** — a device has no project on disk, there is no undo stack, and a
  relaunch is the undo. Every reply says so rather than leaving persistence unstated. `device_step`
  advances REAL frames (~16-33ms each), not a fixed dt: a measurement aid, not a deterministic
  repro. Why these exist, and the registration rule that keeps the two surfaces at parity: [mcp-tool-conventions.md](mcp-tool-conventions.md) §9.
- **Enact (input):** `device_tap` · `device_drag` · `device_pointer` (sustained/HELD
  press, split into down/move/up — the stateful twin of `device_drag`) · `device_dispatch_action` ·
  `device_press_key` · `device_hover` · `device_scroll` · `device_type_text`.
  **Input fidelity is now PER PLATFORM AND PER OP (#32 Phases 1–2) — check, do not assume.** On
  **Android**, `tap`/`drag`/`press_key`/`hover`/`scroll` are delivered as REAL trusted input
  (`isTrusted: true`) by injecting host-side over the WebView's CDP socket; replies say
  ` [input:trusted-cdp]`. On **iOS**, `tap` and `drag` are trusted via WebDriverAgent
  (` [input:trusted-wda]`) — **but only those two**: WDA has no `wheel` action, a touchscreen has no
  hover, and a trusted key reaches only a focused element, so `press_key`/`hover`/`scroll` stay
  synthetic there by design. WDA is a Build Support item and starts **lazily on the first iOS input
  op** (~6s), then is torn down with the lease. When no trusted route exists, ops fall back to a
  SYNTHETIC DOM event —
  and that fallback is **loud**: the reply is fronted by a banner naming the cause and its
  consequences, because a trailing ` [input:synthetic]` on a long line is too easy to skim past.
  `device_pointer` and `device_type_text` are NOT routed in Phase 1 and stay synthetic on every
  platform — they carry the same banner, since a `tap` coming back trusted on the same device makes
  silence there actively misleading. `device_status` live-probes the mechanism (the WHOLE chain: a
  CDP session AND an app build that answers `resolve-aim`), so you can ask before you act. Detail:
  [docs/enact.md](enact.md) § input fidelity; iOS is `docs/trusted-device-input.md`
  Phase 2 (#32).

  **Synthetic input: which canvas gets it** (#93). A synthetic canvas dispatch has to CHOOSE a
  target element — a trusted injection does not, because the browser hit-tests for it. That choice
  used to be `document.querySelector('canvas')`, i.e. the first canvas in the document regardless of
  the aim. Measured on `games/3d-test` (full-screen Three.js canvas at index 0, a 200x300 PixiJS
  canvas at index 1): an aim at (130,503), inside the Pixi canvas, was dispatched on canvas 0 — and
  the reply still said `ok` with the right coordinates, so it read as a hit. Any project layering 2D
  over 3D was affected, and only on the synthetic path.
  It now hit-tests, and **says how it chose** in the reply so a guess cannot pass for a hit:

  | marker | meaning |
  |---|---|
  | `canvas:hit` | `elementFromPoint` landed on a canvas. The honest answer. |
  | `canvas:only` | not over a canvas, but the document has exactly one — nothing to disambiguate. |
  | `canvas:contains` | an overlay won the hit-test; fell back to the topmost canvas whose rect contains the point. |
  | `canvas:ambiguous` | several canvases, the point in none. Picks the first — **this one is a guess.** |

  A gesture (`device_drag`, and `device_pointer`'s down→move→up) picks the canvas ONCE at the grab
  point and keeps it for the whole sequence, mirroring pointer capture: a drag that leaves the
  canvas still delivers its moves and its `up` there, rather than switching mid-gesture to an
  element that never saw the `down`.

  **The `contains` tier is load-bearing, not a corner case.** Measured on the Samsung
  (`com.modokiengine.tropicalisland`, two canvases): a tap at (130,503) resolved `canvas:contains`,
  not `canvas:hit`, because `document.elementFromPoint(130,503)` returned **null** at a point a
  canvas visibly covers. Cause not established — it is not the marker overlay (`pointer-events:none`)
  and the same call returns the canvas for a centre-of-screen aim on a single-canvas scene. So do
  not treat hit-testing as sufficient on device: geometry is what produced the right target here,
  and without that tier the aim would have fallen through to `ambiguous` — i.e. straight back to the
  first-canvas bug.

**What `device_eval` CANNOT do, and why it is not an oversight** (#101). The injected `modoki`
object covers the device's **agent ops**. Input (`tap`/`drag`/`pointer`/`press-key`/`hover`/
`scroll`/`type-text`) and `screenshot` are **not** ops — they are bridge-level methods, and trusted
input is dispatched HOST-SIDE by the backend precisely because *a page cannot dispatch a trusted
event to itself*. So `modoki.call('tap')` answers `Unknown method:`, and unlike the editor there is
no `modoki.api()` to route around it (nor `composite()` — no undo stack on device). The trap worth
knowing: `resolve-dom-point`/`resolve-entity-point` ARE ops, so a script can compute exactly where
to tap and then be unable to tap. Use the `device_*` input tools for that half — each MCP call
keeps its full trusted routing. `device_eval_api` states this boundary in its reply; the guidance
lives in the MCP server rather than on-device because **the app is a shipped artifact that can be
older than the server**, and on-device text would report the old build's wording.

⚠️ **Which APP is answering? The bridge port (9095) is a FIXED default shared by every Modoki
game**, and Android keeps a backgrounded app resident. If another Modoki app already owns 9095, the
one you just installed fails to bind — **both platforms now resolve/reject on the ACTUAL bind
outcome and fall back to an OS-assigned free port on conflict** (`GameDebugPlugin.java`
`startListener` mirrors the iOS `.ready`/`EADDRINUSE`-fallback shape fixed in #88; before that fix
Android resolved `startServer` unconditionally, before the bind was even known, so a failed bind
still reported success). The remaining hazard is the STALE lease: the adb forward / WiFi connect
still points at whichever app held the socket first, so if a backgrounded app got there before your
fresh install, `device_*` calls keep working and answering **from that other game**. Measured
2026-08-02: a rebuilt `3d-test` looked like it was missing a just-landed bridge change; a
backgrounded `court` was answering the whole time. This is the on-device twin of the "which editor
is this?" gotcha below — same silent-wrong-target shape. `device_status` now reports the app
package/bundle id the socket is actually held by (`App: <name> (<id>) [<platform>] — reported by
the device holding the socket`, via `@capacitor/app`'s `getInfo()` read in the SAME page context as
the TCP server — so the answer can't be a locally-derived guess) whenever a lease is connected: the
one-call check for this that used to take a logcat hunt. **If a device answer looks impossible,
`device_status` first; failing that, find the holder by its SOCKET rather than its name —
`adb shell 'cat /proc/net/tcp /proc/net/tcp6' | awk '$4=="0A"'` lists every listener with its uid,
which `dumpsys package <pkg> | grep userId` maps back to a package. A `grep modoki` MISSES a Modoki
game whose package is not named that: `games/court` ships as `com.apiary.court`, and it held 9095
through an entire investigation on 2026-08-20 for exactly this reason (#283).**

`device_status` also names **which HANDSET** the lease is holding, on its own line —
`Device: iPhone18,4 / 26.5.2 — the hardware this lease is holding` — from
`capacitor-game-debug`'s `getDeviceHardware` (#146). Kept separate from the app line deliberately
([mcp-tool-conventions.md](mcp-tool-conventions.md) §2): a wrong-**app** session and a
wrong-**device** session are different failures with different fixes. On iOS it is the same string
that decides which phone a WebDriverAgent launch targets (it matches `xcrun devicectl`'s
`productType`), so a wrong-phone launch becomes a one-call read instead of an inference — see
[trusted-device-input.md](trusted-device-input.md). Absent for a build older than #146: omitted
rather than guessed, since "could not look" is never reported as an answer (§5).

Two limits on that check, both measured on the Samsung 2026-08-02 — know them before you trust it:

- **The squatter is usually the app that CANNOT answer.** Whichever app won the port is by
  definition the one that was already resident, so it is typically the OLDER build — predating the
  handler. Its reply is `Unknown method: app-identity` (the bridge signals a missing handler by
  *returning* the string, not throwing — see `isDeviceError`), and `device_status` surfaces that as
  `App: UNKNOWN — … predates #88 …` rather than swallowing it. An old bridge on the socket is
  itself the signal: it is not the app you just launched. The named identity only appears once the
  squatter is also on a post-#88 build, which is why all nine projects were re-vendored together.
- **The EADDRINUSE fallback buys honesty, not reachability — so #95 removed the collision at its
  source instead.** The app rebinds to an OS-assigned port and logs the true one, but the lease
  dials a fixed `DEVICE_PORT = 9095` (`engine/plugins/backend/deviceConnection.ts`) and
  `adb forward` maps `tcp:<hostPort> → tcp:9095`; nothing discovers the fallback port, so a fallen-back
  app is not reachable over the lease at all. Rather than teach the host to chase a moving port,
  **the bridge now RELEASES the port when the app backgrounds and re-binds when it returns**, making
  *at most one Modoki app listens, and it is the one on screen* an invariant. Consequences worth
  knowing: a **backgrounded Android app can no longer be driven** (deliberate — the tools drive what
  is on screen, and iOS suspends background apps anyway), and the lease drops on background and
  reconnects on return. This NARROWS the app-switch race rather than closing it (resume can precede
  the other app's pause), and an app built before #95 still squats — so when a connect fails on
  9095, closing the other Modoki apps remains the fix, and `device_connect` accepts an explicit
  `port` for the case where you can read the real one from the log or the in-game debug menu.
- ⚠️ **#283's bind RETRY cannot win the foreground handover — measured across three window sizes,
  and this is why the constant is small.** `bindWithRetry` (`GameDebugPlugin.java`; the iOS
  `startListener` mirrors it) retries the default port before accepting a fallback, and on a Galaxy
  A23 the outgoing app's release NEVER arrives while the loop runs — it lands after the loop gives
  up, scaling with how long it waited:

  | window | gave up at | released at | release − give-up |
  |---|---|---|---|
  | 0.5 s | +0.60 s | +1.10 s | 0.49 s |
  | 2 s | +2.11 s | +2.88 s | 0.77 s |
  | 5 s | +5.13 s | +6.32 s | 1.19 s |

  The fallback happened every run (3/3 at 2 s, 3/3 at 5 s). Waiting longer only postpones the
  release — **the retry defers the very thing it is waiting for**, so no value is long enough. The
  original 2 s was sized on ONE 449 ms sample from a different situation (the outgoing app resuming
  and immediately re-pausing) and did not generalise. The retry is kept at 1 s as cheap insurance
  for the unrelated case where the previous owner is already gone; **host-side port discovery below
  is what actually fixes the handover.** A fallback is now also **announced** — `startServer`/`getStatus` return
  `fallbackPort: true`, and the JS side `console.warn`s it (a `_log` would be invisible, since the
  console ring keeps only warn/error).
- ⚠️ **iOS: the normal path is device-verified, the RETRY is not.** On an iPad mini (iPad11,1,
  18.7.8) the rebuilt plugin binds 9095 and reports `{"port":9095,"fallbackPort":false}` from both
  `startServer` and `getStatus` — so the Swift compiles, runs, and does not break the happy path.
  The retry itself never fired: with `court` (an older build that does bind 9095) launched first at
  gaps of 2/3/4/6 s, the incoming app got 9095 cleanly every time, because iOS released the
  outgoing app's port before the new one bound. So iOS's handover looks clean where Android's is
  not, and the retry path there is UNTRIGGERED rather than proven. Read the plugin's output with
  `xcrun devicectl device process launch --console` — it carries the Swift `print()`s, and unlike
  `idevicesyslog` (which captured nothing here) it is provisioned by the toolchain.
- ⭐ **The host now DISCOVERS the port, because the retry alone is not a closure** — the outgoing
  app does not always release at all (measured: Court held 9095 through a full skin-test launch with
  no `Server stopped` ever logged, so no retry window could have helped). Over adb, with no explicit
  `port`, `device_connect` asks the device which app is in the FOREGROUND, resolves that package to
  a uid, and takes the listening socket that uid owns (`androidBridgePort.ts`); if that is not the
  port it reached, it re-forwards and reconnects there.
- ⚠️ **The test is uid OWNERSHIP, not an identity self-report — and that distinction is the fix.**
  An earlier cut asked the connected app to name itself and re-targeted only on a mismatch. That was
  inert against exactly the app most likely to be squatting: as the bullet above already warned,
  the squatter is usually the OLDER build, and Court answers no `app-identity` at all — so the check
  saw "could not look" and stood down. uid ownership needs nobody's cooperation.
  **This closes the #88 wrong-app case too**, which the retry could not touch: a backgrounded
  sibling holding 9095 answers the handshake perfectly, so there is no failure to notice — measured
  on the A23, a bare `device_connect` landed on Court while `skin-test` sat on 39213, and every
  later `device_*` call would have driven the wrong game. Verified end to end: the forward moved to
  `tcp:9098 → tcp:39213` and a `profiler action:'boot'` call answered — an op Court's build does not
  have, which is what makes the reply proof of WHICH app rather than merely a reply.
- **Android over USB only.** The reads are `adb shell`; a WiFi lease has no such channel and keeps
  the explicit `port` escape hatch. Discovery returns nothing rather than guessing when the chain
  breaks (no foreground app, an unresolvable uid, no listener owned by it) — a wrong port means
  driving another app, so "could not tell" is never rendered as an answer.

**How the Percept/Enact tools work — one delegation, zero duplication.** The device runs the SAME game
ECS + renderer + DOM as the editor, and the Percept/Enact op registry (`engine/app/debug/agentBridge.ts`
— `scene-state`, `diagnose`, `journal-events`, `resolve-refs`, `game-introspect`, `layout-bounds`,
`watch-*`, `dispatch-action`, `resolve-dom-point`) is runtime-safe. The device bridge
(`engine/app/debug/bridge.ts` `handleMessage`) delegates any non-native method to that registry via a
**lazy `import('./agentBridge')`** → `runAgentOp`. So every device Percept tool reuses the editor's
exact shaping — summary-first, GUID-addressed, floats rounded to 9 sig-figs. The dynamic import
**code-splits** the ops into their own chunk that loads only on the first Percept/Enact request over a
live lease, so a release game (whose native server rejects connections) never loads it. `agentBridge` is
otherwise gated behind `__MODOKI_EDITOR__`, which is why this delegation is the ONE wire that brings
Percept to device.

**Prefer data over pixels on device — it's not optional on Android.** The native `captureScreen`
renders a WebGPU (Dawn/Vulkan) canvas **black** — only the DOM HUD survives — so `device_screenshot`
uses `adb screencap` for an adb lease (full framebuffer) but has nothing to fall back on over WiFi.
`device_diagnose` (render/scene health as data) and `device_get_scene_state` are the reliable channel.
`device_screenshot` returns a **PATH, not an image** (`inline:true` only when you must see pixels).
On **iOS**, `device_screenshot {source:'wda'}` captures the WHOLE DEVICE SCREEN via WebDriverAgent —
the only way to see a system permission/ATT dialog or springboard, which the app's own capture
cannot (it returns the app *underneath* the dialog, looking like a fine screenshot of the wrong
thing). ⚠️ Its pixels are device-screen coordinates and must **not** be fed to `device_tap`. Detail:
[docs/trusted-device-input.md](trusted-device-input.md) § "WDA also captures the screen" (#102).

**Enact aiming — prefer a `selector`.** `device_tap`/`device_drag` resolve a CSS `selector` on-device
(occlusion-checked, no screenshot round-trip — the fix for tapping DOM chrome like a debug-menu ✕), or
take screenshot pixel coords (iOS converts off the last capture; Android passes the adb dims as
`screenInfo`). `device_drag {dom}` drags **DOM chrome** (widgets, sliders) by dispatching the pointer
sequence ON the grabbed element (auto-engaged on a non-canvas grab) — it neutralizes
`setPointerCapture`/`hasPointerCapture`/`releasePointerCapture` for the synthetic sequence, since a
synthetic pointer isn't an "active pointer" and a React drag hook's `e.currentTarget.setPointerCapture`
would otherwise throw and abort the drag. `device_press_key` dispatches keydown → brief hold → keyup on
the focused element (bubbles to `window`, where the F12 debug-menu toggle + input sources listen).
`device_dispatch_action` triggers a game intent directly and flags a `{dispatched:false}` no-op as an
error, not a phantom success.

⚠️ **A resolved `selector` is dispatched ON the element it resolved to — it did not used to be
(#299).** `device_tap`/`device_pointer` recognised only `<button>`/`<a>` as DOM targets and sent
everything else at the game canvas, so an on-screen control built from a `div` (the `UIRenderer`'s
output, a game's touch d-pad) received an event whose `target` was the CANVAS and every
`e.target`/`closest(...)` handler missed — while the reply said `ok (canvas:only)`. Measured on the
A23 with `demos/forest-camp`: a press on the d-pad left `moveX` at 0 and a tap on the aim button
never toggled archery. The reply now names where the press landed — `dom:<element>` or
`canvas:<how>` — so the aim is checkable from the reply alone. An element that CONTAINS a VISIBLE
canvas (`<body>`, an app root) is still a container, not UI, and keeps the canvas path; a hidden
utility canvas inside a UI panel does not make that panel a container. "UI" means any `Element`, not
just an `HTMLElement` — an inline `<svg>` icon inside a button is an `SVGElement`, and narrowing to
`HTMLElement` sent every icon-button tap back down the canvas path with a clean `ok`.

Two replies say more than `ok`, and both are cases where a bare `ok` would over-claim:
- **`— the target left the DOM during the press`**: the element unmounted itself between the down
  and the up (an ordinary React pattern). Dispatching at a detached node neither throws nor bubbles,
  so the trailing `click` reached nothing and only the down half was delivered.
- **`— the lease dropped during this call`** (`device_pointer`): the connection died while the aim
  was still resolving, so the press was released immediately rather than left held.

⚠️ **Release what `device_pointer` presses.** A `down` left un-released latches the engine's
`pointerSource`, and until then the game reads NO dragging at all — **including the human's finger**,
until the app is force-stopped. That is what made this bug expensive to find: the d-pad kept working
(it tracks its own `pointerId`s), so "drag is broken but buttons are fine" read as a product bug.
Two defences now exist, and neither excuses skipping the `up`: a real finger reclaims a stranded
synthetic gesture ([input.md](input.md) § "How it works" — the "A stranded synthetic press" note), and dropping the lease sends
the `up` for you. (`tap_handle`/`drag_handle` aren't ported — the game UIRenderer emits no
`data-ui-id`.) Full tool table: [`CONNECTION.md`](../engine/tools/game-debug-mcp/CONNECTION.md).

### Lease semantics & why it's Modoki-owned

Ownership is a **deliberate human action** — a session can never acquire the device on its own, only
*use* one the human connected. That kills "a session I didn't intend grabbed the device" at the root
(the old Bonjour/adb auto-connect let idle sessions in any clone grab — and *storm* — the single-client
device). The topology is controlled-comms: **control plane** (Modoki ↔ device: connect / GUID
handshake / ping / disconnect) and **data plane** (Claude → Modoki → device: eval / screenshot / tap /
drag / logs). The Claude→Modoki hop is loopback on the Mac, so proxying even an 1800px iOS screenshot
is a memcpy, not a second WiFi trip.

Why the GUID is **Modoki-generated, server-side, and persisted per clone** (`.modoki/device-guid`):
the long-lived editor owns the token (not the ephemeral app), so relaunching the *game* doesn't
invalidate it and auto-reconnect swallows every relaunch — **click Connect once per editor session**.
The token never leaves the backend; the device trusts exactly one socket. Reuses the per-clone
`MODOKI_BACKEND` convention (5179/5180/5181), so `modoki_identity`'s "which clone am I driving" guard
now covers device ops too, and manual IP deletes discovery entirely — nothing auto-connects, no race.

| Event | Behavior |
|---|---|
| **Connect** (user clicks; IP, or "Use adb") | Modoki mints/loads GUID `X`, opens the socket (WiFi to the IP, or `adb forward` over USB), sends `connect{guid:X}`. Device with no live lease → **accept**, record `X`. |
| **Game relaunch** (common) | App dies → device lease evaporates → sockets drop → Modoki auto-reconnects `connect{guid:X}` to the blank app → re-claims. No click. |
| **WiFi blip** (app alive, socket drops) | Device holds the lease a **5s grace window** before freeing, so auto-reconnect re-grabs it and ownership survives. |
| **Modoki crash / quit** | Socket drops; grace (5s) expires → device frees the lease → another editor can connect. Self-heals. |
| **Second Modoki** | `connect` with a different GUID while leased → **rejected** (device is first-wins). The incumbent auto-reconnects aggressively, so ownership stays put. |
| **Wedged** (last resort) | Relaunch the game — the in-memory lease resets unconditionally. |

**Android transport is a user choice:** *Use adb (USB)* tunnels over `adb forward`→`127.0.0.1` (the
reliable path; IP field disabled) vs. the typed IP over WiFi. iOS is always WiFi/IP. Same lease/GUID
protocol rides either transport — only the socket target differs.

#### `busy` / `refused` over adb does NOT mean another Modoki has it (#164)

**Over a tunnel there is no `ECONNREFUSED`.** `adb forward` accepts the connection on this clone's
local port and only *then* discovers the device end is dead — so `transport.open()` succeeds and it
is the lease **handshake** that gets no reply. `DeviceLeaseClient.connect` reads that, correctly for
WiFi, as "reachable but owned" and reports `busy` / `refused`. On USB the same signal has a second,
commoner cause: **nothing is listening on 9095 at all.** The two are indistinguishable from the
host — a first-wins plugin refuses an extra client by dropping the socket without a reply, which is
byte-for-byte what a dead device end looks like through a forward — so `explainConnectFailure` names
both rather than guessing, and the connect no longer keeps its hardware claim when it fails.

**When the OPEN PROJECT ships `build.debugBuild: false`, the message says so first (#239)** — that
flag means no TCP server was compiled in, which explains "nothing is listening" outright, and the
advice below (reopen the project so heal syncs the flag) *cannot work* while the flag is off,
because heal writes its current value. The backend reads the flag from `loadProjectConfig`, never
from the request body, so a caller cannot talk the refusal out of naming it.

⚠️ **But it is definitive ONLY for `ECONNREFUSED`, and the asymmetry is load-bearing.** `refused`
means the socket was ACCEPTED and then not answered — something *is* listening, which is proof the
server is not simply absent. Two reasons that happens with the open project's flag off: over adb
the forward accepts on this clone's end even when the device port is dead, and **the flag belongs
to the open project while the phone may be running a different app** — which app holds the socket
is unknowable until a lease opens (see `device_status`, #88). A backgrounded sibling game squatting
the shared 9095 answers exactly like this; it was hit on a Galaxy A23 on 2026-08-19, where `sling`
answered a connect aimed at `postfx-demo`. So `refused` names the flag as the leading suspect and
keeps the second cause; only `ECONNREFUSED` gets to rule the others out.

Which one it is, settled in one command (**hex** — `/proc/net/tcp` is hex, and hand-converting 9095
to `0x238F` instead of `0x2387` is a mistake that has already voided one investigation):

```bash
adb -s <serial> shell "cat /proc/net/tcp" | grep -i 2387    # no row → nothing is bound
```

No row means the app is running with its debug server off, and the overwhelmingly likely reason is
that only ONE of the two `build.debugBuild` gates is on: the JS define is baked at build time, while
the native plugin reads the manifest meta-data / plist that `healNativeConfig` writes — see
[Debug vs Release — ONE flag decides](#native-debug-bridge-capacitor-game-debug) below. **A project
whose native folder was scaffolded without a heal has the first and not the second**, and every
symptom points at the first: the bundle contains the bridge, the gated branch runs, and nothing
listens. Reopen the project in the editor (heal-on-open) and rebuild.

The bridge now says so itself, at **error** level and carrying both `GameDebug` and
`TCP server listening` so one grep finds it — it previously reported this at log level, worded to
match neither, which is why the failure read as "the branch never ran".

### Two sources of native logs, and they answer different questions (#217)

`device_native_logs` has a `source`, and picking the wrong one gets you plausible-looking log lines
that cannot contain the answer:

| | `source:'app'` (default) | `source:'system'` |
|---|---|---|
| Where it reads | `OSLogStore(.currentProcessIdentifier)` **inside the app** (`GameDebugPlugin.swift`), logcat in-process on Android | **host-side**: `ios syslog` over USB (iOS) / `adb logcat -d` (Android) |
| Direction | **backward** — a query over stored logs, `seconds` looks back | **iOS: forward** (a stream; `seconds` is how long it captures, and you wait it out). **Android: backward** (a ring-buffer dump; `seconds` is ignored) |
| Needs | the app running **and** the debug lease connected | nothing: no lease, no claim, app may be dead or uninstalled |
| Sees | only this process's own logging | everything the device logs, including what the system says *about* us |

⚠️ **That direction split is real, not an inconsistency to smooth over.** logcat is a ring buffer
that already holds the past; iOS's syslog relay only delivers what happens after you attach. Making
both "consistent" would either cost Android its main advantage or make an agent wait ten seconds for
logs it already has. The response says which read you got (`logcat dump, backward` vs `streamed
forward for Ns`), because an empty result means *"nothing was logged"* in one case and *"nothing
happened while I watched"* in the other, and those lead to opposite next moves.

**The `system` source exists for the three questions the app path cannot answer even in principle**
— why it CRASHED (the process that would have replied is gone), what happened during LAUNCH before
the bridge attached, and system-side kills (jetsam/OOM, watchdog, sandbox denials), which our
process never emits. Measured on an iPhone 8: killing the app mid-capture surfaced SpringBoard's
whole teardown of `com.modokiengine.court`, none of which the in-process path could have produced.

⚠️ **Forward means forward.** `source:'system'` cannot show a crash that already happened — attach,
then reproduce. **`device_crash_reports` is the backward-looking surface** (below); it is a separate
tool rather than a third `source`, because a report reader and a live stream are different things.

### `device_crash_reports` — what the device wrote when the app died (#218)

The `.ips` reports the system writes at the moment of death and keeps for days. Bare call lists this
app's recent reports; `name` summarises one. Needs no lease and no running app — by definition.

**A `JetsamEvent` is included even though its filename names no process, and that is the point:** it
is how an app dies *without* writing a report of its own, so a strict process filter would hide the
likeliest cause of a mystery termination on a low-end device. Summarised, never dumped — one
measured jetsam is 117 KB and 207 processes, and the answer inside it is four numbers:

```
killed:  com.apple.WebKit.WebContent  1027.3 MB  reason: highwater
largest: com.apple.WebKit.WebContent  1027.3 MB
app:     App pid 1117  44.1 MB (peak 76.6 MB)
```

That is the difference between "the screen went black" and "the WebView hit its ~1 GB ceiling while
our shell held 44 MB". `raw:true` returns the report text (capped) when the summary is not enough.
MB figures assume **16 KiB pages** — an assumption named in `IOS_PAGE_BYTES`, because the reports
carry no page size. The parser branches on report SHAPE, never on `bug_type`: that code is opaque
and has moved across OS versions, and being wrong about it would mis-parse a real crash in silence.

**On Android the same tool reads two logcat buffers** (`deviceAndroidDiag.ts`), and the pairing with
iOS is exact: `-b crash` ↔ an `.ips` exception report (`FATAL EXCEPTION` + stack), and `-b events`
`am_kill`/`am_proc_died` ↔ a `JetsamEvent` — the activity manager killing a process, with its
oom_adj and its own reason (`empty #34`, `cached`). That second one is how an Android app dies
*without* writing a crash of its own, which is why both are behind one tool. Measured on a Galaxy
S22 against a deliberately forced crash: the `FATAL EXCEPTION` and the process death that followed
it come back correlated on the same pid.

Two Android-only notes. **`name` is iOS-only** — logcat hands back content, not report FILES, so
there is nothing to address; the bare call already returns the records. And the package filter
includes **`<pkg>:sub` processes**, because a Capacitor game's WebView runs in its own
`:sandboxed_process` and that renderer kill is the one that actually takes the screen black.
Deliberately not used: `adb bugreport` (tens of MB, a minute-plus, for a superset that mostly does
not answer "why did my app die") and `/data/tombstones` (root-only on a production device).

### Which phone a host-side op talks to — ask the TRANSPORT

On Android these read through `adb`, targeted by the LEASE's serial when there is one, else the
project pin, else the only attached device — a refusal naming every candidate otherwise (#149).
On iOS both surfaces need go-ios (Build Support → go-ios, or the first iOS ≤16 build provisions
it), and both resolve the device through **`ios list`, not `devicectl`/`xctrace`**. That is a correction,
not a preference: measured 2026-08-13, an iPhone 8 that go-ios reported continuously **vanished from
the xctrace listing for minutes** and came back, so a syslog read resolved through Apple's listing
failed with "matches none of this Mac's paired iOS devices" about a device that was plugged in,
awake, and answering. usbmuxd is a different visibility path from CoreDevice and Instruments, so
asking Apple's tools whether go-ios can reach something is asking the wrong party.

The rule generalises: **resolve a device through the transport the op will use.** A build still
resolves through `devicectl`/`xctrace` — correctly, because `xcodebuild` targets *that* listing.

Selection order is the usual one: `MODOKI_IOS_DEVICE_UDID` → the only attached device → the one
whose `ProductType` matches the leased app's reported model (the lease never learns a UDID by
design, #146) → **refuse, naming every candidate**. Reading logs off the wrong phone produces a
confidently wrong answer that looks right.

**The same rule binds the PLATFORM, and that was a real defect** (close-out review). These ops exist
for when the app has died — which is exactly when the lease is gone and cannot say what platform it
was. The first cut fell through to iOS whenever the platform was unknown, and with an iPhone and
three Androids attached it silently answered about the iPhone: right-looking payload, wrong device,
no hint a choice had been made. Both tools now take `platform: 'ios'|'android'`, and the order is
**explicit → lease → what is actually attached → refuse naming both sides**. `pickHostSidePlatform`
is the one pure function that decides it, the same shape as `planIosInstall`.

⚠️ **A WiFi lease names no adb serial.** `target.serial` is set only on the `useAdb` path, so "there
is a lease" is not "we know which handset" — and falling through to the build resolver would read a
DIFFERENT USB phone while labelling it as the leased one. With a serial-less lease the Android side
disambiguates by the leased hardware model, exactly as the iOS side does, and refuses rather than
guessing.

**Response budget**: an Android system-log read caps at **400 returned lines** (`MAX_RETURNED_LINES`)
however large a `limit` you pass, and says `clamped` when it did. 4000 threadtime lines is ~400 KB,
roughly 7x the 60,000-char budget, and nothing else on this path truncates.

### Several phones attached: which one, and who has it (#149)

Two questions, one mechanism each. `device_list` answers both in one call — attached Androids
(`adb devices -l`), paired iPhones (`devicectl` + the legacy `xctrace` listing), and who holds each.

**Which one — the serial is resolved ONCE, at connect, and carried on the lease.** Every adb call on
this surface used to be un-targeted, which is fine with one phone and fails outright with two: adb
answers `more than one device/emulator` and refuses, taking out `device_connect {useAdb:true}`,
trusted Android input (CDP discovery is an adb call) and `device_screenshot` together. Now
`device_connect {useAdb:true, serial:"…"}` — or the AI panel's device picker — resolves one serial and
puts it on `status.target.serial`; the CDP tunnel and the adb screenshot **reuse that**, and must
never resolve one of their own. That ordering is the load-bearing part: two calls in one session that
each picked a device could drive two different phones and both report success (the #142 failure, one
device down). Precedence, and the refusal that names every candidate, is documented on
`resolveAndroidSerial` in `engine/plugins/backend/androidDevices.ts`; `MODOKI_ANDROID_SERIAL` (and
adb's own `ANDROID_SERIAL`) pin it, and the panel remembers your last pick per clone.

A native **Android build** picks its install target through `resolveBuildAndroidSerial`, whose order
is: the project's own pin (Project Settings) → **the held lease's phone** → the shared rule above.
The lease leg is #235, and it is what makes the refusal honest rather than a new convenience: the
shared message offers `device_connect {useAdb:true, serial}` and the AI panel's picker as remedies,
and both act by opening a lease — so while the build consulted only the project pin, an agent that
did exactly what the message said got the identical refusal on the next build, one full
build-and-refuse cycle later. The lease is a **preference, not a pin** (same rule the remembered
target follows): a leased phone that has since been unplugged is ignored rather than hard-failing a
build with a serial the human never typed.

⚠️ **That lease leg did not actually fire until 2026-08-21, and the reason is a trap worth keeping:
`deviceConnection` is a module singleton, and the backend router is mounted in TWO PROCESSES** —
Electron's `backendServer.ts` and the Vite dev server's `vite-asset-scanner.ts`. `device_connect`
opens the lease in the **Electron** process; the build resolves its serial in the **Vite** one, where
that singleton had never connected. Measured directly, one lease, one moment, two ports:
`:5183/api/device/status` → `state:"connected", serial:"<the leased handset>"`, while
`:5177/api/device/status` → `state:"disconnected", target:null`. So #235 shipped a correct resolver
fed a value that was structurally always `undefined`, and the build kept advertising the two remedies
it ignored — the very dishonesty #235 set out to remove. The fix is to read the lease from the
**machine-wide claims file** (`ownAdbClaim`), which is the state both processes share and which the
sibling-clone check on that same code path already used; it is NOT to dedupe the singleton. Guarded
by `engine/tests/plugins/buildLeaseSourceWireShape.test.ts`, a source-text guard, because the defect
is *which source is read* — every behavioural test passed `leaseSerial` in as an argument, which pins
how the resolver USES a lease and can say nothing about whether the caller can SEE one.

⚠️ **The #286 measurement below is real but was NOT discriminating, so don't cite it as proof of
precedence.** With the lease invisible to the build, "the pin wins over the lease" and "the lease was
never consulted at all" predict the *same* observation — an APK on the pinned S22. The conclusion
still holds (the code genuinely prefers the pin, and now demonstrably consults the lease when there
is no pin), but it holds because of the code, not because that experiment separated the two.

⚠️ **Read that order the other way round too: a held lease does NOT redirect a build away from the
project's pin.** Claiming phone A and then running `Build → Android` on a project pinned to phone B
installs on **B**, correctly and silently — the two mechanisms answer different questions ("which
phone am I debugging" vs "which phone does this project deploy to"), and only the second decides an
install. Measured 2026-08-21 (#286): a lease on the A23, a Court build, and the APK landed on the
S22 that `games/court/project.user.json` pins. It reads like the lease being ignored, and it is not
— to deploy to the leased phone, change the pin or install the built APK yourself with
`adb -s <serial> install -r`.

**Devices are named by what the PHONE calls itself, not by its model code.** `adb devices -l` reports
only `model:` — `SC_56C`, `SM_S901U1`, `MRD_LX3` — which is precisely the string that fails to tell
three handsets on a desk apart. So the listing asks each phone once (one `adb shell`, memoized per
serial for the process): `settings get global device_name` → `secure bluetooth_name` →
`ro.config.marketing_name` → `ro.product.marketname`, taking the first answer that is not the model
code again. Measured on this Mac's three, and each step earns its place: the Samsungs answer
`Galaxy A23 5G` / `Masaki Android` from `device_name` with **every marketing-name prop empty** (so
"just read the marketing prop" does not work), while the Huawei's `device_name` IS its model code and
only `bluetooth_name` gives `HUAWEI Y6 2019`. A renamed phone reports the owner's own name for it,
which is better than the marketing one. It is a LABEL, never an identity — the serial addresses
everything.

**Who has it — a machine-wide claim, because the lease cannot reach this.** The lease arbitrates the
SOCKET and does it well, but adb is one machine-wide daemon, an `xcodebuild` install needs no socket,
and a WDA launch targets a phone by UDID — so two clones could (and did) drive one phone unimpeded.
`~/.modoki/device-claims.json` sits beside `editor-launches.log`, machine-wide **for the same reason
that log is**: the sibling that caused the collision is exactly what a per-clone file cannot see. A
claim is taken by the lease (`connect`) and by the WDA launch, released on `disconnect`/`stopWda`, and
expired by **pid liveness OR a 12h TTL**, either alone sufficient — a dead session must never hold
hardware hostage. A refusal names the clone, branch, pid and time. Rationale in
`engine/plugins/backend/deviceClaims.ts`; this replaces the unenforced "serialize on-device builds"
convention in the root `CLAUDE.md`.

⚠️ **Ask `device_list`, not the file — the file can hold corpses that block nothing** (#225). Expiry
is applied ON READ, so a claim whose pid is gone is already expired the instant the process dies:
`device_list` will not show it and another clone's `connect` is not refused. The RECORD, though, is
only rewritten when something claims, releases, or sweeps — and `stop-editor.sh` sends a SIGTERM that
no in-process hook survives, so a `cat ~/.modoki/device-claims.json` right after stopping an editor
can still show an entry naming your clone, your branch and a purpose. That reads exactly like a live
hold and is not one; it was hand-deleted twice before being measured. Two things now keep the file
honest — Electron's `before-quit` releases on a normal quit, and every backend startup sweeps
dead-pid entries — but the rule stands regardless of what the file says: **a dead pid holds nothing.**

**The claim now covers the CLI surface too, not just the MCP one (#285).** #149 enforced the claim
only along the path that consults it: `device_connect` refuses a claimed device and names the holder,
while `adb`, `xcrun devicectl`, `xcodebuild -destination`, `ideviceinstaller` and go-ios do not,
because they never ask. That left the claim protecting the polite surface and wide open on the one
where the destructive operations live — `install -r`, `uninstall`, `am force-stop`, `pm clear`,
`logcat -c`, `device process terminate`. On 2026-08-20 this clone released the Galaxy S22, `work-ai2`
claimed it, and this clone then reinstalled Court on it, force-stopped it and cleared its logcat over
raw `adb -s`. `device_list` showed the claim throughout; nothing warned, and the OWNER spotted it
rather than the tooling. The rule was already written down in `CLAUDE.md` — which is the point: it
was a rule with no enforcement, the same shape as #18's `git add -A` hazard, and discipline held for
four hours and then lapsed once the device work became routine.

Two mechanisms now close it, and they are deliberately different in reach:

- **`engine/scripts/device.mjs`** — a standalone CLI (`npm run device:claim|release|list|run`) that
  takes the SAME machine-wide claim the editor does. It is the universal path: it works for a human
  in a terminal, for Codex/Cursor/Antigravity, and inside scripts. Because a CLI process exits
  immediately, its claim cannot be pid-owned — it carries an **owner token** (`cli:<clone path>`) and
  is expired purely by a **90-minute TTL**, far shorter than the pid-claim's 12h backstop for the
  reason spelled out on `CLI_CLAIM_TTL_MS`: a pid-claim has a second, independent expiry and an
  owner-claim has none. `device run -- <cmd>` claims (or refreshes), then execs, and KEEPS the claim.
- **`engine/scripts/claim-guard.mjs`** — a Claude Code `PreToolUse` hook, registered in the committed
  `.claude/settings.json`, that refuses a **destructive** raw device command unless this clone holds
  a live claim on the device it names. This is the one that would have stopped the incident, because
  the violation happens when an agent shells out. It is strict on purpose: a destructive call against
  an UNCLAIMED phone is refused too, matching what CLAUDE.md already required, and the refusal names
  `npm run device:claim <id>` so the remedy costs one command. Read-only calls (`adb devices`,
  `getprop`, `logcat -d`, `devicectl device info`) are always allowed — the claim arbitrates
  interference, not curiosity, and a guard that refused listings would be routed around.

⚠️ **Wireless adb: the TRANSPORT verbs are carved out, because the fail-safe default was
unsatisfiable for them.** `adb connect` / `disconnect` / `pair` address a device as `HOST:PORT` and
have **no `-s` form at all** — the address IS the target. They were not in either verb set, so the
"unrecognised ⇒ destructive" default made them `untargeted`, and the refusal told the caller to
*"say which one: `adb -s <serial> …`"* — advice the command cannot take. The only ways past a
refusal like that are to bypass the hook or to abandon wireless debugging, and both are worse than
the rule. They are daemon management, like `start-server`/`kill-server`, so they are now classified
the same way (2026-08-22, setting the S22 up for the Windows clone).
- The carve-out is scoped to the transport verbs. What a connection is USED for is guarded exactly
  as before: `adb -s 192.0.2.10:5555 install …` parses with the host:port as the serial and is
  refused unclaimed like any USB one. A test pins that so the carve-out cannot leak.
- `adb tcpip` is deliberately NOT in the set — it restarts `adbd` on the phone and does take `-s`,
  so fail-safe-destructive is right for it.
- ⚠️ **A bare `adb disconnect` drops EVERY wireless device on this machine**, including another
  clone's in-flight install, and the carve-out allows it. That collateral is accepted rather than
  overlooked: `kill-server` is strictly worse (it drops USB devices too) and rule 5 has always
  allowed it, so refusing `disconnect` would be inconsistent — and the refusal would be the
  unsatisfiable kind this entry exists to remove. Prefer `adb disconnect <host:port>`.
- The same sweep found three more verbs the fail-safe default was refusing unsatisfiably —
  `version`, `help`, `keygen` (two print and exit; one writes a LOCAL key file). They are in the
  read-only set now. The way to find these is to ask the parser, not to read it: enumerate
  subcommands through `parseDeviceCommand` and look for `untargeted: true` on anything that has
  no `-s` form.
- ⚠️ **Wireless breaks the serialisation the claim provides, and the guard cannot fix that.** The
  same phone is a DIFFERENT claim id over Wi-Fi (`adb:192.0.2.10:5555`) than over USB
  (`adb:RFTESTSERIAL1`), so one machine can hold "the phone" twice over and not know it. Worse,
  claims are per-MACHINE: a wirelessly-shared handset is reachable from a second computer whose
  claims file this one never sees, which is precisely the interleaving #149 exists to prevent.
  Coordinate by hand whenever a phone is shared over the network.

**Scope, because the hook looks more powerful than it is.** It intercepts the Bash tool of a Claude
Code session in this repo and nothing else: your own terminal, the editor backend's own spawns, and
every non-Claude agent CLI bypass it (none has a `PreToolUse` equivalent). It never reaches a Modoki
USER either — `.claude/` is excluded from the OSS snapshot by `scripts/publish-engine-oss.sh`. And a
hook whose path is mistyped **fails OPEN**: Claude Code reports a non-blocking status and runs the
command, so a silently-disabled gate looks exactly like a gate with nothing to say. If you move or
rename the script, break the path deliberately once and confirm you see the hook-error notice.

⚠️ **A guard that fires on TEXT rather than on execution gets routed around, so the parser models the
shell rather than grepping it.** `engine/scripts/deviceCommandTargets.mjs` matches a tool only in
COMMAND position, splits on `;`/`&&`/`||`/`|` only outside quotes, and drops heredoc bodies before
splitting. All three came from live misfires within minutes of the hook going up: it refused the
command that was testing it, then the patch fixing that, then an attempt to write its tests — every
one of them a command that merely CONTAINED device-command text. The asymmetry to preserve when
editing it: an unknown VERB fails safe (refuse), an unknown COMMAND POSITION fails open (allow).
`bash -c "…"` is parsed by recursing into the string, so quote-awareness does not open an evasion.

**iOS keeps a residual gap, narrowed rather than closed.** One iPhone can be held under two claim
ids: a WiFi lease can only claim it by ADDRESS (`ip:<host>`), while every raw iOS CLI targets a UDID
(`ios:<udid>`) — and an iOS app is deliberately never allowed to report its own UDID (see
`deviceHardware`). A WiFi lease therefore stamps the `model`/`osVersion` the phone DOES report onto
its claim, and `device claim ios:<udid>` looks that UDID's product type up in `xcrun`'s listing and
compares. It is a hint, not a proof — two identical handsets report one model — so the rule is
asymmetric on purpose: **a match refuses (with `--force` to override), a mismatch allows, and an
absent model warns but proceeds.** "Cannot tell" is never "different", and never grounds to block a
Mac with no Xcode from claiming any iPhone at all.

**⚠️ Listing devices must never be SYNCHRONOUS — the backend runs inside the Electron main process
(#168).** `/api/device/list` resolved its iOS half with `execFileSync('xcrun', ['xctrace', 'list',
'devices'])`, measured at **1.379s**. The AI panel's device picker polls that route every 2.5s and the
iOS listing is cached for 10s, so every ~10s the main process blocked for ~1.4s. A blocked main
process stops forwarding input to the renderer: macOS keeps drawing the cursor (the window server
owns that) and the renderer keeps compositing at 60fps, so the symptom is not "the editor froze" but
**a drag that stops tracking your hand for a second or two while everything else looks alive**. That
is how it was reported, and it sent the first three investigations into the game's own drag code.

Measured with a CDP `Browser.getVersion` ping — answered by the browser (main) process, touching no
project JavaScript — with the AI panel open: **6 spikes of 1326–1425ms in 75s, p50 0ms**; with the
route stubbed, **0 spikes, max 2ms in 45s**; after the fix, **0 spikes, max 13ms in 75s**. Spike
spacing was exactly 10.0s or 12.5s, the signature of a 10s TTL polled at 2.5s. `sample(1)` on the
main process put the time inside `node::SyncProcessRunner::Spawn` under an HTTP request handler.

The rule that generalises: **a sync spawn is free on a user-initiated route and ruinous on a polled
one.** `ensureWdaRunning` keeps sync twins of the same seams deliberately — it is a human-initiated
60s WDA launch, and its check-and-set from the `isWdaProcessRunning()` guard to `spawnFn(...)` must
stay await-free or two concurrent input ops both spawn an agent (#109; making it async reopened that,
caught by the concurrency test). So the split is async-where-polled, sync-where-atomic, both through
one shared argv. Siblings that match the pattern and are NOT yet async, each measured cheap on this
Mac rather than assumed: `/api/device/list`'s Android half (`adb devices -l`, **13ms** warm) and the
AI panel's `modoki:connect-claude-status` IPC (`git ls-files` per poll; a login-shell `command -v
claude` behind a 15s TTL, only when `claude` is off the inherited PATH — a Finder-launched DMG). Both
would bite on a cold adb server or a slow repo.

**The claim arbitrates the PHONE; the derived host port arbitrates the TUNNEL (#158).** These are two
different questions, and the claim structurally cannot answer the second: two clones leasing two
*different* phones both pass it — correctly, different `deviceId`s — and then fight over one host
port, because that port used to be a hardcoded machine-wide 9095. Measured 2026-08-07: the second
`adb forward` won, and the first clone's lease was pointed at the wrong handset with **no error on
either side** — one editor reporting `connected` to a phone it did not have, the other reporting
`refused` from a phone that never saw its request. So the host end is now derived per clone, the same
idiom as backend/Vite/CDP: `9095 + (backend − 5179)` → 9095 / 9096 / 9097 / 9098
(`resolveDeviceHostPort`, `MODOKI_DEVICE_HOST_PORT` overrides). The **device** side stays 9095 —
`adb -s <serial> forward tcp:<hostPort> tcp:9095` — so nothing on the phone changes.

Two consequences worth carrying. **`status.target.port` is the HOST port**, not the app's — over WiFi
they are the same number, over adb they are not. And **`adb forward --remove` matches on the host port
spec and ignores `-s`**: a serial-targeted removal *will* delete another phone's rule (observed —
`adb -s RFDEADBEEF1 forward --remove tcp:9095` stripped `RFDEADBEEF2`'s live tunnel). Both
`adbRunner.removeForward` and the CDP tunnel's now verify ownership against `adb forward --list`
first and skip with a log on a mismatch — the same cross-clone reach the `pkill -f` scoping rule
exists to prevent, in a different mechanism. One gap remains, documented on `resolveDeviceHostPort`:
under `MODOKI_MULTI=1` there is no `MODOKI_BACKEND_PORT` to derive from, so every editor in that
clone lands on 9095 and only the ownership check stands between them.

## Editor debugging — DEFAULT to Electron (modoki MCP)

**The editor is shipped as the Electron desktop app, so debug it there by default.** Use the
`modoki` MCP server (`engine/tools/modoki-mcp/`), which drives the running Electron editor over
its backend (`MODOKI_BACKEND=http://127.0.0.1:<backend-port>` — 5179 main / 5180 work-ai / 5181
work-ai2 clone; see the Two Clones section of `CLAUDE.md`). This is the host you actually ship, so
it's the only place the Electron-only surfaces exist at all (main-process logs, IPC, native file
dialogs, `autoUpdate`, asar/packaging, the heal-on-open native flow) — none of which a browser tab
can see.

The MCP is **parity-plus** with chrome-devtools for the editor, and better on two axes:
- `modoki_capture_viewport` — `webContents.capturePage()`; captures the **real composited window**
  (use over a screenshot for "numbers right but renders black/NaN"). `modoki_render_scene` /
  `modoki_render_sequence` render the 3D view directly.
  - **If it fails, read the sentence it gives you — and note the one thing it will NOT claim.**
    `explainCaptureFailure` (`engine/electron/rendererOps.ts`) composes that message from the
    window facts *plus* the renderer's own `frameLoop`/`rendererGate`, fetched over IPC only on
    the failure path. The invariant, pinned by `engine/tests/electron/captureScale.test.ts`:
    **it claims a wedged renderer ONLY when the frame loop reports `stalled`.** A layout with no
    Scene/Game panel open has an `idle` frame loop **by design** (reproduced live on
    `games/court` with both closed), so `idle` reads "nothing is rendering to capture — NOT a
    wedged renderer" and points you at `modoki_render_scene`, which needs no mounted viewport;
    `hidden` is throttling; `running` is stated as evidence *against* a wedge. This exists
    because the message used to assert "most likely wedged" whenever it found no window-level
    fault — a diagnosis, and a wrong one for a fully-supported state, which sent the reader
    hunting a renderer fault that did not exist. **An error message that guesses a cause is
    worse than one that reports what it observed.**
- `modoki_tap` / `modoki_drag` — **trusted** `sendInputEvent`; hit-tests **PixiJS + Three.js
  together** (Chrome MCP `drag` is DOM-only — you'd have to `evaluate_script` the EventSystem). Both
  now take `button` (`right`→context menu, `middle`→orbit-pan), `clickCount` (`2`→double-click), and
  `modifiers` (`shift`/`meta`→multi-select, snap). Full raw-input siblings — `modoki_hover`,
  `modoki_scroll`, `modoki_press_key`, `modoki_dnd` — and the aimed-drag layer are under **Enact** below.
  - **A drag's `modifiers` are genuinely HELD, not just a bit on the mouse events.** `drag()`
    presses each one as a real `keyDown` right after the mousedown and releases it after the
    mouseup, so the key is down across every intermediate move. The distinction is load-bearing:
    the 2D gizmo's snap reads `e.shiftKey` off each pointer-move, but the 3D gizmo's reads a
    `window` keydown/keyup listener (`onSnapKey`) that tracks the modifier's LEVEL — the mouse bit
    is invisible to it, and `modoki_press_key` cannot help because it completes keyDown→keyUp
    inside one call. That left 3D-gizmo snapping undrivable by any MCP sequence until it was fixed;
    `modoki_drag {modifiers:['shift']}` now snaps both gizmos. The press lands *after* the
    mousedown on purpose — the mousedown is what gives the panel the keyboard scope `onSnapKey`
    gates on. **The SUSTAINED-pointer trio does NOT do this**: `modoki_pointer` `down`/`move`/`up`
    still sets `modifiers` on the mouse events only, so a level-tracking listener is unreachable
    through it. Holding a real key across separate HTTP calls needs the release to be as reliable
    as the press (a missed `up` leaves Chromium with a stuck modifier), so it was left alone — use
    `modoki_drag` when the modifier's LEVEL is what the code under test reads.
- `modoki_batch` — run several tools **in order, in one turn**. Reach for it when you already know
  the whole sequence (`create_entity` → `set_transform` → `save_all`, or `tap` → `wait` → capture).
  It exists for two reasons: **ordering cannot be expressed any other way** — issuing several tool
  calls in one message does NOT guarantee they run in order — and it lets you **drop the intermediate
  responses**, which is where the token saving is (it saves nothing on transport; every tool is a
  local `fetch`).
  - **Do NOT use it when you need a step's response to decide a later step.** There is no branching;
    use `modoki_eval` for that.
  - `result` per step: `"none"` (omit), `"ack"` (default — small payloads verbatim, large ones
    summarized), `"full"` (automatic for the LAST step, so a batch ending in a read needs no
    annotation). `resultDefault:"none"` suits a pure input macro.
  - **A failure is never hidden by `"none"`**: the failing step is reported in full, AND the steps
    *before* it are un-suppressed — they already applied, and **a batch is not a transaction**
    (nothing is rolled back, since each step is its own call).
  - **The `modoki_` prefix on a step's `tool` is optional** — `"save_all"` and `"modoki_save_all"`
    are the same step (an EXACT match wins first, so a game tool keeps its own `<gameId>_<verb>`
    name). This is not cosmetic: pre-flight validates every step before any of them run, so one
    unresolvable name used to void the WHOLE batch, valid steps included — and writing the bare
    name is the natural slip, because that is how these tools are referred to in prose everywhere,
    this page included (#295).
  - `{"tool":"wait","args":{"ms":100}}` is a pseudo-step for letting the renderer settle before a
    capture (`"modoki_wait"` is accepted for it too).
  - **Refused at pre-flight, so nothing runs:** unknown tool, args that fail the tool's real schema,
    raw `{x,y}` aiming on `tap`/`hover`/`scroll`/`pointer`/`drag`/`dnd`/`drag_handle` (aim by
    `entity`/`selector`/handle id, or `drag_handle`'s `toId`/`delta`), and
    `modoki_build`/`modoki_add_native_target`/`modoki_ota_publish`/`modoki_capture_gesture`/a nested
    batch (run those alone — `capture_gesture`'s `from`/`to` are REQUIRED raw coordinates, so it has
    no stale-proof aim to offer).
  - **Undo:** each step is its own undoable action, so a human's Cmd-Z unwinds a batch one step at a
    time rather than all at once.
- `modoki_type_text` — **trusted** keyboard input into the focused element (tap the input first);
  a real Chromium `char` event, so React controlled inputs (Inspector `BufferedTextInput`) fire
  their `onChange`. `clearFirst` replaces vs appends; `submitKey` `'Tab'`/`'Escape'` BLURs (to test
  commit-on-blur), `'Enter'` submits. This is how you author text fields (rename, `UIElement.text`)
  headlessly — the piece `tap`/`drag` couldn't reach. *(Electron editor only.)*
- `modoki_get_scene_state` / `modoki_mutate_scene` / `modoki_validate_scene` — same live-world
  data + validated edits as the curl `/api/*` endpoints, relayed over the IPC bridge.
  (`modoki_mutate_scene` ops: setTrait / **removeTrait** / addEntity / removeEntity.)
- `modoki_list_traits` / `modoki_list_assets` / `modoki_get_asset_meta` / `modoki_reimport_asset`.
  The two list tools are **summary-first**: bare, `list_assets` returns per-type counts and
  `list_traits` returns trait NAMES by category. Narrow to get detail — `list_assets {type|folder|name}`,
  and `list_traits {name:'Transform'}` for the one field schema you need before a `setTrait` (an unknown
  name errors with a did-you-mean rather than an empty object). `all:true` on either forces the full dump.

**Full editor parity (do/see everything a human can — dev AND the DMG).** These give the agent the
same actions + state a person has in the editor. They relay to the renderer over the SAME bridge
(Vite HMR in dev, Electron IPC in the DMG), so they behave identically in both:
- **See all UI state:** `modoki_get_editor_state` — selection, play state, gizmo mode/space, FPS,
  entity count, editor camera pose, undo/redo labels, and `viewport` (`innerWidth`/`innerHeight`/
  `devicePixelRatio`/`zoomFactor` — the VS Code-style UI zoom as DATA, no CDP needed) (the companion
  to `get_scene_state`). `modoki_get_console_logs` — renderer console + uncaught errors.
- **Eval live renderer state:** `modoki_eval` — run JS in the editor RENDERER and get the value back
  (the editor twin of `device_eval`). For reading/poking live state a file read can't see — a global
  (`window.__3d` for the Three.js GameView, `window.__2d` for the PixiJS one — both GameView ONLY,
  not the editor SceneView, which has its own separate surface), `devicePixelRatio`, a React fiber
  value, WGSL validation, dispatching a bridge event. Runs as an **async** function body (`return x`;
  `await` is allowed — see below); return a
  PROJECTION for anything large/circular. This
  is what removed most of the "stand up a raw CDP client" cases below. *(Electron editor only.)*
  - **`await` works on BOTH eval surfaces** (`modoki_eval` and `device_eval`) — the body is compiled
    with the async function constructor, so composing several promise-returning `modoki.*` ops in one
    call is the normal thing to write. It was a SYNTAX error until #145, reported as *"Unexpected
    identifier 'modoki'"*, which named neither `await` nor async and sent readers to a one-eval-per-read
    workaround. A returned promise is still awaited too, bounded by `EVAL_ASYNC_TIMEOUT_MS` (5s).
  - **An un-awaited promise NESTED in the result serializes as `[unresolved Promise — did you forget
    \`await\`?]`.** A pending thenable has no own enumerable properties, so `return { a: modoki.foo() }`
    used to come back `{"a":{}}` — an empty-looking *result* rather than a mistake, which is how it
    silently ate real debugging calls. The top-level `return modoki.foo()` is unaffected: that one is
    awaited.
  - **`timeoutMs` bounds the whole body, and the two surfaces cap DIFFERENTLY** — `modoki_eval`
    default 5000 / max 25000, `device_eval` default 4000 / **max 20000**. Out-of-range is clamped,
    not refused. Asking for more than the default also lifts the device's transport deadline with it
    (#153); the remaining asymmetry is the device's extra network hop. See the nested-deadline rule below.
- **Play/test the game:** `modoki_play_control {play|stop|pause|resume|step}` — press Play, exercise
  with `modoki_tap`/`modoki_drag`, read `get_scene_state`, then stop (reverts the authored snapshot).
- **Edit like a human (undoable):** `modoki_create_entity` (empty/primitive/2d/ui/camera/light/
  particle — identical to the Hierarchy menu), `modoki_duplicate_entity`, `modoki_delete_entities`,
  `modoki_reparent_entity`, `modoki_set_selection`, `modoki_gizmo`, `modoki_focus_entity`,
  `modoki_history {undo|redo}`. `modoki_prefab {instantiate|create|detach|overrides|apply|revert}`.
  `modoki_set_transform` sets position/rotation/scale in ONE call (partial merge) and — unlike a
  plain `setTrait` — routes a prefab INSTANCE's edit into its overrides instead of being silently
  ignored; prefer it over hand-building a `mutate_scene` op.
- **Fire native menu items:** `modoki_menu` — `list` returns the app-menu tree (each node's `path`/
  `id`/`accelerator`/`enabled`); `path:"View/Zoom In"` or `id:…` fires that item's click (the same
  callback a human's click runs). This is the ONLY way to reach menu-only actions — `modoki_press_key`
  cannot trigger native Electron menu accelerators (Chromium swallows them). *(Electron editor only.)*
  A path segment may itself contain `\` — on Windows every **File → Open Recent** entry is a native
  path — so the matcher splits on `/` and `>` only, and retries with `\` as a separator just for a
  human-typed `View\Zoom In`. It used to split on `\` first, which shredded those labels and made
  the whole Open Recent submenu unreachable while the refusal's own `available` list advertised the
  exact path it had refused. Switching projects from MCP goes through this submenu.
- **Keyboard focus:** `modoki_focus {selector?, panel?}` — `selector` sets `document.activeElement`,
  `panel` sets the editor KEYBOARD SCOPE; with neither, it blurs the focused element. ⚠️ **Driving a
  running GAME needs BOTH gates open, and the bare blur opens one**: keys are dropped while a DOM
  text field holds focus (blur fixes that) AND while any panel other than the GameView owns the
  scope (only `panel:"game"` fixes that). Assuming the blur was enough is what produced a false
  "the character controller is broken" — the two gates, and the warning `modoki_press_key` now
  emits, are in
  [editor-input.md → The runtime input gate](./editor-input.md#the-runtime-input-gate--mechanism-vs-policy).
  ⚠️ **Panel ids are CASE-SENSITIVE** and are the FlexLayout tab ids, not the prose names this doc
  uses — `"Game"` is not `game`. A panel with no open tab, or a miscased id, is **refused** (400,
  naming the ids that are open); `modoki_get_editor_state.openPanels` lists them. Until #301 it was
  neither refused nor applied: the call answered `ok:true` and every following keypress silently
  reached nothing.
- **Scenes/assets:** `modoki_list_scenes` / `modoki_load_scene` / `modoki_new_scene` /
  `modoki_save_all`; `modoki_import_file` (drag-from-Finder equivalent); `modoki_project_settings`
  (`action=set` is a PATCH deep-merged onto the on-disk config — a partial is safe, and omitted
  sections are untouched; the contract + its two refusals live in
  [editor.md → Project Settings — the save contract](./editor.md#project-settings--the-save-contract)).
- **Build/deploy (heavy):** `modoki_build {web|ios|android}` / `modoki_add_native_target {ios|android}`
  — wraps the Build menu's SSE pipeline, consumed to completion; minutes-long, installs on device.

Architecture: live-editor ops register into the bridge op registry (`registerAgentOp` in
`engine/app/debug/agentBridge.ts`) from the lazy editor path
(`engine/app/editor/agentEditorOps.ts`, wired in `setup.ts` `createGameEditor`) — so editor code
stays out of game web builds. Backend routes live in the shared `editorBackendRouter.ts`
(`/api/editor-state`, `/api/editor-action` [allowlisted], `/api/scenes`, `/api/import-file`), which
both the Vite dev server and the Electron main process mount — hence the dev/DMG parity.

## LIVE WORLD vs SCENE FILE — the one rule that makes tools compose

**Two different worlds, and nothing auto-saves between them.** Miss this and you get the
single most confusing failure on this surface: an entity that is *right there on screen* and
*returned by `get_scene_state`*, while a file-editing tool insists it does not exist.

| | Tools | Writes to |
|---|---|---|
| **LIVE world only** (the running editor; undoable, like the menus) | `create_entity`, `duplicate_entity`, `delete_entities`, `reparent_entity`, `prefab` (instantiate / detach), `history`, `set_selection`, `gizmo`, `collider_edit`, `play_control`, `set_timescale` | RAM. **Not saved.** |
| **LIVE world (or the FILE when there is no live world to hold it)** | `set_transform`, `mutate_scene`, `validate_scene` (reads) | see **Persistence** below |
| **LIVE, with the ASSET write parked until `save_all`** | `particle_set`, `anim_set_clip`, `anim_add_key`, `timeline_set`, `timeline_add_clip` (read one back with `read_asset_def`) | RAM now; disk on `save_all` (see below) |
| **ASSET file only** | `write_asset`, `create_asset`, `import_file`, `reimport_asset` | disk, unconditionally — explicit write tools |
| **ASSET file *and* the LIVE world** | `prefab` (**create** → writes the `.prefab.json` **and** tags the source entities as a `PrefabInstance` in the live world, **unsaved** — run `save_all` to persist that linkage into the scene, or a reload discards it) | disk + RAM |
| **Both worlds** | `save_all` (live → disk, **and flushes any pending dirty assets — see below**), `load_scene` / `new_scene` (disk → live, **replacing** the live world) | — |
| **Reads the LIVE world** | `get_scene_state`, `get_layout_bounds`, `watch`, `journal`, `diagnose`, `capture_viewport`, `capture_gesture`, `get_editor_state` | — |
| **Reads the FILE** | `build`, `list_scenes`, `list_assets` | — |

**The rule: a file tool cannot see live work until you `save_all`.**

```
create_entity   → {id, name, guid}   ← live only; the file knows nothing about it
set_transform   → "no entity matching {guid} in this scene FILE"
                  hint: "…DO exist in the live editor world right now but are not in the
                         scene file yet … Run modoki_save_all, then retry."
save_all        → now the file has it
set_transform   → ok
```

That failure mode is now mostly historical for `set_transform`/`mutate_scene` specifically — with a
renderer on the targeted scene they go through the LIVE world (see **Persistence** below), so they
see live work rather than missing it. It still applies verbatim to any tool reaching a scene FILE
that isn't the one the editor has open live.

**Why not just auto-save?** Because the editor is a *shared* surface: an implicit save would
commit the human collaborator's unrelated unsaved work. A surprise write is worse than a
clear error, so file tools **fail with the fix in the message** instead. This is also why the
`auto` persistence mode was removed rather than kept as an option.

### Persistence: MANUAL-ONLY (mcp-persistence.md)

**A live edit never reaches disk on its own. `modoki_save_all` is the only thing that writes.**
Every mutating tool's result carries `saved: true|false` so you never have to *infer* it, and
`modoki_get_editor_state` echoes `persistenceMode: 'manual'`.

There used to be an `auto` mode (the default) in which a live mutation ALSO saved immediately, and
a `manual` mode that parked it. **`auto` was removed** (2026-07-30) so a tool's effect never depends
on invisible session state set in some earlier turn — "did that save?" is now answerable without
asking. `modoki_persistence` is consequently a **read**; passing `mode` gets a 400, not silence.

What that means per tool:

- **`mutate_scene` / `set_transform`**, when a renderer has this exact scene open, apply to the LIVE
  world as **one undoable step** (a human can Cmd-Z the whole tool call, not just its last op) and
  do **not** touch the file. `saved: false`, with a hint naming `save_all`.
- **`particle_set` / `anim_set_clip` / `anim_add_key` / `timeline_set` / `timeline_add_clip`** apply
  live immediately (so the panel/viewport updates) and park the disk write in a **dirty-asset
  registry**. `get_editor_state`'s `dirtyAssetPaths` (omitted when empty) lists what is pending —
  the Percept answer to "what would `load_scene`/discard destroy?".
  **Read one back with `modoki_read_asset_def`** — the READ half of that family, and the reason it
  exists: those five tools all take a FULL definition, so without it you could neither obtain a def
  to modify nor VERIFY an edit (the write returns `{ok:true}` and the only other check was judging a
  rendered frame — see the "verify by DATA" rule above). It reads the **LIVE** cache, not the file,
  which is the whole point under manual persistence: an unsaved edit exists only live, so a file
  read would report the pre-edit value and make a successful edit look like a no-op. `unsaved: true`
  means a write is parked for it. What it returns is the **authored** def in every case — including
  `rig2d`, whose live cache holds a runtime structure (packed `Float32Array`s, weights already
  renormalized, v1 promoted to v2 parts). Reporting that was a real trap: the float32 weights it
  handed back were read as the editor corrupting a rig on load (QA-ASSET-0015), and the actual disk
  churn was somewhere else entirely.
- **`write_asset` / `create_asset` / `import_file` / `reimport_asset`** always write. They are
  explicit "write this file" tools, not live-state edits.
- **The live-world entity/prefab tools** (`create_entity`, `duplicate_entity`, `delete_entities`,
  `reparent_entity`, `prefab` instantiate/detach) never saved. Unchanged — that split predates the
  mode knob and is orthogonal to it.
- **`save_all` flushes BOTH**: it serializes the live scene AND writes every pending dirty asset
  (each through the same validated `/api/asset-write` route). An entry that fails to write is **left
  pending** (never silently dropped) and reported in `assets.failed`; successes move to
  `assets.saved`.

**The FILE-DIRECT fallback is not `auto` coming back.** When no editor is connected, or the call
targets a scene FILE that ISN'T the one open live, or an op is `setBaseScene` (no live-world
equivalent — it changes what the scene *loads*, not any live entity's state), the call writes the
file, because **there is no live world to hold the edit**. This keeps the browser-free curl-editing
path intact. Trust `saved` and `mode` in the result over assuming which path a call took.

⚠️ **Consequence you WILL hit: `unsavedChanges: true` is now the normal state after any agent edit**,
and three things are gated on it. All three were rare under `auto` and are routine now:

| Gate | Behaviour |
|---|---|
| `modoki_build` | **REFUSES** while unsaved — it reads the FILE, so the artifact would miss your work (`force: true` builds the on-disk scene deliberately) |
| file-direct `mutate_scene` (other scene, or `setBaseScene`) | **409s** while unsaved — its write would hot-reload the scene and destroy live-only work |
| a game-code (`.ts`) edit | force-reloads the editor and **DISCARDS** unsaved scene edits after a 5s countdown (CLAUDE.md) |

So: **`save_all` before a build, before a scene swap, and before editing game code** — and don't let
unsaved work pile up across a long session.

The per-call `save?: boolean` param on every mutating tool's schema is **ignored**. It is kept only
so existing callers don't break; don't pass it.

### The corollaries (each was a real, silent bug the MCP re-audit closed)

- **Address entities by `guid`, never `id`.** Runtime ids are reassigned on every hot-reload, and
  the *file* has its own id namespace, so a stale id can resolve to a **different** entity — a silent
  wrong-target on a destructive op. `create_entity`/`duplicate_entity` return the guid, and every
  live-world mutator accepts it: `delete_entities`/`duplicate_entity`/`reparent_entity`/`focus_entity`/
  `set_selection` (and `create_entity`'s parent, `prefab`'s entity/parent) take `guid`/`guids` (wins
  over `id`), as `mutate_scene`/`set_transform`/`get_scene_state {guid}` already did.
- **`load_scene`/`new_scene` REFUSE when there is unsaved live work** (a scene edit OR a
  pending dirty asset) — both would replace/discard it. `save_all` first, then the reload is
  lossless. (`discardUnsaved: true` discards deliberately — renamed from `force` in #261's
  close-out, because `force` on the BUILD family destroys nothing and one word cannot mean both.)
  `mutate_scene`/`set_transform` used to carry
  the SAME refusal for the mirror-image reason (their file write would hot-reload the scene and
  destroy unsaved live-only entities) — that guard is now unreachable in practice: whenever a
  renderer is connected on the targeted scene, the call goes through the LIVE world first (see
  **Persistence** above), so it *joins* whatever unsaved work already existed instead of
  destroying it. The guard still fires for genuine file-direct calls (no renderer, wrong scene,
  or `setBaseScene`).
- **`build` REFUSES on unsaved changes** — it reads the FILE, so the artifact would be
  missing your work. `force: true` builds the on-disk scene deliberately.
- **`save_all` after `new_scene` needs `{path}`** — there is no path yet, and the Save-As
  panel can only be dismissed by a human.
- **A tool result means what it says.** A tool that did nothing now FAILS; it does not return
  a cheerful `ok:true` with the bad news buried in a field. `unsavedChanges` on
  `get_editor_state` tells you where you stand. The re-audit swept this across the whole surface:
  `tap_handle`/`drag_handle` refuse an off-screen, disabled, or OCCLUDED handle and report
  `occluded` (a BOOLEAN, always present) + `occludedBy`, per endpoint for `drag_handle` (S3.17) —
  `allowOccluded:true` presses anyway. Occluded was a *warning that still dispatched* until
  2026-08-19: a 2D gizmo handle under the SceneView's own toolbar pressed the TOOLBAR and answered
  `ok:true`, and the covered press was filed as "the handle is completely inert" (testboard
  5jE5Tip6Qwp7s7YVAYoH — it was not; the same handle moved the entity on the first try once it was
  out from under the toolbar);
  `dispatch_action`/`play_clip` fail on an unknown name / stale guid / no-animator target;
  `reimport`/`import_file` fail on a no-match / unrecognized type; `timeline_set` fails when
  normalization drops a malformed item; `capture_gesture` requires the game Playing; and `diagnose`
  only counts console errors from the last 30s (a stale error no longer pins `ok:false`).

### Three more agent-facing gotchas (base-scene / persistence workstream)

- **`modoki_load_scene` stops Play first, so it CANNOT be used to test a real in-game
  scene swap** (`Time.elapsed` reverts through the Play-press snapshot instead of
  carrying forward). To drive a live swap the way a real win-event handler would,
  call it through `modoki_eval` instead: `window.__sceneManager.loadScene(path)`.
- **A generic 500/504 from `modoki_load_scene`/`modoki_mutate_scene` can mean the
  editor's Vite child died, not that the scene file is bad.** Before suspecting the
  data, check `modoki_get_console_logs` and confirm `vitePort` (from
  `modoki_identity`) is actually reachable — Electron can stay up while its Vite
  child process has died underneath it.
- **`modoki_set_transform` on a ghosted (base-scene-origin) entity is NOT blocked,
  and that's correct** — ghosting is editor-UI only, so a script/agent write is the
  "runtime" side of that line by design. What IS refused is a gizmo DRAG (no handles
  exist to grab on a ghosted entity). Prove the difference by comparing screenshots
  of a ghosted vs. non-ghosted selection, not by calling `modoki_set_transform` and
  expecting it to error.

## Failures: one envelope, one closed code set

**Every failed tool call answers three questions: what was attempted, why it failed, what to do
instead.** `isError: true` plus a single shape (full contract:
[mcp-tool-conventions.md](./mcp-tool-conventions.md) §5):

```jsonc
{ "error": {
    "code": "NOT_FOUND",              // from the closed set below
    "tool": "modoki_set_transform",   // stamped centrally — always present
    "what": "…what was attempted, in YOUR terms",
    "why":  "…the actual cause",
    "got":  "…what was received (structured, not a nested JSON string)",
    "expected": "…the shape that would work",
    "options": ["…the real choices"]  // this is the field that unblocks you
} }
```

`UNKNOWN_PARAM` · `AMBIGUOUS` · `NOT_FOUND` · `AMBIGUOUS_SURFACE` · `OCCLUDED` · `REFUSED_BY_OP` ·
`NO_RENDERER` · `TIMEOUT` · `TOO_LARGE` · `REQUIRES_SAVE` · `NOT_AVAILABLE_HERE` · `PARTIAL`.

**Read the `code` before the prose** — it tells you whether to retry, re-aim, save first, or stop:

| code | what it means for your next call |
|---|---|
| `NOT_FOUND` / `AMBIGUOUS` | your AIM was wrong — re-read state and address by `guid` |
| `AMBIGUOUS_SURFACE` | the entity is on screen in several viewports — pass `surface` |
| `OCCLUDED` | something covers the target; the input was NOT sent somewhere else |
| `REFUSED_BY_OP` | the operation itself declined — including a no-op you asked to change |
| `REQUIRES_SAVE` | live-world work isn't on disk; `modoki_save_all`, or force deliberately |
| `NOT_AVAILABLE_HERE` | **could not look** — never read this as "nothing is there" |
| `TIMEOUT` | retryable; the editor may be busy or wedged |
| `PARTIAL` | some of it applied. A batch is not a transaction — verify before retrying |

Two distinctions this exists to protect, both of which were real silent bugs:

- **"Could not look" is never "nothing is there."** An unreachable source, an absent route, an empty
  trait registry → `NOT_AVAILABLE_HERE`, not an empty answer. `list_traits {name:'Transform'}` once
  answered *"unknown trait"* when the registry simply hadn't loaded, and the agent abandoned a
  perfectly good `setTrait`.
- **A no-op you asked to change is a FAILURE.** `changed:0`, or a write whose keys the loader
  ignores, is `REFUSED_BY_OP` naming the real field names — not `{ok:true}`.

If you are WRITING a tool: `ctx.fail(...)` / `ctx.httpFailure(...)` are the only ways to fail (the
device server: `deviceFail` / `caughtFailure` / `deviceReplyFailure`). There is deliberately no
free-text error constructor — a failure with no code is a failure nobody can act on.

## Tool catalog — every `modoki_*` tool, generated from the contract table

The prose above says which tool to reach for and why; this table is the **facts** — endpoint, whether
it mutates, whether Cmd-Z takes it back, what must be true for it to work, how it is aimed, and the
smallest call that is valid. It is **generated from `engine/tools/modoki-mcp/src/contracts.ts`**, which
is also what the batch pre-flight, the conformance tests, the over-cap hints and the live sweep read —
so a fact appears here once and cannot drift into a plausible-looking lie. `npm test` fails if the
table and the table-of-record disagree.

Two things the table is worth reading FOR, not just referring to:
- **`Smallest call`** is the exact object the T2 fixtures and the live sweep call each tool with, so it
  is machine-checked copy-paste. It is deliberately the *ergonomic* form (the laziest valid call), not
  a defensive one — every one of the nine bugs the batch pass found hid behind a defensively-complete
  call that a test would naturally write.
- **`Effect`** is the answer to "will this survive, and can I take it back": `live` is lost on a scene
  swap, `file` is on disk, `both` does both, `session` is editor state (selection, gizmo, watchers),
  and `undoable` means a human's Cmd-Z unwinds it as ONE step. Persistence is MANUAL-only — see the
  LIVE WORLD vs SCENE FILE section above.

⚠️ **This catalog is the STATIC surface only.** A game can also register its own tools
(`registerAgentTool`), which appear beside these, come and go with the open project, and have no
`contracts.ts` entry — so they are not, and cannot be, in this table. See
[agent-tools.md](./agent-tools.md).

<!-- BEGIN GENERATED TOOL CATALOG -->

*99 tools. Generated from `engine/tools/modoki-mcp/src/contracts.ts` — do NOT hand-edit;
run `npm --prefix engine/tools/modoki-mcp run gen:catalog`. A drifted table fails `npm test`.*

#### Read — answer a question about state (never changes anything)

| Tool | Endpoint | Effect | Needs | Aim | Smallest call |
|---|---|---|---|---|---|
| `modoki_asset_schema` | GET `/api/asset-schema` | read-only | editor | — | `{"type":"particle"}` |
| `modoki_capture_viewport` | POST `/api/capture-viewport` | read-only | editor + electron | — | *(no args)* |
| `modoki_diagnose` | GET `/api/diagnose` | read-only | editor + scene | — | *(no args)* |
| `modoki_editor_journal` | GET `/api/editor-journal` | session · **IMPURE READ** (an optional arg destroys state) | editor | — | *(no args)* |
| `modoki_eval_api` | GET `/api/eval-api` | read-only | editor + renderer | — | *(no args)* |
| `modoki_find_references` | GET `/api/find-references` | read-only | project | asset | `{"target":"/assets/scenes/main.scene.json"}` |
| `modoki_get_asset_meta` | GET `/api/read-meta` | read-only | project | asset | `{"path":"/assets/textures/probe.png"}` |
| `modoki_get_console_logs` | GET `/api/console-logs` | read-only | editor | — | *(no args)* |
| `modoki_get_editor_state` | GET `/api/editor-state` | read-only | editor | — | *(no args)* |
| `modoki_get_layout_bounds` | GET `/api/layout-bounds` | read-only | editor + renderer | — | *(no args)* |
| `modoki_get_scene_state` | GET `/api/scene-state` | read-only | editor + scene | — | *(no args)* |
| `modoki_handles` | GET `/api/enact-handles` | read-only | editor | — | *(no args)* |
| `modoki_identity` | — | read-only | editor | — | *(no args)* |
| `modoki_journal` | GET `/api/journal` | session · **IMPURE READ** (an optional arg destroys state) | editor + renderer | — | *(no args)* |
| `modoki_list_actions` | GET `/api/game-introspect` | read-only | editor + renderer | — | *(no args)* |
| `modoki_list_assets` | GET `/api/scan-assets` | read-only | project | — | *(no args)* |
| `modoki_list_creatable_assets` | GET `/api/creatable-assets` | read-only | editor | — | *(no args)* |
| `modoki_list_scenes` | GET `/api/scenes` | read-only | project | — | *(no args)* |
| `modoki_list_traits` | GET `/api/trait-schema` | read-only | editor | — | *(no args)* |
| `modoki_ota_status` | GET `/api/ota/status` | read-only | project | — | *(no args)* |
| `modoki_player_prefs` | GET `/api/player-prefs` | read-only | editor | — | *(no args)* |
| `modoki_read_asset_def` | GET `/api/asset-def` | read-only | editor | asset | `{"path":"/assets/particles/probe.particle.json"}` |
| `modoki_render_scene` | POST `/api/render-scene` | read-only | editor + renderer + scene | — | *(no args)* |
| `modoki_render_sequence` | POST `/api/render-sequence` | read-only | editor + renderer + scene | — | *(no args)* |
| `modoki_resolve_refs` | GET `/api/resolve-refs` | read-only | project | — | `{"refs":["00000000-0000-0000-0000-000000000000"]}` |
| `modoki_scene_query` | POST `/api/scene-query` | read-only | editor + scene | point | `{"kind":"point","dim":"3d","point":[0,0,0]}` |
| `modoki_unused_assets` | GET `/api/unused-assets` | read-only | project | — | *(no args)* |
| `modoki_validate_prefab` | GET `/api/validate-prefab` | read-only | project | asset | `{"path":"/assets/prefabs/probe.prefab.json"}` |
| `modoki_validate_scene` | GET `/api/validate-scene` | read-only | project | asset | `{"path":"/assets/scenes/main.scene.json"}` |
| `modoki_wait_for_edit` | GET `/api/wait-for-edit` | read-only | editor | — | `{"timeoutMs":50}` |

#### Mutate — change scene/world data

| Tool | Endpoint | Effect | Needs | Aim | Smallest call |
|---|---|---|---|---|---|
| `modoki_create_entity` | POST `/api/editor-action` `create-entity` | live · undoable | editor + scene | — | `{"kind":"empty"}` |
| `modoki_create_registered_asset` | POST `/api/editor-action` `create-registered-asset` | file | editor + project | asset | `{"kind":"material","path":"/assets/materials/probe.mat.json"}` |
| `modoki_delete_asset` | POST `/api/delete-asset` | file | project | asset | `{"paths":["/assets/particles/probe.particle.json"]}` |
| `modoki_delete_entities` | POST `/api/editor-action` `delete-entities` | live · undoable | editor + scene | entity | *(no args)* |
| `modoki_discard_asset_edits` | POST `/api/editor-action` `discard-asset-edits` | session | editor | — | `{"all":true}` |
| `modoki_duplicate_entity` | POST `/api/editor-action` `duplicate-entity` | live · undoable | editor + scene | entity | *(no args)* |
| `modoki_mutate_scene` | POST `/api/scene-mutate` | live · undoable | editor + scene | entity | `{"ops":[{"op":"addEntity","name":"ContractProbe","parentId":0}]}` |
| `modoki_prefab` | POST `/api/editor-action` `prefab` | both · undoable | editor + scene | entity | `{"action":"instantiate","path":"/assets/prefabs/probe.prefab.json"}` |
| `modoki_reparent_entity` | POST `/api/editor-action` `reparent-entity` | live · undoable | editor + scene | entity | *(no args)* |
| `modoki_save_all` | POST `/api/editor-action` `save-all` | file | editor | — | *(no args)* |
| `modoki_set_transform` | POST `/api/scene-mutate` | live · undoable | editor + scene | entity | `{"entity":{"name":"ContractProbe"},"space":"local","position":[1,2,3]}` |
| `modoki_write_player_prefs` | POST `/api/player-prefs` | file | editor | — | `{"action":"flush"}` |

#### Asset — read or write an asset definition

| Tool | Endpoint | Effect | Needs | Aim | Smallest call |
|---|---|---|---|---|---|
| `modoki_anim_add_key` | POST `/api/editor-action` `anim-add-key` | live · undoable | editor | asset | `{"clipPath":"/assets/anim/probe.anim.json","trait":"Transform","field":"x","time":0,"value":1}` |
| `modoki_anim_set_clip` | POST `/api/editor-action` `anim-set-clip` | live · undoable | editor | asset | `{"clipPath":"/assets/anim/probe.anim.json","clip":{}}` |
| `modoki_create_asset` | POST `/api/create-asset` | file | project | asset | `{"type":"particle","path":"/assets/particles/probe.particle.json"}` |
| `modoki_create_folder` | POST `/api/create-folder` | file | project | asset | `{"path":"/assets/probe-folder"}` |
| `modoki_duplicate_asset` | POST `/api/duplicate-asset` | file | project | asset | `{"from":"/assets/particles/probe.particle.json","to":"/assets/particles/probe-copy.particle.json"}` |
| `modoki_import_file` | POST `/api/import-file` | file | project | — | `{"srcPath":"/tmp/probe.png","destFolder":"/assets/textures"}` |
| `modoki_move_asset` | POST `/api/move-file` | file | project | asset | `{"from":"/assets/particles/probe.particle.json","to":"/assets/particles/moved.particle.json"}` |
| `modoki_particle_set` | POST `/api/editor-action` `particle-set` | live · undoable | editor | asset | `{"path":"/assets/particles/probe.particle.json","def":{}}` |
| `modoki_reimport_asset` | POST `/api/reimport` | file | project | asset | `{"path":"/assets/textures/probe.png"}` |
| `modoki_timeline_add_clip` | POST `/api/editor-action` `timeline-add-clip` | live · undoable | editor | asset | `{"timelinePath":"/assets/timelines/probe.timeline.json","trackType":"animation","item":{}}` |
| `modoki_timeline_set` | POST `/api/editor-action` `timeline-set` | live · undoable | editor | asset | `{"timelinePath":"/assets/timelines/probe.timeline.json","timeline":{}}` |
| `modoki_write_asset` | POST `/api/asset-write` | file | project | asset | `{"path":"/assets/particles/probe.particle.json","type":"particle","data":{}}` |
| `modoki_write_asset_meta` | POST `/api/write-meta` | file | project | asset | `{"path":"/assets/textures/probe.png","meta":{}}` |

#### Input (Enact) — trusted input injection

| Tool | Endpoint | Effect | Needs | Aim | Smallest call |
|---|---|---|---|---|---|
| `modoki_capture_gesture` | POST `/api/capture-gesture` | no persistence | editor + electron | point | `{"from":{"x":0,"y":0},"to":{"x":10,"y":10}}` |
| `modoki_dnd` | POST `/api/editor-action` `dom-dnd` | no persistence | editor + electron | selector | `{"from":{"selector":"#a"},"to":{"selector":"#b"}}` |
| `modoki_drag` | POST `/api/input/drag` | no persistence | editor + electron | entity | `{"from":{"selector":"#a"},"to":{"selector":"#b"}}` |
| `modoki_drag_handle` | POST `/api/input/drag-handle` | no persistence | editor + electron | handle | `{"id":"probe-handle","to":{"x":10,"y":10}}` |
| `modoki_focus` | POST `/api/input/focus` | no persistence | editor + electron | selector | `{"selector":"#probe"}` |
| `modoki_hover` | POST `/api/input/hover` | no persistence | editor + electron | entity | `{"selector":"#probe"}` |
| `modoki_pointer` | POST `/api/input/pointer` | no persistence | editor + electron | entity | `{"action":"down","selector":"#probe"}` |
| `modoki_press_key` | POST `/api/input/key` | no persistence | editor + electron | — | `{"key":"Escape"}` |
| `modoki_scroll` | POST `/api/input/scroll` | no persistence | editor + electron | entity | `{"selector":"#probe"}` |
| `modoki_tap` | POST `/api/input/tap` | no persistence | editor + electron | entity | `{"selector":"#probe"}` |
| `modoki_tap_handle` | POST `/api/input/tap-handle` | no persistence | editor + electron | handle | `{"id":"probe-handle"}` |
| `modoki_type_text` | POST `/api/input/type` | no persistence | editor + electron | — | `{"text":"probe"}` |

#### Control — drive the editor session, not scene data

| Tool | Endpoint | Effect | Needs | Aim | Smallest call |
|---|---|---|---|---|---|
| `modoki_collider_edit` | POST `/api/editor-action` `set-collider-edit` | session | editor | — | `{"on":true}` |
| `modoki_dispatch_action` | POST `/api/editor-action` `dispatch-action` | no persistence | editor + renderer | — | `{"name":"probe"}` |
| `modoki_eval` | POST `/api/eval` | no persistence | editor + renderer | — | `{"code":"return 1 + 1;"}` |
| `modoki_exit_pose_envelope` | POST `/api/editor-action` `exit-pose-envelope` | live | editor + scene | — | *(no args)* |
| `modoki_focus_entity` | POST `/api/editor-action` `focus-entity` | no persistence | editor + scene | entity | *(no args)* |
| `modoki_gizmo` | POST `/api/editor-action` `set-gizmo` | session | editor | — | *(no args)* |
| `modoki_history` | POST `/api/editor-action` *(op = your `action`)* | live | editor | — | `{"action":"undo"}` |
| `modoki_hit_regions` | GET `/api/hit-regions` | session | editor + renderer | — | `{"action":"read"}` |
| `modoki_input_watch` | GET `/api/input-watch/read` *(both varies)* | session | editor + renderer | — | `{"action":"read"}` |
| `modoki_load_scene` | POST `/api/editor-action` `load-scene` | live | editor + project | asset | `{"path":"/assets/scenes/main.scene.json"}` |
| `modoki_menu` | POST `/api/menu` | session | editor + electron | — | *(no args)* |
| `modoki_new_scene` | POST `/api/editor-action` `new-scene` | live | editor + project | — | *(no args)* |
| `modoki_open_animation_editor` | POST `/api/editor-action` `open-animation-editor` | session | editor + scene | asset | `{"path":"/assets/animations/probe.anim.json"}` |
| `modoki_open_nine_slice_editor` | POST `/api/editor-action` `open-nine-slice-editor` | no persistence | editor | asset | `{"path":"/assets/textures/probe.png"}` |
| `modoki_open_particle_editor` | POST `/api/editor-action` `open-particle-editor` | no persistence | editor | asset | `{"path":"/assets/particles/probe.particle.json"}` |
| `modoki_open_sprite_editor` | POST `/api/editor-action` `open-sprite-editor` | no persistence | editor | asset | `{"path":"/assets/textures/probe.png"}` |
| `modoki_persistence` | POST `/api/persistence` | no persistence | editor | — | *(no args)* |
| `modoki_play_clip` | POST `/api/editor-action` `dispatch-action` | no persistence | editor + renderer | entity | `{"guid":"00000000-0000-0000-0000-000000000000","clip":"Idle"}` |
| `modoki_play_control` | POST `/api/editor-action` *(op = your `action`)* | session | editor | — | `{"action":"stop"}` |
| `modoki_pose_clip` | POST `/api/editor-action` `pose-clip` | live | editor + scene | — | `{"t":0}` |
| `modoki_profiler` | GET `/api/profiler` *(method varies)* | session | editor + renderer | — | *(no args)* |
| `modoki_project_settings` | GET `/api/project-settings` *(method varies)* | file | project | — | `{"action":"get"}` |
| `modoki_scene_view_mode` | POST `/api/editor-action` `set-scene-view-mode` | session | editor | — | `{"mode":"3d"}` |
| `modoki_set_playhead` | POST `/api/editor-action` `set-playhead` | session | editor | — | `{"t":0}` |
| `modoki_set_selection` | POST `/api/editor-action` `set-selection` | session | editor | entity | *(no args)* |
| `modoki_set_timescale` | POST `/api/editor-action` `set-timescale` | no persistence | editor + renderer | — | `{"scale":1}` |
| `modoki_watch` | GET `/api/watch/list` *(both varies)* | session | editor + renderer | — | `{"action":"list"}` |

#### Build — long-running toolchain work

| Tool | Endpoint | Effect | Needs | Aim | Smallest call |
|---|---|---|---|---|---|
| `modoki_add_native_target` | GET `/api/add-native-target` | file | project | — | `{"platform":"ios"}` |
| `modoki_build` | GET `/api/build` | file | project | — | `{"platform":"web"}` |
| `modoki_ota_keygen` | POST `/api/ota/keygen` | file | project | — | *(no args)* |
| `modoki_ota_publish` | GET `/api/ota/publish` | file | project | — | `{"version":"1.0.0"}` |

#### Meta — operates on the tool surface itself

| Tool | Endpoint | Effect | Needs | Aim | Smallest call |
|---|---|---|---|---|---|
| `modoki_batch` | — | live | editor | — | `{"steps":[{"tool":"wait","args":{"ms":1}}]}` |
<!-- END GENERATED TOOL CATALOG -->

### `device_*` vs `modoki_*` — the naming asymmetries, stated once

The two surfaces answer several of the same questions under different names. This is **historical, not
meaningful**, and it is recorded here rather than renamed away: an alias churn would break every
existing agent call for a cosmetic win. Read across:

| Question | Editor | Device |
|---|---|---|
| recent console output | `modoki_get_console_logs` | `device_console_logs` |
| screen-space rects | `modoki_get_layout_bounds` | `device_layout_bounds` |
| a picture of it | `modoki_capture_viewport` | `device_screenshot` |
| what can I dispatch? | `modoki_list_actions` | `device_introspect` |
| the GAME's own tools | they appear as tools (`court_load_level`) | `device_game_tools` + `device_game_tool_call` — deliberately NOT a dynamic tail; see [agent-tools.md](agent-tools.md) |

**Editor-only BY NATURE, recorded rather than filed as a gap — the §9 ledger.** A capability on one
surface and not the other is a *finding*: either closed, or written down here with the reason.

| Editor-only tool | Why there is nothing for a device counterpart to do |
|---|---|
| `modoki_find_references` | see below |
| `modoki_delete_asset` | trashes files in the PROJECT CHECKOUT. A device carries a built bundle, not a checkout, and its assets are baked into the app package. |
| `modoki_create_registered_asset` · `modoki_list_creatable_assets` | the "New X" registry is an EDITOR panel surface writing into the project on disk. Same reason. |
| `modoki_pose_clip` · `modoki_open_animation_editor` · `modoki_exit_pose_envelope` | all three turn on the editor's **preview envelope** — a snapshot of the authored world that ⏹ Exit reverts to, plus a run-mode that blocks a scene save. A device build has no Animation panel, no envelope, and nothing to revert a pose *to*. |

**Closed rather than recorded (#288 Phase 6):** `device_player_prefs`,
`device_write_player_prefs` and `device_scene_query` ship alongside their `modoki_*` twins, because
both ops register in `agentBridge.ts` (runtime) and the device runtime therefore already had them.
Prefs in particular matter *more* here: on a device the store is a real player's save data,
namespaced by appId, which is why `action:'clear'` requires `confirm:true` on **both** surfaces —
one rule, not a device-only precaution.

**Still asymmetric the other way, and it is a real gap rather than a deliberate one:**
`device_invalidate_assets` exists and there is no `modoki_invalidate_assets`, even though the
`invalidate-assets` op is registered in `agentBridge.ts` and the editor drives it internally from
`/api/reimport`. Recorded here so it is not rediscovered as a surprise; it is not part of #288's
five gaps.

**`modoki_find_references`.** It answers
"what references this?" by walking the PROJECT ON DISK — the tree-shaker's own forward walk,
inverted (#284). A device has no project checkout, only a built bundle whose reference graph has
already been resolved and shaken, so there is nothing on that side for a device counterpart to read.
This is the §9 "capability on one surface and not the other" case closed as deliberate, not left
implicit. (It also means the tool is blind to unsaved live-world edits on the editor side — see its
description.)

Where the two DO share a param name, they now mean the same thing — `device_scroll` took `dx`/`dy`
against the editor's `deltaX`/`deltaY` until the Phase-8 device sweep; `deltaX`/`deltaY` are canonical
on both now, with `dx`/`dy` kept as aliases. **Editor-only by nature** (no game equivalent exists):
`tap_handle` / `drag_handle` / `dnd` / `focus` (editor chrome + Canvas2D authoring),
`play_control` / `history`, `identity`.

**The device is no longer read-only (#166).** It used to be: of ~20 registered ops every one was a
read except `dispatch-action` (which the game must implement) and `set-timescale`, so any "what if X
were hidden/smaller/absent?" question cost an engine edit + web build + `cap sync` + native build +
install + cold launch — ~3 minutes per question. The write ops now live in `agentBridge.ts`
(**runtime**), not `agentEditorOps.ts`, which is what puts them on the device AND in both eval APIs
at once: `modoki.setTraits(…)`, `modoki.duplicateEntity(…)`, `modoki.simStep(…)` are callable from
inside a `device_eval` body, so a read → filter-in-JS → write → measure loop runs in ONE lease round
trip. That composition — not the typed tool — is the thing that replaces the rebuild cycle.

**Remaining device gaps**, logged as features rather than audit fixes: no device `render_scene` (it
returns a JPEG data URL and needs the decode-to-path handling `device_screenshot` has, or it blows
the response budget), and no fixed-dt stepping (see `device_step` above).

#### Nested deadlines — why `device_eval` caps at 20000ms and `modoki_eval` at 25000ms

**A timeout is only real if it is the SHORTEST one in its chain.** Both eval surfaces violated that,
so `EVAL_ASYNC_TIMEOUT_MS = 5000` — the one number anybody could see — was unreachable on each, and a
slow eval reported a dead transport instead of what the code was doing:

| Layer | Editor (`modoki_eval`) | Device (`device_eval`) |
|---|---|---|
| the eval's own budget | `timeoutMs` — default 5000, **max 25000** | `timeoutMs` — default 4000, **max 20000** |
| transport | HMR relay `requestBrowser` — was a fixed **3000**, now `op + 10s` | `TcpLeaseTransport` — was a fixed **5000** per CONNECTION, now `op + 5s` per REQUEST |
| outermost | MCP client abort — was a fixed **30000**, now `op + 15s` | (the device MCP sets no client deadline) |

The editor's relay took an explicit deadline all along (`/api/wait-for-edit` already passed one), so
its layers are sized from the op's budget and each is strictly larger than the one inside it.

**The device could not do that until #153.** `TcpLeaseTransport.request()` took no per-request
timeout, so its 5000ms was fixed for the whole connection *and its clock starts host-side, before the
request reaches the device* — which is why an equal 5000 always lost, and why the device cap sat at
4500 with a comment telling you not to raise it. The transport now takes an optional deadline per
request, `/api/device/request` sizes it from the op's own `timeoutMs` + 5s, and the cap is a policy
choice again. Two properties keep the override safe: it can only EXTEND the connection default (a
caller cannot shorten one into a spurious failure), and it is bounded by a 60s ceiling (a hung device
still fails, instead of holding the link open past the point reconnect would have noticed).

Note the constraint that remains: the **default** (4000) still sits under the 5000ms connection
default, so an eval that names no budget gets its own timeout message rather than a transport one.
Only a caller that asks for more lifts the transport deadline with it. And the device ceiling stays
strictly below the editor's on purpose — the device pays a real network hop the editor does not.

Three files restate this rule with hand-kept constants, deliberately and with comments saying so:
`bridgeHelpers.ts` (renderer, ships in the game), `editorBackendRouter.ts` (cannot import the
renderer bundle), and the MCP's `context.ts`. A shared module would be better, but the only place all
three could import from is `engine/tools/shared/`, which the shipped renderer has no business
depending on — so the restatement is guarded by tests rather than removed.

## Response budget (read this before adding a tool)

**Summary first, drill down on demand.** A bare call answers *what exists / how much*; a filter buys
the detail. A tool that returns 40k tokens can be called once before it crowds out the task it was
meant to serve. Concretely: `get_scene_state` → an index, `get_layout_bounds` / `list_assets` /
`handles` → counts, the journals + console → a tail plus a histogram of the whole ring, `watch` →
stats. Every one names its drill-down in a `hint`.

Three rules, each learned by breaking something:
- **Shape the payload at the BOUNDARY — the MCP tool, the HTTP route, or the agent op — never in a
  shared PRODUCER.** `diagnose`, `WatchTab`, and `JournalTab` read those producers in-process; a
  default applied there blanks a human's panel to save the agent tokens, and no test will catch it.
  (`handles` is the instructive exception: its boundary is the *router*, because `inputRoutes.ts`
  calls the op itself to resolve `tap_handle`.)
- **Never silently ignore a parameter.** A filter that doesn't change the answer is worse than a
  missing one — the caller believes it narrowed. An explicit `limit` always wins over a default.
- **Advertise the filters in the tool description.** An unadvertised filter gets called unfiltered.

Never truncate a payload mid-JSON: over the 60,000-char cap, `ok()` returns a valid
`{elided, bytes, hint, preview}` envelope.

**Measure tokens, not characters.** `chars/4` under-reports these JSON payloads by 25–38%, and it
mis-ranks the fields: hex GUIDs fragment (~1.8 chars/token) while trait names tokenize efficiently,
so `guid` is 43% of the bare index by tokens but only 26% by characters. Two corollaries — a dense
alphabet is a *false* economy for an LLM-facing payload (a 17-char base62 id costs 16 tokens; a
12-char hex id costs 6), and long float literals cost far more than their usefulness (hence the
9-significant-digit default on `get_scene_state`/`get_layout_bounds`/`watch`, worth 22.6k tokens
across the drill-downs). Full design + the measured per-tool budgets: [mcp-response-budget.md](./mcp-response-budget.md).

## Percept — verify by data, not pixels

**Claude is weak at visual feel — give it numbers/events.** This is **Percept**, the engine's
AI-perception layer. Three primitives × two subjects: **Snapshot** ("what's true now?" —
`get_scene_state`/`get_layout_bounds`/
`diagnose`/`get_editor_state`), **Journal** ("what happened, in order?" — `journal`/`editor_journal`),
**Watch** ("how did this number move?" — `watch`); over the **game world** AND the **editor session**
(what your human collaborator is doing). Provenance **sigil** on every journal event: `@` = engine-
authored, bare = game-authored, `!` = human/editor. All ride the same bridge (dev/DMG parity), and all
entity refs are **GUIDs** (hot-reload-stable). Prefer these over screenshots.
- **Semantic (game logic):** `modoki_journal` reads the tick-stamped event trace — game `emit`s
  (`match`/`score`/`win`) PLUS engine `@`-lifecycle events (`@spawn`/`@despawn`, `@anim-start`/
  `@anim-loop`/`@anim-finish`, `@contact`/`@sensor`, `@scene-loaded`/`@scene-swapped`, `@tier`
  — a quality-tier change carrying `prev`/`source`/`reason`), GUID-addressed.
  `modoki_dispatch_action` fires a game intent by name (needs Play); `modoki_list_actions` discovers
  dispatchable actions + read-values. Assert on events, not screenshots. Returns the **last 100 events
  + `byType` counts over the whole 10,000-event ring** (a `@contact`-heavy physics session is ~582k
  tokens entire) — narrow with `type=`, raise `limit=N`. (Journal is **off in shipped game builds** —
  gated `__MODOKI_EDITOR__ || build.debugBuild`; always on in the editor. **Off means not
  RECORDING, not removed** — unlike the debug menu and the bridge (dynamic imports that
  tree-shake out entirely), `core/journal.ts` is statically imported by ~14 runtime modules
  (`SceneManager`, physics, zones, timeline, haptics, video, IAP…), so a release build still
  ships the ring-buffer module and pays one dead `if` per `emit()`. Threading a compile-time
  flag through all of them for a few KB was **declined** — it is a dead branch, not an attack
  surface like the bridge's eval endpoint; revisit only if a playable-ad byte budget actually
  needs it ([playable-export.md](./playable-export.md)). On device the bridge
  turns it ON the moment a debug client attaches — on `connectionChanged` AND, because a page
  reload re-runs `main.tsx`'s disable while the native socket persists with no reconnect event, at
  bridge init via `getStatus().clientConnected` — so launch/reload-time events record during a
  debug session. Events from before the FIRST attach of a session are still unrecorded.)
- **Severity (bug triage):** every event carries a `level` — `info` (default) / `warn` / `error`.
  Game code sets it via `gameJournal.ts`'s `journalWarn`/`journalError` helpers (thin wrappers over
  `emit()` for "something unexpected happened" — a missing spawn point, a failed asset acquire — the
  kind of thing worth finding FIRST in a bug hunt); `journalState`/`journalDecision` cover `info`-level
  state transitions and "why did the game take this branch" events. `modoki_journal`/`device_journal
  level=` filters to that severity **and above** (`level:"warn"` returns `warn`+`error`), skipping the
  normal-gameplay noise. Raw `emit(type, payload, world, level)` still works for a plain semantic event
  — the helpers are convention, not a requirement.
- **Journal TIERS (volume control).** The journal is Percept's largest payload, so events split two
  ways. **Tier-1 always-on**: semantic events + the LEAN enter/exit transitions `@collision`/`@sensor`/
  `@zone` (low-rate — a bare read always sees them). **Tier-2 watch-gated**: the high-frequency
  diagnostic `@contact` (rich manifold: point/normal/speed) records NOTHING until you open a capture,
  and only from that point forward (no back-history). Open/close with `modoki_journal` /`device_journal`
  `action:"start"|"stop"` + `type:"@contact"` **before** the moment you want to trace. Reads report
  `captures` + a `captureHint` so an empty `@contact` result reads as "not capturing", not "no
  contacts". The editor AI panel has a **"Capture @contact on Play"** toggle (per-project) that
  auto-opens the watch when the GameView enters Play. Headless tests (`createTestWorld`) open all Tier-2
  captures by default.
- **Resolve refs → names:** `modoki_resolve_refs` / `device_resolve_refs {refs:[…]}` maps journal/contact
  refs (GUIDs and/or numeric ids) to entity **names** — the deliberate second hop that keeps names OUT
  of the (high-frequency) journal stream. Batch every ref you care about into one call after you've
  narrowed down. Names resolve **even for DESPAWNED entities** (captured at emit time in a per-world
  LRU side-table), which a live `get_scene_state` lookup cannot. Returns `{resolved:{ref:{name,alive}},
  unresolved:[…]}`. Invariant: the side-table **dual-keys** a guidable entity — it records the name
  under BOTH the GUID and the numeric id — because a live event carries the GUID while the synthesized
  despawn-EXIT carries the cached numeric id; keying only the GUID would leave the exit ref unresolvable
  (the case the feature exists for). Don't "simplify" that to a single key.
- **Watch (numeric time-series):** `modoki_watch {start|read|list|clear}` — a standing, change-detected
  series for tuning motion feel (jump overshoot, spring settle, bone/velocity decay) that a screenshot
  can't show. Focus by `component` + `guids[]` (resolved at START — a stale guid FAILS, not a silent
  empty) or `names[]` (case-insensitive substrings — NEW spawns matching a name AUTO-JOIN, the handle
  for a runtime-spawned entity whose guid changes every launch, e.g. the sling puck); optional
  `fields[]`. Anti-flood knobs `epsilon` (record only on change), `everyNFrames` (decimate),
  `maxSamples` (ring cap), `maxSeries` (cap on MOVING series — a static/never-moved entity doesn't
  consume it, so a screen of static tiles can't crowd out a late-joining mover), `expireFrames`
  (auto-expire). `read` returns per-series stats `first/last/min/max/delta/settled` + each series'
  entity `name`; narrow a broad watch with `name=`/`guids=`/`limit=` (`seriesTotal`/`seriesTruncated`
  report the full match count). Editor-side observer — zero shipped-game cost. (`app/debug/watch.ts`.)
- **Input watch (what the finger did):** `modoki_input_watch`/`device_input_watch {start|read|stop|clear}`
  — a bounded record of what the POINTER actually did and what it resolved to, for the failure mode
  with the least evidence: a press that resolves to nothing emits no journal event, no commit, no
  coordinates. `start` opens the window (records nothing before that call — no history, like `@contact`
  capture); `read` returns the most-recent presses (down/up points, distance travelled, hold time,
  move-sample count) plus what each one `resolved` to. `resolved.by` is the one field that tells "the
  press hit nothing" (`'none'` — an authority looked and found nothing there) apart from "nothing could
  answer" (`'unknown'` — nobody who could look was asked) — pass `unresolvedOnly:true` to isolate
  exactly those. `stop` closes the window but KEEPS what was recorded; `clear` drops recorded presses
  without closing it. Capture-phase on `window`, so it sees a press regardless of what any downstream
  layer did with it (blocked, `stopPropagation`'d, a second finger the engine ignores). A game closes
  the "nobody could look" gap by calling `noteInputResolution()` from its own hit-test.
  (`runtime/input/pointerRecorder.ts`.)
- **Hit regions (what it MISSED):** `modoki_hit_regions {read|show|hide}` — the companion half of the
  input watch. **A hit region is authored nowhere**: it is computed inside a game's `hitTest` from
  config, so no inspector, scene view or screenshot can show it. The watch says a press hit nothing;
  this says *what* it missed and *by how much*. `read` returns the shapes as data in **viewport CSS
  px** — the same space presses are recorded in, so they compare with no transform. **Pass
  `at:{x,y}`** (a press coordinate straight from the watch) and it answers directly: `hitsAt` for the
  regions containing it, and when empty, `nearest {id, kind, label, distancePx}` — the number the
  Court investigation that produced #134/#139 had to derive by hand. `distancePx` is to the nearest
  **edge** (0 inside) and is exact for all three shape kinds, poly included: a point-to-*vertex*
  approximation does not merely round badly, it picks the WRONG REGION for anything elongated (a
  1000x10 lane with a press 5 px off its edge scores ~500, handing "nearest" to whatever else is
  within 500 px). A region may carry
  **`drawnShape`** where the game DRAWS something different from what it hit-tests (a forgiving grab
  radius, a badge smaller than its ring); that difference is usually the bug. `show` draws an
  overlay — solid = hit shape, dashed = drawn shape — and plots the last few recorded presses,
  **green inside a region, red outside**, which is what makes the two failure classes visually
  distinct (outside every shape = targeting; inside the right shape and still nothing = latching or
  frame-rate). It also makes visible the thing no amount of reading `hitTest` reveals: **the GAPS
  between regions.** ⚠️ Read `providers`: an empty region list with none registered means *nobody
  could answer*, not *there is nothing there*. A game publishes its geometry with
  `registerHitRegionProvider()`, from the code that OWNS it — never a second copy, which would agree
  today and drift on the first retune. (`runtime/rendering/hitRegions.ts`; Court is the worked
  example, `games/court/runtime/systems.ts`.)
- **Editor session (perceive the human):** `modoki_editor_journal {type,source,since,sinceCap,merged,limit,clear}`
  — the human-authoring stream (`!` sigil: `!select`/`!edit`/`!mutate`/`!transform`/`!create`/`!duplicate`/
  `!delete`/`!reparent`/`!play`/`!pause`/`!stop`/`!gizmo`/`!scene-load`/`!save`/`!undo`/`!redo`), GUID-addressed with
  old→new values on edits. ⚠️ `!edit` is the human Inspector-field path; **your own
  `modoki_mutate_scene`/`modoki_set_transform` land as `!mutate`** — this list omitted it, and a QA
  case that filtered for `!edit` failed against a healthy engine. Every event carries **`source:'human'|'agent'`** so you never mistake YOUR
  own edits for the human's (agent-driven editor ops self-tag `'agent'`). `merged:1` interleaves it with
  the game journal by a shared capture counter for the "pressed Play → set timeScale 0.3 → `@match` tick 84"
  correlated story. All three streams return the **last 100 + `byType` counts**; cursor precisely with
  `since`/`sinceCap`, or raise `limit=N`. (`editor/editorJournal.ts`.)
- **Numeric layout:** `modoki_get_layout_bounds` → **bare it returns COUNTS** (`count`, `layerCounts`,
  `overlapsCount`) plus the cheap `offScreen`/`zeroSize` **id lists** — usually the whole answer to
  "what's invisible or collapsed?". Pass `ids`/`layer` for per-entity screen-space rects (UI DOM rects
  + projected 2D/3D), and `overlaps:true` for the same-layer overlapping PAIRS — that list is O(n²) (2,625
  pairs, 77k chars ≈ 19k tokens on a 241-entity scene), so it's opt-in. Check alignment/overlap/clipping as data.
  (Providers register in `Scene3D`/`Scene2D`; UI via `[data-entity-id]` DOM. New:
  `runtime/core/screenBounds.ts`, `app/debug/layoutDump.ts`.)
- **Diagnose:** `modoki_diagnose` → structured causes (bad refs, NaN/zero-scale transforms, no camera,
  off-screen, console errors) — run FIRST when something renders wrong. (`app/debug/diagnose.ts`.)
  **`consoleErrors` is windowed, and the window is a VERDICT window, not a reporting one (#152).**
  Only errors inside `errorWindowMs` (5 min) gate `ok` — otherwise one benign load-time error sits
  in the 500-entry ring and pins `ok:false` forever. But everything older is COUNTED and timestamped
  in `olderErrors {count, oldestTs, newestTs}`, and the summary names it, because for a while the
  window silently DROPPED them: at 30s, boot errors could never be seen (nobody connects a device,
  attaches an agent and asks a question that fast), and `consoleErrors: []` + `ok:true` + "No issues
  detected." was reachable while the ring held a real ~4s frame-loop stall on a Huawei Y6 that the
  owner was watching happen. `0` never means "this app has logged no errors" — it means "none in the
  last `errorWindowMs`". Read the rest with `modoki_get_console_logs level=error`.

  **On DEVICE it read the wrong buffer entirely, and the window was never what hid boot errors
  (#157).** There are two console rings — `bridge.ts`'s `consoleRing` (populated on device by
  `patchConsole()`) and `agentBridge.ts`'s `consoleBuffer` (populated in the editor by
  `installConsoleCapture()`) — and `diagnose` read the second. That call sits *after*
  `initAgentBridge()`'s `if (!hot && !bridge) return;`, and a shipped build has no
  `import.meta.hot` while a phone has no Electron bridge, so on every real device the buffer stayed
  empty for the life of the process. Measured on a Samsung SM-S901U1: the ring held 5 errors
  including a `[frameDriver]` stall, and `device_diagnose` answered `ok:true, consoleErrors:0,
  "No issues detected."` A clean device diagnose was **structurally guaranteed, not observed** — on
  the one surface CLAUDE.md tells you to run it first, because the Android screenshot is black on
  WebGPU. The writer now publishes its ring through `app/debug/consoleSource.ts` and the reader asks
  for it, preferring its own buffer whenever `consoleHooked` (so the editor path is unchanged).
  Deliberately a seam and NOT a second `installConsoleCapture()`: hoisting that call would patch
  `console.*` twice on device and carry a second copy of every line, on exactly the low-end hardware
  whose frame budget is #154. Two things fixed alongside it, both required before a device boot error
  is actually *readable*: the device now captures `[uncaught]` errors and `[unhandledrejection]`s
  (those listeners lived only in the skipped block, so a failed dynamic import or a throw in scene
  loading was silent), and `safeStringify` no longer renders an `Error` as `{}` — `console.error(err)`
  is the usual way to report a failure, and it was reaching `diagnose` as an empty object.
- **Console:** `modoki_get_console_logs` returns the **last 50** plus three numbers that do NOT mean the
  same thing: `count` (what came back), `total` (what matched `level=`/`since=`), and
  `ringTotal`+`byLevel` (the WHOLE 500-entry ring, regardless of the filter). That last part is the
  point — a `level:'warn'` read still tells you whether any errors exist. It used to build the
  histogram over the already-filtered array, so "are there errors?" answered *no* (S3.8). Error
  entries carry full stacks, so the whole ring can exceed 20k tokens.
- **Asset authoring (no guessing JSON):** `modoki_asset_schema {material|particle|animation}` →
  field metadata + example; `modoki_create_asset` / `modoki_write_asset` (validated, warn-but-write);
  live tuning via `modoki_particle_set` / `modoki_anim_set_clip` / `modoki_anim_add_key` /
  `modoki_set_playhead` (apply live AND persist). New schema layer: `runtime/assets/assetSchemas.ts`.
- **Time + input feel:** `modoki_set_timescale` (0=pause/0.3=slow-mo/2=fast — pair with
  `render_sequence`); `modoki_capture_gesture` (Electron) drags while sampling an entity's Transform
  per frame → a numeric trajectory for tuning input feel.
- **Snapshot (`modoki_get_scene_state`):** **called bare it returns an INDEX** — per entity `id`,
  `guid`, `name`, `parentId`, `layer` + its trait **NAMES**, no field values, under a default `limit`,
  plus a `hint`. That's the cheap "what exists?" question; ask it first, then drill down. (It used to
  dump every field of every trait: ~40k tokens on a 135-entity scene.) **`guid` is on EVERY row, not
  just the index** (S3.12/S3.9): a `trait=` drill-down used to return id-only rows — from the very tool
  that tells you runtime ids are reassigned on every hot-reload — because the guid lived inside
  `traits.EntityAttributes`, which the `trait` filter excludes. **Any target or enricher returns
  VALUES:** filters `trait`/`id`/`guid` (the stable address to prefer)/`name` (substring)/`where`
  ("Trait.field op value" — **reports a parse/unknown-field error** instead of silently dumping everything); enrichers `full` (full-fidelity
  trait dump — AoS/object fields the compact default drops, PLUS runtime read-back fields like
  `SkeletalAnimator.activeClip`/`normalizedTime` and RigidBody `isSleeping`), `world` (resolved world TRS
  + `activeInHierarchy`), `bounds` (per-entity `screen` rect + `onScreen` + 3D `worldAABB {size,center}`),
  `contacts` (live solid `contacts` + sensor `overlaps`, GUIDs), `resources` (include resource entities,
  excluded by default), `limit` (+ `truncated`/`totalCount`; an explicit `limit` always wins, and a
  targeted query is never silently capped). **Floats are rounded to 9 significant digits**
  (`247.13061935179246` → `247.130619`; max error 3.5e-7) — ~18–21% of the tokens on a Transform
  drill-down. **Verify an edit with a TOLERANCE, not `===`.** `precision=0` returns exact float64;
  the same param exists on `get_layout_bounds` and `watch`.

Percept is feature-complete for v2 (Snapshot/Journal/Watch/Editor-Percept all shipped, tested,
adversarially reviewed). One item is deliberately deferred: a `debug|profile|release` journal-mode
enum to replace the current `enableJournal` boolean (now `build.debugBuild`) — not worth building
until a profiler gives `"profile"` a second real consumer.

## Enact — act like a human, not just read like one

**Enact is the input twin of Percept.** Percept made every editor surface *readable* (numeric
bounds/journal); **Enact** makes every human *interaction* *sendable* — the trusted-input layer so the
agent can do anything a mouse+keyboard can, in dev AND the DMG. Reach for it when a
`mutate_scene`/`editor-action` shortcut doesn't exist and you must drive the actual UI (author in a
Canvas2D/SVG editor, exercise a gesture, open a modal). All are Electron-editor trusted input except
`dnd`/`handles`, which ride the editor-action relay and work in dev too. (Design:
[enact.md](./enact.md).)
- **Never aim by pixels. There are three aim modes, and `{x,y}` is the last resort.** Precedence is
  `entity` → `selector` → `{x,y}`; the first two resolve **server-side in the same call**, so nothing
  can move between reading a coordinate and acting on it.
  - **`selector`** (a CSS selector) for **editor chrome** — resolved to the element's centre. Drag
    takes one point spec per endpoint.
  - **`entity: {guid|name|id}`** for a **scene entity** in a viewport — resolved to the entity's live
    screen rect. Prefer `guid`: runtime ids are reassigned on every scene reload. A `name` matching
    several entities is **refused**, not first-matched.
    - ⚠️ **A 2D/3D aim REQUIRES `surface`** (`game-3d` | `game-2d` | `scene-view`) — a UI aim
      refuses it. One entity is often on screen more than once: with the Scene and Game panels both
      open, `Scene3D` and `SceneView` each measure every 3D entity through their own camera
      (measured: `47x45 at (755,312)` vs `496x372 at (76,-63)`, same id, both `onScreen`). It is
      required **even when only one viewport has it**, because otherwise the call succeeds without
      you having said what you meant — so a wrong assumption gets confirmed instead of corrected.
      Read `get_editor_state.surfaces` for what is mounted; a successful aim echoes the `surface` it
      used. Before this, the resolver took whichever rect came first and could click the wrong panel
      while reporting success.
  - **`{x,y}`** only when neither fits (empty canvas space). It is **rejected outright inside
    `modoki_batch`**, where coordinates read before the batch are measured against state its own
    earlier steps invalidated.
  The response reports `matched` (what resolved), `hitTarget` (the topmost element at that point) and
  `occluded`: when `occluded` is true **something covered your target and the click landed on it** —
  the silent-miss class of bug, as data, with no screenshot. Occlusion is measured at resolve time, a
  few ms before dispatch, and is **provenance, not a veto** (the input is still sent). A hidden/
  zero-rect element, an invalid selector, an off-screen entity, or one whose rect centre falls
  outside the window is refused with a 400 rather than aimed at (0,0) or clamped to an edge.
  - ⚠️ **`occlusionScope` qualifies `occluded` for an entity aim, and you must read it.**
    `'element'` (UI entities, which are real DOM nodes) is a true element-level comparison — trust
    `occluded:false`. **`'entity'` (2D/3D entities on a surface with a registered pick provider —**
    today, the editor's `scene-view` **)** asked the surface's OWN hit-test what a click there
    would actually select, so a mesh directly in front of the target IS detected — and by default
    the call **refuses** rather than reporting `occluded:true`: an entity aim expresses intent
    about the ENTITY ("click the character"), so a click the surface would not honour is a failed
    intent, not something to dispatch quietly. The 400 names the blocking entity. Pass
    `entity.allowOccluded:true` to dispatch anyway and see what was actually hit. **`'canvas'`
    (2D/3D entities on a surface with NO pick provider — the runtime `game-2d`/`game-3d` until a
    game registers one) only detects DOM-level covering**: a panel or dialog over the canvas is
    caught, but **a mesh directly in front of the target reports `occluded:false`**, because
    nothing asked the scene what is actually there. Treat `'canvas'` + `occluded:false` as "the
    click reaches the canvas", not "the click hits the entity". A successful `'entity'`-scope
    response also carries `aimedAt` (`'centre'` | `'sampled'` — whether the entity's projected-rect
    centre picked it, or a concave/hollow shape needed a searched point instead) and, on a refusal
    or an `allowOccluded` dispatch, `occludedByEntity` naming who is actually there. Design +
    tests: [docs/enact.md](enact.md).
- **Raw input modalities** (beyond `tap`/`drag`): `modoki_hover` (bare mouse-move → tooltips/hover-
  submenus), `modoki_scroll` (wheel → orbit-zoom, scroll a long panel, cursor-anchored Canvas2D zoom;
  `deltaY>0` = content down, ~120 ≈ one tick; pass `modifiers:['control'|'meta'|…]` to drive a
  modifier-gated wheel handler — Ctrl/Cmd+wheel UI-zoom, the Curve Editor value-axis zoom), `modoki_press_key` (standalone chord into the focused
  element — `Escape`/`Delete`/arrows + hotkeys `W`/`E`/`R` gizmo, `F` frame, `Cmd+Z` — the keys
  `type_text` could only send as a terminal `submitKey`).
- **Sustained/HELD pointer** (`modoki_pointer {action:down|move|up}`) — the stateful twin of
  `modoki_drag`, split across calls: `down` presses and LEAVES the button held, `move` re-aims it
  (drag-move), `up` releases. The press physically persists between MCP calls, so state that exists
  only *while the button is held* — a slingshot pull preview, a charge-up meter, a drag-to-aim
  rubber-band — is readable mid-gesture (`get_scene_state`/`modoki_eval`/screenshot between the
  down and the up), which the atomic `drag`/`dnd` cannot expose. move/up reuse the held button;
  a move/up with nothing held (or a second down while held) is a 409.
- **HTML5 drag-and-drop** (`modoki_dnd`) — the DnD sequence a trusted pointer-drag CANNOT emit:
  Hierarchy reparent/reorder, Assets file-move & prefab-instantiate, Skin sprite-onto-part / bone-
  reparent. Address each end by CSS `selector` or `{x,y}`; the app's own `dragstart` fills the
  DataTransfer (never fabricated). Returns the MIME `types` written (empty ⇒ wrong source element) +
  `accepted`, and **reports `ok:false` when the drop was a no-op** (empty transfer or a rejecting
  target) — so a wrong-source/wrong-target reparent is a visible failure, not a silent success.
  Use this, NOT `modoki_drag`, for asset→slot / reparent.
- **Editor chrome is addressable — `modoki_handles {editor:'chrome'}`.** Panel buttons, the Inspector's
  per-trait `⋮` and its menu rows, toolbar toggles, the Console filter, dialog confirm/cancel all carry
  `data-ui-id="<panel>.<region>.<name>"` and surface as handles, so `modoki_tap_handle {id}` drives them
  with **no new input tool and no pixel measuring**. Ids are stable and semantic
  (`inspector.section.Transform.menu`, `contextmenu.item.Copy Component`, `sceneView.toolbar.gizmo.rotate`,
  `hierarchy.toolbar.create`, `prefab.dialog.confirm`). **Every Inspector NUMBER field is addressable
  as `inspector.field.<Trait>.<field>`** (`inspector.field.Transform.x`,
  `inspector.field.Rotate3D.speed`) — grouped vector axes, bounded UI-anchor sizes and plain numeric
  trait fields alike. Use it instead of a `input[value="…"]` CSS selector: React writes the `value`
  ATTRIBUTE only on the initial render, so a value-based selector silently stops matching the moment
  the field changes — which is usually the very next step of whatever you are driving. Each handle
  reports `rect`, `meta.disabled` (a
  greyed control is DATA, not a shade of grey), `meta.state` where the control has a current value —
  `module-toggles.physics3d.off` reports `state:'selected'` when that is what the project is set to,
  so a tri-state row is read rather than eyeballed — and `occludedBy` (what covers it — occlusion is computed
  for EVERY handle that names an owning element, not just chrome; `occlusionUnchecked` counts the ones
  that named none, so **`occludedCount:0` only means "all clickable" when `occlusionUnchecked` is 0 too**).
  **A handle only exists when its panel is rendered** — an empty result means "open that panel / select an
  entity first", never "guess the pixels". Adding a surface = add the attribute; a guard test
  (`tests/editor/chromeTagging.test.ts`) fails if a load-bearing id is deleted, and a duplicate id logs a
  loud error (`tap_handle` resolves the first match, so a duplicate silently drives the wrong element).
- **Aimed input for the Canvas2D/SVG editors (the input twin of `get_layout_bounds`).** These editors
  (Skin bones, Dopesheet/Curves keyframes, Collider2D vertices, particle curve/gradient points, gizmo
  axes, sprite-slice/9-slice/UI-resize handles) have **no DOM accessibility tree** and a downscaled
  capture ≠ CSS coords, so raw drag is useless — you don't know WHERE to aim. `modoki_handles` **called
  bare returns COUNTS** — `byEditor`/`byKind` (plus `viewport`, `offScreenCount`, `occludedCount`,
  `occlusionUnchecked`, `disabledCount`) — the "what can I aim at right now?" answer. Pass
  `editor`/`kind`/`ids` for the geometry: each handle then has a stable `id`,`x`,`y`,`label`,`meta` and
  `onScreen`, in viewport CSS px, with `viewport {w,h}` for image-px↔CSS mapping. The full list is
  opt-in because a Dopesheet enumerates every key of every track (~374 bytes each — a 2,000-key clip is
  ~187k tokens). Then `modoki_tap_handle {id}` / `modoki_drag_handle {id, to|toId|delta}` issue the
  trusted gesture — coords resolved **server-side** from the id, so no query→drag race.
  **All counts 0 ⇒ open the right editor + enter its sub-mode first** (see openers below); if a
  handle is `offScreen`, `modoki_scroll` the panel until it's aimable rather than silently missing.
- **Openers/mode-setters that unblock editors trusted input can't reach** (a native `<select>` popup or
  a modal that only mounts when its tab/asset is active is a separate OS layer `sendInputEvent` can't
  touch): `modoki_scene_view_mode {3d|ui}` (REQUIRED before Collider2D editing — its vertex handles
  only live in `ui`/2D mode), `modoki_collider_edit {on}` (the toolbar "Points" toggle),
  `modoki_open_particle_editor` / `modoki_open_sprite_editor` / `modoki_open_nine_slice_editor` (pass
  the asset's served path — mounts the panel/modal so its handle providers register). `get_editor_state`
  now reports `sceneViewMode`/`colliderEditMode`.
- **Canonical loop:** open the editor/sub-mode → `modoki_handles` to discover geometry → `drag_handle`/
  `tap_handle` (or `dnd`) to act → verify via Percept (`get_scene_state`/`watch`/`get_layout_bounds`)
  → `modoki_history undo` to revert. Registry twin of `screenBounds.ts`:
  `runtime/rendering/interactionHandles.ts` + `app/debug/handlesDump.ts`; raw modalities in
  `engine/electron/rendererOps.ts`; DnD synth in `engine/app/debug/domDnd.ts`.

## Electron CDP (when the MCP/Percept surface can't answer)

Need full CDP (network inspection, perf traces, heap snapshots) against Electron? Its renderer
speaks CDP too — launch Electron with `--remote-debugging-port` and point `chrome-devtools` at
the Electron window; `--inspect` debugs the main process. So nothing CDP-shaped is lost in Electron.

**Try `modoki_eval` first.** For a one-shot read/poke of live renderer state (a global, a fiber
value, `devicePixelRatio`, dispatching a bridge event, a WGSL compile check), `modoki_eval` returns
the value over the normal MCP bridge with no CDP client to stand up — it's the editor twin of
`device_eval` and removed most of the cases below. Reach for full CDP only when you need a CDP-native
capability `eval` can't give you: sampling a clock/state **over time**, network/perf/heap inspection,
or observing a transient the very act of an HMR-triggering edit would mask.

**REACH for Electron CDP when the MCP/Percept surface can't answer — don't avoid it.** The
`modoki` MCP + Percept tools (now including `modoki_eval`) are the default and cover most editor
debugging, but some questions are only answerable by inspecting the live renderer directly, and past
sessions have wrongly avoided this and gone in circles instead. Attach CDP when you need to: read **live React
fiber/component props or state** (e.g. what `node.textAnim` a UINode actually received — the
projection value, WITHOUT a source edit); measure **CSS-animation clocks / computed transforms /
`getAnimations()` `currentTime`** over time (motion the console can't show); diagnose
**compositing/repaint** ("numbers right, renders static") or **WebGPU/WGSL validation errors**
(invisible to `modoki_get_console_logs`); or count **duplicate module instances** (distinct Vite
module URLs). Critically: a **source-edit probe triggers an HMR that re-renders and MASKS
first-load/transient bugs** — CDP `Runtime.evaluate` (and fiber reads) let you observe the live
buggy state without perturbing it. To reproduce a true cold-start bug, relaunch Electron fresh
(not `location.reload()`, which can leave the renderer half-initialized — `fps:0`, empty tree).

Concrete recipe (used to fix the Game-view UI-text-animation bug): relaunch this clone's editor
with the debug port (same backend/project so the MCP stays valid) —
`pkill -f "$PWD/engine/electron/dist/main.cjs"; MODOKI_BACKEND_PORT=5180 MODOKI_PROJECT=games/<id> \
./node_modules/.bin/electron --remote-debugging-port=9223 "$PWD/engine/electron/dist/main.cjs" &`
— then find the page target via `curl -s localhost:9223/json` (filter to the `/#/editor` url). The
`chrome-devtools` MCP manages its OWN browser and usually CAN'T attach to an arbitrary Electron
port, so drive CDP directly: a ~25-line Node script opens the page's `webSocketDebuggerUrl` and
calls `Runtime.evaluate` with `returnByValue`/`awaitPromise`. **No dependency is needed — Node 22+
has a global `WebSocket`**, and `ws` is not a dependency of this repo (an earlier version of this
recipe imported it, which fails with `ERR_MODULE_NOT_FOUND` wherever you put the script). The
global is the WHATWG client, not an EventEmitter: it has `onopen`/`onmessage`, **not** `.on()` /
`.once()`, and the message payload arrives as `event.data`. The backend (5180) is separate from the
renderer, so the modoki MCP keeps working through the reload.

The minimal script — evaluate an expression in the live renderer without perturbing it (write it
under the repo root as `cdp-eval.mjs`, run `node cdp-eval.mjs "<expr>"`):

```js
// No imports: Node 22+ ships a global WebSocket. `ws` is NOT a dependency here.
const PORT = process.env.CDP_PORT || 9223;
const expr = process.argv[2] ?? '1+1';
// 1. find the editor page target
const targets = await (await fetch(`http://localhost:${PORT}/json`)).json();
const page = targets.find(t => t.type === 'page' && t.url.includes('/#/editor'));
if (!page) throw new Error('no /#/editor page target — is Electron up with --remote-debugging-port?');
// 2. open its CDP socket and Runtime.evaluate
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
ws.onmessage = (event) => {
  const m = JSON.parse(event.data);            // WHATWG: payload is event.data, not a Buffer arg
  if (m.id === 1) { console.log(JSON.stringify(m.result?.result ?? m.error, null, 2)); ws.close(); }
};
ws.send(JSON.stringify({
  id: 1, method: 'Runtime.evaluate',
  params: { expression: expr, returnByValue: true, awaitPromise: true },
}));
```

Read a live fiber/prop, a `getAnimations()` clock, or a WGSL error object the same way — the
`expression` runs in the page context. Use `returnByValue` for serializable results; drop it (and
read `result.objectId`) for live handles. This observes the buggy state WITHOUT the source-edit HMR
that would mask a first-load bug.

## Chrome/Web debugging (chrome-devtools MCP) — opt-in fast loop

**Use this only as the fast renderer-iteration loop** (scenes, UI, shaders) — NOT as the primary
editor debugger. It loads the same Vite-served renderer in a plain browser tab, so it cannot see
any Electron-only surface, and the browser transport can quietly drift from what you ship. When a
bug is Electron-shaped (packaging, native, IPC, autoUpdate), switch to the `modoki` MCP above.

**DO NOT reach for Chrome to debug/verify the EDITOR.** Default to the Electron editor via the
`modoki` MCP for anything editor-shaped — it's what ships, and the clone's Vite port can vanish
mid-session (connection refused) leaving you stuck. In particular, when a `modoki_tap` MISSES a
target, do NOT switch to Chrome to work around it — fix the AIM in Electron. In order of preference:
pass a CSS `selector` (resolved server-side; the response's `occluded`/`hitTarget` tells you if
something covered it), or `{x,y}` from `get_scene_state?bounds=1`. **Never eyeball coordinates off a
capture:** `modoki_capture_viewport` downscales to 1568px longest side, so image px ≠ CSS px — it now
returns `cssWidth`/`cssHeight`/`scale` (image px ÷ `scale` = CSS px) precisely so you never have to
guess. Chrome is a browser-tab renderer loop only, never the editor debugger.

**Re-read bounds immediately before acting.** A camera move, a relaunch, or a scene reload between a
bounds read and a tap invalidates the coordinates. Nearly every "the tool is broken" moment has been a
stale read, not a bug. `selector`/`tap_handle` resolve inside the call and don't have this problem.

**Coordinate space under UI zoom.** The editor supports app-wide UI zoom (see
[editor.md](./editor.md) "UI Zoom") via Electron's `webContents` zoom. The **public coordinate
space for every MCP tool is zoomed-CSS** — the same space `getBoundingClientRect`, `selector`
resolution, `screenBounds`, and `interactionHandles` already report, so nothing above changes
under zoom: pass a `selector` or `{x,y}` from `get_scene_state?bounds=1` as usual. Internally,
`rendererOps.ts` converts that public coordinate to DIP (`×getZoomFactor()`) at the one seam
where it meets `sendInputEvent`, since Chromium's trusted-input API expects zoom-0 DIP px — this
conversion is transparent to callers. The one residual mismatch is `modoki_capture_viewport`'s
reported `cssWidth`/`scale`, which describe the image in DIP, not zoomed-CSS — so an `{x,y}`
eyeballed off a capture (already discouraged above) is off by the zoom factor when zoom ≠ 100%.

**Which editor is `MODOKI_BACKEND` pointing at?** Multiple clones of this repo run side by side, each with
its own editor on its own port. Pointed at the wrong one, **every call succeeds and drives the other
checkout** — nothing errors, nothing you expect changes. `modoki_identity` (or `GET /api/identity`)
answers `{repoRoot, projectRoot, backendPort, pid, branch}`; the MCP also warns on every tool result
when the backend's `repoRoot` isn't this session's. Call it first when edits seem to vanish.

**`repoRoot` also doubles as "where is the engine's own source."** In dev it's the monorepo root;
in a packaged editor it's `<resourcesPath>/app.asar.unpacked` — real, unpacked TypeScript (Vite runs
it unbundled in prod), not a compiled bundle. A standalone end user's project has no engine source
of its own (the scaffolder template declares no `@modoki/engine` dependency — the running editor
serves it live), so `modoki_identity`'s `repoRoot` is the one deterministic way an agent finds the
engine source to read when understanding *why* it behaves a certain way, not just what it's doing
right now. Deliberately a field on `modoki_identity`, not a new tool.

**Addressing entities across hot-reloads:** in `scene-mutate` / editor-action ops, target entities
by `{guid}` or `{name}`, NEVER `{id}`. Runtime numeric ids are reassigned on every scene hot-reload
(and a mutate itself triggers one), so a remembered `{id}` can point at a different entity after the
next call — e.g. a restore mutate using a stale `{id:23}` once stamped a trait onto a prefab-instance
entity instead of the intended one. Only trust an `id` within a single call with no intervening reload.

Launch Chrome with `--remote-debugging-port=9222` pointing to the clone's port.

**Main branch (5173):**
```bash
open -na "Google Chrome" --args --remote-debugging-port=9222 http://localhost:5173
```

**Second clone (auto-picked port):**
The clone's dev/editor Vite server now auto-picks a free port (see the Two Clones section of `CLAUDE.md`) — it's no longer pinned to 5174. Use whatever port `launch-editor.sh` / `npm run dev` printed, on a distinct debugging port:
```bash
open -na "Google Chrome" --args --remote-debugging-port=9223 http://localhost:<clone-port>
```
- Screenshot: `take_screenshot` with `format: "jpeg"`, `quality: 70`
- Tap: `click` by element UID (from `take_snapshot`)
- Drag: use `evaluate_script` to call PixiJS EventSystem directly (Chrome MCP `drag` is for DOM drag-and-drop, not canvas gestures)
- Eval: `evaluate_script`
- Console: `list_console_messages`

## Native Debug Bridge (capacitor-game-debug)

Standalone Capacitor plugin at `engine/packages/capacitor-game-debug/`. Runs a TCP server on the device for the MCP server to connect to.

**Platform details:**
- **iOS:** NWListener (TCP) + native lease handshake + `captureScreen` + `getNativeLogs` (OSLogStore)
- **Android:** ServerSocket (TCP, first-wins single client) + native lease handshake + `captureScreen` + `getNativeLogs` (logcat)
- **No Bonjour/mDNS on either platform** — advertising was removed from the plugin; the backend connects by IP/adb.

**Debug vs Release — ONE flag decides, on every layer (#112).** `build.debugBuild` (Project
Settings → Developer) is the single source of truth. **The Xcode/Gradle configuration is
orthogonal: it means optimization and symbols, NOT debug surfaces.** That distinction is worth
holding onto — "Debug" is an overloaded word and this is exactly where a reader conflates the two.

- **JS bridge** (`app/main.tsx` → `./debug/bridge`, which carries `handleEval` = arbitrary JS),
  the event journal, and the in-game debug menu — baked as `__MODOKI_DEBUG_BUILD__`
  (`vite.config.ts`). Default **false** → the whole `./debug/bridge` import tree-shakes out of a
  shipped game build (native AND web), so there is no eval-capable JS server at all; the editor +
  dev keep it always-on. (The `debug|profile|release` mode enum once floated to replace this
  boolean is deliberately deferred — see "Percept" above.)
- **iOS native plugin registration** — the `modoki:game-debug-*` fenced block in the generated
  `MyViewController.swift`, written by `healNativeConfig` from the flag.
- **iOS Local Network / Bonjour Info.plist keys** — added *and removed* by `healNativeConfig` from
  the flag, in the SOURCE plist.
- **Android native plugin** — the `com.modokiengine.gamedebug.DEBUG_BUILD` AndroidManifest
  `<meta-data>`, healed from the flag and read by `GameDebugPlugin.startServer`. Absent reads as
  false (fail closed).

Each of those used to key on something *else* — `#if DEBUG`, `CONFIGURATION == Release`,
`FLAG_DEBUGGABLE` — and they could disagree. The combination that broke was one you would normally
want: `debugBuild: true` + a Release configuration (debugging an optimized build, or a TestFlight
QA build) shipped the JS bridge with no plugin registered and the plist keys stripped — a debug
build that could not debug, with nothing explaining why. Turn the flag ON per-game to debug
on-device (the internal native testbeds already set it), then **reopen the project** so the heal
runs.

⚠️ **The flag is a SOFT gate, and deliberately so.** `#if DEBUG` was hard — a Release build
physically could not carry a live native server. Nothing now prevents archiving and submitting a
build with the flag on. **This repo's TestFlight builds run with `debugBuild: true`**, and a
TestFlight archive is bit-identical to a store archive — same `xcodebuild archive`, same
`method: app-store-connect` export; release-to-store is a button in App Store Connect *afterwards*.
So there is no build-time signal to refuse on that would not also block the workflow in daily use,
and an env-var escape hatch set on every TestFlight build is no gate at all. Do not "restore" a
refusal without first solving that distinction; it has no build-time solution.
The mitigation is therefore a loud
archive-time warning rather than a refusal — an Xcode build phase gated on `ACTION == install`
(so it does NOT fire on an ordinary Release-configuration build) and a Gradle `taskGraph.whenReady`
warning on `:app:*Release`, both healed in/out with the flag.

What IS verified is the other direction — that flag-off genuinely strips every surface above.
`engine/tests/architecture/debugBuildGates.test.ts` (in `npm run verify`) holds it for the native
surfaces, including that every committed project agrees with its own flag; `npm run smoke:debug-flag`
holds it for the JS bundle by building a project twice and grepping `dist/` (measured on
`games/sling`: `app-identity` 1 → 0, `GameDebug` 9 → 0). Both carry a flag-ON control, so a green
run cannot mean "the grep found nothing".

The one honest limit on "stripped": `GameDebugPlugin.swift` is compiled into the iOS App target
**unconditionally** — its pbxproj file-ref is not flag-gated — so the class is in the binary either
way. What the flag removes is the *registration*, and since JS is the only caller, an unregistered
plugin has no way in: Capacitor never exposes it, so `startServer` can never be called and no
socket is ever bound. That is why the guard asserts registration rather than symbol absence
(asserting absence would fail for a correct build). Gating the file-ref too is possible but is a
larger, riskier pbxproj edit than #112 needed.

**Known issues:**
- iOS SPM static linking strips the plugin class — requires manual registration in MyViewController + Xcode file reference from App target to `engine/packages/capacitor-game-debug/ios/Sources/GameDebugPlugin/GameDebugPlugin.swift` (project-relative path in pbxproj, no copy). Edit the package source only.
- **Android screenshots use `adb screencap`** — but only when the **lease itself is adb** (`target.useAdb`,
  from `/api/device/status` — F2), NOT merely because some Android is on USB (that would screenshot the
  wrong device when the lease is a WiFi iPhone). A WebGL/WebGPU (Dawn/Vulkan) canvas inside the Android
  WebView composites in a separate GPU surface, so the device's native `captureScreen` (`rootView.draw()`)
  renders it **black** — only the DOM HUD survives; `adb screencap` reads the post-composition
  framebuffer, capturing the 3D scene + HUD together. `device_screenshot` uses it for an adb lease and
  stores the capture dims so `device_tap`/`device_drag` still convert coordinates. It's a read-only side channel (no game commands → doesn't
  touch the lease) and needs the device on USB; **iOS** captures fine natively through the lease.

**MCP screenshot + tap coordinates:**
- `device_screenshot` returns image pixel dimensions; pass the same coords to `device_tap`/`device_drag`.
  On **iOS** the device stores its own capture dims and converts coords itself. On **Android** (adb
  capture) the MCP remembers the adb dims and passes them as `screenInfo` so the device can convert.
- iOS captures at higher res than native (e.g., 1800 from 1260 native); the image is large — don't
  eyeball coordinates, use `device_eval` to query `getBoundingClientRect()`.
- **Canvas offset gotcha**: The PixiJS canvas starts at `CSS top ≈ 27` (below the React HUD), not y=0.
  Use `device_eval` to get `canvas.getBoundingClientRect().top` and cell positions.
- **Debug markers**: The bridge shows red/green/cyan dots and dashed lines on tap/drag. Check
  `device_console_logs` for `[debug-bridge]` coordinate logs.
- The device TCP server accepts only **one client** (first wins) — the backend lease is the single
  owner, so nothing else can cross-wire.
- Do NOT use `sleep` between MCP commands — the game launches fast and MCP commands are synchronous. Claude's thinking time is longer than any sleep.

**Connection docs:** `engine/tools/game-debug-mcp/CONNECTION.md`

## Agent Dev-Server API (AI-friendly scene editing)

Dev-only endpoints + scene hot-reload so an AI agent (or any tooling) can edit scenes via plain `curl` and verify the result **without driving a browser/screenshot**. All dev-only (the asset-scanner middleware only runs under `vite` dev). Server: `engine/plugins/vite-asset-scanner.ts`. Browser client: `engine/app/debug/agentBridge.ts` (gated on `import.meta.hot`, stripped from prod). Pure logic (shared Node + browser): `packages/modoki/src/runtime/scene/{sceneValidation,sceneMutate,sceneSchema}.ts`; ref predicates in import-free `runtime/core/assetRefRules.ts`.

- **Scene/prefab hot-reload** — editing a scene file on disk (the `Edit` tool, `git checkout`, `/api/scene-mutate`) auto-reloads the **active** scene in the browser; editor camera + selection are preserved (selection via the existing GUID-keyed `selectionRestore`). A prefab edit reloads the current scene (instances re-expand). The watcher classifies files with the scanner's own `detectType()` — **scene files are positively identified by the `.scene.json` suffix** (or, as a legacy fallback, a plain `.json` under a `scenes/` dir — issue #54). The editor's own Cmd+S saves (`/api/write-file`) are suppressed (1.5s self-write guard) so they don't bounce the live scene; external edits still reload.
- **`curl localhost:5173/api/scene-state[?trait=Transform][&id=N]`** — returns the **live ECS world** as JSON. **Bare it is an INDEX** (`{scenePath, entityCount, entities:[{id,guid,name,parentId,layer,traits:[names]}], hint}`), capped at a default `limit` of 200 entities — past that it clips and gains `truncated`/`totalCount`. Pass a target (`trait`/`id`/`name`/`where`) or an enricher (`full`/`world`/`bounds`/`contacts`) to get trait **values** (`traits` becomes an object); a targeted query is never capped unless you pass `limit`. Relays to the open tab over the HMR socket (504 if no app is open). Because it reads the live world (not the file), a changed value here proves a hot-reload actually took effect. **Prefer this over screenshots to verify scene edits.**
- **`curl .../api/validate-scene?path=/games/.../x.json`** — warn-but-load validation: unknown trait/field, type mismatch, and the literal-asset-path-instead-of-GUID mistake (see "Asset References" in `CLAUDE.md`). Needs a tab open to push the trait schema (`schemaAvailable:false` ⇒ ref checks still run, type checks skipped).
- **`POST .../api/scene-mutate {path, ops}`** — validated `setTrait`/`removeTrait`/`addEntity`/`removeEntity` (entity ref by `id`/`name`/`guid`; mints GUIDs); writes atomically; returns `{ok, changed, errors, warnings}`. Hot-reload then reflects it. It does **NOT** echo the scene back (that fired on every edit and cost ~10k tokens of context for data nobody read — and it was the pre-expansion *file*, not the live world). Pass `returnScene:true` if you actually want the written file; **to verify an edit, read `/api/scene-state`.**
- **`GET .../api/editor-state`** + **`POST .../api/editor-action {action, …}`** (allowlisted) + **`GET .../api/scenes`** + **`POST .../api/import-file {srcPath, destFolder}`** — the editor-parity surface (live UI state read; selection/play/undo/scene/prefab/entity actions; scene list; Finder-style import). `editor-state`/`editor-action` relay to the renderer, so they need a tab/editor open. See the modoki MCP section above for the tool wrappers.
- **`GET .../api/build-modules`** — resolves `build.modules` (`'auto' | boolean` per module) for the OPEN project, reusing the same Node-side scene-scan `resolveModules` a real build uses (`engine/plugins/detect-modules.ts`). No renderer/tab needed — pure filesystem read. Lets an agent (or `get_editor_state`'s `rendererGate.render3d`) tell whether a project actually renders 3D, e.g. to explain a suppressed "no 3D viewport" watchdog warning on a 2D/UI-only project.

**Gotcha:** the Vite plugin loads once at server startup. Editing the plugin **or any module it imports** (`sceneValidation`, `sceneMutate`, `assetRefRules`) requires a dev-server restart (`curl /api/exit` + `npm run dev`). Browser-side modules (`agentBridge`, `sceneSchema`) hot-update normally.
