/** NineSliceImage — seamless 9-slice background for a UI element.
 *
 *  Renders the sprite's 9 regions as SEPARATE, slightly-overlapping divs instead of
 *  CSS `border-image`. border-image's regions tile exactly (spec) and cannot overlap,
 *  so Chrome leaves hairline subpixel seams between them under non-integer scaling
 *  (the editor preview). Separate divs CAN overlap: each slice bleeds `OV` px past its
 *  grid cell into its neighbours, covering any subpixel gap — seamless at any zoom,
 *  no backstop plane.
 *
 *  Sits as a decorative `pointer-events:none`, `z-index:-1` layer behind the element's
 *  text/children (the host element sets `isolation:isolate` so it stays contained).
 *  A CSS grid (`{l} 1fr {r}` × `{t} 1fr {b}`) adapts the cell sizes to the element's
 *  real, unknown size; corners stay fixed, edges + centre stretch. */

import React from 'react';

export interface NineSliceImageProps {
  url: string;
  /** Source image dims (px) the frame + insets were authored against. */
  imgW: number;
  imgH: number;
  /** The sprite's rect within the source image (whole-image sprite ⇒ full image). */
  frame: { x: number; y: number; w: number; h: number };
  /** 9-slice insets in SOURCE px, and the edge render scale (CSS px per source px). */
  l: number; r: number; t: number; b: number; scale: number;
}

/** px each slice bleeds past its cell into neighbours (× the shared boundary = 2·OV
 *  overlap). Big enough to swallow a subpixel seam, small enough that the ~1px of
 *  double-painted (continuous) edge pixels is invisible. */
const OV = 1;

/** CSS background-position % for showing source offset `s` of a `slice`-wide region
 *  from a `dim`-wide image, paired with the matching `backgroundSize` %. The classic
 *  responsive-sprite trick: dimensionless, so it's independent of the (unknown,
 *  stretched) cell size AND of any downscale of the loaded texture variant. */
function posPct(s: number, dim: number, slice: number): string {
  const denom = dim - slice;
  return denom === 0 ? '0%' : `${(s / denom) * 100}%`;
}

/** One slice cell: an inner div bled `OV` past the cell on all sides, showing source
 *  sub-rect (sx,sy,sw,sh) of the image stretched to fill. */
function cell(url: string, W: number, H: number, sx: number, sy: number, sw: number, sh: number, key: string) {
  const inner: React.CSSProperties = {
    position: 'absolute',
    inset: `-${OV}px`,
    backgroundImage: `url(${url})`,
    backgroundRepeat: 'no-repeat',
    backgroundSize: `${(W / sw) * 100}% ${(H / sh) * 100}%`,
    backgroundPosition: `${posPct(sx, W, sw)} ${posPct(sy, H, sh)}`,
  };
  return <div key={key} style={{ position: 'relative' }}><div style={inner} /></div>;
}

export function NineSliceImage({ url, imgW: W, imgH: H, frame, l, r, t, b, scale }: NineSliceImageProps) {
  const { x: fx, y: fy, w: fw, h: fh } = frame;
  // Source sub-rects: the frame partitioned by the insets (works for a whole-image
  // sprite AND a sliced one, via the fx/fy offset).
  const midW = fw - l - r, midH = fh - t - b;
  const cx = fx + l, cy = fy + t, rx = fx + fw - r, by = fy + fh - b;

  const outer: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    overflow: 'hidden',
    zIndex: -1,
    display: 'grid',
    gridTemplateColumns: `${l * scale}px 1fr ${r * scale}px`,
    gridTemplateRows: `${t * scale}px 1fr ${b * scale}px`,
  };

  return (
    <div aria-hidden style={outer}>
      {cell(url, W, H, fx, fy, l, t, 'tl')}
      {cell(url, W, H, cx, fy, midW, t, 'tc')}
      {cell(url, W, H, rx, fy, r, t, 'tr')}
      {cell(url, W, H, fx, cy, l, midH, 'ml')}
      {cell(url, W, H, cx, cy, midW, midH, 'mc')}
      {cell(url, W, H, rx, cy, r, midH, 'mr')}
      {cell(url, W, H, fx, by, l, b, 'bl')}
      {cell(url, W, H, cx, by, midW, b, 'bc')}
      {cell(url, W, H, rx, by, r, b, 'br')}
    </div>
  );
}
