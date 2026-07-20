/** UI trait schema verification — verifies all UI traits are properly defined. */

import { describe, it, expect } from 'vitest';

async function getUITraits() {
  return import('../../../src/runtime/traits');
}

describe('UI traits', () => {
  describe('UIElement (consolidated)', () => {
    it('has layout fields', async () => {
      const { UIElement } = await getUITraits();
      expect(UIElement).toBeDefined();
      const schema = (UIElement as any).schema;
      expect(schema.flexDirection).toBe('column');
      expect(schema.justifyContent).toBe('flex-start');
      expect(schema.alignItems).toBe('stretch');
      expect(schema.isVisible).toBe(true);
      expect(schema.marginTop).toBe(0);
      expect(schema.alignSelf).toBe('auto');
      expect(schema.zIndex).toBe(0);
      expect(schema.minWidth).toBe(0);
      expect(schema.maxWidth).toBe(0);
    });

    it('has style fields (from UIStyle)', async () => {
      const { UIElement } = await getUITraits();
      const schema = (UIElement as any).schema;
      expect(schema.backgroundColor).toBe(0);
      expect(schema.backgroundOpacity).toBe(0);
      expect(schema.borderRadius).toBe(0);
      expect(schema.opacity).toBe(1);
    });

    it('has text fields (from UIText)', async () => {
      const { UIElement } = await getUITraits();
      const schema = (UIElement as any).schema;
      expect(schema.text).toBe('');
      expect(schema.fontFamily).toBe('');
      expect(schema.fontSize).toBe(16);
      expect(schema.fontWeight).toBe('normal');
      expect(schema.fontStyle).toBe('normal');
      expect(schema.textColor).toBe(0xffffff);
      expect(schema.textAlign).toBe('left');
      expect(schema.lineHeight).toBe(0);
      expect(schema.textStrokeWidth).toBe(0);
      expect(schema.textOverflow).toBe('clip');
      expect(schema.maxLines).toBe(0);
    });

    it('has image fields (from UIContent)', async () => {
      const { UIElement } = await getUITraits();
      const schema = (UIElement as any).schema;
      expect(schema.imageSrc).toBe('');
      expect(schema.imageMode).toBe('cover');
    });

    it('can be called as a function', async () => {
      const { UIElement } = await getUITraits();
      const data = UIElement();
      expect(data).toBeDefined();
    });

    it('has elementType + placeholder + range fields with safe defaults', async () => {
      const { UIElement } = await getUITraits();
      const schema = (UIElement as any).schema;
      expect(schema.elementType).toBe('div');
      expect(schema.placeholder).toBe('');
      // Range defaults — slider spans 0..100 in steps of 1 until the editor
      // overrides them on a per-element basis.
      expect(schema.rangeMin).toBe(0);
      expect(schema.rangeMax).toBe(100);
      expect(schema.rangeStep).toBe(1);
    });

    it('accepts range overrides via the trait constructor (does not throw)', async () => {
      const { UIElement } = await getUITraits();
      // koota traits don't surface field values from the factory return; we
      // just verify the trait factory accepts the new range fields without
      // throwing. Field-default validation lives in the schema check above.
      expect(() => UIElement({ elementType: 'range', rangeMin: -5, rangeMax: 12, rangeStep: 0.25 })).not.toThrow();
    });
  });

  describe('UIBinding', () => {
    it('is defined with binding fields', async () => {
      const { UIBinding } = await getUITraits();
      expect(UIBinding).toBeDefined();
      const schema = (UIBinding as any).schema;
      expect(schema.textBinding).toBe('');
      expect(schema.inputBinding).toBe('');
    });
  });

  describe('UIAction', () => {
    it('is defined with a bindings array', async () => {
      const { UIAction } = await getUITraits();
      const { createWorld } = await import('koota');
      expect(UIAction).toBeDefined();
      // AoS trait (callback form, because bindings is an array) — no .schema;
      // read defaults by spawning.
      const w = createWorld();
      const data = w.spawn(UIAction()).get(UIAction) as any;
      expect(Array.isArray(data.bindings)).toBe(true);
      w.destroy();
    });
  });

  describe('UIAnchor', () => {
    it('is defined with anchor field', async () => {
      const { UIAnchor } = await getUITraits();
      expect(UIAnchor).toBeDefined();
      const schema = (UIAnchor as any).schema;
      expect(schema.anchor).toBe('stretch');
      expect(schema.safeArea).toBe(true);
      expect(schema.zIndex).toBe(0);
    });
  });
});
