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
});
