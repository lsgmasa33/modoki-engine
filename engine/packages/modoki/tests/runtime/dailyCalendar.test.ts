/**
 * The daily challenge's calendar model (#345 phase 1, promoted to the engine in #928).
 *
 * `runtime/core/dailyCalendar.ts` is pure and takes `nowMs`, so everything here is exact: no clock
 * is stubbed, no timers advance, and every case is a literal instant. The one thing that IS
 * environmental is the TIMEZONE — every date in this module is local by design — so the
 * zone-sensitive cases run under an explicit `TZ` rather than trusting whatever the machine is set to.
 *
 * Moved from `games/court/tests/daily.test.ts` with every assertion intact; the one change is that
 * the star cases pass a rating rule, since the clamp is now Court's (`dailyStarsOf`, tested in
 * Court's `daily.test.ts` with its English labels). The owner rulings these cases cite were made for
 * Court and carried into wordweave deliberately (#928).
 */

import { describe, expect, it } from 'vitest';
import {
  DAYS_PER_MONTH_GRID, dateKeyOf, dayCostsCoins, effectiveDayKey, effectiveNowMs,
  isDailyUnlocked, isDateKey, isDayInteractive, isMonthInRange, isRealDateKey, isTodayUnplayed,
  monthOf, monthsForCalendar, pickDailyLevel, previousMonth, sameMonth,
  daysForMonth as daysForMonthWithRule,
  type DailyCompletion, type DailyProgress, type DayCell, type MonthRef,
} from '../../src/runtime/core/dailyCalendar';

/** Local noon on a given civil date — far from either midnight, so a case that is ABOUT the
 *  calendar is never accidentally about a timezone edge. The edges get their own tests. */
const at = (y: number, m1: number, d: number, h = 12, min = 0): number =>
  new Date(y, m1 - 1, d, h, min).getTime();

const progress = (over: Partial<DailyProgress> = {}): DailyProgress => ({
  completed: {},
  purchased: {},
  price: 30,
  ...over,
});

const cellFor = (cells: DayCell[], key: string): DayCell =>
  cells.find((c) => c.key === key)!;

/** A rating rule for the cases that are ABOUT a done cell's stars — the stored number, unclamped. */
const starsOf = (d: DailyCompletion): number => d.stars ?? 0;

/** `starsOf` is required in production; most cases here are about STATE and price, not the rating,
 *  so they take a no-rating rule by default. The rating cases pass one explicitly. */
const daysForMonth = (
  month: MonthRef, nowMs: number, p: DailyProgress, rule: (d: DailyCompletion) => number = () => 0,
): DayCell[] => daysForMonthWithRule(month, nowMs, p, rule);

describe('dateKeyOf', () => {
  it('is YYYY-MM-DD, zero-padded on both month and day', () => {
    expect(dateKeyOf(at(2026, 8, 28))).toBe('2026-08-28');
    expect(dateKeyOf(at(2026, 1, 5))).toBe('2026-01-05');
    expect(dateKeyOf(at(2026, 12, 31))).toBe('2026-12-31');
  });

  // ⚠️ The padding is not cosmetic: it is what makes lexicographic string order chronological, and
  // every past/future comparison in the module is a plain string compare that depends on it.
  it('pads so string order IS chronological order', () => {
    const keys = [at(2026, 12, 1), at(2026, 2, 28), at(2026, 1, 9), at(2027, 1, 1)]
      .map(dateKeyOf);
    expect([...keys].sort()).toEqual(['2026-01-09', '2026-02-28', '2026-12-01', '2027-01-01']);
  });

  // ⚠️ **The bug this module exists to avoid**, in both directions. `toISOString().slice(0,10)`
  // answers the PREVIOUS day for a morning instant east of Greenwich, and the NEXT day for an
  // evening instant west of it — so a player would be re-handed yesterday's puzzle over breakfast
  // in Tokyo, and handed tomorrow's after dinner in Los Angeles. Each case asserts that the UTC
  // answer really does DIFFER, so the test discriminates instead of merely exercising the code.
  const withTz = (tz: string, fn: () => void) => {
    const prev = process.env.TZ;
    // ⚠️ Assigning `undefined` back stores the STRING "undefined", which Node reads as UTC — so a
    // bare `process.env.TZ = prev` left every later case in this file running in UTC rather than
    // in the machine zone (#928 close-out review). Delete it instead.
    try { process.env.TZ = tz; fn(); } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
  };

  it('uses the LOCAL date east of Greenwich, where UTC is still yesterday', () => {
    withTz('Asia/Tokyo', () => {
      const morning = new Date(2026, 7, 29, 8, 0).getTime(); // 08:00 JST = 23:00 UTC the 28th
      expect(new Date(morning).toISOString().slice(0, 10), 'not a discriminating instant').toBe('2026-08-28');
      expect(dateKeyOf(morning)).toBe('2026-08-29');
    });
  });

  it('uses the LOCAL date west of Greenwich, where UTC is already tomorrow', () => {
    withTz('America/Los_Angeles', () => {
      const evening = new Date(2026, 7, 28, 20, 0).getTime(); // 20:00 PDT = 03:00 UTC the 29th
      expect(new Date(evening).toISOString().slice(0, 10), 'not a discriminating instant').toBe('2026-08-29');
      expect(dateKeyOf(evening)).toBe('2026-08-28');
    });
  });

  it('agrees with the platform on the local date at both midnights of a day', () => {
    // Constructed from local components and read back through the same local accessors, so this
    // holds in EVERY zone the suite might run in — which is what makes it a real assertion rather
    // than one that only passes on this Mac.
    for (const [h, m] of [[0, 0], [23, 59]] as const) {
      const t = new Date(2026, 2, 15, h, m).getTime();
      const d = new Date(t);
      expect(dateKeyOf(t)).toBe(`${d.getFullYear()}-0${d.getMonth() + 1}-${d.getDate()}`);
    }
  });
});

