/** The cloud-sync contract — the declaration surface, as PURE types plus one constructor (#532).
 *
 *  ## What a GROUP is, and what it is not
 *
 *  A **sync-guaranteed group** is the unit the sync layer versions and transports: one cloud
 *  document, one monotonic `version`, one set of device-local marks. A game declares its groups by
 *  what must stay CONSISTENT together, which is not the same as what happens to share a storage key.
 *
 *  ⚠️ **A group is a VERSIONING/TRANSPORT unit, NOT a merge unit.** Fields inside one group can and
 *  do have different merge rules — a game may union one field and choose between two others in the
 *  same group. Grouping replaces the per-save version; it replaces no part of a game's field-by-field
 *  merge table. (Court's purchase group unions entitlements and chooses `coins`.)
 *
 *  ## Why the marks live INSIDE the group's own document
 *
 *  `PlayerPrefs` is atomic per key (`../storage/playerPrefs.ts`), so a group whose content and marks
 *  share ONE key cannot tear them apart: a rejected write drops both, leaving the group coherently
 *  behind rather than holding a receipt for content it never stored. The next sync sees the group
 *  behind the server, is clean against its own mark, and re-fetches. Self-healing, with no gate to
 *  remember.
 *
 *  ⚠️ **That is a property of SINGLE-KEY groups only, and this contract makes the difference
 *  impossible to forget.** A group spanning several keys can still land its marks while a content
 *  write is rejected — after which it reads dirty at the server's own version and uploads STALE
 *  content over it, destroying whatever the server held. So `atomicity` is a discriminated union and
 *  `'multi-key'` REQUIRES a `durable()` probe: the compiler asks for the gate, rather than a
 *  convention nobody re-reads asking for it. See #491 for the failure this prevents, and
 *  `../storage/prefsDocStore.ts` for why reading a value back does NOT prove it was stored.
 *
 *  ## Layering
 *
 *  L2, and it imports no other L2 folder — in particular not `storage/`. A game hands in a
 *  `GroupStore` and this module never learns what backs it, exactly the structural-typing inversion
 *  `storage/prefsDocStore.ts` and `iap/ledger.ts` already use. Pure and clock-free: every clock
 *  reading arrives as a parameter, so the determinism guard is satisfied by construction.
 */

/** The device-local sync bookkeeping for ONE group. Never uploaded — `lastSyncedVersion` is this
 *  device's claim about what the server acknowledged, and is meaningless to any other device. */
export interface GroupMarks {
  /** The version this device last actually EXCHANGED with the server — uploaded and accepted, or
   *  downloaded and adopted. `0` = never synced.
   *
   *  ⚠️ Only ever advanced on ACKNOWLEDGEMENT, never optimistically. Marking a rejected write as
   *  synced is how a device comes to believe the server holds writes it never received. */
  lastSyncedVersion: number;
  /** `fingerprint()` of the content at that exchange. Content differing from it IS the definition of
   *  "there are local writes the server has not seen".
   *
   *  ⚠️ **Derived, never maintained.** A dirty COUNTER has two failure modes that both lose data
   *  silently: a write path that forgets to bump it (the repo's dominant defect class — a mechanism
   *  that never fires), and a torn write leaving a counter describing data it never saw. A
   *  fingerprint has neither: nothing has to remember it, and a tear is safe in both directions —
   *  lose the marks and the group merely looks dirty and re-uploads; lose the content and the
   *  fingerprint still describes what is actually stored.
   *
   *  An unrecognised or missing value must read as DIRTY. A redundant upload costs a round trip; a
   *  missed one costs the save. */
  lastSyncedFingerprint: string;
  /** The account these marks describe.
   *
   *  ⚠️ **Without this, signing out of one account and into another SILENTLY OVERWRITES the second
   *  account's cloud save.** Carry account A's `lastSyncedVersion: 7` into a sign-in as B whose
   *  document is at v3, and the rollback branch of `decideGroup` pushes A's content into B's document
   *  at v4. No fork, no dialog, B's save gone. Deriving the answer from a STORED uid beats clearing
   *  the marks on sign-out for the same reason the fingerprint beats a counter: nothing has to
   *  remember to clear them. */
  uid: string;
  /** Wall-clock ms of the last acknowledged exchange — what a "Backed up 2 hours ago" line reads.
   *
   *  ⚠️ Not `updatedAt`. `updatedAt` is when the content was last WRITTEN, which on an offline
   *  device keeps advancing while nothing reaches the cloud at all — reporting it as the backup time
   *  tells a player their progress is safe at the exact moment it is not. */
  lastSyncedAt: number;
}

