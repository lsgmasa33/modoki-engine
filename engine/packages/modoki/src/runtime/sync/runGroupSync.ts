/** Running the sync-guaranteed group protocol — one group, and the aggregate over a set (#532).
 *
 *  This is a PORT of `games/court/runtime/saveSync.ts`'s `runSync` (see its docblock) onto the
 *  "one document per group" axis. Semantics are preserved exactly; only the persistence step is new
 *  — the original had ONE document so the mark and the content it describes were always atomic by
 *  construction, and a group's `atomicity` now makes that an explicit, checked property instead of
 *  a given.
 */

import { decideGroup, scopeMarksToAccount } from './decide';
import { neverSynced } from './types';
import type {
  AnySyncGroup, CloudGroup, ConflictChoice, GroupMarks, GroupTransport, LocalGroup,
} from './types';

/** What one group's sync did. */
export type GroupOutcome =
  | { kind: 'idle' }
  /** `replacedLocal` means this upload also carries content ADOPTED from the server (a `take-server`
   *  whose `adopt()` owed an upload) — see `saveSync.ts`'s `SyncOutcome` for why the flag exists: the
   *  caller must know this write also changed the device's content, not just its marks. */
  | { kind: 'uploaded'; version: number; replacedLocal?: true }
  | { kind: 'adopted'; version: number }
  /** The saves have forked and `onFork` is `'ask'`. Nothing is written — the caller resolves via
   *  `resolveGroupFork` once the player answers. */
  | { kind: 'fork'; local: LocalGroup<never>; server: CloudGroup<never> }
  | { kind: 'failed'; reason: string }
  /** `resolveGroupFork`'s push lost a race — the server moved again while the player was deciding.
   *  The caller must re-run a full `runGroupSync`/`runCloudSync` pass for this group rather than treat it
   *  as a plain failure; see `resolveFork.ts`'s docblock for why a bare `'conflict'` is not enough. */
  | { kind: 'restart' };

