/**
 * The daily challenge's CALENDAR model — civil dates, the month grid, the paid past day and the
 * per-install pick. Pure TS, no imports.
 *
 * Promoted out of `games/court/runtime/daily.ts` (#345, #764) when wordweave became the second game
 * with a daily challenge (#928). The two games run the same calendar rules, and a rule that should
 * be identical everywhere has to be imported, not forked (docs/cross-game-infrastructure.md) — the
 * defects this file already absorbed (a timezone switch serving a paid day free, a month boundary
 * with no reachable `today` cell, `'9999-99-99'` bricking the calendar) are exactly the kind a second
 * copy would have to rediscover.
 *
 * ⚠️ **What stays in the GAME:** every player-visible word (month names, weekday letters, the
 * "Aug 28" prose) — the engine carries no copy, the same rule `tests/runtime/accountNoCopy.test.ts`
 * enforces for `runtime/account/**` — and every side effect: the clock read, persistence, the price
 * knob, the pool of boards, the rating a completed day earns.
 *
 * ── Takes no clock ─────────────────────────────────────────────────────────────────────────────
 * Nothing here reads a clock. `nowMs` is a parameter: the determinism guard bans `Date.now()` in
 * engine `runtime/**` for game state, and a real-world date is not simulation state. The single
 * `Date.now()` lives at the game's call site (Court: `dailyNowMs()` in `systems.ts`).
 *
 * ⚠️ **Every date is LOCAL, never UTC.** A key built from `toISOString().slice(0, 10)` hands a
 * player east of Greenwich tomorrow's puzzle in the evening and re-runs yesterday's in the morning.
 * `getFullYear`/`getMonth`/`getDate` are local by definition, which is why the key is assembled
 * from them rather than from any of `Date`'s string formatters.
 *
 * ⚠️ **The device clock is NOT trusted, and only the PAID surface is defended** (Court owner ruling
 * 2026-09-09, #764; wordweave took the same ruling deliberately, #928). A player can still wind the
 * clock forward and farm FREE dailies; that stays accepted (single-player, no leaderboard, and a real
 * defence needs a backend). What IS defended is the `locked` day's coin price: "today" is a
 * HIGH-WATER mark (`effectiveNowMs`), so moving the clock — or the TIME ZONE — backwards cannot turn
 * a day the player would have had to BUY into today's free one. ⚠️ Reading `dateKeyOf(nowMs)` on the
 * raw device instant to decide anything a player pays for re-opens that hole — convert once, at the
 * boundary, with `effectiveNowMs`.
 *
 * ⚠️ **A time zone switch moves the CALENDAR without moving the INSTANT**, which is why no
 * instant-based defence can close this: `trustedClock.ts`'s anchor, and any fail-closed
 * `now < lastSeen` check, protect the instant and see nothing here. Measured — one fixed instant,
 * `dateKeyOf` reads `2026-09-09` in Tokyo and `2026-09-08` in Niue. Do not wire `trustedNow()` into
 * this module: it is the wrong instrument, not a partial one. ORDER day keys; never test them for
 * mere inequality.
 *
 * What the design DOES owe is never losing state to a clock that moves: completion is keyed by date
 * and stored append-only, and nothing here deletes or invalidates a record because a date became
 * "impossible".
 */

/** A civil date, `YYYY-MM-DD`, in the player's LOCAL timezone.
 *
 *  Zero-padded so lexicographic string order IS chronological order — which is why every
 *  comparison below is a plain `<`/`>` on strings and no date maths is needed to ask "is this day
 *  in the past". */
export type DateKey = string;

/** A month the calendar can show. `month` is 0-based, matching `Date`'s own convention — the one
 *  place a 1-based month would be friendlier is the display string, and that is the game's job. */
export interface MonthRef {
  year: number;
  /** 0 = January, 11 = December. */
  month: number;
}

/**
 * How many day cells one month page holds. **An entity COUNT, not a tuning knob** — it counts the
 * `Day<slot>` children of the game's pooled month prefab (Court: `daily-month.prefab.json`).
 *
 * 6 rows x 7 columns. Six rows rather than five because the worst case needs it: 31 days starting
 * on a Saturday is 6 leading blanks + 31 = 37 cells, which does not fit in 35. Most months leave
 * the last row entirely blank, and that is correct rather than wasteful — a FIXED grid is what lets
 * the pooled prefab be authored once.
 */
