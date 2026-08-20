import type { PluginListenerHandle } from '@capacitor/core';

/** The fault shapes {@link GameDebugPlugin.triggerFault} can raise.
 *
 *  - `crash` — a genuine native crash on BOTH platforms: Android sends itself SIGSEGV
 *    (`Process.sendSignal(myPid(), 11)`), iOS dereferences a bad pointer (`EXC_BAD_ACCESS`).
 *    ⚠️ Android REPORTING of a signal crash needs `firebase-crashlytics-ndk` on the classpath —
 *    the Java handler never sees a signal, so without it the fault is real and only an
 *    `ApplicationExitInfo` row arrives. Triggering and reporting are separate questions and this
 *    only answers the first; see docs/debug-menu.md § Faults for how to tell them apart in logcat.
 *  - `anr` — Android only. Blocks the real main looper for `blockMs` (default 45000). TWO steps are
 *    needed and each closes a different gap: the system raises an ANR on an INPUT/broadcast timeout
 *    (so tap the screen during the block), and the REPORT exists only if the process then DIES of it
 *    (so choose "Close app" in the system dialog). Measured on an S22: a 15 s block that ends on its
 *    own produces a system-confirmed ANR, no ApplicationExitInfo record, and no report.
 *  - `uncaught` — Android only. An uncaught `RuntimeException` on the UI thread — the canonical
 *    Android fatal, and a different handler from Firebase's own synthetic `crash()`.
 *
 *  iOS rejects `anr` and `uncaught` rather than approximating them. It has no ANR: the watchdog
 *  (0x8badf00d) only kills during launch/suspend transitions, not steady-state foreground, and
 *  Crashlytics does not report hangs at all — MetricKit's `MXHangDiagnostic` is the only oracle,
 *  which is a different subsystem, not a probe. */
export type FaultKind = 'crash' | 'anr' | 'uncaught';

export interface GameDebugPlugin {
  /** Start the TCP server + UDP beacon */
  startServer(options?: { port?: number }): Promise<{ port: number }>;

  /** Stop the server */
  stopServer(): Promise<{ ok: boolean }>;

  /** Check if server is running and has a connected client */
  getStatus(): Promise<{ running: boolean; clientConnected: boolean; port: number }>;

  /** Send a response back to the connected MCP client */
  sendResponse(options: { id: string; result?: string; error?: string }): Promise<{ ok: boolean }>;

  /** Capture full screen as JPEG (native rendering, not just canvas) */
  captureScreen(): Promise<{
    image: string;
    imageWidth: number;
    imageHeight: number;
    screenWidth: number;
    screenHeight: number;
  }>;

  /** Get recent native logs (os_log on iOS, logcat on Android) */
  getNativeLogs(options?: { limit?: number; seconds?: number; filter?: string; subsystem?: string }): Promise<{ logs: string[]; error?: string }>;

  /** The device's WiFi IPv4 address (empty string if WiFi is down) — shown in the in-game
   *  debug menu so the user can type it into Modoki's device Connect field. */
  getDeviceIp(): Promise<{ ip: string }>;

  /** WHICH DEVICE holds this lease (#146) — reported over the lease so the host can tie a
   *  WebDriverAgent launch to the leased phone instead of guessing from what is plugged into the
   *  Mac.
   *
   *  - `model` — iOS: `hw.machine`, the product type (`iPhone18,4`), which `xcrun devicectl`
   *    reports byte-identically as `hardwareProperties.productType`, so the two are comparable.
   *    Android: `Build.MODEL` (`SC-56C`), matching `adb shell getprop ro.product.model`.
   *  - `osVersion` — iOS `systemVersion` (`26.5.2`) / Android `Build.VERSION.RELEASE`.
   *
   *  **Both are `''` when unknown, never a fabricated value** — the host reads empty as "could not
   *  verify" and keeps its heuristic, which is a different (and safe) outcome from a mismatch.
   *  A plugin older than #146 has no such method and rejects; callers must treat that as unknown
   *  too. Deliberately NOT `@capacitor/device`: that plugin is optional and no Modoki project
   *  installs it, so reading it made the first version of #146 inert on every real device. */
  getDeviceHardware(): Promise<{ model: string; osVersion: string }>;

  /** Raise a DELIBERATE native fault, so the crash pipeline can be proven against the shapes a
   *  shipped game actually dies of (#278). Every kind KILLS OR FREEZES the app on purpose.
   *
   *  Why native at all: #275 proved the JS half end to end, and JS cannot reach any of this.
   *  Android's WebView renderer is a separate sandboxed process, so blocking the JS thread for
   *  8 s raises no ANR (measured 8002 ms, nothing reported); a Java exception and a signal crash
   *  each take a different route into Crashlytics than anything `globalErrors.ts` can produce.
   *
   *  Gated on the SAME `build.debugBuild` flag as the debug bridge — the Android manifest
   *  meta-data, the iOS Info.plist key — and rejects with that reason when it is off. A release
   *  build cannot be made to call this.
   *
   *  **The promise is not a result.** On `crash` and `uncaught` the process is gone before JS is
   *  resumed, so the call neither resolves nor rejects; treat a settled promise as "the fault was
   *  ACCEPTED", never as "the fault happened". The oracle is the crash console, not this return. */
  triggerFault(options: { kind: FaultKind; blockMs?: number }): Promise<{ ok: boolean }>;

  /** Listen for incoming requests from MCP */
  addListener(
    eventName: 'request',
    handler: (data: { id: string; method: string; params: string }) => void,
  ): Promise<PluginListenerHandle>;

  /** Listen for connection state changes */
  addListener(
    eventName: 'connectionChanged',
    handler: (data: { connected: boolean; remoteAddress?: string }) => void,
  ): Promise<PluginListenerHandle>;
}