describe('month navigation', () => {
  it('rolls the year backwards at January', () => {
    expect(previousMonth({ year: 2026, month: 0 })).toEqual({ year: 2025, month: 11 });
    expect(previousMonth({ year: 2026, month: 7 })).toEqual({ year: 2026, month: 6 });
  });

  // ⚠️ The ORDER is the `UIEntries` data order and therefore a contract: index 1 is this month, and
  // the calendar opens there because the owner sees only the current month until `(<)` is pressed.
  it('offers exactly two months, last month first', () => {
    const months = monthsForCalendar(at(2026, 8, 28));
    expect(months).toHaveLength(2);
    expect(months[0]).toEqual({ year: 2026, month: 6 });
    expect(months[1]).toEqual({ year: 2026, month: 7 });
    expect(sameMonth(months[1], monthOf(at(2026, 8, 28)))).toBe(true);
  });

  it('crosses a year boundary', () => {
    expect(monthsForCalendar(at(2026, 1, 3))[0]).toEqual({ year: 2025, month: 11 });
  });

  /**
   * ⚠️ **The window the calendar can SCROLL is not the window a day can be BOUGHT in** (owner,
   * 2026-08-29). `isMonthInRange` below stays two months forever — that is the price rule. This
   * one stretches back to cover a day the player already owns, because a bought day that no page
   * can reach is a day the coins bought and then lost.
   */
  describe('reaching back to an owned day', () => {
    it('is still two months when the player owns nothing', () => {
      expect(monthsForCalendar(at(2026, 8, 28), undefined)).toHaveLength(2);
    });

    it('is still two months for a day already inside the window', () => {
      // Last month needs no rescue — it is already page 0.
      expect(monthsForCalendar(at(2026, 8, 28), '2026-07-04')).toHaveLength(2);
    });

    it('stretches to the month of the oldest owned day, contiguously', () => {
      const months = monthsForCalendar(at(2026, 8, 28), '2026-04-09');
      expect(months.map((m) => `${m.year}-${m.month}`))
        .toEqual(['2026-3', '2026-4', '2026-5', '2026-6', '2026-7']);
    });

    it('still ends on THIS month — the order is the UIEntries contract', () => {
      const months = monthsForCalendar(at(2026, 8, 28), '2026-04-09');
      expect(sameMonth(months[months.length - 1]!, monthOf(at(2026, 8, 28)))).toBe(true);
    });

    it('crosses a year boundary while reaching back', () => {
      const months = monthsForCalendar(at(2026, 1, 3), '2025-10-31');
      expect(months[0]).toEqual({ year: 2025, month: 9 });
      expect(months).toHaveLength(4);   // Oct, Nov, Dec 2025, Jan 2026
    });

    it('ignores a malformed key rather than looping', () => {
      expect(monthsForCalendar(at(2026, 8, 28), 'not-a-date')).toHaveLength(2);
      expect(monthsForCalendar(at(2026, 8, 28), '')).toHaveLength(2);
    });

    // ⚠️ Close-out review, 2026-08-29: `readDaily().purchased` admits any non-empty string and is
    // stored SORTED — a corrupt entry sorting before a real key (`.` is below every digit in ASCII)
    // used to become `purchased[0]` and silently collapse the reach-back window to the two-month
    // floor for a player who genuinely owns an old day. `dailyMonthRefs` (`systems.ts`) is fixed to
    // pick `purchased.find(isDateKey)` instead of `purchased[0]` — this pins the SAME shape, using
    // only what the calendar model exports, since `isDateKey` is the shared validator the fix depends on.
    it('a caller anchoring on the oldest OWNED day must skip a malformed entry, not trust [0]', () => {
      const purchased = ['.corrupt-entry', '2026-04-09'].sort();
      // Sorted lexicographically, the corrupt entry — not a real date — lands at index 0.
      expect(purchased[0]).toBe('.corrupt-entry');
      expect(isDateKey(purchased[0]!)).toBe(false);
      const reachBack = purchased.find(isDateKey);
      expect(reachBack).toBe('2026-04-09');
      const months = monthsForCalendar(at(2026, 8, 28), reachBack);
      expect(months.map((m) => `${m.year}-${m.month}`))
        .toEqual(['2026-3', '2026-4', '2026-5', '2026-6', '2026-7']);
      // The regression this guards: passing `purchased[0]` straight through gets the malformed
      // string, which `monthsForCalendar` rejects — collapsing back to the two-month floor.
      expect(monthsForCalendar(at(2026, 8, 28), purchased[0]), 'the bug this test exists to catch')
        .toHaveLength(2);
    });

    it('ignores a FUTURE key — it can only ever reach backwards', () => {
      expect(monthsForCalendar(at(2026, 8, 28), '2027-05-01')).toHaveLength(2);
    });

    it('caps an absurd stored key rather than minting thousands of pages', () => {
      // A corrupt save must not turn into a calendar the scroll view has to pool 12,000 pages for.
      expect(monthsForCalendar(at(2026, 8, 28), '1900-01-01').length).toBeLessThanOrEqual(123);
    });
  });

  it('knows which months are reachable', () => {
    const now = at(2026, 8, 28);
    expect(isMonthInRange({ year: 2026, month: 7 }, now), 'this month').toBe(true);
    expect(isMonthInRange({ year: 2026, month: 6 }, now), 'last month').toBe(true);
    expect(isMonthInRange({ year: 2026, month: 5 }, now), 'two months back').toBe(false);
    expect(isMonthInRange({ year: 2026, month: 8 }, now), 'next month').toBe(false);
  });

  /**
   * #412 — "the calendar is a history, not a two-month window" (owner, 2026-08-29).
   *
   * ⚠️ **This is a SIGNATURE-level statement, not a regression guard for the reach-back
   * conflation bug #412 fixed.** `isMonthInRange(month, nowMs)` and `daysForMonth(month, nowMs,
   * progress)` take no reach-back argument at all — so however `oldestDailyReachBack` in
   * `systems.ts` derives its key (from `purchased` alone, from `completed` alone, from both, or
   * wrongly from neither), NOTHING about that computation can ever make a test here fail. What
   * this DOES pin, honestly: the price window and the scroll-reach window are independent BY
   * CONSTRUCTION (`isMonthInRange` does not call `monthsForCalendar` — see its own banner
   * comment), which is what makes it safe for the reach-back key to grow without moving the
   * payable window an inch. The regression guard for the actual conflation — whether
   * `oldestDailyReachBack` reaches a day through the REAL tap path — lives in
   * `dailyPurchase.test.ts`'s "a day reachable ONLY via a free completion…" case, which drives
   * `__testing.playDailyAt` and can fail.
   */
  describe('the price window\'s SIGNATURE cannot see a reach-back key (#412) — a structural fact, '
    + 'not a conflation regression guard', () => {
    const now = at(2026, 8, 28);
    // Three months back: May 2026 (month index 4), well outside the two-month payable window
    // (July/August). Nothing purchased — this player's only connection to the day is a free solve.
    const oldMonth = { year: 2026, month: 4 };
    const completedKey = '2026-05-15';

    it('(a) monthsForCalendar itself reaches an old month given a reach-back key — a purely '
      + 'SCROLL fact about the pure function, not a claim about how systems.ts derives the key', () => {
      const months = monthsForCalendar(now, completedKey);
      expect(months.some((m) => sameMonth(m, oldMonth)), 'the completed month must be scrollable to')
        .toBe(true);
    });

    it('(b) daysForMonth/isMonthInRange never take a reach-back argument at all, so a scrollable '
      + 'old month still prices every non-completed day at 0/expired — SIGNATURE-level, cannot '
      + 'see any reach-back conflation by construction', () => {
      expect(isMonthInRange(oldMonth, now), 'precondition: outside the two-month payable window')
        .toBe(false);
      const cells = daysForMonth(oldMonth, now, progress({ completed: { [completedKey]: { stars: 2 } } }), starsOf);
      expect(cellFor(cells, completedKey)).toMatchObject({ state: 'done', stars: 2, price: 0 });
      // Every other non-blank day in the month is unrescued: still expired, still free to look at,
      // still un-payable. If the price window had silently derived from the reach-back key, these
      // would read `locked` with a real price instead.
      const others = cells.filter((c) => c.key !== '' && c.key !== completedKey);
      expect(others.length, 'fixture: May 2026 has other days to check').toBeGreaterThan(0);
      for (const c of others) {
        expect(c.state, `${c.key} must stay expired, not become payable`).toBe('expired');
        expect(c.price, `${c.key} must never price a day the reach-back fix did not unlock`).toBe(0);
      }
    });
  });

  // A SIGNATURE-level fact, not a conflation guard either: `monthsForCalendar` reaches back given
  // ANY reach-back key, whatever collection it was derived from — this test hands it one by hand.
  // Whether `systems.ts`'s `oldestDailyReachBack` actually DERIVES that key from `completed` (as
  // well as `purchased`) is covered in `dailyPurchase.test.ts`, where `__testing` can reach it.
  it('monthsForCalendar reaches back given a key with no purchase behind it at all', () => {
    const months = monthsForCalendar(at(2026, 8, 28), '2026-04-09');
    expect(months.map((m) => `${m.year}-${m.month}`))
      .toEqual(['2026-3', '2026-4', '2026-5', '2026-6', '2026-7']);
  });
});

