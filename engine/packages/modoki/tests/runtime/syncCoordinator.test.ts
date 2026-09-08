/** WHEN a cloud sync runs (#361; moved out of the worked example in #658).
 *
 *  The awkward cases here are all about OVERLAP, and none of them are visible in a single-trigger
 *  test: a burst of progression writes, a background trigger landing mid-sync, a conflict that has
 *  not been answered yet. Every dependency is injected, so each is driven deterministically instead
 *  of with sleeps.
 *
 *  ⚠️ **The document type here is a STUB, and that is the point.** The coordinator never reads a
 *  field off a save document, so this suite gives it the smallest one its assertions need — a
 *  `version`, to tell two forks apart. If a change to the coordinator ever makes a richer document
 *  necessary HERE, that is the signal it has stopped being document-agnostic.
 */
import { describe, expect, it } from 'vitest';
import {
  CloudSyncCoordinator,
  type CloudSyncDeps, type ConflictChoice, type SyncFork, type SyncOutcomeOf,
} from '../../src/runtime/sync';

/** The stub save document — a version and nothing else. */
interface TestDoc { version: number }
interface TestFork extends SyncFork { groupId: string; serverDoc: TestDoc }
type TestOutcome = SyncOutcomeOf<TestFork>;
type TestDeps = CloudSyncDeps<TestFork>;

function harness(over: Partial<TestDeps> = {}) {
  const calls: string[] = [];
  const timers: (() => void)[] = [];
  let nextOutcome: TestOutcome = { kind: 'idle' };
  let gate: (() => void) | null = null;
  let resolveGate: (() => void) | null = null;
  const deps: TestDeps = {
    currentUid: () => 'uid-1',
    sync: async () => {
      calls.push('sync');
      if (gate) await new Promise<void>((r) => { const g = gate!; gate = null; timers.push(() => { g(); r(); }); });
      return nextOutcome;
    },
    resolve: async (groupId: string, _doc: TestDoc, choice: ConflictChoice) => {
      calls.push(`resolve:${groupId}:${choice}`);
      if (resolveGate) await new Promise<void>((r) => { const g = resolveGate!; resolveGate = null; timers.push(() => { g(); r(); }); });
      return nextOutcome;
    },
    schedule: (_ms, fn) => { timers.push(fn); },
    ...over,
  };
  return {
    deps, calls, timers,
    c: new CloudSyncCoordinator<TestFork>(deps),
    set(o: TestOutcome) { nextOutcome = o; },
    /** Make the next sync() hang until `release()` is called. */
    hold() { gate = () => {}; },
    /** Make the next resolve() hang until `release()` is called — mirrors `hold()`. */
    holdResolve() { resolveGate = () => {}; },
    runTimers() { const t = timers.splice(0); t.forEach((f) => f()); },
  };
}

/** One asking fork, defaulting to `groupId: 'g'`. A real game's fork type carries its dialog's
 *  summary rows too; none of them are modelled here, because the coordinator cannot see them. */
const askingFork = (over: Partial<TestFork> = {}): TestFork => ({
  groupId: 'g',
  serverDoc: { version: 4 },
  ...over,
});

/** A single-group `'ask'` outcome — #532 C5's list shape, with exactly one entry. */
const fork = (): TestOutcome => ({ kind: 'ask', forks: [askingFork()] });

