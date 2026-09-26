/** The console ring must not keep what its call site referenced alive (#1589).
 *
 *  The editor's `retainCallSite` used to keep a live `new Error()` per warn/error entry behind a
 *  lazy `stack` getter. An Error whose `.stack` was never read holds V8's captured frames, and each
 *  frame holds its function's closure scope — so a `console.warn` from inside a system pinned that
 *  system's whole ECS world for as long as the entry lived. Measured live: every Play world of a
 *  session survived a forced GC. The ring now formats the stack at record time and drops the Error.
 *
 *  "Something got collected" IS observable here, which the old code's F10 comment said it was not:
 *  a `WeakRef` to a sentinel only the logging closure references, plus a real forced GC. A WeakRef
 *  target is held until the current job ends, so each GC runs after a macrotask turn. */

import { describe, it, expect, afterEach } from 'vitest';
import v8 from 'node:v8';
import vm from 'node:vm';
import {
  installConsoleRing, recordConsoleRingEntry, getConsoleRingEntries, __resetConsoleRingForTest,
} from '../../packages/modoki/src/runtime/core/consoleRing';
import { getEditorLogs } from '../../packages/modoki/src/editor/consoleCapture';

v8.setFlagsFromString('--expose_gc');
const forceGc = vm.runInNewContext('gc') as () => void;

async function collectedAfterGc(ref: WeakRef<object>): Promise<boolean> {
  for (let i = 0; i < 5 && ref.deref() !== undefined; i++) {
    await new Promise((r) => setTimeout(r, 0));
    forceGc();
  }
  return ref.deref() === undefined;
}

/** Logs a warning from a closure whose scope holds a large sentinel — the shape of a system
 *  logging from inside `world.query(...).updateEach(...)`, whose scope holds `world`. Returns only
 *  a WeakRef, so nothing but the ring's entry can keep the sentinel alive. */
function warnFromAClosureHolding(): WeakRef<object> {
  const sentinel = { payload: new Array(100_000).fill(1) };
  const system = () => {
    if (sentinel.payload.length < 0) return; // context-allocates `sentinel` in this closure's scope
    recordConsoleRingEntry('warn', ['a system warned']);
  };
  system();
  return new WeakRef(sentinel);
}

afterEach(() => { __resetConsoleRingForTest(); });

describe('retainCallSite keeps a stack, never the scopes on its call path (#1589)', () => {
  it('a warn entry kept in the ring does not keep its caller\'s closure scope alive', async () => {
    installConsoleRing({ capacity: 100, bootPrefix: 10, retainCallSite: true });
    const ref = warnFromAClosureHolding();

    expect(getConsoleRingEntries(), 'the entry itself must still be in the ring (pinned prefix)').toHaveLength(1);
    expect(await collectedAfterGc(ref), 'the ring entry pins the sentinel its call site closed over').toBe(true);
  });

  // A BACKSTOP, not independent coverage: the row copies the formatted string, and the ring keeps
  // no Error, so this goes red only when BOTH regress (the projection back to a getter over the
  // entry AND the ring back to a lazy Error) — measured. Either fix alone keeps it green, which is
  // why test 1 (the ring) and the package test pinning the row's plain `stack` carry the coverage.
  it('the editor Console panel\'s cached projection does not keep it alive after the ring drops the entry', async () => {
    installConsoleRing({ capacity: 100, bootPrefix: 10, retainCallSite: true });
    const ref = warnFromAClosureHolding();
    expect(getEditorLogs(), 'the projection caches the row').toHaveLength(1);

    // The ring forgets the entry; the panel's module-level cache does not, until its next render.
    __resetConsoleRingForTest();
    expect(await collectedAfterGc(ref), 'the Console panel cache pins the sentinel (projection getter over the entry + a lazy ring Error)').toBe(true);
  });

  it('the stored stack still names the real caller, not the ring\'s own frames', () => {
    installConsoleRing({ capacity: 100, bootPrefix: 10, retainCallSite: true });
    (function realCallSiteForRetentionTest() { recordConsoleRingEntry('error', ['boom']); })();

    const [entry] = getConsoleRingEntries();
    expect(typeof entry!.stack).toBe('string');
    expect(entry!.stack!.split('\n')[0]).toContain('realCallSiteForRetentionTest');
  });
});
