/**
 * The cloud-sync group protocol (#532) — `decideGroup`'s four-case table, the per-group runner's
 * attempt loop and its persistence gate, `resolveGroupFork`, and the aggregate `runCloudSync` over a
 * heterogeneous set. No storage, no network — fakes only, so the genuinely hard part (conflict
 * resolution) is deterministic. Modelled on `games/court/tests/cloudSaveAdapter.test.ts`'s
 * `fakeServer()`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  decideGroup, hasLocalWrites, scopeMarksToAccount, emptyMarks, neverSynced,
  defineSyncGroup, runGroupSync, runCloudSync, resolveGroupFork,
  type AnySyncGroup, type CloudGroup, type ForkPolicy, type GroupMarks, type GroupStore,
  type GroupTransport, type LocalGroup,
} from '../../src/runtime/sync';

// ── Fakes ──────────────────────────────────────────────────────────────────────

interface Content { value: string }

/** Builds a `GroupStore` + a matching `durable()` probe sharing one flag, since `GroupAtomicity` and
 *  `GroupStore` are declared separately but a real implementation ties them to the same backend. */
function makeStore(initial: LocalGroup<Content>) {
  let state: LocalGroup<Content> = initial;
  let durableFlag = true;
  const writes: LocalGroup<Content>[] = [];
  const store: GroupStore<Content> = {
    read: () => state,
    write: (next) => { state = next; writes.push(next); },
    flush: async () => {},
  };
  return {
    store,
    writes,
    durable: () => durableFlag,
    setDurable: (v: boolean) => { durableFlag = v; },
    get state() { return state; },
  };
}

function fingerprint(content: Content): string {
  return content.value;
}

function group(overrides: Partial<Parameters<typeof defineSyncGroup<Content>>[0]> & {
  store: GroupStore<Content>;
  atomicity?: ReturnType<typeof singleKey> | ReturnType<typeof multiKey>;
} & { onFork?: ForkPolicy }): AnySyncGroup {
  return defineSyncGroup<Content>({
    id: 'g',
    fingerprint,
    isFreshAndEmpty: (c) => c.value === '',
    merge: (local, _server, choice) => (choice === 'local' ? local.content : (_server.content as Content)),
    adopt: (_local, server) => ({ content: server.content as Content, upload: false }),
    onFork: 'ask',
    atomicity: singleKey(),
    ...overrides,
  });
}

function singleKey() {
  return { kind: 'single-key' as const };
}
function multiKey(durable: () => boolean) {
  return { kind: 'multi-key' as const, durable };
}

function marks(over: Partial<GroupMarks> = {}): GroupMarks {
  return { ...emptyMarks(), ...over };
}

/** A transport enforcing the SAME compare-and-swap the real Firestore rules do, per
 *  `cloudSaveAdapter.test.ts`'s `fakeServer()`. */
function fakeTransport(initial: Record<string, CloudGroup<unknown> | null> = {}) {
  const docs = new Map<string, CloudGroup<unknown> | null>(Object.entries(initial));
  const pushes: { groupId: string; doc: CloudGroup<unknown> }[] = [];
  const transport: GroupTransport = {
    load: async (id) => docs.get(id) ?? null,
    push: async (id, doc) => {
      pushes.push({ groupId: id, doc });
      const current = docs.get(id) ?? null;
      if (doc.version !== (current?.version ?? 0) + 1) return 'conflict';
      docs.set(id, doc);
      return 'ok';
    },
  };
  return {
    transport,
    pushes,
    get(id: string) { return docs.get(id) ?? null; },
    set(id: string, doc: CloudGroup<unknown> | null) { docs.set(id, doc); },
  };
}

const OPTS = { uid: 'u1', now: 1000 };

// ── decideGroup — the four cases ────────────────────────────────────────────────

