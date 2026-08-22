/** What the debug menu's "Backing resolution" row SAYS — extracted from `DeviceTab.tsx` so it can
 *  be tested without mounting a panel (the repo's rule: a panel's decisions live in a plain `.ts`
 *  beside it; see docs/editor.md § Panels).
 *
 *  The row shows three facts that are easy to conflate, and every past bug here has been one of
 *  them wearing another's clothes:
 *
 *   - **what you picked** — the value a tap stored. Highlighted solid.
 *   - **what is running** — the effective cap after the tier (or an override) has had its say.
 *     Marked dashed when it differs from the pick.
 *   - **what the tier would do to a pick** — dimming, as a hint before you tap.
 *
 *  ⚠️ **"What you picked" is the OVERRIDE when one is in force, not the authored value.**
 *  `DeviceTab.setCap` writes both together so they agree, but the override setter is also exported
 *  from `runtime/index.ts` for `device_eval`, and that path moves only the override. Judging the
 *  marks by `authored` there highlighted a button nobody picked and printed a caption about a
 *  clamp that was not happening — measured case: tier ceiling 1, authored 1, external override 3
 *  → button "1" solid, nothing dimmed, no caption, renderer running at 3. */

/** `Infinity` is the tier's own "unclamped" identity (`UNCLAMPED_OVERRIDES`); an authored `0`
 *  ("Off") means the same thing from the other side (`renderSettings.ts`'s sentinel). Both read as
 *  "no ceiling" so a would-be-authored value compares against the tier's ceiling on equal terms. */
export function asCeiling(v: number): number {
  return v > 0 ? v : Infinity;
}

/** Everything the row needs to describe itself. `override === null` means the tier governs. */
export interface CapRowState {
  authored: number;
  override: number | null;
  effective: number;
  tierCeiling: number;
}

/** The value the row should treat as YOUR PICK — see the ⚠️ in the module doc. */
export function pickedCap(s: CapRowState): number {
  return s.override !== null ? s.override : s.authored;
}

/** Would picking `value` be immediately clamped back down by the ACTIVE tier?
 *
 *  ⚠️ **IT LABELS THE BUTTON; IT DOES NOT DISABLE IT** (owner, 2026-08-12). Disabling was tried and
 *  is wrong: A/B-ing the backing resolution on a device is the whole reason the row exists, and a
 *  tier clamps it on every phone that is not `high` — i.e. on exactly the hardware worth testing.
 *
 *  While an override is in force the tier is clamping NOTHING on that surface, so nothing dims. */
export function willBeClamped(value: number, s: CapRowState): boolean {
  return s.override === null && asCeiling(value) > s.tierCeiling;
}

/** The three marks for one option button. */
export function capButtonMarks(value: number, s: CapRowState): {
  /** Solid border — this is the pick. */
  active: boolean;
  /** Dashed border — this is what actually runs, and it is not what you picked. */
  isEffective: boolean;
  /** Dimmed — the tier will clamp this pick. */
  clamped: boolean;
} {
  const picked = pickedCap(s);
  return {
    active: picked === value,
    isEffective: s.effective === value && s.effective !== picked,
    clamped: willBeClamped(value, s),
  };
}

const capLabel = (v: number): string => (v > 0 ? String(v) : 'Off');

/** The small caption beside the row, or `null` when the row needs no explanation.
 *
 *  Two regimes, because they are two different facts. With NO override the tier may have clamped
 *  the authored pick, and hiding that is how the row came to look broken. With an override, the
 *  tier is being overridden — and the panel must still let you see what the tier WOULD have done,
 *  so the ceiling is spelled out rather than merely flagged. Both override notes can be true at
 *  once, so they are collected instead of nested. */
export function capRowCaption(s: CapRowState): string | null {
  if (s.override === null) {
    return s.authored !== s.effective
      ? `authored ${capLabel(s.authored)}, tier clamps to ${capLabel(s.effective)}`
      : null;
  }
  const parts: string[] = [];
  if (asCeiling(s.override) > s.tierCeiling) {
    parts.push(`overriding tier ceiling of ${s.tierCeiling === Infinity ? 'uncapped' : s.tierCeiling}`);
  }
  // The stored value only deserves a mention once it disagrees with what is running — which
  // happens on the device_eval path, never through the panel's own buttons.
  if (s.override !== s.authored) parts.push(`authored ${capLabel(s.authored)}`);
  return parts.length ? parts.join(', ') : null;
}