export interface RunSyncOptions {
  uid: string;
  /** Wall-clock ms, injected — never read in here. See `GroupMarks.lastSyncedAt`. */
  now: number;
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Persist a group's content with its marks ADVANCED to describe what was just exchanged.
 *
 * ⚠️ **Why this exists at all — the multi-key case has no single write to make atomic.** A
 * single-key group's one `store.write()` already carries content and marks together, so nothing
 * here is needed beyond that call. A multi-key group cannot offer that: its keys land as separate
 * underlying writes, so writing the advanced marks in the SAME call as the content risks landing the
 * marks while the content write is rejected — after which the group reads clean at a version it
 * never actually holds, and the next sync uploads STALE content over whatever the server has (#491).
 * So a multi-key group pays with a second write: content first with marks UNCHANGED, flush, probe
 * `atomicity.durable()`, and only once that says the content actually landed does the marks write
 * go out. If it says no, this returns `false` and the caller reports a failure — the group is left
 * holding its OLD marks, so it cannot claim a version it does not hold.
 *
 * ⚠️ **That is damage control, NOT a self-heal, and the difference decides how a game should group.**
 * The gate is only clean when the content write failed ENTIRELY: the group then still holds coherent
 * old content, reads clean against its old marks, and the next sync silently re-fetches. A PARTIAL
 * failure — some of the group's keys landed, others were rejected — leaves content matching neither
 * side, which reads DIRTY against the old marks while the server has moved. That is a fork, and for
 * an `onFork: 'ask'` group it surfaces as a dialog the player cannot meaningfully answer, whose
 * "keep this device" arm uploads the incoherent mix. No policy resolves that well, because by then
 * there is no coherent local side left to choose.
 *
 * **So this is a fallback for a group that genuinely cannot be one key, never a default.** A
 * single-key group cannot reach the bad state at all: its one write carries content and marks
 * together or neither, so a rejection leaves it coherently behind and the re-fetch is exact. That is
 * the engine's own storage rule (`../storage/playerPrefs.ts`: *"state that must change together goes
 * under ONE key"*), and it is the whole reason `GroupAtomicity` makes a caller say which one it is.
 *
 * Returns whether the marks landed.
 *
 * Exported for `resolveFork.ts`, which owes the identical guarantee on its own two writes (the
 * upload before acknowledgement, the marks after) and must not re-derive it by hand.
 */
export async function persist(group: AnySyncGroup, next: LocalGroup<never>): Promise<boolean> {
  if (group.atomicity.kind === 'single-key') {
    group.store.write(next);
    await group.store.flush();
    return true;
  }
  const previousMarks: GroupMarks = group.store.read().marks;
  group.store.write({ ...next, marks: previousMarks });
  await group.store.flush();
  if (!group.atomicity.durable()) return false;
  group.store.write(next);
  await group.store.flush();
  return true;
}

/**
 * Advance a group's MARKS without touching its content — the plain-upload path.
 *
 * ⚠️ **The content comes from a fresh `store.read()`, never from the caller's snapshot**, and that
 * is the whole point: between deciding and being acknowledged, a game write can have landed on this
 * device. Writing a decision-time snapshot back would destroy it; reading through means the marks
 * describe what the server acknowledged while the device keeps whatever it actually holds, so the
 * racing write reads dirty and uploads on the next pass.
 *
 * No durability gate here, and none is owed: `persist`'s two-phase dance exists because a multi-key
 * group's marks can outrun its CONTENT write, and there is no content write to outrun. Returns
 * `true` for symmetry with `persist`, so a caller can treat the two the same way.
 */
export async function persistMarks(
  group: AnySyncGroup,
  version: number,
  marks: GroupMarks,
): Promise<boolean> {
  const current = group.store.read();
  group.store.write({ ...current, version, marks });
  await group.store.flush();
  return true;
}

/**
 * Has a local write landed since we read the store, invalidating a content-replacing outcome?
 *
 * ⚠️ **The classic read-modify-write across an await, and it silently destroys player data.** The
 * runner reads the store once, then awaits `transport.load()` and (on an upload path)
 * `transport.push()` — two network round trips during which the game itself can write. A
 * `take-server` decision's premise ("this group has nothing unsynced worth protecting") was
 * evaluated against the STALE read, so it can still look true when we are about to act on it and be
 * false in fact. Applying anyway overwrites whatever landed in the window, with no fork ever raised.
 *
 * ⚠️ **ESTABLISHED LINEAGES ONLY, and the exclusion is the whole safety of this guard.**
 * `take-server` is reachable two ways: a fingerprint MATCHING the marks, or `hasLocalWrites`'
 * fresh-install fast path (`neverSynced` + `isFreshAndEmpty`). Re-deciding is right for the first
 * and catastrophic for the second — the raced write defeats `isFreshAndEmpty`, so the retry reads
 * dirty against a server that has moved and yields a FORK. That is the "choose between nothing and
 * your progress" dialog the fresh-install rule exists to prevent, and its keep-this-device arm
 * uploads the near-empty save over a real account. Losing the single raced write on that path is
 * strictly the lesser evil.
 *
 * ⚠️ `established` is passed IN rather than derived from the `local` in hand, and that is not a
 * style choice. `local` is SYNTHETIC after an adopt that owes an upload — `adoptAndMaybeUpload`
 * hands back marks describing the SERVER — so a fresh install reads as an established lineage by
 * the time the post-push check runs, switching the exclusion above off in exactly the case it
 * exists for. It must come from the marks the STORE actually held on the last real read.
 *
 * Only content-REPLACING outcomes are gated. A plain upload is already self-healing without this:
 * it stamps a fingerprint of the content it uploaded, so the racing write reads dirty on the next
 * pass and uploads then. Gating it here would turn a benign, self-correcting race into a failure.
 */
function localMovedUnderUs(group: AnySyncGroup, established: boolean, seen: string): boolean {
  if (!established) return false;
  return group.fingerprint(group.store.read().content) !== seen;
}

/** Re-read the store and re-scope its marks — the state a pass restarts from. */
function readScoped(group: AnySyncGroup, uid: string): { local: LocalGroup<never>; seen: string } {
  const fresh = group.store.read();
  const seen = group.fingerprint(fresh.content);
  return { local: { ...fresh, marks: scopeMarksToAccount(fresh.marks, uid, seen) }, seen };
}

/**
 * Run one sync to completion for a single group: read the server, decide, and act.
 *
 * Mirrors `saveSync.ts`'s `runSync` exactly (see its docblock for the full reasoning) —
 * ⚠️ **a rejected push is re-DECIDED, never re-pushed**: another device landing a version while this
 * one held unsynced changes is, by definition, a fork, so a blind re-push would silently destroy the
 * other device's work. The one retryable case is a server that moved BACKWARDS (a cleared/reset
 * document), where the re-decide yields a fresh `upload`.
 *
 * ⚠️ **The attempt bound is not paranoia.** A rejected write and a misconfigured security rule are
 * indistinguishable to the transport, and unbounded, the second spins forever on a player's phone.
 *
 * Never throws. A failed sync must leave the game playable — the content is still on the device,
 * which is the whole reason cloud save is an addition to local storage, never a replacement.
 */
export async function runGroupSync(
  group: AnySyncGroup,
  transport: GroupTransport,
  opts: RunSyncOptions,
): Promise<GroupOutcome> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  // `seen` is the fingerprint of the content this pass DECIDED against. `localMovedUnderUs` compares
  // a fresh store read against it to catch a game write landing during the network round trips.
  let { local, seen } = readScoped(group, opts.uid);
  // ⚠️ Refreshed ONLY where the store is actually re-read — never re-derived from `local`, which
  // goes synthetic after an adopt. See `localMovedUnderUs`.
  let established = !neverSynced(local.marks);
  // Set when a pass through the loop ADOPTED the server's content — see `replacedLocal` above.
  let replacedLocal: true | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let server: CloudGroup<never> | null;
    try {
      server = (await transport.load(group.id)) as CloudGroup<never> | null;
    } catch (e) {
      return { kind: 'failed', reason: `load failed: ${String(e)}` };
    }

    const decision = decideGroup(group, local, server);

    if (decision.action === 'none') return { kind: 'idle' };

    if (decision.action === 'take-server') {
      // ⚠️ A content-REPLACING outcome, so re-check the store before acting on a decision made
      // against a read that is now two network round trips old — see `localMovedUnderUs`.
      if (localMovedUnderUs(group, established, seen)) {
        ({ local, seen } = readScoped(group, opts.uid));
        established = !neverSynced(local.marks);
        continue;
      }
      const outcome = await adoptAndMaybeUpload(group, local, server as CloudGroup<never>, opts);
      if (outcome.kind === 'continue') {
        local = outcome.local;
        replacedLocal = true;
        continue;
      }
      return outcome.result;
    }

    if (decision.action === 'fork') {
      if (group.onFork === 'ask') {
        return { kind: 'fork', local, server: server as CloudGroup<never> };
      }
      const s = server as CloudGroup<never>;
      // ⚠️ **A policy-resolved fork goes through `merge`, NEVER through `adopt` — and the two are
      // not interchangeable.** `adopt` is the SILENT path, and its whole contract rests on there
      // being nothing local to preserve (see `SyncGroupSpec.adopt`): that premise is what makes it
      // safe for it to union nothing. A fork is by definition the case where both sides moved, so
      // the premise is false and anything the group unions only on the fork path — a completed
      // day whose date has passed, a spend record that must follow the receipt it paid for — would
      // be silently discarded. `merge` is the hook that owns that, on both arms.
      const choice: ConflictChoice =
        group.onFork === 'take-server' || s.updatedAt > local.updatedAt ? 'server' : 'local';
      const merged = group.merge(local, s, choice);
      // The merge taught the server nothing it does not already hold, so there is nothing to
      // upload — adopt at its version rather than spending a round trip re-pushing its own content.
      if (group.fingerprint(merged) === group.fingerprint(s.content)) {
        // Content-replacing, same as the `take-server` branch above — re-check before applying.
        if (localMovedUnderUs(group, established, seen)) {
          ({ local, seen } = readScoped(group, opts.uid));
          established = !neverSynced(local.marks);
          continue;
        }
        const next: LocalGroup<never> = {
          content: merged,
          version: s.version,
          // The content IS the server's, so its `updatedAt` is too — see `adoptAndMaybeUpload`.
          updatedAt: s.updatedAt,
          marks: {
            lastSyncedVersion: s.version,
            lastSyncedFingerprint: group.fingerprint(s.content),
            uid: opts.uid,
            lastSyncedAt: opts.now,
          },
        };
        const ok = await persist(group, next);
        if (!ok) return { kind: 'failed', reason: 'content write was not durable' };
        return { kind: 'adopted', version: s.version };
      }
      // The merge holds something the server has not seen, so it owes an upload. Marks stay
      // UNADVANCED until the server acknowledges — `pushAndPersist` advances them on `'ok'` only.
      const mergedLocal: LocalGroup<never> = {
        content: merged,
        version: s.version + 1,
        // ⚠️ The LATER of the two, not this device's. The merged content descends from BOTH sides,
        // so a stamp from one alone under-reports when it was last modified — and `updatedAt` is
        // what a `take-newer` policy and a dialog's "last played" row both read.
        updatedAt: Math.max(local.updatedAt, s.updatedAt),
        marks: local.marks,
      };
      const result = await pushAndPersist(group, transport, mergedLocal, s.version + 1, opts, replacedLocal, 'merged',
        () => localMovedUnderUs(group, established, seen));
      // On a retry the merge is DISCARDED and recomputed against the re-read server, rather than
      // re-pushed — the same rule the `'conflict'` branch applies to a plain upload.
      if (result.kind === 'retry') continue;
      return result.outcome;
    }

    // 'create' | 'upload'
    const result = await pushAndPersist(group, transport, local, decision.version, opts, replacedLocal, 'local',
      () => localMovedUnderUs(group, established, seen));
    if (result.kind === 'retry') continue;
    return result.outcome;
  }
  return { kind: 'failed', reason: `gave up after ${maxAttempts} conflicting attempts` };
}

