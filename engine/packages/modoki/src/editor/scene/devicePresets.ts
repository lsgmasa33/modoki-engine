/** Device presets for the editor's GameView / SceneView device simulation.
 *
 *  Each preset carries BOTH the logical (CSS point) size AND the physical (device
 *  pixel) resolution. The distinction is load-bearing (see CLAUDE.md "device screen
 *  size simulation"):
 *
 *   - **logical** (points) drives ALL layout math — UI anchors/sizes, 2D Canvas fit,
 *     3D camera aspect. A 200pt button stays 200pt on every device, exactly like
 *     real iOS/Android. This is what `resolveLogicalSize()` feeds the letterbox /
 *     anchor math, and what the device picker SHOWS.
 *   - **physical** (= logical × devicePixelRatio) is the render-backbuffer target for
 *     sharpness. Stored explicitly (not derived) so devices with fractional DPR keep
 *     their true marketing resolution without rounding drift.
 *

 *  ## Safe-area insets
 *
 *  Each preset also carries the safe-area insets the device imposes, so the editor can
 *  emulate what `env(safe-area-inset-*)` reports on hardware — it resolves to **0** on a
 *  desktop browser, which is why a notched-phone layout bug is invisible in the editor
 *  until it ships (#271, and the reason the #272 fix shipped unverified once already).
 *
 *  ⚠️ **These are the PHYSICAL insets — the notch / Dynamic Island and the home
 *  indicator — i.e. what a FULL-SCREEN GAME sees with the status bar hidden.** That is
 *  the model, not an approximation of one:
 *   - The notch inset is the sensor housing, so it persists when the status bar is
 *     hidden. A Dynamic Island phone reports 59/62 either way.
 *   - A device with NO notch reports 0 with the status bar hidden — measured on the
 *     iPhone 8, and the fact that disproved the first attempt at #272's fix.
 *   - A project that SHOWS the status bar (`capacitor.statusBarHidden: false`) therefore
 *     gets MORE top inset than these numbers on a non-notched device. Not modelled yet;
 *     every project that has hit this so far hides it.
 *
 *  ⚠️ **Only measured values are trustworthy, and the two that ARE measured both overturned the
 *  guess they replaced** — in opposite directions, which is the argument for measuring rather than
 *  reasoning: the iPhone Air was seeded at 62 and reads **68** (a value in no published table),
 *  and Android was seeded at 24/24 and reads **0** (the window is inset by the system, so CSS
 *  never sees the cutout). A guess here is not "roughly right"; it is unbounded in either
 *  direction.
 *  Apple's are from the published per-model table (useyourloaf, cross-checked against the
 *  logical sizes already in this file — they agree), except the iPhone Air, which is measured.
 *  Android's come from two measured handsets that agree within 1dp — see `androidPhone`. A wrong number here mis-authors a layout in a way that looks perfect in
 *  the editor, so treat this table as data to be CORRECTED as devices get tested — there
 *  is an iPhone Air, a Galaxy S22 and a Galaxy A23 attached to this machine, and each one
 *  that gets measured should replace its guess and lose its `UNVERIFIED` marker.
 *
 *  Orientation is NOT baked into the list (no separate portrait/landscape entries) —
 *  presets are authored portrait and flipped at runtime by `resolveLogicalSize` /
 *  `resolvePhysicalSize` via the editor's orientation toggle.
 */

export type DeviceCategory = 'General' | 'Apple' | 'Samsung' | 'Google' | 'Android' | 'Aspect';

/** Safe-area insets in LOGICAL points, one edge each — the same quartet
 *  `env(safe-area-inset-*)` exposes to CSS.
 *
 *  Re-exported rather than re-declared: `runtime/ui/anchorLayout` already owns this shape (the
 *  pixel path takes one), and a second identically-shaped type here would be a third name for one
 *  quartet — with `runtime/ui/safeArea.SafeAreaInsets`, which is the MEASURED value and carries
 *  percentages too, that is exactly the same-name-different-shape hazard the layering rules exist
 *  to avoid. One definition, imported by both. */
import type { SafeAreaPx } from '../../runtime/ui/anchorLayout';
export type { SafeAreaPx };

