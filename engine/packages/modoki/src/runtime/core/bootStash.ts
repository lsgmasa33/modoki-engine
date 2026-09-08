/**
 * The ONE cross-boot telemetry stash (#861).
 *
 * ⚠️ THE CLASS THIS EXISTS TO CLOSE. Three buffers in this engine are filled early in boot and
 * delivered by something that runs LATER in the same boot, so a boot that dies in between loses
 * them silently:
 *
 *   | Buffer                      | Filled by                  | Delivered by                                |
 *   |-----------------------------|----------------------------|---------------------------------------------|
 *   | `__MODOKI_EARLY_ERRORS__`   | inline guard, `index.html` | `drainEarlyErrors()` ← install               |
 *   | `__MODOKI_EARLY_CONSOLE__`  | inline shim, `index.html`  | `drainEarlyConsole()` ← `installConsoleRing` |
 *   | `deliver()`'s `queued[]`    | `globalErrors.ts`          | `flushQueue()` ← `onAppServicesRegistered`   |
 *
 * #825 fixed the first ad-hoc, with its own key, its own envelope, its own staleness bound and its
 * own hand-guessed cap. Copy-pasting that shape twice more would have produced three envelopes and
 * **three independently guessed caps drawing on one undivided rate-limit budget** — which is the
 * documented failure mode of `globalErrors.ts`'s `MAX_PER_BURST_WINDOW` comment, arriving on
 * schedule. This module is the single envelope those three write into instead.
 *
 * ⚠️ THE BUDGET IS THE POINT, not the serialization. Every replay drains through the SAME shared
 * limiter (`MAX_PER_BURST_WINDOW`, `globalErrors.ts`) in one synchronous burst on the replaying
 * boot, and a cross-boot replay is a GUEST in that boot's budget — it must never be able to spend
 * the window the live boot needs to report its own crash. So there is ONE pool with ONE cap and ONE
 * drop count ({@link REPLAY_ENTRY_CAP}), not a sub-cap per source: a replaying boot does not care
 * which buffer a fault came from, and a single pool leaves nothing to guess per site.
 *
 * ⚠️ MEASURED, 2026-09-07 — the window boundary is NOT where #633/#825/#859/#860 say it is.
 * A `--target web` build of `games/sling`, served over HTTP: a top-level throw in a module in
 * `App.tsx`'s static import graph finds BOTH early buffers already drained (`done: true`), because
 * `main.tsx` imports `installErrorCapture`/`installConsoleRing` as side-effect imports ABOVE
 * `./App.tsx` and that source order survives the bundle. Only modules evaluated before
 * `main.tsx`'s `import './installErrorCapture'` line (`./sharedRegistry`, react, react-dom,
 * `./index.css`) are in the inline guard's window. **Everything in `App.tsx`'s graph reaches the
 * LIVE listener and dies in `queued[]` instead** — which is why {@link writeBootStash} exists on
 * this side at all, and why the console tail has two possible sources (see
 * {@link BootStashEnvelope.console}).
 */

import { rawEpochNow } from './clock';

/** ⚠️ `engine/index.html`'s inline guard is a SECOND writer of this envelope and cannot import
 *  anything (a bare `<script>`, no bundler). Rather than hand-syncing the literals — the
 *  arrangement that let `EARLY_ERROR_CAP` drift to 32, two OVER its headroom — the constants below
 *  are INJECTED into that script at build time by `engine/plugins/earlyConsoleShim.ts`.
 *  ⚠️ Precisely what is pinned, because the difference matters: `bootStash.test.ts` asserts (a) the
 *  HTML's DEFAULT literals already equal these constants, and (b) the plugin's `transformIndexHtml`
 *  actually rewrites a drifted literal. So changing a constant here alone turns the suite RED — the
 *  hand-sync is not removed so much as made LOUD, which is the real improvement over #825's silent
 *  drift. */
export const STASH_KEY = 'modoki-boot-stash';

/** ⚠️ #825's key, still READ so an upgrade does not throw away the fault it was written to save.
 *  Without this the v1 acceptance below is UNREACHABLE — a genuine pre-#861 build wrote v1 under
 *  THIS key, and the new reader only ever opened the new one, so the one launch that mattered (the
 *  user updates after a boot-killing crash) silently dropped the report and left the old key in
 *  `localStorage` forever. Read-and-remove only; nothing writes it any more. */
export const LEGACY_STASH_KEY = 'modoki-early-error-stash';

/** Envelope format version. `2` is the unified envelope; `1` was #825's errors-only stash, still
 *  ACCEPTED on read so a build upgrading across this change still reports the fault it stashed
 *  before the upgrade (a v1 payload simply carries no `console` tail). */
export const STASH_VERSION = 2;
const ACCEPTED_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

