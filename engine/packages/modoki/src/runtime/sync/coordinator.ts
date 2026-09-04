/** WHEN a cloud sync runs (#361; promoted out of the worked example in #658).
 *
 *  The protocol (`runGroupSync.ts`) decides what a sync does; the GAME's adapter performs it. This
 *  module owns the third question, which is easy to get wrong in ways nothing tests: *when*, and
 *  *what happens when two triggers overlap*.
 *
 *  Pure coordination — no ECS, no Capacitor, no PlayerPrefs, no timers of its own. Every dependency
 *  is injected, so the awkward cases below (a burst of triggers, a sync landing while another is in
 *  flight, an unanswered conflict) are tested deterministically instead of with sleeps.
 *
 *  ## Why this is document-agnostic, and how to keep it that way
 *
 *  ⚠️ **Nothing here ever reads a field off a save document.** The coordinator routes a fork's
 *  `serverDoc` straight back to the game's own `resolve`, and otherwise reads only `kind`, `forks`
 *  and `groupId`. That is the entire reason `TFork` can be a type parameter rather than a game's
 *  save type — and it is a constraint to PRESERVE, not an observation about today: the moment
 *  something in this file dereferences a game's save, the parameter stops meaning anything and this
 *  module belongs back in that game.
 *
 *  ## Layering
 *
 *  L2, importing no other L2 folder — its own `./types` for `ConflictChoice`, and L0
 *  `core/liveness` for the shared teardown token (#573). Clock-free and timer-free by
 *  construction: `schedule` arrives as a dependency, so the determinism guard is satisfied without
 *  an allowlist entry.
 *
 *  ## The three rules that matter
 *
 *  1. **A pending conflict SUPPRESSES further syncs.** Once the player has been asked, asking again
 *     from the next trigger would stack dialogs over a decision they are already making. The
 *     question stays open until answered.
 *  2. **Overlapping triggers COALESCE, they do not queue up.** Backgrounding the app while a sync
 *     is in flight should run one more sync afterwards, not one per trigger — the save is a single
 *     document and N syncs of it are N-1 wasted round trips on a player's data plan.
 *  3. **A failed sync is never fatal.** The save is still on the device. Cloud save is an addition
 *     to local storage, not a replacement for it, and every failure path here is a no-op rather
 *     than an error the player sees.
 */

import { createTeardownToken } from '../core/liveness';
import type { ConflictChoice } from './types';

/** Why a sync was asked for. Carried into the log line so a device trace says which trigger fired,
 *  which is otherwise unrecoverable after the fact. */
export type SyncReason = 'sign-in' | 'resume' | 'background' | 'progress' | 'manual';

/** The MINIMUM the coordinator needs to know about one asking fork: which group forked, and the
 *  server document that group's choice will be resolved against.
 *
 *  A game's own fork type extends this with whatever its dialog renders — summary rows, labels, a
 *  headline. None of that is named here on purpose: the coordinator hands `serverDoc` back to the
 *  game untouched, so `unknown` is not a weakening, it is the honest type. `TFork['serverDoc']`
 *  recovers the game's real document type at the `resolve` seam below. */
export interface SyncFork {
  groupId: string;
  serverDoc: unknown;
}

/** The unanswered fork(s), waiting on the player — one entry per group that actually forked
 *  (#532 C5). `SyncOutcomeOf`'s `'ask'` arm carries the identical list; this alias exists so a
 *  game's wiring can name "what the dialog renders from" without spelling out `TFork[]` at every
 *  call site. */
export type PendingConflict<TFork extends SyncFork> = TFork[];

/** What one sync did.
 *
 *  ⚠️ **No `save` field — the content is on DISK by the time a caller sees this** (the group's
 *  `GroupStore` wrote it). A copy of the save travelling beside the stored one is a second source of
 *  truth for the same fact; the pre-#532 shape had one, and nothing outside the game's own adapter
 *  ever read it.
 *
 *  ⚠️ **`version` and `replacedLocal` have no production reader, and that is deliberate** — they are
 *  the payload of the deliberately unwired `CloudSyncDeps.onOutcome`, reserved for **analytics**
 *  (owner, 2026-09-02, #576 item 3). **Reserved, not dead: do not delete them, and do not
 *  re-justify them with a consumer that does not exist.** An earlier banner claimed `version` was
 *  "what a caller can meaningfully act on"; that was false, and the false claim is what made this
 *  pair read as live code to one sweep and as dead code to another. */
