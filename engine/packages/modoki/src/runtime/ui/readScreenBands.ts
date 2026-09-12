import type { World } from 'koota';
import type { Band } from '../core/screenBands';
import { ScreenBand } from '../traits/ScreenBand';

export interface ReadScreenBandsOptions<R extends string> {
  /** The role vocabulary. A band whose role is not in here is SKIPPED, never coerced. */
  readonly accept: readonly R[];
  /** The roles that must ALL be present, or the authored stack is refused wholesale. Often a
   *  subset of `accept`: a game can accept a decorative band it does not depend on. */
  readonly require: readonly R[];
  /** The no-scene fallback, returned when a world authors no usable stack. */
  readonly fallback: readonly Band<R>[];
  /** Reports an unusable authored stack. Called with every problem in ONE message. The caller owns
   *  the once-per-world latching and the wording — see the note below. */
  readonly warn?: (message: string) => void;
}

/**
 * Read the AUTHORED band stack out of a world, or return the caller's fallback (#800).
 *
 * ⚠️ **Refuses WHOLESALE rather than patching a partial stack.** A scene missing a required role
 * would otherwise lay out with that band absent — a silently zero-height area — and half an
 * authored stack mixed with half a code one is the hardest version of this to diagnose.
 *
 * ⚠️ **A duplicated role is DROPPED, not paid.** `solveBands`' `byRole` keeps the first of a pair,
 * but the duplicate would still take a share of `flexTotal`, so duplicating a band entity in the
 * editor would shrink every real panel with nothing on screen to explain why. A scene-file guard
 * structurally cannot see a live edit, so the check has to be here.
 *
 * ⚠️ **This function holds NO state, deliberately** — no warn latch, no world reference. The games
 * that use it warn once per WORLD (Play swaps the world, and a process-wide latch would go silent
 * for the rest of a session after the first bad scene), and at least one of them reports through
 * the same latch from another call site. An engine-owned latch would break that, and would need
 * world-swap teardown of its own.
 *
 * ⚠️ Called every frame, not cached: a retune in the Inspector has to reach the next layout pass,
 * or dragging a band would appear to do nothing.
 */
export function readScreenBands<R extends string>(
  world: World,
  opts: ReadScreenBandsOptions<R>,
): readonly Band<R>[] {
  const seen = new Map<R, Band<R>>();
  let duplicate = false;

  for (const e of world.query(ScreenBand)) {
    const b = e.get(ScreenBand);
    if (!b) continue;
    const role = b.role as R;
    if (!opts.accept.includes(role)) continue;
    if (seen.has(role)) { duplicate = true; continue; }
    // ⚠️ `order` is READ, never derived from `accept`'s position. A `stampOrder` option existed for
    // one commit — Court's stacking order used to be code-owned — and was deleted when the owner
    // ruled the field authored (#800): it had no caller, and a mechanism nothing fires is the
    // defect class this repo hits most. It also gave `accept` two meanings, vocabulary AND
    // sequence, so a game whose roles were not listed in stacking order got a silently wrong stack.
    seen.set(role, {
      role,
      order: b.order,
      minHeight: b.minHeight,
      flex: b.flex,
    });
  }

  // No usable band at all is the no-scene case (a headless test world, or a scene predating the
  // authoring surface) — the fallback IS the answer there, and warning about it would fire on
  // every such world.
  if (seen.size === 0) return opts.fallback;

  const missing = opts.require.filter((r) => !seen.has(r));
  // ⚠️ Every problem in ONE message, not the first one. A caller latches this once per world, so
  // reporting a duplicate separately meant a stack that was BOTH duplicated and missing a required
  // role printed only the duplicate and never named the missing one — pointing the reader at the
  // wrong fix, on the one message they get.
  const problems = [
    ...(duplicate ? ['two ScreenBand entities claim the same role'] : []),
    ...(missing.length > 0 ? [`the stack is missing ${missing.join(', ')}`] : []),
  ];
  if (problems.length > 0) opts.warn?.(problems.join('; and '));
  if (missing.length > 0) return opts.fallback;
  return [...seen.values()];
}
