/** Anchor-first UI authoring rules.
 *
 *  Modoki authors come from Unity, where placement is anchor-based (RectTransform)
 *  rather than CSS flex. So the editor treats the UIAnchor as the primary
 *  positioning tool: every UI element is created with one, the Inspector floats it
 *  to the top (priority < UIElement), and an anchor disables the UIElement flex
 *  fields it overrides. This module is the single, pure, testable home for those
 *  rules — imported by both the Hierarchy "Create UI" menu and the Inspector.
 *
 *  Key distinction the disabling encodes: a UIElement has TWO layout roles —
 *    • "how I sit in my parent"  (flexGrow / flexShrink / alignSelf, stretched
 *      width/height) — an anchor (position:absolute) overrides these → disabled.
 *    • "how I arrange MY children" (flexDirection / justifyContent / alignItems /
 *      gap) — the Unity LayoutGroup equivalent; still works under an anchor (e.g.
 *      an anchored panel stacking a runtime-variable list) → stays live.
 *  Only the first set lives in SELF_PLACEMENT_PROPS. */

export type UiPreset = 'view' | 'text' | 'image' | 'button' | 'input' | 'slider';

export interface UiTraitSpec {
  name: string;
  data?: Record<string, unknown>;
}

/** Per-preset UIElement field defaults (size / colors / text / element type). */
export const UI_PRESET_DEFAULTS: Record<UiPreset, Record<string, unknown>> = {
  view: { width: 200, height: 100, backgroundOpacity: 0.1, backgroundColor: 0xffffff, borderWidth: 1, borderColor: 0xffffff },
  text: { fontSize: 16, textColor: 0xffffff, text: 'Text' },
  image: { width: 100, height: 100 },
  button: { width: 120, height: 40, backgroundOpacity: 0.8, backgroundColor: 0x3498db, borderRadius: 8, fontSize: 14, textColor: 0xffffff, text: 'Button' },
  input: { elementType: 'input', width: 160, height: 32, backgroundOpacity: 1, backgroundColor: 0xffffff, borderWidth: 1, borderColor: 0xcccccc, borderRadius: 4, fontSize: 14, textColor: 0x222222, placeholder: 'Enter text…' },
  slider: { elementType: 'range', width: 160, height: 24, rangeMin: 0, rangeMax: 100, rangeStep: 1 },
};

/** Default anchor stamped on every newly-created UI element: centered, with
 *  pivot 0.5 so the element's CENTER (not its top-left) lands at the parent
 *  center — pivot 0 against a `center` anchor would offset it down-right. */
export const DEFAULT_UI_ANCHOR = { anchor: 'center', pivotX: 0.5, pivotY: 0.5 } as const;

/** Build the trait specs for a new UI element of `preset` under `parentId`.
 *  Always includes a UIAnchor (anchor-first authoring). */
export function buildUiCreateSpecs(preset: UiPreset, parentId: number): { name: string; specs: UiTraitSpec[] } {
  const label = preset.charAt(0).toUpperCase() + preset.slice(1);
  const name = `UI ${label}`;
  return {
    name,
    specs: [
      { name: 'EntityAttributes', data: { name, parentId, layer: 'ui' } },
      { name: 'RenderableUI' },
      { name: 'UIAnchor', data: { ...DEFAULT_UI_ANCHOR } },
      { name: 'UIElement', data: UI_PRESET_DEFAULTS[preset] },
    ],
  };
}

/** UIElement "self-placement" flex props — how the element sits in its parent.
 *  An anchor overrides all of these, so the Inspector disables them (with a
 *  "remove anchor to use flex" note) when the entity has a UIAnchor. The
 *  container/child-arrangement props are deliberately NOT here (see module doc). */
export const SELF_PLACEMENT_PROPS: ReadonlySet<string> = new Set(['flexGrow', 'flexShrink', 'alignSelf']);

/** Whether a UIElement field `key` is disabled by the presence of a UIAnchor.
 *  width/height are handled separately (disabled only on a stretched axis). */
export function isSelfPlacementDisabled(traitName: string, hasAnchor: boolean, key: string): boolean {
  return traitName === 'UIElement' && hasAnchor && SELF_PLACEMENT_PROPS.has(key);
}