describe('daysForMonth — the grid', () => {
  const now = at(2026, 8, 28);

  // ⚠️ The contract a POOLED prefab depends on. Answering only the slots with days on them leaves
  // the previous month's numbers showing under the new month's tail — a cell printing a date the
  // tap does not open.
  it('always returns exactly DAYS_PER_MONTH_GRID cells, blanks included', () => {
    for (const m of [{ year: 2026, month: 1 }, { year: 2026, month: 7 }, { year: 2024, month: 1 }]) {
      expect(daysForMonth(m, now, progress())).toHaveLength(DAYS_PER_MONTH_GRID);
    }
  });

  it('lays the days out under the right weekday columns', () => {
    // 1 August 2026 is a Saturday — column 6, so six leading blanks.
    const cells = daysForMonth({ year: 2026, month: 7 }, now, progress());
    expect(cells.slice(0, 6).every((c) => c.state === 'blank')).toBe(true);
    expect(cells[6].day).toBe(1);
    expect(cells[6].key).toBe('2026-08-01');
    // ...and the 8th sits directly below the 1st, one week later.
    expect(cells[6 + 7].day).toBe(8);
  });

  it('numbers every day of the month exactly once, in order', () => {
    const cells = daysForMonth({ year: 2026, month: 7 }, now, progress());
    expect(cells.filter((c) => c.state !== 'blank').map((c) => c.day))
      .toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
  });

  it.each([
    [{ year: 2026, month: 1 }, 28, 'February, common year'],
    [{ year: 2024, month: 1 }, 29, 'February, leap year'],
    [{ year: 2000, month: 1 }, 29, 'February, century leap year'],
    [{ year: 1900, month: 1 }, 28, 'February, century NON-leap year'],
    [{ year: 2026, month: 3 }, 30, 'a 30-day month'],
    [{ year: 2026, month: 6 }, 31, 'a 31-day month'],
  ])('%o has %i days (%s)', (month, expected) => {
    const cells = daysForMonth(month, at(month.year, month.month + 1, 15), progress());
    expect(cells.filter((c) => c.state !== 'blank')).toHaveLength(expected);
  });

  it('gives blank cells no key, no number and no price', () => {
    const blank = daysForMonth({ year: 2026, month: 7 }, now, progress())[0];
    expect(blank).toEqual({ key: '', day: 0, state: 'blank', stars: 0, price: 0 });
  });
});

