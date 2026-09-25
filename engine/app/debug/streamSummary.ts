/** Tail-with-counts: the summary-first shape for the append-only agent streams
 *  (console logs, the game journal, the editor journal).
 *
 *  These are ring buffers. They look tiny on a quiet session and enormous on a real one:
 *  measured worst cases are ~20–27k tokens for the 500-entry console ring, ~257k–582k for
 *  the 10,000-event game journal (a physics-heavy Play session is `@contact`-dominated at
 *  ~226 bytes/event), and ~54k–126k for the 2,000-event editor journal. Returning the whole
 *  window on a bare call is never what the caller wanted — they want *what just happened*,
 *  plus enough shape to know whether to ask for more.
 *
 *  THE ORDERING RULE THAT MATTERS: counts are computed over the FULL filtered set, BEFORE
 *  the tail slice. Count after slicing and `byType` degenerates into "the types among the
 *  50 I showed you", which is worse than no counts at all — it looks like a summary of the
 *  buffer and is actually a summary of the excerpt.
 *
 *  This is a boundary helper. It is called from the agent op handlers, never from the
 *  producers (`journalEvents`, `readEditorJournal`, `dumpConsoleLogs`), which stay
 *  full-fidelity for the in-process consumers: the Debug Menu's JournalTab, and `diagnose`,
 *  which reads `dumpConsoleLogs({level:'error'}).logs` directly. See
 *  `docs/mcp-response-budget.md` — "shape the payload at the BOUNDARY, never in the producer". */

export interface TailResult<T> {
  /** The tail — the most RECENT `limit` items (streams are append-ordered). */
  items: T[];
  /** How many items matched the filters, before the tail was taken. */
  total: number;
  truncated: boolean;
  /** Histogram over the FULL filtered set, not over `items`. */
  byType: Record<string, number>;
}

/** Take the last `limit ?? defaultLimit` items, and histogram the whole set by `typeOf`.
 *  An EXPLICIT limit always wins — including a huge one, which is the "give me everything"
 *  escape hatch. Only a caller who passed no limit gets the default. */
export function tailWithCounts<T>(
  items: readonly T[],
  typeOf: (item: T) => string,
  opts: { limit?: number; defaultLimit: number },
): TailResult<T> {
  const byType: Record<string, number> = {};
  for (const it of items) {
    const k = typeOf(it);
    byType[k] = (byType[k] ?? 0) + 1;
  }
  const { items: tail, truncated } = takeTail(items, opts.limit, opts.defaultLimit);
  return { items: tail, total: items.length, truncated, byType };
}

/** Take the last N — the ONLY place the tail arithmetic lives.
 *
 *  Two traps, both of which have shipped here at least once:
 *   - `slice(-0)` is `slice(0)` — the WHOLE array. A `limit:0` "just give me the counts" read
 *     would silently return the entire ring, the exact opposite of what was asked.
 *   - `limit ?? defaultLimit` does NOT catch NaN (`NaN ?? 50` is NaN). A NaN limit then makes
 *     `length > NaN` false and `NaN <= 0` false, so the tail returns everything: a `?limit=abc`
 *     typo becomes a full-ring flood.
 *
 *  Exported so no caller is tempted to re-derive it. `agentEditorOps`' merged `timeline` did,
 *  and re-created the `slice(-0)` bug this comment describes. */
export function takeTail<T>(items: readonly T[], limit: number | undefined, defaultLimit: number): { items: T[]; truncated: boolean } {
  // A negative limit is 0 — else `0 > -3` reports an EMPTY list as truncated (#1559 review).
  const n = Math.max(0, typeof limit === 'number' && Number.isFinite(limit) ? limit : defaultLimit);
  const truncated = items.length > n;
  return { items: n <= 0 ? [] : truncated ? items.slice(-n) : [...items], truncated };
}

/** Take the FIRST n (the OLDEST) — for FORWARD-cursor incremental polling (since/sinceCap).
 *  takeTail would drop the oldest-after-cursor block PERMANENTLY: the un-returned events have a
 *  LOWER seq/cap than the returned newest-N window, so no forward cursor can ever reach them, and
 *  advancing the cursor to the newest cap seen skips them for good. takeHead returns the oldest
 *  window instead; pair it with a nextCursor = the last returned item's seq/cap so the next poll
 *  continues contiguously with no gap. Same NaN/`slice(0,0)` guards as takeTail. */
export function takeHead<T>(items: readonly T[], limit: number | undefined, defaultLimit: number): { items: T[]; truncated: boolean } {
  const n = Math.max(0, typeof limit === 'number' && Number.isFinite(limit) ? limit : defaultLimit);
  const truncated = items.length > n;
  return { items: n <= 0 ? [] : truncated ? items.slice(0, n) : [...items], truncated };
}

/** The one line that turns a truncated answer into an actionable one. */
export function tailHint(kind: string, shown: number, total: number, extra = ''): string {
  return `Showing the last ${shown} of ${total} ${kind} (newest last). Raise limit=N for more${extra}.`;
}

/** Ring-buffer tail defaults, chosen from MEASURED bytes-per-entry so a bare call lands in
 *  the low thousands of tokens rather than the tens of thousands:
 *    console  ~162 B/entry  → 50  ≈ 8k chars  (ring cap 500 ⇒ ~20–27k tok unbounded)
 *    journal  ~102–226 B/ev → 100 ≈ 10–23k chars (ring cap 10,000 ⇒ ~257–582k tok)
 *    editor   ~130–253 B/ev → 100 ≈ 13–25k chars (ring cap 2,000 ⇒ ~54–126k tok) */
export const CONSOLE_TAIL_DEFAULT = 50;
export const JOURNAL_TAIL_DEFAULT = 100;
export const EDITOR_JOURNAL_TAIL_DEFAULT = 100;
