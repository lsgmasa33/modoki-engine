/** How a FILTERED read discloses what its filter left out (#1214) — ONE implementation for every
 *  read that takes a filter, on the editor, the device and the backend.
 *
 *  The defect this exists for: a filtered read that matched nothing answered an empty list with
 *  nothing beside it, so "the filter matched nothing" (a typo, a wrong layer) was byte-identical to
 *  "nothing exists" — or worse, the reply EXPLAINED the empty result from the filtered list ("the
 *  surface is not hit-testable") and the agent had no reason to doubt it. The #1208 sweep found 33
 *  filtered reads and 17 that did this, because nothing shared made a read disclose its population
 *  and each one re-decided whether to.
 *
 *  Two shapes, by what the population IS (docs/mcp-tool-conventions.md §2):
 *  - a RING (console, journals) always answers `ringTotal` plus a histogram over the whole ring,
 *    filter ignored — {@link histogram};
 *  - a SET (entities, rects, series, handles, regions) answers a hint only when the filter matched
 *    nothing, naming the unfiltered count and the live vocabulary — {@link emptyFilterHint}. Only the
 *    empty case pays for the unfiltered read.
 *
 *  Dependency-free: the renderer ops, the Node backend and the `game-debug-mcp` package all import it
 *  as a value. */

/** Count `items` by `keyOf`. The histogram a ring reply carries beside `ringTotal`. */
export function histogram<T>(items: Iterable<T>, keyOf: (item: T) => string): Record<string, number> {
  // Null prototype: a key from a provider (a handle kind, a region kind) named `constructor` or
  // `toString` would otherwise start from the inherited function and stringify into the count.
  const out: Record<string, number> = Object.create(null);
  for (const it of items) {
    const k = keyOf(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** The filter as the caller wrote it, for a sentence: `name=Plyer, layer=2d`. Unset, empty-string and
 *  empty-array entries are left out — they did not filter anything. */
export function describeFilter(filter: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(filter)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (Array.isArray(v)) {
      if (v.length) parts.push(`${k}=[${v.join(',')}]`);
      continue;
    }
    parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return parts.join(', ');
}

/** Largest vocabulary a hint lists. The hint is a pointer, not a dump: a scene's full name list is the
 *  unbounded payload a filter exists to avoid. */
export const LIVE_VOCABULARY_CAP = 12;

/** Edit distance, case-insensitive, on at most 64 chars a side — a ranking key, not a spell checker. */
function distance(a: string, b: string): number {
  const x = a.toLowerCase().slice(0, 64), y = b.toLowerCase().slice(0, 64);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

/** `{a, b, c, … +N more}` — distinct, capped, blank values dropped. Sorted alphabetically, or — given
 *  `near`, the value the caller asked for — closest first, so a typo's intended value is in the capped
 *  list even when the vocabulary is hundreds long (an alphabetical cut would show the first twelve). */
export function liveSet(values: Iterable<string>, cap = LIVE_VOCABULARY_CAP, near?: string): string {
  let uniq = [...new Set([...values].filter((v) => typeof v === 'string' && v.trim() !== ''))].sort();
  if (near) {
    const q = near.toLowerCase();
    const rank = (v: string) => (v.toLowerCase().includes(q) ? -1 : distance(v, near));
    const ranked = uniq.map((v) => [v, rank(v)] as const);
    ranked.sort((a, b) => a[1] - b[1]); // stable: ties keep the alphabetical order
    uniq = ranked.map(([v]) => v);
  }
  const shown = uniq.slice(0, Math.max(0, cap));
  const more = uniq.length - shown.length;
  return `{${shown.join(', ')}${more > 0 ? `${shown.length ? ', ' : ''}… +${more} more` : ''}}`;
}

export interface EmptyFilterDisclosure {
  /** The row noun, singular: `entity`, `rect`, `series`. */
  what: string;
  /** {@link describeFilter}'s output, or any short phrase naming the filter. */
  filter: string;
  /** How many rows the same read returns with NO filter. */
  unfilteredCount: number;
  /** What `unfilteredCount` counts, finishing "but N …". Default `exist unfiltered`. */
  unfilteredLabel?: string;
  /** Named live vocabularies, e.g. `{ name: names, layer: layers }`. Empty ones are skipped. */
  live?: Record<string, Iterable<string>>;
  /** Per vocabulary, the value the caller asked for — lists that vocabulary closest-first. */
  near?: Record<string, string | undefined>;
}

/** The hint for a filtered read that matched nothing. It says which of the two readings is true —
 *  "nothing exists" or "the filter missed" — because an empty list cannot say it by itself. */
export function emptyFilterHint(d: EmptyFilterDisclosure): string {
  if (d.unfilteredCount === 0) {
    return `no ${d.what} matches ${d.filter} — and none exist to match (0 ${d.unfilteredLabel ? d.unfilteredLabel.replace(/^exist\s*/, '') : 'unfiltered'}), so the filter is not why this is empty.`;
  }
  const vocab = Object.entries(d.live ?? {})
    .map(([k, vs]) => [k, [...vs]] as const)
    .filter(([, vs]) => vs.some((v) => typeof v === 'string' && v.trim() !== ''))
    .map(([k, vs]) => `${k} ∈ ${liveSet(vs, LIVE_VOCABULARY_CAP, d.near?.[k])}`);
  return `no ${d.what} matches ${d.filter}, but ${d.unfilteredCount} ${d.unfilteredLabel ?? 'exist unfiltered'}.` +
    (vocab.length ? ` Live now: ${vocab.join('; ')}.` : '') +
    ' Check the spelling, or drop the filter.';
}
