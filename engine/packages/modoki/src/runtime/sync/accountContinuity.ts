/** Account continuity — an account deleted while this device was NOT running (#1274).
 *
 *  `GroupTransport.confirmAccount` asks the server about the account a sync runs as, which needs a session AS
 *  that account. A phone that was closed when its account was deleted elsewhere never has one: on launch the auth
 *  SDK signs it out before any game code runs (measured, Court, iPad mini 5, 2026-09-16), and the phone keeps the
 *  deleted account's save. If the player then signs in with the same Apple or Google login, Firebase creates a
 *  NEW account, and the next sync would upload the deleted account's save into it.
 *
 *  That sign-in is the evidence. **While an account exists, a provider login belongs to exactly one account**, so
 *  a new uid for a login the previous account had means the previous account is gone. Each sync records the
 *  signed-in account's login keys; the next sync as a different account compares against that record before any
 *  group runs.
 *
 *  - The phone that stays signed out is deliberately left alone (owner, 2026-09-17: "do the same as Weave", whose
 *    ruling keeps that save). Nothing about it is knowable without a server-side record.
 *  - A different login is an ordinary account switch, never a match — an Apple-only account followed by a Google
 *    one shares no key.
 *  - **A phone with no record is not covered.** A record is written only by a sync that ran with this check, so a
 *    phone whose deleted account never synced after the update (including one already in #1274's state) switches
 *    as before.
 *  - **Unknown keys skip the check for that sync, and the switch then goes ahead** — which re-scopes the marks, so
 *    the chance is gone for good. Journalled (`sync.account-continuity.keys-unknown`) whenever a match was
 *    possible, so a platform where the lookup always fails is visible in an editor or debug build. A store build
 *    has no journal, so there it stays silent. Not deferred: a deferral would need state
 *    that outlives the sync, and on such a platform it would block every real account switch instead.
 */

import { journalWarn } from '../core/gameJournal';
import type { AnySyncGroup } from './types';

/** The last account a sync ran as, and its login keys. */
export interface LoginRecord {
  uid: string;
  /** {@link loginKey} values — opaque hashes, compared for overlap only. */
  keys: readonly string[];
}

/** What a game hands `runCloudSync` to turn the check on. One object, so a game cannot wire half of it. */
export interface AccountContinuity {
  /** The login keys of `uid` — one {@link loginKey} per `providerData` entry (on Android that includes the
   *  `firebase` pseudo-provider, whose key can never be shared by two accounts). `[]` when `uid` is not the account
   *  signed in right now, or the answer is unknown: that turns the check off for this sync and records nothing.
   *  A throw reads as `[]`. */
  loginKeys(uid: string): Promise<readonly string[]>;
  /** The stored record, or `null` when none (or an unreadable one) is stored. */
  read(): LoginRecord | null;
  /** Store the record. Called only when it changes. */
  write(record: LoginRecord): void;
}

/**
 * The stored form of one provider login: SHA-256 of `providerId` and the provider's own user id.
 *
 * ⚠️ **Hashed, so the provider's user id is never stored.** The comparison only needs equality, and a game's own
 * model deliberately holds no provider identity (Court's `CourtUser`, owner 2026-09-01). Both parts go in, so an
 * Apple id and a Google id that happen to be equal are still different logins.
 */
export async function loginKey(providerId: string, providerUid: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([providerId, providerUid]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The uid of a previous account that no longer exists, judged from a sign-in as `uid` — or `null`.
 *
 * Also records `uid`'s keys for the next sync. The record is written only AFTER the comparison, since writing
 * first would compare the new account against itself.
 *
 * `'gone'` needs all four:
 * 1. the record names a different, non-empty uid;
 * 2. the record shares a login key with the account signed in now;
 * 3. some group holds marks for that uid which it actually exchanged (`lastSyncedVersion > 0`), so the local
 *    save really is that account's;
 * 4. `uid` is non-empty.
 *
 * On `'gone'` the record is left as it was: the game wipes and restarts, and the next sync records the new
 * account then.
 */
export async function previousAccountGone(
  groups: readonly AnySyncGroup[],
  continuity: AccountContinuity,
  uid: string,
): Promise<string | null> {
  if (uid === '') return null;
  let keys: readonly string[];
  try {
    keys = await continuity.loginKeys(uid);
  } catch {
    keys = [];
  }
  const previous = safeRead(continuity);
  const holdsPrevious = previous !== null && previous.uid !== '' && previous.uid !== uid
    && groups.some((g) => {
      const m = g.store.read().marks;
      return m.uid === previous.uid && m.lastSyncedVersion > 0;
    });
  if (keys.length === 0) {
    // No uid in the payload, as with every account journal line.
    if (holdsPrevious) journalWarn('sync.account-continuity.keys-unknown', {});
    return null;
  }
  if (holdsPrevious && previous.keys.some((k) => keys.includes(k))) return previous.uid;
  if (previous === null || previous.uid !== uid || !sameKeys(previous.keys, keys)) {
    continuity.write({ uid, keys: [...keys] });
  }
  return null;
}

function safeRead(continuity: AccountContinuity): LoginRecord | null {
  try {
    const r = continuity.read();
    return r && typeof r.uid === 'string' && Array.isArray(r.keys) ? r : null;
  } catch {
    return null;
  }
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k) => b.includes(k));
}

/** Parse a stored record — for a game's `read()`. Anything that is not exactly the shape reads as `null`. */
export function parseLoginRecord(value: unknown): LoginRecord | null {
  if (!value || typeof value !== 'object') return null;
  const { uid, keys } = value as { uid?: unknown; keys?: unknown };
  if (typeof uid !== 'string' || !Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) return null;
  return { uid, keys: keys as string[] };
}
