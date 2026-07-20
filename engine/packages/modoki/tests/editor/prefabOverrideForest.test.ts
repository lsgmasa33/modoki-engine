/** prefabOverrideForest — nest the Apply/Revert dialog override list by ECS parent.
 *
 *  Guards the "child rendered as a sibling" bug: e.g. Plane173 (parentId=Island)
 *  appeared flat next to Island because the dialog ignored parentage. */

import { describe, it, expect } from 'vitest';
import { buildOverrideForest } from '../../src/editor/panels/prefabOverrideForest';

type N = { ecsId: number; parentEcsId: number; name: string };
const e = (ecsId: number, parentEcsId: number, name: string): N => ({ ecsId, parentEcsId, name });

describe('buildOverrideForest', () => {
  it('nests a child under its parent (the Island / Plane173 case)', () => {
    const forest = buildOverrideForest([
      e(21, 0, 'Island'),
      e(23, 21, 'Plane173'),
    ]);
    expect(forest).toHaveLength(1);
    expect(forest[0].node.name).toBe('Island');
    expect(forest[0].depth).toBe(0);
    expect(forest[0].children).toHaveLength(1);
    expect(forest[0].children[0].node.name).toBe('Plane173');
    expect(forest[0].children[0].depth).toBe(1);
  });

  it('groups many children under one parent, preserving input (localId) order', () => {
    const forest = buildOverrideForest([
      e(21, 0, 'Island'),
      e(23, 21, 'Plane173'),
      e(24, 21, 'Water'),
      e(25, 21, 'Sand'),
    ]);
    expect(forest).toHaveLength(1);
    expect(forest[0].children.map((c) => c.node.name)).toEqual(['Plane173', 'Water', 'Sand']);
    expect(forest[0].children.every((c) => c.depth === 1)).toBe(true);
  });

  it('handles 3 levels deep with correct depth', () => {
    const forest = buildOverrideForest([
      e(1, 0, 'root'),
      e(2, 1, 'child'),
      e(3, 2, 'grandchild'),
    ]);
    expect(forest[0].children[0].children[0].node.name).toBe('grandchild');
    expect(forest[0].children[0].children[0].depth).toBe(2);
  });

  it('promotes an orphan (parent absent from the list) to a root', () => {
    // Island has no overrides → not in the list; its child still shows, as a root.
    const forest = buildOverrideForest([
      e(23, 21, 'Plane173'),
      e(24, 21, 'Water'),
    ]);
    expect(forest.map((f) => f.node.name)).toEqual(['Plane173', 'Water']);
    expect(forest.every((f) => f.depth === 0)).toBe(true);
  });

  it('keeps multiple roots flat and in order', () => {
    const forest = buildOverrideForest([e(1, 0, 'a'), e(2, 0, 'b'), e(3, 0, 'c')]);
    expect(forest.map((f) => f.node.name)).toEqual(['a', 'b', 'c']);
  });

  it('never drops a row on a self-parent or a parent cycle', () => {
    const self = buildOverrideForest([e(1, 1, 'self')]);
    expect(self).toHaveLength(1);
    expect(self[0].node.name).toBe('self');

    const cycle = buildOverrideForest([e(1, 2, 'a'), e(2, 1, 'b')]);
    const names = new Set<string>();
    const walk = (f: { node: N; children: { node: N; children: unknown[] }[] }) => {
      names.add(f.node.name);
      f.children.forEach((c) => walk(c as never));
    };
    cycle.forEach((f) => walk(f as never));
    expect(names).toEqual(new Set(['a', 'b'])); // both surface, exactly once each
  });
});
