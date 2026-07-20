# Device MCP — Connection Guide

## Overview

Device debugging is a **deliberate, Modoki-owned lease** — NOT auto-discovery. The human clicks
**Connect a Device** in the editor's AI panel; the editor backend holds one TCP connection to the
device, mints + holds a lease GUID, pings, and auto-reconnects across game relaunches. This MCP
owns no connection: every `device_*` tool proxies through the backend's `/api/device/request`.

There is **no Bonjour/mDNS** and **no auto-connect**. The old design browsed the LAN continuously
and grabbed any device the moment it advertised — with several Claude sessions running that
*stormed* the single-client device. See `docs/debug-tools-mcp.md`.

```
┌────────────────────────────────┐          ┌──────────────────────┐        ┌────────────┐
│  Device (iOS/Android)          │   TCP     │  Modoki editor       │  HTTP  │ device MCP │  stdio
│  ┌──────────┐  ┌────────────┐  │  :9095    │  backend (per clone) │◄───────│ (thin      │◄──── Claude
│  │ WebView  │◄─│ Native     │◄─┼───────────│  holds lease + GUID  │ /api/  │  client)   │      Code
│  │ (game)   │─►│ TCP :9095  │──┼──────────►│  pings, reconnects   │ device │            │
│  └──────────┘  └────────────┘  │           └──────────────────────┘ /request└────────────┘
└────────────────────────────────┘                    ▲
                                          AI panel → "Connect a Device" (human)
```

## How it works

1. **Human connects** — AI panel → *Connect a Device*: type the device IP (shown in the game's
   debug menu → Device tab), or check **Use adb (USB)** for Android over USB.
2. **Backend leases** — mints/loads a per-clone GUID (`.modoki/device-guid`), opens the TCP socket
   (typed IP, or `adb forward` → `127.0.0.1`), sends a `connect{guid}` the device accepts (first
   wins). It pings, and on a drop auto-reconnects within a 5s grace window using the same GUID.
3. **Claude proxies** — `device_*` tools `POST /api/device/request {method, params}`; the backend
   forwards over its held socket, the device's JS bridge answers, the reply comes back. **The GUID
   never leaves the backend** (controlled comms).

One backend per clone → **one device per clone** (each clone pins its own `MODOKI_BACKEND` port:
main 5179 / work-ai 5180 / work-ai2 5181). No `target` param, no platform in the tool name.

---

## Connecting

### iOS (WiFi)
1. Build+install a **Debug** build (the plugin is `#if DEBUG`-gated) and launch the game.
2. Open the game's debug menu (3-finger tap) → **Device** tab → read the **Debug connect IP**.
3. In the editor AI panel → *Connect a Device*, enter that IP, click **Connect**.
4. First install shows the iOS **Local Network** permission prompt — tap Allow.
5. **Keep the game foregrounded** — iOS tears down the listener on suspend/background.