/** A preset's insets for both orientations. Landscape is NOT a rotation of portrait and
 *  must be authored separately: an iPhone in portrait is inset at the TOP by the notch
 *  and at the bottom by the home indicator (62/34), while the same phone in landscape has
 *  NO top inset at all — the notch has moved to a side (0 top, 21 bottom, 62 on both
 *  sides). Deriving one from the other by swapping w/h, the way `resolveLogicalSize`
 *  legitimately does for the screen box, produces a top inset that does not exist. */
export interface SafeAreaSet {
  portrait: SafeAreaPx;
  landscape: SafeAreaPx;
}

/** No insets at all — a device with no notch and no home indicator (and the shape every
 *  abstract/Free preset takes). Frozen because it is shared by reference across presets. */
export const NO_INSETS: SafeAreaPx = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
export const NO_SAFE_AREA: SafeAreaSet = Object.freeze({ portrait: NO_INSETS, landscape: NO_INSETS });

/** Every home-indicator iPhone follows ONE pattern, so it is written once here rather
 *  than 4x in the table where a digit could drift: portrait is `top` + a 34pt home
 *  indicator; landscape drops the top inset entirely, keeps 21pt at the bottom, and puts
 *  the sensor-housing inset on BOTH sides (the OS reports it symmetrically — it cannot
 *  know which way you will rotate). Values cross-checked against the published per-model
 *  table; the iPhone 16 Pro row (62/34 portrait, 0/21/62/62 landscape) is the worked
 *  example the pattern was read off. */
const notchedIPhone = (topPt: number): SafeAreaSet => ({
  portrait: { top: topPt, right: 0, bottom: 34, left: 0 },
  landscape: { top: 0, right: topPt, bottom: 21, left: topPt },
});

/** An Android phone under Capacitor, bars hidden: the **display cutout on top, nothing else**.
 *
 *  ⭐ MEASURED on two devices, 2026-08-20, over each WebView's own devtools socket:
 *    Galaxy A23 (Android 13, 52px cutout @ dpr 1.875 = 27.7dp) -> `env()` top **28**, bottom 0
 *    Galaxy S22 (Android 14, 81px cutout @ dpr 3    = 27.0dp) -> `env()` top **27**, bottom 0
 *  Two different OEMs, densities and Android versions landing within 1dp, which is what makes a
 *  shared 28 defensible rather than one phone generalised.
 *
 *  **Bottom is 0 because both system bars are HIDDEN** (`capacitor.statusBarHidden`, which on
 *  Android hides the navigation bar too). A project that shows them would see a bottom inset and
 *  must re-measure.
 *
 *  ⚠️ **This row was WRONG TWICE, in both directions, and the reason is worth keeping.** It was
 *  seeded at 24/24 by inference. It was then "corrected" to ZERO from a real measurement — which
 *  was a real measurement of a BROKEN WINDOW: the generated `MainActivity` set
 *  `setDecorFitsSystemWindows(false)` but never `layoutInDisplayCutoutMode`, so the window was
 *  laid out BENEATH the cutout and CSS had no inset to report. The black band the owner saw on
 *  that A23 was the same defect. Measuring a bug and generalising it as a platform fact is the
 *  trap here: the question to ask of a zero is always "is this device insetless, or is my window
 *  not reaching the edge?" */
const androidPhone = (): SafeAreaSet => ({
  portrait: { top: 28, right: 0, bottom: 0, left: 0 },
  // Rotated, the cutout moves to a side. Both bars stay hidden, so still nothing at top/bottom.
  // INFERRED, not measured: Court is portrait-locked, so nothing here could rotate to check it.
  landscape: { top: 0, right: 28, bottom: 0, left: 28 },
});

/** A Face ID iPad: no notch, so NO top inset with the status bar hidden — only the 20pt
 *  home indicator, on the bottom in both orientations. */
const faceIdIPad = (): SafeAreaSet => ({
  portrait: { top: 0, right: 0, bottom: 20, left: 0 },
  landscape: { top: 0, right: 0, bottom: 20, left: 0 },
});