/** Marks for a group that has never exchanged anything with anyone. */
export function emptyMarks(): GroupMarks {
  return { lastSyncedVersion: 0, lastSyncedFingerprint: '', uid: '', lastSyncedAt: 0 };
}

/** Has this group ever completed an exchange with the server?
 *
 *  ⚠️ Both halves, not just the version: `take-server` is reachable BOTH by a fingerprint matching
 *  the marks and by the fresh-install fast path in `hasLocalWrites`. A caller that re-decides after
 *  an await must be able to tell those apart — re-deciding is right for the first and catastrophic
 *  for the second. */
export function neverSynced(marks: GroupMarks): boolean {
  return marks.lastSyncedVersion === 0 && marks.lastSyncedFingerprint === '';
}

/** One group as stored on the device: content, the version it is at, and the marks. Read and written
 *  as ONE unit — that is what makes a single-key group's mark atomic with its content. */
export interface LocalGroup<T> {
  content: T;
  /** The version this group's document is at. `0` = never written anywhere. */
  version: number;
  /** Wall-clock ms at the moment this group was last WRITTEN. Ordering for a dialog to render, never
   *  the protocol's ordering — `version` is that. */
  updatedAt: number;
  marks: GroupMarks;
}

/** One group as stored in the cloud. The marks are absent by construction: they never leave the
 *  device, so there is no field here for a caller to forget to strip. */
export interface CloudGroup<T> {
  content: T;
  version: number;
  updatedAt: number;
}

/** Read and write one group's local state.
 *
 *  ⚠️ `read()` may not be pure — a game's reader can legitimately seed a default as a side effect
 *  (Court's wallet grants a new player their starting coins on first read). Callers must not treat
 *  repeated reads as free, and `isFreshAndEmpty` must account for whatever the seed produces. */
export interface GroupStore<T> {
  read(): LocalGroup<T>;
  /** Write content and marks TOGETHER. A single-key implementation must perform exactly one
   *  underlying write, or the atomicity this contract is built on does not exist. */
  write(next: LocalGroup<T>): void;
  /** Push pending writes to the platform. Resolving is NOT an fsync on any backend — it means the
   *  platform has ACCEPTED the write. That is exactly the signal `GroupAtomicity`'s `durable()`
   *  probe then interrogates, and the reason a multi-key group needs two writes rather than one. */
  flush(): Promise<void>;
}

/** How a group behaves when both sides have moved and the saves have genuinely forked. */
export type ForkPolicy =
  /** Raise the question. The player's single answer applies to every asking group — see
   *  `SyncGroup.onFork` for why a group should earn this rather than default to it. */
  | 'ask'
  /** Take the server silently. For a group whose local side is never worth defending. */
  | 'take-server'
  /** Take whichever side has the later `updatedAt`, silently.
   *
   *  ⚠️ This puts a WALL CLOCK in charge of the outcome, so it is only safe for a group where a
   *  wrong device clock can lose nothing the player would miss — a preference, not a balance and not
   *  progress. */
  | 'take-newer';

/** What the player chose. Two arms and deliberately no third "combine": a three-way choice on a
 *  two-way question is how a dialog stops being read, and a merge is only safe if EVERY field has a
 *  defined merge rule. Fields exempt from the choice are handled by the group's own `merge`. */
export type ConflictChoice = 'local' | 'server';

/** The atomicity a group's storage actually provides, and the gate a weaker one owes.
 *
 *  ⚠️ Do not reach for `'multi-key'` because it is easier to declare. The single-key form is what
 *  makes the mark atomic with the content it describes, and the engine's own storage contract says
 *  so directly: *"state that must change together goes under ONE key"* (`../storage/playerPrefs.ts`).
 *  `'multi-key'` exists for a group that genuinely cannot be consolidated, and it buys back safety
 *  with a runtime probe rather than with a guarantee. */