describe('decideGroup', () => {
  const g = group({ store: makeStore({ content: { value: 'a' }, version: 1, updatedAt: 0, marks: marks() }).store });

  it('no server document -> create at version 1', () => {
    const local: LocalGroup<Content> = { content: { value: 'a' }, version: 0, updatedAt: 0, marks: marks() };
    expect(decideGroup(g, local as never, null)).toEqual({ action: 'create', version: 1 });
  });

  it('server === synced, clean -> none', () => {
    const local: LocalGroup<Content> = {
      content: { value: 'a' }, version: 5, updatedAt: 0,
      marks: marks({ lastSyncedVersion: 5, lastSyncedFingerprint: 'a' }),
    };
    const server: CloudGroup<Content> = { content: { value: 'a' }, version: 5, updatedAt: 0 };
    expect(decideGroup(g, local as never, server as never)).toEqual({ action: 'none' });
  });

  it('server === synced, dirty -> upload at server.version + 1', () => {
    const local: LocalGroup<Content> = {
      content: { value: 'b' }, version: 5, updatedAt: 0,
      marks: marks({ lastSyncedVersion: 5, lastSyncedFingerprint: 'a' }),
    };
    const server: CloudGroup<Content> = { content: { value: 'a' }, version: 5, updatedAt: 0 };
    expect(decideGroup(g, local as never, server as never)).toEqual({ action: 'upload', version: 6 });
  });

  it('server > synced, clean -> take-server', () => {
    const local: LocalGroup<Content> = {
      content: { value: 'a' }, version: 5, updatedAt: 0,
      marks: marks({ lastSyncedVersion: 5, lastSyncedFingerprint: 'a' }),
    };
    const server: CloudGroup<Content> = { content: { value: 'z' }, version: 9, updatedAt: 0 };
    expect(decideGroup(g, local as never, server as never)).toEqual({ action: 'take-server' });
  });

  it('server > synced, dirty -> fork', () => {
    const local: LocalGroup<Content> = {
      content: { value: 'b' }, version: 5, updatedAt: 0,
      marks: marks({ lastSyncedVersion: 5, lastSyncedFingerprint: 'a' }),
    };
    const server: CloudGroup<Content> = { content: { value: 'z' }, version: 9, updatedAt: 0 };
    expect(decideGroup(g, local as never, server as never)).toEqual({ action: 'fork' });
  });

  it('server < synced (rolled back / reset) -> re-upload at server.version + 1, not a fork', () => {
    const local: LocalGroup<Content> = {
      content: { value: 'b' }, version: 9, updatedAt: 0,
      marks: marks({ lastSyncedVersion: 9, lastSyncedFingerprint: 'b' }),
    };
    const server: CloudGroup<Content> = { content: { value: 'reset' }, version: 2, updatedAt: 0 };
    expect(decideGroup(g, local as never, server as never)).toEqual({ action: 'upload', version: 3 });
  });
});

// ── hasLocalWrites ───────────────────────────────────────────────────────────────

describe('hasLocalWrites', () => {
  const g = group({ store: makeStore({ content: { value: '' }, version: 0, updatedAt: 0, marks: marks() }).store });

  it('fresh install, never synced, empty content -> clean', () => {
    const local: LocalGroup<Content> = { content: { value: '' }, version: 0, updatedAt: 0, marks: emptyMarks() };
    expect(neverSynced(local.marks)).toBe(true);
    expect(hasLocalWrites(g, local as never)).toBe(false);
  });

  it('never synced but NOT empty -> dirty', () => {
    const local: LocalGroup<Content> = { content: { value: 'real progress' }, version: 0, updatedAt: 0, marks: emptyMarks() };
    expect(hasLocalWrites(g, local as never)).toBe(true);
  });
});

// ── scopeMarksToAccount ───────────────────────────────────────────────────────────

describe('scopeMarksToAccount', () => {
  it('same uid passes through unchanged', () => {
    const m = marks({ uid: 'u1', lastSyncedVersion: 7, lastSyncedFingerprint: 'x', lastSyncedAt: 500 });
    expect(scopeMarksToAccount(m, 'u1', 'x')).toEqual(m);
  });

  it('different uid zeroes the versions and clears the fingerprint by default', () => {
    const m = marks({ uid: 'A', lastSyncedVersion: 7, lastSyncedFingerprint: 'x', lastSyncedAt: 500 });
    const scoped = scopeMarksToAccount(m, 'B', 'not-x');
    expect(scoped).toEqual({ lastSyncedVersion: 0, lastSyncedFingerprint: '', lastSyncedAt: 0, uid: 'B' });
  });

  it('different uid but current fingerprint matches the previous mark -> keeps the fingerprint (already safe elsewhere), still zeroes versions', () => {
    const m = marks({ uid: 'A', lastSyncedVersion: 7, lastSyncedFingerprint: 'same', lastSyncedAt: 500 });
    const scoped = scopeMarksToAccount(m, 'B', 'same');
    expect(scoped).toEqual({ lastSyncedVersion: 0, lastSyncedFingerprint: 'same', lastSyncedAt: 0, uid: 'B' });
  });
});

// ── runGroupSync ─────────────────────────────────────────────────────────────────

