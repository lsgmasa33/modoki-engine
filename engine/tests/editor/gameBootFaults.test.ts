/** Regression: a fault in the OPEN PROJECT's game code must NOT take the editor down.
 *
 *  The wedged-editor bug: `editor/setup.ts` awaited `g.registerSystems()` unguarded, so a
 *  throw inside a game module rejected `createGameEditor()`. The editor route is a bare
 *  `React.lazy` + `Suspense`, so the whole UI never mounted — a blank window with no frame
 *  driver (fps 0) and, because `registerEditorAgentOps()` sat further down the same function,
 *  an agent bridge that answered `unknown agent op 'editor-state'`. Entirely silent.
 *
 *  These tests pin the contract that replaced it: every game boot hook is independently
 *  guarded, failures are RECORDED rather than thrown, and one broken game never prevents its
 *  siblings (or the editor) from registering. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  addGameBootFault, getGameBootFaults, describeGameBootFaults,
} from '../../app/editor/gameBootFaults';

/** Mirrors `runGameHook` in editor/setup.ts: a throwing hook becomes a recorded fault. */
async function runGameHook(gameId: string, phase: string, hook?: () => unknown): Promise<void> {
  if (!hook) return;
  try {
    await hook();
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    addGameBootFault({ gameId, phase, message });
  }
}

describe('game boot faults', () => {
  beforeEach(() => {
    // The registry is module-level and append-only by design (a boot happens once per page);
    // drain it between cases so assertions are about THIS case.
    (getGameBootFaults() as { length: number }).length = 0;
  });

  it('records a throwing hook instead of propagating it', async () => {
    await expect(
      runGameHook('court', 'registerSystems', () => { throw new Error('boom'); }),
    ).resolves.toBeUndefined();

    expect(getGameBootFaults()).toEqual([
      { gameId: 'court', phase: 'registerSystems', message: 'Error: boom' },
    ]);
  });

  it('records an async rejection the same way', async () => {
    await runGameHook('court', 'loadConfig', async () => { throw new TypeError('bad config'); });
    expect(getGameBootFaults()[0]).toMatchObject({
      phase: 'loadConfig', message: 'TypeError: bad config',
    });
  });

  it('lets later hooks and later games still register after one fails', async () => {
    const ran: string[] = [];
    await runGameHook('a', 'registerSystems', () => { throw new Error('a is broken'); });
    await runGameHook('a', 'registerEditorBindings', () => { ran.push('a.bindings'); });
    await runGameHook('b', 'registerSystems', () => { ran.push('b.systems'); });

    // The whole point: a broken module degrades ITS registrations, not the boot.
    expect(ran).toEqual(['a.bindings', 'b.systems']);
    expect(getGameBootFaults()).toHaveLength(1);
  });

  it('is a no-op for an absent optional hook', async () => {
    await runGameHook('a', 'registerPostprocessors', undefined);
    expect(getGameBootFaults()).toHaveLength(0);
  });

  it('summarises nothing when the project booted clean', () => {
    expect(describeGameBootFaults()).toBeNull();
  });

  it('summarises every fault, naming game and phase, for the on-screen banner', async () => {
    await runGameHook('a', 'registerSystems', () => { throw new Error('boom'); });
    await runGameHook('b', 'loadConfig', () => { throw new Error('nope'); });

    const summary = describeGameBootFaults();
    expect(summary).toContain('a.registerSystems(): Error: boom');
    expect(summary).toContain('b.loadConfig(): Error: nope');
  });

  it('reports a non-Error throw rather than dropping it', async () => {
    await runGameHook('a', 'registerSystems', () => { throw 'a bare string'; });
    expect(getGameBootFaults()[0].message).toBe('a bare string');
  });
});

describe('console capture formats Errors', () => {
  // F3 (#626/#633 adversarial review): this used to test the editor's own `formatError`, which by
  // the time of this review had ZERO production callers — `getEditorLogs()` projects the shared
  // ring's `stringifyArg` instead, which used to drop `cause` entirely. `formatError` is deleted;
  // the fix moved to the ring itself (`runtime/core/consoleRing.ts`), so these are repointed at
  // the REAL path: `console.error(err)` through the shared ring.
  //
  // Snapshotted BEFORE any test's `installConsoleRing()` wraps it, and restored directly
  // (bypassing the ring's own `__resetConsoleRingForTest`, which lives on whatever module
  // instance `vi.resetModules()` handed each test — restoring the raw global sidesteps that
  // "which instance" question entirely).
  const pristineConsoleError = console.error;
  afterEach(() => {
    console.error = pristineConsoleError;
  });

  it('keeps the message instead of JSON.stringify-ing it to "{}"', async () => {
    // `JSON.stringify(new Error('x')) === '{}'` — an Error has no enumerable own properties.
    // That is how "[Editor] scene load failed: {}" reached the log bridge with the actual
    // cause erased, sending four debugging sessions after the wrong thing.
    vi.resetModules();
    const { installConsoleRing, getConsoleRingEntries } = await import('../../packages/modoki/src/runtime/core/consoleRing');
    installConsoleRing();
    expect(JSON.stringify(new Error('the real cause'))).toBe('{}'); // the trap, pinned
    console.error(new Error('the real cause'));

    const [entry] = getConsoleRingEntries();
    expect(entry.args[0]).toContain('Error: the real cause');
  });

  it('includes the cause chain', async () => {
    vi.resetModules();
    const { installConsoleRing, getConsoleRingEntries } = await import('../../packages/modoki/src/runtime/core/consoleRing');
    installConsoleRing();
    const err = new Error('outer', { cause: new RangeError('inner') });
    console.error(err);

    const [entry] = getConsoleRingEntries();
    expect(entry.args[0]).toContain('Error: outer');
    expect(entry.args[0]).toContain('caused by: RangeError: inner');
  });
});
