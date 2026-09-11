/**
 * `prefabInstances` — what a placed prefab instance carries, member by member (#1060).
 *
 * ⚠️ **Every case builds at least TWO documents**, because the defect lives in the gap between a
 * prefab and its placement: a suite with one document cannot tell a composed read from a root read,
 * which is exactly the blind spot this module exists to close.
 */

import { describe, expect, it } from 'vitest';
import { prefabInstances, prefabLookup, type InstanceMember } from './prefabInstances';

const CLICK = { bindings: [{ event: 'click' }] };
const BTN = { width: 48, widthUnit: 'px', height: 48, heightUnit: 'px' };

const TILE = {
  id: 'tile', rootLocalId: 1,
  entities: [
    { localId: 1, traits: { EntityAttributes: { name: 'Tile', parentId: 0 }, UIElement: BTN, UIAction: CLICK } },
    { localId: 2, traits: { EntityAttributes: { name: 'Face', parentId: 1 }, UIElement: { width: 80, height: 80 } } },
    { localId: 3, traits: { EntityAttributes: { name: 'Num', parentId: 2 }, UIElement: { width: 50, height: 50 } } },
  ],
};

const pageOf = (...rows: object[]) => ({
  id: 'page', rootLocalId: 1,
  entities: [{ localId: 1, traits: { EntityAttributes: { name: 'Grid', parentId: 0 }, UIElement: {} } }, ...rows],
});
const placeTile = (localId: number, extra: object) =>
  ({ localId, prefab: 'tile', traits: { EntityAttributes: { name: `Row${localId}`, parentId: 1 } }, ...extra });
const at = (members: InstanceMember[], path: string, localId: number) =>
  members.find((m) => m.path.join('.') === path && m.localId === localId);

describe('composing one placement', () => {
  it('folds the row\'s overrides onto the child root, while `standalone` is the prefab file as read', () => {
    const page = pageOf(placeTile(2, { overrides: { 1: { EntityAttributes: { name: 'Tile0' }, UIElement: { width: 20 } } } }));
    const [inst] = prefabInstances(page, prefabLookup([page, TILE]));
    expect(inst.name, 'the runtime name is the override on the child root, not the row name').toBe('Tile0');
    expect(inst.ref).toBe('tile');
    expect(inst.root.effective!.UIElement).toEqual({ ...BTN, width: 20 });
    expect(inst.root.standalone!.UIElement, 'what a root-reading guard sees').toEqual(BTN);
    expect(inst.members.map((m) => m.localId), 'every member, root first').toEqual([1, 2, 3]);
    expect(inst.members[1].effective, 'Face is untouched by this placement').toEqual(inst.members[1].standalone);
  });

  it('a name-only placement composes to the prefab\'s own sizes — every pooled cell renames its root', () => {
    const page = pageOf(placeTile(2, { overrides: { 1: { EntityAttributes: { name: 'Tile0', sortOrder: 0 } } } }));
    const [inst] = prefabInstances(page, prefabLookup([page, TILE]));
    expect(inst.root.effective!.UIElement).toEqual(inst.root.standalone!.UIElement);
    expect((inst.root.effective!.EntityAttributes as { name: string }).name).toBe('Tile0');
  });

  it('reaches a NON-root member the row overrides, and addresses each member\'s parent', () => {
    const page = pageOf(placeTile(2, { overrides: { 2: { UIElement: { width: 10 } } } }));
    const [inst] = prefabInstances(page, prefabLookup([page, TILE]));
    const face = at(inst.members, '', 2)!;
    expect(face.effective!.UIElement).toEqual({ width: 10, height: 80 });
    expect(face.parent).toEqual({ path: [], localId: 1 });
    expect(at(inst.members, '', 3)!.parent).toEqual({ path: [], localId: 2 });
    expect(inst.root.parent, 'the placed root\'s parent is the ROW\'s, outside the instance').toBeUndefined();
  });

  it('applies removedTraits', () => {
    const page = pageOf(placeTile(2, { removedTraits: { 1: ['UIAction'] } }));
    const [inst] = prefabInstances(page, prefabLookup([page, TILE]));
    expect(inst.root.effective!.UIAction).toBeUndefined();
    expect(inst.root.standalone!.UIAction).toEqual(CLICK);
  });
});

