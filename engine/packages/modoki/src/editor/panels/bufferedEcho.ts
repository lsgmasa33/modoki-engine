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

export function resyncBuffered<T>(
  current: string,
  external: T,
  pending: readonly PendingCommit<T>[],
  parse: (raw: string) => T,
  now: number,
): { text: string | null; pending: PendingCommit<T>[] } {
  const live = pending.filter((p) => now - p.at <= ECHO_WINDOW_MS);
  const hit = live.findIndex((p) => Object.is(p.value, external));
  // The text already means this value — keeping it is never a loss (#242).
  if (Object.is(parse(current), external)) return { text: null, pending: hit >= 0 ? live.slice(hit + 1) : live };
  // A late echo of this field's own earlier commit (#1411).
  if (hit >= 0) return { text: null, pending: live.slice(hit + 1) };
  return { text: String(external), pending: [] };
}