describe('daysForMonth — cell states', () => {
  // 28 August 2026. Everything below is relative to this instant.
  const now = at(2026, 8, 28);
  const thisMonth = { year: 2026, month: 7 };
  const lastMonth = { year: 2026, month: 6 };

  it('marks today, and only today', () => {
    const cells = daysForMonth(thisMonth, now, progress());
    expect(cells.filter((c) => c.state === 'today').map((c) => c.key)).toEqual(['2026-08-28']);
  });

  it('leaves the future dimmed, free and inert', () => {
    const cells = daysForMonth(thisMonth, now, progress());
    const tomorrow = cellFor(cells, '2026-08-29');
    expect(tomorrow.state).toBe('future');
    expect(tomorrow.price).toBe(0);
    expect(isDayInteractive(tomorrow)).toBe(false);
  });

  // Owner, 2026-08-28: every past day in range is payable, including days before the player
  // unlocked the feature. The calendar opens as a backlog you can buy into.
  it('prices every unplayed past day in range', () => {
    const cells = daysForMonth(thisMonth, now, progress());
    const past = cells.filter((c) => c.state === 'locked');
    expect(past.map((c) => c.day)).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));
    expect(new Set(past.map((c) => c.price))).toEqual(new Set([30]));
  });

  it('prices last month the same way — it is in range', () => {
    const cells = daysForMonth(lastMonth, now, progress());
    expect(cells.filter((c) => c.state === 'locked')).toHaveLength(31);
  });

  // ⚠️ `expired` is not dead code, and it is REACHABLE from the UI as of 2026-08-29: owning one
  // day in an old month puts that whole month back in the pager, where its unbought neighbours
  // draw as expired. That is the design — buying rescues the DAY, not the month.
  //
  // ⚠️ **This comment used to say "the two-month window lives in `monthsForCalendar` alone and no
  // caller can widen it by accident". That is now backwards and would be a dangerous thing to
  // act on**: `monthsForCalendar` is the SCROLL window and is no longer two months, while the
  // PRICE window is `isMonthInRange`, deliberately de-derived from it. "Restoring" the derivation
  // would make an old month payable again the moment the player owns one day in it.
  it('reports a month outside the window as expired, at no price', () => {
    const cells = daysForMonth({ year: 2026, month: 5 }, now, progress());
    const days = cells.filter((c) => c.state !== 'blank');
    expect(days.every((c) => c.state === 'expired')).toBe(true);
    expect(days.every((c) => c.price === 0)).toBe(true);
    expect(days.every((c) => !isDayInteractive(c))).toBe(true);
  });

  /**
   * ⚠️ **The expiry fix** (owner, 2026-08-29). `purchased` is tested BEFORE the range, so a day
   * bought and not finished stays `open` however old it gets. Before this, it turned `expired`
   * one to two months after purchase and the coins had bought something that stopped existing.
   */
  it('a purchased day stays open FOREVER, long past the payable window', () => {
    const old = { year: 2026, month: 2 };   // March 2026, five months back
    expect(isMonthInRange(old, now), 'precondition: the month is NOT payable').toBe(false);
    const cells = daysForMonth(old, now, progress({ purchased: { '2026-03-11': 'lvl' } }));
    const bought = cellFor(cells, '2026-03-11');
    expect(bought.state, 'a day the player paid for must never expire').toBe('open');
    expect(bought.price).toBe(0);
    expect(isDayInteractive(bought)).toBe(true);
    // Its unbought neighbours in the same month are still expired — buying rescues the DAY, not
    // the month, and it does not make an old month payable again.
    const neighbour = cellFor(cells, '2026-03-12');
    expect(neighbour.state).toBe('expired');
    expect(neighbour.price).toBe(0);
  });

  it('a purchased past day is open and FREE', () => {
    const cells = daysForMonth(thisMonth, now, progress({ purchased: { '2026-08-10': 'lvl' } }));
    const bought = cellFor(cells, '2026-08-10');
    expect(bought.state).toBe('open');
    expect(bought.price).toBe(0);
    expect(dayCostsCoins(bought)).toBe(false);
    expect(isDayInteractive(bought)).toBe(true);
  });

  // Owner, 2026-08-28: coins buy the DAY, not the play. A completed day is free forever after.
  it('a completed day is done, free to replay, and shows its stars', () => {
    const cells = daysForMonth(thisMonth, now, progress({
      completed: { '2026-08-10': { stars: 3 }, '2026-08-11': { stars: 1 } },
    }), starsOf);
    expect(cellFor(cells, '2026-08-10')).toMatchObject({ state: 'done', stars: 3, price: 0 });
    expect(cellFor(cells, '2026-08-11')).toMatchObject({ state: 'done', stars: 1, price: 0 });
    expect(dayCostsCoins(cellFor(cells, '2026-08-10'))).toBe(false);
  });

  // ⚠️ The ordering that turns the pip off: completion is checked BEFORE the today/past split, so
  // solving today's puzzle moves the cell out of `today` immediately.
  it("today's cell becomes done once it is completed", () => {
    const cells = daysForMonth(thisMonth, now, progress({ completed: { '2026-08-28': { stars: 2 } } }));
    expect(cellFor(cells, '2026-08-28').state).toBe('done');
    expect(cells.filter((c) => c.state === 'today')).toEqual([]);
  });

  // Completion outranks the window too: a day you actually played must keep showing its stars
  // rather than decaying into `expired` and losing the record on screen.
  it('a completed day stays done even outside the two-month window', () => {
    const cells = daysForMonth({ year: 2026, month: 5 }, now, progress({
      completed: { '2026-06-04': { stars: 2 } },
    }), starsOf);
    expect(cellFor(cells, '2026-06-04')).toMatchObject({ state: 'done', stars: 2 });
  });

  // The rating is the GAME's rule (Court clamps to 0..3 in `dailyStarsOf`, wordweave has none), so
  // the engine hands the record over and draws whatever comes back — and draws 0 when no rule is
  // passed, rather than inventing a rating out of a stored number it was never told how to read.
  it("draws the game's rating for a done cell, calling the rule once per DONE cell only", () => {
    const seen: DailyCompletion[] = [];
    const p = progress({ completed: { '2026-08-10': { stars: 99 }, '2026-08-12': {} } });
    const rated = daysForMonthWithRule(thisMonth, now, p, (d) => { seen.push(d); return d.stars === 99 ? 2 : 1; });
    expect(cellFor(rated, '2026-08-10').stars).toBe(2);
    expect(cellFor(rated, '2026-08-12').stars).toBe(1);
    expect(seen, 'called once per DONE cell, with the stored record').toEqual([{ stars: 99 }, {}]);
    expect(rated.filter((c) => c.state !== 'done').every((c) => c.stars === 0), 'no other cell rated').toBe(true);
  });

  it('floors and clamps the authored price so the badge and the charge are one integer', () => {
    const odd = daysForMonth(thisMonth, now, progress({ price: 12.7 }));
    expect(cellFor(odd, '2026-08-01').price).toBe(12);
    const negative = daysForMonth(thisMonth, now, progress({ price: -5 }));
    expect(cellFor(negative, '2026-08-01').price, 'a day must never pay the player').toBe(0);
  });

  // Every non-blank cell must be decided. A state map that grew a hole would show an unstyled cell
  // rather than erroring, which is the silent failure this game keeps paying for.
  it('assigns every cell a state — no gaps', () => {
    const known = new Set(['blank', 'future', 'today', 'done', 'open', 'locked', 'expired']);
    for (const m of [lastMonth, thisMonth, { year: 2026, month: 8 }, { year: 2026, month: 5 }]) {
      for (const c of daysForMonth(m, now, progress())) expect(known).toContain(c.state);
    }
  });
});

