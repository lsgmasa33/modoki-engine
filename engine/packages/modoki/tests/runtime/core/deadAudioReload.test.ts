/**
 * #1455 — reload the page when its audio is dead: the decision, against injected dependencies.
 * Each rule in `core/deadAudioReload.ts` has a case here that fails when the rule is removed.
 */
import { describe, it, expect, vi } from 'vitest';
import { createDeadAudioReloadHandler, type DeadAudioReloadDeps } from '../../../src/runtime/core/deadAudioReload';

function deps(over: Partial<DeadAudioReloadDeps> = {}) {
  const calls: string[] = [];
  let last: number | null = null;
  let clock = 1_000_000;
  const d: DeadAudioReloadDeps = {
    now: () => clock,
    blockedBy: () => [],
    flush: vi.fn(async () => { calls.push('flush'); }),
    reload: vi.fn(async () => { calls.push('reload'); }),
    lastReloadAt: () => last,
    markReloaded: (at) => { calls.push('mark'); last = at; },
    wait: vi.fn(async (ms: number) => { clock += ms; }),
    stillDead: vi.fn(async () => true),
    minIntervalMs: 600_000,
    retryMs: 2_000,
    maxWaitMs: 10_000,
    ...over,
  };
  return { d, calls, advance: (ms: number) => { clock += ms; } };
}

describe('createDeadAudioReloadHandler (#1455)', () => {
  it('marks, flushes, THEN reloads — the mark must survive the reload, the flush must precede it', async () => {
    const { d, calls } = deps();
    expect(await createDeadAudioReloadHandler(d).onDead()).toBe('reloading');
    expect(calls).toEqual(['mark', 'flush', 'reload']);
  });

  it('refuses a second dead-audio reload within the interval (no reload loop), and allows one after it', async () => {
    const { d, advance } = deps();
    const h = createDeadAudioReloadHandler(d);
    expect(await h.onDead()).toBe('reloading');
    advance(599_000);
    expect(await h.onDead()).toBe('rate-limited');
    expect(d.reload).toHaveBeenCalledTimes(1);
    advance(2_000);
    expect(await h.onDead()).toBe('reloading');
  });

  it('waits while a reload blocker is active, then reloads once it clears', async () => {
    let blocked = 3;
    const { d } = deps({ blockedBy: () => (blocked-- > 0 ? ['wordweave.fullscreenAd'] : []) });
    expect(await createDeadAudioReloadHandler(d).onDead()).toBe('reloading');
    expect(d.wait).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxWaitMs blocked, without reloading or spending the rate-limit', async () => {
    const { d, calls } = deps({ blockedBy: () => ['iap'] });
    expect(await createDeadAudioReloadHandler(d).onDead()).toBe('blocked');
    expect(d.reload).not.toHaveBeenCalled();
    expect(calls).not.toContain('mark');
  });

  it('a second call while the first is still deciding is refused, not a second reload', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { d } = deps({ flush: () => gate });
    const h = createDeadAudioReloadHandler(d);
    const first = h.onDead();
    expect(await h.onDead()).toBe('busy');
    release();
    expect(await first).toBe('reloading');
    expect(d.reload).toHaveBeenCalledTimes(1);
  });

  it('re-checks right before reloading: audio that came back by itself (e.g. while blocked) is not reloaded', async () => {
    let blocked = 2;
    const { d, calls } = deps({
      blockedBy: () => (blocked-- > 0 ? ['wordweave.purchase'] : []),
      stillDead: async () => false,
    });
    expect(await createDeadAudioReloadHandler(d).onDead()).toBe('recovered');
    expect(d.reload).not.toHaveBeenCalled();
    expect(calls, 'nor does it spend the rate-limit').not.toContain('mark');
  });
});

