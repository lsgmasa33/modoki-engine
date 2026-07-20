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
  type UiPreset,
} from '../../src/editor/uiAuthoring';

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
