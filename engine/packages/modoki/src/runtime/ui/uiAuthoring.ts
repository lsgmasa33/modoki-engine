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

import { isSizeInert } from './anchorLayout';

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

/** How a per-field gate resolves across a MULTI-selection.
 *  `inert` = dead on every selected entity (safe to make read-only),
 *  `mixed` = dead on some and live on others,
 *  `live`  = dead on none. */
export type SelectionGate = 'live' | 'mixed' | 'inert';

/** Resolve a gate from a per-entity predicate over the whole selection.
 *
 *  WHY THIS EXISTS (issue #34): the gates below used to read the PRIMARY entity
 *  alone, which is wrong in BOTH directions once the gate drives `readOnly` rather
 *  than mere dimming — a stretched primary made the field read-only on siblings
 *  where the value is genuinely live, and a non-stretched primary let a write land
 *  on siblings that silently discard it (the #16 trap, re-entered via the
 *  selection). Only a unanimous verdict may disable a control; anything else is
 *  `mixed` and must stay editable, labelled as mixed. */
function resolveGate<T>(items: readonly T[], isInert: (item: T) => boolean): SelectionGate {
  if (items.length === 0) return 'live';
  let inert = 0;
  for (const item of items) if (isInert(item)) inert += 1;
  if (inert === 0) return 'live';
  return inert === items.length ? 'inert' : 'mixed';
}

/** The width/height gate across a selection. `anchors` is one entry per selected
 *  entity: its UIAnchor mode, or null/undefined when it has no anchor (a free-flow
 *  element, whose size is always live). */
export function selectionSizeGate(
  anchors: readonly (string | null | undefined)[],
  axis: 'width' | 'height',
): SelectionGate {
  return resolveGate(anchors, (a) => !!a && isSizeInert(a, axis));
}

/** The self-placement (flexGrow/flexShrink/alignSelf) gate across a selection.
 *  Any anchor at all kills these, whatever its mode — so this asks only whether each
 *  selected entity HAS one, i.e. its entry is non-null. An anchored entity whose mode
 *  is unreadable (`''`) still counts as anchored: `''` is a missing MODE, not a missing
 *  anchor, and the two must not collapse (they answer different questions here and in
 *  `selectionSizeGate`, where `''` correctly stretches nothing). */
export function selectionAnchorGate(anchors: readonly (string | null | undefined)[]): SelectionGate {
  return resolveGate(anchors, (a) => a !== null && a !== undefined);
}
