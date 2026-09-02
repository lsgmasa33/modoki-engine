/** The device console-capture ring and its `console.*` patch — split out of `bridge.ts` so it can
 *  be installed EAGERLY, at module-evaluation time, above `App.tsx`'s import (#591).
 *
 *  THE RACE THIS CLOSES. The capture used to live inside `bridge.ts`, reached only through
 *  `initDebugBridge()`, which `main.tsx` calls from behind an ASYNC dynamic
 *  `import('./debug/bridge')`. `createRoot().render()` runs synchronously right after that import
 *  is kicked off, so React mounts — and its effects run — before the chunk is guaranteed to have
 *  resolved. Whether a mount-time `console.info` was captured therefore depended on how fast that
 *  chunk loaded relative to React's first effects: the SAME build captured it on an iPad mini 5 and
 *  did not on a Galaxy S22. A missing device log was never trustworthy evidence of anything.
 *
 *  WHY A SEPARATE MODULE, NOT JUST AN EAGER CALL IN bridge.ts. Position, not code: this file is
 *  imported (via `../installDeviceConsoleCapture.ts`) directly into `main.tsx`'s static import graph, so
 *  it runs before React mounts instead of racing a chunk fetch (see that file for what this does and
 *  does NOT reach — a module-eval log inside App.tsx's graph is still missed) — while `bridge.ts` MUST stay a
 *  lazy chunk. `bridge.ts` also pulls in the native TCP server and `capacitor-game-debug`; a release
 *  build constant-folds its gate to `false` and Rollup DCEs that entire eval-capable chunk out, and
 *  that guarantee (the one `main.tsx`'s bridge-import comment documents) must survive this split.
 *  The console patch itself is pure JS wrapping `console` — no native dependency — so it can move
 *  without taking any of that surface with it.
 *
 *  WHY THE NAME IS DEVICE-QUALIFIED. `agentBridge.ts` exports its OWN, unrelated
 *  `installConsoleCapture()` — the EDITOR-side capture, populating `consoleBuffer` — and a second
 *  identically-named function in the same directory tree is exactly how #157 recurred: `diagnose`
 *  once read the wrong one of these two rings on device and reported a structurally clean bill of
 *  health. `installDeviceConsoleCapture` names which ring this one is, on sight.
 */

import { setConsoleSource } from './consoleSource';
import { createConsoleRing, MAX_CONSOLE_LOGS } from './bridgeHelpers';

/** Prefixes the two synthetic ring entries below, and doubles as the bundle-leak marker
 *  `smoke-debug-build-flag.mjs` greps for: this module is now in `main.tsx`'s STATIC import graph
 *  rather than behind a lazy chunk, so it is the one piece of the debug surface whose stripping from
 *  a release build is not guaranteed by lazy-chunking alone — the smoke test's job is to prove the
 *  build-constant gate still DCEs it. */
export const CONSOLE_CAPTURE_MARKER = '[console-capture]';

// `/* @__PURE__ */`: this module is reachable from `main.tsx`'s STATIC import graph (unlike
// `bridge.ts`, which stays behind a dynamic import precisely so it can be DCE'd), so a release build
// must be able to tree-shake this ring away when nothing calls `installDeviceConsoleCapture()`.
// `createConsoleRing` genuinely just allocates and returns a plain object — no side effect the
// annotation would be lying about — so marking it pure is honest, not a workaround.
export const consoleRing = /* @__PURE__ */ createConsoleRing(MAX_CONSOLE_LOGS);

/** `console.log` bound BEFORE this module's own patch, for the bridge's OWN chatter (`bridge.ts`'s
 *  `_log`) — which must reach logcat/OSLog WITHOUT entering the ring.
 *
 *  ⚠️ THIS EXPORT EXISTS BECAUSE #591 BROKE THE OLD WAY OF GETTING IT, silently. `bridge.ts` used to
 *  get the pristine function for free from `const _log = console.log.bind(console)` at its own module
 *  scope: the capture was installed by `initDebugBridge()`, i.e. strictly AFTER that module had
 *  evaluated, so the bind captured the unwrapped function. Installing eagerly from `main.tsx`
 *  inverted that — `console.log` is already the wrapper by the time `bridge.ts` evaluates — and the
 *  bridge's ~25 `_log` call sites began pushing into the ring. Every `device_tap`/`drag`/`pointer`/
 *  `press_key`/`type_text` logs one line, so ~200 input ops evict the whole 200-entry ring: the change
 *  that made a boot log capturable would have made it evictable by the very tool used to read it.
 *  Caught in review by noticing that `[debug-bridge] Initializing native bridge` appeared in the
 *  ring in the S22 measurement — which had been read as evidence the fix worked.
 *
 *  What it binds is the PRISTINE `console.log`, so the bridge's chatter bypasses every capture
 *  installed after `main.tsx`'s static graph — this ring, the editor's, and `runtime/debug`'s in-game
 *  one (whose Console tab therefore stops showing `[debug-bridge]` lines it usually used to show,
 *  since `bridge.ts` was a late lazy chunk; deliberate — the same eviction argument applies to its
 *  ring too). Nothing installed EARLIER wraps `console.log`: `installGlobalErrorHandlers` touches
 *  only `console.error`/`console.warn`. `.bind()` is genuinely side-effect-free, so the
 *  `@__PURE__` annotation is honest and keeps this droppable in a release build. */
