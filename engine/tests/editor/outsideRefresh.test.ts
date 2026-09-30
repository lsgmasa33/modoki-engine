/** #1879 part 2: `modoki_refresh`'s flow. Owner, 2026-09-30: "claude can reload any time, and we show a toaster for a
 *  human with count down". The countdown, the hold and the release are fakes here: the release and the hold are driven
 *  for real in `outsideSceneConflict.test.ts`, the countdown is `countdownBanner.ts`'s.
 *  Mutations, measured: the countdown run whether or not a human is focused (`deps.focused() &&` dropped) → "nobody
 *  focused" goes red; a Cancel that applies anyway (the cancel branch dropped) → "a Cancel" goes red; `decision` not
 *  passed to the release → "the agent's scene answer" goes red; `deferredFields` dropped from the early return → "a
 *  change Play deferred" goes red. */
import { describe, it, expect } from 'vitest';
import { refreshOutsideChanges, decideSceneConflict, type RefreshDeps } from '../../app/editor/outsideRefresh';
import type { OutsideReleaseReport } from '../../app/debug/agentBridge';

function rig(o: { pending: string[]; focused: boolean; press?: 'go' | 'cancel'; report?: Partial<OutsideReleaseReport>; awaiting?: string[]; deferred?: string[] }) {
  const calls = { countdown: 0, release: [] as { decision?: string }[] };
  const deps: RefreshDeps = {
    pending: () => o.pending,
    awaiting: () => o.awaiting ?? [],
    deferred: () => ({ paths: o.deferred ?? [], reason: o.deferred?.length ? 'game is playing — stop the game (Stop) before editing the scene' : null }),
    focused: () => o.focused,
    countdown: async () => { calls.countdown++; return o.press ?? 'go'; },
    release: async (opts) => { calls.release.push(opts); return { applied: o.pending, deferred: [], sceneConflicts: [], ...o.report }; },
  };
  return { deps, calls };
}

describe('refreshOutsideChanges', () => {
  it('nobody focused: applies at once, no countdown', async () => {
    const { deps, calls } = rig({ pending: ['/a.prefab.json'], focused: false });
    expect(await refreshOutsideChanges(deps)).toEqual({ applied: ['/a.prefab.json'] });
    expect(calls.countdown).toBe(0);
  });

  it('a human focused: the countdown first, then the release', async () => {
    const { deps, calls } = rig({ pending: ['/a.prefab.json'], focused: true });
    expect((await refreshOutsideChanges(deps)).applied).toEqual(['/a.prefab.json']);
    expect(calls).toEqual({ countdown: 1, release: [{ decision: undefined }] });
  });

  it('a Cancel applies nothing and says the changes are still pending', async () => {
    const { deps, calls } = rig({ pending: ['/a.prefab.json'], focused: true, press: 'cancel' });
    const r = await refreshOutsideChanges(deps);
    expect(r).toMatchObject({ applied: [], cancelled: true });
    expect(r.hint).toMatch(/stale/);
    expect(calls.release).toEqual([]);
  });

  it('nothing held: no countdown, nothing applied', async () => {
    const { deps, calls } = rig({ pending: [], focused: true });
    expect(await refreshOutsideChanges(deps)).toEqual({ applied: [] });
    expect(calls.countdown).toBe(0);
  });

  it('the agent\'s scene answer reaches the release, and a question left open is reported', async () => {
    const held = rig({
      pending: ['/s.scene.json'], focused: false,
      report: { applied: [], sceneConflicts: [{ urlPath: '/s.scene.json', answer: 'held' }] },
    });
    const r = await refreshOutsideChanges(held.deps, 'keep');
    expect(held.calls.release).toEqual([{ decision: 'keep' }]);
    expect(r.sceneConflicts).toEqual([{ path: '/s.scene.json', status: 'held' }]);
    expect(r.hint).toMatch(/scene:"reload".*scene:"keep"/);
    const open = rig({ pending: [], focused: true, awaiting: ['/s.scene.json'] });
    expect(await refreshOutsideChanges(open.deps)).toMatchObject({ applied: [], awaitingHuman: true });
  });
});

describe('refreshOutsideChanges: what a refresh cannot apply', () => {
  it('a change Play deferred is reported with its reason, held or not (review 2, #4)', async () => {
    const none = rig({ pending: [], focused: false, deferred: ['/s.scene.json'] });
    expect(await refreshOutsideChanges(none.deps)).toEqual({
      applied: [], deferred: ['/s.scene.json'], deferredReason: 'game is playing — stop the game (Stop) before editing the scene',
    });
    const some = rig({ pending: ['/a.prefab.json'], focused: false, deferred: ['/s.scene.json'] });
    expect(await refreshOutsideChanges(some.deps)).toMatchObject({ applied: ['/a.prefab.json'], deferred: ['/s.scene.json'] });
  });
});

describe('decideSceneConflict', () => {
  it('a clean scene is no question; a focused human is always asked; otherwise the agent answers or it is held', () => {
    expect(decideSceneConflict({ dirty: false, focused: true })).toBe('clean');
    expect(decideSceneConflict({ dirty: true, focused: true, decision: 'reload' })).toBe('asking');
    expect(decideSceneConflict({ dirty: true, focused: false, decision: 'reload' })).toBe('reload');
    expect(decideSceneConflict({ dirty: true, focused: false, decision: 'keep' })).toBe('kept');
    expect(decideSceneConflict({ dirty: true, focused: false })).toBe('held');
  });
});