/** The silent `take-server` handling. ⚠️ NOT reachable from a fork — see the ⚠️ in the fork branch
 *  above for why a policy-resolved fork must go through `merge` instead. */
async function adoptAndMaybeUpload(
  group: AnySyncGroup,
  local: LocalGroup<never>,
  server: CloudGroup<never>,
  opts: RunSyncOptions,
): Promise<{ kind: 'continue'; local: LocalGroup<never> } | { kind: 'return'; result: GroupOutcome }> {
  const adopted = group.adopt(local, server);
  if (!adopted.upload) {
    const next: LocalGroup<never> = {
      content: adopted.content,
      version: server.version,
      // ⚠️ **The SERVER's stamp, not this device's** — the content just became the server's, so
      // claiming it was modified whenever this device last wrote is a lie the next fork reads:
      // `updatedAt` is what `take-newer` and the conflict dialog's "last played" both go by, and an
      // adopting device that kept its own older stamp would present the adopted content as stale.
      // (`adopted.content` may union something local on top; the union is a merge of what the
      // server already holds with what this device already held, so it introduces no newer edit.)
      updatedAt: server.updatedAt,
      marks: {
        lastSyncedVersion: server.version,
        lastSyncedFingerprint: group.fingerprint(server.content),
        uid: opts.uid,
        lastSyncedAt: opts.now,
      },
    };
    const ok = await persist(group, next);
    if (!ok) return { kind: 'return', result: { kind: 'failed', reason: 'content write was not durable' } };
    return { kind: 'return', result: { kind: 'adopted', version: server.version } };
  }
  // The adopt owes an upload (it added something the server has not seen). Set `local` to the
  // adopted state, describing the SERVER as what was last exchanged, and re-enter the loop — the
  // next pass re-reads and decides `upload` from a clean footing. Deliberately NOT duplicating the
  // push block here; see the original's ⚠️ in `saveSync.ts`.
  const next: LocalGroup<never> = {
    content: adopted.content,
    version: server.version + 1,
    // ⚠️ **The LATER of the two here, unlike the pure adopt above.** This branch is the one where
    // the adopt ADDED something the server has not seen, so the content descends from both sides
    // and the server's stamp alone would under-report when it was last modified — on a device whose
    // own stamp is newer, it would present a document carrying that device's contribution as older
    // than the contribution itself.
    updatedAt: Math.max(local.updatedAt, server.updatedAt),
    marks: {
      lastSyncedVersion: server.version,
      lastSyncedFingerprint: group.fingerprint(server.content),
      uid: opts.uid,
      lastSyncedAt: local.marks.lastSyncedAt,
    },
  };
  return { kind: 'continue', local: next };
}