export const unpatchedLog: (...args: unknown[]) => void = /* @__PURE__ */ console.log.bind(console);

let installed = false;

/** Patch `console.*` to also record into `consoleRing`, and capture uncaught errors/rejections that
 *  never reach `console.*` at all. Idempotent: `main.tsx` calls this EAGERLY (#591) and
 *  `initDebugBridge()` still calls it too — the bridge must not depend on the eager install having
 *  fired — so a double-install would otherwise wrap `console.*` twice and record every line twice. */
export function installDeviceConsoleCapture(): void {
  if (installed) return;
  installed = true;

  // Publish the ring FIRST, before anything that could conceivably fail. Ordered this way, no
  // partial failure can leave the ring both filling and unreadable, so the flag can stay at the top
  // where a retry cannot double-wrap `console.*` (a second pass would bind the first wrapper as its
  // `original`, giving two ring entries per line and two listeners per uncaught error — exactly what
  // this function's idempotence exists to prevent). The alternative — flag last, so a throw is
  // retryable — trades a blind ring for a double-wrapped one; this ordering needs neither.
  // Without this publication the device captured faithfully and nothing could reach it (see
  // consoleSource.ts); `setConsoleSource` is a bare assignment, so it cannot throw.
  setConsoleSource(() => consoleRing.entries.map((e) => ({
    // The ring carries 'info' as a distinct level; the reader's vocabulary has three. Fold it into
    // 'log' rather than dropping the entry — losing a line to a vocabulary mismatch is the same
    // class of silent omission this whole seam exists to end.
    level: e.level === 'info' ? 'log' : e.level,
    ts: e.timestamp,
    text: e.args.join(' '),
  })));

  const levels = ['log', 'warn', 'error', 'info'] as const;
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      consoleRing.push(level, args);
    };
  }
  // An uncaught error or a rejected promise never reaches `console.*`, so the patch above cannot
  // see it — and a failed dynamic import or a throw deep in scene/resource loading is exactly the
  // kind of thing worth diagnosing on a phone. `agentBridge` records these for the editor; the
  // device had no equivalent, so its ring was silent on the whole class (#157).
  // Each wrapped in try/catch for the same reason `agentBridge`'s twin is ("never let capture break
  // logging"), and it matters MORE here: this handler runs INSIDE the window error handler, so a
  // throw while describing an error becomes another error event. `e.error` is attacker-shaped in the
  // general case — a value whose `stack` getter throws, or a Proxy — and `String(e.message)` can
  // throw on an object with a hostile `toString`. Without the guard the entry is lost AND an
  // exception escapes into the host, at precisely the moment something is already going wrong.
  if (typeof window !== 'undefined') {
    window.addEventListener('error', (e) => {
      try {
        const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : '';
        const msg = e.error instanceof Error ? (e.error.stack || e.error.message) : String(e.message);
        consoleRing.push('error', [`${CONSOLE_CAPTURE_MARKER} [uncaught] ${msg}${where}`]);
      } catch { /* ignore — a capture failure must never amplify the error it is reporting */ }
    });
    window.addEventListener('unhandledrejection', (e) => {
      try {
        const r = (e as PromiseRejectionEvent).reason;
        const msg = r instanceof Error ? (r.stack || r.message) : String(r);
        consoleRing.push('error', [`${CONSOLE_CAPTURE_MARKER} [unhandledrejection] ${msg}`]);
      } catch { /* ignore */ }
    });
  }
  // (The ring is published to `consoleSource` at the TOP of this function — see the note there for
  // why the ordering, not a trailing flag, is what makes partial failure harmless.)
}
