/** Types for `splashLayout.mjs` — the module is plain Node (the icon wrapper script cannot
 *  import TypeScript), so its shape is declared here for the TS consumers that import it. */

export interface AspectRange { min: number; max: number }
export declare const DEVICE_ASPECT_RANGE: {
  portrait: AspectRange;
  landscape: AspectRange;
  any: AspectRange;
};

export type OrientationKey = 'portrait' | 'landscape' | 'any';
export declare function orientationKey(orientation: string | undefined): OrientationKey;

export interface SafeBox {
  x: number; y: number; w: number; h: number;
  widthFrac: number; heightFrac: number;
}
export declare function safeBox(width: number, height: number, orientation?: string): SafeBox;

export interface PlacedRect { x: number; y: number; w: number; h: number; clamped: boolean }
export declare function overlayRect(
  safe: SafeBox,
  opts: { widthPct: number; offsetPct?: number; aspect: number },
): PlacedRect;

export declare const BADGE_WIDTH_PCT: number;
export declare const BADGE_MARGIN_PCT: number;
export declare function badgeRect(safe: SafeBox, aspect: number): PlacedRect;
