/** #1034 — a packaged startup failure HUNG instead of exiting.
 *
 *  `dialog.showErrorBox` is synchronous: it runs a nested native modal loop, so the `app.exit(1)`
 *  written after it never ran when nobody was there to click OK. The fix is an ORDERING one — the
 *  termination is armed before the dialog is shown — and test 1 below is that statement made
 *  falsifiable: a dialog whose promise NEVER settles must still terminate the process.
 *
 *  This module exists as a module precisely so these can be real unit tests. `quitExitCode.test.ts`
 *  records why the sibling guard there is a source grep instead: main.ts is the Electron entry
 *  point and has no harness. Extracting the decision is what buys the coverage. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reportFatalStartup, FATAL_DIALOG_TIMEOUT_MS } from '../../electron/fatalDialog';

const OPTS = { title: 'Modoki Editor — startup failed', message: 'the backend never bound' };
/** A stand-in for a live BrowserWindow. Its only job is to be non-null: with a parent the dialog
 *  is a SHEET and the event loop keeps running, which is what makes the timer reachable. */
const WIN = () => ({ id: 1 });

describe('reportFatalStartup (#1034)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('TERMINATES even when the dialog never resolves — the bug, stated as a test', async () => {
    const terminate = vi.fn();
    // A modal loop that never returns is exactly a promise that never settles.
    reportFatalStartup(OPTS, { parentWindow: WIN, showMessageBox: () => new Promise<never>(() => {}), terminate });

    expect(terminate, 'must not terminate before the timeout — a present human gets to read it').not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FATAL_DIALOG_TIMEOUT_MS);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates IMMEDIATELY when the user clicks through, without waiting out the timer', async () => {
    const terminate = vi.fn();
    reportFatalStartup(OPTS, { parentWindow: WIN, showMessageBox: () => Promise.resolve({ response: 0 }), terminate });

    await vi.advanceTimersByTimeAsync(0); // just let the promise callback run
    expect(terminate).toHaveBeenCalledTimes(1);
    // …and the armed timer must not fire a SECOND termination behind it.
    await vi.advanceTimersByTimeAsync(FATAL_DIALOG_TIMEOUT_MS * 2);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  /** ⚠️ The exactly-once guard is INVISIBLE in the click-through case — `clearTimeout` cancels the
   *  armed timer there, so removing `if (done) return` changes nothing and that test stays green.
   *  The order that exposes it is the other one: the TIMEOUT fires first, and the human's click
   *  lands afterwards on a dialog that is still on screen. Without the guard that is a second
   *  `app.quit()` during teardown. */
  it('does not terminate TWICE when a late click follows the timeout', async () => {
    const terminate = vi.fn();
    let settle: (v: unknown) => void = () => {};
    reportFatalStartup(OPTS, {
      parentWindow: WIN,
      showMessageBox: () => new Promise((res) => { settle = res; }),
      terminate,
    });
    await vi.advanceTimersByTimeAsync(FATAL_DIALOG_TIMEOUT_MS);
    expect(terminate).toHaveBeenCalledTimes(1);
    settle({ response: 0 });            // the human clicks OK after the timer already fired
    await vi.advanceTimersByTimeAsync(0);
    expect(terminate, 'the armed timer and a late click must not both terminate').toHaveBeenCalledTimes(1);
  });

  it('terminates when the dialog REJECTS', async () => {
    const terminate = vi.fn();
    reportFatalStartup(OPTS, { parentWindow: WIN, showMessageBox: () => Promise.reject(new Error('no window yet')), terminate });
    await vi.advanceTimersByTimeAsync(0);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates when the dialog THROWS synchronously (pre-ready), without waiting out the timer', async () => {
    const terminate = vi.fn();
    reportFatalStartup(OPTS, {
      parentWindow: WIN,
      showMessageBox: () => { throw new Error('dialog before app.ready'); },
      terminate,
    });
    expect(terminate).toHaveBeenCalledTimes(1); // synchronous path — no tick needed
  });

  it('a terminate that itself throws does not escape, but IS logged (never silent)', async () => {
    // A swallowed throw on the one line that ends the process would present as the very hang this
    // module prevents, with nothing in the log to say why.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const terminate = vi.fn(() => { throw new Error('app.exit unavailable'); });
    expect(() => reportFatalStartup(OPTS, { parentWindow: WIN, showMessageBox: () => Promise.resolve({}), terminate })).not.toThrow();
    await vi.advanceTimersByTimeAsync(FATAL_DIALOG_TIMEOUT_MS); // must not reject either
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(err, 'a terminate() throw must reach the log').toHaveBeenCalledWith(
      expect.stringContaining('terminate() threw'), expect.anything(),
    );
    err.mockRestore();
  });

  it('runs the INJECTED terminate — the dev-server site keeps its quit path, not app.exit (#68)', async () => {
    // Site 2 must go through closeSplash + quitExitCode = 1 + app.quit(), not app.exit(1):
    // collapsing all three onto one exit would fix #1034 and reintroduce #68.
    const order: string[] = [];
    reportFatalStartup(OPTS, {
      parentWindow: WIN,
      showMessageBox: () => new Promise<never>(() => {}),
      terminate: () => { order.push('closeSplash', 'quitExitCode=1', 'app.quit'); },
    });
    await vi.advanceTimersByTimeAsync(FATAL_DIALOG_TIMEOUT_MS);
    expect(order).toEqual(['closeSplash', 'quitExitCode=1', 'app.quit']);
  });

  it('shows an ERROR dialog carrying the caller title and message', () => {
    const showMessageBox = vi.fn(() => new Promise<never>(() => {}));
    reportFatalStartup({ ...OPTS, detail: 'Log: /tmp/main.log' }, { parentWindow: WIN, showMessageBox, terminate: vi.fn() });
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.anything(), // the PARENT window — passing it is what makes this a sheet, not an app-modal
      expect.objectContaining({ type: 'error', title: OPTS.title, message: OPTS.message, detail: 'Log: /tmp/main.log' }),
    );
  });

  /** ⚠️ The half the FIRST version of this fix got wrong, and only a live run caught. Arming the
   *  timer is not sufficient: `dialog.showMessageBox` with NO parent window is APP-MODAL on macOS —
   *  it runs a nested `[NSAlert runModal]` loop on the main thread despite returning a Promise, so
   *  the single-threaded event loop cannot run the timer that was meant to rescue it. Measured: a
   *  packaged editor sat for 4m51s against a 10s timer, with `finish()` never called by either
   *  racer. So with no window we must show NOTHING and terminate. */
  describe('with NO parent window — a modal there would block the loop that the timer runs on', () => {
    it('shows no dialog at all', () => {
      const showMessageBox = vi.fn(() => new Promise<never>(() => {}));
      reportFatalStartup(OPTS, { parentWindow: () => null, showMessageBox, terminate: vi.fn() });
      expect(showMessageBox).not.toHaveBeenCalled();
    });

    it('terminates IMMEDIATELY — not after the timeout, which could never arrive', () => {
      const terminate = vi.fn();
      reportFatalStartup(OPTS, { parentWindow: () => null, showMessageBox: vi.fn(), terminate });
      expect(terminate, 'no timers advanced — this must be synchronous').toHaveBeenCalledTimes(1);
    });

    it('treats a THROWING window probe as no-window rather than propagating', () => {
      const terminate = vi.fn();
      const showMessageBox = vi.fn();
      expect(() => reportFatalStartup(OPTS, {
        parentWindow: () => { throw new Error('app not ready'); },
        showMessageBox,
        terminate,
      })).not.toThrow();
      expect(showMessageBox).not.toHaveBeenCalled();
      expect(terminate).toHaveBeenCalledTimes(1);
    });

    it('does not terminate a second time when the armed timer later fires', async () => {
      const terminate = vi.fn();
      reportFatalStartup(OPTS, { parentWindow: () => null, showMessageBox: vi.fn(), terminate });
      await vi.advanceTimersByTimeAsync(FATAL_DIALOG_TIMEOUT_MS * 2);
      expect(terminate).toHaveBeenCalledTimes(1);
    });
  });

  it('honours an explicit timeoutMs', async () => {
    const terminate = vi.fn();
    reportFatalStartup({ ...OPTS, timeoutMs: 50 }, { parentWindow: WIN, showMessageBox: () => new Promise<never>(() => {}), terminate });
    await vi.advanceTimersByTimeAsync(50);
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});

