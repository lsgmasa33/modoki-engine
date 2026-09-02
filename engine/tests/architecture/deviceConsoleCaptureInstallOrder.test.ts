import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';

/**
 * The device console capture (#591) must be installed by a SIDE-EFFECT IMPORT placed above
 * `./App.tsx`, not by a call in `main.tsx`'s body — modeled closely on
 * `errorCaptureInstallOrder.test.ts` (#275), the same construct for the same reason.
 *
 * ⚠️ THE RACE THIS CLOSES is invisible at a glance: the capture used to be reachable only through
 * `initDebugBridge()`, behind an ASYNC dynamic `import('./debug/bridge')` in main.tsx.
 * `createRoot().render()` runs synchronously right after that import starts, so React mounts — and
 * its effects run — before the chunk is guaranteed to have resolved. The same build captured a
 * mount-time log on an iPad mini 5 and did not on a Galaxy S22: a RACE, not a platform quirk. ES
 * module imports are hoisted and evaluated in source order BEFORE any statement of the importing
 * module runs, so only a side-effect import placed above `./App.tsx` runs early enough to cover
 * React's own mount effects.
 *
 * ⚠️ SOURCE ORDER IS NECESSARY, NOT SUFFICIENT, and this guard can only see the necessary half.
 * Device-measured on a Galaxy S22 (2026-09-03): in a production bundle rolldown emits this module in
 * a shared chunk the entry imports AFTER chunks belonging to App.tsx's graph, so a module-eval log
 * inside that graph is still missed while a mount-time one is captured. Do not read a green here as
 * "everything at boot is captured" — see `app/installDeviceConsoleCapture.ts` for what was measured.
 *
 * ⚠️ This guard PARSES the import list and the gate expression rather than grepping the file, for
 * the same reason `errorCaptureInstallOrder.test.ts` does: the files explain themselves in comments
 * naming `installDeviceConsoleCapture` and `App.tsx`, so a text match would be satisfied by the
 * explanation of the rule instead of the rule.
 */

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app');
const MAIN = path.join(appDir, 'main.tsx');
const INSTALL_DEVICE_CONSOLE_CAPTURE = path.join(appDir, 'installDeviceConsoleCapture.ts');
const BRIDGE = path.join(appDir, 'debug/bridge.ts');

/** Import specifiers in source order, comments stripped via the shared scanner
 *  (@modoki/engine/testing, #419). Mirrors errorCaptureInstallOrder.test.ts's helper. */
