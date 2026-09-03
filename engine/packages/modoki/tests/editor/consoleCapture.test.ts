/** consoleCapture tests — the editor Console panel's PROJECTION of the shared console ring (#626).
 *
 *  This module no longer touches `console.*`/`window` itself (that moved to the shared ring,
 *  `runtime/core/consoleRing.ts`, and to `engine/app/debug/uncaughtCapture.ts`'s capture-phase
 *  listener) — so this file no longer needs jsdom, unlike its pre-#626 self.
 *
 *  Each test gets a FRESH instance of both this module and the ring via `vi.resetModules()` plus a
 *  dynamic re-import of BOTH in the same post-reset epoch (importing either statically at the top of
 *  the file would silently bind a STALE module instance — the `/@fs` two-instances trap; see
 *  `uncaughtCapture.test.ts`'s sibling comment for the full reasoning). The real GLOBAL
 *  `console.log`/`info`/`warn`/`error`, however, are NOT reset by `vi.resetModules()` — each fresh
 *  ring instance would otherwise wrap whatever the PREVIOUS test's ring already installed, nesting
 *  one more wrapper per test. `pristineConsole` is snapshotted once, before anything wraps it, and
 *  restored in `afterEach` so every test's `installConsoleRing()` wraps the TRUE original. */

import { describe, it, expect, afterEach, vi } from 'vitest';

const pristineConsole = {
  log: console.log, info: console.info, warn: console.warn, error: console.error,
};

afterEach(() => {
  console.log = pristineConsole.log;
  console.info = pristineConsole.info;
  console.warn = pristineConsole.warn;
  console.error = pristineConsole.error;
  vi.resetModules();
});

async function load() {
  const ring = await import('../../src/runtime/core/consoleRing');
  const cc = await import('../../src/editor/consoleCapture');
  return { ring, cc };
}

