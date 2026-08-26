/** The `data-ui-paint` marker (#337 close-out) — stamped by every UINode-rendered layer that
 *  paints something visible but is NOT itself an addressable entity (so it carries no
 *  `data-entity-id` of its own): `NineSliceImage`, `UIVideoMount`, `AnimatedText`'s wrapping
 *  span. The SceneView editor's paint-order click arbiter (`editor/panels/uiPreviewPick.ts`)
 *  searches an entity's own DOM subtree for this marker to know it paints something even when
 *  its own box has no CSS background/text — without it, a 9-sliced dialog (most of Court's
 *  card art) reads as fully decorative and loses a click to whatever is behind it.
 *
 *  ONE constant, not four copies of the string literal, because a producer/consumer pair that
 *  only agrees by matching literals is exactly the kind of drift a refactor (renaming this
 *  attribute, or `NineSliceImage` changing its wrapper) can break silently: `npm run verify`
 *  stays green even with every producer stripped of the marker — see the mutation check in the
 *  #337 close-out. Same pattern as `TouchControl.ts`'s `TOUCH_ATTR`. */
export const UI_PAINT_ATTR = 'data-ui-paint';