export type SyncOutcomeOf<TFork extends SyncFork> =
  | { kind: 'idle' }
  /** `replacedLocal` means this upload also carries content ADOPTED from the server, so the caller
   *  knows the device's content changed and not only its marks.
   *
   *  ⚠️ It exists because the two are separable and one path does both. A `take-server` that also
   *  has a local purchase to push adopts the server document and then uploads it; without this flag
   *  the caller took the `'uploaded'` branch, wrote MARKS ONLY, and left the server's progress off
   *  the device while claiming to have synced it — after which the device read dirty against its
   *  own stale content and pushed it back, destroying the other device's progress. */
  | { kind: 'uploaded'; version: number; replacedLocal?: true }
  | { kind: 'adopted'; version: number }
  /** The saves have forked, in one or more groups. Nothing is written — the player decides ONCE
   *  (ruling 4), then the caller applies the game's own per-group resolve and pushes each.
   *
   *  ⚠️ **`forks` is a LIST, one entry per group that actually reported `'fork'`, never one per
   *  DECLARED group (#532 C5, F5).** A group that forked but resolves silently (`onFork:
   *  'take-newer'`) or did not fork at all has no entry — rendering a row for it would tell the
   *  player it is at stake when it is not, the exact lie F5 forbids. */
  | { kind: 'ask'; forks: TFork[] }
  | { kind: 'failed'; reason: string };

export interface CloudSyncDeps<TFork extends SyncFork> {
  /** The signed-in account's uid, or `null`. Read per call rather than captured: sign-out during
   *  an in-flight sync is a real sequence, and a captured uid would write to the wrong account. */
  currentUid: () => string | null;
  /** Run one sync. The game's own `syncNow`, bound to its cloud transport. */
  sync: () => Promise<SyncOutcomeOf<TFork>>;
  /** Apply the player's answer for ONE asking group, resolved against THAT group's own server
   *  document. The game's own `resolveSyncConflict`. `answer()` below calls this once per entry in
   *  `pending` — ruling 4's single choice, applied to every asking group independently.
   *
   *  `serverDoc` is reached through `TFork` rather than declared here, so the game's real save type
   *  arrives at this seam without this module ever naming it. */
  resolve: (
    groupId: string,
    serverDoc: TFork['serverDoc'],
    choice: ConflictChoice,
  ) => Promise<SyncOutcomeOf<TFork>>;
  /** Defer work. Injected so a test drives the clock instead of waiting on it. */
  schedule: (ms: number, fn: () => void) => void;
  /** Told about every outcome.
   *
   *  ⚠️ **UNWIRED ON PURPOSE — the worked example supplies no `onOutcome`, and that is a decision,
   *  not an oversight** (owner, 2026-09-02, #576 item 3). Its only supplier is this module's own
   *  test; the sole production construction passes `currentUid`/`sync`/`resolve`/`schedule` and
   *  stops there. It is kept as headroom for **analytics** to consume sync outcomes.
   *
   *  This docstring used to claim it was "the hook the UI uses to show a conflict or a 'synced'
   *  tick" — there is no such UI, and the conflict dialog is raised through a different path
   *  entirely (the game's own `pendingSyncConflict` → its account chrome). That false claim is what
   *  made the hook and its payload read as live code: #572's sweep found them and reported them as
   *  dead. **They are not dead, they are reserved — do not delete them, and do not re-describe them
   *  as serving a consumer that exists.** */
  onOutcome?: (outcome: SyncOutcomeOf<TFork>, reason: SyncReason) => void;
}

/** How long a burst of progression writes is coalesced before syncing.
 *
 *  A structural constant, not a tuning knob: it exists because solving a level writes progress,
 *  wallet and rating in the same frame, and syncing three times for one solve is three uploads of
 *  the same document. It is not a value the owner would want different after seeing it on screen —
 *  nothing about it is visible — so it stays in code (see CLAUDE.md's authored-values rule).
 *
 *  ⚠️ **That argument was made about ONE game's write cadence, and this is now every game's
 *  window.** `schedule` injects the timer but not the length. A second game whose progression
 *  writes burst on a different rhythm takes this as a `deps` field rather than forking the module
 *  — but it stays a constant until one actually does, because a knob with one caller is a guess. */
const PROGRESS_DEBOUNCE_MS = 2_000;