/** A fault from a version the user has long since updated past is noise, not a report — replaying
 *  it now would file it against the CURRENT app version and make an already-fixed bug look live. */
export const STASH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ⚠️ THE DIVIDED BUDGET. These three are the whole reason this module exists, and the invariant
 * binding them to the limiter is asserted by `bootStash.test.ts`:
 *
 *     REPLAY_ENTRY_CAP + CONSOLE_CONTEXT_SLOT + RESERVED_BREADCRUMBS <= MAX_PER_BURST_WINDOW / 3
 *
 * A THIRD of the window, not the arithmetic leftover. The worst case that bound rules out is a
 * previous boot's stash consuming the whole window and leaving the live boot unable to report its
 * own crash — and the overflow would be COMPLETELY silent, because a limiter refusal emits nothing
 * and clear-on-read has already destroyed the payload by then.
 *
 * ⚠️ ADDING A FOURTH REPLAY SOURCE MEANS RE-DERIVING THIS TOTAL, not appending another cap. The
 * test above goes red when the sum breaks the bound, which is the only thing that makes that
 * non-optional.
 */
export const REPLAY_ENTRY_CAP = 6;
/** The console tail replays as exactly ONE joined breadcrumb — never one event per line. That is
 *  what makes the tail affordable at all: #859's ring holds up to 256 lines, and the shared window
 *  is 30 events wide, so a line-per-event replay could not fit under any division of it. */
export const CONSOLE_CONTEXT_SLOT = 1;
/** Reserved: a `[reload]` breadcrumb that can already have spent a slot before the replay starts,
 *  plus the replay's own "N dropped" breadcrumb — which needs a slot or the cap that is supposed to
 *  make drops honest is itself silently refused. */
export const RESERVED_BREADCRUMBS = 2;

/** Field bounds for one persisted fault. Kept here (not in the HTML) so both writers agree. */
export const STASH_MAX_MESSAGE = 500;
export const STASH_MAX_STACK = 2000;
/** The joined console tail's character bound. Deliberately smaller than `globalErrors.ts`'s
 *  `MAX_MESSAGE_CHARS` (4000): this is the ONLY field whose size is driven by how chatty a boot
 *  happened to be, and it shares `localStorage` with the faults, which matter more. */
export const STASH_MAX_CONSOLE_CHARS = 2000;
/** How many trailing console lines the tail carries. A COUNT bound on top of the character bound
 *  above, because the two fail differently: 40 chatty lines blow the character budget, 40 terse
 *  ones would otherwise under-use it. Whichever binds first wins.
 *  ⚠️ Lives HERE because BOTH writers need it — `globalErrors.ts` for the ring-sourced tail and
 *  `engine/index.html` for the shim-sourced one. It was briefly duplicated in both, untagged, in
 *  the very change whose purpose was killing hand-synced literals. */
export const CONSOLE_TAIL_LINES = 40;

/** One persisted fault. DATA, not pre-formatted prose — `globalErrors.ts` owns the wording via its
 *  own `describe()`, and a second copy of that formatting in the HTML writer would drift. */
export interface StashedFault {
  kind: 'error' | 'unhandledrejection';
  message?: string;
  stack?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  ts?: number;
}

/**
 * One persisted report that is ALREADY formatted (#860's window).
 *
 * ⚠️ WHY THIS IS NOT A `StashedFault`. The two windows carry genuinely different payloads, and
 * flattening them into one shape would lose information rather than simplify. A window-1 fault is
 * raw fields, because `engine/index.html` cannot format — `globalErrors.ts` owns the wording via
 * `describe()`. A window-3 report has ALREADY been through `captureToCrashlytics`, so it is final
 * text that must not be re-prefixed, and it carries a `CaptureKind` (`warn` and `breadcrumb` are
 * both reachable there) that `StashedFault.kind` cannot express.
 *
 * They still share ONE cap and ONE drop count — see {@link REPLAY_ENTRY_CAP}. Separate arrays,
 * single pool: that is the invariant, not "a single array".
 */
export interface StashedReport {
  kind: 'error' | 'warn' | 'breadcrumb';
  text: string;
}

