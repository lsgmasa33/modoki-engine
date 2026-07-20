/** getOverrides unit tests — prefab field-level override detection. */

import { describe, it, expect } from 'vitest';

async function getModule() {
  return import('../../src/editor/scene/prefab');
}

function makePrefab(entities: { localId: number; traits: Record<string, Record<string, unknown> | boolean> }[]) {
  return { name: 'test', entities, rootLocalId: 1 };
}

describe('getOverrides', () => {
  it('returns empty set when fields match exactly', async () => {
    const { getOverrides } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: { Transform: { x: 5, y: 10, z: 0 } },
    }]);
    const current = { Transform: { x: 5, y: 10, z: 0 } };

    const overrides = getOverrides(1, current, prefab);
    expect(overrides.size).toBe(0);
  });

  it('detects changed numeric fields', async () => {
    const { getOverrides } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: { Transform: { x: 5, y: 10, z: 0 } },
    }]);
    const current = { Transform: { x: 99, y: 10, z: 0 } };

    const overrides = getOverrides(1, current, prefab);
    expect(overrides.has('Transform.x')).toBe(true);
    expect(overrides.has('Transform.y')).toBe(false);
  });

  it('detects changed string fields', async () => {
    const { getOverrides } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: { EntityAttributes: { name: 'Tree' } },
    }]);
    const current = { EntityAttributes: { name: 'ModifiedTree' } };

    const overrides = getOverrides(1, current, prefab);
    expect(overrides.has('EntityAttributes.name')).toBe(true);
  });

  it('uses float tolerance (1e-6) for numbers', async () => {
    const { getOverrides } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: { Transform: { x: 1.0000001, y: 5 } },
    }]);
    const current = { Transform: { x: 1.0000002, y: 5 } };

    const overrides = getOverrides(1, current, prefab);
    // Difference is 1e-7, below 1e-6 tolerance
    expect(overrides.has('Transform.x')).toBe(false);
  });

  it('detects changes beyond float tolerance', async () => {
    const { getOverrides } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: { Transform: { x: 1.0 } },
    }]);
    const current = { Transform: { x: 1.001 } };

    const overrides = getOverrides(1, current, prefab);
    expect(overrides.has('Transform.x')).toBe(true);
  });

  it('skips parentId field', async () => {
    const { getOverrides } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: { EntityAttributes: { name: 'Same', parentId: 0 } },
    }]);
    const current = { EntityAttributes: { name: 'Same', parentId: 999 } };

    const overrides = getOverrides(1, current, prefab);
    expect(overrides.has('EntityAttributes.parentId')).toBe(false);
  });

  it('skips PrefabInstance trait entirely', async () => {
    const { getOverrides } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: { Transform: { x: 0 } },
    }]);
    const current = {
      Transform: { x: 0 },
      PrefabInstance: { source: '/prefabs/tree.json', rootInstanceId: 42 },
    };

    const overrides = getOverrides(1, current, prefab);
    expect(overrides.size).toBe(0);
  });

  it('returns empty set when entity not found in prefab', async () => {
    const { getOverrides } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: { Transform: { x: 0 } },
    }]);
    const current = { Transform: { x: 99 } };

    const overrides = getOverrides(999, current, prefab);
    expect(overrides.size).toBe(0);
  });

  it('skips tag traits (boolean data) in prefab', async () => {
    const { getOverrides } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: { Transform: { x: 0 }, Paused: true },
    }]);
    const current = { Transform: { x: 0 }, Paused: {} };

    const overrides = getOverrides(1, current, prefab);
    // Paused is a tag (boolean) in prefab — skipped
    expect(overrides.size).toBe(0);
  });

  it('handles multiple traits with mixed changes', async () => {
    const { getOverrides } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: {
        Transform: { x: 1, y: 2, z: 3 },
        EntityAttributes: { name: 'Original', isActive: true },
      },
    }]);
    const current = {
      Transform: { x: 1, y: 999, z: 3 },        // y changed
      EntityAttributes: { name: 'Modified', isActive: true }, // name changed
    };

    const overrides = getOverrides(1, current, prefab);
    expect(overrides.size).toBe(2);
    expect(overrides.has('Transform.y')).toBe(true);
    expect(overrides.has('EntityAttributes.name')).toBe(true);
  });

  it('ignores fields not present in prefab source', async () => {
    const { getOverrides } = await getModule();
    const prefab = makePrefab([{
      localId: 1,
      traits: { Transform: { x: 0 } },
    }]);
    // Current has fields not in prefab — should not appear as overrides
    const current = { Transform: { x: 0, customField: 42 } };

    const overrides = getOverrides(1, current, prefab);
    expect(overrides.size).toBe(0);
  });
});
