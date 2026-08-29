/** assetTypeIcons — inline SVG glyphs + colors for the Assets-panel type badges.
 *
 *  Replaces the old 2–3 letter text labels (ANM / SCN / PFX / {} …) that were
 *  hard to tell apart — several shared near-identical colors too (model & prefab
 *  blue, shader & particle teal, scene & material orange). Each glyph is drawn in
 *  a 16×16 box and inherits its color via `currentColor`, so the badge just sets
 *  `color`. Distinct shape + a hue-separated palette make the type readable at a
 *  glance even at 13px. Source models (.obj/.fbx/.dae) keep their format text
 *  badge in the Assets panel — that's a "source, not the shipped asset" signal,
 *  handled by the caller. */

import type { ReactNode } from 'react';

/** Per-type badge color. Spread around the hue wheel so adjacent rows differ. */
export const ASSET_TYPE_COLORS: Record<string, string> = {
  texture: '#2ecc71',     // green
  shader: '#1abc9c',      // teal
  particle: '#00d2ff',    // cyan
  model: '#4aa3df',       // blue
  mesh: '#74b9ff',        // light steel-blue (geometry; sibling of model)
  prefab: '#7d5fff',      // violet
  environment: '#9b59b6', // purple
  material: '#e84393',    // pink
  font: '#e74c3c',        // red
  scene: '#f39c12',       // orange
  animation: '#f1c40f',   // gold
  animset: '#cddc39',     // lime (animation-family, distinct hue gap)
  spriteanim: '#4fd1b5',  // mint (sprite-flipbook animation; sprite + animation family)
  rig2d: '#a29bfe',       // soft indigo (2D skinning rig — bones/skeleton family)
  sprite: '#16a085',      // dark teal (2D image family, sibling of texture)
  atlas: '#27ae60',       // emerald (packed sprite sheet; texture/sprite family)
  level: '#d35400',       // pumpkin (pure-data level layout, e.g. Sling's .level.json)
  wave: '#3498db',        // peter-river blue (enemy/spawn wave data)
  'court-level': '#c0392b', // pomegranate (Court's puzzle level data)
  timeline: '#e17055',    // terracotta (Director timeline; animation family)
  audio: '#2980b9',       // belize-hole blue (audio clip)
  video: '#8e44ad',       // wisteria (video clip)
  script: '#9aa7b4',      // slate-grey (source code — not an asset-pipeline type)
};

/** Canonical asset-type list + display order — the SINGLE source of truth shared
 *  by the Assets panel's category (list) view section order AND the type-filter
 *  menu, so the two never drift. Grouped roughly by pipeline stage: composition
 *  (incl. pure-data level/wave/court-level) → rendering → animation (incl.
 *  timeline) → fx → lighting → text → media (audio/video) → code. 'script' is a
 *  pseudo-type (source files, not asset-manifest entries). Types absent here sort
 *  last, alphabetically. Keep in sync with ASSET_TYPE_COLORS above, and with the
 *  `glyph()` switch below — every entry here needs a badge glyph or it falls back
 *  to a 3-letter text label (harmless, but check it's the intent). Coverage over
 *  every type the classifier (`loaders/assetTypeClassifier.ts`) actually produces
 *  is pinned by `tests/editor/assetTypeOrder.test.ts` (#417). */
export const ASSET_TYPE_ORDER: readonly string[] = [
  'scene', 'prefab', 'level', 'wave', 'court-level',
  'model', 'mesh', 'material', 'texture', 'sprite', 'atlas',
  'animation', 'animset', 'spriteanim', 'rig2d', 'timeline',
  'particle', 'shader',
  'environment', 'font',
  'audio', 'video',
  'script',
];

/** Order comparator for asset types: canonical order first, then alphabetical for
 *  anything not in the list. */
export function compareAssetTypes(a: string, b: string): number {
  const ia = ASSET_TYPE_ORDER.indexOf(a);
  const ib = ASSET_TYPE_ORDER.indexOf(b);
  const ra = ia === -1 ? ASSET_TYPE_ORDER.length : ia;
  const rb = ib === -1 ? ASSET_TYPE_ORDER.length : ib;
  return ra !== rb ? ra - rb : a.localeCompare(b);
}

