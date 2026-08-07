/** WHERE `diagnose` READS CONSOLE ERRORS FROM — one seam, so the writer and the reader can never
 *  again be two different buffers (#157).
 *
 *  THE BUG THIS EXISTS TO CLOSE. There are two console rings in this app, each correct on its own
 *  surface, and `diagnose` read the one that a shipped build never fills:
 *
 *    - `bridge.ts`      → `consoleRing`   (`patchConsole()`)          — populated ON DEVICE
 *    - `agentBridge.ts` → `consoleBuffer` (`installConsoleCapture()`) — populated IN THE EDITOR
 *
 *  `installConsoleCapture()` is called from `initAgentBridge()`, *after* `if (!hot && !bridge)
 *  return;`. A production build has no `import.meta.hot` and a phone has no Electron bridge, so on
 *  every real device that early return fires and `consoleBuffer` stays empty for the life of the
 *  process — while the ops registry, which registers by module side-effect, answers `diagnose`
 *  perfectly well from it. Measured on a Samsung SM-S901U1: the device ring held 5 errors
 *  (including a `[frameDriver]` boot stall) and `device_diagnose` answered
 *  `ok:true, consoleErrors:0, "No issues detected."`
 *
 *  That made a clean `device_diagnose` STRUCTURALLY guaranteed rather than observed — on the one
 *  surface where CLAUDE.md tells an agent to run it first, because the native screenshot is black
 *  on WebGPU. It is also why widening the #152 window could not make device boot errors visible:
 *  the window was never what hid them.
 *
 *  WHY A SEAM AND NOT A SECOND CAPTURE. The obvious fix — hoist `installConsoleCapture()` above the
 *  early return — would patch `console.*` a second time on device and carry a second copy of every
 *  line, on exactly the low-end hardware whose budget is someone else's open issue. The device
 *  ALREADY captures everything it needs; nothing was missing but a way for the reader to find it.
 *  So the writer publishes its ring here and the reader asks. One capture, one copy.
 *
 *  WHY NOT A DIRECT IMPORT EITHER WAY. `bridge.ts` reaches the ops registry through a DYNAMIC
 *  `import('./agentBridge')` on purpose, so the Percept chunk stays code-split out of a shipped
 *  game's main bundle (a release game rejects connections, so the chunk never loads at all). A
 *  static edge in either direction would defeat that. This module has no imports of its own beyond
 *  a type, so both sides can hold it cheaply.
 */

/** The shape `dumpConsoleLogs` serves. Mirrors `agentBridge`'s own entry so a registered source is
 *  indistinguishable from the native buffer at the read site. */
export interface ConsoleSourceEntry {
  level: 'log' | 'warn' | 'error';
  ts: number;
  text: string;
}

let source: (() => ConsoleSourceEntry[]) | null = null;

/** Publish a console ring for `diagnose`/`console-logs` to read. Called by whichever surface
 *  actually captured — today `bridge.ts` on device. Last registration wins; there is only ever one
 *  writer per process. */
export function setConsoleSource(fn: () => ConsoleSourceEntry[]): void {
  source = fn;
}

/** The registered ring, or `null` when nobody published one (the ordinary editor case, where
 *  `agentBridge`'s own buffer is the source and this seam stays inert).
 *
 *  A throwing source degrades to `null` rather than propagating. This feeds `diagnose` — the tool
 *  of LAST RESORT, the one you reach for when everything is already broken — so a fault in the
 *  reporting path must not be what denies you the report. Falling back to the (empty) native
 *  buffer reproduces the old behaviour exactly, which is a bad answer but never a dead tool. */
export function readConsoleSource(): ConsoleSourceEntry[] | null {
  if (!source) return null;
  try { return source(); } catch { return null; }
}

/** Test seam — a module-scope registration would otherwise leak between test files. */
export function _resetConsoleSourceForTests(): void {
  source = null;
}