export interface BootStashEnvelope {
  v: number;
  /** Epoch at write time. Epoch, not `performance.now()` — "is this fault older than 7 days" is a
   *  genuinely elapsed-real-time question that a per-navigation monotonic clock cannot answer. */
  ts: number;
  /** Faults that never made it into `entries` — from the source buffer's own cap AND from
   *  {@link REPLAY_ENTRY_CAP} here. Both are "never reached Crashlytics", so both belong in one
   *  honest count rather than two that each tell half the story. */
  dropped: number;
  entries: StashedFault[];
  /** Pre-formatted reports from #860's window. Shares {@link REPLAY_ENTRY_CAP} with `entries` —
   *  the cap is on the TOTAL, so a boot that produced both cannot spend the pool twice. */
  reports?: StashedReport[];
  /**
   * The run-up to the crash: the console lines closest to the fault, already joined and truncated
   * into ONE string by the writer.
   *
   * ⚠️ TWO SOURCES, decided by how far boot got — this is the measured finding in the module
   * header. When `installConsoleRing()` has run, the lines are in the RING (the inline shim is
   * drained and empty), and `globalErrors.ts` reads them from there. When it has not, they are
   * still in the inline shim's buffer, and `engine/index.html` reads them from there. Same field,
   * same single slot, same budget — a fix sourcing this ONLY from the shim would have covered only
   * the rarer of the two windows while appearing to close both.
   */
  console?: string;
}

/** Clamp + join console lines into the single `console` field. Exported so both the ring-sourced
 *  and shim-sourced writers produce byte-identical shapes rather than two near-miss formats. */
export function joinConsoleTail(lines: readonly string[]): string {
  // Take from the END: the lines CLOSEST to the fault are the run-up that explains it, which is the
  // whole value #859 argues for. Trimming the head of an over-long tail keeps that property; a
  // head-first slice would keep the least relevant lines and drop the ones that matter.
  const joined = lines.join('\n');
  return joined.length > STASH_MAX_CONSOLE_CHARS ? joined.slice(-STASH_MAX_CONSOLE_CHARS) : joined;
}

/**
 * Read the stash and CLEAR it, in that order.
 *
 * ⚠️ Clear-on-read is load-bearing, not tidiness: it is what makes the replay ONCE-ONLY, so a
 * deterministic boot-killing crash cannot re-file the same fault on every launch forever. The cost
 * — accepted, and unchanged from #825 — is that if THIS boot also dies before the crashlytics sink
 * registers, the payload is lost with it. An unbounded re-file loop is the worse failure.
 *
 * Returns `null` for every degenerate case (absent, unparseable, wrong version, malformed, stale),
 * because a caller can do nothing different with any of them.
 */
