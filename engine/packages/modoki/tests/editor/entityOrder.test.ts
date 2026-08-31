/** Unit tests for `orderEntitiesForSave` — the pure rule shared by `serializeScene`,
 *  `buildEntityTree`, and the `sceneEntityOrder` guard test (QA-HIER-0002). */

import { describe, it, expect } from 'vitest';
import { orderEntitiesForSave } from '../../src/runtime/core/ecs/entityOrder';

interface Row {
  key: string;
  parentKey: string | null;
  sortOrder: number;
  name: string;
  guid: string;
}

const adapt = (r: Row) => r;

const names = (rows: Row[]) => rows.map((r) => r.name);

describe('orderEntitiesForSave', () => {
  it('orders siblings by sortOrder ascending', () => {
    const rows: Row[] = [
      { key: 'a', parentKey: null, sortOrder: 30, name: 'Third', guid: 'g-3' },
      { key: 'b', parentKey: null, sortOrder: 10, name: 'First', guid: 'g-1' },
      { key: 'c', parentKey: null, sortOrder: 20, name: 'Second', guid: 'g-2' },
    ];
    expect(names(orderEntitiesForSave(rows, adapt))).toEqual(['First', 'Second', 'Third']);
  });

  it('breaks an equal-sortOrder tie on guid, lexicographically', () => {
    const rows: Row[] = [
      { key: 'a', parentKey: null, sortOrder: 0, name: 'Zed', guid: 'g-z' },
      { key: 'b', parentKey: null, sortOrder: 0, name: 'Mid', guid: 'g-m' },
      { key: 'c', parentKey: null, sortOrder: 0, name: 'Ann', guid: 'g-a' },
    ];
    expect(names(orderEntitiesForSave(rows, adapt))).toEqual(['Ann', 'Mid', 'Zed']);
  });

  it('breaks an equal-sortOrder AND equal-guid tie on name', () => {
    const rows: Row[] = [
      { key: 'a', parentKey: null, sortOrder: 0, name: 'Zed', guid: 'g-x' },
      { key: 'b', parentKey: null, sortOrder: 0, name: 'Ann', guid: 'g-x' },
      { key: 'c', parentKey: null, sortOrder: 0, name: 'Mid', guid: 'g-x' },
    ];
    expect(names(orderEntitiesForSave(rows, adapt))).toEqual(['Ann', 'Mid', 'Zed']);
  });

  it('emits a parent immediately before its subtree, depth-first, multi-level', () => {
    const rows: Row[] = [
      { key: 'gc', parentKey: 'c', sortOrder: 0, name: 'Grandchild', guid: 'g-gc' },
      { key: 'a', parentKey: null, sortOrder: 10, name: 'A', guid: 'g-a' },
      { key: 'b', parentKey: null, sortOrder: 20, name: 'B', guid: 'g-b' },
      { key: 'c', parentKey: 'a', sortOrder: 0, name: 'Child', guid: 'g-c' },
      { key: 'bc', parentKey: 'b', sortOrder: 0, name: 'B-child', guid: 'g-bc' },
    ];
    expect(names(orderEntitiesForSave(rows, adapt))).toEqual([
      'A', 'Child', 'Grandchild', 'B', 'B-child',
    ]);
  });

  it('treats an entity whose parentKey is not in the set as a root', () => {
    const rows: Row[] = [
      { key: 'a', parentKey: 'missing', sortOrder: 10, name: 'Orphan', guid: 'g-a' },
      { key: 'b', parentKey: null, sortOrder: 20, name: 'Real Root', guid: 'g-b' },
    ];
    expect(names(orderEntitiesForSave(rows, adapt))).toEqual(['Orphan', 'Real Root']);
  });

  it('does not drop entities caught in a parent cycle (a -> b -> a)', () => {
    const rows: Row[] = [
      { key: 'a', parentKey: 'b', sortOrder: 0, name: 'A', guid: 'g-a' },
      { key: 'b', parentKey: 'a', sortOrder: 0, name: 'B', guid: 'g-b' },
      { key: 'c', parentKey: null, sortOrder: 0, name: 'C', guid: 'g-c' },
    ];
    const out = orderEntitiesForSave(rows, adapt);
    expect(out.length).toBe(rows.length);
    expect(new Set(out.map((r) => r.key))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('does not mutate the input array', () => {
    const rows: Row[] = [
      { key: 'a', parentKey: null, sortOrder: 30, name: 'Third', guid: 'g-3' },
      { key: 'b', parentKey: null, sortOrder: 10, name: 'First', guid: 'g-1' },
    ];
    const snapshot = [...rows];
    orderEntitiesForSave(rows, adapt);
    expect(rows).toEqual(snapshot);
    expect(rows[0].name).toBe('Third');
  });

  it('is stable: reordering the input and running again gives the same output', () => {
    const rows: Row[] = [
      { key: 'a', parentKey: null, sortOrder: 10, name: 'A', guid: 'g-a' },
      { key: 'b', parentKey: 'a', sortOrder: 0, name: 'A-child', guid: 'g-ac' },
      { key: 'c', parentKey: null, sortOrder: 20, name: 'B', guid: 'g-b' },
      { key: 'd', parentKey: 'c', sortOrder: 0, name: 'B-child', guid: 'g-bc' },
    ];
    const first = names(orderEntitiesForSave(rows, adapt));

    const shuffled = [rows[3], rows[1], rows[0], rows[2]];
    const second = names(orderEntitiesForSave(shuffled, adapt));

    expect(second).toEqual(first);
  });
});