describe('daysForMonth — the month boundary', () => {
  // The 1st and the last day are where an off-by-one in the leading-blank arithmetic surfaces, and
  // "today is the 1st" is the case where every other day in the month is in the future.
  it('handles today being the 1st', () => {
    const cells = daysForMonth({ year: 2026, month: 7 }, at(2026, 8, 1), progress());
    expect(cellFor(cells, '2026-08-01').state).toBe('today');
    expect(cells.filter((c) => c.state === 'locked'), 'nothing is in the past yet').toEqual([]);
    expect(cells.filter((c) => c.state === 'future')).toHaveLength(30);
  });

  it('handles today being the last day', () => {
    const cells = daysForMonth({ year: 2026, month: 7 }, at(2026, 8, 31), progress());
    expect(cellFor(cells, '2026-08-31').state).toBe('today');
    expect(cells.filter((c) => c.state === 'future')).toEqual([]);
  });

  // ⚠️ Owner's rule, and the reason the pip is worth having: a missed today becomes a payable past
  // day at midnight. Same date, one day later, and the state must have moved.
  it('yesterday becomes a priced past day once the date rolls', () => {
    const key = '2026-08-27';
    const before = daysForMonth({ year: 2026, month: 7 }, at(2026, 8, 27), progress());
    const after = daysForMonth({ year: 2026, month: 7 }, at(2026, 8, 28), progress());
    expect(cellFor(before, key).state).toBe('today');
    expect(cellFor(before, key).price).toBe(0);
    expect(cellFor(after, key).state).toBe('locked');
    expect(cellFor(after, key).price).toBe(30);
  });
});

describe('daysForMonth — DST', () => {
  // ⚠️ A calendar that walked the month by adding 86_400_000 ms at a time loses a day at
  // spring-forward and repeats one at autumn-back. This module never constructs a per-day instant —
  // the keys are string arithmetic and the length comes from the platform's own calendar — so these
  // assert the PROPERTY, and each one first proves the zone actually moved. Without that guard the
  // whole block is vacuous: a day COUNT is timezone-independent, so it would pass under any zone,
  // including one where `process.env.TZ` never took effect.
  const withTz = (tz: string, fn: () => void) => {
    const prev = process.env.TZ;
    // ⚠️ Assigning `undefined` back stores the STRING "undefined", which Node reads as UTC — so a
    // bare `process.env.TZ = prev` left every later case in this file running in UTC rather than
    // in the machine zone (#928 close-out review). Delete it instead.
    try { process.env.TZ = tz; fn(); } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
  };

  /** Every day appears once, and lands under the weekday column the platform agrees it falls on.
   *  The alignment is the half that ms-arithmetic would actually break. */
  const expectWellFormedMonth = (month: { year: number; month: number }, expectedDays: number) => {
    const cells = daysForMonth(month, at(month.year, month.month + 1, 20), progress());
    const days = cells.filter((c) => c.state !== 'blank').map((c) => c.day);
    expect(days).toHaveLength(expectedDays);
    expect(new Set(days).size, 'a day was repeated').toBe(expectedDays);
    expect(days).toEqual(Array.from({ length: expectedDays }, (_, i) => i + 1));
    for (const cell of cells) {
      if (cell.state === 'blank') continue;
      const column = cells.indexOf(cell) % 7;
      expect(column, `day ${cell.day} is under the wrong weekday column`)
        .toBe(new Date(month.year, month.month, cell.day).getDay());
    }
  };

  it('spring forward does not lose or misalign a day', () => {
    // US DST begins 8 March 2026 — 2am local does not exist that night.
    withTz('America/New_York', () => {
      expect(
        new Date(2026, 2, 1, 12).getTimezoneOffset(),
        'the zone did not actually change — this test would be vacuous',
      ).not.toBe(new Date(2026, 2, 20, 12).getTimezoneOffset());
      expectWellFormedMonth({ year: 2026, month: 2 }, 31);
    });
  });

  it('autumn back does not repeat or misalign a day', () => {
    // US DST ends 1 November 2026 — 1am local happens twice.
    withTz('America/New_York', () => {
      expect(
        new Date(2026, 9, 20, 12).getTimezoneOffset(),
        'the zone did not actually change — this test would be vacuous',
      ).not.toBe(new Date(2026, 10, 20, 12).getTimezoneOffset());
      expectWellFormedMonth({ year: 2026, month: 10 }, 30);
    });
  });

  it('a southern-hemisphere zone transitions the other way round and behaves the same', () => {
    withTz('Australia/Sydney', () => {
      expect(
        new Date(2026, 2, 1, 12).getTimezoneOffset(),
        'the zone did not actually change — this test would be vacuous',
      ).not.toBe(new Date(2026, 3, 20, 12).getTimezoneOffset());
      expectWellFormedMonth({ year: 2026, month: 3 }, 30);
    });
  });

  // A zone whose DST shift is not a whole hour, and whose offset is not a whole number of hours
  // from UTC — the shape most likely to break anything doing offset maths by hand.
  it('a half-hour-offset zone behaves the same', () => {
    withTz('Australia/Lord_Howe', () => {
      // Lord Howe shifts by THIRTY minutes, not an hour, and sits at a half-hour offset from UTC —
      // the shape most likely to break anything doing offset maths by hand.
      //
      // ⚠️ Pinned to Lord Howe's ACTUAL offsets rather than to "the offset changed": Sydney and
      // every other southern-hemisphere zone passes that weaker check, so it could not tell that
      // THIS zone was the one in effect — which is the entire reason the case exists.
      expect(new Date(2026, 2, 1, 12).getTimezoneOffset(), 'not Lord Howe — the half-hour zone is the point').toBe(-660);
      expect(new Date(2026, 3, 20, 12).getTimezoneOffset(), 'the 30-minute shift did not happen').toBe(-630);
      expectWellFormedMonth({ year: 2026, month: 3 }, 30);
    });
  });
});

