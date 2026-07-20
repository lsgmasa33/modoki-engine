import { trait } from 'koota';

/** UIBinding — connects UI content to Zustand store fields.
 *
 *  Covers text templating, two-way input, state-driven VISIBILITY, and a small "active
 *  highlight" rule. Visibility: the authored `UIElement.isVisible` is still the base source of
 *  truth; a `visibleBinding` (below) can ADDITIONALLY hide the element from a store field (both
 *  must be true), and — like a button's UIAction `kind:'set'` — it's a play-time effect that never
 *  reaches disk (the editor ignores it so bound elements stay authorable).
 *
 *  Active highlight reads the SOURCE OF TRUTH directly (no mirrored store flag):
 *  the element renders with `highlightColor` as its background whenever the live
 *  value of `highlightComponent.highlightProperty` on the entity referenced by
 *  `highlightTarget` (a guid) string-equals `highlightValue`. The canonical use
 *  is a clip-selector button that lights up while its clip is the one currently
 *  playing — `highlightTarget`→the animated entity, component `SkeletalAnimator`,
 *  property `clip`, value this button's clip name. Disabled when
 *  `highlightColor` < 0 (the default).
 *
 *  ⚠️ REPAINT INVARIANT (the watched value must dirty the UI): the highlight
 *  re-resolves only when the UI tree rebuilds, which happens on a UI dirty signal —
 *  i.e. when the watched trait is written through `setTrait`/`writeTraitField` (these
 *  call `markUIDirty`) or by a UIAction `kind:'set'` binding. If a SYSTEM mutates the
 *  watched value via a raw `entity.set`/`updateEach` (the per-frame ECS write path,
 *  which deliberately bypasses the dirty system for performance), the highlight will
 *  NOT update until some other UI change dirties the tree. The canonical clip-selector
 *  is safe because the clip is changed via a `set` binding. To highlight a value a
 *  game system drives directly, that writer must call `markUIDirty()` after the write.
 *  (Locked by uiTreeHighlight.test.ts "does NOT re-resolve … without a dirty signal".) */
export const UIBinding = trait({
  textBinding: '' as string,      // store field for text template, e.g. "score"
  inputBinding: '' as string,     // store field for two-way input value, e.g. "inputText"
  // State-driven visibility: hide/show this element from a store field (in ADDITION to the
  // authored UIElement.isVisible — both must be true). '' visibleBinding = no override. `visibleOp`
  // '' means "truthy"; otherwise compare the store value against `visibleValue` (number-coerced when
  // both look numeric). E.g. show a game-over panel when `gameOver` is truthy, or a heart when
  // `hearts >= 2`. Re-resolves on any UI dirty / store change (like textBinding).
  visibleBinding: '' as string,   // store field to gate visibility on, e.g. "gameOver" / "hearts"
  visibleOp: '' as string,        // '' (truthy) | '==' | '!=' | '>' | '>=' | '<' | '<='
  visibleValue: '' as string,     // compared value (number-coerced when numeric), e.g. "2"
  highlightTarget: '' as string,     // guid of the entity holding the state to compare
  highlightComponent: '' as string,  // trait name on the target, e.g. "SkeletalAnimator"
  highlightProperty: '' as string,   // field on that trait, e.g. "clip"
  highlightValue: '' as string,      // value (string-compared) that marks THIS element active
  highlightColor: -1 as number,      // active background color (0xRRGGBB); < 0 = highlight off
  highlightTextColor: -1 as number,  // active text color (0xRRGGBB); < 0 = leave text unchanged
});
