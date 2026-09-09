/** The ONE `requestBrowser` stub for router tests (#889 phase 3).
 *
 *  ## Why this is shared rather than copied
 *
 *  Every router test file owns its own `makeCtx`, and each one defaulted `requestBrowser` to
 *  `async () => ({})` — "a renderer that answers with nothing". That was a faithful stub while the
 *  routes asked exactly one op. It stopped being one the moment `resolve-unsaved` existed:
 *
 *    • the gate REQUIRES a `covers` list, and treats a reply without one as "the renderer could
 *      not answer" — which is correct, and which turned every gated route in those files into a
 *      503 the moment it was gated;
 *    • a single object answering every op is a fake modelling behaviour nothing has. Handing an
 *      `editor-state` payload back for `resolve-unsaved` makes every case look like a skewed
 *      renderer, and an assertion written against that is defending the fake.
 *
 *  Five copies of that stub existed, and #867's scar is precisely this: a hand-copied helper is
 *  born incomplete and nobody notices, because the copy that matters is the one nobody edited. So
 *  the reply SHAPE lives here once. The `makeCtx` copies themselves are left alone — they differ
 *  in project root and path resolution on purpose, and they are not what broke.
 *
 *  ⚠️ **`covers` echoes what the caller ASKED for** rather than being a fixed four-element list.
 *  A fixed list would answer "yes I cover that" to a route that under-declares its registries,
 *  which is the skew check's whole subject — the stub must not be more generous than the renderer.
 */

import { vi } from 'vitest';

export type StubHold = { path: string; registry: string; detail?: string };

export const relay = (opts: {
  /** What `editor-state` answers. Default: a stopped editor. */
  editorState?: Record<string, unknown>;
  /** What `resolve-unsaved` reports as held. Default: nothing. */
  holds?: StubHold[];
  /** Extra ops this case needs (e.g. `apply-scene-ops`), by op name. */
  ops?: Record<string, (params?: unknown) => unknown>;
} = {}) => vi.fn(async (op: string, params?: unknown) => {
  if (opts.ops && op in opts.ops) return opts.ops[op](params);
  if (op === 'editor-state') return opts.editorState ?? { playState: 'stopped' };
  if (op === 'resolve-unsaved') {
    const asked = (params as { registries?: string[] } | undefined)?.registries
      ?? ['dirtyAsset', 'pendingMeta', 'pendingBaseScene', 'liveScene'];
    // ⚠️ **Filtered by the ask, exactly as the real op filters.** A stub that returns every row
    // regardless of scope is MORE PERMISSIVE than production, and the tests that would catch the
    // difference are the scoping tests themselves — so they would be defending the fake. Caught
    // exactly that way: `/api/asset-write` scopes to `dirtyAsset`, and its "an unrelated liveScene
    // hold must not refuse this write" case failed against a stub that handed back the liveScene
    // row anyway.
    const askedPaths = (params as { paths?: string[] } | undefined)?.paths;
    const holds = (opts.holds ?? []).filter((h) =>
      asked.includes(h.registry) && (askedPaths === undefined || askedPaths.includes(h.path)));
    // A `discard` ask reports back what it dropped, the way the real op does — a route that
    // asserts on `discardedParked` would otherwise be asserting on a stub that never discards.
    const wantDiscard = new Set((params as { discard?: string[] } | undefined)?.discard ?? []);
    const discarded = holds.filter((h) => wantDiscard.has(h.registry));
    return { ok: true, holds, discarded, covers: asked };
  }
  return {};
});