function importSpecifiers(src: string, label: string): string[] {
  const code = stripComments(src);
  assertScanIsSane(src, code, label);
  return [...code.matchAll(/^\s*import\s+(?:[^'"]*?from\s*)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

/** Pull the boolean gate expression out of an `if (<expr>) {` line, comments stripped first, with
 *  whitespace normalized to a single space so formatting differences don't fail a semantically
 *  identical expression. Used both for main.tsx's bridge-import gate and
 *  installDeviceConsoleCapture.ts's own gate — they must fold identically or a release build's DCE
 *  diverges between the two sites. */
function extractGate(src: string, marker: string | RegExp, label: string): string {
  const code = stripComments(src);
  assertScanIsSane(src, code, label);
  const lines = code.split('\n');
  const markerIdx = lines.findIndex((l) => (typeof marker === 'string' ? l.includes(marker) : marker.test(l)));
  expect(markerIdx, `${label}: could not find a line matching ${marker} to locate the guarding "if" from`).toBeGreaterThanOrEqual(0);
  // The marker (the bridge import call / the installDeviceConsoleCapture() call) sits INSIDE the
  // `if` block, not necessarily on its own "if (...)" line — walk backward to find it.
  let ifIdx = markerIdx;
  while (ifIdx >= 0 && !/if\s*\(/.test(lines[ifIdx])) ifIdx--;
  expect(ifIdx, `${label}: no preceding "if (" line found above line ${markerIdx} ("${lines[markerIdx]}")`).toBeGreaterThanOrEqual(0);
  const m = lines[ifIdx].match(/if\s*\((.*)\)\s*\{?\s*$/);
  expect(m, `${label}: line ${ifIdx} ("${lines[ifIdx]}") does not match the expected "if (<expr>) {" shape`).not.toBeNull();
  return m![1].replace(/\s+/g, ' ').trim();
}

describe('device console capture install order (#591)', () => {
  const mainSrc = fs.readFileSync(MAIN, 'utf8');
  const specs = importSpecifiers(mainSrc, 'app/main.tsx');

  it('imports ./installDeviceConsoleCapture BEFORE ./App.tsx', () => {
    const capture = specs.findIndex((s) => s.includes('installDeviceConsoleCapture'));
    const app = specs.findIndex((s) => s.includes('App.tsx'));
    expect(capture, 'main.tsx must import ./installDeviceConsoleCapture').toBeGreaterThanOrEqual(0);
    expect(app, 'main.tsx must import ./App.tsx').toBeGreaterThanOrEqual(0);
    expect(
      capture,
      `./installDeviceConsoleCapture must be imported BEFORE ./App.tsx (it is at ${capture}, App.tsx at ${app}). ` +
        `Imports evaluate in source order, so anything above App.tsx is the only code that runs ` +
        `before React's mount effects — which is where the #591 ` +
        `boot-time console race lived.`,
    ).toBeLessThan(app);
  });

  it("does NOT install by calling installDeviceConsoleCapture( from main.tsx's body", () => {
    const stripped = stripComments(mainSrc);
    assertScanIsSane(mainSrc, stripped, 'app/main.tsx');
    const body = stripped
      .split('\n')
      .filter((l) => !/^\s*import\s/.test(l))
      .join('\n');
    expect(
      /\binstallDeviceConsoleCapture\s*\(/.test(body),
      'main.tsx must not CALL installDeviceConsoleCapture() directly — a statement runs after every ' +
        'import, which is too late. The side-effect import ./installDeviceConsoleCapture is the install.',
    ).toBe(false);
  });

  it("installDeviceConsoleCapture.ts's gate is byte-identical (modulo whitespace) to main.tsx's bridge-import gate", () => {
    const installSrc = fs.readFileSync(INSTALL_DEVICE_CONSOLE_CAPTURE, 'utf8');
    const mainGate = extractGate(mainSrc, "import('./debug/bridge')", 'app/main.tsx (bridge-import gate)');
    const installGate = extractGate(installSrc, 'installDeviceConsoleCapture()', 'app/installDeviceConsoleCapture.ts');
    expect(
      installGate,
      'installDeviceConsoleCapture.ts\'s gate must fold IDENTICALLY to the one guarding ' +
        "import('./debug/bridge') in main.tsx, or a release build's dead-code elimination strips " +
        'one but not the other — shipping either a stray console patch or a stray eval-capable ' +
        `bridge chunk. main.tsx gate: "${mainGate}" — installDeviceConsoleCapture.ts gate: "${installGate}"`,
    ).toBe(mainGate);
  });

  it('installDeviceConsoleCapture.ts pulls in NOTHING beyond the gate and the installer', () => {
    const installSrc = fs.readFileSync(INSTALL_DEVICE_CONSOLE_CAPTURE, 'utf8');
    // The precedent's most load-bearing assertion (errorCaptureInstallOrder.test.ts:70), and it
    // matters MORE here: this module is in main.tsx's STATIC graph, so anything it imports is both
    // evaluated uncovered AND a new candidate to survive DCE into a release bundle. `verify` would
    // stay green either way, and the only gate that could notice (`smoke:debug-flag`) is manual and
    // greps for `[console-capture]`, not for whatever else came along for the ride.
    expect(importSpecifiers(installSrc, 'app/installDeviceConsoleCapture.ts'))
      .toEqual(['@capacitor/core', './debug/deviceConsoleCapture']);
  });

  it('bridge.ts no longer declares its own capture — there can only ever be ONE BRIDGE ring', () => {
    const bridgeSrc = fs.readFileSync(BRIDGE, 'utf8');
    const stripped = stripComments(bridgeSrc);
    assertScanIsSane(bridgeSrc, stripped, 'app/debug/bridge.ts');
    // consoleSource.ts's own "one capture, one copy" rationale (#157): a second capture on device
    // would double-wrap console.* and carry a second copy of every line, on exactly the low-end
    // hardware whose budget is tightest. bridge.ts must READ the shared ring, not build its own.
    // ⚠️ "ONE ring" is scoped to the BRIDGE deliberately — it is not a claim about the process.
    // `runtime/debug/consoleCapture.ts` installs a third capture by side effect from
    // `runtime/debug/index.ts`, and that chunk does load on device in a debug build. Do not cite
    // this test as evidence the process has a single console ring; it does not.
    expect(
      /\bcreateConsoleRing\s*\(/.test(stripped),
      'bridge.ts must not call createConsoleRing( itself — the ring now lives in ' +
        'deviceConsoleCapture.ts and bridge.ts should only import { consoleRing, ' +
        'installDeviceConsoleCapture } from it.',
    ).toBe(false);
    expect(importSpecifiers(bridgeSrc, 'app/debug/bridge.ts').some((s) => s.includes('./deviceConsoleCapture'))).toBe(true);
  });

  it('bridge.ts does not bind console.log itself — its chatter must bypass the ring', () => {
    const bridgeSrc = fs.readFileSync(BRIDGE, 'utf8');
    const stripped = stripComments(bridgeSrc);
    assertScanIsSane(bridgeSrc, stripped, 'app/debug/bridge.ts');
    // THE EXACT REGRESSION #591's FIX INTRODUCED, and the reason this guard is worth its lines.
    // `const _log = console.log.bind(console)` at bridge module scope used to capture the PRISTINE
    // function, because the capture was installed later by `initDebugBridge()`. Installing eagerly
    // from main.tsx inverted the order, so that same bind captured the ring WRAPPER and the bridge's
    // ~25 `_log` sites began filling the 200-entry ring — one line per input op, so a couple of
    // hundred device_tap/drag calls evict the boot log the whole feature exists to preserve. It was
    // invisible in `verify` and read as SUCCESS in the device measurement (the `[debug-bridge]`
    // lines were sitting in the ring). `_log` must come from `unpatchedLog`.
    // ⚠️ PINNED POSITIVELY, and blacklisting a spelling is not good enough — that was this guard's
    // first draft and review shot it down. `_err` three lines below `_log` is written
    // `(...args) => console.error(...args)`, so the most natural future edit is "make `_log`
    // symmetric": `const _log = (...args: unknown[]) => console.log(...args);`. That reintroduces
    // the whole regression and matches no `console.log.bind(` blacklist, keeps `./deviceConsoleCapture`
    // imported (so the import pin still passes), and never touches `unpatchedLog` (so the unit test,
    // which calls it directly, cannot see `_log` stop pointing at it). All three guards would stay
    // green. So: assert what `_log` IS, and that bridge.ts names `console.log` nowhere at all.
    expect(
      /const\s+_log\s*=\s*unpatchedLog\s*;/.test(stripped),
      'bridge.ts must define `const _log = unpatchedLog;` — since #591 the capture is installed '
        + 'eagerly, so ANY local binding of console.log (a .bind, an arrow, a destructure) captures '
        + 'the ring wrapper and puts every [debug-bridge] line into the 200-entry ring.',
    ).toBe(true);
    expect(
      /console\s*\.\s*log\b/.test(stripped),
      'bridge.ts must not reference `console.log` at all — its own chatter goes through '
        + '`unpatchedLog` so it cannot evict the boot logs `device_console_logs` exists to show. '
        + '(`console.error` via `_err` IS deliberately in the ring; `console.warn` is unrelated.)',
    ).toBe(false);
    expect(importSpecifiers(bridgeSrc, 'app/debug/bridge.ts').some((s) => s.includes('./deviceConsoleCapture'))).toBe(true);
  });
});