/**
 * Push content at `version` and persist on success.
 *
 * `origin` says where `local.content` came from, and it is REQUIRED because no comparison can
 * recover it. `'local'` means the device already holds this content — it was read from the store —
 * so success advances the MARKS ONLY. `'merged'` means it was computed here (a policy-resolved
 * fork), so the device does not hold it yet and success must write it. Deriving this by comparing
 * against a fresh store read gets the `'local'` case exactly backwards in the one situation that
 * matters: a game write landing during the round trip makes the two differ, and the answer there is
 * to leave the newer write alone, not to overwrite it. See `persistMarks`.
 */
async function pushAndPersist(
  group: AnySyncGroup,
  transport: GroupTransport,
  local: LocalGroup<never>,
  version: number,
  opts: RunSyncOptions,
  replacedLocal: true | undefined,
  origin: 'local' | 'merged',
  movedUnderUs: () => boolean,
): Promise<{ kind: 'retry' } | { kind: 'outcome'; outcome: GroupOutcome }> {
  let result: 'ok' | 'conflict' | 'failed';
  try {
    result = await transport.push(group.id, { content: local.content, version, updatedAt: local.updatedAt });
  } catch (e) {
    return { kind: 'outcome', outcome: { kind: 'failed', reason: `push failed: ${String(e)}` } };
  }
  if (result === 'ok') {
    const marks: GroupMarks = {
      lastSyncedVersion: version,
      lastSyncedFingerprint: group.fingerprint(local.content),
      uid: opts.uid,
      lastSyncedAt: opts.now,
    };
    // ⚠️ **A plain upload advances the MARKS and must not write the content back.** The device
    // already holds `local.content` — that is what was just uploaded — so re-writing it can only
    // do harm: a game write landing during the push's round trip is on disk by now, and writing
    // the decision-time snapshot over it destroys it silently. That race is deliberately NOT gated
    // (see `runGroupSync`'s own note): it self-heals, because the marks stamp the fingerprint of
    // what was UPLOADED, so the racing write reads dirty and goes up on the next pass. It can only
    // self-heal if it is still there.
    //
    // Two exceptions, and both mean the content is genuinely new to the device: `origin ===
    // 'merged'` (a policy-resolved fork computed it here) and `replacedLocal` (an earlier pass in
    // this loop ADOPTED the server's content and deferred persisting it to this push).
    const writesContent = origin === 'merged' || replacedLocal;
    // ⚠️ **The self-heal argument above does NOT cover a content-writing push, so those two arms
    // take the #492 re-check instead.** On the marks-only path a racing write survives and reads
    // dirty; here the content write lands ON TOP of it and the marks then stamp
    // `fingerprint(local.content)` — the very content that overwrote it — so the device reads
    // CLEAN and there is no next pass to heal anything. A solve made during a 2-second mobile
    // round trip would be gone, with the boards dropped and no dialog. Re-checking here rather
    // than only before the push is the point: the push is exactly the await the write races.
    //
    // On a move we DISCARD this outcome and re-enter the loop rather than applying it. The push
    // itself already succeeded and stands; the re-decide then finds a device that is dirty against
    // a server it has seen move, which is a fork — the dialog the player should get. That is the
    // pre-#532 behaviour (`saveSync.ts`'s `syncNow` gated `uploaded` + `replacedLocal` the same
    // way), and the fresh-install exclusion inside `localMovedUnderUs` is what keeps it safe.
    if (writesContent && movedUnderUs()) return { kind: 'retry' };
    const ok = writesContent
      ? await persist(group, { content: local.content, version, updatedAt: local.updatedAt, marks })
      : await persistMarks(group, version, marks);
    if (!ok) return { kind: 'outcome', outcome: { kind: 'failed', reason: 'content write was not durable' } };
    return {
      kind: 'outcome',
      outcome: replacedLocal ? { kind: 'uploaded', version, replacedLocal } : { kind: 'uploaded', version },
    };
  }
  if (result === 'failed') return { kind: 'outcome', outcome: { kind: 'failed', reason: 'push rejected' } };
  // 'conflict' — another device wrote between our read and our write. Re-read and RE-DECIDE, never
  // re-push: a write that lost a race was, by definition, made while this device held unsynced
  // changes against a server that has since moved, which is a fork.
  return { kind: 'retry' };
}

export interface RunSyncResult {
  outcomes: Record<string, GroupOutcome>;
  /** Ids of the groups whose outcome is `fork` — the ones an `onFork: 'ask'` policy actually raised,
   *  and the set a single dialog resolves together (one player choice, many groups — see F5 in
   *  `docs/plans/per-group-sync.md`). */
  asking: string[];
}

/**
 * Run every group's sync. Groups run SEQUENTIALLY, not concurrently — deterministic ordering, and it
 * avoids N devices' worth of concurrent writes landing at once. Parallelizing the LOAD half (each
 * group's read has no cross-group dependency) is a plausible later optimization, left out
 * deliberately: the win is small at Court's group count and it complicates the sequencing this
 * function's simplicity currently buys.
 */
export async function runCloudSync(
  groups: readonly AnySyncGroup[],
  transport: GroupTransport,
  opts: RunSyncOptions,
): Promise<RunSyncResult> {
  const outcomes: Record<string, GroupOutcome> = {};
  const asking: string[] = [];
  for (const group of groups) {
    const outcome = await runGroupSync(group, transport, opts);
    outcomes[group.id] = outcome;
    if (outcome.kind === 'fork') asking.push(group.id);
  }
  return { outcomes, asking };
}