### Android (adb over USB — recommended)
1. Connect over USB; `adb devices` shows it as `device`.
2. AI panel → *Connect a Device* → check **Use adb (USB)** → **Connect**. The backend runs
   `adb forward tcp:9095 tcp:9095` and connects to `127.0.0.1:9095`.
   (WiFi by IP also works if the router doesn't isolate AP clients; adb is the reliable path.)

The editor remembers the last IP / adb choice per clone (`.modoki/device-target.json`) and
pre-fills the field on relaunch.

### Deadlock recovery
If the connection wedges, **relaunch the game** — the backend reconnects with the held GUID inside
the grace window. If a second Modoki already holds the device, its connect is refused (first wins).

---

## Available MCP tools

Every tool proxies through the backend lease. Opening the lease is a **deliberate** action — either
the human clicks *Connect a Device* in the AI panel, **or** an agent calls **`device_connect`** (below)
explicitly. This is NOT the removed Bonjour auto-connect (which stormed the single-client device), and
the lease is **first-wins**, so an explicit connect can't grab a device another editor already holds.

**Percept — read-by-data** (structured, summary-first, GUID-addressed, floats rounded 9 sig-figs).
These reuse the SAME op registry as the editor `modoki` MCP, delegated onto the device path (see
`docs/plans/device-percept-enact-plan.md`). Verify game state by DATA — critical on Android, where the
WebGPU screenshot is black:

| Tool | Description |
|---|---|
| `device_get_scene_state` | Live ECS world as data — bare = compact INDEX (id/guid/name/traits); drill down with `guid`/`trait`/`name`/`where`/`full`/`world`/`bounds`/`contacts` |
| `device_diagnose` | Structured render/scene health — the causes behind a black/wrong frame (console errors, off-screen entities, missing camera, bad transforms) |
| `device_journal` | Tick-stamped game-event trace (match/score/@contact/…) — verify LOGIC without pixels |
| `device_introspect` | Dispatchable action names (+ schemas) and live named read-values |
| `device_layout_bounds` | Numeric screen-space rects (UI DOM / 2D / 3D world-AABB projected); bare = counts + offScreen/zeroSize ids |
| `device_watch` | Standing numeric time-series over the live world (`start`/`read`/`list`/`clear`) — spring settle, velocity decay, overshoot |

**Enact — trusted input:**

| Tool | Description |
|---|---|
| `device_tap` | Tap by CSS `selector` (resolved on-device, occlusion-checked, **no screenshot**) or screenshot pixel `x`/`y` |
| `device_drag` | Drag between two points, each aimed by selector (`fromSelector`/`toSelector`) or screenshot coords. `dom:true` (auto on a non-canvas grab) drags DOM chrome (widgets/sliders) by dispatching on the element itself |
| `device_dispatch_action` | Trigger a game intent directly by name (no pixel-hunting); a no-op is reported as an error, not a phantom success |
| `device_press_key` | Press a key chord (keydown/hold/keyup) — open the debug menu (`F12`), Escape a modal, drive gameplay keys; `key` + `modifiers[]` |
| `device_hover` | Hover a target (pointerover/enter/move) so :hover styles / tooltips / hover-gated UI activate |
| `device_scroll` | Scroll by dispatching a wheel event at a point/selector (defaults to viewport center) |

**Utility:**

| Tool | Description |
|---|---|
| `device_status` | Report the lease (connected device, or how to connect) |
| `device_connect` | Open the lease — `ip` (WiFi) or `useAdb:true` (USB); bare = reconnect the last target. Same action as the AI panel's *Connect a Device* |
| `device_disconnect` | Close the lease (release the device for another editor) |
| `device_eval` | Execute JavaScript in the game page context |
| `device_screenshot` | Capture the screen → saves file, opens Preview, returns **path + dimensions** (image inlined only with `inline:true`). Android: full framebuffer via `adb screencap`; iOS: native via the lease |
| `device_console_logs` | Return captured `console.log/warn/error/info` |
| `device_native_logs` | Return native logs (Android logcat / iOS `os_log`) |

**Aiming:** prefer a CSS `selector` on `device_tap`/`device_drag` — it resolves on-device (occlusion
reported) with no screenshot round-trip. Otherwise take a `device_screenshot` first and pass its
**pixel coordinates** (converted to CSS via device pixel ratio + canvas offset). On iOS the device
stores the last capture's dims and converts itself; on Android the MCP passes the adb capture's dims as
`screenInfo`.

**Android screenshots use `adb screencap` when the lease is adb, not the lease's native capture.** A
WebGL/WebGPU canvas inside the Android WebView composites in a separate GPU surface, so the native
`captureScreen` (`rootView.draw()`) renders it black — `adb screencap` reads the real framebuffer
(3D + HUD). `device_screenshot` uses it only when the **lease target is adb** (not merely because some
Android is on USB — else a WiFi-iPhone lease would capture the wrong device); it's read-only. iOS (and
any WiFi lease) captures natively through the lease.

---

## MCP configuration

`.mcp.json` (per clone) — the MCP is a thin HTTP client of the clone's backend:
```json
"game-debug": {
  "command": "npx",
  "args": ["tsx", "engine/tools/game-debug-mcp/src/index.ts"],
  "env": { "MODOKI_BACKEND": "${MODOKI_BACKEND:-http://127.0.0.1:5179}" }
}
```
Point a session at its clone with `MODOKI_BACKEND=http://127.0.0.1:<port>`. Ports: **9095** is the
device's TCP server (owned by the backend, not this MCP).

---

## Debug vs Release

| Concern | Debug build | Release build |
|---|---|---|
| iOS TCP server (`#if DEBUG`) | Runs | Plugin not registered |
| iOS Local Network prompt | Shows on first install | Never triggers |
| Android TCP server (`FLAG_DEBUGGABLE`) | Runs | `startServer()` rejects |
| JS bridge code | Native + dev | Native only (plugin no-ops on web) |

No Bonjour/mDNS advertising on either platform — it was removed from both the plugin and the MCP.

---

## Troubleshooting

- **`device_*` says "no device connected"** — connect in the AI panel first; check `device_status`.
- **Connect stuck / times out** — wrong IP, not on the same WiFi, not a Debug build, or firewalled.
  The connect is bounded (~6s) and reports which of these to check. On Android, prefer adb.
- **iOS drops after a while** — the app was backgrounded; keep it foregrounded and reconnect.
- **Second Modoki can't connect** — the device is leased by another clone (first wins). Disconnect
  there, or relaunch the game to reset the lease.
- **Can't reach the backend** — the editor isn't running for that clone, or `MODOKI_BACKEND` points
  at the wrong port.

### Manual end-to-end (bypass the MCP)
```bash
curl -s http://127.0.0.1:5179/api/device/status
curl -s -X POST http://127.0.0.1:5179/api/device/request \
  -H 'content-type: application/json' \
  -d '{"method":"eval","params":{"code":"return document.title"}}'
```
