/**
 * hmrStaleness — the RENDERER half of the game-code HMR fix.
 *
 * WHY THIS FILE MATTERS MORE THAN ITS SIZE SUGGESTS. This module owns the only code path
 * in the engine that can deliberately destroy a user's unsaved work, and the only signal
 * (`discardedUnsavedEdits` / `!hmr.discarded-unsaved`) that docs tell agents to trust when
 * deciding whether an editor's measurements are stale. Both were previously untested: the
 * one existing test covered the dev-SERVER hook (which signal is sent), not what the
 * renderer does with it.
 *
 * The module takes its hot context and its dirty-probe as parameters precisely so this is
 * testable — `import.meta.hot` is undefined under vitest, so without those seams every
 * branch below would be unreachable from a test.
 *
 * `location.reload` is not implementable in jsdom, so it is replaced with a spy per test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { HotLike } from '../../app/debug/hmrStaleness';

// `status` is module-level and deliberately STICKY for the life of a page (an agent reading
// get_editor_state later must still learn that work was dropped). That is right in
// production — initHmrStaleness runs once per page load — but it would leak between tests,
// so each test gets a fresh module instance instead of a test-only reset export.
type Mod = typeof import('../../app/debug/hmrStaleness');
let initHmrStaleness: Mod['initHmrStaleness'];
let getHmrStatus: Mod['getHmrStatus'];

const DISCARDED_KEY = 'modoki:hmr-discarded';
const BANNER_ID = 'modoki-hmr-banner';

/** A stand-in for Vite's hot context that lets a test fire HMR events by hand. */
function fakeHot(): HotLike & { emit: (event: string, payload?: unknown) => void } {
  const handlers = new Map<string, ((p: never) => void)[]>();
  return {
    on: (event, cb) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    emit: (event, payload) => {
      for (const cb of handlers.get(event) ?? []) (cb as (p: unknown) => void)(payload);
    },
  };
}

let reload: ReturnType<typeof vi.fn>;

const banner = () => document.getElementById(BANNER_ID);
const bannerText = () => banner()?.textContent ?? '';
const clickButton = (label: string): void => {
  const btn = [...(banner()?.querySelectorAll('button') ?? [])]
    .find((b) => b.textContent === label);
  if (!btn) throw new Error(`no "${label}" button; banner reads: ${bannerText()}`);
  btn.click();
};
/** Let the handler's awaits settle — the dirty probe is async by design. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  vi.resetModules();
  ({ initHmrStaleness, getHmrStatus } = await import('../../app/debug/hmrStaleness'));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  });
  sessionStorage.clear();
  document.getElementById(BANNER_ID)?.remove();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('game code changed — clean scene', () => {
  it('reloads immediately, with no banner and no discard record', async () => {
    const hot = fakeHot();
    initHmrStaleness(hot, () => false);
    hot.emit('modoki:game-code-changed', { file: '/g/runtime/systems.ts' });
    await settle();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(banner()).toBeNull();
    // Nothing was lost, so nothing may be reported as lost.
    expect(sessionStorage.getItem(DISCARDED_KEY)).toBeNull();
  });
});

describe('game code changed — dirty scene', () => {
  it('does NOT reload during the grace window, and warns that work will be lost', async () => {
    const hot = fakeHot();
    initHmrStaleness(hot, () => true);
    hot.emit('modoki:game-code-changed', { file: '/g/runtime/systems.ts' });
    await settle();

    expect(reload).not.toHaveBeenCalled();
    expect(bannerText()).toContain('unsaved scene changes will be LOST');

    vi.advanceTimersByTime(2000);
    expect(reload, 'must still be counting down at 2s').not.toHaveBeenCalled();
  });

  it('takes the loss when the countdown expires, and records it for the next page', async () => {
    const hot = fakeHot();
    initHmrStaleness(hot, () => true);
    hot.emit('modoki:game-code-changed', { file: '/g/runtime/systems.ts' });
    await settle();

    vi.advanceTimersByTime(5200);
    await settle();

    expect(reload).toHaveBeenCalledTimes(1);
    const rec = JSON.parse(sessionStorage.getItem(DISCARDED_KEY) ?? 'null');
    expect(rec?.file).toBe('/g/runtime/systems.ts');
  });

  it('SAVING during the grace window means no discard is recorded', async () => {
    // Saving is an advertised response to the banner, so this is the COMMON case — and
    // recording a discard that never happened would poison the exact signal agents are
    // told to trust. The flag must be re-read at reload time, not captured 5s earlier.
    let dirty = true;
    const hot = fakeHot();
    initHmrStaleness(hot, () => dirty);
    hot.emit('modoki:game-code-changed', { file: '/g/runtime/systems.ts' });
    await settle();

    dirty = false; // user hits Cmd+S while the banner counts down
    vi.advanceTimersByTime(5200);
    await settle();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(DISCARDED_KEY), 'nothing was lost, so nothing may be claimed lost')
      .toBeNull();
  });

  it('"Reload now" discards immediately', async () => {
    const hot = fakeHot();
    initHmrStaleness(hot, () => true);
    hot.emit('modoki:game-code-changed', { file: '/g/a.ts' });
    await settle();

    clickButton('Reload now');
    await settle();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(DISCARDED_KEY) ?? 'null')?.file).toBe('/g/a.ts');
  });

  it('"Cancel" keeps the edits, skips the reload, and marks the editor STALE', async () => {
    const hot = fakeHot();
    initHmrStaleness(hot, () => true);
    hot.emit('modoki:game-code-changed', { file: '/g/a.ts' });
    await settle();

    clickButton('Cancel');
    vi.advanceTimersByTime(10_000); // the countdown must be dead, not merely paused

    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(DISCARDED_KEY)).toBeNull();
    // This is the state where measurements silently lie, so it must be reported.
    expect(getHmrStatus().staleGameCode).toBe(true);
    expect(bannerText()).toContain('STALE');
  });
});

describe('reporting a discard the PREVIOUS page took', () => {
  it('consumes the record on boot, surfaces it, and does not re-report it', async () => {
    sessionStorage.setItem(DISCARDED_KEY, JSON.stringify({ file: '/g/x.ts', at: 1 }));

    initHmrStaleness(fakeHot(), () => false);
    await settle();

    expect(getHmrStatus().discardedUnsavedEdits).toBe(true);
    expect(bannerText()).toContain('discarded');
    // Consumed, so a later reload does not claim a second, phantom loss.
    expect(sessionStorage.getItem(DISCARDED_KEY)).toBeNull();
  });

  it('stays silent when there is no record', async () => {
    initHmrStaleness(fakeHot(), () => false);
    await settle();
    expect(getHmrStatus().discardedUnsavedEdits).toBe(false);
    expect(banner()).toBeNull();
  });
});

describe('no hot context (a shipped game build)', () => {
  it('is completely inert', async () => {
    initHmrStaleness(undefined, () => true);
    await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(banner()).toBeNull();
  });
});