export const DAYS_PER_MONTH_GRID = 42;

/**
 * What one day cell says.
 *
 * - `blank` — grid padding before the 1st or after the last. There is no day here at all.
 * - `future` — after today. Drawn, dimmed, inert: the player can see the month's shape without
 *   being able to reach into it.
 * - `today` — today, not yet completed. The one free live cell, and what the main-menu pip is
 *   about.
 * - `done` — completed, any day. Tappable, and replaying is FREE (Court owner, 2026-08-28: coins buy
 *   the DAY, not the play) — the same rule a solved ladder level already follows.
 * - `open` — a past day already bought but not yet completed. Free to enter; the coins are spent.
 * - `locked` — a past day in range, not completed, not bought. **Costs coins.**
 * - `expired` — a past day older than the two-month window. Dimmed, no price, unreachable.
 */
export type DayState = 'blank' | 'future' | 'today' | 'done' | 'open' | 'locked' | 'expired';

/** One completed day's record, as far as the calendar reads it. A game stores more (Court: the
 *  level id and a star rating); the calendar only needs presence, and hands the record to the
 *  game's `starsOf` to decide what the cell draws. */
export interface DailyCompletion {
  stars?: number;
  /** A game's own fields (Court's `timeSec`, Weaveling's). The calendar reads none of them — the
   *  index signature is what lets a game's richer record be passed without a cast. */
  [field: string]: unknown;
}

/**
 * One calendar cell. `S` is the game's rating type — Court's `StarCount` (`0..3`); a game with no
 * rating passes `() => 0` as `daysForMonth`'s `starsOf`.
 */
export interface DayCell<S extends number = number> {
  /** The day's date key, or `''` when `state === 'blank'`. */
  key: DateKey;
  /** 1..31, or 0 when `state === 'blank'`. The number printed on the cell. */
  day: number;
  state: DayState;
  /** The rating this day earned. **0 means "no row to draw"** and covers both "not completed" and
   *  "completed with no rating" — the same deliberate conflation a level tile makes. */
  stars: S | 0;
  /** What entering costs right now, in coins. **0 for every state except `locked`** — including
   *  `done` and `open`, which are free by the rule above. Carried per-cell rather than left for
   *  the renderer to infer from the state, so the price badge and the charge cannot disagree. */
  price: number;
}

/** What the calendar needs to know about the player to decide a cell. All read-only; this module
 *  never writes. */