describe('isTodayUnplayed — the main-menu pip', () => {
  const now = at(2026, 8, 28);

  it('is lit when today has not been completed', () => {
    expect(isTodayUnplayed(now, {})).toBe(true);
  });

  it('goes out the moment today is completed', () => {
    expect(isTodayUnplayed(now, { '2026-08-28': { stars: 1 } })).toBe(false);
  });

  // ⚠️ A backlog must NOT light the pip: it would then be lit permanently for anyone who ever
  // skipped a day, and a permanent badge is not a nudge. It asks about today alone.
  //
  // The fixture is the point: TWENTY unplayed past days, and only today completed. An earlier
  // version of this test passed an empty backlog and was structurally identical to the test above
  // it — it asserted the same thing twice and nothing about a backlog at all.
  it('ignores a backlog of unplayed past days', () => {
    // ⚠️ The FIXTURE is the test. An earlier version of this passed `{ today: done }` and nothing
    // else — no backlog at all — so it was byte-identical to the test above it and asserted the
    // same thing twice. A review caught the comment claiming a backlog the fixture never had.
    //
    // Here days 1..26 of the month are genuinely unplayed, only TODAY is done, and the pip is out.
    const completed: Record<string, { stars: number }> = { '2026-08-28': { stars: 3 } };
    expect(Object.keys(completed)).toHaveLength(1);
    expect(isTodayUnplayed(now, completed), '26 past days unplayed, today done').toBe(false);

    // And the discriminating half: the SAME 26-day backlog with today NOT done must light it.
    // Without this the assertion above passes for a predicate that ignores its argument.
    const backlogOnly: Record<string, { stars: number }> = { '2026-07-15': { stars: 2 } };
    expect(isTodayUnplayed(now, backlogOnly), 'a backlog alone must not satisfy it').toBe(true);
  });

  it('lights again when the date rolls', () => {
    const completed = { '2026-08-28': { stars: 3 } };
    expect(isTodayUnplayed(now, completed)).toBe(false);
    expect(isTodayUnplayed(at(2026, 8, 29), completed)).toBe(true);
  });
});

describe('isDailyUnlocked', () => {
  // Owner, 2026-08-28: 15 REAL puzzles, tutorial lessons excluded. The caller must therefore pass
  // `realPuzzlesSolved(progress)`, never `solvedIds.length`.
  it('unlocks at the threshold, not before', () => {
    expect(isDailyUnlocked(14, 15)).toBe(false);
    expect(isDailyUnlocked(15, 15)).toBe(true);
    expect(isDailyUnlocked(400, 15)).toBe(true);
  });

  it.each([0, -1, NaN])('a threshold of %p unlocks immediately — a setting, not a break', (t) => {
    expect(isDailyUnlocked(0, t)).toBe(true);
  });
});

