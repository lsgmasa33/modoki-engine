/** The re-sync decision behind `useBufferedValue` (fields.tsx): given the text a field is showing
 *  and a value the store just handed it, keep the text or replace it?
 *
 *  Kept out of the hook so it can be unit-tested without mounting a panel (docs/editor.md § Panels).
 *
 *  Two ways the store's value can be this field's OWN commit coming back, and neither may touch
 *  the text:
 *  - **The echo of the latest keystroke** (#242): the text already MEANS the store's value, so a
 *    re-sync could only reformat it (`''`/`-` → `0`), which is the destruction #242 measured.
 *  - **A LATE echo of an earlier keystroke** (#1411): each keystroke commits, and the value comes
 *    back a render later — by which time the next keystroke has already landed. Measured live in an
 *    unfocused window (`document.hasFocus() === false`, so the focus guard never arms): typing the
 *    alphabet, React wrote `…qr` over `…qrs` and the `t` landed after it — the `s` was gone, and so
 *    was about one character per run. The echoed value matches nothing on screen, so without a
 *    record of what this field committed it is indistinguishable from an external change.
 *
 *  So the field remembers what it committed (`pending`). A store value found there is a late echo:
 *  skip it, and drop it and everything before it (echoes arrive in commit order). Anything else is a
 *  genuine external change (a gizmo drag, an undo, a selection change): re-sync, and forget the
 *  record — a value that later returns to one this field once typed must re-sync, not be mistaken
 *  for its echo. Entries expire after {@link ECHO_WINDOW_MS}, because the commit that ends an edit
 *  has nothing after it to consume it, and nothing may depend on a blur event to clear it (#233). */

export interface PendingCommit<T> { value: T; at: number }

/** How long a commit is still expected to echo back. An echo lags a frame or two; this only bounds
 *  how long a stale entry can shadow a genuine external change equal to it (an undo right after
 *  typing, back to a value that was typed a moment ago). */
export const ECHO_WINDOW_MS = 1000;

/** How a field decides "the store handed back what I committed", and how it writes a value it
 *  re-syncs to. Everything defaults to exact (`Object.is`, `String`), which is right for a field
 *  shown EXACTLY as stored.
 *
 *  A field whose value is a PROJECTION of what it commits needs more (#1407). The Inspector rounded
 *  to 2dp before the field saw the value, so typing `4.1256` committed 4.1256 and got back 4.13.
 *  That value was never committed and does not equal `parse(text)`, so the field's own echo read as
 *  an external change and overwrote the text mid-edit. Measured live on a two-entity selection in an
 *  unfocused window.
 *
 *  TWO comparators, because the two checks in {@link resyncBuffered} have different lifetimes:
 *  - `same` matches a PENDING commit (#1411). It may be loose (equal at the displayed precision),
 *    because a pending entry expires after {@link ECHO_WINDOW_MS}, so at worst a genuine external
 *    change equal to it at that precision is hidden for one second.
 *  - `means` is the #242 check, "the text already means this value". It has NO expiry and holds
 *    until the next external change or a blur, which in an unfocused window may never come. So it
 *    must be TIGHT. At display precision, an undo from 4.1256 to 4.13 left `4.1256` on screen
 *    indefinitely (review finding). It absorbs only representation noise, such as a unit round
 *    trip (30° → rad → 29.999999999999996°). */
export interface EchoMatch<T> {
  same?: (a: T, b: T) => boolean;
  means?: (a: T, b: T) => boolean;
  format?: (v: T) => string;
}

/** Match pending echoes and display at `precision` decimal places, the rounding the Inspector has
 *  always shown. `means` absorbs float noise only (12 significant digits). `===`, not `Object.is`:
 *  a value that rounds to -0 displays as `0`, and must match 0. */
export function roundedTo(precision: number): Required<EchoMatch<number>> {
  const round = (v: number) => parseFloat(v.toFixed(precision));
  const denoise = (v: number) => Number(v.toPrecision(12));
  return {
    same: (a, b) => round(a) === round(b),
    means: (a, b) => denoise(a) === denoise(b),
    format: (v) => String(round(v)),
  };
}

export function resyncBuffered<T>(
  current: string,
  external: T,
  pending: readonly PendingCommit<T>[],
  parse: (raw: string) => T,
  now: number,
  match: EchoMatch<T> = {},
): { text: string | null; pending: PendingCommit<T>[] } {
  const same = match.same ?? Object.is;
  const live = pending.filter((p) => now - p.at <= ECHO_WINDOW_MS);
  const hit = live.findIndex((p) => same(p.value, external));
  // The text already means this value, so keeping it is never a loss (#242). That holds only while
  // `means` stays tight: see EchoMatch.
  if ((match.means ?? Object.is)(parse(current), external)) return { text: null, pending: hit >= 0 ? live.slice(hit + 1) : live };
  // A late echo of this field's own earlier commit (#1411).
  if (hit >= 0) return { text: null, pending: live.slice(hit + 1) };
  return { text: (match.format ?? String)(external), pending: [] };
}
