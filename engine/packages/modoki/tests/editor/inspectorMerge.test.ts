/** readMergedTraits / sameTraitResult — multi-select trait intersection +
 *  mixed-field computation that powers the Inspector's multi-entity mode. */

import { describe, it, expect, vi } from 'vitest';

type FakeTrait = { name: string; category: 'component' | 'tag' | 'resource' };

// Each entity is a map of traitName -> field data (tags map to {}).
const entities = new Map<number, Map<FakeTrait, Record<string, unknown>>>();

function setEntity(id: number, traits: { meta: FakeTrait; data: Record<string, unknown> }[]) {
  entities.set(id, new Map(traits.map((t) => [t.meta, t.data])));
}

vi.mock('../../src/runtime/ecs/entityUtils', () => ({
  getEntityTraits: (id: number) => [...(entities.get(id)?.keys() ?? [])],
  readTraitData: (id: number, meta: FakeTrait) => entities.get(id)?.get(meta) ?? null,
}));

const { readMergedTraits, sameTraitResult } = await import('../../src/editor/panels/inspectorMerge');

// Shared trait metas (object identity matters — the merge keys by name but the
// snapshot diff compares meta references).
const Transform: FakeTrait = { name: 'Transform', category: 'component' };
const Health: FakeTrait = { name: 'Health', category: 'component' };
const Light: FakeTrait = { name: 'Light', category: 'component' };
const EA: FakeTrait = { name: 'EntityAttributes', category: 'component' };

describe('readMergedTraits — single select', () => {
  it('returns each trait verbatim with no mixed/nonShared', () => {
    setEntity(1, [{ meta: Transform, data: { x: 1, y: 2 } }]);
    const { result, nonShared } = readMergedTraits([1]);
    expect(result).toHaveLength(1);
    expect(result[0].data).toEqual({ x: 1, y: 2 });
    expect(result[0].mixed).toBeUndefined();
    expect(nonShared).toEqual([]);
  });
});

describe('readMergedTraits — multi select', () => {
  it('keeps only traits common to ALL entities', () => {
    setEntity(1, [{ meta: Transform, data: { x: 1 } }, { meta: Health, data: { hp: 10 } }]);
    setEntity(2, [{ meta: Transform, data: { x: 1 } }, { meta: Light, data: { intensity: 1 } }]);

    const { result, nonShared } = readMergedTraits([1, 2]);
    expect(result.map((r) => r.meta.name)).toEqual(['Transform']);
    // Health (on 1) and Light (on 2) are present on some-but-not-all.
    expect(nonShared).toEqual(['Health', 'Light']);
  });

  it('marks differing fields as mixed and shares identical ones', () => {
    setEntity(1, [{ meta: Transform, data: { x: 1, y: 5, z: 9 } }]);
    setEntity(2, [{ meta: Transform, data: { x: 2, y: 5, z: 9 } }]);
    setEntity(3, [{ meta: Transform, data: { x: 3, y: 5, z: 8 } }]);

    const { result } = readMergedTraits([1, 2, 3]);
    const tf = result.find((r) => r.meta.name === 'Transform')!;
    expect(tf.mixed).toBeDefined();
    expect([...tf.mixed!].sort()).toEqual(['x', 'z']); // y is identical across all
    // Representative value comes from the first entity.
    expect(tf.data!.x).toBe(1);
    expect(tf.data!.y).toBe(5);
  });

  it('no mixed set when every field matches', () => {
    setEntity(1, [{ meta: Transform, data: { x: 4, y: 4 } }]);
    setEntity(2, [{ meta: Transform, data: { x: 4, y: 4 } }]);
    const { result } = readMergedTraits([1, 2]);
    expect(result[0].mixed).toBeUndefined();
  });

  it('excludes EntityAttributes from the nonShared note', () => {
    setEntity(1, [{ meta: Transform, data: { x: 1 } }, { meta: EA, data: { name: 'a' } }]);
    setEntity(2, [{ meta: Transform, data: { x: 1 } }]); // no EA
    const { nonShared } = readMergedTraits([1, 2]);
    expect(nonShared).toEqual([]); // EA omitted even though not shared
  });

  it('notes a TAG present on some-but-not-all entities', () => {
    const Paused: FakeTrait = { name: 'Paused', category: 'tag' };
    setEntity(1, [{ meta: Transform, data: { x: 1 } }, { meta: Paused, data: {} }]);
    setEntity(2, [{ meta: Transform, data: { x: 1 } }]); // no Paused tag
    const { result, nonShared } = readMergedTraits([1, 2]);
    // Not rendered (not common to all) but surfaced in the note so it's not invisible.
    expect(result.map((r) => r.meta.name)).toEqual(['Transform']);
    expect(nonShared).toEqual(['Paused']);
  });
});

describe('sameTraitResult', () => {
  const mk = (x: number, mixed?: string[]) => [{
    meta: Transform as any, data: { x }, mixed: mixed ? new Set(mixed) : undefined,
  }];

  it('true for identical data + mixed', () => {
    expect(sameTraitResult(mk(1, ['x']), mk(1, ['x']))).toBe(true);
  });
  it('false when a value differs', () => {
    expect(sameTraitResult(mk(1), mk(2))).toBe(false);
  });
  it('false when the mixed set flips even if value is stable', () => {
    expect(sameTraitResult(mk(1, ['x']), mk(1))).toBe(false);
  });
  it('false on length mismatch', () => {
    expect(sameTraitResult(mk(1), [])).toBe(false);
  });
});