/**
 * Combine one `SyncOutcomeOf` per asking group, resolved in `answer()`, into the single outcome the
 * UI is told about (#532 C5). Priority order, applied across the WHOLE set rather than picking
 * whichever group happened to resolve last:
 *
 * 1. Any group that re-forked (`'ask'`) wins — a fresh question left unanswered is worse than a
 *    stale verdict about the question the player already answered. Its forks are pooled, so a
 *    player who answered a two-group fork and had ONE of them re-fork under them is shown a fresh
 *    dialog for exactly that group, not both.
 * 2. Otherwise, any group whose answer failed to reach the server (`'failed'`) wins — the choice for
 *    THAT group is still safe on the device (`resolveGroupFork`'s guarantee) and will retry on the
 *    next sync, but reporting a plain success would hide that a group is still unsynced.
 * 3. Otherwise every group landed: report the strongest positive signal, `'adopted'` over
 *    `'uploaded'` over `'idle'`, deterministically — not "whichever group ran last".
 */
function combineResolveResults<TFork extends SyncFork>(
  results: readonly SyncOutcomeOf<TFork>[],
): SyncOutcomeOf<TFork> {
  const freshForks = results.flatMap((r) => (r.kind === 'ask' ? r.forks : []));
  if (freshForks.length > 0) return { kind: 'ask', forks: freshForks };
  const failed = results.find(
    (r): r is Extract<SyncOutcomeOf<TFork>, { kind: 'failed' }> => r.kind === 'failed',
  );
  if (failed) return failed;
  for (const kind of ['adopted', 'uploaded', 'idle'] as const) {
    const hit = results.find((r) => r.kind === kind);
    if (hit) return hit;
  }
  return results[0] ?? { kind: 'idle' };
}

/**
 * Normalize what a game's `sync`/`resolve` handed back, AT THE BOUNDARY — before any of this
 * module's three `kind === 'ask'` reads see it.
 *
 * ⚠️ **An `'ask'` carrying no forks is a CONTRACT VIOLATION, and the only safe reading of it is
 * "nothing happened".** `forks` is typed as a plain array with no non-empty floor, so a second
 * game's `sync`/`resolve` can produce one; every consequence of letting it through is silent:
 *
 * - installed as `pending`, `[]` is truthy — the UI gets a conflict with no rows, rule 1's
 *   suppression latches on every later trigger, and `answer()` bails on `length === 0` WITHOUT
 *   clearing it, so only a sign-out recovers;
 * - reported as `'ask'` while `conflict()` is `null` — a caller writing the obvious
 *   `if (o.kind === 'ask') show(c.conflict()!)` gets `null` past its assertion, and the reserved
 *   `onOutcome` analytics payload records a dialog the player was never shown;
 * - returned from a `resolve()`, it ENDS `answer()`'s loop (the `break` below), so a second asking
 *   group's answer is never applied — the one case that loses the player's actual input.
 *
 * ⚠️ **Normalized ONCE here rather than guarded at each of the three reads.** The per-read guard
 * was written first and missed the `break` — three sites that must each remember the same clause is
 * exactly how that happens (#658 close-out review, F2). Loud + degrade, the same posture
 * `resolveRef` takes on a bad asset ref: the contract breach is not silently tolerable, but it must
 * not take the game down either. NOT `'failed'` — that means "retriable transport error" everywhere
 * else here, and would drive a game's status row to "sync failed" for something that neither failed
 * nor wrote anything.
 */
function normalizeOutcome<TFork extends SyncFork>(o: SyncOutcomeOf<TFork>): SyncOutcomeOf<TFork> {
  if (o.kind === 'ask' && o.forks.length === 0) {
    console.error(
      "[sync] a coordinator dependency returned { kind: 'ask', forks: [] }. An ask with no forks " +
      'is a contract violation — there is no fork to show and nothing to resolve. Treating it as ' +
      "idle. Build the 'ask' only from the groups that actually forked.",
    );
    return { kind: 'idle' };
  }
  return o;
}

