import type { World } from 'koota';
import type { Band } from '../core/screenBands';
import { ScreenBand } from '../traits/ScreenBand';

export interface ReadScreenBandsOptions<R extends string> {
  /** The role vocabulary. A band whose role is not in here is SKIPPED, never coerced. */
  readonly accept: readonly R[];
  /** The roles that must ALL be present, or the authored stack is refused wholesale. Often a
   *  subset of `accept`: a game can accept a decorative band it does not depend on. */
  readonly require: readonly R[];
  /** Roles whose relative STACKING ORDER a game depends on, top to bottom. Reported (never
   *  repaired, never reordered) when the authored `order` values disagree — a pair is only checked
   *  when both its roles are present, since a missing one is already `require`'s to report.
   *
   *  ⚠️ **This is not `stampOrder` returning.** That option WROTE `order` onto authored data, gave
   *  `accept` a second meaning, and was deleted in #800 for having no caller. This one only reads
   *  the authored order and says when it breaks a dependency the game declared — and it ships with
   *  a caller (#1089: wordweave's board-slack transfer is a silent no-op when `board` is authored
   *  above `crossword`).
   *
   *  ⚠️ **Every role listed here must also be in `accept`.** A role that is not can never enter
   *  `seen`, so its pair is indistinguishable from "that band is absent" and the dependency is
   *  declared but unenforceable — silently. That is a programming error in the caller, not an
   *  authoring mistake, which is why it is stated here rather than reported at runtime. */
  readonly requireOrder?: readonly R[];
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
 * ⚠️ **A band with NO ROLE PICKED is reported, not just skipped** (#1089). `ScreenBand.role`
 * defaults to `''` so that a saved scene keeps the field (see the trait), which makes "somebody
 * dropped a band and never chose what it is" a real and reachable state — and one that `require`
 * structurally cannot catch, because no declared role went missing. An out-of-VOCABULARY role is a
 * different thing and stays silently skipped: a game may carry a decorative band this reader is not
 * meant to know about.
 *
 * ⚠️ **A stack that is merely MIS-ORDERED or duplicated still returns its authored bands** — only a
 * missing required role falls back. Discarding every authored value over an ordering nit would lose
 * far more than it protects, and the report is what the caller actually needs.
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
  // ⚠️ The duplicated ROLES, not a boolean. `two ScreenBand entities claim the same role` printed
  // verbatim when five did, or when two different roles were each duplicated — sending the reader
  // looking for one mistake. Same bar as the unconfigured count below (#1089 review).
  const duplicated = new Set<R>();
  let unconfigured = 0;

  for (const e of world.query(ScreenBand)) {
    const b = e.get(ScreenBand);
    if (!b) continue;
    const role = b.role as R;
    // ⚠️ Checked BEFORE `accept`, and counted rather than skipped silently: `''` is the trait's
    // never-picked default, not a role this reader simply does not recognise.
    if (b.role === '') { unconfigured += 1; continue; }
    if (!opts.accept.includes(role)) continue;
    if (seen.has(role)) { duplicated.add(role); continue; }
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

  const unconfiguredProblem = unconfigured > 0
    ? [`${unconfigured} ScreenBand ${unconfigured === 1 ? 'entity has' : 'entities have'} no role set`]
    : [];

  // No usable band at all is the no-scene case (a headless test world, or a scene predating the
  // authoring surface) — the fallback IS the answer there, and warning about it would fire on
  // every such world. ⚠️ Unless bands were actually authored and none of them picked a role, which
  // is the opposite of the no-scene case and the one thing worth saying about it.
  if (seen.size === 0) {
    if (unconfiguredProblem.length > 0) opts.warn?.(unconfiguredProblem[0]);
    return opts.fallback;
  }

  // ⚠️ EVERY declared pair, not just consecutive ones. With `['a','b','c']` and `b` absent, a
  // consecutive-only walk never compares `a` with `c`, so an author could invert the outermost
  // dependency and get silence (#1089 review).
  //
  // Only pairs whose BOTH roles are present: a missing one is `require`'s to report, and saying
  // both would point the reader at the wrong fix on the one message they get.
  //
  // ⚠️ `>=`, not `>`. `solveBands` sorts by `order` and ties are UNSPECIFIED (see the trait), so on
  // equal orders the stacking sequence falls out of world query order — i.e. entity spawn order.
  // A tie is therefore already a broken dependency, not a satisfied one.
  const misordered: string[] = [];
  const wanted = opts.requireOrder ?? [];
  for (let i = 0; i < wanted.length; i += 1) {
    for (let j = i + 1; j < wanted.length; j += 1) {
      const before = seen.get(wanted[i]);
      const after = seen.get(wanted[j]);
      if (before && after && before.order >= after.order) {
        misordered.push(`${wanted[i]} must be ordered above ${wanted[j]}`);
      }
    }
  }

  const missing = opts.require.filter((r) => !seen.has(r));
  // ⚠️ Every problem in ONE message, not the first one. A caller latches this once per world, so
  // reporting a duplicate separately meant a stack that was BOTH duplicated and missing a required
  // role printed only the duplicate and never named the missing one — pointing the reader at the
  // wrong fix, on the one message they get.
  const problems = [
    ...(duplicated.size > 0
      ? [`more than one ScreenBand claims the same role: ${[...duplicated].join(', ')}`]
      : []),
    ...unconfiguredProblem,
    ...(misordered.length > 0 ? [`the stack is out of order — ${misordered.join(', ')}`] : []),
    // ⚠️ States the CONSEQUENCE, because this is the one problem that discards the authored stack
    // and this is where that is decided. Court's caller used to append "falling back to the code
    // band stack" to every message, including the three that do not fall back (#1089 review).
    ...(missing.length > 0
      ? [`the stack is missing ${missing.join(', ')}, so the whole authored stack is refused`]
      : []),
  ];
  if (problems.length > 0) opts.warn?.(problems.join('; and '));
  if (missing.length > 0) return opts.fallback;
  return [...seen.values()];
}