export interface DailyProgress {
  /** dateKey -> the result. Presence IS completion. */
  completed: Readonly<Record<DateKey, DailyCompletion>>;
  /** Past dates already unlocked with coins, mapped to whatever the game bought (Court: the level
   *  id, #532 Phase C1). This module only ever tests membership, never reads the value. */
  purchased: Readonly<Record<DateKey, string>>;
  /** What a locked day costs — the game's authored price knob (Court: `coinsPerDailyReplay`). */
  price: number;
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** The one place a `DateKey`'s SHAPE is checked. A save reader that admits any non-empty string as
 *  a key lets a corrupt entry (a hand-edited `PlayerPrefs` document, or one written by a
 *  future/older build) sort lexicographically BEFORE a real key (`.` is below every digit in ASCII)
 *  and land at index 0 of a sorted array. A caller anchoring on "the oldest OWNED day" picks the
 *  oldest key that actually LOOKS like a date instead of trusting index 0; sharing this regex with
 *  `monthsForCalendar` below is the whole point, so the two cannot drift into disagreeing about
 *  what a date key looks like. */
export function isDateKey(key: string): key is DateKey {
  return /^\d{4}-\d{2}-\d{2}$/.test(key);
}

/**
 * A date key that is also a REAL date (#764 close-out review).
 *
 * ⚠️ **`isDateKey` is a SHAPE test, and shape is not enough where the value orders a floor.**
 * `'9999-99-99'` passes the regex, and it is strictly worse than alphabetic junk: it is the MAXIMUM
 * of every comparison so it wins a take-the-later merge permanently, and `effectiveNowMs` would
 * resolve it through `new Date(9999, 98, 99)` to an instant in **year 10007** — driving
 * `monthsForCalendar` and `daysForMonth` eight thousand years out and bricking the daily for that
 * account on every device, forever.
 *
 * Round-trips through `Date` rather than range-checking each field by hand, so February and leap
 * years are the platform calendar's answer and not arithmetic here — the same reason `daysInMonth`
 * asks `Date` for a month's length.
 */
export function isRealDateKey(key: string): key is DateKey {
  if (!isDateKey(key)) return false;
  const y = Number(key.slice(0, 4)), m = Number(key.slice(5, 7)), d = Number(key.slice(8, 10));
  const probe = new Date(y, m - 1, d, 12);
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
}

/**
 * The LOCAL civil date of an instant, as `YYYY-MM-DD`.
 *
 * ⚠️ **Not `toISOString().slice(0, 10)`** — see this file's banner. The three accessors used here
 * are local by definition, and that is the whole point.
 */
export function dateKeyOf(nowMs: number): DateKey {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * What the calendar treats as "today": the LATER of the device's local date and the furthest date
 * this player has already been observed on.
 *
 * ⚠️ **This is the whole of #764's fix, and it is deliberately ONE-SIDED.** Moving the clock or the
 * time zone FORWARD still moves today forward — that is the farming this file's banner accepts, and
 * the player pays for it by spending tomorrow's daily to get it. Moving BACKWARD moves nothing, so a
 * past day the player would have had to buy stays `locked` (or `open`, if they already bought it)
 * instead of being served as today's free challenge.
 *
 * A `floor` that is not a real date key (`''` before the first observation, or a corrupt document)
 * loses to the live date, which is the correct degradation in both directions: an unknown floor
 * must never push "today" somewhere the player has never been, and must never suppress a real one.
 *
 * ⚠️ **No production caller in Court — `effectiveNowMs` + `dateKeyOf` is the shipped path.** Kept
 * because it is the clearest statement of the RULE and the cheapest thing for a test to assert
 * against; a caller that grows here is probably converting twice.
 */
export function effectiveDayKey(nowMs: number, floor: DateKey): DateKey {
  return dateKeyOf(effectiveNowMs(nowMs, floor));
}

/**
 * The same answer as `effectiveDayKey`, as an INSTANT — the form every other function here takes.
 *
 * ⚠️ **This is the boundary, and converting ONCE here is the whole point** (#764 review finding,
 * 2026-09-09). The first cut threaded the floor into `daysForMonth` and `isTodayUnplayed` and left
 * every OTHER derivation on the raw instant — and `monthsForCalendar` caps the window's FORWARD end
 * at `monthOf(nowMs)`. Measured: local `2026-09-30` with floor `2026-10-01` produced a calendar
 * whose pageable months were `[Aug, Sep]`, no cell anywhere in state `today`, and the menu pip lit
 * pointing at a day the player could not reach. A real traveller reaches that state by flying
 * Tokyo -> LA across a month boundary; no clock cheat is needed.
 *
 * Converting the INSTANT instead means every date and month question downstream answers from the
 * same day, by construction, rather than by remembering to thread a floor into each one.
 *
 * ⚠️ **Idempotent**, deliberately: applying it to an already-effective instant returns it unchanged
 * (the floor is no longer later than the local date), so a call site that converts twice is safe.
 *
 * Resolves to local NOON on the floor's date — far from either midnight, so a DST transition on
 * that day cannot move the civil date it reads back as.
 */
export function effectiveNowMs(nowMs: number, floor: DateKey): number {
  if (!isRealDateKey(floor) || floor <= dateKeyOf(nowMs)) return nowMs;
  return new Date(
    Number(floor.slice(0, 4)), Number(floor.slice(5, 7)) - 1, Number(floor.slice(8, 10)), 12,
  ).getTime();
}

/** The month an instant falls in, locally. */
export function monthOf(nowMs: number): MonthRef {
  const d = new Date(nowMs);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/** The month before this one, rolling the year at January. */
export function previousMonth(m: MonthRef): MonthRef {
  return m.month === 0 ? { year: m.year - 1, month: 11 } : { year: m.year, month: m.month - 1 };
}

/** Same month? Compared field-wise rather than by any derived string, so a caller cannot pass a
 *  differently-shaped month and get a false negative. */
export function sameMonth(a: MonthRef, b: MonthRef): boolean {
  return a.year === b.year && a.month === b.month;
}

/**
 * The months the calendar can PAGE, oldest first — `[lastMonth, thisMonth]` by default, extended
 * back to cover `reachBack` when the player owns a day older than that.
 *
 * ⚠️ **The ORDER is the contract** — it is the `UIEntries` data order, so the LAST index is this
 * month and the calendar opens there (Court owner, 2026-08-28: *"you see only the current month. you
 * have to press (<) button to see the previous month"*). Older months to the left means `(<)` is
 * "go back", which is the direction the arrow points. The index of this month is therefore
 * `length - 1` and is NOT a constant.
 *
 * ⚠️ **The window is not the PRICE window, and conflating them is the bug this signature exists to
 * prevent** (Court owner, 2026-08-29). `isMonthInRange` below stays exactly two months: that is how
 * far back a day can be BOUGHT. This decides how far back the calendar can be SCROLLED, which has to
 * reach any day the player already owns — otherwise coins buy a day that silently stops existing.
 *
 * `reachBack` is a dateKey (the oldest purchased day) rather than a `MonthRef`, because the caller
 * has keys and converting one here keeps the "which month is that in" rule in this module. A key
 * that is malformed, or newer than last month, changes nothing.
 */
export function monthsForCalendar(nowMs: number, reachBack?: DateKey): MonthRef[] {
  const thisMonth = monthOf(nowMs);
  const out: MonthRef[] = [previousMonth(thisMonth), thisMonth];
  if (!reachBack || !isDateKey(reachBack)) return out;
  const target: MonthRef = { year: Number(reachBack.slice(0, 4)), month: Number(reachBack.slice(5, 7)) - 1 };
  // Walk back one month at a time rather than computing a count: `previousMonth` already owns the
  // year rollover, and the loop cannot produce a gap. Bounded by the target, which came from a
  // stored purchase — a corrupt future-dated key exits on the first test.
  let oldest = out[0]!;
  let guard = 0;
  while (!sameMonth(oldest, target) && (target.year < oldest.year
      || (target.year === oldest.year && target.month < oldest.month))) {
    oldest = previousMonth(oldest);
    out.unshift(oldest);
    if (++guard > MAX_REACH_BACK_MONTHS) break;
  }
  return out;
}

/** A ceiling on how far `monthsForCalendar` will walk back, so a corrupt or absurd stored key
 *  cannot mint thousands of calendar pages. 10 years of owned days is not a real save. */
const MAX_REACH_BACK_MONTHS = 120;

/**
 * Is this month inside the PAYABLE window — this month or last month?
 *
 * ⚠️ Deliberately NOT `monthsForCalendar(...).some(...)`: that window stretches to cover owned days,
 * and reusing it here would make an old month payable again just because the player owns one day in
 * it. This is the price rule and it stays two months, always.
 */
export function isMonthInRange(month: MonthRef, nowMs: number): boolean {
  const thisMonth = monthOf(nowMs);
  return sameMonth(month, thisMonth) || sameMonth(month, previousMonth(thisMonth));
}

/** How many days the month has. `day 0` of the NEXT month is the last day of this one — the
 *  standard trick, and it is correct across leap years because the platform's calendar decides,
 *  not arithmetic here. */
function daysInMonth(m: MonthRef): number {
  return new Date(m.year, m.month + 1, 0).getDate();
}

/** Which column the 1st falls in. 0 = Sunday, matching `Date.getDay()` — so a game's weekday header
 *  row must start on SUNDAY too, or every month's day 1 sits under the wrong letter. */
function firstWeekdayOf(m: MonthRef): number {
  return new Date(m.year, m.month, 1).getDay();
}

/** The date key for a day-of-month, built by ARITHMETIC rather than by constructing a `Date`.
 *
 *  ⚠️ Deliberate: a `new Date(y, m, d)` lands on local midnight, and on a spring-forward day in
 *  some zones local midnight does not exist, so the runtime shifts the instant. `getDate()` still
 *  answers correctly there, but not constructing the instant at all is strictly safer and cheaper
 *  — the key is a string about a calendar, not about a moment. */
function keyFor(m: MonthRef, day: number): DateKey {
  return `${m.year}-${pad2(m.month + 1)}-${pad2(day)}`;
}

/**
 * The 42 cells of one month.
 *
 * ⚠️ **Always exactly `DAYS_PER_MONTH_GRID` entries, blanks included — that is the contract, and
 * the caller depends on it.** A pooled entry is by definition RECYCLED, so answering only the slots
 * that have days on them leaves the PREVIOUS month's numbers showing under the new month's tail —
 * the worst thing a calendar can do: it would print a date the tap does not open.
 *
 * `starsOf` turns a completed day's record into the rating its cell draws. It is the game's rule —
 * the engine does not know what a rating is — and a game with no rating passes `() => 0`.
 *
 * ⚠️ **REQUIRED, deliberately** (#928 close-out review). It was optional, and because `S` is
 * inferred from what the caller expects back, a result annotated `DayCell<StarCount>` compiled
 * with it omitted — so a new call site that forgot the game's rule would type-check and silently
 * draw every finished day with no stars. Required turns that into a compile error.
 *
 * Pure. `nowMs` decides today and the window; nothing else is read.
 */
export function daysForMonth<S extends number>(
  month: MonthRef,
  nowMs: number,
  progress: DailyProgress,
  starsOf: (done: DailyCompletion) => S,
): DayCell<S>[] {
  // ⚠️ **`nowMs` is the EFFECTIVE instant, not the device clock** (#764) — the caller applies
  // `effectiveNowMs` once, at the boundary, so every date and month question in this file answers
  // from the same day. An earlier cut applied the floor HERE and left `isMonthInRange` and
  // `monthsForCalendar` on the raw instant, which produced a calendar with no reachable `today`
  // cell — see `effectiveNowMs`.
  const todayKey = dateKeyOf(nowMs);
  // ⚠️ **This REVERSES a prior ruling, deliberately.** `isMonthInRange` used to be argued as
  // correct on the RAW instant. With a forward floor the window shifts forward too, so a month can
  // age out of the payable range up to a day early. That is accepted: the alternative is a calendar
  // whose window and whose cells disagree about what day it is.
  const inRange = isMonthInRange(month, nowMs);
  const total = daysInMonth(month);
  const lead = firstWeekdayOf(month);
  const out: DayCell<S>[] = [];

  for (let slot = 0; slot < DAYS_PER_MONTH_GRID; slot++) {
    const day = slot - lead + 1;
    if (day < 1 || day > total) {
      out.push({ key: '', day: 0, state: 'blank', stars: 0, price: 0 });
      continue;
    }
    const key = keyFor(month, day);
    const done = progress.completed[key];
    if (done) {
      // ⚠️ Checked BEFORE the past/future split, and that ordering is load-bearing: today's puzzle
      // becomes `done` the moment it is solved rather than staying `today`, which is what turns the
      // main-menu pip off. `isTodayUnplayed` asks the same question from the same record.
      out.push({ key, day, state: 'done', stars: starsOf(done), price: 0 });
      continue;
    }
    if (key > todayKey) {
      out.push({ key, day, state: 'future', stars: 0, price: 0 });
      continue;
    }
    if (key === todayKey) {
      out.push({ key, day, state: 'today', stars: 0, price: 0 });
      continue;
    }
    // A past day.
    //
    // ⚠️ **`purchased` is tested BEFORE the range, and the order is the whole of the fix**
    // (Court owner, 2026-08-29). It was the other way round, so a day the player had BOUGHT and not
    // finished turned `expired` once it aged out of the payable window — and the coins had bought
    // something that silently stopped existing, with no warning and no refund. Buying takes a day
    // OUT of the expiry rule permanently, which is what "coins buy the DAY" has to mean.
    //
    // ⚠️ The calendar must be able to SCROLL to the month as well — see `monthsForCalendar`'s
    // `reachBack`. This branch alone would give the day a correct face on a page nothing can page
    // to, which is the same loss wearing a different label.
    if (key in progress.purchased) {
      out.push({ key, day, state: 'open', stars: 0, price: 0 });
      continue;
    }
    // Not bought: out of the two-month window it is unreachable at any price.
    if (!inRange) {
      out.push({ key, day, state: 'expired', stars: 0, price: 0 });
      continue;
    }
    out.push({
      key,
      day,
      state: 'locked',
      stars: 0,
      // Clamped at 0 so an author cannot make a day pay the player, and floored so the badge and
      // the charge are the same integer.
      price: Math.max(0, Math.floor(progress.price)),
    });
  }
  return out;
}

/** Is this cell a control right now? The single answer, so the renderer's dimming and the tap
 *  handler's gate cannot drift apart. */
export function isDayInteractive(cell: DayCell): boolean {
  return cell.state === 'today' || cell.state === 'done' || cell.state === 'open'
    || cell.state === 'locked';
}

/** Does entering this cell charge coins? `locked` is the only one — stated as its own predicate so
 *  a caller never infers "free" from a price of 0 that merely has not been computed yet. */
export function dayCostsCoins(cell: DayCell): boolean {
  return cell.state === 'locked';
}

/**
 * Is today's challenge still unplayed? **This is the main-menu pip**, and the same predicate
 * decides whether the game boots into the menu rather than the level (Court owner, 2026-08-28).
 *
 * Deliberately asks only about TODAY: a backlog of unplayed past days must not light the pip, or it
 * would be lit permanently for anyone who ever skipped a day, which is the opposite of a nudge.
 *
 * ⚠️ **`nowMs` is the EFFECTIVE instant** (#764), for the same reason `daysForMonth`'s is: the pip
 * must agree with the grid. Handed the raw device clock it would light for a "today" that
 * `daysForMonth` is drawing as a past `locked` day — a nudge toward a cell that charges coins.
 */
export function isTodayUnplayed(nowMs: number, completed: DailyProgress['completed']): boolean {
  return !completed[dateKeyOf(nowMs)];
}

/**
 * Has the player earned the daily challenge? The caller passes its count of REAL puzzles solved —
 * tutorial lessons excluded, and never a ladder position (Court owner, 2026-08-28: the two diverge
 * for a player whose solves are not contiguous).
 *
 * A threshold of 0 or less unlocks it immediately, which is a legitimate setting (it is how the
 * feature gets tested without playing fifteen puzzles) rather than a broken one.
 */
export function isDailyUnlocked(realPuzzlesSolved: number, unlockAfter: number): boolean {
  if (!Number.isFinite(unlockAfter) || unlockAfter <= 0) return true;
  return realPuzzlesSolved >= unlockAfter;
}

/**
 * FNV-1a, 32-bit. A hash rather than an RNG because the pick must be REPRODUCIBLE from its inputs:
 * the assignment is persisted, but if the write is lost between choosing and flushing, asking again
 * must answer the same board rather than silently handing out a second puzzle for the same day.
 *
 * Not cryptographic and does not need to be — it is choosing a puzzle, not a key.
 */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // `Math.imul` keeps the multiply in 32 bits; `>>> 0` keeps the result unsigned. Without both,
    // long inputs drift into float territory and the hash stops being reproducible across engines.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Which board a given date hands out.
 *
 * Court owner, 2026-08-28: *"the game picks one unplayed challenging level. if all have been
 * played, you can pick one randomly."* Two buckets:
 *
 * 1. Boards not yet assigned to ANY date.
 * 2. If none are left, the whole pool. REACHABLE and therefore tested, because a fallback nobody
 *    exercises is one that breaks on the day the pool runs out.
 *
 * ⚠️ The pool must be DISJOINT from the game's ladder — a daily drawn from the ladder spoils a
 * ladder level. Court carves its pool out of the corpus; wordweave generates a separate one.
 *
 * `salt` makes the choice per-INSTALL, so two players on the same day do not get the same puzzle —
 * *"doesn't need to be the same for all the player"* is what makes a daily possible with no backend,
 * and a per-install salt is what cashes it in. Passing `''` makes the pick a pure function of the
 * date.
 *
 * Returns `null` only for an empty pool. The caller must render a calendar with nothing to hand out
 * rather than crash.
 */
export function pickDailyLevel(
  pool: readonly { id: string }[],
  assignedIds: ReadonlySet<string>,
  dateKey: DateKey,
  salt = '',
): string | null {
  if (pool.length === 0) return null;
  const unassigned = pool.filter((e) => !assignedIds.has(e.id));
  const candidates = unassigned.length > 0 ? unassigned : pool;
  // Indexed by hash rather than shuffled: a shuffle would need the whole list ordered to pick one
  // of it, and the modulo is the same choice for far less work.
  return candidates[hash32(`${salt}|${dateKey}`) % candidates.length]!.id;
}