describe('runGroupSync', () => {
  it('idle when in sync', async () => {
    const s = makeStore({
      content: { value: 'a' }, version: 3, updatedAt: 0,
      marks: marks({ uid: 'u1', lastSyncedVersion: 3, lastSyncedFingerprint: 'a' }),
    });
    const g = group({ store: s.store });
    const t = fakeTransport({ g: { content: { value: 'a' }, version: 3, updatedAt: 0 } });
    const outcome = await runGroupSync(g, t.transport, OPTS);
    expect(outcome).toEqual({ kind: 'idle' });
  });

  it('create: no server doc, local dirty -> uploads at version 1', async () => {
    const s = makeStore({ content: { value: 'first save' }, version: 0, updatedAt: 5, marks: emptyMarks() });
    const g = group({ store: s.store });
    const t = fakeTransport();
    const outcome = await runGroupSync(g, t.transport, OPTS);
    expect(outcome).toEqual({ kind: 'uploaded', version: 1 });
    expect(t.get('g')).toEqual({ content: { value: 'first save' }, version: 1, updatedAt: 5 });
    expect(s.state.marks.lastSyncedVersion).toBe(1);
    expect(s.state.marks.lastSyncedFingerprint).toBe('first save');
    expect(s.state.marks.lastSyncedAt).toBe(OPTS.now);
  });

  it('take-server adopts silently when adopt() owes no upload', async () => {
    const s = makeStore({
      content: { value: 'old' }, version: 3, updatedAt: 0,
      marks: marks({ uid: 'u1', lastSyncedVersion: 3, lastSyncedFingerprint: 'old' }),
    });
    const g = group({
      store: s.store,
      adopt: (_local, server) => ({ content: server.content as Content, upload: false }),
    });
    const t = fakeTransport({ g: { content: { value: 'new-from-server' }, version: 9, updatedAt: 0 } });
    const outcome = await runGroupSync(g, t.transport, OPTS);
    expect(outcome).toEqual({ kind: 'adopted', version: 9 });
    expect(s.state.content).toEqual({ value: 'new-from-server' });
    expect(s.state.marks.lastSyncedVersion).toBe(9);
    expect(t.pushes.length).toBe(0);
  });

  it('take-server whose adopt() owes an upload falls through and uploads, with replacedLocal set', async () => {
    const s = makeStore({
      content: { value: 'old' }, version: 3, updatedAt: 7,
      marks: marks({ uid: 'u1', lastSyncedVersion: 3, lastSyncedFingerprint: 'old' }),
    });
    const g = group({
      store: s.store,
      adopt: (_local, server) => ({ content: { value: `${(server.content as Content).value}+local` }, upload: true }),
    });
    const t = fakeTransport({ g: { content: { value: 'server' }, version: 9, updatedAt: 0 } });
    const outcome = await runGroupSync(g, t.transport, OPTS);
    expect(outcome).toEqual({ kind: 'uploaded', version: 10, replacedLocal: true });
    expect(t.get('g')).toEqual({ content: { value: 'server+local' }, version: 10, updatedAt: 7 });
    expect(s.state.marks.lastSyncedVersion).toBe(10);
  });

  it('a CAS conflict re-reads and re-decides -> fork, NOT a blind re-push (exactly one push attempt)', async () => {
    // Local is dirty relative to server-at-synced (upload is the first decision)...
    const s = makeStore({
      content: { value: 'mine-edited' }, version: 5, updatedAt: 0,
      marks: marks({ uid: 'u1', lastSyncedVersion: 5, lastSyncedFingerprint: 'mine' }),
    });
    const g = group({ store: s.store });
    let doc: CloudGroup<unknown> = { content: { value: 'server-doc' }, version: 5, updatedAt: 0 };
    let pushCount = 0;
    // Race: another device commits v6 to the server in the gap between our load and our push, and
    // the push reports the CAS rejection.
    const racy: GroupTransport = {
      load: async () => doc,
      push: async () => {
        pushCount += 1;
        doc = { content: { value: 'winner' }, version: 6, updatedAt: 0 };
        return 'conflict';
      },
    };
    const outcome = await runGroupSync(g, racy, OPTS);
    expect(outcome).toEqual({
      kind: 'fork',
      local: expect.objectContaining({ content: { value: 'mine-edited' } }),
      server: { content: { value: 'winner' }, version: 6, updatedAt: 0 },
    });
    expect(pushCount).toBe(1);
  });

  it('gives up after maxAttempts conflicting attempts rather than spinning', async () => {
    // Modelled on `saveSync.test.ts`'s equivalent case: the server document never actually moves
    // (a rejected write and a misconfigured security rule look identical to the transport), so every
    // pass re-decides the SAME 'upload' and every push is rejected.
    const s = makeStore({
      content: { value: 'mine' }, version: 2, updatedAt: 0,
      marks: marks({ uid: 'u1', lastSyncedVersion: 2, lastSyncedFingerprint: 'stale' }),
    });
    const g = group({ store: s.store });
    const t: GroupTransport = {
      load: async () => ({ content: { value: 'server' }, version: 2, updatedAt: 0 }),
      push: async () => 'conflict',
    };
    const outcome = await runGroupSync(g, t, { ...OPTS, maxAttempts: 3 });
    expect(outcome).toEqual({ kind: 'failed', reason: 'gave up after 3 conflicting attempts' });
  });

  it("onFork: 'ask' writes nothing at all", async () => {
    const s = makeStore({
      content: { value: 'mine' }, version: 5, updatedAt: 0,
      marks: marks({ uid: 'u1', lastSyncedVersion: 5, lastSyncedFingerprint: 'mine-old' }),
    });
    const g = group({ store: s.store, onFork: 'ask' });
    const t = fakeTransport({ g: { content: { value: 'theirs' }, version: 9, updatedAt: 0 } });
    const outcome = await runGroupSync(g, t.transport, OPTS);
    expect(outcome.kind).toBe('fork');
    expect(s.writes.length).toBe(0);
    expect(t.pushes.length).toBe(0);
  });

  it("onFork: 'take-server' adopts silently on a fork", async () => {
    const s = makeStore({
      content: { value: 'mine' }, version: 5, updatedAt: 0,
      marks: marks({ uid: 'u1', lastSyncedVersion: 5, lastSyncedFingerprint: 'mine-old' }),
    });
    const g = group({
      store: s.store, onFork: 'take-server',
      adopt: (_local, server) => ({ content: server.content as Content, upload: false }),
    });
    const t = fakeTransport({ g: { content: { value: 'theirs' }, version: 9, updatedAt: 0 } });
    const outcome = await runGroupSync(g, t.transport, OPTS);
    expect(outcome).toEqual({ kind: 'adopted', version: 9 });
    expect(s.state.content).toEqual({ value: 'theirs' });
  });

  // ⚠️ The guard for the ONE thing that distinguishes a policy-resolved fork from a silent adopt.
  // `adopt` fires only when there is nothing local to preserve, so it is allowed to union nothing;
  // a fork is by definition the case where both sides moved, so resolving one through `adopt`
  // silently discards whatever the group unions only on the fork path (Court: a completed daily
  // whose date has passed, a spend record that must follow its receipt). This group's `merge`
  // unions and its `adopt` does not — exactly Court's asymmetry — so routing the fork back through
  // `adopt` makes the assertion below fail instead of passing quietly.
  it("onFork: 'take-server' resolves a fork through merge, NOT through adopt", async () => {
    const s = makeStore({
      content: { value: 'mine' }, version: 5, updatedAt: 0,
      marks: marks({ uid: 'u1', lastSyncedVersion: 5, lastSyncedFingerprint: 'mine-old' }),
    });
    const g = group({
      store: s.store, onFork: 'take-server',
      // The fork hook keeps the loser's contribution; the silent hook throws it away.
      merge: (local, server) => ({ value: `${(server.content as Content).value}+${local.content.value}` }),
      adopt: (_local, server) => ({ content: server.content as Content, upload: false }),
    });
    const t = fakeTransport({ g: { content: { value: 'theirs' }, version: 9, updatedAt: 0 } });
    const outcome = await runGroupSync(g, t.transport, OPTS);
    expect(s.state.content).toEqual({ value: 'theirs+mine' });
    // The merge holds something the server has not seen, so it owes an upload at server.version + 1.
    expect(outcome).toEqual({ kind: 'uploaded', version: 10 });
    expect(t.pushes.length).toBe(1);
  });

  it("onFork: 'take-newer' picks the server when it is newer", async () => {
    const s = makeStore({
      content: { value: 'mine' }, version: 5, updatedAt: 100,
      marks: marks({ uid: 'u1', lastSyncedVersion: 5, lastSyncedFingerprint: 'mine-old' }),
    });
    const g = group({
      store: s.store, onFork: 'take-newer',
      adopt: (_local, server) => ({ content: server.content as Content, upload: false }),
    });
    const t = fakeTransport({ g: { content: { value: 'theirs' }, version: 9, updatedAt: 200 } });
    const outcome = await runGroupSync(g, t.transport, OPTS);
    expect(outcome).toEqual({ kind: 'adopted', version: 9 });
  });

  it("onFork: 'take-newer' picks local when it is newer, uploading over the server", async () => {
    const s = makeStore({
      content: { value: 'mine' }, version: 5, updatedAt: 300,
      marks: marks({ uid: 'u1', lastSyncedVersion: 5, lastSyncedFingerprint: 'mine-old' }),
    });
    const g = group({ store: s.store, onFork: 'take-newer' });
    const t = fakeTransport({ g: { content: { value: 'theirs' }, version: 9, updatedAt: 200 } });
    const outcome = await runGroupSync(g, t.transport, OPTS);
    expect(outcome).toEqual({ kind: 'uploaded', version: 10 });
    expect(t.get('g')).toEqual({ content: { value: 'mine' }, version: 10, updatedAt: 300 });
  });

  it('a single-key group performs exactly ONE write per persist', async () => {
    const s = makeStore({ content: { value: 'a' }, version: 0, updatedAt: 0, marks: emptyMarks() });
    const g = group({ store: s.store, atomicity: singleKey() });
    const t = fakeTransport();
    await runGroupSync(g, t.transport, OPTS);
    expect(s.writes.length).toBe(1);
  });

  // ── A game write landing DURING the push's round trip ────────────────────────────────────
  //
  // The await that a real write actually races. Each case injects the write from inside
  // `transport.push`, which is where a two-second mobile round trip puts it.
  describe('a local write landing during the push round trip', () => {
    it('a plain upload leaves it alone and self-heals — that is why it is not gated', async () => {
      const s = makeStore({
        content: { value: 'mine' }, version: 4, updatedAt: 0,
        marks: marks({ uid: 'u1', lastSyncedVersion: 4, lastSyncedFingerprint: 'synced' }),
      });
      const g = group({ store: s.store });
      const t = fakeTransport({ g: { content: { value: 'synced' }, version: 4, updatedAt: 0 } });
      const racing: GroupTransport = {
        load: t.transport.load,
        push: async (id, doc) => {
          s.store.write({ ...s.state, content: { value: 'mine+raced' } });
          return t.transport.push(id, doc);
        },
      };

      const outcome = await runGroupSync(g, racing, OPTS);

      expect(outcome).toEqual({ kind: 'uploaded', version: 5 });
      expect(s.state.content).toEqual({ value: 'mine+raced' });        // survived
      expect(s.state.marks.lastSyncedFingerprint).toBe('mine');        // ...and reads DIRTY
    });

    it('⚠️ an adopt-then-upload does NOT write over it — it re-decides instead', async () => {
      // The half `persistMarks` alone does not reach. This arm genuinely owes a content write, so
      // it cannot simply skip it — and applying it would overwrite the raced write AND stamp marks
      // matching the overwriting content, leaving the device clean with the write gone for good.
      // The answer is to discard the outcome and re-decide: the push stands, and the device is now
      // dirty against a server it has seen move, which is a fork.
      const s = makeStore({
        content: { value: 'mine' }, version: 4, updatedAt: 0,
        marks: marks({ uid: 'u1', lastSyncedVersion: 4, lastSyncedFingerprint: 'mine' }),
      });
      const g = group({
        store: s.store,
        // The device holds something the server lacks, so the adopt owes an upload.
        adopt: (_local, server) => ({ content: { value: `${(server.content as Content).value}+ent` }, upload: true }),
      });
      const t = fakeTransport({ g: { content: { value: 'theirs' }, version: 9, updatedAt: 0 } });
      let raced = false;
      const racing: GroupTransport = {
        load: t.transport.load,
        push: async (id, doc) => {
          if (!raced) { raced = true; s.store.write({ ...s.state, content: { value: 'mine+solve' } }); }
          return t.transport.push(id, doc);
        },
      };

      const outcome = await runGroupSync(g, racing, OPTS);

      expect(s.state.content).toEqual({ value: 'mine+solve' }); // the raced write is STILL THERE
      expect(outcome.kind).toBe('fork');                        // ...and the player gets asked
      expect(s.state.marks.lastSyncedVersion).toBe(4);          // no clean claim over lost content
    });

    it('⚠️ …but NOT on a fresh install, where re-deciding is the account-wiping dialog', async () => {
      // The exclusion `localMovedUnderUs` carries, reached through the one path that used to defeat
      // it: after an adopt, `local`'s marks describe the SERVER, so deriving "established" from
      // them would read a fresh install as an established lineage. Losing the single raced write
      // here is strictly the lesser evil against offering to push a near-empty save over a real
      // account.
      const s = makeStore({ content: { value: '' }, version: 0, updatedAt: 0, marks: emptyMarks() });
      const g = group({
        store: s.store,
        adopt: (_local, server) => ({ content: { value: `${(server.content as Content).value}+ent` }, upload: true }),
      });
      const t = fakeTransport({ g: { content: { value: 'theirs' }, version: 9, updatedAt: 0 } });
      let raced = false;
      const racing: GroupTransport = {
        load: t.transport.load,
        push: async (id, doc) => {
          if (!raced) { raced = true; s.store.write({ ...s.state, content: { value: 'solve' } }); }
          return t.transport.push(id, doc);
        },
      };

      const outcome = await runGroupSync(g, racing, OPTS);

      expect(outcome).toEqual({ kind: 'uploaded', version: 10, replacedLocal: true });
      expect(s.state.content).toEqual({ value: 'theirs+ent' }); // the adopt applied; no dialog
    });
  });

  describe('multi-key durability gate', () => {
    // ⚠️ Driven through an ADOPT, not an upload, and that is the gate's actual scope. A plain
    // upload writes no content at all — the device already holds what it is pushing — so it takes
    // `persistMarks` and has nothing to gate; see the case below this describe. The two-phase dance
    // exists for the paths where content genuinely arrives from elsewhere.
    it('durable -> two writes, marks advance', async () => {
      const s = makeStore({
        content: { value: 'a' }, version: 0, updatedAt: 0,
        marks: marks({ uid: 'u1', lastSyncedVersion: 1, lastSyncedFingerprint: 'a' }),
      });
      const g = group({
        store: s.store, atomicity: multiKey(s.durable),
        adopt: (_local, server) => ({ content: server.content as Content, upload: false }),
      });
      const t = fakeTransport({ g: { content: { value: 'b' }, version: 4, updatedAt: 0 } });
      const outcome = await runGroupSync(g, t.transport, OPTS);
      expect(outcome).toEqual({ kind: 'adopted', version: 4 });
      expect(s.writes.length).toBe(2);
      expect(s.writes[0].content).toEqual({ value: 'b' });      // content lands...
      expect(s.writes[0].marks.lastSyncedVersion).toBe(1);      // ...with the marks NOT advanced
      expect(s.writes[1].marks.lastSyncedVersion).toBe(4);      // then marks advance
    });

    it('a plain upload takes the marks-only path — no content write, so nothing to gate', async () => {
      // The device is pushing what it already holds. Writing that content back could only destroy a
      // game write that landed during the round trip, so `persistMarks` reads the store through
      // instead; with no content write there is no durability question to ask, and a `durable()`
      // stuck at false must NOT turn a perfectly good upload into a failure.
      const s = makeStore({ content: { value: 'a' }, version: 0, updatedAt: 0, marks: emptyMarks() });
      s.setDurable(false);
      const g = group({ store: s.store, atomicity: multiKey(s.durable) });
      const t = fakeTransport();
      const outcome = await runGroupSync(g, t.transport, OPTS);
      expect(outcome).toEqual({ kind: 'uploaded', version: 1 });
      expect(s.writes.length).toBe(1);
      expect(s.writes[0].content).toEqual({ value: 'a' });
      expect(s.writes[0].marks.lastSyncedVersion).toBe(1);
    });

    it('not durable -> content write happened, marks did NOT advance, outcome failed, and a follow-up sync self-heals by re-fetching', async () => {
      const s = makeStore({ content: { value: 'a' }, version: 0, updatedAt: 0, marks: emptyMarks() });
      s.setDurable(false);
      // 'take-server' (rather than the default 'ask') so the self-heal on the follow-up pass is
      // OBSERVABLE as a silent re-adopt, not a dialog the player has to answer — the point being
      // proven is that the device re-converges with the server on its own, not what a human does
      // with a fork prompt.
      const g = group({
        store: s.store, atomicity: multiKey(s.durable), onFork: 'take-server',
        adopt: (_local, server) => ({ content: server.content as Content, upload: false }),
      });
      const t = fakeTransport({ g: { content: { value: 'b' }, version: 4, updatedAt: 0 } });
      const outcome = await runGroupSync(g, t.transport, OPTS);
      expect(outcome).toEqual({ kind: 'failed', reason: 'content write was not durable' });
      // The content write was ATTEMPTED (one write), and the marks were withheld — so the device
      // cannot claim a version whose content it may not actually hold.
      expect(s.writes.length).toBe(1);
      expect(s.writes[0].content).toEqual({ value: 'b' });
      expect(s.writes[0].marks).toEqual(emptyMarks());

      // The follow-up sync: the marks are still blank, so the device reads against them and adopts
      // again — landing the marks the failed attempt could not. No lost data, no dialog.
      s.setDurable(true);
      const followUp = await runGroupSync(g, t.transport, OPTS);
      expect(followUp.kind).toBe('adopted');
      expect(s.state.marks.lastSyncedVersion).toBe(4);
    });
  });

  it('transport.load throwing -> failed, never an escaped rejection', async () => {
    const s = makeStore({ content: { value: 'a' }, version: 0, updatedAt: 0, marks: emptyMarks() });
    const g = group({ store: s.store });
    const t: GroupTransport = {
      load: async () => { throw new Error('offline'); },
      push: async () => 'ok',
    };
    await expect(runGroupSync(g, t, OPTS)).resolves.toEqual({ kind: 'failed', reason: 'load failed: Error: offline' });
  });

  it('transport.push throwing -> failed, never an escaped rejection', async () => {
    const s = makeStore({ content: { value: 'a' }, version: 0, updatedAt: 0, marks: emptyMarks() });
    const g = group({ store: s.store });
    const t: GroupTransport = {
      load: async () => null,
      push: async () => { throw new Error('write denied'); },
    };
    await expect(runGroupSync(g, t, OPTS)).resolves.toEqual({ kind: 'failed', reason: 'push failed: Error: write denied' });
  });
});