export interface DevicePreset {
  name: string;
  category: DeviceCategory;
  /** Logical width in CSS points (portrait). Drives layout. 0 = Free (fill container). */
  logicalW: number;
  /** Logical height in CSS points (portrait). */
  logicalH: number;
  /** Physical width in device pixels (portrait). */
  physicalW: number;
  /** Physical height in device pixels (portrait). */
  physicalH: number;
  /** Safe-area insets in LOGICAL points, per orientation. See the header. */
  safeArea: SafeAreaSet;
}

/** Free = no device, fill the panel. All sizes 0. */
export const FREE_PRESET: DevicePreset = { name: 'Free', category: 'General', logicalW: 0, logicalH: 0, physicalW: 0, physicalH: 0, safeArea: NO_SAFE_AREA };

/** Flat catalog (portrait orientation). Grouped for the picker via `category`. */
export const DEVICE_PRESETS: DevicePreset[] = [
  FREE_PRESET,

  // ── Apple — logical points @ DPR → physical pixels ──
  { name: 'iPhone SE',          category: 'Apple', logicalW: 375,  logicalH: 667,  physicalW: 750,  physicalH: 1334, safeArea: NO_SAFE_AREA }, // @2 — home button, no notch: 0 insets with the status bar hidden (measured on the iPhone 8, same generation)
  { name: 'iPhone Air',         category: 'Apple', logicalW: 420,  logicalH: 912,  physicalW: 1260, physicalH: 2736, safeArea: notchedIPhone(68) }, // @3 — MEASURED on the device 2026-08-20 (viewport 420x912, env() top 68 / bottom 34). ⚠️ 68 is NEITHER published Dynamic Island value (59 on 16/16 Plus, 62 on 16 Pro/Max) — the Air has its own, so do not "correct" it to 62. Landscape is inferred from the portrait measurement: the app is portrait-locked, so it could not be read.
  { name: 'iPhone 16 Pro',      category: 'Apple', logicalW: 402,  logicalH: 874,  physicalW: 1206, physicalH: 2622, safeArea: notchedIPhone(62) }, // @3
  { name: 'iPhone 16 Pro Max',  category: 'Apple', logicalW: 440,  logicalH: 956,  physicalW: 1320, physicalH: 2868, safeArea: notchedIPhone(62) }, // @3
  { name: 'iPad Pro 11"',       category: 'Apple', logicalW: 834,  logicalH: 1194, physicalW: 1668, physicalH: 2388, safeArea: faceIdIPad() }, // @2
  { name: 'iPad Pro 13"',       category: 'Apple', logicalW: 1032, logicalH: 1376, physicalW: 2064, physicalH: 2752, safeArea: faceIdIPad() }, // @2 (M4)
  { name: 'iPad Pro 12.9"',     category: 'Apple', logicalW: 1024, logicalH: 1366, physicalW: 2048, physicalH: 2732, safeArea: faceIdIPad() }, // @2

  // ── Samsung ──
  { name: 'Galaxy S22',              category: 'Samsung', logicalW: 360, logicalH: 780,  physicalW: 1080, physicalH: 2340, safeArea: androidPhone() }, // @3
  { name: 'Galaxy S24',              category: 'Samsung', logicalW: 360, logicalH: 780,  physicalW: 1080, physicalH: 2340, safeArea: androidPhone() }, // @3
  { name: 'Galaxy Z Fold7 (Folded)', category: 'Samsung', logicalW: 360, logicalH: 840,  physicalW: 1080, physicalH: 2520, safeArea: androidPhone() }, // cover, @3
  { name: 'Galaxy Z Fold7 (Open)',   category: 'Samsung', logicalW: 656, logicalH: 728,  physicalW: 1968, physicalH: 2184, safeArea: androidPhone() }, // main, @3 (near-square)

  // ── Google ──
  { name: 'Pixel 9',      category: 'Google', logicalW: 412, logicalH: 924, physicalW: 1080, physicalH: 2424, safeArea: androidPhone() }, // ~@2.62

  // ── Other Android ──
  { name: 'Xiaomi 14',         category: 'Android', logicalW: 400, logicalH: 890, physicalW: 1200, physicalH: 2670, safeArea: androidPhone() }, // @3
  { name: 'Huawei Mate 60 Pro', category: 'Android', logicalW: 420, logicalH: 907, physicalW: 1260, physicalH: 2720, safeArea: androidPhone() }, // @3
  { name: 'Motorola Edge 50',  category: 'Android', logicalW: 360, logicalH: 800, physicalW: 1080, physicalH: 2400, safeArea: androidPhone() }, // @3

  // ── Abstract aspect-ratio presets — logical == physical (DPR 1), no device chrome ──
  { name: '16:9 (720p)',  category: 'Aspect', logicalW: 1280, logicalH: 720,  physicalW: 1280, physicalH: 720,  safeArea: NO_SAFE_AREA },
  { name: '16:9 (1080p)', category: 'Aspect', logicalW: 1920, logicalH: 1080, physicalW: 1920, physicalH: 1080, safeArea: NO_SAFE_AREA },
  { name: '4:3',          category: 'Aspect', logicalW: 1024, logicalH: 768,  physicalW: 1024, physicalH: 768,  safeArea: NO_SAFE_AREA },
  { name: '1:1',          category: 'Aspect', logicalW: 512,  logicalH: 512,  physicalW: 512,  physicalH: 512,  safeArea: NO_SAFE_AREA },
];

