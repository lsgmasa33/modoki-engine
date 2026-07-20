/**
 * entityIndex (Animation Editor) — version-gated cache + clear/teardown (anim-editors F7),
 * plus resolvePathToEntityId path walking.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let entities: { id: number; name: string; parentId: number }[] = [];
let version = 0;

vi.mock('../../src/runtime/ecs/entityUtils', () => ({
  getAllEntities: () => entities,
  getStructureVersion: () => version,
}));

const { getAnimEntityIndex, clearAnimEntityIndex, resolvePathToEntityId } =
  await import('../../src/editor/animation/entityIndex');

beforeEach(() => {
  clearAnimEntityIndex();
  version = 0;
  entities = [
    { id: 1, name: 'Root', parentId: 0 },
    { id: 2, name: 'Arm', parentId: 1 },
    { id: 3, name: 'Hand', parentId: 2 },
  ];
});

describe('getAnimEntityIndex', () => {
  it('builds byId + childrenByParent and reuses the cache at the same structure version', () => {
    const a = getAnimEntityIndex();
    expect(a.byId.get(3)).toMatchObject({ id: 3, name: 'Hand', parentId: 2 });
    expect(a.childrenByParent.get(1)?.get('Arm')).toBe(2);
    expect(getAnimEntityIndex()).toBe(a); // same version → same cached object
  });

  it('rebuilds when the structure version changes', () => {
    const a = getAnimEntityIndex();
    version = 1;
    const b = getAnimEntityIndex();
    expect(b).not.toBe(a);
  });

  it('clearAnimEntityIndex forces a rebuild even at the same version', () => {
    const a = getAnimEntityIndex();
    clearAnimEntityIndex();
    const b = getAnimEntityIndex();
    expect(b).not.toBe(a); // stale index not served after teardown
  });
});

describe('resolvePathToEntityId', () => {
  it('resolves a relative name-path, the empty path (root), and a missing segment', () => {
    const idx = getAnimEntityIndex();
    expect(resolvePathToEntityId(idx, 1, '')).toBe(1);
    expect(resolvePathToEntityId(idx, 1, 'Arm/Hand')).toBe(3);
    expect(resolvePathToEntityId(idx, 1, 'Arm/Nope')).toBeNull();
  });
});
