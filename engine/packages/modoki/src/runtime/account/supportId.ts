/** Which identifier a Settings "Player ID" row shows, for a player writing to support (#1398).
 *
 *  Owner ruling (2026-09-18): the account uid when signed in, and otherwise the Firebase Analytics
 *  app-instance ID, so a signed-out player, the one support has no other way to look up, still has
 *  something to paste. The whole value is shown and copied, never a shortened one.
 *
 *  `none` is a real outcome, not an edge case: signing in is optional, and there is no app-instance ID
 *  off-native or when the Firebase call fails. (Firebase would also withhold one if ANALYTICS_STORAGE
 *  consent were denied, which neither game sets today; see docs/ui-system.md.) The game
 *  shows its own authored "not available" line then, and must not offer a Copy that copies nothing.
 *
 *  Pure: the game passes what it knows. `uid` is the signed-in account's uid (null or undefined when
 *  signed out); `appInstanceId` is what the analytics wrapper resolved. No player-visible copy here
 *  (`accountNoCopy.test.ts`). */
export type SupportId =
  | { kind: 'account'; id: string }
  | { kind: 'install'; id: string }
  | { kind: 'none' };

export function supportId(uid: string | null | undefined, appInstanceId: string | null | undefined): SupportId {
  if (uid != null && uid.trim() !== '') return { kind: 'account', id: uid };
  if (appInstanceId != null && appInstanceId.trim() !== '') return { kind: 'install', id: appInstanceId };
  return { kind: 'none' };
}

/** The last Copy tap's outcome, shown on the button until `until` (ms, on the caller's clock). */
export interface CopyFeedback {
  copied: boolean;
  until: number;
}

/** The game's authored wording for the row. The engine carries none (#675). */
export interface SupportIdWords {
  copy: string;
  copied: string;
  failed: string;
  unavailable: string;
}

export interface SupportIdView {
  /** The WHOLE ID, never shortened (owner ruling), or the authored "not available" line. */
  value: string;
  /** The button's word: Copy, or Copied / Failed inside the feedback window. */
  button: string;
  /** Hidden when there is no ID: a Copy that copies nothing would be a control that does nothing. */
  buttonVisible: boolean;
}

/** What a Player ID row shows, given the decision above and the last copy's outcome. Shared by both
 *  games so their rows cannot drift apart. Clock-free: `now` is passed in. */
export function supportIdView(id: SupportId, words: SupportIdWords, feedback: CopyFeedback | null, now: number): SupportIdView {
  if (id.kind === 'none') return { value: words.unavailable, button: words.copy, buttonVisible: false };
  const showing = feedback !== null && now < feedback.until;
  const button = !showing ? words.copy : feedback.copied ? words.copied : words.failed;
  return { value: id.id, button, buttonVisible: true };
}