/** Category display order for the picker. */
export const DEVICE_CATEGORY_ORDER: DeviceCategory[] = ['General', 'Apple', 'Samsung', 'Google', 'Android', 'Aspect'];

export type Orientation = 'portrait' | 'landscape';

/** Effective LOGICAL size for a preset under an orientation (landscape swaps w/h). */
export function resolveLogicalSize(p: DevicePreset, orientation: Orientation): { w: number; h: number } {
  return orientation === 'portrait'
    ? { w: p.logicalW, h: p.logicalH }
    : { w: p.logicalH, h: p.logicalW };
}

/** Effective PHYSICAL size for a preset under an orientation (landscape swaps w/h). */
export function resolvePhysicalSize(p: DevicePreset, orientation: Orientation): { w: number; h: number } {
  return orientation === 'portrait'
    ? { w: p.physicalW, h: p.physicalH }
    : { w: p.physicalH, h: p.physicalW };
}

/** Effective safe-area insets for a preset under an orientation. Unlike the size
 *  resolvers this is a LOOKUP, not a swap — see `SafeAreaSet` for why rotating the
 *  portrait quartet would invent a top inset the device does not have. */
export function resolveSafeArea(p: DevicePreset, orientation: Orientation): SafeAreaPx {
  return orientation === 'portrait' ? p.safeArea.portrait : p.safeArea.landscape;
}

/** The four CSS custom properties the UI layer reads for safe-area insets, as an inline
 *  style object for a preview container. `anchorCss` emits
 *  `var(--ui-sa-top, env(safe-area-inset-top))`, so SETTING these overrides the (always
 *  zero) desktop `env()` for everything inside the container, and NOT setting them —
 *  which is what every shipped build does — falls through to the device's real values.
 *  That fallback is the whole design: there is no editor branch in the runtime. */
export function safeAreaCssVars(insets: SafeAreaPx): Record<string, string> {
  return {
    '--ui-sa-top': `${insets.top}px`,
    '--ui-sa-right': `${insets.right}px`,
    '--ui-sa-bottom': `${insets.bottom}px`,
    '--ui-sa-left': `${insets.left}px`,
  };
}

/** Device pixel ratio implied by a preset (physical / logical). 1 for Free/abstract. */
export function presetDpr(p: DevicePreset): number {
  return p.logicalW > 0 ? p.physicalW / p.logicalW : 1;
}

/** Menu label, e.g. "iPhone 16 Pro (402×874)". Shows the LOGICAL (point) size —
 *  the resolution layout is actually computed against. Free has no suffix. */
export function presetLabel(p: DevicePreset, orientation: Orientation = 'portrait'): string {
  if (p.logicalW <= 0) return p.name;
  const { w, h } = resolveLogicalSize(p, orientation);
  return `${p.name} (${w}×${h})`;
}

/** Case-insensitive substring filter over device names (and category). `Free` always
 *  matches an empty query so the picker can clear back to it. Used by the device picker
 *  search box. Token-AND: every whitespace-separated term must appear. */