// ── runCloudSync over a heterogeneous set ────────────────────────────────────────────

// ── The read-modify-write-across-an-await guard ──────────────────────────────────
//
// The runner reads the store once, then awaits the transport. A game write landing in that window
// invalidates a `take-server` decision's premise, and applying anyway overwrites it with no fork
// ever raised. See `localMovedUnderUs`.

describe('a local write landing during the network round trip', () => {
  it('is NOT overwritten by a take-server outcome — the pass re-decides instead', async () => {
    const s = makeStore({
      content: { value: 'synced' }, version: 5, updatedAt: 0,
      marks: marks({ uid: 'u1', lastSyncedVersion: 5, lastSyncedFingerprint: 'synced' }),
    });
    const g = group({ store: s.store, onFork: 'ask' });
    // The game writes while `load()` is in flight — exactly the window the guard covers.
    const t = fakeTransport({ g: { content: { value: 'theirs' }, version: 9, updatedAt: 0 } });
    const racing: GroupTransport = {
      load: async (id) => {
        s.store.write({ ...s.state, content: { value: 'raced' } });
        return t.transport.load(id);
      },
      push: t.transport.push,
    };

    const outcome = await runGroupSync(g, racing, OPTS);

    // Re-deciding finds the group dirty against a server that moved: a fork, which is the question
    // the player should have been asked in the first place. Never a silent adopt.
    expect(outcome.kind).toBe('fork');
    expect(s.state.content).toEqual({ value: 'raced' });
  });

  // ⚠️ The other half, and the one that is catastrophic if it regresses. On a FRESH INSTALL the
  // raced write defeats `isFreshAndEmpty`, so re-deciding would yield a fork — the "choose between
  // nothing and your progress" dialog whose keep-this-device arm uploads a near-empty save over a
  // real account. The guard must NOT fire for a never-synced group.
  it('does NOT fire for a never-synced group — the fresh-install adopt stays silent', async () => {
    const s = makeStore({ content: { value: '' }, version: 0, updatedAt: 0, marks: emptyMarks() });
    const g = group({ store: s.store, onFork: 'ask' });
    const t = fakeTransport({ g: { content: { value: 'real progress' }, version: 9, updatedAt: 0 } });
    const racing: GroupTransport = {
      load: async (id) => {
        s.store.write({ ...s.state, content: { value: 'a stray write' } });
        return t.transport.load(id);
      },
      push: t.transport.push,
    };

    const outcome = await runGroupSync(g, racing, OPTS);

    expect(outcome).toEqual({ kind: 'adopted', version: 9 });
    expect(s.state.content).toEqual({ value: 'real progress' });
  });

  it('does not gate a plain upload, which is self-healing on its own', async () => {
    const s = makeStore({
      content: { value: 'mine' }, version: 5, updatedAt: 0,
      marks: marks({ uid: 'u1', lastSyncedVersion: 5, lastSyncedFingerprint: 'old' }),
    });
    const g = group({ store: s.store, onFork: 'ask' });
    const t = fakeTransport({ g: { content: { value: 'mine' }, version: 5, updatedAt: 0 } });
    const racing: GroupTransport = {
      load: async (id) => {
        s.store.write({ ...s.state, content: { value: 'raced' } });
        return t.transport.load(id);
      },
      push: t.transport.push,
    };

    const outcome = await runGroupSync(g, racing, OPTS);

    expect(outcome.kind).toBe('uploaded');
  });
});