const S = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinejoin: 'round' as const,
  strokeLinecap: 'round' as const,
};

/** Glyph paths per asset type. `bg` is the badge background, used only where a
 *  shape must occlude another (the prefab "instance" card). */
function glyph(type: string, bg: string): ReactNode {
  switch (type) {
    case 'model': // 3D cube (mesh)
      return (<><path {...S} d="M8 1.8l5.4 3v6.4L8 14.2 2.6 11.2V4.8z" /><path {...S} d="M2.6 4.8L8 7.9l5.4-3.1M8 7.9v6.3" /></>);
    case 'mesh': // 2×2 grid (Windows-logo style) — geometry asset
      return (<><rect x="2.4" y="2.4" width="5" height="5" rx="0.8" fill="currentColor" /><rect x="8.6" y="2.4" width="5" height="5" rx="0.8" fill="currentColor" /><rect x="2.4" y="8.6" width="5" height="5" rx="0.8" fill="currentColor" /><rect x="8.6" y="8.6" width="5" height="5" rx="0.8" fill="currentColor" /></>);
    case 'texture': // framed image (sun + hills)
      return (<><rect {...S} x="2.2" y="3.2" width="11.6" height="9.6" rx="1.2" /><circle cx="5.6" cy="6.2" r="1.1" fill="currentColor" /><path {...S} d="M2.7 12l3.1-3.1 2 2 2.8-2.8 3 3" /></>);
    case 'environment': // globe (HDR panorama)
      return (<><circle {...S} cx="8" cy="8" r="6" /><path {...S} d="M2.2 8h11.6M8 2.1c2.4 1.9 2.4 9.9 0 11.8M8 2.1c-2.4 1.9-2.4 9.9 0 11.8" /></>);
    case 'scene': // top-down XY-plane perspective grid (the scene ground plane)
      return (<><path {...S} d="M2.5 13L5.5 4h5l3 9z" /><path {...S} strokeWidth={1} d="M4.5 7h7M3.5 10h9M8 4v9M6.5 4L4.5 13M9.5 4L11.5 13" /></>);
    case 'material': // shaded preview sphere + specular highlight
      return (<><circle cx="8" cy="8" r="6" fill="currentColor" /><circle cx="6" cy="6" r="1.7" fill="rgba(255,255,255,0.6)" /></>);
    case 'prefab': // overlapping cards (template + instance)
      return (<><rect {...S} x="2.4" y="2.4" width="7.6" height="7.6" rx="1.3" /><rect x="6" y="6" width="7.6" height="7.6" rx="1.3" fill={bg} stroke="currentColor" strokeWidth={1.3} /></>);
    case 'font': // letter A
      return (<path {...S} strokeWidth={1.4} d="M3.4 13L7 3l3.6 10M4.7 9.6h4.6" />);
    case 'shader': // node graph (FX)
      return (<><circle cx="4" cy="4.2" r="1.7" fill="currentColor" /><circle cx="12" cy="6.2" r="1.7" fill="currentColor" /><circle cx="6" cy="12" r="1.7" fill="currentColor" /><path {...S} d="M5.5 4.7l5 1M4.7 5.6l1 5" /></>);
    case 'particle': // particle burst
      return (<><circle cx="8" cy="8" r="1.7" fill="currentColor" /><circle cx="3.8" cy="4.8" r="1" fill="currentColor" /><circle cx="12.4" cy="5" r="1.1" fill="currentColor" /><circle cx="4.6" cy="12.2" r="1" fill="currentColor" /><circle cx="12" cy="11.6" r="1.3" fill="currentColor" /></>);
    case 'animation': // sine curve (one full period — reads as animation / easing)
      return (<path {...S} strokeWidth={1.5} d="M2 8C3.6 4 6.4 4 8 8S12.4 12 14 8" />);
    case 'animset': // stick figure (a set of skeletal clips)
      return (<><circle cx="8" cy="3.4" r="1.7" fill="currentColor" /><path {...S} d="M8 5.1v5.1M8 6.6L5.1 8.4M8 6.6l2.9 1.8M8 10.2L5.6 14M8 10.2 10.4 14" /></>);
    case 'atlas': // packed grid of sprites (cells of varied size on one page)
      return (<><rect {...S} x="2.2" y="2.2" width="11.6" height="11.6" rx="1.2" /><path {...S} strokeWidth={1} d="M8 2.4v11.2M2.4 8h5.6M8 6h5.6M8 10.4h5.6" /></>);
    case 'spriteanim': // stacked frames + play triangle (flipbook animation)
      return (<><rect {...S} x="2.4" y="4.6" width="8.6" height="8.6" rx="1.1" /><path {...S} d="M5 4.6V3.1h8.5v8.5h-1.5" /><path d="M5.7 7.3l3.4 2-3.4 2z" fill="currentColor" /></>);
    case 'rig2d': // bone (2D skinning rig) — a diagonal bone with lobed ends
      return (<><path {...S} strokeWidth={1.6} d="M5.2 10.8l5.6-5.6" /><circle cx="4.3" cy="10" r="1.3" fill="currentColor" /><circle cx="6" cy="11.7" r="1.3" fill="currentColor" /><circle cx="11.7" cy="6" r="1.3" fill="currentColor" /><circle cx="10" cy="4.3" r="1.3" fill="currentColor" /></>);
    case 'level': // stacked layers (pure-data level layout)
      return (<><path {...S} d="M8 2.3L2.6 5.3 8 8.3l5.4-3z" /><path {...S} d="M2.6 8.3L8 11.3l5.4-3" /><path {...S} d="M2.6 11L8 14l5.4-3" /></>);
    case 'wave': // zigzag (enemy/spawn wave pattern) — distinct from animation's smooth sine
      return (<path {...S} strokeWidth={1.4} d="M2 11L5 5l3 6 3-6 3 6" />);
    case 'court-level': // puzzle piece (Court's puzzle level data)
      return (<path {...S} d="M3 3h4.2c.1-.9 1.6-.9 1.6 0H13v4.2c.9.1.9 1.6 0 1.6V13H8.8c-.1.9-1.6.9-1.6 0H3V8.8c-.9-.1-.9-1.6 0-1.6z" />);
    case 'timeline': // horizontal track + keyframe markers
      return (<><path {...S} d="M2.4 8h11.2" /><rect x="3.4" y="6.7" width="2.4" height="2.6" rx="0.4" fill="currentColor" /><rect x="10.2" y="6.7" width="2.4" height="2.6" rx="0.4" fill="currentColor" /><circle cx="8" cy="8" r="1.3" fill="currentColor" /></>);
    case 'audio': // speaker + sound waves
      return (<><path {...S} d="M2.6 6.4h2.6L8.4 3v10L5.2 9.6H2.6z" fill="currentColor" /><path {...S} d="M10.4 5.6a4 4 0 0 1 0 4.8M12.4 3.6a7 7 0 0 1 0 8.8" /></>);
    case 'video': // video camera (distinct from spriteanim's frames+play-triangle)
      return (<><rect {...S} x="2.2" y="4.4" width="8" height="7.2" rx="1" /><path {...S} d="M10.2 6.6l3.6-2v6.8l-3.6-2z" /></>);
    case 'script': // angle brackets (source file: </>)
      return (<path {...S} strokeWidth={1.5} d="M6 4.5L2.5 8 6 11.5M10 4.5L13.5 8 10 11.5" />);
    default:
      return null;
  }
}

/** Render the asset-type glyph. Returns null for an unknown type (caller falls
 *  back to a short text label). */
export function AssetTypeGlyph({ type, size = 13, bg = '#1a1a2e' }: { type: string; size?: number; bg?: string }) {
  const g = glyph(type, bg);
  if (!g) return null;
  return <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: 'block' }} aria-hidden>{g}</svg>;
}
