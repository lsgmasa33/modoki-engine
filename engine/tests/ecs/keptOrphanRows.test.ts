/** R2's kept-orphan store follows a guid rename (#1778, `rekeyKeptOrphanRows`, called by `applyGuidRemap`). The caller
 *  cases are in `tests/editor/createPrefabMemberIdentity.test.ts`; this pins the two remap shapes they do not reach. */
import { describe, it, expect, afterEach } from 'vitest';
import { keptOrphanRowsOf, setKeptOrphanRows, rekeyKeptOrphanRows, clearKeptOrphanRows } from '../../packages/modoki/src/runtime/core/ecs/keptOrphanRows';

afterEach(() => clearKeptOrphanRows());

describe('rekeyKeptOrphanRows', () => {
  /** Mutation: move each entry to its new key inside the first loop (no take-out pass) — `a`'s rows land on `b` and are
   *  then taken out again as `b`'s, so one set ends up lost: red. */
  it('a remap that SWAPS two guids swaps their rows — neither set is lost', () => {
    setKeptOrphanRows('a', { '/x': { name: 'A' } });
    setKeptOrphanRows('b', { '/y': { name: 'B' } });
    rekeyKeptOrphanRows(new Map([['a', 'b'], ['b', 'a']]));
    expect(keptOrphanRowsOf('a')).toEqual({ '/y': { name: 'B' } });
    expect(keptOrphanRowsOf('b')).toEqual({ '/x': { name: 'A' } });
  });

  it('a guid the remap does not name keeps its rows, and an unkept guid in the remap creates none', () => {
    setKeptOrphanRows('c', { '/z': { name: 'C' } });
    rekeyKeptOrphanRows(new Map([['d', 'e']]));
    expect(keptOrphanRowsOf('c')).toEqual({ '/z': { name: 'C' } });
    expect(keptOrphanRowsOf('e')).toBeUndefined();
  });
});

/** Review finding 6: the rows name entities by guid too (a moved member's `parent`, a restated trait's ref), and
 *  `remapWorldGuidRefs` reaches live trait values only. Mutation: skip the value pass — the parent keeps the old guid. */
describe('rekeyKeptOrphanRows renames the guids INSIDE the kept rows', () => {
  it('a kept row whose parent was renamed names the new guid', () => {
    setKeptOrphanRows('root', { '/x': { name: 'Gone', parent: 'old-parent', traits: { UIAction: { bindings: [{ target: 'old-parent' }] } } } });
    rekeyKeptOrphanRows(new Map([['old-parent', 'new-parent']]));
    expect(keptOrphanRowsOf('root')).toEqual({ '/x': { name: 'Gone', parent: 'new-parent', traits: { UIAction: { bindings: [{ target: 'new-parent' }] } } } });
  });
});