export class CloudSyncCoordinator<TFork extends SyncFork> {
  private pending: PendingConflict<TFork> | null = null;
  private inFlight = false;
  /** A trigger that arrived mid-sync. One bit, not a queue — see rule 2. Stamped with the
   *  generation it arrived under (#506): `reset()` clears this bit, so anything left in it once a
   *  dead run resumes was necessarily set AFTER the reset — but that trigger still deserves to run,
   *  even though the `run()` call resuming to dispatch it is itself dead. Comparing the bit's own
   *  `gen` against the CURRENT generation (not the dead run's captured one) is what lets it through
   *  instead of being dropped along with the dead run's outcome. */
  private again: { reason: SyncReason; gen: number } | null = null;
  private debouncing = false;
  /** Invalidated by `reset()`. A boolean "was reset" flag cannot tell a sign-out apart from a
   *  sign-out-then-sign-in-as-another-account — both would read as "reset happened" — so every
   *  async path captures liveness before its await and checks it after, before writing anything
   *  back (#506).
   *
   *  ⚠️ **A TEARDOWN token, not a supersession one, and the difference is the whole semantics**
   *  (#573, `docs/async-lifetime.md`): this counter bumps on INVALIDATION (a sign-out), not on the
   *  start of each attempt. A supersession token would make every overlapping sync cancel the one
   *  before it, which is precisely what rule 2's coalescing must NOT do.
   *
   *  ⚠️ **Used BOTH ways on purpose** — the "composed, not substituted" case `liveness.ts` names.
   *  Three sites take a `capture()`, which is the ordinary before/after-await question. The
   *  `again` bit above instead stamps the RAW `.generation` and compares it against the current
   *  value later, which a `capture()` cannot express: a capture asks "is my session still live",
   *  and that bit deliberately asks the opposite question — "did this trigger arrive AFTER the
   *  reset", so it survives a dead run rather than dying with it. */
  private readonly liveness = createTeardownToken();

  /** Declared explicitly rather than as a constructor parameter property: the repo builds with
   *  `erasableSyntaxOnly`, which forbids the shorthand (it emits code rather than erasing). */
  private readonly deps: CloudSyncDeps<TFork>;

  constructor(deps: CloudSyncDeps<TFork>) {
    this.deps = deps;
  }

  /** The unanswered fork(s), if any — one entry per group that actually forked (#532 C5). The UI
   *  renders from this. */
  conflict(): PendingConflict<TFork> | null {
    return this.pending;
  }

  /** Ask for a sync. Returns what happened, or `null` when the request was deliberately dropped
   *  (signed out, a conflict is waiting, or it was folded into an in-flight run). */
  async request(reason: SyncReason): Promise<SyncOutcomeOf<TFork> | null> {
    if (!this.deps.currentUid()) return null;
    // Rule 1: never ask twice about the same fork.
    if (this.pending) return null;

    if (reason === 'progress') {
      if (this.debouncing) return null;
      this.debouncing = true;
      // Liveness is captured HERE, not read fresh when the timer fires: the closure belongs
      // to the session that scheduled it, and a sign-out landing during the debounce window must
      // not sync on the next player's behalf (#506) — `currentUid()`'s guard only covers
      // `request()` itself, and this callback reaches `run()` directly.
      const stillLive = this.liveness.capture();
      this.deps.schedule(PROGRESS_DEBOUNCE_MS, () => {
        // Liveness checked BEFORE clearing `debouncing` — review finding 2. A dead timer (its
        // session already reset) still owes a lock release for the account that scheduled it, but
        // that release must not touch the LIVE session's own latch: clearing it unconditionally
        // here unlatched a debounce window that belonged to whoever is signed in now, so their next
        // same-burst trigger was no longer swallowed — two uploads of one document, not one.
        // `reset()` already clears `debouncing` for the dead session, so a stale timer has nothing
        // of its own left to clear.
        if (!stillLive()) return;
        this.debouncing = false;
        // Rule 1: a pending conflict suppresses further syncs. Every OTHER dispatch site guards
        // with `!this.pending` (`request`'s own check above, `answer`'s cleared-before-await); this
        // closure reaches `run()` directly, and `run()` has no such check on its own — review
        // finding 3. Left unguarded, a timer firing while the player is looking at a conflict
        // dialog silently replaces `pending` with whatever fork the sync raises next, and the
        // player ends up answering a fork they were never shown.
        if (this.pending) return;
        void this.run('progress');
      });
      return null;
    }
    return this.run(reason);
  }