describe('a nested placement', () => {
  // `row` places the tile at its row 2; the page places `row` and reaches the tile's Face THROUGH it.
  const ROW = {
    id: 'row', rootLocalId: 1,
    entities: [
      { localId: 1, traits: { EntityAttributes: { name: 'Row', parentId: 0 }, UIElement: {} } },
      { localId: 2, prefab: 'tile', traits: { EntityAttributes: { name: 'Inner', parentId: 1 } },
        overrides: { 1: { EntityAttributes: { name: 'Inner' } }, 2: { EntityAttributes: { name: 'RowFace' } } } },
    ],
  };
  const placeRow = (extra: object = {}) =>
    pageOf({ localId: 2, prefab: 'row', traits: { EntityAttributes: { name: 'R', parentId: 1 } }, ...extra });

  it('threads nestedOverrides into the child\'s own instance, the way the spawner does', () => {
    const page = placeRow({ nestedOverrides: { 2: { 2: { UIElement: { width: 5 } } } } });
    const [inst] = prefabInstances(page, prefabLookup([page, ROW, TILE]));
    const deepFace = at(inst.members, '2', 2)!;
    expect(deepFace, 'the tile\'s Face, one nesting level down, is enumerated').toBeDefined();
    expect(deepFace.effective!.UIElement).toEqual({ width: 5, height: 80 });
    expect(deepFace.standalone!.UIElement, 'standalone = the row prefab read on its own').toEqual({ width: 80, height: 80 });

    // `standalone` carries the PLACING prefab's own rename — it is that prefab's copy, not the tile's.
    const nameOf = (t: Record<string, unknown> | null) => (t?.EntityAttributes as { name?: string } | undefined)?.name;
    expect(nameOf(deepFace.standalone)).toBe('RowFace');
  });

  it('lists the nested ROOT once, one level up, and addresses members parented to it THERE', () => {
    // ⚠️ The case the close-out review caught: the nested root is skipped at its own depth, so a
    // parent address of `('2', 1)` names nothing and an ancestor walk silently comes back empty.
    const page = placeRow();
    const [inst] = prefabInstances(page, prefabLookup([page, ROW, TILE]));
    const innerRoots = inst.members.filter((m) => (m.effective?.EntityAttributes as { name?: string })?.name === 'Inner');
    expect(innerRoots.map((m) => [m.path.join('.'), m.localId])).toEqual([['', 2]]);
    expect(at(inst.members, '2', 1), 'not listed again at its own depth').toBeUndefined();

    const deepFace = at(inst.members, '2', 2)!;
    expect(deepFace.parent, 'parented to the nested root → the placing row').toEqual({ path: [], localId: 2 });
    expect(at(inst.members, deepFace.parent!.path.join('.'), deepFace.parent!.localId)).toBe(innerRoots[0]);
    expect(at(inst.members, '2', 3)!.parent, 'a deeper member stays at its own depth').toEqual({ path: [2], localId: 2 });
    expect(innerRoots[0].parent).toEqual({ path: [], localId: 1 });
  });

  it('agrees with the row prefab measured on its own — the induction the corpus relies on', () => {
    // A member left identical by the outer placement is covered wherever the inner document is
    // measured; that only holds if `standalone` here equals `effective` there.
    const page = placeRow();
    const lookup = prefabLookup([page, ROW, TILE]);
    const outer = at(prefabInstances(page, lookup)[0].members, '2', 2)!;
    const inner = at(prefabInstances(ROW, lookup)[0].members, '', 2)!;
    expect(outer.standalone).toEqual(inner.effective);
  });
});

describe('what it refuses to guess', () => {
  it('yields no instance for a child that does not resolve', () => {
    const page = pageOf(placeTile(2, {}));
    expect(prefabInstances(page, prefabLookup([page]))).toEqual([]);
  });

  it('terminates on a prefab that places itself', () => {
    const cyc = {
      id: 'cyc', rootLocalId: 1,
      entities: [
        { localId: 1, traits: { EntityAttributes: { name: 'C', parentId: 0 }, UIElement: BTN } },
        { localId: 2, prefab: 'cyc', traits: { EntityAttributes: { parentId: 1 } } },
      ],
    };
    const page = pageOf({ localId: 2, prefab: 'cyc', traits: { EntityAttributes: { parentId: 1 } } });
    const [inst] = prefabInstances(page, prefabLookup([page, cyc]));
    expect(inst.members.length).toBeLessThan(10);
    expect(at(inst.members, '', 2)!.effective, 'the self-placement spawns nothing').toBeNull();
  });
});
