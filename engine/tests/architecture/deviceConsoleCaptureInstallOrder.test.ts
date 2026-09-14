import { describe, it, expect } from 'vitest';
import { found } from '@modoki/engine/testing/inOrder';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, assertScanIsSane, readScannedSource } from '@modoki/engine/testing';
import { callsTo, findNodes, flatText, guardsOf, lineOf, parseSource, printedText, stringValueOf, ts } from '@modoki/engine/testing/sourceAst';

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
const INSTALL_CONSOLE_RING = path.join(appDir, 'installConsoleRing.ts');
const INSTALL_DEVICE_CONSOLE_CAPTURE = path.join(appDir, 'installDeviceConsoleCapture.ts');
const BRIDGE = path.join(appDir, 'debug/bridge.ts');

/** The parse of `abs`, comments blanked through the shared reader (@modoki/engine/testing, #419). */
function parsed(abs: string): ts.SourceFile {
  return parseSource(readScannedSource(abs).code, path.relative(appDir, abs));
}

/** Import specifiers in source order — the module's own `import` DECLARATIONS, so a dynamic
 *  `import('./x')` or a string naming one is not an import. Mirrors errorCaptureInstallOrder.test.ts. */
function importSpecifiers(abs: string): string[] {
  return parsed(abs).statements.filter(ts.isImportDeclaration).map((d) => stringValueOf(d.moduleSpecifier) ?? '<non-literal>');
}

/** The gate every one of `markers` runs under, as `printedText` spells it — so a formatter's wrap
 *  does not fail a semantically identical expression. Used both for main.tsx's bridge-import gate and
 *  installDeviceConsoleCapture.ts's own gate: they must fold identically or a release build's DCE
 *  diverges between the two sites.
 *
 *  ⚠️ **The marker's OWN condition, not the nearest `if (` line above it (#1179).** That walk took
 *  whatever `if` last opened ABOVE the marker — so a marker moved to just after the gate's closing
 *  brace, or into a nested `if` inside it, was still vouched for by the line above. Here each marker
 *  must run under exactly ONE condition, in the THEN branch of an `if`; anything else — no gate, an
 *  `else`, an early return above it, a second nested condition — fails, naming what it found. */
function gateOf(markers: ts.Node[], what: string, label: string): string {
  expect(markers.length, `${label}: no ${what} found to read the gate of`).toBeGreaterThan(0);
  const gates = markers.map((m) => {
    const guards = guardsOf(m);
    const seen = guards.map((g) => `${g.holds ? '' : 'NOT '}${printedText(g.test)}`);
    expect(
      guards.length === 1 && guards[0].holds && ts.isIfStatement(guards[0].by),
      `${label}:${lineOf(m)}: \`${flatText(m)}\` must run under exactly one condition — the THEN branch of `
        + `its gate \`if\`. It runs under: ${JSON.stringify(seen)}`,
    ).toBe(true);
    return printedText(guards[0].test);
  });
  expect(new Set(gates).size, `${label}: every ${what} must share one gate — found ${JSON.stringify(gates)}`).toBe(1);
  return gates[0];
}

/** `import('<spec>')` — a dynamic import of exactly that specifier. */
const dynamicImports = (sf: ts.SourceFile, spec: string): ts.CallExpression[] =>
  findNodes(sf, (n): n is ts.CallExpression => ts.isCallExpression(n)
    && n.expression.kind === ts.SyntaxKind.ImportKeyword && stringValueOf(n.arguments[0]) === spec);

describe('the gate reader reads the marker\'s OWN condition (#1179)', () => {
  const markersIn = (src: string) => callsTo(parseSource(src, 'fixture.ts'), 'install');

  it('accepts a gate the formatter wrapped, spelt the way the one-line form is', () => {
    expect(gateOf(markersIn('if (!a &&\n  (\n    b ||\n    c\n  )) {\n  install();\n}'), 'install()', 'fixture')).toBe('!a && (b || c)');
  });

  it.each([
    ['after the gate\'s block — the old walk found the `if (` line above it', 'if (!a && b) {\n  x();\n}\ninstall();'],
    ['inside a nested `if` in the gate', 'if (!a && b) {\n  if (c) {\n    install();\n  }\n}'],
    ['in the ELSE branch', 'if (!a && b) {\n  x();\n} else {\n  install();\n}'],
    ['after an early return rather than inside a gate', 'function f() {\n  if (a) return;\n  install();\n}'],
    ['behind `&&` rather than inside an `if`', '!a && b && install();'],
    ['inside a function declared in another branch', 'if (other) {\n  function go() {\n    if (!a && b) {\n      install();\n    }\n  }\n  go();\n}'],
  ])('refuses a marker %s', (_why, src) => {
    expect(() => gateOf(markersIn(src), 'install()', 'fixture')).toThrow(/must run under exactly one condition/);
  });

  it('refuses two markers under different gates', () => {
    expect(() => gateOf(markersIn('if (a) { install(); }\nif (b) { install(); }'), 'install()', 'fixture')).toThrow(/share one gate/);
  });

  it('a call on a line that starts with `import` is still a call', () => {
    expect(markersIn("import('./x').then(() => install());")).toHaveLength(1);
  });
});

