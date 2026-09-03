/** The device console-capture SEAM — projects the ONE shared engine console ring
 *  (`@modoki/engine/runtime/core/consoleRing`, installed eagerly by `../installConsoleRing.ts`)
 *  rather than owning a fifth independent `console.*` patch of its own (#596/#597 Stage 2).
 *
 *  UNTIL STAGE 2, this file wrapped `console.log/info/warn/error` itself — split out of `bridge.ts`
 *  by #591 so it could be installed eagerly, but still its OWN patch, alongside three others (the
 *  shared ring, `agentBridge.ts`'s editor-side capture, and `runtime/debug`'s in-game one). That
 *  duplication is exactly what #596/#597 exists to end. The shared ring is now the ONLY thing that
 *  wraps `console.*`; this module patches nothing and instead PROJECTS the shared ring into the
 *  shapes this bridge's existing callers (`bridge.ts`, `consoleSource.ts`) already expect, so
 *  neither of them had to change.
 *
 *  UNTIL STAGE 3a, the `window` `error`/`unhandledrejection` listeners lived here too — the shared
 *  ring only sees `console.*` calls, so an uncaught error or a rejected promise needed a listener
 *  somewhere. But `agentBridge.ts` had grown its OWN, near-identical pair (#157's editor-side
 *  capture), and once both fed the one shared ring every uncaught error produced TWO entries. They
 *  now live in ONE place, `./uncaughtCapture.ts`, registered from `../installConsoleRing.ts`'s wider
 *  gate (not this module's narrower one — see that file's doc comment for why). `CONSOLE_CAPTURE_MARKER`
 *  is re-exported below so this module's existing importers don't need to change.
 *
 *  WHY THE NAME IS DEVICE-QUALIFIED. `agentBridge.ts` exports its OWN, unrelated
 *  `installConsoleCapture()` — the EDITOR-side capture, formerly populating `consoleBuffer` — and a
 *  second identically-named function in the same directory tree is exactly how #157 recurred:
 *  `diagnose` once read the wrong one of these two rings on device and reported a structurally clean
 *  bill of health. `installDeviceConsoleCapture` names which ring this one is, on sight.
 */

import { setConsoleSource } from './consoleSource';
import type { ConsoleLine } from './bridgeHelpers';
import { getConsoleRingEntries, recordConsoleRingEntry } from '@modoki/engine/runtime/core/consoleRing';

export { CONSOLE_CAPTURE_MARKER } from './uncaughtCapture';

/** `console.log` bound before ANY patch — a straight re-export of the shared ring's own
 *  `unpatchedLog`, for the bridge's OWN chatter (`bridge.ts`'s `_log`), which must reach
 *  logcat/OSLog WITHOUT entering the ring.
 *
 *  ⚠️ THIS EXPORT EXISTS BECAUSE #591 BROKE THE OLD WAY OF GETTING IT, silently — see
 *  `runtime/core/consoleRing.ts`'s own `unpatchedLog` doc comment for the full incident (~25
 *  `bridge.ts` call sites, ~200 input ops evicting the boot capture). Re-exporting the SAME binding
 *  that module captured at ITS OWN evaluation time — before `installConsoleRing()` (or this
 *  module's now-removed console patch) could ever run — keeps that guarantee in ONE place instead
 *  of two independent captures that could drift out of sync. */
export { unpatchedLog } from '@modoki/engine/runtime/core/consoleRing';

/** Project one shared-ring entry into this bridge's `ConsoleLine` shape. `timestamp` must be
 *  EPOCH — `bridge.ts`'s `handleConsoleLogs` and `diagnose` compare it against wall-clock windows —
 *  while the shared ring stores MONOTONIC `mono` (`performance.now()`; L0 cannot touch
 *  `Date.now()`, see the determinism guard). The conversion is exact
 *  (`performance.timeOrigin` is the epoch instant `performance.now()`'s zero point measures from)
 *  and belongs here, in the unscanned app layer, rather than in the engine's
 *  determinism-guarded `runtime/**`. */
function toConsoleLine(entry: { level: ConsoleLine['level']; args: string[]; mono: number }): ConsoleLine {
  return {
    type: 'console',
    level: entry.level,
    args: entry.args,
    timestamp: Math.round(performance.timeOrigin + entry.mono),
  };
}

/** Public shape mirrors what `bridgeHelpers.ts`'s `createConsoleRing` used to expose —
 *  `bridge.ts:546-547` calls `.query()` on this. `createConsoleRing` itself is GONE (#596/#597
 *  close-out review): it had no production caller left anywhere, only `bridge.test.ts`'s "console
 *  ring" tests, which pinned a private buffer nothing shipped ever read while THIS one — the one
 *  actually wired to `bridge.ts` — carried no unit contract of its own. Those tests are repointed
 *  at THIS object directly now, which is also why they can catch something the dead copy never
 *  could: a broken serializer in the shared ring's own `record()` path (`consoleRing.ts`'s
 *  `stringifyArg`) — exactly the Error-stack regression this same review found. What changed from
 *  the old private buffer is the backing: `entries`/`query` now PROJECT the shared ring instead of
 *  owning one. `push` records DIRECTLY into the shared ring (see its own doc comment below) — it
 *  has no caller left in this file since Stage 3a moved the `window` listeners to
 *  `./uncaughtCapture.ts` (which calls `recordConsoleRingEntry` itself), but stays exported as this
 *  projection's own synthetic-write API, exercised directly by `deviceConsoleCapture.test.ts` and
 *  `bridge.test.ts`. */
export const consoleRing = {
  get entries(): ConsoleLine[] {
    return getConsoleRingEntries().map(toConsoleLine);
  },
  /** ⚠️ Records DIRECTLY into the shared ring — deliberately NOT `console[level](...args)`.
   *  Routing these synthetic lines back through `console.error` would hand them to
   *  `globalErrors.ts`'s console.error wrapper, whose Error-object WeakSet dedup cannot match a
   *  string, filing a SECOND Crashlytics issue for an uncaught error it has already reported. See
   *  `recordConsoleRingEntry`'s doc comment and `globalErrors.ts:366-377`. */
  push(level: ConsoleLine['level'], args: unknown[]): void {
    recordConsoleRingEntry(level, args);
  },
  query(limit: number, level?: string): ConsoleLine[] {
    const all = getConsoleRingEntries().map(toConsoleLine);
    const filtered = level ? all.filter((l) => l.level === level) : all;
    return filtered.slice(-limit);
  },
};

let installed = false;

/** Register the #157 `consoleSource` seam. Idempotent: `main.tsx` calls this eagerly and
 *  `initDebugBridge()` still calls it too — the bridge must not depend on the eager install having
 *  fired — so a double-install must be a no-op.
 *
 *  ⚠️ #596/#597 Stage 3a moved the uncaught-error/rejection listeners OUT of this function and into
 *  `./uncaughtCapture.ts` (registered from `../installConsoleRing.ts`'s wider gate) — this module no
 *  longer registers any `window` listener at all. See this file's own doc comment for why. */
export function installDeviceConsoleCapture(): void {
  if (installed) return;
  installed = true;

  // Publish the ring — `setConsoleSource` is a bare assignment, so it cannot throw.
  setConsoleSource(() => consoleRing.entries.map((e) => ({
    // The ring carries 'info' as a distinct level; the reader's vocabulary has three. Fold it into
    // 'log' rather than dropping the entry — losing a line to a vocabulary mismatch is the same
    // class of silent omission this whole seam exists to end.
    level: e.level === 'info' ? 'log' : e.level,
    ts: e.timestamp,
    text: e.args.join(' '),
  })));
}
