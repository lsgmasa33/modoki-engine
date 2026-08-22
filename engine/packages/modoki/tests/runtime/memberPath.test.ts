import { describe, it, expect } from 'vitest';
import { splitMemberPath, resolveMemberPathIn } from '../../src/runtime/core/ecs/memberPath';

type Index = Map<number, { id: number; name: string }[]>;
const idx = (rows: Record<number, [number, string][]>): Index => {
  const m: Index = new Map();
  for (const [parent, kids] of Object.entries(rows)) m.set(Number(parent), kids.map(([id, name]) => ({ id, name })));
  return m;
};

// Court's real shape: a PAGE entry holds 25 nested `level-tile` instances, and each tile
// carries THREE state faces that each contain their own `Num`. Modelled from
// games/court/runtime/assets/prefabs/level-tile.prefab.json (localIds 3, 6, 8 are all 'Num').
const courtPage = idx({
  1: [[10, 'Tile0'], [11, 'Tile1']],
  11: [[20, 'Solved'], [21, 'Now'], [22, 'Locked']],
  20: [[30, 'Num'], [33, 'Mark']],
  21: [[31, 'Num']],
  22: [[32, 'Num']],
});

describe('splitMemberPath', () => {
  it('treats the empty path as the entry root — no segments', () => {
    expect(splitMemberPath('')).toEqual([]);
  });
  it('tolerates stray separators rather than producing empty segments', () => {
    expect(splitMemberPath('/Tile3//Num/')).toEqual(['Tile3', 'Num']);
  });
});

describe('resolveMemberPathIn', () => {
  it('resolves the entry root itself for the empty path', () => {
    expect(resolveMemberPathIn(courtPage, 1, '')).toEqual({ id: 1 });
  });

  it('crosses a nested prefab-instance boundary — the thing rootInstanceId cannot do', () => {
    // Tile1 is a nested instance inside the page; its members carry the TILE's
    // rootInstanceId, not the page's, so a flat scan would miss this entirely.
    expect(resolveMemberPathIn(courtPage, 1, 'Tile1/Solved/Num')).toEqual({ id: 30 });
  });

  it('REFUSES an ambiguous path instead of picking the first match', () => {
    // 'Tile1/Num' does not exist at that level, but the realistic trap is a path that
    // names several siblings. Three faces each hold a `Num`, so a leaf-name match would
    // have hit three entities.
    const ambiguous = idx({ 1: [[2, 'Num'], [3, 'Num']] });
    expect(resolveMemberPathIn(ambiguous, 1, 'Num')).toEqual({ id: 0, failure: 'ambiguous', at: 'Num' });
  });

  it('reports WHERE a path failed, not just that it did', () => {
    expect(resolveMemberPathIn(courtPage, 1, 'Tile1/Missing/Num'))
      .toEqual({ id: 0, failure: 'not-found', at: 'Tile1/Missing' });
  });

  it('does not escape the entry — a sibling of the root is unreachable', () => {
    // Tile0 is a child of the page (1); starting from Tile1 (11) it must not resolve.
    expect(resolveMemberPathIn(courtPage, 11, 'Tile0').id).toBe(0);
  });

  it('fails on a leaf with no children rather than throwing', () => {
    expect(resolveMemberPathIn(courtPage, 1, 'Tile1/Solved/Num/Deeper'))
      .toEqual({ id: 0, failure: 'not-found', at: 'Tile1/Solved/Num/Deeper' });
  });
});
