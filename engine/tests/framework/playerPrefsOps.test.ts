/** The `player-prefs-read` / `player-prefs-write` agent ops (#288 gap 4).
 *
 *  These are registered in `agentBridge.ts` rather than `agentEditorOps.ts` on purpose
 *  (docs/mcp-tool-conventions.md §9): nothing about PlayerPrefs touches editor chrome,
 *  the undo stack, or the project on disk, so the DEVICE surface gets the same ops —
 *  which is the surface where prefs are a real player's save data.
 *
 *  What is worth asserting here is almost entirely the REFUSALS. The happy paths are
 *  thin wrappers over `PlayerPrefs`, which has its own tests; the interesting behaviour
 *  is the set of shapes the ops decline to produce — an empty key list from a store
 *  nobody read, a silent no-op delete, a `clear` with no acknowledgement, and an ok
 *  verdict on a durable write the backend rejected.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { runAgentOp } from '../../app/debug/agentBridge';
import { PlayerPrefs, InMemoryBackend } from '@modoki/engine/runtime';
import type { PrefsBackend } from '@modoki/engine/runtime';
// The reset seam is a STANDALONE export, deliberately kept off the public `PlayerPrefs`
// object and out of the runtime barrel so it never reaches game-author autocomplete
// (playerPrefs.ts's "Test seam" note). Reached by path here rather than widened into the
// barrel — the same trade `agentToolRegistry.test.ts` and friends already make.
import { resetPlayerPrefsForTest } from '../../packages/modoki/src/runtime/storage/playerPrefs';

afterEach(() => { resetPlayerPrefsForTest(); });

const read = (params?: Record<string, unknown>) =>
  runAgentOp('player-prefs-read', params ?? {}) as Promise<Record<string, unknown>>;
const write = (params: Record<string, unknown>) =>
  runAgentOp('player-prefs-write', params) as Promise<Record<string, unknown>>;

describe('player-prefs ops: an un-hydrated store REFUSES, it does not answer empty', () => {
  // `cache` is filled only by init(). Before that, keys() returns [] for a store that may
  // have plenty on disk — and [] is exactly what a genuinely empty store returns, so the
  // caller cannot tell them apart. §5 ranks that ("could not look" as "nothing is there")
  // as unrecoverable, which is why this is a refusal and not a field beside an empty array.
  it('read refuses with NOT_AVAILABLE_HERE', async () => {
    const r = await read();
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_AVAILABLE_HERE');
    expect(r.keys).toBeUndefined(); // no empty list to misread
    expect(String(r.hint)).toMatch(/NOT "the store is empty"/);
  });

  it('WRITES refuse too — the sharper half', async () => {
    // A set before init() lands in a throwaway in-memory cache under the 'default'
    // namespace, and the next init() CLEARS it. Every signal the caller has says the write
    // succeeded and nothing of it survives — the §0 rank-1 false success.
    const r = await write({ action: 'set', key: 'level', value: 3 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_AVAILABLE_HERE');
    // …and it really did not write.
    expect(PlayerPrefs.has('level')).toBe(false);
  });
});

describe('player-prefs ops against a hydrated store', () => {
  beforeEach(async () => {
    resetPlayerPrefsForTest();
    await PlayerPrefs.init({ namespace: 'unit-test', backend: new InMemoryBackend() });
  });

  it('a bare read returns the key INDEX and names the namespace', async () => {
    await write({ action: 'set', key: 'b', value: 2 });
    await write({ action: 'set', key: 'a', value: 1 });
    const r = await read();
    expect(r.ok).toBe(true);
    // The namespace is on EVERY reply: the same game has separate stores depending on
    // where it runs (the editor hydrates `<gameId>@editor`), so a key list that does not
    // say which store it came from cannot answer "is my save there".
    expect(r.namespace).toBe('unit-test');
    expect(r.keys).toEqual(['a', 'b']); // sorted, so a diff between two reads is stable
    expect(r.totalCount).toBe(2);
    expect(r.value).toBeUndefined(); // summary-first: no values until a key is named
  });

  it('a named key returns its value; an ABSENT key is an answer, not a refusal', async () => {
    await write({ action: 'set', key: 'progress', value: { level: 4, stars: [1, 2] } });
    const hit = await read({ key: 'progress' });
    expect(hit.ok).toBe(true);
    expect(hit.present).toBe(true);
    expect(hit.value).toEqual({ level: 4, stars: [1, 2] });

    const miss = await read({ key: 'progres' });
    expect(miss.ok).toBe(true);      // we looked, and it is not there — that IS the answer
    expect(miss.present).toBe(false);
    expect(miss.keys).toEqual(['progress']); // …and the typo is visible without a second call
  });

  it('`present` is what separates a missing key from one holding JSON null', async () => {
    // Without it both replies carry `value: undefined` after JSON transport, and an agent
    // reading "no value" concludes "no key" for a key that exists and is deliberately null.
    await write({ action: 'set', key: 'optedOut', value: null });
    const stored = await read({ key: 'optedOut' });
    const absent = await read({ key: 'neverSet' });
    expect(stored.present).toBe(true);
    expect(stored.value).toBeNull();
    expect(absent.present).toBe(false);
  });

  it('set reports saved:true only after the durable write was ACCEPTED', async () => {
    const r = await write({ action: 'set', key: 'coins', value: 10 });
    expect(r.ok).toBe(true);
    expect(r.saved).toBe(true);
    expect(PlayerPrefs.hasPendingWrite('coins')).toBe(false);
  });

  it("set with no value is REFUSED — PlayerPrefs reads undefined as a delete", async () => {
    await write({ action: 'set', key: 'keep', value: 1 });
    const r = await write({ action: 'set', key: 'keep' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REFUSED_BY_OP');
    expect(r.options).toContain("action:'delete' to remove the key");
    // The point of the refusal: the key is still there. Passing it through would have
    // deleted it while the caller thought they were writing.
    expect(PlayerPrefs.has('keep')).toBe(true);
  });

  it('delete of an ABSENT key is refused with the real key list, not a silent no-op', async () => {
    await write({ action: 'set', key: 'highScore', value: 99 });
    const r = await write({ action: 'delete', key: 'highscore' }); // wrong case
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_FOUND');
    expect(r.options).toEqual(['highScore']);
    expect(PlayerPrefs.has('highScore')).toBe(true);
  });

  it('delete removes the key', async () => {
    await write({ action: 'set', key: 'gone', value: 1 });
    const r = await write({ action: 'delete', key: 'gone' });
    expect(r.ok).toBe(true);
    expect(PlayerPrefs.has('gone')).toBe(false);
  });

  it('clear WITHOUT confirm refuses, and lists what it would have destroyed', async () => {
    await write({ action: 'set', key: 'a', value: 1 });
    await write({ action: 'set', key: 'b', value: 2 });
    const r = await write({ action: 'clear' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REFUSED_BY_OP'); // NOT REQUIRES_SAVE — no scene work is at stake
    expect(r.keys).toEqual(['a', 'b']);
    // Nothing removed. On the device surface this is a real player's save data.
    expect(PlayerPrefs.keys().sort()).toEqual(['a', 'b']);
  });

  it('clear WITH confirm removes everything in the namespace', async () => {
    await write({ action: 'set', key: 'a', value: 1 });
    const r = await write({ action: 'clear', confirm: true });
    expect(r.ok).toBe(true);
    expect(r.cleared).toBe(1);
    expect(PlayerPrefs.keys()).toEqual([]);
  });

  it('a missing or unknown action is refused and the real ones are listed', async () => {
    // §1: a tool whose params are all optional and whose {} has a destructive reading is a
    // hazard by construction. `action` is required at the op as well as in the zod schema,
    // so the curl surface cannot reach a default either.
    for (const bad of [{}, { action: 'wipe' }]) {
      const r = await write(bad);
      expect(r.ok).toBe(false);
      expect(r.options).toEqual(['set', 'delete', 'clear', 'flush']);
    }
  });
});

describe('a durable write the backend REJECTED is never reported as success', () => {
  /** A backend that accepts hydration and then fails every write — the quota-exceeded /
   *  native-I/O-error case. `drain()` catches it, re-queues the key into `dirty`, and
   *  settles fulfilled so later writes are not poisoned; meanwhile `cache` keeps the value,
   *  so `get()` returns it happily. Every ordinary signal says the write worked. */
  class RejectingBackend implements PrefsBackend {
    async getAll(): Promise<Record<string, string>> { return {}; }
    async set(): Promise<void> { throw new Error('QuotaExceededError'); }
    async remove(): Promise<void> { throw new Error('QuotaExceededError'); }
  }

  beforeEach(async () => {
    resetPlayerPrefsForTest();
    await PlayerPrefs.init({ namespace: 'unit-reject', backend: new RejectingBackend() });
  });

  it('set reports PARTIAL, not ok — a read-back cannot see this failure', async () => {
    const r = await write({ action: 'set', key: 'coins', value: 10 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PARTIAL');
    expect(r.saved).toBe(false);
    // The trap this guards: the value IS readable. A verification that only re-read it
    // would confirm a write that will not survive a restart — the shape that let a
    // purchase ledger finish a transaction whose record was about to vanish (#196).
    expect((await read({ key: 'coins' })).value).toBe(10);
  });

  it('flush reports the keys the backend re-queued instead of a clean ok', async () => {
    await write({ action: 'set', key: 'x', value: 1 });
    const r = await write({ action: 'flush' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PARTIAL');
    expect(r.pendingWrites).toEqual(['x']);
  });

  it('pendingWrites comes back SORTED even when keys were dirtied out of alphabetical order', async () => {
    // The fixture above always dirties keys already in alphabetical order, so a naive read
    // of the test suite cannot tell the `.sort()` in the flush branch apart from `pendingKeys()`
    // coincidentally returning insertion order. Dirty 'gems' before 'coins' — z-before-a — and
    // the RejectingBackend's `set` keeps both pending through the flush this op performs.
    await write({ action: 'set', key: 'gems', value: 1 });
    await write({ action: 'set', key: 'coins', value: 2 });
    const r = await write({ action: 'flush' });
    expect(r.ok).toBe(false);
    expect(r.pendingWrites).toEqual(['coins', 'gems']); // sorted, not insertion order
  });
});

describe('player-prefs-write delete: dirty-and-absent-from-cache is not proof of a rejection', () => {
  // The op's own reasoning was previously "absent from cache + dirty === a rejected delete,
  // already applied". That is one true cause of the signature, but NOT the only one — an
  // ordinary debounced delete (still inside `del()`'s 150ms window, nothing sent to the
  // backend at all) looks identical from the op's point of view. This describe uses an
  // ACCEPTING backend to prove the honest branch: flushing settles which one it was, and here
  // it turns out to be "merely debounced", so the flush completes the removal.
  beforeEach(async () => {
    resetPlayerPrefsForTest();
    await PlayerPrefs.init({ namespace: 'unit-debounced-del', backend: new InMemoryBackend() });
  });

  it('a debounced (never-attempted) delete reports ok:true, alreadyRemoved:true — not a rejection', async () => {
    // Call PlayerPrefs directly, NOT through the op, so both writes stay debounced (no flush
    // in between) — this is exactly what a GAME does when it calls `PlayerPrefs.delete()`
    // itself, the scenario the brief calls out.
    PlayerPrefs.set('k', 1);
    PlayerPrefs.delete('k');
    expect(PlayerPrefs.has('k')).toBe(false);       // cache already reflects the delete
    expect(PlayerPrefs.hasPendingWrite('k')).toBe(true); // but nothing has reached the backend

    const r = await write({ action: 'delete', key: 'k' });
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(true);
    expect(r.saved).toBe(true);
    expect(r.alreadyRemoved).toBe(true); // this call did the flush, not the original cache removal
    expect(PlayerPrefs.hasPendingWrite('k')).toBe(false); // and it is now genuinely durable
  });
});

describe('a rejected DELETE is invisible to a cache-derived pending list (#422)', () => {
  /** `RejectingBackend` above returns `{}` from `getAll()`, so the cache hydrates empty and
   *  a `delete` short-circuits on the op's NOT_FOUND guard before ever reaching the bug —
   *  it never sees the key it would delete. This variant seeds ONE hydrated entry so the
   *  delete path actually runs, and both `set`/`remove` still reject to simulate the
   *  quota/native-I/O case. The key carries the full `mk:<namespace>:` prefix + envelope,
   *  matching what `PlayerPrefs.init()` reads off a real backend. */
  //  Seeds TWO keys — 'coins' and 'gems' — so the clear test (#422 finding 3) can distinguish a
  //  key the clear itself enumerated from one that was already pending-deleted beforehand.
  class SeededRejectingBackend implements PrefsBackend {
    async getAll(): Promise<Record<string, string>> {
      return {
        'mk:unit-reject-del:coins': JSON.stringify({ v: 1, d: 10 }),
        'mk:unit-reject-del:gems': JSON.stringify({ v: 1, d: 5 }),
      };
    }
    async set(): Promise<void> { throw new Error('QuotaExceededError'); }
    async remove(): Promise<void> { throw new Error('QuotaExceededError'); }
  }

  beforeEach(async () => {
    resetPlayerPrefsForTest();
    await PlayerPrefs.init({ namespace: 'unit-reject-del', backend: new SeededRejectingBackend() });
  });

  it('delete reports PARTIAL, not ok — the old code returned {ok:true, deleted:true, saved:true}', async () => {
    const r = await write({ action: 'delete', key: 'coins' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PARTIAL');
    expect(r.deleted).toBe(true); // the cache removal DID happen
    expect(r.saved).toBe(false);  // the durable remove did not
  });

  it('a follow-up flush after the rejected delete reports PARTIAL with the key pending — the headline regression', async () => {
    await write({ action: 'delete', key: 'coins' });
    const r = await write({ action: 'flush' });
    // Before the fix this reported {ok: true, pendingWrites: []} — `keys().filter(hasPendingWrite)`
    // could never see 'coins', because delete() had already dropped it from `cache`/`keys()`.
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PARTIAL');
    expect(r.pendingWrites).toContain('coins');
  });

  it('a bare read after the rejected delete surfaces the pending key even though `keys` does not have it', async () => {
    await write({ action: 'delete', key: 'coins' });
    const r = await read();
    expect(r.keys).not.toContain('coins'); // gone from the cache-derived view
    expect(r.pendingWrites).toContain('coins'); // but still pending — the authoritative view
  });

  it('clear on a rejecting backend reports PARTIAL with pendingWrites non-empty', async () => {
    const r = await write({ action: 'clear', confirm: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PARTIAL');
    expect((r.pendingWrites as string[]).length).toBeGreaterThan(0);
  });

  it('the delete PARTIAL carries a hint — it was the only one of the three PARTIAL shapes without one (#422 finding 2)', async () => {
    const r = await write({ action: 'delete', key: 'coins' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PARTIAL');
    expect(typeof r.hint).toBe('string');
    expect(String(r.hint)).toMatch(/flush/);
  });

  it("read({key}) after a rejected delete reports present:false AND pendingWrite:true (#422 finding 1)", async () => {
    await write({ action: 'delete', key: 'coins' });
    const r = await read({ key: 'coins' });
    // `ok:true, present:false` ALONE was #422's own failure shape on this branch — a rejected
    // delete leaving a key still on disk reported as durably gone.
    expect(r.ok).toBe(true);
    expect(r.present).toBe(false);
    expect(r.pendingWrite).toBe(true);
  });

  it('a second delete of an already-rejected-delete key reports PARTIAL, not NOT_FOUND, with a hint (#422 finding 2)', async () => {
    await write({ action: 'delete', key: 'coins' }); // first delete: rejected, key now dirty + absent from cache
    const r = await write({ action: 'delete', key: 'coins' }); // the retry the PARTIAL invites
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PARTIAL'); // NOT NOT_FOUND — the key is neither mistyped nor gone
    expect(r.deleted).toBe(true);
    expect(r.saved).toBe(false);
    expect(typeof r.hint).toBe('string');
    expect(String(r.hint)).toMatch(/flush/);
  });

  it("clear reports a consistent count when one key was ALREADY pending-deleted before the clear ran (#422 finding 3)", async () => {
    // 'coins' is deleted (and rejected) BEFORE the clear — it is out of the cache and dirty
    // going in, so the clear itself never enumerates it. Only 'gems' remains in the cache for
    // the clear to actually act on.
    await write({ action: 'delete', key: 'coins' });
    const r = await write({ action: 'clear', confirm: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PARTIAL');
    // The clear enumerated exactly ['gems'] — 'coins' was already gone from the cache.
    expect(r.cleared).toBe(1);
    expect(r.keys).toEqual(['gems']);
    // The honest full pending set still names both keys...
    expect(r.pendingWrites).toEqual(['coins', 'gems']);
    // ...but the count/sentence attributed to THIS clear is 1 of 1 (gems), not "2 of 1".
    expect(String(r.error)).toMatch(/for 1 of them: gems/);
    expect(String(r.error)).not.toMatch(/2 of them/);
    // 'coins' is named as pending from BEFORE this clear, not as one this clear caused.
    expect(String(r.error)).toMatch(/coins.*already pending before this clear ran/);
  });
});

describe('clear: the "accepted for all" message is honest when the backend actually rejects one', () => {
  /** Rejects `remove` for exactly one key ('coins') and accepts every other write — the
   *  mixed case the review reproduced: `failed.length === 0` must never fire beside a
   *  non-empty `pendingWrites`, and the counts in the message must stay mutually consistent
   *  with `cleared`/`keys`/`pendingWrites`. */
  class SelectivelyRejectingBackend implements PrefsBackend {
    async getAll(): Promise<Record<string, string>> {
      return {
        'mk:unit-mixed:coins': JSON.stringify({ v: 1, d: 10 }),
        'mk:unit-mixed:gems': JSON.stringify({ v: 1, d: 5 }),
      };
    }
    async set(): Promise<void> { /* accepted */ }
    async remove(key: string): Promise<void> {
      if (key.endsWith(':coins')) throw new Error('QuotaExceededError');
    }
  }

  beforeEach(async () => {
    resetPlayerPrefsForTest();
    await PlayerPrefs.init({ namespace: 'unit-mixed', backend: new SelectivelyRejectingBackend() });
  });

  it('reports PARTIAL naming only the rejected key, never claiming a clean accept', async () => {
    const r = await write({ action: 'clear', confirm: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PARTIAL');
    expect(r.cleared).toBe(2); // both keys were enumerated by this clear
    expect(r.pendingWrites).toEqual(['coins']); // only the rejected one is still dirty
    // The message must not say "accepted for all of them" while pendingWrites is non-empty.
    expect(String(r.error)).not.toMatch(/accepted the durable remove for all of them/);
    expect(String(r.error)).not.toMatch(/every key this clear enumerated was durably removed/);
    // It must name the one that failed, consistent with pendingWrites.
    expect(String(r.error)).toMatch(/for 1 of them: coins/);
  });
});

describe('clear: pendingWrites is sorted even when the dirty order is not alphabetical', () => {
  class ReverseRejectingBackend implements PrefsBackend {
    async getAll(): Promise<Record<string, string>> {
      return {
        'mk:unit-clear-sort:zeta': JSON.stringify({ v: 1, d: 1 }),
        'mk:unit-clear-sort:alpha': JSON.stringify({ v: 1, d: 2 }),
      };
    }
    async set(): Promise<void> { /* accepted */ }
    async remove(): Promise<void> { throw new Error('QuotaExceededError'); } // reject everything
  }

  it('clear reports pendingWrites SORTED, not in the zeta-then-alpha dirty order', async () => {
    resetPlayerPrefsForTest();
    // getAll()'s own key order is zeta, then alpha — the opposite of alphabetical — so
    // pendingKeys() drains in that same non-alphabetical order unless the op sorts it.
    await PlayerPrefs.init({ namespace: 'unit-clear-sort', backend: new ReverseRejectingBackend() });
    const r = await write({ action: 'clear', confirm: true });
    expect(r.ok).toBe(false);
    expect(r.pendingWrites).toEqual(['alpha', 'zeta']); // sorted, not insertion/dirty order
  });
});
