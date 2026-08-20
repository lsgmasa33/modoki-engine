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
 *  ⚠️ **Only measured values are trustworthy, and almost none of these are measured.**
 *  Apple's are from the published per-model table (useyourloaf, cross-checked against the
 *  logical sizes already in this file — they agree). Android's are the COMMON CASE
 *  (punch-hole cutout + gesture navigation), not per-device truth: real Android insets
 *  move with the OEM, the Android version and whether the user runs gesture or 3-button
 *  navigation. A wrong number here mis-authors a layout in a way that looks perfect in
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
 *  `env(safe-area-inset-*)` exposes to CSS. */
export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A preset's insets for both orientations. Landscape is NOT a rotation of portrait and
 *  must be authored separately: an iPhone in portrait is inset at the TOP by the notch
 *  and at the bottom by the home indicator (62/34), while the same phone in landscape has
 *  NO top inset at all — the notch has moved to a side (0 top, 21 bottom, 62 on both
 *  sides). Deriving one from the other by swapping w/h, the way `resolveLogicalSize`
 *  legitimately does for the screen box, produces a top inset that does not exist. */
export interface SafeAreaSet {
  portrait: SafeAreaInsets;
  landscape: SafeAreaInsets;
}

/** No insets at all — a device with no notch and no home indicator (and the shape every
 *  abstract/Free preset takes). Frozen because it is shared by reference across presets. */
export const NO_INSETS: SafeAreaInsets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
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

/** The common-case Android phone: a punch-hole cutout under the status bar and a gesture
 *  navigation pill. Both are ~24dp. Landscape keeps the pill at the bottom (it rotates
 *  with the system) and, like iOS, treats the cutout symmetrically because the rotation
 *  direction is unknown. ⚠️ 3-button navigation makes the bottom inset ~48dp instead —
 *  a user setting, not a device fact, so it is deliberately not modelled. */
const androidPhone = (): SafeAreaSet => ({
  portrait: { top: 24, right: 0, bottom: 24, left: 0 },
  landscape: { top: 0, right: 24, bottom: 24, left: 24 },
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
  { name: 'Galaxy S22',              category: 'Samsung', logicalW: 360, logicalH: 780,  physicalW: 1080, physicalH: 2340, safeArea: androidPhone() }, // @3 — ⚠️ UNVERIFIED, and this device is attached (see the header)
  { name: 'Galaxy S24',              category: 'Samsung', logicalW: 360, logicalH: 780,  physicalW: 1080, physicalH: 2340, safeArea: androidPhone() }, // @3 — ⚠️ UNVERIFIED
  { name: 'Galaxy Z Fold7 (Folded)', category: 'Samsung', logicalW: 360, logicalH: 840,  physicalW: 1080, physicalH: 2520, safeArea: androidPhone() }, // cover, @3 — ⚠️ UNVERIFIED
  { name: 'Galaxy Z Fold7 (Open)',   category: 'Samsung', logicalW: 656, logicalH: 728,  physicalW: 1968, physicalH: 2184, safeArea: androidPhone() }, // main, @3 (near-square) — ⚠️ UNVERIFIED

  // ── Google ──
  { name: 'Pixel 9',      category: 'Google', logicalW: 412, logicalH: 924, physicalW: 1080, physicalH: 2424, safeArea: androidPhone() }, // ~@2.62 — ⚠️ UNVERIFIED

  // ── Other Android ──
  { name: 'Xiaomi 14',         category: 'Android', logicalW: 400, logicalH: 890, physicalW: 1200, physicalH: 2670, safeArea: androidPhone() }, // @3 — ⚠️ UNVERIFIED
  { name: 'Huawei Mate 60 Pro', category: 'Android', logicalW: 420, logicalH: 907, physicalW: 1260, physicalH: 2720, safeArea: androidPhone() }, // @3 — ⚠️ UNVERIFIED
  { name: 'Motorola Edge 50',  category: 'Android', logicalW: 360, logicalH: 800, physicalW: 1080, physicalH: 2400, safeArea: androidPhone() }, // @3 — ⚠️ UNVERIFIED

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
export function resolveSafeArea(p: DevicePreset, orientation: Orientation): SafeAreaInsets {
  return orientation === 'portrait' ? p.safeArea.portrait : p.safeArea.landscape;
}

/** The four CSS custom properties the UI layer reads for safe-area insets, as an inline
 *  style object for a preview container. `anchorCss` emits
 *  `var(--ui-sa-top, env(safe-area-inset-top))`, so SETTING these overrides the (always
 *  zero) desktop `env()` for everything inside the container, and NOT setting them —
 *  which is what every shipped build does — falls through to the device's real values.
 *  That fallback is the whole design: there is no editor branch in the runtime. */
export function safeAreaCssVars(insets: SafeAreaInsets): Record<string, string> {
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
