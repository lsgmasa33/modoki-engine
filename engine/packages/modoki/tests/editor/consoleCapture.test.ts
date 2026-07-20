// @vitest-environment jsdom
/** consoleCapture tests — console patching (still calls original), the
 *  ring-buffer trim, the window `error` (ErrorEvent + resource-load Event) and
 *  `unhandledrejection` handlers, and idempotent install.
 *
 *  Needs jsdom for window/document/ErrorEvent (the package's default test env is
 *  node, where the window handlers aren't installed). consoleCapture patches the
 *  GLOBAL console at import and re-patches on every fresh import, so we restore a
 *  pristine console around each test to avoid recursive double-patching. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Pristine console methods, captured before consoleCapture ever patches them.
const pristine = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
function restoreConsole() {
  console.log = pristine.log;
  console.warn = pristine.warn;
  console.error = pristine.error;
}

beforeEach(() => {
  restoreConsole();
  vi.resetModules(); // fresh module instance (empty buffer, captureInstalled=false)
});
afterEach(() => {
  restoreConsole();
  vi.restoreAllMocks();
});

/** Import a fresh consoleCapture (auto-installs on import). */
async function load() {
  return import('../../src/editor/consoleCapture');
}

describe('consoleCapture', () => {
  it('patches console.error to a level:error entry while still calling the original', async () => {
    // Spy BEFORE import so the module captures the spy as its "original".
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cc = await load();

    console.error('boom', { code: 42 });

    expect(errorSpy).toHaveBeenCalledWith('boom', { code: 42 }); // original still invoked
    const last = cc.logBuffer.at(-1)!;
    expect(last.level).toBe('error');
    expect(last.message).toContain('boom');
    expect(last.message).toContain('"code": 42'); // object arg JSON-stringified
  });

  it('records the right level for log / warn / error', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cc = await load();

    console.log('a');
    console.warn('b');
    console.error('c');

    const tail = cc.logBuffer.slice(-3);
    expect(tail.map((e) => e.level)).toEqual(['log', 'warn', 'error']);
    expect(tail.map((e) => e.message)).toEqual(['a', 'b', 'c']);
  });

  it('skips stack capture for log level, lazily formats it for warn/error (F2 part b)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cc = await load();

    console.log('plain');
    console.warn('careful');
    console.error('boom');

    const [logE, warnE, errE] = cc.logBuffer.slice(-3);
    // log level: no stack ever captured.
    expect(logE.stack).toBe('');
    // warn/error: the lazy getter formats a real (non-empty) V8 stack on read, and
    // it drops the internal frames so the first line is NOT the "Error" header.
    expect(warnE.stack.length).toBeGreaterThan(0);
    expect(warnE.stack.split('\n')[0]).not.toMatch(/^Error/);
    expect(errE.stack.length).toBeGreaterThan(0);
    // memoized: a second read returns the identical string instance.
    expect(errE.stack).toBe(errE.stack);
  });

  it('trims the buffer to MAX_LOGS, dropping the oldest entries', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const cc = await load();

    const overflow = 50;
    for (let i = 0; i < cc.MAX_LOGS + overflow; i++) console.log(`m${i}`);

    expect(cc.logBuffer.length).toBe(cc.MAX_LOGS);
    expect(cc.logBuffer[0].message).toBe(`m${overflow}`);            // oldest survivors
    expect(cc.logBuffer.at(-1)!.message).toBe(`m${cc.MAX_LOGS + overflow - 1}`);
  });

  it('captures uncaught ErrorEvents (window error)', async () => {
    const cc = await load();

    window.dispatchEvent(new ErrorEvent('error', { message: 'kaboom', error: new Error('kaboom') }));

    const last = cc.logBuffer.at(-1)!;
    expect(last.level).toBe('error');
    expect(last.message).toContain('Uncaught');
    expect(last.message).toContain('kaboom');
  });

  it('captures resource-load errors (non-ErrorEvent) with tag + url', async () => {
    const cc = await load();

    const img = document.createElement('img');
    document.body.appendChild(img);
    img.src = 'http://localhost/missing.png';
    // Resource errors arrive as a plain Event on the element; the window listener
    // is registered in the capture phase precisely so it still sees them.
    img.dispatchEvent(new Event('error'));
    document.body.removeChild(img);

    const last = cc.logBuffer.at(-1)!;
    expect(last.level).toBe('error');
    expect(last.message).toContain('Resource load error');
    expect(last.message).toContain('<img>');
    expect(last.message).toContain('missing.png');
  });

  it('captures unhandled promise rejections with a non-Error reason', async () => {
    const cc = await load();

    const ev: Event & { reason?: unknown } = new Event('unhandledrejection');
    ev.reason = 'plain string reason';
    window.dispatchEvent(ev);

    const last = cc.logBuffer.at(-1)!;
    expect(last.level).toBe('error');
    expect(last.message).toContain('Unhandled rejection');
    expect(last.message).toContain('plain string reason');
  });

  it('coalesces a burst of logs into ONE onNewLog notification per frame (F2/F4)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const cc = await load();
      const onNewLog = vi.fn();
      cc.setOnNewLog(onNewLog);

      // A burst in one tick: 5 logs → notification is scheduled, not fired yet.
      for (let i = 0; i < 5; i++) console.log(`burst${i}`);
      expect(onNewLog).not.toHaveBeenCalled(); // deferred to the next frame
      expect(cc.logBuffer.length).toBe(5);     // buffer is updated synchronously

      vi.runAllTimers(); // flush the rAF
      expect(onNewLog).toHaveBeenCalledTimes(1); // collapsed 5 → 1 render

      // A second burst after the flush schedules a fresh notification.
      console.log('again');
      vi.runAllTimers();
      expect(onNewLog).toHaveBeenCalledTimes(2);

      cc.setOnNewLog(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire a pending notification after the listener is detached', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const cc = await load();
      const onNewLog = vi.fn();
      cc.setOnNewLog(onNewLog);

      console.log('x');        // schedules a flush
      cc.setOnNewLog(null);    // panel unmounts before the frame runs
      vi.runAllTimers();
      expect(onNewLog).not.toHaveBeenCalled(); // re-checked null at flush time
    } finally {
      vi.useRealTimers();
    }
  });

  it('installConsoleCapture is idempotent (no double-wrapping)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const cc = await load();
    const patched = console.log;

    cc.installConsoleCapture(); // second call — the guard should no-op

    expect(console.log).toBe(patched); // not re-wrapped
  });
});
