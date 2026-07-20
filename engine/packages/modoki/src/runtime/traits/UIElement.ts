import { trait } from 'koota';

/** Length units for UIElement/UIAnchor fields. `px`/`%` plus the four viewport
 *  units (resolved against the LOGICAL device viewport — see resolveLengthPx /
 *  cssVal). Adding a unit here means updating: resolveLengthPx (anchorLayout.ts),
 *  cssVal (UINode.tsx), the anchor CSS emitter (anchorCss.ts), the inspector
 *  dropdown + registerTraits enums, and uiResizeMath. */
export type UILengthUnit = 'px' | '%' | 'vw' | 'vh' | 'vmin' | 'vmax';

/** UIElement — consolidated UI trait: layout, style, text, and image. */
export const UIElement = trait({
  // ── Layout ──
  width: 0,   // 0 = auto
  height: 0,  // 0 = auto
  widthUnit: '%' as UILengthUnit,
  heightUnit: '%' as UILengthUnit,
  flexDirection: 'column' as 'row' | 'column',
  flexWrap: 'nowrap' as 'nowrap' | 'wrap',
  justifyContent: 'flex-start' as 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around',
  alignItems: 'stretch' as 'flex-start' | 'center' | 'flex-end' | 'stretch',
  gap: 0,
  flexGrow: 0,
  flexShrink: 1,
  paddingTop: 0,
  paddingTopUnit: '%' as UILengthUnit,
  paddingLeft: 0,
  paddingLeftUnit: '%' as UILengthUnit,
  paddingRight: 0,
  paddingRightUnit: '%' as UILengthUnit,
  paddingBottom: 0,
  paddingBottomUnit: '%' as UILengthUnit,
  marginTop: 0,
  marginTopUnit: '%' as UILengthUnit,
  marginRight: 0,
  marginRightUnit: '%' as UILengthUnit,
  marginBottom: 0,
  marginBottomUnit: '%' as UILengthUnit,
  marginLeft: 0,
  marginLeftUnit: '%' as UILengthUnit,
  minWidth: 0,   // 0 = none
  minWidthUnit: 'px' as UILengthUnit,
  maxWidth: 0,   // 0 = none
  maxWidthUnit: 'px' as UILengthUnit,
  minHeight: 0,  // 0 = none
  minHeightUnit: 'px' as UILengthUnit,
  maxHeight: 0,  // 0 = none
  maxHeightUnit: 'px' as UILengthUnit,
  alignSelf: 'auto' as 'auto' | 'flex-start' | 'center' | 'flex-end' | 'stretch',
  zIndex: 0,
  overflow: 'visible' as 'visible' | 'hidden' | 'scroll',
  isVisible: true,

  // ── Style (box visuals) ──
  backgroundColor: 0 as number,   // 0 = transparent
  backgroundOpacity: 0,
  borderRadius: 0,
  borderWidth: 0,
  borderColor: 0x333333 as number,
  borderOpacity: 1,      // border color alpha (folded into the borderColor picker)
  opacity: 1,

  // ── Text ──
  text: '' as string,
  fontFamily: '' as string,
  fontSize: 16,
  fontWeight: 'normal' as 'normal' | 'bold',
  fontStyle: 'normal' as 'normal' | 'italic',
  textColor: 0xffffff as number,
  textOpacity: 1,        // text color alpha (folded into the textColor picker)
  textAlign: 'left' as 'left' | 'center' | 'right',
  lineHeight: 0,         // 0 = auto/normal
  letterSpacing: 0,
  textShadowColor: 0x000000 as number,
  textShadowOpacity: 1,  // shadow color alpha (folded into the textShadowColor picker)
  textShadowOffsetX: 0,
  textShadowOffsetY: 0,
  textShadowBlur: 0,
  textStrokeColor: 0x000000 as number,
  textStrokeOpacity: 1,  // stroke color alpha (folded into the textStrokeColor picker)
  textStrokeWidth: 0,
  textOverflow: 'clip' as 'clip' | 'ellipsis',
  maxLines: 0,           // 0 = unlimited

  // ── Image ──
  imageSrc: '' as string,
  imageMode: 'cover' as 'cover' | 'contain' | 'fill' | 'none',

  // ── Element type ──
  elementType: 'div' as 'div' | 'input' | 'range',
  placeholder: '' as string,

  // ── Range (slider) ──
  rangeMin: 0,
  rangeMax: 100,
  rangeStep: 1,
});
