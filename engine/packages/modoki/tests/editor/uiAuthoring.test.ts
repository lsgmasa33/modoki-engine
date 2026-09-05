/** uiAuthoring — anchor-first UI authoring rules (pure).
 *
 *  Guards the decisions behind the "Create UI favors Anchor over flex" change:
 *   • every Create-UI preset stamps a centered UIAnchor (anchor-first),
 *   • the default anchor truly centers (center + pivot 0.5, not pivot 0),
 *   • only SELF-placement flex props are disabled by an anchor — the
 *     child-arrangement (LayoutGroup) props stay live. */

import { describe, it, expect } from 'vitest';
import {
  buildUiCreateSpecs,
  DEFAULT_UI_ANCHOR,
  UI_PRESET_DEFAULTS,
  SELF_PLACEMENT_PROPS,
  isSelfPlacementDisabled,
  selectionSizeGate,
  selectionAnchorGate,
  selectionPooledRowGate,
  isElementMarginInert,
  MARGIN_KEYS,
  POOLED_ROW_PINNED_GROUPS,
  POOLED_ROW_PINNED_FIELDS,
  POOLED_ROW_GENERIC_WARN_FIELDS,
  buildPooledRowPin,
  pooledRowNoteText,
  pooledRowNoteSegments,
  type UiPreset,
} from '../../src/runtime/ui/uiAuthoring';

const ALL_PRESETS: UiPreset[] = ['view', 'text', 'image', 'button', 'input', 'slider'];

describe('buildUiCreateSpecs (anchor-first)', () => {
  it('every preset includes EntityAttributes + RenderableUI + UIAnchor + UIElement', () => {
    for (const preset of ALL_PRESETS) {
      const { specs } = buildUiCreateSpecs(preset, 0);
      const names = specs.map((s) => s.name);
      expect(names).toContain('EntityAttributes');
      expect(names).toContain('RenderableUI');
      expect(names).toContain('UIAnchor');
      expect(names).toContain('UIElement');
    }
  });

  it('stamps the centered default anchor on every preset', () => {
    for (const preset of ALL_PRESETS) {
      const { specs } = buildUiCreateSpecs(preset, 0);
      const anchor = specs.find((s) => s.name === 'UIAnchor');
      expect(anchor?.data).toEqual({ anchor: 'center', pivotX: 0.5, pivotY: 0.5 });
    }
  });

  it('default anchor centers via pivot 0.5 (pivot 0 would offset to bottom-right)', () => {
    // Regression guard: a `center` anchor with the trait-default pivot 0 lands the
    // element's top-left at the parent center. Pivot 0.5 puts its CENTER there.
    expect(DEFAULT_UI_ANCHOR.anchor).toBe('center');
    expect(DEFAULT_UI_ANCHOR.pivotX).toBe(0.5);
    expect(DEFAULT_UI_ANCHOR.pivotY).toBe(0.5);
  });

  it('names the element "UI <Preset>" and parents/labels EntityAttributes correctly', () => {
    const { name, specs } = buildUiCreateSpecs('button', 42);
    expect(name).toBe('UI Button');
    const attrs = specs.find((s) => s.name === 'EntityAttributes');
    expect(attrs?.data).toMatchObject({ name: 'UI Button', parentId: 42, layer: 'ui' });
  });

  it('carries the preset UIElement defaults through unchanged', () => {
    const { specs } = buildUiCreateSpecs('slider', 0);
    const el = specs.find((s) => s.name === 'UIElement');
    expect(el?.data).toBe(UI_PRESET_DEFAULTS.slider);
    expect(el?.data).toMatchObject({ elementType: 'range', rangeMin: 0, rangeMax: 100 });
  });

  it('orders UIAnchor before UIElement in the spec list', () => {
    const { specs } = buildUiCreateSpecs('view', 0);
    const names = specs.map((s) => s.name);
    expect(names.indexOf('UIAnchor')).toBeLessThan(names.indexOf('UIElement'));
  });
});