describe('pickDailyLevel', () => {
  const pool = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const none = new Set<string>();

  it('picks from the pool', () => {
    expect(pool.map((p) => p.id)).toContain(pickDailyLevel(pool, none, '2026-08-28'));
  });

  // ⚠️ The property the persistence depends on: if the write is lost between choosing and
  // flushing, asking again must answer the SAME level rather than handing out a second puzzle for
  // the same day.
  it('is reproducible for a given date and salt', () => {
    const first = pickDailyLevel(pool, none, '2026-08-28', 'install-1');
    for (let i = 0; i < 5; i++) {
      expect(pickDailyLevel(pool, none, '2026-08-28', 'install-1')).toBe(first);
    }
  });

  it('never returns a level already assigned to another date', () => {
    const assigned = new Set(['a', 'b']);
    expect(pickDailyLevel(pool, assigned, '2026-08-28')).toBe('c');
  });

  // ⚠️ **The fallback that must be reachable.** ~93 days away on the current corpus, and it grows
  // with every level added — but a fallback nobody exercises is one that breaks on the day the pool
  // runs out. Driven here with a 3-level pool so it is one line away instead of three months.
  it('falls back to the whole pool once every level is assigned', () => {
    const all = new Set(pool.map((p) => p.id));
    const picked = pickDailyLevel(pool, all, '2026-08-28');
    expect(picked).not.toBeNull();
    expect(pool.map((p) => p.id)).toContain(picked);
  });

  it('returns null only for an empty pool', () => {
    expect(pickDailyLevel([], none, '2026-08-28')).toBeNull();
  });

  it('handles a pool of one', () => {
    expect(pickDailyLevel([{ id: 'only' }], none, '2026-08-28')).toBe('only');
    expect(pickDailyLevel([{ id: 'only' }], new Set(['only']), '2026-08-28')).toBe('only');
  });

  // The salt is what makes two installs diverge on the same date — the owner's "doesn't need to be
  // the same for all the player" is what lets this feature work with no backend, and this is where
  // it is cashed in. Asserted over a large pool so a collision is not mistaken for a bug.
  it('two installs can get different puzzles on the same date', () => {
    const big = Array.from({ length: 90 }, (_, i) => ({ id: `lvl-${i}` }));
    const picks = new Set(
      Array.from({ length: 12 }, (_, i) => pickDailyLevel(big, none, '2026-08-28', `install-${i}`)),
    );
    expect(picks.size, 'every install got the same puzzle — the salt is not reaching the hash')
      .toBeGreaterThan(1);
  });

  // The other half: the same install must NOT get the same puzzle every day.
  it('one install gets different puzzles on different dates', () => {
    const big = Array.from({ length: 90 }, (_, i) => ({ id: `lvl-${i}` }));
    const picks = new Set(
      ['2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31']
        .map((k) => pickDailyLevel(big, none, k, 'install-1')),
    );
    expect(picks.size).toBeGreaterThan(1);
  });

  // Spreads across the pool rather than favouring one index — a hash that collapsed (a broken
  // `Math.imul`, say) would still pass every test above.
  it('spreads picks across the pool over a month', () => {
    const big = Array.from({ length: 90 }, (_, i) => ({ id: `lvl-${i}` }));
    const picks = new Set(
      Array.from({ length: 31 }, (_, i) => pickDailyLevel(big, none, `2026-08-${String(i + 1).padStart(2, '0')}`, 's')),
    );
    expect(picks.size).toBeGreaterThan(20);
  });
});

/**
 * #764 — the calendar's "today" is a HIGH-WATER MARK, so the paid surface survives a clock a player
 * can move.
 *
 * The defect, measured before the fix with ONE fixed instant and no clock movement at all:
 * `dateKeyOf` reads `2026-09-09` in Tokyo and `2026-09-08` in Niue, so a player who had skipped
 * 09-08 could switch zone and be served that 30-coin `locked` day as today's free challenge.
 *
 * ⚠️ **Every case here holds the INSTANT fixed and varies only the FLOOR.** That is the whole point
 * of the mechanism: a time zone moves the calendar without moving the instant, which is why
 * `trustedNow()`/`effectiveNow()`'s anchor and any fail-closed `now < lastSeen` check see nothing.
 * A test that moved `nowMs` instead would be testing a clock change — a different, ACCEPTED, vector
 * — and would pass with the floor ignored entirely.
 */
describe('effectiveDayKey — the floor under "today" (#764)', () => {
  const now = at(2026, 9, 8, 12);   // local 2026-09-08

  it('a LATER floor wins, which is the direction that closes the hole', () => {
    expect(effectiveDayKey(now, '2026-09-09')).toBe('2026-09-09');
  });

  it('an EARLIER floor loses, so a floor can never hold "today" back', () => {
    // The accept side. Without this, a fix that simply always returned the floor would pass the
    // test above and freeze every player's calendar on the first day they ever opened it.
    expect(effectiveDayKey(now, '2026-09-01')).toBe('2026-09-08');
  });

  it('an EQUAL floor is a no-op', () => {
    expect(effectiveDayKey(now, '2026-09-08')).toBe('2026-09-08');
  });

  it('an absent floor degrades to the live local date', () => {
    // `''` is every player who has not opened the calendar since this landed.
    expect(effectiveDayKey(now, '')).toBe('2026-09-08');
  });

  it('a SHAPE-valid but impossible date loses too — the worse half of the junk case', () => {
    // ⚠️ `'9999-99-99'` passes `isDateKey`'s regex, and it is strictly worse than `'zzz'`:
    // `readDaily` accepts it as well, it is the MAXIMUM of every comparison so it wins the merge
    // permanently, and `new Date(9999, 98, 99)` resolves to an instant in year 10007 — which would
    // drive the whole calendar eight thousand years out and brick the Daily for that account on
    // every device. Shape is not enough where the value orders a floor.
    expect(effectiveDayKey(now, '9999-99-99')).toBe('2026-09-08');
    expect(effectiveDayKey(now, '2026-02-30'), 'February 30th is not a date').toBe('2026-09-08');
    expect(effectiveDayKey(now, '2026-13-01'), 'there is no month 13').toBe('2026-09-08');
  });

  it('but a REAL leap day is accepted — the guard must not reject valid dates', () => {
    // The accept side. Asked of `Date` rather than range-checked by hand, so February and leap
    // years are the platform calendar's answer: 2028 is a leap year, 2027 is not.
    expect(effectiveDayKey(now, '2028-02-29')).toBe('2028-02-29');
    expect(effectiveDayKey(now, '2027-02-29'), '2027 is not a leap year').toBe('2026-09-08');
  });

  it('a floor that is not a date key at all loses, however high it SORTS', () => {
    // ⚠️ The dangerous direction. Every letter is above every digit in ASCII, so a junk string
    // would beat any real date on a bare `>` and push "today" past the end of the calendar —
    // pricing every day the player can see. `isDateKey` is what stops it, and `readDaily` rejects
    // such a value on the way in as well; this pins the pure half.
    expect(effectiveDayKey(now, 'tomorrow')).toBe('2026-09-08');
    expect(effectiveDayKey(now, '9999-99-99x')).toBe('2026-09-08');
  });
});

