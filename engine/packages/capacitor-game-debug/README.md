# capacitor-game-debug

Capacitor 8 plugin that runs a **TCP debug server** on the device for remote game debugging. Paired with an **MCP (Model Context Protocol) server** that enables Claude Code to autonomously screenshot, tap, drag, eval JS, and read logs on physical iOS and Android devices.

## Installation

```bash
npm install capacitor-game-debug
npx cap sync
```

## How It Works

```
┌──────────────┐   TCP :9095   ┌──────────────────┐   HTTP   ┌────────────┐   MCP   ┌────────────┐
│  Device      │ ←───────────→ │  Modoki editor   │ ←──────→ │ device MCP │ ←─────→ │ Claude Code│
│ (iOS/Android)│               │  backend         │  /api/   │ (thin      │         │ (AI agent) │
│  TCP server  │               │  holds lease +   │  device/ │  client)   │         │            │
│  WebView     │               │  GUID, reconnects│  request │            │         │            │
└──────────────┘               └──────────────────┘          └────────────┘         └────────────┘
        ▲
   AI panel → "Connect a Device" (human: IP or adb)
```

The connection is a **deliberate, Modoki-owned lease** — no Bonjour/mDNS, no auto-discovery. The
editor backend holds one TCP socket + a per-clone lease GUID (which never leaves the backend) and
auto-reconnects; the `device_*` MCP is a thin client that proxies through `/api/device/request`. See
`docs/debug-tools-mcp.md`.

**iOS**: NWListener (TCP) over WiFi — connect by the IP shown in the game's debug menu.
**Android**: ServerSocket (TCP), first-wins single client — over USB via `adb forward tcp:9095 tcp:9095`, or by WiFi IP.

## Platform Details

| Feature | iOS | Android |
|---|---|---|
| Connection | WiFi IP (via lease) | adb forward (USB) or WiFi IP |
| Screenshot | `drawHierarchy` (captures WebGL) via lease | `adb screencap` (full framebuffer; native `captureScreen` can't capture the WebGL/WebGPU surface) |
| Tap/Drag | PixiJS EventSystem calls | PixiJS EventSystem calls |
| JS Eval | TCP bridge → WebView | TCP bridge → WebView |
| Native Logs | OSLogStore (iOS 15+) | logcat |
| Debug Gate | `#if DEBUG` | `FLAG_DEBUGGABLE` |

## Plugin API

```typescript
import { GameDebug } from 'capacitor-game-debug';
```

| Method | Description |
|---|---|
| `startServer({ port? })` | Start TCP server (default port 9095) |
| `stopServer()` | Stop TCP server |
| `getStatus()` | Check server running + client connected |
| `captureScreen()` | Take screenshot (base64 JPEG + dimensions) |
| `getNativeLogs({ limit?, seconds?, filter?, subsystem? })` | Read native platform logs |
| `sendResponse({ id, result?, error? })` | Reply to a bridge request |

### Events

```typescript
GameDebug.addListener('request', ({ id, method, params }) => {
  // Handle eval, tap, drag requests from MCP server
});

GameDebug.addListener('connectionChanged', ({ connected, remoteAddress }) => {
  // Client connected/disconnected
});
```

## MCP Server

The MCP server at `tools/game-debug-mcp/` is a **thin client** of the lease and provides 7 tools for
Claude Code (each proxies through the backend's `/api/device/request`):

| Tool | Description |
|---|---|
| `device_screenshot` | Capture device screen — saves to a file (`savePath` or temp), opens it in Preview, and returns the PATH + dimensions as text. Pass `inline:true` to also embed the image |
| `device_tap` | Tap at screenshot pixel coordinates (device converts to CSS off the last capture) |
| `device_drag` | Drag between two points (PixiJS EventSystem) |
| `device_eval` | Execute JavaScript in the game WebView |
| `device_console_logs` | Read captured console.log/warn/error |
| `device_native_logs` | Read iOS OSLogStore or Android logcat |
| `device_status` | Report the Modoki lease (connected device, or how to connect) |

### Coordinate System

Take a `device_screenshot` first, then use its **pixel coordinates** for `device_tap`/`device_drag`.
The device converts them to CSS off that capture (accounting for device pixel ratio and canvas offset).

### One device per clone

There is **no `target` parameter** — the lease already owns the single connected device (one backend
per clone). Connect it deliberately in the editor: AI panel → *Connect a Device*.

## Debug vs Release

The plugin is automatically disabled in release builds:
- **iOS**: `#if DEBUG` gates plugin registration in the view controller
- **Android**: `FLAG_DEBUGGABLE` runtime check rejects requests in release

## iOS Known Issue

SPM static linking strips the plugin class when there are no external framework dependencies. Requires manual registration in `MyViewController` + Xcode file reference to the plugin source file (project-relative path, no copy).

## Platform Requirements

- iOS 15.0+ (OSLogStore for native logs)
- Android API 21+
- Capacitor 8
- iOS + Mac on the same WiFi (connect by the device IP — no Bonjour)
- USB + adb for Android (or same-WiFi IP)
