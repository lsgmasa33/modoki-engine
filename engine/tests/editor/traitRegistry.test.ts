/** Tests for the trait registry — the foundation of the decoupled editor. */

import { describe, it, expect } from 'vitest';
import { trait } from 'koota';
import {
  registerTrait, getTraitMeta, getTraitByName, getAllTraits, inferFields,
} from '@modoki/engine/runtime';

// Create test traits (not the real game traits)
const TestPosition = trait({ x: 0, y: 0, z: 0 });
const TestHealth = trait({ hp: 100, maxHp: 100, shield: false });
const TestTag = trait();

describe('traitRegistry', () => {
  // Note: registry is a module-level singleton, so registrations persist across tests.
  // We register once and test the accumulated state.

  it('registers a component trait and retrieves by trait object', () => {
    registerTrait({
      name: 'TestPosition', trait: TestPosition, category: 'component',
      fields: {
        x: { type: 'number', step: 0.1 },
        y: { type: 'number', step: 0.1 },
        z: { type: 'number', step: 0.1 },
      },
    });

    const meta = getTraitMeta(TestPosition);
    expect(meta).toBeDefined();
    expect(meta!.name).toBe('TestPosition');
    expect(meta!.category).toBe('component');
    expect(Object.keys(meta!.fields)).toEqual(['x', 'y', 'z']);
  });

  it('retrieves by name', () => {
    const meta = getTraitByName('TestPosition');
    expect(meta).toBeDefined();
    expect(meta!.trait).toBe(TestPosition);
  });

  it('registers a tag trait', () => {
    registerTrait({
      name: 'TestTag', trait: TestTag, category: 'tag', fields: {},
    });

    const meta = getTraitMeta(TestTag);
    expect(meta!.category).toBe('tag');
    expect(Object.keys(meta!.fields)).toHaveLength(0);
  });

  it('registers a resource trait with readOnly fields', () => {
    registerTrait({
      name: 'TestHealth', trait: TestHealth, category: 'resource',
      fields: {
        hp: { type: 'number', readOnly: true },
        maxHp: { type: 'number', readOnly: true },
        shield: { type: 'boolean' },
      },
    });

    const meta = getTraitByName('TestHealth');
    expect(meta!.fields['hp'].readOnly).toBe(true);
    expect(meta!.fields['shield'].type).toBe('boolean');
  });

  it('getAllTraits returns all registered traits', () => {
    const all = getAllTraits();
    const names = all.map((t) => t.name);
    expect(names).toContain('TestPosition');
    expect(names).toContain('TestTag');
    expect(names).toContain('TestHealth');
  });

  it('getTraitByName returns undefined for unknown name', () => {
    expect(getTraitByName('NonExistent')).toBeUndefined();
  });

  it('getTraitMeta returns undefined for unregistered trait', () => {
    const Unknown = trait({ foo: 0 });
    expect(getTraitMeta(Unknown)).toBeUndefined();
  });
});

describe('inferFields', () => {
  it('infers number fields from schema defaults', () => {
    const fields = inferFields(TestPosition);
    expect(fields['x']).toEqual({ type: 'number', step: 0.1 });
    expect(fields['y']).toEqual({ type: 'number', step: 0.1 });
    expect(fields['z']).toEqual({ type: 'number', step: 0.1 });
  });

  it('infers boolean fields', () => {
    const fields = inferFields(TestHealth);
    expect(fields['shield']).toEqual({ type: 'boolean' });
    expect(fields['hp']).toEqual({ type: 'number', step: 0.1 });
  });

  it('infers string fields', () => {
    const StringTrait = trait({ name: '', label: 'hello' });
    const fields = inferFields(StringTrait);
    expect(fields['name']).toEqual({ type: 'string' });
    expect(fields['label']).toEqual({ type: 'string' });
  });

  it('returns empty for tag trait (no schema)', () => {
    const fields = inferFields(TestTag);
    expect(Object.keys(fields)).toHaveLength(0);
  });
});