describe('daysForMonth — the floor defends the PAID surface (#764)', () => {
  const month = { year: 2026, month: 8 };          // September 2026
  const localSept8 = at(2026, 9, 8, 12);
  /** What `systems.ts`'s `dailyNowMs()` hands in: the raw clock with the floor already applied. */
  const withFloor = (floor: string): number => effectiveNowMs(localSept8, floor);
  const unplayed = (floor: string): DayCell[] =>
    daysForMonth(month, withFloor(floor), progress({ price: 30 }));

  it('with no floor, 09-08 IS today and free — the unchanged behaviour', () => {
    // The control. This is what every existing player sees, and what the case below has to differ
    // from for the fix to be doing anything at all.
    const cell = cellFor(unplayed(''), '2026-09-08');
    expect(cell.state).toBe('today');
    expect(cell.price).toBe(0);
  });

  it('a floor of 09-09 keeps 09-08 LOCKED at its price, with the instant unmoved', () => {
    // The defect, exactly: the player was on 09-09, moved the zone back, and the device now reads
    // 09-08. The floor remembers, so the day they would have had to buy stays bought-or-locked.
    const cell = cellFor(unplayed('2026-09-09'), '2026-09-08');
    expect(cell.state).toBe('locked');
    expect(cell.price).toBe(30);
  });

  it('and 09-09 is the free one instead — the floor MOVES today, it does not delete it', () => {
    // Without this, "locked" above could be satisfied by a fix that simply made every cell past.
    const cell = cellFor(unplayed('2026-09-09'), '2026-09-09');
    expect(cell.state).toBe('today');
    expect(cell.price).toBe(0);
  });

  it('a day the player already BOUGHT is still open under a floor — coins keep buying the day', () => {
    // The floor must not undo #420's rule. A purchased past day is `open` and free whatever the
    // clock says, so a player who paid 30 coins before moving zone is not charged twice.
    const cells = daysForMonth(month, withFloor('2026-09-09'), progress({
      price: 30, purchased: { '2026-09-08': 'lvl-a' },
    }));
    expect(cellFor(cells, '2026-09-08').state).toBe('open');
    expect(cellFor(cells, '2026-09-08').price).toBe(0);
  });

  it('moving FORWARD is still accepted — a raised floor serves that day free', () => {
    // ⚠️ Deliberately still possible (owner, 2026-09-09). `dailyCalendar.ts`'s banner accepts farming free
    // dailies; only the paid surface is defended. A fix that closed this too would be a different,
    // larger ruling — and this test is what makes that a decision rather than a drift.
    const cell = cellFor(unplayed('2026-09-10'), '2026-09-10');
    expect(cell.state).toBe('today');
    expect(cell.price).toBe(0);
  });

  it('the day the player skipped to get there is the price of it', () => {
    // The bound on the accepted vector, and what makes it "spending tomorrow" rather than minting:
    // reaching 09-10 early leaves 09-09 behind as a past day at full price.
    const cell = cellFor(unplayed('2026-09-10'), '2026-09-09');
    expect(cell.state).toBe('locked');
    expect(cell.price).toBe(30);
  });
});

/**
 * ⚠️ **The floor must move the calendar's WINDOW too, not just the day it names** — close-out
 * review finding, and the reason the floor is applied to the INSTANT rather than threaded into
 * `daysForMonth` alone.
 *
 * `monthsForCalendar` caps the window's forward end at `monthOf(nowMs)`. With the floor applied
 * only inside `daysForMonth`, a floor in a LATER month named a day that no pageable month
 * contained: no cell anywhere in state `today`, the `>` arrow unable to reach it, and the menu pip
 * lit pointing at it. Reached with no clock cheat at all — a player in Tokyo opens the app at 00:10
 * on Oct 1, then flies to LA where it is still Sep 30.
 */
describe('the floor moves the calendar WINDOW, not just the day (#764 close-out)', () => {
  const localSept30 = at(2026, 9, 30, 12);
  const now = effectiveNowMs(localSept30, '2026-10-01');

  it('October is pageable once the floor is in it', () => {
    const months = monthsForCalendar(now);
    expect(months.some((m) => m.year === 2026 && m.month === 9), 'October must be reachable').toBe(true);
  });

  it('and the floor day has a `today` cell in it', () => {
    const cells = daysForMonth({ year: 2026, month: 9 }, now, progress({ price: 30 }));
    expect(cellFor(cells, '2026-10-01').state).toBe('today');
  });

  it('while the raw local date would have left the window a month behind — the control', () => {
    // Without this the two assertions above pass for a calendar that simply always shows October.
    const months = monthsForCalendar(localSept30);
    expect(months.some((m) => m.year === 2026 && m.month === 9),
      'fixture: on the raw clock October is NOT pageable, which is the defect').toBe(false);
  });
});

describe('isTodayUnplayed — the pip asks about the FLOOR day, not the local one (#764)', () => {
  // Local date is 09-08; the floor says the player has already been seen on 09-09. So "today", for
  // the pip exactly as for the grid, is 09-09 — and the pip is handed the same EFFECTIVE instant
  // `dailyNowMs()` hands everything else. Both cases are chosen so the RAW-clock version gives the
  // OPPOSITE answer; otherwise they would pass with the fix removed.
  const raw = at(2026, 9, 8, 12);
  const now = effectiveNowMs(raw, '2026-09-09');

  it('goes out when the FLOOR day is completed, though the local day is not', () => {
    // On the raw clock this asks about 09-08, finds it unplayed, and lights the pip — pointing the
    // player at a cell `daysForMonth` is drawing as a past `locked` day at 30 coins.
    const completed = { '2026-09-09': { stars: 2 } };
    expect(isTodayUnplayed(now, completed)).toBe(false);
    expect(isTodayUnplayed(raw, completed), 'fixture: the raw clock gives the opposite answer').toBe(true);
  });

  it('stays lit when the LOCAL day is completed but the floor day is not', () => {
    // The opposite direction, and the half that stops "always false under a floor" from passing.
    const completed = { '2026-09-08': { stars: 2 } };
    expect(isTodayUnplayed(now, completed)).toBe(true);
    expect(isTodayUnplayed(raw, completed), 'fixture: the raw clock gives the opposite answer').toBe(false);
  });
});
