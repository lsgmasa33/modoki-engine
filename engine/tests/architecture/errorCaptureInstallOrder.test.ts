import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';

/**
 * The global error capture (#275) must be installed by a SIDE-EFFECT IMPORT placed above
 * `./App.tsx`, not by a call in `main.tsx`'s body.
 *
 * ⚠️ THE DISTINCTION IS THE WHOLE BUG, and it is invisible at a glance. ES module imports are
 * hoisted and evaluated in source order BEFORE any statement of the importing module runs, so
 * `installGlobalErrorHandlers()` written as main.tsx's first statement still executes after
 * `./App.tsx` and its entire transitive graph — the runtime barrel, PixiJS, three, every game
 * trait registration. A top-level throw anywhere in there was uncovered, and that failure reaches
 * a player as a blank screen on launch with nothing reported: exactly the invisible launch-day
 * crash the phase exists to end. It shipped that way for one commit.
 *
 * ⚠️ This guard PARSES the import list rather than grepping the file, because the file explains
 * itself in a comment naming both `installErrorCapture` and `App.tsx` — a text match would be
 * satisfied by the explanation of the rule instead of the rule.
 *
 * ⚠️ SOURCE ORDER IS NECESSARY, NOT SUFFICIENT, and this guard can only see the necessary half —
 * its sibling `deviceConsoleCaptureInstallOrder.test.ts` says so out loud; this file did not (#636).
 * Measured on a real bundle (`games/wordweave/dist/assets/index-mD_oY731.js`, 487,006 bytes): the
 * four installs (this one among them) sit in ONE comma-expression at byte ~368,600, while the
 * entry's last static import finishes at byte ~5,497 — a throw during module evaluation anywhere in
 * `App.tsx`'s static import graph fires ~363 kB before `installGlobalErrorHandlers` exists to catch
 * it, and is never reported to Crashlytics. Do not read a green here as "every boot-time error is
 * captured" — `engine/index.html`'s fatal-load guard buffers an error from that same window
 * (`__MODOKI_EARLY_ERRORS__`), but the drain (`globalErrors.ts`'s `drainEarlyErrors`) only runs once
 * `installGlobalErrorHandlers` itself is reached, so it covers an early fault on a boot that
 * COMPLETES — a boot that never does is #825, still open.
 */

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app');
const MAIN = path.join(appDir, 'main.tsx');

/** Import specifiers in source order, comments stripped via the shared scanner
 *  (@modoki/engine/testing, #419). */
function importSpecifiers(src: string, label: string): string[] {
  const code = stripComments(src);
  assertScanIsSane(src, code, label);
  return [...code.matchAll(/^\s*import\s+(?:[^'"]*?from\s*)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

describe('global error capture install order (#275)', () => {
  const src = fs.readFileSync(MAIN, 'utf8');
  const specs = importSpecifiers(src, 'app/main.tsx');

  it('imports ./installErrorCapture before ./App.tsx', () => {
    const capture = specs.findIndex((s) => s.includes('installErrorCapture'));
    const app = specs.findIndex((s) => s.includes('App.tsx'));
    expect(capture, 'main.tsx must import ./installErrorCapture').toBeGreaterThanOrEqual(0);
    expect(app, 'main.tsx must import ./App.tsx').toBeGreaterThanOrEqual(0);
    expect(
      capture,
      `./installErrorCapture must be imported BEFORE ./App.tsx (it is at ${capture}, App.tsx at ${app}). ` +
        `Imports evaluate in source order, so anything above App.tsx is the only code that runs ` +
        `before App.tsx's module graph — which is where a launch-killing top-level throw lives.`,
    ).toBeLessThan(app);
  });

  it('does NOT install by calling the function from main.tsx\'s body', () => {
    const stripped = stripComments(src);
    assertScanIsSane(src, stripped, 'app/main.tsx');
    const body = stripped
      .split('\n')
      .filter((l) => !/^\s*import\s/.test(l))
      .join('\n');
    expect(
      /installGlobalErrorHandlers\s*\(/.test(body),
      'main.tsx must not CALL installGlobalErrorHandlers() — a statement runs after every import, ' +
        'which is too late. The side-effect import ./installErrorCapture is the install.',
    ).toBe(false);
  });

  it('installErrorCapture actually calls the installer, and pulls in nothing else', () => {
    const capture = fs.readFileSync(path.join(appDir, 'installErrorCapture.ts'), 'utf8');
    expect(/^\s*installGlobalErrorHandlers\s*\(\s*\)\s*;?\s*$/m.test(capture)).toBe(true);
    // Anything this module imports is itself evaluated uncovered, so the list stays at one.
    expect(importSpecifiers(capture, 'app/installErrorCapture.ts')).toEqual(['@modoki/engine/runtime']);
  });

  // The MISSING pin (found while implementing #633): main.tsx:12-15 documents `installErrorCapture`
  // as deliberately the INNER wrap — `installGlobalErrorHandlers`' contract is "call it early,
  // BEFORE anything else touches console.warn", so the ring (installConsoleRing, imported right
  // below it) must wrap OUTSIDE it, not the other way round. #591 briefly had these two the other
  // way round, inverting that nesting, and nothing before this test would have caught a repeat.
  it('imports ./installErrorCapture BEFORE ./installConsoleRing (#591, #633)', () => {
    const errorCapture = specs.findIndex((s) => s.includes('installErrorCapture'));
    const consoleRing = specs.findIndex((s) => s.includes('installConsoleRing'));
    expect(errorCapture, 'main.tsx must import ./installErrorCapture').toBeGreaterThanOrEqual(0);
    expect(consoleRing, 'main.tsx must import ./installConsoleRing').toBeGreaterThanOrEqual(0);
    expect(
      errorCapture,
      `./installErrorCapture must be imported BEFORE ./installConsoleRing (it is at ${errorCapture}, ` +
        `installConsoleRing at ${consoleRing}) — installGlobalErrorHandlers must take the INNER ` +
        'wrap so it sees console.warn before the shared ring does; #591 regressed exactly this ' +
        'ordering once.',
    ).toBeLessThan(consoleRing);
  });
});
