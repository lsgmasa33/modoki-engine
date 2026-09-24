/** The gameplay recorder's boot-retry policy (#1518) — pure, so it is testable without a browser.
 *
 *  `record-take.mjs` boots the game in a fresh page and steps it until it is on screen. The page
 *  can RELOAD during that boot: on a cold dependency cache Vite discovers the game's native-SDK
 *  deps mid-boot, re-optimises and forces a full reload (#1520), and `--url` pointed at a running
 *  editor's server reloads on any game-code save. Playwright then throws `Execution context was
 *  destroyed`, and before this the render died with it.
 *
 *  A reloaded boot is thrown away WHOLE and started again in a fresh browser context, not resumed
 *  on the same page: the first document's partial boot may already have written `localStorage`
 *  (the game's prefs, a quality-probe verdict), and a second boot on top of that starts from state
 *  the take never had. Safe because no take frame has been stepped yet. */

/** How many boot attempts before a reloading page is reported as a failure. A reload that is not
 *  one-off (a server reloading in a loop) must still end the render. */
export const MAX_BOOT_ATTEMPTS = 3;

/** Did the page reload? `navigations` counts main-frame `framenavigated` events, the `goto` being
 *  the first — nothing in the app writes the URL during boot.
 *
 *  ⚠️ **The error text is the signal that carries the Vite reload, not the counter.** The reload
 *  destroys the old execution context BEFORE the new document commits, so the evaluate it killed
 *  rejects while `framenavigated` is still undelivered: measured on a cold cache, the counter alone
 *  missed it (1/1) and the text alone caught it (1/1). The counter covers the other case — a reload
 *  that lands BETWEEN two evaluates, so nothing throws and the boot finishes in the second document. */
export function pageReloaded(navigations, error) {
  return navigations > 1 || RELOAD_ERROR.test(error?.message ?? '');
}

/** Playwright's words for an operation a navigation cut off: an evaluate whose context the reload
 *  destroyed, or a `goto` that a second navigation interrupted or aborted before `load`. */
const RELOAD_ERROR = /Execution context was destroyed|interrupted by another navigation|net::ERR_ABORTED/;

/** How `bootAttempt` classifies a FAILED attempt: a reload unless the render is being cancelled.
 *  A cancel closes the browser under the attempt, and a retry would open a context on a browser
 *  that is gone. Here, not inline, so the error argument — the signal the live reload actually
 *  carries — is under test (review of #1518). */
export function failedAttemptReloaded({ navigations, error, cancelling }) {
  return !cancelling && pageReloaded(navigations, error);
}

/** Run `attempt(n)` until one boots without a reload.
 *
 *  `attempt` resolves `{ reloaded, value }` or `{ reloaded, error }` — it catches its own error so
 *  it can say whether a reload came first. An attempt whose page reloaded is discarded whether it
 *  threw or not: one that "succeeded" after a reload booted the second document on the first one's
 *  writes. An error with NO reload behind it is the game's own failure and is thrown at once —
 *  retrying it would only triple the time to the same message.
 *
 *  `discard(outcome)` closes a thrown-away attempt; `onReload(n)` reports it. Resolves
 *  `{ value, reloads }`, where `reloads` is how many attempts were thrown away. */
export async function bootWithReloadRetry(attempt, { maxAttempts = MAX_BOOT_ATTEMPTS, discard = async () => {}, onReload = () => {} } = {}) {
  for (let n = 1; ; n++) {
    const outcome = await attempt(n);
    if (!outcome.reloaded) {
      if ('error' in outcome) throw outcome.error;
      return { value: outcome.value, reloads: n - 1 };
    }
    await discard(outcome);
    if (n >= maxAttempts) {
      const cause = 'error' in outcome ? `: ${outcome.error?.message ?? outcome.error}` : '';
      throw new Error(`the game page reloaded during boot on all ${maxAttempts} attempts${cause}`);
    }
    onReload(n);
  }
}
