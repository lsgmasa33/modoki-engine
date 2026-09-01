/** What to do with one group, given a freshly fetched server document (#532).
 *
 *  Pure, clock-free, and the whole of the protocol's decision-making. The caller performs the I/O
 *  the decision names.
 *
 *  ## Two mechanisms, doing two different jobs
 *
 *  **The version counter decides WHETHER the two sides have forked** — a monotonic integer per
 *  group, with the server accepting an upload only at exactly `current + 1` (a compare-and-swap,
 *  enforced server-side). Cheap, exact, and it needs no content inspection.
 *
 *  **The fingerprint decides WHETHER THIS DEVICE HAS UNSYNCED WRITES.** A bare version number cannot
 *  tell *"my 9 IS the server's 9"* from *"my 9 is a different 9 that never left this device"*, and
 *  that ambiguity loses data silently:
 *
 *  1. Both devices at v8. 2. Tablet goes offline, writes local v9. 3. Phone uploads its own v9;
 *  server = 9. 4. Tablet reconnects: `local.version === server.version`, so "nothing to do" — the
 *  tablet's write is never uploaded, the phone's never arrives, and the tablet's next save goes to
 *  v10, which the server accepts.
 *
 *  So the device tracks `lastSyncedVersion` — the version it last actually EXCHANGED — and the four
 *  cases fall out of comparing that against the server, with dirtiness as the second axis.
 */

import {
  neverSynced,
  type AnySyncGroup,
  type CloudGroup,
  type GroupMarks,
  type LocalGroup,
} from './types';

/** What one group's sync should do. */
export type GroupDecision =
  /** In sync, nothing pending. */
  | { action: 'none' }
  /** No document on the server yet. Upload as version 1. */
  | { action: 'create'; version: 1 }
  /** This device has writes the server has not seen, and the server has not moved past what we
   *  acknowledged. Upload at `version`, which the compare-and-swap will accept. */
  | { action: 'upload'; version: number }
  /** The server moved and this device has nothing unsynced — its content is a strict ancestor.
   *  Adopt silently; there is no question to ask. */
  | { action: 'take-server' }
  /** Both sides moved. The saves have forked, and what happens next is the group's `onFork`. */
  | { action: 'fork' };

/**
 * Are there durable local writes the server has never seen? Derived, never stored.
 *
 * ⚠️ **A never-synced group with nothing in it is CLEAN, and getting this wrong is account-wiping.**
 * A fresh install has no marks, so a plain fingerprint comparison calls it dirty; signing in to an
 * account holding real progress then produces a FORK rather than a silent adopt, and shows the
 * player the "choose between nothing and your progress" dialog the design exists to prevent. One
 * reflex tap on *keep this device* uploads the empty save over the account.
 *
 * ⚠️ The fresh-install arm keys on `isFreshAndEmpty`, which each group defines for itself precisely
 * because "empty" is not the same question in every group — see `SyncGroupSpec.isFreshAndEmpty` for
 * the seeding trap that makes a naive "equals empty" wrong.
 */
export function hasLocalWrites(group: AnySyncGroup, local: LocalGroup<never>): boolean {
  if (neverSynced(local.marks) && group.isFreshAndEmpty(local.content)) return false;
  return group.fingerprint(local.content) !== local.marks.lastSyncedFingerprint;
}

/**
 * The marks, but ONLY if they describe `uid`.
 *
 * A mismatch reads as never-synced, which is the safe direction: the group looks dirty, uploads once
 * redundantly, and cannot claim the server has seen writes it has not. The dangerous direction is
 * the opposite — see `GroupMarks.uid`.
 *
 * ⚠️ **Whether there are unsynced WRITES is a SEPARATE question from whose versions these are, and
 * getting it wrong in either direction loses data:**
 *
 *   • Signed in as A, signed out, signed in as B. What is on disk is A's content, and A's marks say
 *     A's cloud already holds exactly it. Treating that as "local writes" offers to push A's content
 *     into B's document, which is an offer to corrupt B.
 *   • Signed out, played offline, then signed in. That content is the player's and nothing has it.
 *     Treating THAT as clean lets the silent adopt erase it.
 *
 * The fingerprint tells them apart exactly: content still matching what the PREVIOUS account
 * acknowledged is already safe in that account's cloud, and this device owes the new one nothing.
 * Anything else is a real unsynced write.
 *
 * ⚠️ **`''` is an account like any other here, and an earlier `marks.uid !== '' &&` guard made it
 * the one account that could never converge.** The reasoning behind that clause was Court's — marks
 * with no uid are pre-#361 and should read as never-synced — but the marks this engine writes always
 * carry the uid they were exchanged with, so an anonymous group (a game with no accounts at all, or
 * a sync run before sign-in) stamps `''` legitimately and then failed to recognise its OWN marks on
 * the next pass: every sync re-adopted the server forever. The legacy case it was aiming at is still
 * caught, because `'' === someRealUid` is false. Found by Court's `syncNow(io)` with no uid (#532).
 */
export function scopeMarksToAccount(
  marks: GroupMarks,
  uid: string,
  currentFingerprint: string,
): GroupMarks {
  if (marks.uid === uid) return marks;
  const alreadySafeElsewhere =
    marks.lastSyncedFingerprint !== '' && currentFingerprint === marks.lastSyncedFingerprint;
  return {
    lastSyncedVersion: 0,
    lastSyncedFingerprint: alreadySafeElsewhere ? marks.lastSyncedFingerprint : '',
    lastSyncedAt: 0,
    uid,
  };
}

/**
 * Decide what one group's sync should do. `server` is `null` when the account has no document for
 * this group yet.
 */
export function decideGroup(
  group: AnySyncGroup,
  local: LocalGroup<never>,
  server: CloudGroup<never> | null,
): GroupDecision {
  if (!server) return { action: 'create', version: 1 };

  const dirty = hasLocalWrites(group, local);
  const synced = local.marks.lastSyncedVersion;

  // The server is BEHIND what we last exchanged: the cloud document was reset or rolled back (a
  // cleared account, a debug reset). Not a fork — re-establish the lineage from where it actually is.
  if (server.version < synced) return { action: 'upload', version: server.version + 1 };

  if (server.version === synced) {
    return dirty ? { action: 'upload', version: server.version + 1 } : { action: 'none' };
  }

  // server.version > synced — the server has moved on.
  return dirty ? { action: 'fork' } : { action: 'take-server' };
}
