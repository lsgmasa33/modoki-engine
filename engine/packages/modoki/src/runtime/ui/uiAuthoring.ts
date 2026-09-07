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

/** The pooled-row gate across a selection (#651). `pooled` is one entry per selected entity:
 *  whether it carries the `UIEntry` trait, i.e. is a pooled `UIEntries` row root whose box is
 *  pinned every tick by the scroll view that owns it — margin and min/max size are forced to 0
 *  there, and an authored value never takes effect (`entriesSystem.ts` `warnAuthoredOverride`).
 *  Same unanimous-or-nothing rule as the anchor gates above (#34): `inert` only when EVERY
 *  selected entity is a pooled row, so a mixed selection shows a distinct "partly pooled" note
 *  instead of one that is only true of some of what's selected. The fields themselves stay
 *  editable in every case — this drives an Inspector NOTE, never `readOnly`. */
export function selectionPooledRowGate(pooled: readonly boolean[]): SelectionGate {
  return resolveGate(pooled, (p) => p);
}

/** The four `UIElement` margin fields, as the Inspector and the scene validator both name them. */
export const MARGIN_KEYS: readonly ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'] =
  ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'];

/** The `UIElement` fields `entriesSystem` pins on every pooled `UIEntries` row root, every tick
 *  (#651, #761) — grouped the way both the runtime pin and the Inspector note describe them.
 *  Grouped instead of flat so the Inspector note can name what it pins WITHOUT a hand-written
 *  list drifting from the pin itself: `entriesSystem.ts`'s equality guard, its `entity.set`, and
 *  `PooledRowNote` all derive from this one constant now, so a fifteenth field added to the pin
 *  and forgotten here fails LOUDLY (the drift-guard test) instead of silently, the way `width`,
 *  `widthUnit`, `height`, `heightUnit`, `flexShrink` and `isVisible` did before #761.
 *
 *  `forcedTo` is each group's own Inspector-note copy for "what it pins TO" — NOT `'0'` for every
 *  group (#761): `size` is pinned to the scroll view's own resolved box (in px) and `visibility`
 *  to whether the slot is live, neither of which is a constant. It lives ON the group, not in a
 *  separate label-keyed map (#764 close-out) — a map keyed by `label` string can rename the label
 *  in one place and silently orphan the description in the other (a group renamed 'flex shrink' →
 *  'flex-shrink' left the map's `'flex shrink'` key unmatched, and the note rendered `undefined`
 *  with all tests green). A label and its forced-to text can't separate when they're one object. */
