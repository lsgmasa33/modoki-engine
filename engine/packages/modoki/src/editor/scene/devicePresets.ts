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
 *  Orientation is NOT baked into the list (no separate portrait/landscape entries) —
 *  presets are authored portrait and flipped at runtime by `resolveLogicalSize` /
 *  `resolvePhysicalSize` via the editor's orientation toggle.
 */

export type DeviceCategory = 'General' | 'Apple' | 'Samsung' | 'Google' | 'Android' | 'Aspect';

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
}

/** Free = no device, fill the panel. All sizes 0. */
export const FREE_PRESET: DevicePreset = { name: 'Free', category: 'General', logicalW: 0, logicalH: 0, physicalW: 0, physicalH: 0 };

/** Flat catalog (portrait orientation). Grouped for the picker via `category`. */
export const DEVICE_PRESETS: DevicePreset[] = [
  FREE_PRESET,

  // ── Apple — logical points @ DPR → physical pixels ──
  { name: 'iPhone SE',          category: 'Apple', logicalW: 375,  logicalH: 667,  physicalW: 750,  physicalH: 1334 }, // @2
  { name: 'iPhone Air',         category: 'Apple', logicalW: 420,  logicalH: 912,  physicalW: 1260, physicalH: 2736 }, // @3
  { name: 'iPhone 16 Pro',      category: 'Apple', logicalW: 402,  logicalH: 874,  physicalW: 1206, physicalH: 2622 }, // @3
  { name: 'iPhone 16 Pro Max',  category: 'Apple', logicalW: 440,  logicalH: 956,  physicalW: 1320, physicalH: 2868 }, // @3
  { name: 'iPad Pro 11"',       category: 'Apple', logicalW: 834,  logicalH: 1194, physicalW: 1668, physicalH: 2388 }, // @2
  { name: 'iPad Pro 13"',       category: 'Apple', logicalW: 1032, logicalH: 1376, physicalW: 2064, physicalH: 2752 }, // @2 (M4)
  { name: 'iPad Pro 12.9"',     category: 'Apple', logicalW: 1024, logicalH: 1366, physicalW: 2048, physicalH: 2732 }, // @2

  // ── Samsung ──
  { name: 'Galaxy S22',              category: 'Samsung', logicalW: 360, logicalH: 780,  physicalW: 1080, physicalH: 2340 }, // @3
  { name: 'Galaxy S24',              category: 'Samsung', logicalW: 360, logicalH: 780,  physicalW: 1080, physicalH: 2340 }, // @3
  { name: 'Galaxy Z Fold7 (Folded)', category: 'Samsung', logicalW: 360, logicalH: 840,  physicalW: 1080, physicalH: 2520 }, // cover, @3
  { name: 'Galaxy Z Fold7 (Open)',   category: 'Samsung', logicalW: 656, logicalH: 728,  physicalW: 1968, physicalH: 2184 }, // main, @3 (near-square)

  // ── Google ──
  { name: 'Pixel 9',      category: 'Google', logicalW: 412, logicalH: 924, physicalW: 1080, physicalH: 2424 }, // ~@2.62

  // ── Other Android ──
  { name: 'Xiaomi 14',         category: 'Android', logicalW: 400, logicalH: 890, physicalW: 1200, physicalH: 2670 }, // @3
  { name: 'Huawei Mate 60 Pro', category: 'Android', logicalW: 420, logicalH: 907, physicalW: 1260, physicalH: 2720 }, // @3
  { name: 'Motorola Edge 50',  category: 'Android', logicalW: 360, logicalH: 800, physicalW: 1080, physicalH: 2400 }, // @3

  // ── Abstract aspect-ratio presets — logical == physical (DPR 1) ──
  { name: '16:9 (720p)',  category: 'Aspect', logicalW: 1280, logicalH: 720,  physicalW: 1280, physicalH: 720 },
  { name: '16:9 (1080p)', category: 'Aspect', logicalW: 1920, logicalH: 1080, physicalW: 1920, physicalH: 1080 },
  { name: '4:3',          category: 'Aspect', logicalW: 1024, logicalH: 768,  physicalW: 1024, physicalH: 768 },
  { name: '1:1',          category: 'Aspect', logicalW: 512,  logicalH: 512,  physicalW: 512,  physicalH: 512 },
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
