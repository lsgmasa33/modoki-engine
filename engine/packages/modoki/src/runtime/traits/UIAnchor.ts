import { trait } from 'koota';
import type { UILengthUnit } from './UIElement';

/** UIAnchor — screen positioning and safe area for root UI containers. */
export const UIAnchor = trait({
  anchor: 'stretch' as 'stretch' | 'top' | 'top-stretch' | 'bottom' | 'bottom-stretch' | 'left' | 'left-stretch' | 'right' | 'right-stretch' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center' | 'h-stretch' | 'v-stretch',
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
  zIndex: 0,
});