describe('isSelfPlacementDisabled (anchor overrides self-placement only)', () => {
  it('disables grow/shrink/align-self on an anchored UIElement', () => {
    for (const key of ['flexGrow', 'flexShrink', 'alignSelf']) {
      expect(isSelfPlacementDisabled('UIElement', true, key)).toBe(true);
      expect(SELF_PLACEMENT_PROPS.has(key)).toBe(true);
    }
  });

  it('keeps child-arrangement (LayoutGroup) props live even when anchored', () => {
    // These arrange THIS element's children — unaffected by its own anchor.
    for (const key of ['flexDirection', 'justifyContent', 'alignItems', 'gap', 'padding', 'backgroundColor']) {
      expect(isSelfPlacementDisabled('UIElement', true, key)).toBe(false);
      expect(SELF_PLACEMENT_PROPS.has(key)).toBe(false);
    }
  });

  it('disables nothing when the element has no anchor', () => {
    for (const key of ['flexGrow', 'flexShrink', 'alignSelf']) {
      expect(isSelfPlacementDisabled('UIElement', false, key)).toBe(false);
    }
  });

  it('only applies to UIElement, not other traits', () => {
    expect(isSelfPlacementDisabled('UIAnchor', true, 'flexGrow')).toBe(false);
    expect(isSelfPlacementDisabled('Transform', true, 'flexGrow')).toBe(false);
  });
});

describe('selectionSizeGate (unanimous-or-nothing across a multi-selection, #34)', () => {
  it('is live when nothing in the selection stretches that axis', () => {
    expect(selectionSizeGate(['bottom', 'center', null], 'width')).toBe('live');
  });

  it('is inert only when EVERY entity has that axis stretched', () => {
    expect(selectionSizeGate(['stretch', 'bottom-stretch', 'h-stretch'], 'width')).toBe('inert');
    // The same selection for HEIGHT: only 'stretch' kills it → not unanimous.
    expect(selectionSizeGate(['stretch', 'bottom-stretch', 'h-stretch'], 'height')).toBe('mixed');
  });

  it('is mixed regardless of which end the live one sits at', () => {
    // The pre-#34 bug was order-sensitive (it read entityIds[0]); the verdict must not be.
    expect(selectionSizeGate(['bottom-stretch', 'bottom'], 'width')).toBe('mixed');
    expect(selectionSizeGate(['bottom', 'bottom-stretch'], 'width')).toBe('mixed');
  });

  it('counts an un-anchored entity as live — its size always takes effect', () => {
    expect(selectionSizeGate(['stretch', null], 'width')).toBe('mixed');
    expect(selectionSizeGate([null, undefined], 'width')).toBe('live');
  });

  it('single-select still collapses to a plain inert/live answer', () => {
    expect(selectionSizeGate(['bottom-stretch'], 'width')).toBe('inert');
    expect(selectionSizeGate(['bottom-stretch'], 'height')).toBe('live');
  });

  it('an empty selection gates nothing', () => {
    expect(selectionSizeGate([], 'width')).toBe('live');
  });
});

describe('selectionAnchorGate (self-placement props, #34)', () => {
  it('only reports inert when every entity is anchored — any mode counts', () => {
    expect(selectionAnchorGate(['center', 'stretch'])).toBe('inert');
    expect(selectionAnchorGate(['center', null])).toBe('mixed');
    expect(selectionAnchorGate([null, null])).toBe('live');
    expect(selectionAnchorGate([])).toBe('live');
  });

  it('counts an anchor with an unreadable mode ("") as anchored', () => {
    // `''` = anchored, mode unknown; `null` = no anchor at all. The two gates disagree
    // about it ON PURPOSE — any anchor kills self-placement, but an unknown mode
    // stretches nothing — so collapsing them would break exactly one of the two.
    expect(selectionAnchorGate(['', ''])).toBe('inert');
    expect(selectionAnchorGate(['', null])).toBe('mixed');
    expect(selectionSizeGate(['', ''], 'width')).toBe('live');
  });
});