/** The whack-a-mole half (#1034). The three sites were three copies of one shape, and the fix is
 *  one helper — which only stays true if a fourth copy cannot be added. Same source-guard shape as
 *  `quitExitCode.test.ts`, `reapScoping.test.ts` and `posixPathGuard.test.ts`, and for the same
 *  reason: the entry point has no harness, so the pattern is checked in the SOURCE.
 *
 *  ⚠️ Bans the whole `*Sync` dialog family, not just the `showErrorBox` that happened to bite. Every
 *  one of them runs the same nested modal loop, so a `showMessageBoxSync` added tomorrow is this bug
 *  wearing a different name. */
import { readScannedSource } from '@modoki/engine/testing';
import * as nodePath from 'node:path';
import { readdirSync } from 'node:fs';

describe('no synchronous dialog may return to engine/electron (#1034)', () => {
  const dir = nodePath.resolve(__dirname, '../../electron');
  // Derived from the directory, not a hand-listed set of files — a new module in here is covered
  // the day it lands, with nobody having to remember this test exists.
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('scans a non-trivial number of electron modules (the corpus is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('%s uses no *Sync dialog', (file) => {
    const { code } = readScannedSource(nodePath.join(dir, file));
    const hits = [...code.matchAll(/\b(showErrorBox|showMessageBoxSync|showOpenDialogSync|showSaveDialogSync)\b/g)]
      .map((m) => m[1]);
    expect(
      hits,
      `${file}: a synchronous Electron dialog runs a nested native modal loop, so anything sequenced ` +
        'after it never runs when nobody can click OK (#1034). Use reportFatalStartup, or the async ' +
        'dialog.showMessageBox — and arm whatever must happen next BEFORE showing it.',
    ).toEqual([]);
  });
});