describe('runCloudSync', () => {
  it('one idle, one uploading, one forking -- the forking one writes nothing, the others complete', async () => {
    const idleStore = makeStore({
      content: { value: 'a' }, version: 3, updatedAt: 0,
      marks: marks({ uid: 'u1', lastSyncedVersion: 3, lastSyncedFingerprint: 'a' }),
    });
    const idleGroup = defineSyncGroup<Content>({
      id: 'idle', store: idleStore.store, fingerprint,
      isFreshAndEmpty: (c) => c.value === '',
      merge: (l) => l.content, adopt: (_l, s) => ({ content: s.content as Content, upload: false }),
      onFork: 'ask', atomicity: singleKey(),
    });

    const uploadStore = makeStore({ content: { value: 'new content' }, version: 0, updatedAt: 0, marks: emptyMarks() });
    const uploadGroup = defineSyncGroup<Content>({
      id: 'upload', store: uploadStore.store, fingerprint,
      isFreshAndEmpty: (c) => c.value === '',
      merge: (l) => l.content, adopt: (_l, s) => ({ content: s.content as Content, upload: false }),
      onFork: 'ask', atomicity: singleKey(),
    });

    const forkStore = makeStore({
      content: { value: 'mine' }, version: 5, updatedAt: 0,
      marks: marks({ uid: 'u1', lastSyncedVersion: 5, lastSyncedFingerprint: 'mine-old' }),
    });
    const forkGroup = defineSyncGroup<Content>({
      id: 'fork', store: forkStore.store, fingerprint,
      isFreshAndEmpty: (c) => c.value === '',
      merge: (l) => l.content, adopt: (_l, s) => ({ content: s.content as Content, upload: false }),
      onFork: 'ask', atomicity: singleKey(),
    });

    const t = fakeTransport({
      idle: { content: { value: 'a' }, version: 3, updatedAt: 0 },
      fork: { content: { value: 'theirs' }, version: 9, updatedAt: 0 },
    });

    const result = await runCloudSync([idleGroup, uploadGroup, forkGroup], t.transport, OPTS);

    expect(result.outcomes.idle).toEqual({ kind: 'idle' });
    expect(result.outcomes.upload).toEqual({ kind: 'uploaded', version: 1 });
    expect(result.outcomes.fork.kind).toBe('fork');
    expect(result.asking).toEqual(['fork']);
    expect(forkStore.writes.length).toBe(0);
    expect(uploadStore.state.marks.lastSyncedVersion).toBe(1);
  });
});

