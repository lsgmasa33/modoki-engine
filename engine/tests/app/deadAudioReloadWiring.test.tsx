// @vitest-environment jsdom
/** Pins the app-shell WIRING of the dead-audio reload (#1455): what `useDeadAudioReload` hands the
 *  decision, and the guards that live only here. The decision is tested in
 *  `packages/modoki/tests/runtime/core/deadAudioReload.test.ts`; the opt-in read in
 *  `deadAudioReload.test.tsx` (a separate file because `vi.mock` of the project config is per file).
 *
 *  ⚠️ `.test.tsx`, not `.ts`: `engine/vite.config.ts` collects only `tests/app/**\/*.test.tsx`. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const spies = vi.hoisted(() => ({
  deadListeners: new Set<(after: 'ad' | 'foreground') => void>(),
  onDead: vi.fn(async () => 'reloading'),
  deps: null as null | Record<string, (...a: unknown[]) => unknown>,
  shutdownRealmThenReload: vi.fn(),
  isAudioStillDead: vi.fn(async () => true),
}));

vi.mock('virtual:modoki-project-config', () => ({ default: { runtime: { reloadOnDeadAudio: true } } }));
vi.mock('@modoki/engine/runtime', () => ({
  PlayerPrefs: { flush: vi.fn() },
  getActiveReloadBlockers: () => [],
  isAudioStillDead: spies.isAudioStillDead,
  shutdownRealmThenReload: spies.shutdownRealmThenReload,
  createDeadAudioReloadHandler: (deps: Record<string, (...a: unknown[]) => unknown>) => {
    spies.deps = deps;
    return { onDead: spies.onDead };
  },
  onAudioDead: (fn: (after: 'ad' | 'foreground') => void) => {
    spies.deadListeners.add(fn);
    return () => { spies.deadListeners.delete(fn); };
  },
}));

const { useDeadAudioReload } = await import('../../app/useDeadAudioReload');
function Probe() { useDeadAudioReload(); return null; }
const fireDead = () => { for (const fn of spies.deadListeners) fn('foreground'); };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.location.hash = '';
  sessionStorage.clear();
});

describe('useDeadAudioReload wiring (#1455)', () => {
  it('a dead verdict on the GAME route asks the handler; unmount unsubscribes', () => {
    const { unmount } = render(<Probe />);
    expect(spies.deadListeners.size).toBe(1);
    fireDead();
    expect(spies.onDead).toHaveBeenCalledTimes(1);
    unmount();
    expect(spies.deadListeners.size).toBe(0);
  });

  it('NEVER on the editor route — a reload there discards unsaved scene edits', () => {
    window.location.hash = '#/editor';
    render(<Probe />);
    fireDead();
    expect(spies.onDead).not.toHaveBeenCalled();
  });

  it('the rate-limit memory round-trips through sessionStorage, and junk reads as "never"', () => {
    render(<Probe />);
    const d = spies.deps!;
    expect(d.lastReloadAt()).toBeNull();
    d.markReloaded(1234567);
    expect(d.lastReloadAt()).toBe(1234567);
    sessionStorage.setItem('modoki.deadAudioReloadAt', 'garbage');
    expect(d.lastReloadAt()).toBeNull();
  });

  it('reloads through the realm shutdown, and re-checks through the audio service', async () => {
    render(<Probe />);
    const d = spies.deps!;
    d.reload();
    expect(spies.shutdownRealmThenReload).toHaveBeenCalledTimes(1);
    await d.stillDead();
    expect(spies.isAudioStillDead).toHaveBeenCalledTimes(1);
  });
});