describe('an empty `ask` must not wedge the coordinator (#658 close-out review)', () => {
  /* `[]` is truthy, so installing it as `pending` hands the UI a conflict with no rows AND latches
     rule 1's suppression forever — `answer()` bails on `length === 0` without clearing it, so the
     player cannot dismiss a dialog they were never shown. Only a sign-out would recover.
     Unreachable from the worked example (its `syncNow` guards `asking.length > 0`), but the
     PUBLISHED contract types `forks` as a plain array with no non-empty floor, and accepting a
     second game's `sync`/`resolve` is the entire point of this module being engine-side. */

  it('does not install an empty fork list from sync(), and keeps syncing afterwards', async () => {
    const h = harness();
    h.set({ kind: 'ask', forks: [] });
    const reported = await h.c.request('sign-in');
    expect(h.c.conflict()).toBeNull();      // not `[]` — an empty conflict is not a conflict
    // ⚠️ The REPORT must agree with the state. Reporting `'ask'` while `conflict()` is null sends
    // `if (o.kind === 'ask') show(c.conflict()!)` — the obvious consumer loop — straight through a
    // non-null assertion with null, and records a dialog in `onOutcome` nobody was ever shown.
    expect(reported).toEqual({ kind: 'idle' });
    h.set({ kind: 'idle' });
    expect(await h.c.request('resume')).not.toBeNull();  // rule 1 must NOT be latched
    expect(h.calls).toEqual(['sync', 'sync']);
  });

  it('does not install an empty fork list from answer()', async () => {
    const h = harness();
    h.set(fork());
    await h.c.request('sign-in');           // a real conflict, so there is something to answer
    h.set({ kind: 'ask', forks: [] });      // ...whose resolve comes back empty
    expect(await h.c.answer('local')).toEqual({ kind: 'idle' });
    expect(h.c.conflict()).toBeNull();
    h.set({ kind: 'idle' });
    expect(await h.c.request('resume')).not.toBeNull();
  });
});