// ── resolveGroupFork ─────────────────────────────────────────────────────────────

describe('resolveGroupFork', () => {
  it('merges, pushes, and advances marks on success', async () => {
    const s = makeStore({
      content: { value: 'mine' }, version: 5, updatedAt: 0,
      marks: marks({ uid: 'u1', lastSyncedVersion: 5, lastSyncedFingerprint: 'mine-old' }),
    });
    const g = group({ store: s.store });
    const server: CloudGroup<Content> = { content: { value: 'theirs' }, version: 9, updatedAt: 0 };
    const t = fakeTransport({ g: server as CloudGroup<unknown> });

    const outcome = await resolveGroupFork(g, server as never, 'local', { transport: t.transport, ...OPTS });
    expect(outcome).toEqual({ kind: 'uploaded', version: 10 });
    expect(t.get('g')).toEqual({ content: { value: 'mine' }, version: 10, updatedAt: 0 });
    expect(s.state.marks.lastSyncedVersion).toBe(10);
    expect(s.state.marks.lastSyncedFingerprint).toBe('mine');
  });

  it('a merge that teaches the server nothing adopts at its version, with no push at all', async () => {
    // *Keep the cloud* on a group whose merge contributes nothing back. Pushing here would cost a
    // round trip and move the server for a document that did not change — which every OTHER device
    // on the account would then have to adopt.
    const s = makeStore({
      content: { value: 'mine' }, version: 5, updatedAt: 0,
      marks: marks({ uid: 'u1', lastSyncedVersion: 5, lastSyncedFingerprint: 'mine-old' }),
    });
    const g = group({ store: s.store });
    const server: CloudGroup<Content> = { content: { value: 'theirs' }, version: 9, updatedAt: 3 };
    const t: GroupTransport = {
      load: async () => server as never,
      push: async () => { throw new Error('must not push'); },
    };

    const outcome = await resolveGroupFork(g, server as never, 'server', { transport: t, ...OPTS });

    expect(outcome).toEqual({ kind: 'adopted', version: 9 });
    expect(s.state.content).toEqual({ value: 'theirs' });
    expect(s.state.marks.lastSyncedVersion).toBe(9);
    expect(s.state.updatedAt).toBe(3); // the server's stamp — this content IS the server's
  });

  it('writes the chosen content even when the push fails, but does not advance marks', async () => {
    const s = makeStore({
      content: { value: 'mine' }, version: 5, updatedAt: 0,
      marks: marks({ uid: 'u1', lastSyncedVersion: 5, lastSyncedFingerprint: 'mine-old' }),
    });
    // A merge that CONTRIBUTES, so an upload is genuinely owed and its failure is observable —
    // with the default merge the case above applies and there is no push to fail.
    const g = group({
      store: s.store,
      merge: (local, srv) => ({ value: `${(srv.content as Content).value}+${local.content.value}` }),
    });
    const server: CloudGroup<Content> = { content: { value: 'theirs' }, version: 9, updatedAt: 0 };
    const t: GroupTransport = { load: async () => server as never, push: async () => 'failed' };

    const outcome = await resolveGroupFork(g, server as never, 'server', { transport: t, ...OPTS });
    expect(outcome).toEqual({ kind: 'failed', reason: 'push rejected' });
    expect(s.state.content).toEqual({ value: 'theirs+mine' }); // chosen content landed on the device
    expect(s.state.marks.lastSyncedVersion).toBe(5); // marks unchanged -- unresolved on the server
  });

  it("a conflicting push returns 'restart' so the caller re-runs a full sync", async () => {
    const s = makeStore({
      content: { value: 'mine' }, version: 5, updatedAt: 0,
      marks: marks({ uid: 'u1', lastSyncedVersion: 5, lastSyncedFingerprint: 'mine-old' }),
    });
    const g = group({ store: s.store });
    const server: CloudGroup<Content> = { content: { value: 'theirs' }, version: 9, updatedAt: 0 };
    const t: GroupTransport = { load: async () => server as never, push: async () => 'conflict' };

    const outcome = await resolveGroupFork(g, server as never, 'local', { transport: t, ...OPTS });
    expect(outcome).toEqual({ kind: 'restart' });
    expect(s.state.content).toEqual({ value: 'mine' }); // chosen content still landed
  });
});
