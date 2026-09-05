import { trait } from 'koota';
import type { UILengthUnit } from './UIElement';

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
  top: 0,
  topUnit: 'px' as UILengthUnit,
  left: 0,
  leftUnit: 'px' as UILengthUnit,
  right: 0,
  rightUnit: 'px' as UILengthUnit,
  bottom: 0,
  bottomUnit: 'px' as UILengthUnit,
  pivotX: 0,
  pivotY: 0,
  safeArea: true as boolean,
});
