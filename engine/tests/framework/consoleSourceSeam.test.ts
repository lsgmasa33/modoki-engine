/** `diagnose` reads the buffer that was actually WRITTEN — the writer/reader split (#157).
 *
 *  WHY THIS FILE SPANS TWO MODULES. The defect was invisible to either side's own tests, and that
 *  is the whole lesson: `bridge.ts` captured faithfully into its ring, `agentBridge.ts` read
 *  faithfully from its buffer, both were tested, both passed, and on a shipped device build they
 *  were not the same buffer. A test that mounts one module can never see it. So this one asserts
 *  the SEAM: what a device writes is what `diagnose` reports.
 *
 *  The device condition is reproduced honestly rather than by mocking a phone: `installConsoleCapture()`
 *  is simply never called (which is what `initAgentBridge()`'s `if (!hot && !bridge) return;` does
 *  on a production build), and the ring is published through `consoleSource` exactly as
 *  `patchConsole()` does.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestWorld, type TestWorld } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { computeDiagnostics } from '../../app/debug/diagnose';
import { setConsoleSource, readConsoleSource, _resetConsoleSourceForTests } from '../../app/debug/consoleSource';

registerAllTraits();

let game: TestWorld | undefined;
beforeEach(() => { _resetConsoleSourceForTests(); });
afterEach(() => { game?.dispose(); game = undefined; _resetConsoleSourceForTests(); });

describe('console source seam — the device ring reaches diagnose (#157)', () => {
  it('is INERT when nobody registers — the editor path must not change', () => {
    expect(readConsoleSource()).toBeNull();
  });

  it('a registered ring is what a reader sees', () => {
    setConsoleSource(() => [{ level: 'error', ts: 1000, text: 'boom' }]);
    expect(readConsoleSource()).toEqual([{ level: 'error', ts: 1000, text: 'boom' }]);
  });

  /** The exact scenario measured on the Samsung: the ring holds a boot stall, and diagnose
   *  reported `ok:true / "No issues detected."` because it was reading a different, empty buffer. */
  it('a device-style boot error in the ring FAILS the verdict instead of vanishing', () => {
    game = createTestWorld({});
    const now = 2_000_000;
    setConsoleSource(() => [
      { level: 'log', ts: now - 1000, text: '[MeshCache] Loaded 114 templates' },
      { level: 'error', ts: now - 2000, text: '[frameDriver] FRAME LOOP STALLED — no frame for 3926ms' },
    ]);
    const d = computeDiagnostics({ consoleErrors: readConsoleSource()!.filter((e) => e.level === 'error'), now, errorWindowMs: 300_000 });
    expect(d.consoleErrors).toHaveLength(1);
    expect(d.consoleErrors[0].text).toMatch(/FRAME LOOP STALLED/);
    expect(d.ok).toBe(false);
    expect(d.summary).not.toMatch(/No issues detected/);
  });

  /** #152 and #157 compose: an error too old for the verdict window is still COUNTED. On device
   *  this pairing is the whole point — boot errors are old by the time anyone connects. */
  it('an aged-out device boot error is reported as olderErrors, not dropped', () => {
    game = createTestWorld({});
    const now = 2_000_000;
    setConsoleSource(() => [{ level: 'error', ts: now - 600_000, text: '[frameDriver] FRAME LOOP STALLED' }]);
    const d = computeDiagnostics({ consoleErrors: readConsoleSource()!, now, errorWindowMs: 300_000 });
    expect(d.consoleErrors).toHaveLength(0);          // outside the verdict window
    expect(d.olderErrors?.count).toBe(1);             // but not invisible
    expect(d.summary).toMatch(/1 older console error/);
  });
});

/** The seam feeds `diagnose`, the tool you reach for when everything is already broken. A fault in
 *  the reporting path must not be the thing that denies you the report. */
describe('console source robustness', () => {
  it('a THROWING source degrades to null instead of taking diagnose down with it', () => {
    setConsoleSource(() => { throw new Error('ring exploded'); });
    expect(() => readConsoleSource()).not.toThrow();
    expect(readConsoleSource()).toBeNull();
  });

  it('a throwing source still lets computeDiagnostics answer', () => {
    game = createTestWorld({});
    setConsoleSource(() => { throw new Error('ring exploded'); });
    const d = computeDiagnostics({ consoleErrors: readConsoleSource() ?? [], now: 1000, errorWindowMs: 300_000 });
    expect(d.summary).toBeTruthy();   // a degraded report, never a dead tool
  });
});