describe('selectionPooledRowGate (UIEntries pooled-row Inspector note, #651)', () => {
  it('is live when nothing in the selection is a pooled row', () => {
    expect(selectionPooledRowGate([false, false])).toBe('live');
    expect(selectionPooledRowGate([])).toBe('live');
  });

  it('is inert only when EVERY selected entity is a pooled row', () => {
    expect(selectionPooledRowGate([true, true])).toBe('inert');
    expect(selectionPooledRowGate([true])).toBe('inert');
  });

  it('is mixed when only part of the selection is a pooled row, regardless of order', () => {
    expect(selectionPooledRowGate([true, false])).toBe('mixed');
    expect(selectionPooledRowGate([false, true])).toBe('mixed');
  });
});

/**
 * #757 — `applyAnchorStyle` clears all four UIElement margins on an anchored element, so an
 * authored value is discarded with no signal. #746's shape, found by sweeping for the pattern.
 * The predicate is shared with `anchorCss` and the Inspector gate so they cannot drift.
 */
describe('isElementMarginInert (#757)', () => {
  it('any anchor kills margin — EVERY mode, not just the stretching ones', () => {
    // The contrast with isSizeInert is the whole point: size dies only on a stretched axis, margin
    // dies on all four sides under any anchor at all. A per-mode predicate here would be wrong.
    for (const a of ['center', 'top-left', 'bottom-right', 'stretch', 'top-stretch', 'left-stretch']) {
      expect(isElementMarginInert(a)).toBe(true);
    }
  });

  it('no anchor leaves margin live — this is flow layout, where margin is the real mechanism', () => {
    expect(isElementMarginInert(null)).toBe(false);
    expect(isElementMarginInert(undefined)).toBe(false);
  });

  it("an unreadable mode ('') still counts as ANCHORED — a missing mode is not a missing anchor", () => {
    // Same distinction selectionAnchorGate draws, and the opposite of selectionSizeGate, where ''
    // correctly stretches nothing. Getting this backwards would leave the field live on an element
    // whose margins are in fact being cleared.
    expect(isElementMarginInert('')).toBe(true);
  });

  it('MARGIN_KEYS names exactly the four UIElement margin fields', () => {
    expect([...MARGIN_KEYS]).toEqual(['marginTop', 'marginRight', 'marginBottom', 'marginLeft']);
  });
});

describe('selectionAnchorGate drives the margin fields (#757)', () => {
  // Margin needs no gate of its own: "is every selected entity anchored?" is exactly the condition,
  // and selectionAnchorGate already answers it. Pinned here so a later reader does not add a
  // redundant selectionMarginGate, and so the unanimous-or-nothing rule (#34) is covered for margin
  // specifically rather than only for zIndex and size.
  it('unanimous anchored → inert (dim + read-only)', () => {
    expect(selectionAnchorGate(['center', 'stretch', ''])).toBe('inert');
  });

  it('none anchored → live', () => {
    expect(selectionAnchorGate([null, undefined])).toBe('live');
  });

  it('MIXED stays editable — blocking it would strand the flow-layout entities', () => {
    expect(selectionAnchorGate(['center', null])).toBe('mixed');
  });
});

describe('POOLED_ROW_PINNED_FIELDS / POOLED_ROW_PINNED_GROUPS (#761)', () => {
  it('flattens to exactly the fourteen fields entriesSystem pins', () => {
    expect(POOLED_ROW_PINNED_FIELDS).toEqual([
      'width', 'widthUnit', 'height', 'heightUnit',
      'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
      'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
      'flexShrink', 'isVisible',
    ]);
  });

  it('every field appears in exactly one group — no drift between the flat list and the groups', () => {
    const seen = new Set<string>();
    for (const g of POOLED_ROW_PINNED_GROUPS) {
      for (const f of g.fields) {
        expect(seen.has(f), `'${f}' appears in more than one group`).toBe(false);
        seen.add(f);
      }
    }
    expect([...seen].sort()).toEqual([...POOLED_ROW_PINNED_FIELDS].sort());
  });

  it('buildPooledRowPin writes EXACTLY the POOLED_ROW_PINNED_FIELDS key set — bidirectional #764 guard', () => {
    // #761's own drift guard (entriesSystem.test.ts) only checked "every field the constant
    // names is actually corrected" — it caught a field DROPPED from the pin, but not one ADDED to
    // it: a reviewer added `opacity: 0` to the pin's hand-typed literal and all 95 tests stayed
    // green. Routing the literal through `buildPooledRowPin` and asserting a SET-EQUALS here
    // (not a superset check) closes that hole — this must go red the moment the builder's
    // returned keys stop matching the constant in EITHER direction.
    const pin = buildPooledRowPin({ live: true, wantW: 100, wantH: 50 });
    expect(new Set(Object.keys(pin))).toEqual(new Set(POOLED_ROW_PINNED_FIELDS));
  });
});