export const POOLED_ROW_PINNED_GROUPS: readonly { label: string; fields: readonly string[]; forcedTo: string }[] = [
  { label: 'size', fields: ['width', 'widthUnit', 'height', 'heightUnit'], forcedTo: "the scroll view's resolved box" },
  { label: 'margin', fields: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'], forcedTo: '0' },
  { label: 'min/max size', fields: ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'], forcedTo: '0' },
  { label: 'flex shrink', fields: ['flexShrink'], forcedTo: '0' },
  { label: 'visibility', fields: ['isVisible'], forcedTo: 'whether the slot is live' },
];

/** Flattened `POOLED_ROW_PINNED_GROUPS` — the exact 14-field set `entriesSystem.ts` writes on a
 *  pooled row root every tick. Its equality guard, its `entity.set` and the drift-guard test in
 *  `entriesSystem.test.ts` all key off this list. */
export const POOLED_ROW_PINNED_FIELDS: readonly string[] =
  POOLED_ROW_PINNED_GROUPS.flatMap((g) => g.fields);

/** Build the exact 14-field record `entriesSystem.ts` pins onto a pooled `UIEntries` row root
 *  every tick (#761 close-out, #764-review). This is the ONE place the pinned VALUES are typed —
 *  `entriesSystem`'s `entity.set` calls this instead of carrying its own literal, so the keys it
 *  writes can never drift from `POOLED_ROW_PINNED_FIELDS` again the way `opacity: 0` did in
 *  review: that mutation added a 15th key to the hand-typed literal and every test stayed green,
 *  because the drift guard only checked the constant's fields AGAINST the pin (one direction) —
 *  never the reverse. Routing the literal through this single builder, and asserting
 *  `Object.keys(buildPooledRowPin(...))` set-equals `POOLED_ROW_PINNED_FIELDS` in
 *  `uiAuthoring.test.ts`, makes the guard BIDIRECTIONAL: a stray key added here fails that test
 *  too, not just a key silently dropped. */
export function buildPooledRowPin(
  { live, wantW, wantH }: { live: boolean; wantW: number; wantH: number },
): Record<string, unknown> {
  return {
    isVisible: live, flexShrink: 0,
    width: wantW, widthUnit: 'px', height: wantH, heightUnit: 'px',
    marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
    minWidth: 0, maxWidth: 0, minHeight: 0, maxHeight: 0,
  };
}

/** The `POOLED_ROW_PINNED_FIELDS` minus the four fields the warn loop handles specially — `width`
 *  and `height` fold their companion unit into ONE warning (see `entriesSystem.ts`'s width/height
 *  call sites), and `isVisible` compares against the slot's live state rather than a plain
 *  equality guard. The remaining nine drive `entriesSystem`'s generic warn loop directly, so a
 *  15th field added to `POOLED_ROW_PINNED_GROUPS` is warned-about automatically instead of
 *  needing a second, hand-typed field list kept in sync by hand (the #761/#764 pattern this whole
 *  module exists to stop). */
export const POOLED_ROW_GENERIC_WARN_FIELDS: readonly string[] = POOLED_ROW_PINNED_FIELDS.filter(
  (f) => f !== 'isVisible' && f !== 'width' && f !== 'widthUnit' && f !== 'height' && f !== 'heightUnit',
);

/** The Inspector's pooled-row note text, built from `POOLED_ROW_PINNED_GROUPS` rather than
 *  hand-written (#761) — so it cannot drift from what `entriesSystem.ts`'s pin actually writes
 *  the way the old two-group text (margin, min/max size) drifted from the six fields #761 added
 *  silently. Plain text, not JSX: this is a DECISION (what the note says), so it lives in a plain
 *  `.ts` module and carries its own test, per this repo's "editor .tsx carries no tests"
 *  convention — `Inspector.tsx`'s `PooledRowNote` only wraps it in the note's box styling.
 *  `mixed` = only PART of the selection is a pooled row (#34's unanimous-or-nothing rule) — the
 *  fields stay editable either way, so this must not claim a value is ignored for entities where
 *  it still takes effect. */
export function pooledRowNoteText(mixed: boolean): string {
  const labels = POOLED_ROW_PINNED_GROUPS.map((g) => g.label);
  if (mixed) {
    return `Partly pooled — some of the selected elements are UIEntries pooled rows and some `
      + `aren't. ${labels.join(', ')} stay editable so the un-pooled ones can still be authored, `
      + `but the pooled ones ignore what you write. Select them separately to be sure of the result.`;
  }
  const forcedTo = POOLED_ROW_PINNED_GROUPS.map((g) => `${g.label} to ${g.forcedTo}`).join('; ');
  return `Pooled row — this UIEntries row's box is owned by the scroll view that spawned it, `
    + `which forces ${labels.join(', ')} below every tick (${forcedTo}) — so authored values `
    + `here will not take effect.`;
}

/** Structured form of `pooledRowNoteText` (#764 close-out) — the Inspector note lost its `<b>`
 *  emphasis when the text moved into a plain-string function, and became one ~300-character
 *  unbroken sentence naming the five labels twice (bare, then again with values). This gives
 *  `PooledRowNote` a `{label, forcedTo}` per group to render as a short bolded list instead, while
 *  still deriving every word from `POOLED_ROW_PINNED_GROUPS` — the same DECISION `pooledRowNoteText`
 *  encodes, just not pre-flattened to a string. `intro` carries the unanimous-or-nothing `mixed`
 *  wording (#34); `items` is the per-group `{label, forcedTo}` list either way, so a mixed
 *  selection still shows an author WHICH fields are at stake even though none of them are forced
 *  there.
 *
 *  `mode` widened from a plain `mixed: boolean` in #671 — the editor half of #671 needed a THIRD
 *  case: a prefab open in prefab-edit mode that some `UIEntries` view spawns as an entry kind. That
 *  prefab carries no live `UIEntry` sibling trait (it's `runtimeOnly`, stamped by `entriesSystem` at
 *  spawn, so it exists in no `.prefab.json`) — the `'inert'`/`'mixed'` cases can never fire there,
 *  and without a third case the entry prefab's root had no signal at all. `'entry-prefab'` reuses
 *  `POOLED_ROW_PINNED_GROUPS` verbatim (same fields the pin writes) with future-tense wording: the
 *  fields are not being overridden RIGHT NOW (nothing is pooled in prefab-edit mode), they WILL be
 *  once some view spawns this prefab as a row. */
export function pooledRowNoteSegments(mode: 'inert' | 'mixed' | 'entry-prefab'): {
  intro: string;
  items: readonly { label: string; forcedTo: string }[];
} {
  const items = POOLED_ROW_PINNED_GROUPS.map((g) => ({ label: g.label, forcedTo: g.forcedTo }));
  if (mode === 'mixed') {
    return {
      intro: `Partly pooled — some of the selected elements are UIEntries pooled rows and some `
        + `aren't. The fields below stay editable so the un-pooled ones can still be authored, but `
        + `the pooled ones ignore what you write. Select them separately to be sure of the result.`,
      items,
    };
  }
  if (mode === 'entry-prefab') {
    return {
      intro: `Entry prefab — a UIEntries scroll view spawns this prefab as an entry kind and will `
        + `force the fields below on this root every tick.`,
      items,
    };
  }
  return {
    intro: `Pooled row — this UIEntries row's box is owned by the scroll view that spawned it, `
      + `which forces the fields below every tick — so authored values here will not take effect.`,
    items,
  };
}

/** Is an authored `UIElement.margin*` INERT because the element is anchored (#757)?
 *
 *  `UINode` writes all four margins into the style; `applyAnchorStyle` then runs and clears every
 *  one of them. This is #746's shape exactly — a late writer replacing an authored `UIElement`
 *  field — and it was found by sweeping for that pattern rather than its symptom.
 *
 *  ⚠️ **The condition is "has an anchor at all", with NO per-mode nuance** — unlike `isSizeInert`,
 *  which only fires on the stretched axis. `applyAnchorStyle` clears all four unconditionally for
 *  every anchor mode, so this predicate must too. `anchorCss` imports it rather than restating the
 *  condition, so the editor cannot disagree with the layout about what is inert.
 *
 *  ⚠️ **This is deliberately NOT a claim that margin could never do anything here.** The original
 *  code comment said margin "does not affect position — the pivot sits at the anchor point
 *  regardless", which is true of the pivot but not the whole story: on a STRETCHED axis
 *  (`top: 0; bottom: 0` with `height: auto`) CSS margins genuinely participate in the
 *  over-constrained resolution and would shrink the box. So for the `*-stretch` modes the engine is
 *  DECIDING margin should not apply, not observing that it cannot.
 *
 *  That decision was put to the owner and upheld (2026-09-05): anchor offsets stay the ONE way to
 *  inset a stretched element, because a second way to produce the same gap means an author has to
 *  know which one the last author used. It also matches why the Inspector's Margin section is
 *  collapsed by default — margin is deliberately de-emphasised here, so the acceptable direction
 *  for a fix is to make its limits louder, never to give it a second job. Same ruling as #746: the
 *  defect is the SILENCE, not the precedence.
 *
 *  Takes the entity's anchor mode, or null/undefined when it has no `UIAnchor` at all. A mode of
 *  `''` still counts as anchored — that is a missing MODE, not a missing anchor, the same
 *  distinction `selectionAnchorGate` draws. */
export function isElementMarginInert(anchor: string | null | undefined): boolean {
  return anchor !== null && anchor !== undefined;
}

/** The margin gate across a selection (#757). One entry per selected entity: its `UIAnchor.anchor`,
 *  or null/undefined when it has no anchor. Unanimous-or-nothing per #34.
 *
 *  ⚠️ **Exists so the Inspector's margin decision runs through `isElementMarginInert`.** It is
 *  behaviourally identical to `selectionAnchorGate` TODAY, and that is not a reason to reuse that
 *  one: `selectionAnchorGate` carries its own inline copy of the condition, so routing margin
 *  through it made "the same predicate drives the layout and the editor" false for the decision
 *  that actually sets `readOnly` — `anchorCss` would have stopped clearing margins while the
 *  Inspector kept the fields greyed, leaving an author unable to type a value that had started
 *  working. The two ALSO answer different questions (self-placement vs. margin) and may diverge, so
 *  a shared body is the wrong kind of saving. */
export function selectionMarginGate(anchors: readonly (string | null | undefined)[]): SelectionGate {
  return resolveGate(anchors, isElementMarginInert);
}
