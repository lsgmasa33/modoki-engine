/** Shared marquee hit-test geometry for the Dopesheet + Curves views (extracted for
 *  testability + to kill the last divergence noted in F8). Both views select the keys whose
 *  on-screen center falls inside the rubber-band box; they differ ONLY in how a key maps to
 *  a screen center (Dopesheet: row band + time-x; Curves: value-y + time-x). Pass that as
 *  `center(ti, ki)` — return `null` to skip a key (e.g. a row outside the box's y-band). */

import type { AnimationTrack } from '../../../runtime/animation/types';
import type { MarqueeBox } from './useTimelineDrag';

export function keysInBox(
  tracks: AnimationTrack[],
  visible: number[],
  box: MarqueeBox,
  center: (ti: number, ki: number) => { cx: number; cy: number } | null,
): string[] {
  const xMin = Math.min(box.x0, box.x1), xMax = Math.max(box.x0, box.x1);
  const yMin = Math.min(box.y0, box.y1), yMax = Math.max(box.y0, box.y1);
  const ids: string[] = [];
  for (const ti of visible) {
    tracks[ti].keys.forEach((_k, ki) => {
      const c = center(ti, ki);
      if (!c) return;
      if (c.cx >= xMin && c.cx <= xMax && c.cy >= yMin && c.cy <= yMax) ids.push(`${ti}:${ki}`);
    });
  }
  return ids;
}