describe('POOLED_ROW_GENERIC_WARN_FIELDS (#764)', () => {
  it('is POOLED_ROW_PINNED_FIELDS minus the four specially-handled fields', () => {
    const specially_handled = new Set(['isVisible', 'width', 'widthUnit', 'height', 'heightUnit']);
    const expected = POOLED_ROW_PINNED_FIELDS.filter((f) => !specially_handled.has(f));
    expect([...POOLED_ROW_GENERIC_WARN_FIELDS].sort()).toEqual([...expected].sort());
  });
});

describe('pooledRowNoteText (#761 — widened from margin/min-max to all fourteen fields)', () => {
  it('mentions every group label from POOLED_ROW_PINNED_GROUPS, not just margin and min/max size', () => {
    const text = pooledRowNoteText(false);
    for (const g of POOLED_ROW_PINNED_GROUPS) expect(text).toContain(g.label);
  });

  it('the mixed-selection text also mentions every group label', () => {
    const text = pooledRowNoteText(true);
    for (const g of POOLED_ROW_PINNED_GROUPS) expect(text).toContain(g.label);
  });

  it('mentions all five labels AND all five forced-to descriptions (#764 — was only 2 of 5)', () => {
    // A prior version of this test asserted only the label loop above and the two non-constant
    // forced-to strings ("scroll view's resolved box", "whether the slot is live") — it never
    // pinned the three plain "0" descriptions (margin, min/max size, flex shrink) to anything, so
    // renaming `POOLED_ROW_PINNED_GROUPS['flex shrink']`'s label (#764's reviewer mutation) broke
    // the text (an `undefined` forced-to) without breaking this suite.
    const text = pooledRowNoteText(false);
    expect(POOLED_ROW_PINNED_GROUPS).toHaveLength(5);
    for (const g of POOLED_ROW_PINNED_GROUPS) {
      expect(text, `label '${g.label}' missing from the note`).toContain(g.label);
      expect(text, `forcedTo '${g.forcedTo}' (for '${g.label}') missing from the note`).toContain(g.forcedTo);
    }
    expect(text).not.toContain('undefined');
  });

  it('does not claim "forced to 0" for size or visibility — they are forced to a resolved value', () => {
    // The old two-group text said "forced to 0"; size and visibility are pinned to the scroll
    // view's resolved box and the slot's live state respectively, neither a constant.
    const text = pooledRowNoteText(false);
    expect(text).toContain("scroll view's resolved box");
    expect(text).toContain('whether the slot is live');
  });

  it('mixed text says fields stay editable, and non-mixed text says they are forced', () => {
    expect(pooledRowNoteText(true)).toContain('stay editable');
    expect(pooledRowNoteText(false)).toContain('forces');
  });
});

describe('pooledRowNoteSegments (#764 — structured note, restores Inspector bolding)', () => {
  it('returns one {label, forcedTo} item per POOLED_ROW_PINNED_GROUPS entry, in order', () => {
    const { items } = pooledRowNoteSegments(false);
    expect(items).toEqual(POOLED_ROW_PINNED_GROUPS.map((g) => ({ label: g.label, forcedTo: g.forcedTo })));
  });

  it('the mixed variant carries the same items — a mixed selection still names which fields are at stake', () => {
    const { items } = pooledRowNoteSegments(true);
    expect(items).toEqual(POOLED_ROW_PINNED_GROUPS.map((g) => ({ label: g.label, forcedTo: g.forcedTo })));
  });

  it('intro text matches pooledRowNoteText\'s tone for each mode', () => {
    expect(pooledRowNoteSegments(true).intro).toContain('stay editable');
    expect(pooledRowNoteSegments(false).intro).toContain('forces');
  });
});