export function filterDevices(query: string, presets: DevicePreset[] = DEVICE_PRESETS): DevicePreset[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return presets;
  return presets.filter((p) => {
    const hay = `${p.name} ${p.category}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

// ── Agent-facing resolution (#367) ─────────────────────────────────────────
// `modoki_set_game_view_device` picks a preview screen by NAME or by an explicit pixel size. The
// decision logic lives here rather than in the op so it is unit-testable without an editor —
// `docs/editor.md` § Panels: a panel's decisions belong in a plain .ts module beside it.

/** Bounds on a CUSTOM size. Not taste: `logicalW: 0` is how `FREE_PRESET` says "fill the panel"
 *  (`isFree` in GameView), so a 0 would silently become Free rather than the size asked for — the
 *  §0 rank-1 false success. The upper bound keeps `physical = logical × dpr` inside a backbuffer
 *  a GPU will actually allocate; at the ceiling that is 8192 × 4 = 32768 px. */
export const CUSTOM_SIZE_MIN = 1;
export const CUSTOM_SIZE_MAX = 8192;
export const CUSTOM_DPR_MIN = 0.5;
export const CUSTOM_DPR_MAX = 4;

/** Why a reported safe-area quartet reads the way it does.
 *
 *  `'preset'` — the catalog's authored insets for this device and orientation. Zeros here are a
 *  STATEMENT (an iPhone SE with the status bar hidden really reports 0), not an absence.
 *  `'custom-none'` — an explicit pixel size has no device behind it, so there is nothing to look
 *  up and the quartet is zeros BY CONSTRUCTION. Reported rather than left implicit because
 *  `devicePresets.ts`'s header warns at length that an invented inset mis-authors a layout that
 *  then looks perfect in the editor; four bare zeros are indistinguishable from a measurement. */
export type SafeAreaBasis = 'preset' | 'custom-none';

/** The name a custom-size preset carries. Flat rather than `Custom 800x600`: the read-back
 *  carries the numbers, so encoding them in the name would be a second copy to drift. */
export const CUSTOM_PRESET_NAME = 'Custom';

/** The full read-back for a selected preview screen — what the setter returns and what
 *  `modoki_get_editor_state` reports, so a measurement can be attributed to a screen size. */
export interface DeviceSelection {
  device: string;
  category: DeviceCategory;
  orientation: Orientation;
  /** CSS points — the space ALL layout math runs in. */
  logical: { w: number; h: number };
  /** Device pixels — the render backbuffer target. */
  physical: { w: number; h: number };
  dpr: number;
  safeArea: SafeAreaPx;
  safeAreaBasis: SafeAreaBasis;
  /** `Free` fills the panel, so its logical size is whatever the panel currently is — the
   *  0×0 in `logical`/`physical` means "no fixed size", not "zero pixels". */
  free: boolean;
}

/** Build the read-back block for a preset under an orientation. */
export function describeDeviceSelection(p: DevicePreset, orientation: Orientation): DeviceSelection {
  return {
    device: p.name,
    category: p.category,
    orientation,
    logical: resolveLogicalSize(p, orientation),
    physical: resolvePhysicalSize(p, orientation),
    dpr: presetDpr(p),
    safeArea: resolveSafeArea(p, orientation),
    safeAreaBasis: p.name === CUSTOM_PRESET_NAME ? 'custom-none' : 'preset',
    free: p.logicalW <= 0,
  };
}

/** Exact (case-insensitive) lookup by name. Returns undefined rather than guessing — §5 of
 *  `docs/mcp-tool-conventions.md`: a caller who names a screen that does not exist is told so with
 *  the real list, because silently previewing a DIFFERENT screen than asked for is worse than
 *  failing. Case-insensitive is not fuzzy matching: no two presets differ only by case (asserted
 *  in `devicePresets.test.ts`), so it cannot resolve to a screen other than the one named. */
export function findPresetByName(name: string, presets: DevicePreset[] = DEVICE_PRESETS): DevicePreset | undefined {
  const want = name.trim().toLowerCase();
  return presets.find((p) => p.name.toLowerCase() === want);
}

/** A synthetic preset for an explicit pixel size — the shape a catalog entry has, so every
 *  `resolve*` helper and every GameView consumer handles it with no branch of its own.
 *
 *  `width`/`height` are LOGICAL (CSS points), which is the space layout runs in; `dpr` (default 1)
 *  derives the physical backbuffer. The names say `logical` on the tool's parameters for the same
 *  reason — §2, one name one meaning: a bare `width` means two different things in this file. */
export function makeCustomPreset(logicalW: number, logicalH: number, dpr = 1): DevicePreset {
  return {
    name: CUSTOM_PRESET_NAME,
    category: 'General',
    logicalW, logicalH,
    physicalW: Math.round(logicalW * dpr),
    physicalH: Math.round(logicalH * dpr),
    safeArea: NO_SAFE_AREA,
  };
}

/** Validate an explicit custom size. Returns the offending detail as a STRING (the `why` an op
 *  turns into a refusal), or null when it is usable. */
export function validateCustomSize(logicalW: unknown, logicalH: unknown, dpr: unknown): string | null {
  for (const [label, v] of [['logicalWidth', logicalW], ['logicalHeight', logicalH]] as const) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return `${label} must be a finite number — got ${JSON.stringify(v)}`;
    if (!Number.isInteger(v)) return `${label} must be a whole number of logical (CSS) pixels — got ${v}`;
    if (v < CUSTOM_SIZE_MIN || v > CUSTOM_SIZE_MAX) {
      return `${label} must be between ${CUSTOM_SIZE_MIN} and ${CUSTOM_SIZE_MAX} — got ${v}`
        + (v <= 0 ? ` (0 is how the 'Free' preset says "fill the panel", so it cannot mean a size)` : '');
    }
  }
  if (dpr !== undefined) {
    if (typeof dpr !== 'number' || !Number.isFinite(dpr)) return `dpr must be a finite number — got ${JSON.stringify(dpr)}`;
    if (dpr < CUSTOM_DPR_MIN || dpr > CUSTOM_DPR_MAX) return `dpr must be between ${CUSTOM_DPR_MIN} and ${CUSTOM_DPR_MAX} — got ${dpr}`;
    // ⚠️ **The dpr must ROUND-TRIP, or the read-back contradicts the call.** `makeCustomPreset`
    // stores `physical = round(logical * dpr)` and `presetDpr` recovers it as `physical / logical`,
    // so a dpr whose product is fractional comes back as a DIFFERENT number than the one passed:
    // `{1, 1, dpr: 0.5}` was accepted and answered `dpr: 1`, and `{3, 3, dpr: 0.5}` answered
    // `0.666…`, while the tool's description promises `physical = logical x dpr`. Telling the agent
    // a dpr it did not ask for is the §0 rank-2 class (a wrong answer stated authoritatively), so
    // the combination is refused rather than silently rounded. Tolerance, not `Number.isInteger`,
    // because 1.1 * 10 is 11.000000000000002 in IEEE754 and that is a round-trip, not a failure.
    //
    // ⚠️ This is NOT a ban on fractional dpr — 2.5 on any even dimension passes. But do not reach
    // for a real phone's dpr as the example: Pixel 9 is 412x924 -> 1080x2424, i.e. ~2.6214 wide and
    // ~2.6234 tall, and `{412, 924, 2.62}` IS refused here (412 x 2.62 = 1079.44). A device whose
    // two axes disagree on dpr cannot be expressed as one custom `dpr` at all — that is why the
    // CATALOG stores physical sizes explicitly instead of deriving them. Pick such a screen by
    // NAME, not by custom size.
    const fractional = ([['logicalWidth', logicalW], ['logicalHeight', logicalH]] as const)
      .filter(([, v]) => Math.abs((v as number) * dpr - Math.round((v as number) * dpr)) > 1e-9);
    if (fractional.length) {
      const [label, v] = fractional[0];
      return `dpr ${dpr} on ${label} ${v} gives a fractional physical size (${(v as number) * dpr}px), `
        + 'which cannot round-trip: the read-back would report a different dpr than the one passed. '
        + 'Pick a dpr whose product with BOTH dimensions is a whole number of device pixels — or, if '
        + 'you are after a real phone, select it by NAME: a device whose two axes imply slightly '
        + "different ratios (Pixel 9 is ~2.6214 x ~2.6234) has no single dpr, which is why the "
        + 'catalog stores its physical size explicitly.';
    }
  }
  return null;
}