describe('when a sync is skipped', () => {
  it('does nothing while signed out', async () => {
    const h = harness({ currentUid: () => null });
    expect(await h.c.request('sign-in')).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('does not ask twice about the same fork', async () => {
    // A second dialog stacked over a decision the player is already making.
    const h = harness();
    h.set(fork());
    await h.c.request('sign-in');
    expect(h.c.conflict()).not.toBeNull();
    expect(await h.c.request('resume')).toBeNull();
    expect(await h.c.request('background')).toBeNull();
    expect(h.calls).toEqual(['sync']);
  });
});

describe('coalescing', () => {
  it('folds a burst of progression writes into ONE sync', async () => {
    // Solving a level writes progress, wallet and rating in the same frame. Three uploads of one
    // document is two wasted round trips on a player's data plan.
    const h = harness();
    await h.c.request('progress');
    await h.c.request('progress');
    await h.c.request('progress');
    expect(h.calls).toEqual([]); // still debouncing
    h.runTimers();
    await Promise.resolve();
    expect(h.calls).toEqual(['sync']);
  });

  it('runs exactly ONE follow-up for any number of triggers landing mid-sync', async () => {
    const h = harness();
    h.hold();
    const first = h.c.request('sign-in');
    await Promise.resolve();
    expect(await h.c.request('resume')).toBeNull();
    expect(await h.c.request('background')).toBeNull();
    h.runTimers();          // release the held sync
    await first;
    await Promise.resolve();
    expect(h.calls).toEqual(['sync', 'sync']); // the original + one follow-up, not three
  });

  it('does not run the follow-up when the first sync raised a conflict', async () => {
    // The follow-up would be suppressed by the pending conflict anyway; running it would just
    // burn a round trip to be told the same thing.
    const h = harness();
    h.hold();
    h.set(fork());
    const first = h.c.request('sign-in');
    await Promise.resolve();
    await h.c.request('background');
    h.runTimers();
    await first;
    await Promise.resolve();
    expect(h.calls).toEqual(['sync']);
  });

  it('a debounce timer firing while a conflict dialog is open does not replace it behind the player\'s back (review finding 3)', async () => {
    // Rule 1: a pending conflict suppresses further syncs — every OTHER dispatch site guards with
    // `!this.pending` (`request`'s own check, `answer`'s cleared-before-await). The debounce
    // closure reaches `run()` directly and `run()` has no such check, so a timer that happens to
    // fire while the player is looking at a dialog silently replaces `pending` with a NEW fork —
    // the player answers a fork (v9) they were never shown, having been shown a different one (v4).
    const h = harness();
    await h.c.request('progress');           // arms the debounce timer
    h.set(fork());                            // serverDoc.version === 4
    await h.c.request('background');         // -> 'ask', dialog open on version 4
    expect(h.c.conflict()?.[0]?.serverDoc.version).toBe(4);
    const newer = fork();
    (newer as { forks: TestFork[] }).forks[0].serverDoc = { version: 9 };
    h.set(newer);
    h.timers[0]();                            // the debounce timer fires while the dialog is open
    await Promise.resolve();
    await Promise.resolve();
    expect(h.c.conflict()?.[0]?.serverDoc.version).toBe(4); // must NOT be replaced while pending
    expect(h.calls).toEqual(['sync']);        // the debounce timer must not have synced at all
  });

  it('a debounce timer firing with NO pending conflict still syncs — keep-direction for finding 3', async () => {
    const h = harness();
    await h.c.request('progress');           // arms the debounce timer
    h.runTimers();
    await Promise.resolve();
    expect(h.calls).toEqual(['sync']);
  });
});

describe('answering a conflict', () => {
  it('applies the choice and clears the question', async () => {
    const h = harness();
    h.set(fork());
    await h.c.request('sign-in');
    h.set({ kind: 'uploaded', version: 5 });
    const out = await h.c.answer('local');
    expect(out?.kind).toBe('uploaded');
    expect(h.c.conflict()).toBeNull();
    expect(h.calls).toEqual(['sync', 'resolve:g:local']);
  });

  it('raises a NEW question when a third write landed while the dialog was open', async () => {
    const h = harness();
    h.set(fork());
    await h.c.request('sign-in');
    const newer = fork();
    (newer as { forks: TestFork[] }).forks[0].serverDoc = { version: 9 };
    h.set(newer);
    await h.c.answer('server');
    expect(h.c.conflict()?.[0]?.serverDoc.version).toBe(9); // a fresh fork, not the answered one
  });

  it('⚠️ a trigger arriving DURING the answer does not race the resolve', async () => {
    // answer() cleared `pending` before awaiting but never took the in-flight lock, so a
    // background trigger during a slow push passed both guards and ran sync() concurrently with
    // resolve() — reading a server still on the old version, raising a NEW conflict about the fork
    // just answered, and re-showing the dialog for a settled question (close-out review, finding 5).
    let releaseResolve: (() => void) | null = null;
    const calls: string[] = [];
    const c = new CloudSyncCoordinator<TestFork>({
      currentUid: () => 'uid-1',
      sync: async () => { calls.push('sync'); return { kind: 'idle' }; },
      resolve: async () => {
        calls.push('resolve');
        await new Promise<void>((r) => { releaseResolve = r; });
        return { kind: 'uploaded', version: 5 };
      },
      schedule: (_ms, fn) => { fn(); },
    });
    // Seed a pending conflict through the real path.
    const f = fork();
    if (f.kind !== 'ask') throw new Error('unreachable');
    (c as unknown as { pending: unknown }).pending = f.forks;
    const answering = c.answer('local');
    await Promise.resolve();
    expect(await c.request('background')).toBeNull();   // deferred, not run concurrently
    expect(calls).toEqual(['resolve']);
    releaseResolve!();
    await answering;
    await Promise.resolve();
    expect(calls).toEqual(['resolve', 'sync']);          // the deferred trigger runs AFTER
  });

  it('is a no-op with nothing pending', async () => {
    const h = harness();
    expect(await h.c.answer('local')).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('unblocks syncing again after the answer', async () => {
    const h = harness();
    h.set(fork());
    await h.c.request('sign-in');
    h.set({ kind: 'idle' });
    await h.c.answer('server');
    expect(await h.c.request('resume')).toEqual({ kind: 'idle' });
  });
});

describe('answering a TWO-group fork (#532 C5 — ruling 4: one choice, applied to each independently)', () => {
  /** A coordinator whose `resolve` looks up a per-groupId outcome from `byGroup`, defaulting to
   *  `{ kind: 'uploaded', version: 1 }` — lets each test say exactly what group A and group B do
   *  without the shared `harness()`'s single `nextOutcome`. */
  function twoGroupHarness(byGroup: Record<string, TestOutcome>) {
    const calls: { groupId: string; doc: TestDoc; choice: ConflictChoice }[] = [];
    const c = new CloudSyncCoordinator<TestFork>({
      currentUid: () => 'uid-1',
      sync: async () => ({ kind: 'ask', forks: [askingFork({ groupId: 'g.a' }), askingFork({ groupId: 'g.b', serverDoc: { version: 7 } })] }),
      resolve: async (groupId, doc, choice) => {
        calls.push({ groupId, doc, choice });
        return byGroup[groupId] ?? { kind: 'uploaded', version: 1 };
      },
      schedule: () => {},
    });
    return { c, calls };
  }

  it('an EMPTY ask from group A must not end the loop and skip group B (#658 close-out, F2)', async () => {
    /* `answer()` breaks on a fresh `'ask'` because a real one already describes the state of every
       group (the resolve re-enters a full sync). An EMPTY ask describes nothing, so breaking on it
       silently drops the player's answer for every remaining group — the one case here that loses
       real input. Fixed at the boundary (`normalizeOutcome`), not at the `break`. */
    const { c, calls } = twoGroupHarness({ 'g.a': { kind: 'ask', forks: [] } });
    await c.request('sign-in');
    expect(c.conflict()?.map((f) => f.groupId)).toEqual(['g.a', 'g.b']);
    await c.answer('local');
    expect(calls.map((x) => x.groupId)).toEqual(['g.a', 'g.b']);  // B was NOT skipped
  });

  it('resolves EACH asking group against its OWN serverDoc, with the single choice', async () => {
    const { c, calls } = twoGroupHarness({});
    await c.request('sign-in');
    expect(c.conflict()?.map((f) => f.groupId)).toEqual(['g.a', 'g.b']);
    await c.answer('local');
    expect(calls.map((x) => x.groupId)).toEqual(['g.a', 'g.b']);
    expect(calls.every((x) => x.choice === 'local')).toBe(true);
    expect(calls[0].doc.version).toBe(4); // askingFork()'s default serverDoc
    expect(calls[1].doc.version).toBe(7); // group B's own, different serverDoc
  });

  /**
   * #532 C4c-2 review, finding 6. `resolveSyncConflict` absorbs a `'restart'` by re-entering a FULL
   * `syncNow` over every group, so an `'ask'` returned by group A's resolve already describes the
   * current state of B as well. Continuing the loop would resolve B against a `serverDoc` captured
   * before that re-sync, and would pool two entries for one group id — which the chrome renders one
   * of arbitrarily and the next `answer()` resolves twice.
   *
   * Asserted on the CALL LIST, not just the outcome: the outcome is `'ask'` either way, so a test
   * that only checked `c.conflict()` would pass with the `break` deleted.
   */
  it('a fresh `ask` from one group ENDS the loop — the later groups are not resolved stale', async () => {
    const refork = askingFork({ groupId: 'g.b', serverDoc: { version: 9 } });
    const { c, calls } = twoGroupHarness({ 'g.a': { kind: 'ask', forks: [refork] } });
    await c.request('sign-in');
    await c.answer('local');
    // B was never resolved from the ORIGINAL list — A's resolve already re-synced every group.
    expect(calls.map((x) => x.groupId)).toEqual(['g.a']);
    // And exactly one pending entry for B, from the re-sync — not two.
    expect(c.conflict()?.map((f) => f.groupId)).toEqual(['g.b']);
    expect(c.conflict()?.[0].serverDoc.version).toBe(9);
  });

  it('⚠️ A succeeds, B fails: reports `failed`, not a silent success (deliberate decision, #532 C5)', async () => {
    // Reporting the LAST group's outcome ('uploaded' if B ran last, 'failed' if A ran last) would
    // hide whichever one it is not — this pins the priority instead: any failure in the set wins
    // over a success, so the player is told the answer did not fully land, even though group A's
    // half is genuinely safe on the device (`resolveGroupFork`'s own guarantee) and will retry.
    const { c } = twoGroupHarness({
      'g.a': { kind: 'uploaded', version: 5 },
      'g.b': { kind: 'failed', reason: 'push rejected' },
    });
    await c.request('sign-in');
    const out = await c.answer('local');
    expect(out?.kind).toBe('failed');
    // Neither group's answer is left pending — both were resolved, one just did not land.
    expect(c.conflict()).toBeNull();
  });

  it('A fails, B succeeds: still `failed` — order does not decide the verdict', async () => {
    const { c } = twoGroupHarness({
      'g.a': { kind: 'failed', reason: 'push rejected' },
      'g.b': { kind: 'uploaded', version: 5 },
    });
    await c.request('sign-in');
    const out = await c.answer('local');
    expect(out?.kind).toBe('failed');
  });

  it('every group lands cleanly: reports the strongest signal, `adopted` over `uploaded`', async () => {
    const { c } = twoGroupHarness({
      'g.a': { kind: 'uploaded', version: 5 },
      'g.b': { kind: 'adopted', version: 7 },
    });
    await c.request('sign-in');
    const out = await c.answer('local');
    expect(out?.kind).toBe('adopted');
  });

  it('a group that RE-FORKS wins over a sibling that succeeded — the fresh question is shown', async () => {
    const { c } = twoGroupHarness({
      'g.a': { kind: 'uploaded', version: 5 },
      'g.b': { kind: 'ask', forks: [askingFork({ groupId: 'g.b', serverDoc: { version: 9 } })] },
    });
    await c.request('sign-in');
    const out = await c.answer('local');
    expect(out?.kind).toBe('ask');
    expect(c.conflict()?.map((f) => f.groupId)).toEqual(['g.b']);
    expect(c.conflict()?.[0]?.serverDoc.version).toBe(9);
  });
});

describe('failure and reset', () => {
  it('survives a sync that throws, and keeps syncing afterwards', async () => {
    // A rejection escaping the run would leave inFlight stuck true and silently kill every later
    // sync for the rest of the session — a mechanism that stops working with no symptom.
    let boom = true;
    const h = harness({ sync: async () => { if (boom) { boom = false; throw new Error('offline'); } return { kind: 'idle' }; } });
    const out = await h.c.request('sign-in');
    expect(out?.kind).toBe('failed');
    expect((await h.c.request('resume'))?.kind).toBe('idle');
  });

  it('drops a pending conflict on reset — it belongs to the account that raised it', async () => {
    // Carrying it across a sign-out would ask the NEXT player about a save that is not theirs.
    const h = harness();
    h.set(fork());
    await h.c.request('sign-in');
    h.c.reset();
    expect(h.c.conflict()).toBeNull();
  });
});

describe('a reset landing while an operation is already in flight (#506)', () => {
  // `inFlight` is a re-entrancy lock, not an identity token — it says nothing about which account
  // started the call it is guarding. A boolean "was reset" flag is not enough either, because
  // sign-out-then-sign-in-as-another-account must read differently from a plain sign-out, which is
  // exactly what a boolean cannot do. Hence the generation counter: every async path captures it
  // before its first await and checks for drift after, and a mismatch means the account that asked
  // for this work is gone.

  it('a sign-out landing inside sync() does not leave the previous account’s conflict pending for the next player', async () => {
    const h = harness();
    h.hold();
    h.set(fork());
    const first = h.c.request('sign-in');
    await Promise.resolve();
    h.c.reset(); // the sign-out lands while sync() is still awaiting
    h.runTimers(); // release the held sync
    await first;
    await Promise.resolve();
    expect(h.c.conflict()).toBeNull();
  });

  it('a sign-out landing inside resolve() does not re-install a conflict', async () => {
    const h = harness();
    h.set(fork());
    await h.c.request('sign-in'); // seeds a pending conflict the normal way
    expect(h.c.conflict()).not.toBeNull();
    h.holdResolve();
    h.set(fork()); // what resolve() would return if a third write landed mid-dialog
    const answering = h.c.answer('local');
    await Promise.resolve();
    h.c.reset(); // the sign-out lands while resolve() is still awaiting
    h.runTimers(); // release the held resolve
    await answering;
    await Promise.resolve();
    expect(h.c.conflict()).toBeNull();
  });

  it('a coalesced follow-up trigger that arrived BEFORE the sign-out is not run after it', async () => {
    const h = harness();
    h.hold();
    const first = h.c.request('sign-in');
    await Promise.resolve();
    // The trigger lands mid-sync, while the account is still the live one — a normal rule-2
    // coalesce — and only THEN does the sign-out land, before the dead sync's lock is released.
    expect(await h.c.request('background')).toBeNull();
    h.c.reset();
    h.runTimers(); // release the held sync
    await first;
    await Promise.resolve();
    expect(h.calls).toEqual(['sync']); // no second sync for the pre-reset trigger
  });

  it('a progress debounce timer that fires after a sign-out does not sync', async () => {
    const h = harness();
    await h.c.request('progress');
    expect(h.calls).toEqual([]); // still debouncing
    h.c.reset();
    h.runTimers(); // fire the debounce timer
    await Promise.resolve();
    expect(h.calls).toEqual([]);
  });

  it('a dead progress timer does not unlatch the LIVE session\'s debounce (review finding 2)', async () => {
    // The dead timer bails correctly on the generation check — but it cleared `debouncing`
    // unconditionally on the way past, so the NEXT session's own in-progress debounce window
    // unlatches early and a same-burst trigger is no longer swallowed: two uploads of one document
    // instead of one.
    const h = harness();
    await h.c.request('progress');          // account A arms timer[0], generation 0
    h.c.reset();                             // sign-out → generation 1, debouncing cleared
    await h.c.request('progress');          // account B arms timer[1], generation 1, debouncing = true
    const deadTimer = h.timers[0];
    deadTimer();                             // A's dead timer fires: must bail WITHOUT touching debouncing
    await h.c.request('progress');          // same burst — must still be swallowed by B's live latch
    h.runTimers();
    await Promise.resolve();
    expect(h.calls).toEqual(['sync']);      // exactly one sync for B's burst
  });

  // Keep-direction: a guard aggressive enough to drop something a LIVE session legitimately owns
  // is worse than the leak it is meant to close.

  it('a normal sync with no reset still installs the conflict and still calls onOutcome', async () => {
    const outcomes: TestOutcome[] = [];
    const h = harness({ onOutcome: (o) => { outcomes.push(o); } });
    h.set(fork());
    await h.c.request('sign-in');
    expect(h.c.conflict()).not.toBeNull();
    expect(outcomes.map((o) => o.kind)).toEqual(['ask']);
  });

  it('a normal answer() still installs a NEW fork raised by the resolve', async () => {
    const h = harness();
    h.set(fork());
    await h.c.request('sign-in');
    const newer = fork();
    (newer as { forks: TestFork[] }).forks[0].serverDoc = { version: 9 };
    h.set(newer);
    await h.c.answer('server');
    expect(h.c.conflict()?.[0]?.serverDoc.version).toBe(9);
  });

  it('a follow-up trigger that arrives mid-sync with no reset still runs', async () => {
    const h = harness();
    h.hold();
    const first = h.c.request('sign-in');
    await Promise.resolve();
    expect(await h.c.request('background')).toBeNull();
    h.runTimers();
    await first;
    await Promise.resolve();
    expect(h.calls).toEqual(['sync', 'sync']);
  });

  it('a trigger from the NEWLY signed-in account, arriving while the previous account’s sync is still parked, is honoured once the lock releases', async () => {
    // `again` has no queue depth, but it DOES carry the generation it was stamped under. A dead
    // run resuming to dispatch it must not throw away a live trigger just because the run carrying
    // it out happens to be the one that is dying — B's bit is B's, not A's, and B is owed a sync.
    const h = harness();
    h.hold();
    const first = h.c.request('sign-in'); // account A's sync — now parked
    await Promise.resolve();
    h.c.reset(); // A signs out; B signs in (the mock's currentUid() stays truthy either way)
    // B's own trigger arrives while A's dead sync still holds the in-flight lock, coalescing into
    // `again` the same way any mid-sync trigger would — but stamped with B's generation.
    expect(await h.c.request('background')).toBeNull();
    h.runTimers(); // release A's parked sync
    await first;
    await Promise.resolve();
    expect(h.calls).toEqual(['sync', 'sync']); // A's dead sync, then B's follow-up
  });

  it('the same trigger, arriving while an answer() to the previous account’s conflict is still parked, is honoured once the lock releases', async () => {
    const h = harness();
    h.set(fork());
    await h.c.request('sign-in'); // account A raises a conflict
    expect(h.c.conflict()).not.toBeNull();
    h.holdResolve();
    const answering = h.c.answer('local'); // A's answer — now parked inside resolve()
    await Promise.resolve();
    h.c.reset(); // A signs out; B signs in
    // B's own trigger arrives while A's answer() still holds the in-flight lock.
    expect(await h.c.request('background')).toBeNull();
    h.runTimers(); // release A's parked resolve
    await answering;
    await Promise.resolve();
    expect(h.calls).toEqual(['sync', 'resolve:g:local', 'sync']); // the seeding sync, A's dead resolve, then B's follow-up
  });
});
