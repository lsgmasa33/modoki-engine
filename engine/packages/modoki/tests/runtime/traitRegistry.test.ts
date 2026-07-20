/** traitRegistry unit tests — registration, lookup, nameTransform, inferFields. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';

async function getRegistry() {
  return import('../../../src/runtime/ecs/traitRegistry');
}

beforeEach(() => {
  vi.resetModules();
});

describe('traitRegistry', () => {
  describe('registerTrait / getAllTraits', () => {
    it('registers a trait and retrieves it', async () => {
      const { registerTrait, getAllTraits, getTraitByName } = await getRegistry();

      const TestTrait = trait({ x: 0, y: 0 });
      registerTrait({
        name: 'TestTrait',
        trait: TestTrait,
        category: 'component',
        fields: { x: { type: 'number' }, y: { type: 'number' } },
      });

      const all = getAllTraits();
      expect(all.some((m) => m.name === 'TestTrait')).toBe(true);

      const byName = getTraitByName('TestTrait');
      expect(byName?.trait).toBe(TestTrait);
    });

    it('getTraitMeta returns metadata for a registered trait', async () => {
      const { registerTrait, getTraitMeta, getTraitByName } = await getRegistry();

      const TestTrait = trait({ value: 0 });
      const meta = { name: 'TestTrait', trait: TestTrait, category: 'resource', fields: { value: { type: 'number' } } };
      registerTrait(meta);

      expect(getTraitMeta(TestTrait)).toBe(meta);
      expect(getTraitByName('TestTrait')).toBe(meta);
    });

    it('getTraitByName returns undefined for unknown name', async () => {
      const { getTraitByName } = await getRegistry();

      expect(getTraitByName('nonexistent')).toBeUndefined();
    });

    it('re-registering the same NAME with a new Trait object evicts the stale one (no duplicate metas)', async () => {
      const { registerTrait, getAllTraits, getTraitByName, getTraitMeta } = await getRegistry();

      // First registration (mirrors the original module load).
      const First = trait({ x: 0 });
      registerTrait({ name: 'Dup', trait: First, category: 'component', fields: { x: { type: 'number' } } });
      // Re-registration after a (hypothetical) script hot-reload: a NEW koota Trait
      // object, same name — the registry is keyed by Trait OBJECT, so without
      // eviction getAllTraits() would return TWO 'Dup' metas (one orphaned).
      const Second = trait({ x: 0, y: 0 });
      registerTrait({ name: 'Dup', trait: Second, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' } } });

      const dups = getAllTraits().filter((m) => m.name === 'Dup');
      expect(dups).toHaveLength(1);                 // stale object evicted
      expect(getTraitByName('Dup')?.trait).toBe(Second);
      expect(getTraitMeta(First)).toBeUndefined();  // old object no longer in the registry
      expect(getTraitMeta(Second)?.name).toBe('Dup');
    });
  });

  describe('nameTransform', () => {
    it('returns original name when no transform is set', async () => {
      const { transformName } = await getRegistry();

      expect(transformName('hello')).toBe('hello');
    });

    it('applies custom transform function', async () => {
      const { setNameTransform, transformName } = await getRegistry();

      setNameTransform((name) => name.toUpperCase());

      expect(transformName('hello')).toBe('HELLO');
    });
  });

  describe('inferFields', () => {
    it('infers number fields from schema', async () => {
      const { inferFields } = await getRegistry();

      const TestTrait = trait({ x: 0, y: 1.5 });
      const fields = inferFields(TestTrait);

      expect(fields.x.type).toBe('number');
      expect(fields.y.type).toBe('number');
    });

    it('infers string fields from schema', async () => {
      const { inferFields } = await getRegistry();

      const TestTrait = trait({ name: 'default' });
      const fields = inferFields(TestTrait);

      expect(fields.name.type).toBe('string');
    });

    it('infers boolean fields from schema', async () => {
      const { inferFields } = await getRegistry();

      const TestTrait = trait({ active: true });
      const fields = inferFields(TestTrait);

      expect(fields.active.type).toBe('boolean');
    });

    it('returns empty object for trait without schema', async () => {
      const { inferFields } = await getRegistry();

      // Create a mock trait without schema
      const MockTrait = {} as any;
      const fields = inferFields(MockTrait);

      expect(fields).toEqual({});
    });
  });
});