export type GroupAtomicity =
  | { kind: 'single-key' }
  | {
      kind: 'multi-key';
      /** `false` when ANY of the group's keys still has an unlanded write. The marks are withheld
       *  until this is true, so the group is never left holding a receipt for content that was
       *  rejected.
       *
       *  ⚠️ **This is why a multi-key group costs TWO writes.** The runner writes the content with
       *  the marks left UNADVANCED, flushes, probes here, and only then writes the advanced marks.
       *  A single-key group needs none of that — its one write carries both or neither.
       *
       *  ⚠️ **Reading the content back does NOT answer this.** A rejected backend write is re-queued
       *  while the in-memory cache keeps returning the value — a read-back check confirms itself.
       *  The pending-write flag is the only signal that distinguishes them
       *  (`../storage/prefsDocStore.ts`). */
      durable(): boolean;
    };

/** Everything the sync layer needs to know about one group. Construct with `defineSyncGroup`. */
export interface SyncGroupSpec<T> {
  /** The cloud document id for this group. Stable for the life of the group.
   *
   *  ⚠️ **Renaming this orphans the old document**, which no client can then reach — account
   *  deletion enumerates the account's documents rather than trusting this list, precisely so a
   *  rename cannot leave undeleted user data behind. */
  id: string;
  store: GroupStore<T>;
  /** A stable serialization-and-hash of the CONTENT only. Two devices holding the same content must
   *  produce the same value, so ordering-insensitive fields must be sorted.
   *
   *  ⚠️ Exclude anything that changes without the player acting (an ad cooldown, a re-anchored
   *  clock). Including such a field makes a device read dirty for a non-event, which can raise a
   *  fork dialog whose entire content is a timestamp. */
  fingerprint(content: T): string;
  /** "This group has nothing worth protecting" — a never-synced device holding only defaults.
   *
   *  ⚠️ **Account for whatever `store.read()` SEEDS.** If reading grants a default, the content of a
   *  brand-new device is never byte-identical to an empty one, and a predicate written as "equals
   *  empty" reports every fresh install as dirty. That turns a silent adopt into the "choose between
   *  nothing and your progress" dialog — which a reflex tap on *keep this device* then answers by
   *  uploading the empty save over a real account. */
  isFreshAndEmpty(content: T): boolean;
  /** Resolve a genuine fork. Only consulted when `onFork` is `'ask'` and the player has answered.
   *  Fields exempt from the choice (a purchase, an unioned record set) are merged here on BOTH arms
   *  — the choice adjudicates progress, not everything. */
  merge(local: LocalGroup<T>, server: CloudGroup<T>, choice: ConflictChoice): T;
  /** Resolve the SILENT adopt — the server moved and this group has nothing unsynced.
   *
   *  ⚠️ **A separate hook from `merge`, and the difference is load-bearing.** This path fires only
   *  when there is nothing local to preserve, so a union here can preserve nothing — and after a
   *  sign-out it actively LEAKS, folding the previous account's content into the new one's document,
   *  with no inverse. A union belongs on the fork path, which is one player's account by definition.
   *  Anything genuinely exempt from the choice (a restored purchase this device holds and the server
   *  has never seen) is the one thing that belongs here.
   *
   *  `upload: true` means the result holds something the server does not, so the adopt owes an
   *  upload. */
  adopt(local: LocalGroup<T>, server: CloudGroup<T>): { content: T; upload: boolean };
  onFork: ForkPolicy;
  atomicity: GroupAtomicity;
}

/** A group with its element type erased, so a heterogeneous set can be driven by one loop. Every
 *  value handed back to a group came out of that same group, so the erasure is sound. */
export type AnySyncGroup = SyncGroupSpec<never>;

/** Declare a group. The only reason this exists rather than an object literal is the erasure above —
 *  it keeps `T` checked at the declaration site and absent from the runner. */
export function defineSyncGroup<T>(spec: SyncGroupSpec<T>): AnySyncGroup {
  return spec as unknown as AnySyncGroup;
}

/** The I/O one sync needs, per document. Injected so the protocol is testable with fakes rather than
 *  against a live backend — which is what makes conflict resolution, the genuinely hard part,
 *  deterministic. */
export interface GroupTransport {
  /** One group's document, or `null` if the account has none yet.
   *
   *  ⚠️ `null` means "no document", NEVER "could not read". A read failure must THROW: treating an
   *  offline read as "no save" lets a device conclude it is a fresh account and overwrite a real
   *  one. */
  load(groupId: string): Promise<CloudGroup<unknown> | null>;
  /** Attempt a write. `'conflict'` means the server's compare-and-swap REJECTED it — another device
   *  wrote first — which is a normal race outcome, not an error: re-read and decide again. */
  push(groupId: string, doc: CloudGroup<unknown>): Promise<'ok' | 'conflict' | 'failed'>;
}
