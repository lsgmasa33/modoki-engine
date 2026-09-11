import { trait } from 'koota';
import { UI_ANCHOR_LENGTHS as L, type UILengthUnit } from './uiLength';

/** The 16 anchor placements. Exported so the layout modules that CONSUME an anchor
 *  (`ui/anchorLayout.ts`, `ui/anchorCss.ts`) can narrow to it instead of widening to
 *  `string`: neither of their switches has a `default`, so an unknown mode silently
 *  produces an unpositioned element rather than an error. L2 `runtime/ui/` may import
 *  L1 `runtime/traits/`, so this direction is the sanctioned one. */
export type AnchorMode =
  | 'stretch' | 'top' | 'top-stretch' | 'bottom' | 'bottom-stretch'
  | 'left' | 'left-stretch' | 'right' | 'right-stretch'
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  | 'center' | 'h-stretch' | 'v-stretch';

/** UIAnchor — screen positioning and safe area for root UI containers. */
export const UIAnchor = trait({
  anchor: 'stretch' as AnchorMode,
  // The four offsets take their value AND unit defaults from the one length table (#840), so an
  // authored-data reader (`readUIAnchorLength`) cannot disagree with this schema about what an
  // absent unit means. See `uiLength.ts`.
  top: L.top.value as number,
  topUnit: L.top.unit as UILengthUnit,
  left: L.left.value as number,
  leftUnit: L.left.unit as UILengthUnit,
  right: L.right.value as number,
  rightUnit: L.right.unit as UILengthUnit,
  bottom: L.bottom.value as number,
  bottomUnit: L.bottom.unit as UILengthUnit,
  pivotX: 0,
  pivotY: 0,
  safeArea: true as boolean,
});
