import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  registerRealmShutdownTask,
  runRealmShutdownTasks,
  notifyRealmSurvived,
  shutdownRealmThenReload,
  __resetRealmShutdownForTest,
} from '../../src/runtime/core/realmShutdown';

afterEach(() => {
  __resetRealmShutdownForTest();
  vi.restoreAllMocks();
});

describe('realmShutdown', () => {
  it('runs every registered task', async () => {
    const a = vi.fn();
    const b = vi.fn();
    registerRealmShutdownTask('a', a);
    registerRealmShutdownTask('b', b);

    await runRealmShutdownTasks();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('is a once-per-realm latch — a second call does not re-run tasks', async () => {
    const task = vi.fn();
    registerRealmShutdownTask('task', task);

    await runRealmShutdownTasks();
    await runRealmShutdownTasks();

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('a throwing task does not prevent the others from running, and does not reject', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = vi.fn();
    registerRealmShutdownTask('boom-sync', () => { throw new Error('sync boom'); });
    registerRealmShutdownTask('boom-async', async () => { throw new Error('async boom'); });
    registerRealmShutdownTask('ok', ok);

    await expect(runRealmShutdownTasks()).resolves.toBeUndefined();

    expect(ok).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it('the disposer removes only its own task', async () => {
    const kept = vi.fn();
    const removed = vi.fn();
    registerRealmShutdownTask('kept', kept);
    const disposeRemoved = registerRealmShutdownTask('removed', removed);

    disposeRemoved();
    await runRealmShutdownTasks();

    expect(kept).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
  });

  it('notifyRealmSurvived() re-arms the seam so a LATER call re-runs every task', async () => {
    const task = vi.fn();
    registerRealmShutdownTask('task', task);

    await runRealmShutdownTasks();
    expect(task).toHaveBeenCalledTimes(1);

    // A failed reload: the realm did not actually die. Without re-arming, the second call below
    // would just return the earlier resolved promise and `task` would stay at 1 call.
    notifyRealmSurvived();
    await runRealmShutdownTasks();

    expect(task).toHaveBeenCalledTimes(2);
  });

  it('bounds the wait: a task that never settles still lets runRealmShutdownTasks() resolve', async () => {
    vi.useFakeTimers();
    try {
      registerRealmShutdownTask('hung', () => new Promise<void>(() => {}));

      const done = vi.fn();
      void runRealmShutdownTasks().then(done);

      // Nothing has settled yet.
      await vi.advanceTimersByTimeAsync(0);
      expect(done).not.toHaveBeenCalled();

      // Past the ~250ms bound, the race's timeout branch resolves it.
      await vi.advanceTimersByTimeAsync(300);
      expect(done).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('shutdownRealmThenReload — the latch is re-armed when the reload does not happen (#587)', () => {
  // ⚠️ Found in close-out review. Two of the three shipped reload sites composed this by hand as
  // `void runRealmShutdownTasks().finally(() => reload())`, with no catch. If `reload()` throws,
  // the tasks have already run, the once-per-realm latch is spent, and the realm is STILL ALIVE —
  // so the next reload in that realm skips teardown entirely, silently. Only resumeReload.ts
  // re-armed. The seam now owns the recovery so a call site cannot forget it.

  it('re-arms the latch when reload() throws, so a later reload still tears down', async () => {
    const ran: string[] = [];
    registerRealmShutdownTask('t', () => { ran.push('run'); });

    await expect(
      shutdownRealmThenReload(() => { throw new Error('navigation blocked'); }),
    ).rejects.toThrow('navigation blocked');
    expect(ran, 'the task ran on the first attempt').toEqual(['run']);

    // The realm survived. A second attempt must run the task AGAIN — if the latch were still
    // spent, this would resolve immediately having torn down nothing.
    await expect(
      shutdownRealmThenReload(() => { throw new Error('blocked again'); }),
    ).rejects.toThrow('blocked again');
    expect(ran, 'the second attempt re-ran teardown rather than returning the spent latch').toEqual(['run', 'run']);
  });

  it('runs teardown BEFORE the reload, not after', async () => {
    const order: string[] = [];
    registerRealmShutdownTask('t', () => { order.push('teardown'); });
    await expect(
      shutdownRealmThenReload(() => { order.push('reload'); throw new Error('stop'); }),
    ).rejects.toThrow('stop');
    expect(order).toEqual(['teardown', 'reload']);
  });

  it('still reloads when a task throws — a failed teardown must not block the reload', async () => {
    let reloaded = false;
    registerRealmShutdownTask('bad', () => { throw new Error('teardown failed'); });
    await expect(
      shutdownRealmThenReload(() => { reloaded = true; throw new Error('stop'); }),
    ).rejects.toThrow('stop');
    expect(reloaded, 'a throwing task must not prevent the realm from dying').toBe(true);
  });
});
