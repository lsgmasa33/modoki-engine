/** lengthUnitWarning — dev-only heuristic flagging a likely width/height vs
 *  min/max-width/height UNIT mismatch.
 *
 *  `UIElement.width`/`height` default their unit to '%', while `minWidth`/`maxWidth`/
 *  `minHeight`/`maxHeight` default theirs to 'px' — an author who types a relative
 *  size and a small min/max NUMBER with no unit authored on the min/max field most
 *  likely meant it to share the relative unit, and instead clamped to a few PIXELS.
 *  That shipped as a real bug: Court's `RulesClose` button (#529). The Inspector did
 *  not even expose the min/max unit fields until #549, so nobody could see or fix it
 *  by hand — this warning is the other half of that fix, catching it at runtime.
 *
 *  Pure and exported so it is unit-testable without mounting anything. Wired into
 *  `uiTreeStore.ts`'s tree-build pass under `if (import.meta.env?.DEV)` — NOT into
 *  UINode's render — because UINode never renders a node inside a hidden subtree at
 *  all (`!node.isVisible` returns before recursing into children), so a render-time
 *  check would silently miss every element inside a closed dialog. That is the exact
 *  #529 case: `RulesClose`/`RulesLine4` live inside the How-to-Play dialog, which
 *  stays `isVisible: false` until a player opens it — nobody would have seen this
 *  warning fire for the bug it exists to catch. The tree-build pass visits every
 *  UIElement regardless of `isVisible` (it skips only genuinely deactivated
 *  entities/ancestors), so it sees hidden subtrees and runs on the dirty-flag rebuild
 *  at scene load — "you get a list of suspects on next launch."
 *
 *  Deduped per (entity, field, UNITS) — see `lengthUnitWarningKey` — not per value. The
 *  values were only ever in the key to catch an *edit*, but the values change on every
 *  pointermove of a resize drag (`UIResizeOverlay.tsx` calls `writeUIElement` per sample),
 *  so a values-in-key dedupe re-warned hundreds of times during the exact interaction an
 *  author uses to fix the mismatch. Any edit that actually FIXES the problem changes a
 *  UNIT (the whole point is picking the right unit), which changes the key anyway — so
 *  keying on units alone still re-warns on a real fix attempt, just not on every sample
 *  of an in-progress drag.
 *
 *  KNOWN FALSE POSITIVE (a deliberate hairline, not a bug in this heuristic): a
 *  genuinely-intended `height: 100%` with `maxHeight: 1` (meaning "cap it at a
 *  hairline of one pixel") still fires this warning — the rule cannot distinguish
 *  "meant px, typo'd a small number" from "meant px, meant it to be tiny". It is a
 *  heuristic to catch the common mistake, not a proof of one; it only ever runs in
 *  DEV. */

export const RELATIVE_LENGTH_UNITS = new Set(['%', 'vw', 'vh', 'vmin', 'vmax']);

/** A min/max px value at or below this is "small enough to plausibly be a stray
 *  percentage/vh/vmin number" rather than an intentional pixel constraint. */
export const SUSPICIOUS_PX_THRESHOLD = 20;

export type LengthAxis = 'width' | 'height';
export type ConstraintField = 'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight';

/** The subset of UIElement/UINodeData fields this check reads. All optional so a
 *  test fixture (or a real UINodeData, which always supplies them) can omit a field
 *  and get the trait's own default applied here. */
export interface LengthUnitCheckInput {
  width?: number; widthUnit?: string;
  height?: number; heightUnit?: string;
  minWidth?: number; minWidthUnit?: string;
  maxWidth?: number; maxWidthUnit?: string;
  minHeight?: number; minHeightUnit?: string;
  maxHeight?: number; maxHeightUnit?: string;
}

export interface LengthUnitSuspect {
  axis: LengthAxis;
  sizeField: LengthAxis;
  sizeValue: number;
  sizeUnit: string;
  constraintField: ConstraintField;
  constraintValue: number;
  constraintUnit: string;
}

function checkAxis(
  axis: LengthAxis,
  sizeValue: number | undefined,
  sizeUnit: string | undefined,
  constraints: Array<{ field: ConstraintField; value: number | undefined; unit: string | undefined }>,
): LengthUnitSuspect[] {
  const size = sizeValue ?? 0;
  const unit = sizeUnit ?? '%'; // UIElement.width/height default to '%'
  if (size === 0 || !RELATIVE_LENGTH_UNITS.has(unit)) return [];

  const out: LengthUnitSuspect[] = [];
  for (const c of constraints) {
    const cValue = c.value ?? 0;
    const cUnit = c.unit ?? 'px'; // UIElement.min*/max* default to 'px'
    if (cValue === 0 || cUnit !== 'px') continue;
    if (cValue > SUSPICIOUS_PX_THRESHOLD) continue;
    out.push({
      axis,
      sizeField: axis,
      sizeValue: size,
      sizeUnit: unit,
      constraintField: c.field,
      constraintValue: cValue,
      constraintUnit: cUnit,
    });
  }
  return out;
}

/** Returns one entry per offending min/max field — an entity can trip both axes, and
 *  an axis can trip both its min and its max. */
export function findLengthUnitSuspects(ui: LengthUnitCheckInput): LengthUnitSuspect[] {
  return [
    ...checkAxis('width', ui.width, ui.widthUnit, [
      { field: 'minWidth', value: ui.minWidth, unit: ui.minWidthUnit },
      { field: 'maxWidth', value: ui.maxWidth, unit: ui.maxWidthUnit },
    ]),
    ...checkAxis('height', ui.height, ui.heightUnit, [
      { field: 'minHeight', value: ui.minHeight, unit: ui.minHeightUnit },
      { field: 'maxHeight', value: ui.maxHeight, unit: ui.maxHeightUnit },
    ]),
  ];
}

/** Human-readable warning naming the entity, both fields, both values WITH their
 *  units, and what to do about it. */
export function formatLengthUnitWarning(entityLabel: string, suspect: LengthUnitSuspect): string {
  return (
    `[UIElement] ${entityLabel}: ${suspect.sizeField}=${suspect.sizeValue}${suspect.sizeUnit} but ` +
    `${suspect.constraintField}=${suspect.constraintValue}${suspect.constraintUnit} — that clamps to ` +
    `${suspect.constraintValue} PIXELS, not ${suspect.sizeUnit}. If you meant ${suspect.constraintField} ` +
    `to scale with ${suspect.sizeField}, set its unit in the Inspector (${suspect.constraintField} now ` +
    `has its own unit dropdown).`
  );
}

/** Dedupe key for the module-level warned-once guard. Keys on entity+field+UNITS, not
 *  values — see the module doc comment for why values would re-warn hundreds of times
 *  mid-drag, and why keying on units still re-warns once a fix actually changes one. */
export function lengthUnitWarningKey(entityId: number, suspect: LengthUnitSuspect): string {
  return `${entityId}:${suspect.constraintField}:${suspect.sizeUnit}:${suspect.constraintUnit}`;
}