export function readAndClearBootStash(): BootStashEnvelope | null {
  // No initializer: the try below always assigns before any read, and its catch returns — an
  // `= null` here is flagged dead by `no-useless-assignment`.
  let raw: string | null;
  try {
    raw = localStorage.getItem(STASH_KEY);
    if (raw !== null) localStorage.removeItem(STASH_KEY);
  } catch {
    return null; // private mode, disabled site data — nothing to replay, and nothing to clear
  }
  // ⚠️ ITS OWN try, and that is the whole point. Sharing the block above meant a throw on the
  // LEGACY read discarded the payload already taken off disk for the NEW key — read, cleared, and
  // thrown away in one call, losing a real crash report. Nothing here may endanger `raw`.
  try {
    // Fall back to #825's key, and clear it EITHER WAY — an upgrade must not leave a stale payload
    // behind under a key nothing reads again.
    const legacy = localStorage.getItem(LEGACY_STASH_KEY);
    if (legacy !== null) {
      localStorage.removeItem(LEGACY_STASH_KEY);
      if (raw === null) raw = legacy;
    }
  } catch {
    /* the legacy key is best-effort; never at the cost of the payload already in hand */
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // unparseable — noise, not a report
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const stash = parsed as Partial<BootStashEnvelope>;
  if (typeof stash.v !== 'number' || !ACCEPTED_VERSIONS.has(stash.v)) return null;
  if (!Array.isArray(stash.entries)) return null;
  if (typeof stash.ts !== 'number' || !Number.isFinite(stash.ts)) return null;
  if (rawEpochNow() - stash.ts > STASH_MAX_AGE_MS) return null;

  // ⚠️ Bounded HERE independent of what the stash CLAIMS to hold, and bounded across BOTH arrays
  // together. `REPLAY_ENTRY_CAP` at write time bounds a WELL-BEHAVED writer; a hand-edited,
  // corrupted or future-version payload could carry arbitrarily many of either, and the replay
  // must not scale with a length this module does not control. Enforcing the shared pool on READ
  // as well as on write is what makes "one cap" true of the thing that actually spends the budget.
  const entries = stash.entries.slice(0, REPLAY_ENTRY_CAP);
  const rawReports = Array.isArray(stash.reports) ? stash.reports : [];
  const reports = rawReports.slice(0, Math.max(0, REPLAY_ENTRY_CAP - entries.length));
  // What THIS truncation discarded is added to the writer's own count. Passing `dropped` through
  // unchanged contradicted its doc ("both belong in one honest count") and made an over-sized
  // payload lose entries with no breadcrumb saying so — a silent drop, which is the one thing this
  // budget exists to prevent.
  const truncated = (stash.entries.length - entries.length) + (rawReports.length - reports.length);
  const declared = typeof stash.dropped === 'number' && Number.isFinite(stash.dropped) ? stash.dropped : 0;

  return {
    v: stash.v,
    ts: stash.ts,
    dropped: declared + truncated,
    entries,
    reports,
    console: typeof stash.console === 'string' ? stash.console : undefined,
  };
}

/**
 * Write the envelope. The TS-side writer, for the window where the installers HAVE run and the
 * fault is sitting in `deliver()`'s in-memory queue (#860) — the inline guard cannot reach that
 * case at all (its own buffer is already drained and disarmed by then, and `queued[]` is module
 * state it has no handle on).
 *
 * ⚠️ Never throws. A telemetry write failing must not become a second fault on a boot that is
 * already failing — private mode, an exceeded quota and a hostile value all degrade to "no stash".
 */
/** ⚠️ Takes `reports` ONLY, never `entries`, and that asymmetry is real rather than an oversight.
 *  The two writers are split by window and cannot both run on one boot: `engine/index.html` owns
 *  the raw-fault (`entries`) side and serializes the envelope itself, because in ITS window this
 *  module has not evaluated; this function owns the pre-formatted (`reports`) side, because in
 *  ITS window the inline guard is already drained and disarmed. An `entries` parameter here had no
 *  caller — it made the pooling below look exercised while being unreachable, which is the same
 *  can't-fire defect class this whole family is about, so it is gone. The pool is enforced where
 *  both arrays genuinely CAN meet: {@link readAndClearBootStash}. */
/**
 * Choose which reports survive {@link REPLAY_ENTRY_CAP}.
 *
 * ⚠️ NOT a head slice, and not a tail slice either — both drop the crash in a realistic boot.
 * `queued` is push-ordered and a boot emits ordinary log noise before it dies (asset 404s,
 * deprecation warnings — `console.error`/`console.warn` are BOTH wrapped into `deliver()`), so:
 *
 *  - **Head slice** (the first version of this) keeps six benign warns and drops the
 *    `[uncaught]` that killed the boot. That is the exact payload the whole family exists to
 *    deliver, so the bug silently un-did the fix while every test stayed green.
 *  - **Tail slice** inverts it: a fatal throw followed by six cascade errors drops the root cause.
 *
 * So the pool is filled by KIND first — `error` (uncaught faults and `console.error`) outranks
 * `warn`, which outranks `breadcrumb` — and within a kind by original order, keeping the EARLIEST.
 * Earliest-within-errors is deliberate and matches `engine/index.html`'s `consider()`, which picks
 * the first stacked error because a later one is usually a cascade symptom of it (#823).
 *
 * The net guarantee, which is the one that matters: **a fatal error is never displaced by benign
 * log noise, however much of it a boot emitted first.**
 */
function selectReportsForStash(reports: readonly StashedReport[]): StashedReport[] {
  const rank = (k: StashedReport['kind']): number => (k === 'error' ? 0 : k === 'warn' ? 1 : 2);
  return reports
    .map((r, i) => ({ r, i }))
    // Stable by construction: ties on kind fall back to the original index, so "earliest wins"
    // holds within each kind rather than depending on the sort being stable.
    .sort((a, b) => rank(a.r.kind) - rank(b.r.kind) || a.i - b.i)
    .slice(0, REPLAY_ENTRY_CAP)
    // Back into chronological order — a replay should read as the boot happened, not as the
    // priority order that decided what survived.
    .sort((a, b) => a.i - b.i)
    .map((x) => x.r);
}

export function writeBootStash(input: {
  reports?: readonly StashedReport[];
  dropped?: number;
  console?: string;
}): void {
  try {
    const inReports = input.reports ?? [];
    const reports = selectReportsForStash(inReports);
    const envelope: BootStashEnvelope = {
      v: STASH_VERSION,
      ts: rawEpochNow(),
      // What the cap could not hold is COUNTED, not silently discarded — a drop nobody can see is
      // the failure this budget exists to make visible.
      dropped: (inReports.length - reports.length) + (input.dropped ?? 0),
      entries: [],
    };
    if (reports.length > 0) envelope.reports = reports;
    if (input.console) envelope.console = input.console;
    localStorage.setItem(STASH_KEY, JSON.stringify(envelope));
  } catch {
    /* private mode, quota exceeded, or an unserializable value — never let the stash itself throw */
  }
}

/** Drop any stash this boot wrote. Called when the crashlytics sink finally registers: the queue is
 *  about to flush live, so a persisted copy would replay the SAME fault again next launch. This is
 *  the half that keeps the eager write honest. */
export function clearBootStash(): void {
  try {
    localStorage.removeItem(STASH_KEY);
  } catch {
    /* nothing left to try */
  }
}