  private async run(reason: SyncReason): Promise<SyncOutcomeOf<TFork> | null> {
    // Rule 2: coalesce. A trigger arriving mid-sync sets one bit; the run that is already going
    // re-runs once at the end, however many triggers landed. The bit is stamped with the CURRENT
    // generation, read fresh here — not the captured `gen` below, which belongs to this (possibly
    // dying) call — see the `again` field's docblock (#506).
    if (this.inFlight) { this.again = { reason, gen: this.liveness.generation }; return null; }
    this.inFlight = true;
    // Captured BEFORE the await — see the `liveness` field's docblock. `inFlight` is a
    // re-entrancy lock, not an identity token, so it says nothing about which account started
    // this call (#506).
    const stillLive = this.liveness.capture();
    let outcome: SyncOutcomeOf<TFork>;
    try {
      outcome = normalizeOutcome(await this.deps.sync());
    } catch (e) {
      // Rule 3. `syncNow` already promises not to throw; this is the belt to its braces, because a
      // rejection escaping here would leave `inFlight` stuck true and silently kill every later
      // sync for the rest of the session.
      outcome = { kind: 'failed', reason: `sync threw: ${String(e)}` };
    } finally {
      // Unconditional — this is a LOCK release, not a write-back. It must happen whether or not
      // the session that started this call is still live, or a dropped result would leave the
      // lock stuck and silently kill every later sync (the same failure Rule 3 guards above).
      this.inFlight = false;
    }

    // The account that asked for THIS sync is gone (a sign-out, or a sign-out-then-sign-in-as-
    // another-account landed while `sync()` was in flight). This outcome belongs to nobody on
    // screen now — don't install it, don't tell the UI about it (#506).
    const stale = !stillLive();
    if (!stale) {
      // Safe to install unconditionally: `normalizeOutcome` has already turned an empty `'ask'`
      // into `'idle'` at the boundary, so an `'ask'` reaching here always carries at least one
      // fork. See that function for why the check lives there and not at this read.
      if (outcome.kind === 'ask') {
        this.pending = outcome.forks;
      }
      this.deps.onOutcome?.(outcome, reason);
    }

    // A follow-up trigger is a SEPARATE question from this outcome, and what lets it through is
    // that it is judged by a DIFFERENT variable than `stale` — not by the comparison below, which
    // is tautological (`reset()` is the only writer of the generation and nulls `again` in the same
    // synchronous block, so a non-null `again` always carries the current generation). Keep them
    // separate: a trigger that arrived after the reset belongs to whoever is signed in right now
    // and is owed a sync, even though this `run()` call resuming to dispatch it is itself dead
    // (#506). Collapsing the follow-up onto `stale` is the mistake this shape exists to prevent.
    const followUp = this.again;
    this.again = null;
    if (followUp && followUp.gen === this.liveness.generation && !this.pending) void this.run(followUp.reason);

    return stale ? null : outcome;
  }