describe('consoleCapture (editor projection)', () => {
  it('exposes `stack` as a GETTER, so projecting does not format every entry\'s stack', async () => {
    // The ring's own `stack` is lazy (retainCallSite) because formatting Error.stack is the
    // expensive part in V8. A plain `stack: e.stack ?? ''` in the projection would read it for
    // EVERY entry on every projection — up to 1000 stacks each time a new log lands — quietly
    // undoing the one capability #626 set out to preserve. Pin the mechanism, not just the value.
    const { ring, cc } = await load();
    ring.installConsoleRing({ retainCallSite: true });
    console.warn('lazy-please');

    const row = cc.getEditorLogs().find((e) => e.message === 'lazy-please')!;
    const d = Object.getOwnPropertyDescriptor(row, 'stack');
    expect(typeof d?.get).toBe('function');
    expect(d?.value).toBeUndefined();
    expect(row.stack).toBeTruthy(); // and it still resolves when actually read
  });

  it('returns a FRESH array but the identical cached ROW OBJECTS while nothing has changed (F9)', async () => {
    // Console.tsx calls this on every render (scroll, resize, selection). Re-mapping the whole ring
    // each time would be a regression against the pre-#626 panel, which read a stable array — but
    // handing out the INTERNAL cache array itself is the defect `getConsoleRingEntries()` carries
    // its own explicit ⚠️ against: a caller's stray `.reverse()`/`.sort()`/`.push()` would corrupt
    // what every LATER call sees, since they'd all be reading this same array.
    const { ring, cc } = await load();
    ring.installConsoleRing();
    console.log('cache-me');

    const a = cc.getEditorLogs();
    const b = cc.getEditorLogs();
    expect(b).not.toBe(a); // a fresh array every call...
    expect(b).toEqual(a);
    expect(b[0]).toBe(a[0]); // ...but the SAME row object — the mapping was not redone

    console.log('now-changed');
    const c = cc.getEditorLogs();
    expect(c).not.toBe(a);
    expect(c[0]).not.toBe(a[0]); // a real re-map happened this time
  });

  it('self-heals its clear watermark when the shared ring is reset out from under it', async () => {
    // The watermark is a seq value; `__resetConsoleRingForTest()` restarts seq at 0 but cannot
    // reach into this module to reset it. Without the sync guard, every later read filters out
    // EVERY entry until seq climbs back past the stale watermark — the panel reads as "captures
    // nothing" and nothing fails anywhere. `runtime/debug/consoleCapture.ts` hit this first.
    const { ring, cc } = await load();
    ring.installConsoleRing();
    console.warn('before-clear');
    cc.clearEditorLogs();
    expect(cc.getEditorLogs()).toHaveLength(0);

    ring.__resetConsoleRingForTest();
    ring.installConsoleRing();
    console.warn('after-reset');

    const logs = cc.getEditorLogs();
    expect(logs.map((e) => e.message)).toContain('after-reset');
  });

  it('projects a plain console.log into a LogEntry with an empty stack', async () => {
    const { ring, cc } = await load();
    ring.installConsoleRing();
    console.log('hello');

    const [entry] = cc.getEditorLogs();
    expect(entry.level).toBe('log');
    expect(entry.message).toBe('hello');
    expect(entry.stack).toBe('');
    expect(typeof entry.id).toBe('number');
    expect(entry.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('folds the ring\'s "info" level down to "log" — the panel has no info row', async () => {
    const { ring, cc } = await load();
    ring.installConsoleRing();
    console.info('fyi');

    const [entry] = cc.getEditorLogs();
    expect(entry.level).toBe('log');
  });

  it('joins multiple args with a space, matching the ring\'s own convention', async () => {
    const { ring, cc } = await load();
    ring.installConsoleRing();
    console.log('a', 'b', 3);

    const [entry] = cc.getEditorLogs();
    expect(entry.message).toBe('a b 3');
  });

  it('a warn/error entry has NO stack unless the ring was installed with retainCallSite', async () => {
    const { ring, cc } = await load();
    ring.installConsoleRing(); // retainCallSite defaults off
    console.warn('careful');
    console.error('boom');

    for (const entry of cc.getEditorLogs()) expect(entry.stack).toBe('');
  });

  it('a warn/error entry has a call-site stack when retainCallSite is on — the panel\'s one genuine extra need', async () => {
    const { ring, cc } = await load();
    ring.installConsoleRing({ retainCallSite: true });
    console.warn('careful');

    const [entry] = cc.getEditorLogs();
    expect(entry.stack.length).toBeGreaterThan(0);
  });

  it('clearEditorLogs() hides everything logged before it via a watermark — NOT a truncation of the shared ring', async () => {
    const { ring, cc } = await load();
    ring.installConsoleRing();
    console.log('before');
    cc.clearEditorLogs();
    console.log('after');

    expect(cc.getEditorLogs().map((e) => e.message)).toEqual(['after']);
    // The shared ring itself still holds BOTH entries — other consumers (agentBridge, the device
    // bridge, the in-game debug menu's ConsoleTab) must not lose their own history to this panel's
    // Clear button.
    expect(ring.getConsoleRingEntries().map((e) => e.args[0])).toEqual(['before', 'after']);
  });

  it('getEditorLogsVersion() advances on a new log AND on a clear, even when the ring\'s own version alone would not move', async () => {
    const { ring, cc } = await load();
    ring.installConsoleRing();
    const v0 = cc.getEditorLogsVersion();
    console.log('one');
    const v1 = cc.getEditorLogsVersion();
    expect(v1).toBeGreaterThan(v0);

    cc.clearEditorLogs(); // nothing new recorded — the ring's OWN version does not move for this
    const v2 = cc.getEditorLogsVersion();
    expect(v2).toBeGreaterThan(v1);
  });

  it('setOnNewLog fires on a new log (async, via the ring\'s own microtask flush) and stops after setOnNewLog(null)', async () => {
    const { ring, cc } = await load();
    ring.installConsoleRing();
    const seen: string[] = [];
    cc.setOnNewLog(() => seen.push('notified'));

    console.log('probe');
    expect(seen).toEqual([]); // not synchronous — still the same task
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(['notified']);

    cc.setOnNewLog(null);
    console.log('probe2');
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(['notified']); // no further calls after detaching
  });

  // F3 (#626/#633 adversarial review): `formatError` used to live in THIS module and was
  // unit-tested here directly, but `getEditorLogs()` never called it — it projects the ring's own
  // `stringifyArg`, which is `err.stack || err.message` and (until F3) dropped `cause` entirely.
  // These two tests are repointed at the REAL path an Error takes through this panel: a
  // `console.error(err)` call, through the shared ring, to `getEditorLogs()`.
  it('an Error argument keeps its message (and stack) instead of collapsing to "{}"', async () => {
    const { ring, cc } = await load();
    ring.installConsoleRing();
    // `JSON.stringify(new Error('x')) === '{}'` — an Error has no enumerable own properties. That
    // is how "[Editor] scene load failed: {}" reached the log bridge with the actual cause erased.
    expect(JSON.stringify(new Error('the real cause'))).toBe('{}');
    console.error(new Error('the real cause'));

    const [entry] = cc.getEditorLogs();
    expect(entry.message).toContain('Error: the real cause');
    expect(entry.message.split('\n').length).toBeGreaterThan(1); // a stack, not a one-liner
  });

  it('an Error\'s cause chain reaches the panel, not just its own stack', async () => {
    const { ring, cc } = await load();
    ring.installConsoleRing();
    const err = new Error('outer', { cause: new RangeError('inner') });
    console.error(err);

    const [entry] = cc.getEditorLogs();
    expect(entry.message).toContain('Error: outer');
    expect(entry.message).toContain('caused by: RangeError: inner');
  });
});
