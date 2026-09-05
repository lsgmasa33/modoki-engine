/** Text relayout dirty-signal — mirrors `markUIDirty` (uiTreeStore). Bumped when
 *  something that affects laid-out text changes OUTSIDE the per-entity trait hash
 *  the renderers already track each frame:
 *   - an async font atlas finishes loading (text that was waiting can now lay out),
 *   - a dynamic provider generates a new glyph + grows its atlas (Phase 7).
 *
 *  The renderers compare a stored version to {@link getTextDirtyVersion} and force a
 *  full text re-evaluation when it changed. A monotonic counter (not a boolean) so
 *  multiple observers each detect the change exactly once. */

let _version = 0;
/** Counts ONLY un-attributed bumps (no fontId given). Kept separate from `_version`
 *  (which counts both attributed and un-attributed bumps) so a per-font read can add
 *  just this in — reusing `_version` would make every attributed bump move every
 *  font's value and defeat the whole point of attributing bumps by font. */
let _globalOnly = 0;
/** Per-font bump counts, keyed by font GUID. */
const _byFont = new Map<string, number>();
const listeners = new Set<() => void>();

/** Signal that laid-out text may be stale and should be rebuilt next frame. O(1).
 *  Pass the font GUID when the caller knows which font changed, so unrelated fonts'
 *  text doesn't get rebuilt too (#696) — omit it when the caller can't name one. */
export function markTextDirty(fontId?: string): void {
  _version++;
  if (fontId !== undefined) {
    _byFont.set(fontId, (_byFont.get(fontId) ?? 0) + 1);
  } else {
    _globalOnly++;
  }
  for (const l of listeners) l();
}

/** The current dirty version — renderers store the last value they acted on and
 *  re-evaluate when it differs.
 *
 *  With no `fontId`, returns the global counter (unchanged contract: bumps by
 *  exactly 1 per `markTextDirty()` call, attributed or not).
 *
 *  With a `fontId`, returns `_globalOnly + (bumps attributed to that font)` — the
 *  sum, not just the per-font count. As of this writing every `markTextDirty()` call
 *  in `src/` passes a font GUID, so `_globalOnly` never moves today; the fallback is
 *  kept so a FUTURE caller that cannot name a font still invalidates every font,
 *  rather than being silently ignored by a per-font read. Both counters only ever
 *  increase, so the sum is strictly increasing per font and two distinct states
 *  cannot collide. The no-argument form of this function is exercised only by this
 *  module's own test today (no production call site omits `fontId`). */
export function getTextDirtyVersion(fontId?: string): number {
  if (fontId === undefined) return _version;
  return _globalOnly + (_byFont.get(fontId) ?? 0);
}

/** Subscribe to dirty bumps (e.g. to schedule a repaint). Returns an unsubscribe. */
export function onTextDirty(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