  /**
   * Apply the player's answer to every asking group's fork (#532 C5 — ruling 4: one choice, applied
   * to each independently, resolved against ITS OWN server document).
   *
   * ⚠️ Clears `pending` BEFORE awaiting. Leaving it set across the await would make the dialog
   * un-dismissable if the push is slow, and — worse — a trigger arriving mid-resolve would be
   * suppressed by rule 1 against a conflict that is already being answered.
   */
  async answer(choice: ConflictChoice): Promise<SyncOutcomeOf<TFork> | null> {
    const forks = this.pending;
    if (!forks || forks.length === 0) return null;
    this.pending = null;
    // ⚠️ Holds the in-flight lock for the whole resolve — every group's, not just the first's.
    // Without it, a `background` trigger arriving during a slow push passed both guards (no pending,
    // not in flight), ran `sync()` CONCURRENTLY with `resolve()`, read a server still on the old
    // version, and raised a NEW conflict about the fork the player had just answered — so the dialog
    // reappeared for a settled question and the second answer pushed again (close-out review,
    // finding 5).
    this.inFlight = true;
    // Captured BEFORE the await — see the `liveness` field's docblock (#506).
    const stillLive = this.liveness.capture();
    try {
      // Sequential, not `Promise.all` — one group's resolve can internally re-enter a FULL `syncNow`
      // pass covering every group (the game's own resolve absorbs a `'restart'` this
      // way), so resolving two groups concurrently would race that recursive sync against a sibling
      // group's own push. One at a time keeps every write ordered.
      const results: SyncOutcomeOf<TFork>[] = [];
      for (const fork of forks) {
        const outcome = normalizeOutcome(await this.deps.resolve(fork.groupId, fork.serverDoc, choice));
        // The player who answered is gone (signed out, or signed out and back in as someone else,
        // while THIS group's resolve was in flight). Their answer already left `pending` cleared
        // above; don't push the NEXT group's resolve for an account that is no longer signed in, and
        // don't re-install a conflict, report an outcome, or chase a follow-up on their behalf.
        if (!stillLive()) return null;
        results.push(outcome);
        // ⚠️ **A fresh `'ask'` ENDS the loop, and that is a correctness rule rather than an
        // optimisation** (#532, C4c-2 review finding 6). `resolveSyncConflict` absorbs a
        // `'restart'` by re-entering a FULL `syncNow` pass — over EVERY group, not just this one —
        // so an `'ask'` coming back here already describes the current state of all of them. The
        // remaining entries in `forks` are questions about a state that no longer exists, and their
        // `serverDoc`s were captured before that re-sync: resolving them would push the player's
        // answer at a version the server has moved past, and would let `combineResolveResults` pool
        // two entries for the SAME group id — one from the re-sync, one stale — which
        // `syncAccountChrome` would then render one of arbitrarily, and the next `answer()` would
        // resolve that group twice.
        //
        // Self-limiting even without this (the stale push conflicts and restarts, and the content
        // is idempotent), so this is not a live data bug — it is a reachable state C4c-2 created by
        // making two asking groups possible, closed at the point it becomes reachable rather than
        // left for someone to rediscover from a duplicated dialog row.
        if (outcome.kind === 'ask') break;
      }
      // ⚠️ **Deliberate decision, because "report the last group's outcome" is not one** (#532 C5).
      // A THIRD write can have landed on any one group's document while the dialog was open, in
      // which case that group's resolve returns a NEW fork about the new state — those are fresh
      // questions, not the ones just answered, and take priority: if ANY group re-forked, the
      // combined outcome is `'ask'` over exactly the groups that did, so the player is shown the new
      // question rather than a success/failure verdict that ignores it. Otherwise, if any group's
      // answer failed to reach the server, the combined outcome is `'failed'` — the player's choice
      // for THAT group is still safe on the device (`resolveGroupFork`'s own guarantee) and will
      // retry on the next sync, but reporting success would hide that a group is still unsynced.
      // Only when every group's answer landed cleanly does this report a success, picking the
      // strongest signal (`'adopted'` over `'uploaded'` over `'idle'`) rather than whichever group
      // happened to resolve last.
      const outcome = combineResolveResults(results);
      // Same as `run()`'s install: every `results[]` entry came through `normalizeOutcome`, and
      // `combineResolveResults` only emits an `'ask'` when `freshForks` is non-empty, so this
      // cannot install an empty list.
      if (outcome.kind === 'ask') {
        this.pending = outcome.forks;
      }
      this.deps.onOutcome?.(outcome, 'manual');
      return outcome;
    } catch (e) {
      if (!stillLive()) return null;
      return { kind: 'failed', reason: `resolve threw: ${String(e)}` };
    } finally {
      // Unconditional — a lock release, not a write-back (same reasoning as `run()`'s finally).
      this.inFlight = false;
      // A trigger that arrived while the player was deciding is honoured now, not dropped — the
      // app may have been backgrounded and resumed across the dialog. Judged by a DIFFERENT
      // variable than `stillLive` (see `run()`'s comment for why the generation compare itself is
      // tautological): a trigger that arrived for a NEW account while this answer() was still
      // resolving the OLD one's conflict is still owed its sync, even though this call itself is
      // dropping everything else (#506).
      const followUp = this.again;
      this.again = null;
      if (followUp && followUp.gen === this.liveness.generation && !this.pending) void this.run(followUp.reason);
    }
  }

  /** Drop all state — sign-out, or the debug "new user id". A conflict belongs to the account that
   *  raised it, so carrying it across a sign-out would ask the NEXT player about a save that is not
   *  theirs. */
  reset(): void {
    this.pending = null;
    this.again = null;
    this.debouncing = false;
    this.liveness.invalidateAll();
    // Invalidated, not just cleared — every async path in flight right now captured the OLD generation
    // before its await and checks it after, so whatever they were carrying (a conflict to install,
    // an outcome to report, a follow-up to chase) lands as a no-op instead of on the next player
    // (#506). Deliberately NOT touching `inFlight`: the sync/resolve call really is still running:
    // clearing the lock here would let a concurrent one start on top of it.
  }
}