describe('device console capture install order (#591)', () => {
  const mainSf = parsed(MAIN);
  const specs = importSpecifiers(MAIN);

  it('imports ./installDeviceConsoleCapture BEFORE ./App.tsx', () => {
    const capture = found(specs.findIndex((s) => s.includes('installDeviceConsoleCapture')), "main.tsx's import of ./installDeviceConsoleCapture");
    const app = found(specs.findIndex((s) => s.includes('App.tsx')), "main.tsx's import of ./App.tsx");
    expect(
      capture,
      `./installDeviceConsoleCapture must be imported BEFORE ./App.tsx (it is at ${capture}, App.tsx at ${app}). ` +
        `Imports evaluate in source order, so anything above App.tsx is the only code that runs ` +
        `before React's mount effects — which is where the #591 ` +
        `boot-time console race lived.`,
    ).toBeLessThan(app);
  });

  // ⚠️ Every CALL, wherever it sits (#1179). The line filter this replaces dropped every line starting
  // `import`, so `import('./x').then(() => installDeviceConsoleCapture())` was invisible to it.
  it("does NOT install by calling installDeviceConsoleCapture( from main.tsx's body", () => {
    expect(
      callsTo(mainSf, 'installDeviceConsoleCapture').length > 0,
      'main.tsx must not CALL installDeviceConsoleCapture() directly — a statement runs after every ' +
        'import, which is too late. The side-effect import ./installDeviceConsoleCapture is the install.',
    ).toBe(false);
  });

  // The shared ring (#596/#597 Stage 2) must be imported even EARLIER than the device capture — it
  // is what actually captures boot now, since the device ring no longer patches console.* itself.
  it('imports ./installConsoleRing BEFORE ./App.tsx (and no later than ./installDeviceConsoleCapture)', () => {
    const ring = found(specs.findIndex((s) => s.includes('installConsoleRing')), "main.tsx's import of ./installConsoleRing");
    const capture = specs.findIndex((s) => s.includes('installDeviceConsoleCapture'));
    const app = specs.findIndex((s) => s.includes('App.tsx'));
    expect(
      ring,
      `./installConsoleRing must be imported BEFORE ./App.tsx (it is at ${ring}, App.tsx at ${app}) — ` +
        'imports evaluate in source order, so anything above App.tsx is the only code that runs ' +
        "before React's mount effects.",
    ).toBeLessThan(app);
    expect(
      ring,
      `./installConsoleRing must be imported no later than ./installDeviceConsoleCapture (ring at ${ring}, ` +
        `device capture at ${capture}) — the shared ring must already be wrapping console.* before the ` +
        'device seam registers its window-error listeners and setConsoleSource projection.',
    ).toBeLessThanOrEqual(capture);
  });

  it("does NOT install by calling installConsoleRing( from main.tsx's body", () => {
    expect(
      callsTo(mainSf, 'installConsoleRing').length > 0,
      'main.tsx must not CALL installConsoleRing() directly — a statement runs after every import, ' +
        'which is too late. The side-effect import ./installConsoleRing is the install.',
    ).toBe(false);
  });

  it("installDeviceConsoleCapture.ts's gate is byte-identical (modulo whitespace) to main.tsx's bridge-import gate", () => {
    const mainGate = gateOf(dynamicImports(mainSf, './debug/bridge'), "import('./debug/bridge')", 'app/main.tsx (bridge-import gate)');
    const installGate = gateOf(callsTo(parsed(INSTALL_DEVICE_CONSOLE_CAPTURE), 'installDeviceConsoleCapture'),
      'installDeviceConsoleCapture() call', 'app/installDeviceConsoleCapture.ts');
    expect(
      installGate,
      'installDeviceConsoleCapture.ts\'s gate must fold IDENTICALLY to the one guarding ' +
        "import('./debug/bridge') in main.tsx, or a release build's dead-code elimination strips " +
        'one but not the other — shipping either a stray console patch or a stray eval-capable ' +
        `bridge chunk. main.tsx gate: "${mainGate}" — installDeviceConsoleCapture.ts gate: "${installGate}"`,
    ).toBe(mainGate);
  });

  it('installDeviceConsoleCapture.ts pulls in NOTHING beyond the gate and the installer', () => {
    // The precedent's most load-bearing assertion (errorCaptureInstallOrder.test.ts's "actually calls the installer" test), and it
    // matters MORE here: this module is in main.tsx's STATIC graph, so anything it imports is both
    // evaluated uncovered AND a new candidate to survive DCE into a release bundle. `verify` would
    // stay green either way, and the only gate that could notice (`smoke:debug-flag`) is manual and
    // greps for `[console-capture]`, not for whatever else came along for the ride.
    expect(importSpecifiers(INSTALL_DEVICE_CONSOLE_CAPTURE))
      .toEqual(['@capacitor/core', './debug/deviceConsoleCapture']);
  });

  // The shared ring's gate is a DELIBERATE SUPERSET of the device capture's — NOT the same
  // expression, and not forced to match it. Reconciling the two would reintroduce the exact
  // inert-mechanism bug #596/#597 exists to fix: a debug WEB build (DEBUG_BUILD on, no native
  // platform) needs the shared ring wrapping console.* even though the device ring never installs
  // there. So this asserts the WIDER text on its own terms, and separately asserts it differs from
  // the narrower device/bridge gate — a future edit that "simplifies" them back into one expression
  // is exactly the regression this second assertion is meant to catch.
  it("installConsoleRing.ts's gate is the wider union — deliberately NOT equal to the device gate", () => {
    const ringGate = gateOf(callsTo(parsed(INSTALL_CONSOLE_RING), 'installConsoleRing'), 'installConsoleRing() call', 'app/installConsoleRing.ts');
    const deviceGate = gateOf(dynamicImports(mainSf, './debug/bridge'), "import('./debug/bridge')", 'app/main.tsx (bridge-import gate)');
    expect(
      ringGate,
      `app/installConsoleRing.ts's gate must be the documented wider union. Got: "${ringGate}"`,
    ).toBe('!__MODOKI_PLAYABLE__ && (import.meta.env.DEV || import.meta.env.VITE_DEBUG_BRIDGE || __MODOKI_EDITOR__ || __MODOKI_DEBUG_BUILD__)');
    expect(
      ringGate,
      'installConsoleRing.ts\'s gate must NOT equal the device/bridge gate — it is deliberately WIDER ' +
        '(adds __MODOKI_EDITOR__ and drops the Capacitor.isNativePlatform() qualifier on ' +
        '__MODOKI_DEBUG_BUILD__) so the shared ring still installs on a debug WEB build, where the ' +
        'device ring does not. If a future edit makes these equal, it has silently narrowed the shared ' +
        "ring's gate back down to the device ring's — the exact inert-mechanism bug this stage fixes.",
    ).not.toBe(deviceGate);
  });

  it('installConsoleRing.ts pulls in NOTHING beyond the gate and its two installers', () => {
    // #596/#597 Stage 3a added the second import: `./debug/uncaughtCapture`'s window-error
    // listeners now register from THIS gate too (not `installDeviceConsoleCapture.ts`'s narrower
    // one — see the module doc comment), so this list legitimately grew by one.
    expect(importSpecifiers(INSTALL_CONSOLE_RING))
      .toEqual(['@modoki/engine/runtime/core/consoleRing', './debug/uncaughtCapture']);
  });

  it('bridge.ts no longer declares its own capture — there can only ever be ONE BRIDGE ring', () => {
    const bridgeSrc = fs.readFileSync(BRIDGE, 'utf8');
    const stripped = stripComments(bridgeSrc);
    assertScanIsSane(bridgeSrc, stripped, 'app/debug/bridge.ts');
    // consoleSource.ts's own "one capture, one copy" rationale (#157): a second capture on device
    // would double-wrap console.* and carry a second copy of every line, on exactly the low-end
    // hardware whose budget is tightest. bridge.ts must READ the shared ring, not build its own.
    // ⚠️ "ONE ring" is scoped to the BRIDGE deliberately — it is still not a claim about the
    // process, though it is much closer to one since #596/#597. This comment used to say
    // `runtime/debug/consoleCapture.ts` installs a THIRD capture by side effect from
    // `runtime/debug/index.ts` — effectively pre-registering #597, which it turned out to be. That
    // is fixed: `runtime/core/consoleRing.ts` is now the only thing in the app + runtime that wraps
    // `console.*`. `packages/modoki/src/editor/consoleCapture.ts` (the editor Console panel) was the
    // one remaining separate wrapper for a while, kept apart because its entries carried lazily-built
    // stacks and it listened in the CAPTURE phase for resource-load errors — semantics the shared
    // ring didn't model. #626 folded it in too: the lazy stack is now `ConsoleRingOptions
    // .retainCallSite` (opt-in, editor-only), and the capture-phase resource-load listener moved to
    // `engine/app/debug/uncaughtCapture.ts`. agentBridge, deviceConsoleCapture, runtime/debug AND the
    // editor Console panel are now all projections of the one ring.
    expect(
      /\bcreateConsoleRing\s*\(/.test(stripped),
      'bridge.ts must not call createConsoleRing( itself — the ring now lives in ' +
        'deviceConsoleCapture.ts and bridge.ts should only import { consoleRing, ' +
        'installDeviceConsoleCapture } from it.',
    ).toBe(false);
    expect(importSpecifiers(BRIDGE).some((s) => s.includes('./deviceConsoleCapture'))).toBe(true);
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
    expect(importSpecifiers(BRIDGE).some((s) => s.includes('./deviceConsoleCapture'))).toBe(true);
  });
});
