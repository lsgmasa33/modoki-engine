/** The identity resolver (#1468 Phase 6) — where an entity's identity walk steps from, read from the prefab
 *  DOCUMENT its frame was expanded from rather than remembered on the entity (`PrefabInstance.homeParent` /
 *  `homeSteps`, deleted). Each rule on synthetic nodes, so a case the scene fixtures cannot build (two
 *  instances of one prefab inside one outermost instance) is still pinned. The integrated behaviour — moves
 *  saved, refs kept, duplicates and Apply — is `duplicateCarriesRefs.test.ts`'s; this file is the rules. */
import { describe, it, expect } from 'vitest';
import { createWorld, trait } from 'koota';
import {
  resolveIdentityParents, noteFrameDoc, frameDocReader, setRuntimeFrameDocFallback, frameDocRootCount,
  type IdentityNode, type TemplateDoc,
} from '../../packages/modoki/src/runtime/core/ecs/identityParents';

/** A document whose rows are `[localId, parentLocalId, prefab?]`; the root is row 1. */
const doc = (...rows: Array<[number, number, string?]>): TemplateDoc => ({
  rootLocalId: 1,
  entities: rows.map(([localId, parentId, prefab]) => ({ localId, ...(prefab ? { prefab } : {}), traits: { EntityAttributes: { parentId } } })),
});
const P = doc([1, 0], [2, 1], [3, 2], [4, 3]);          // Root > A(2) > B(3) > C(4)
const reader = (docs: Record<string, TemplateDoc>) => (source: string) => docs[source];

/** Instance of P at root id 10 under scene entity 1: A=12, B=13, C=14. */
const instance = (over: Partial<Record<number, Partial<IdentityNode>>> = {}): IdentityNode[] => {
  const base: IdentityNode[] = [
    { id: 1, parentId: 0, guid: 'scene', pi: null },
    { id: 10, parentId: 1, guid: 'root', pi: { source: 'P', localId: 1, rootInstanceId: 10 } },
    { id: 12, parentId: 10, guid: 'a', pi: { source: 'P', localId: 2, rootInstanceId: 10 } },
    { id: 13, parentId: 12, guid: 'b', pi: { source: 'P', localId: 3, rootInstanceId: 10 } },
    { id: 14, parentId: 13, guid: 'c', pi: { source: 'P', localId: 4, rootInstanceId: 10 } },
  ];
  return base.map((n) => ({ ...n, ...(over[n.id] ?? {}) })).filter((n) => !(over[n.id] as { gone?: boolean } | undefined)?.gone);
};
const gone = { gone: true } as unknown as Partial<IdentityNode>;

describe('identity parents — a linked member', () => {
  it('at its row: its live parent, not moved', () => {
    const r = resolveIdentityParents(instance(), reader({ P }));
    expect(r.of(14)).toEqual({ parentId: 13, extra: [] });
    expect(r.moved(14)).toBe(false);
  });

  it('moved inside its instance: the row parent it left, and it reads as moved', () => {
    const r = resolveIdentityParents(instance({ 14: { parentId: 10 } }), reader({ P }));
    expect(r.of(14)).toEqual({ parentId: 13, extra: [] });
    expect(r.moved(14)).toBe(true);
  });

  it('its row parent gone: the nearest row that stands, with the gone row as a step', () => {
    const r = resolveIdentityParents(instance({ 13: gone, 14: { parentId: 10 } }), reader({ P }));
    expect(r.of(14)).toEqual({ parentId: 12, extra: [3] });
    expect(r.moved(14)).toBe(true);
  });

  it('two gone rows in a row: both steps, outermost first', () => {
    const r = resolveIdentityParents(instance({ 12: gone, 13: gone, 14: { parentId: 10 } }), reader({ P }));
    expect(r.of(14)).toEqual({ parentId: 10, extra: [2, 3] });
  });

  it('a row parent UNPACKED — still there, no longer a member — is stepped past like a gone one', () => {
    const r = resolveIdentityParents(instance({ 13: { pi: null }, 14: { parentId: 10 } }), reader({ P }));
    expect(r.of(14)).toEqual({ parentId: 12, extra: [3] });
  });

  it('a row parent that belongs to ANOTHER instance of the same prefab is not this frame\'s', () => {
    // Instance 2 at root 20 has its own B (23); this instance's B is gone. Its member C must not walk from 23.
    const two: IdentityNode[] = [
      ...instance({ 13: gone, 14: { parentId: 23 } }),
      { id: 20, parentId: 1, guid: 'root2', pi: { source: 'P', localId: 1, rootInstanceId: 20 } },
      { id: 23, parentId: 20, guid: 'b2', pi: { source: 'P', localId: 3, rootInstanceId: 20 } },
    ];
    expect(resolveIdentityParents(two, reader({ P })).of(14)).toEqual({ parentId: 12, extra: [3] });
  });

  it('no document: its live parent — the answer a member with no home always got', () => {
    const r = resolveIdentityParents(instance({ 14: { parentId: 10 } }), reader({}));
    expect(r.of(14)).toEqual({ parentId: 10, extra: [] });
    expect(r.moved(14)).toBe(false);
  });
});

describe('identity parents — an orphan row', () => {
  const O = doc([1, 0], [2, 0], [3, 9]);                // A(2) has parent 0; B(3) names no row
  const orphans = (rootParent: number, owned = false): IdentityNode[] => [
    { id: 1, parentId: 0, guid: 'scene', pi: null },
    { id: 10, parentId: rootParent, guid: 'root', pi: { source: 'O', localId: 1, rootInstanceId: 10, ...(owned ? { parentLocalId: 5 } : {}) } },
    { id: 12, parentId: 99, guid: 'a', pi: { source: 'O', localId: 2, rootInstanceId: 10 } },
    { id: 13, parentId: 99, guid: 'b', pi: { source: 'O', localId: 3, rootInstanceId: 10 } },
  ];
  it('of a stored instance: under the instance\'s own parent, where the loader hangs it', () => {
    const r = resolveIdentityParents(orphans(1), reader({ O }));
    expect(r.parentOf(12)).toBe(1);
    expect(r.parentOf(13)).toBe(1);
  });
  it('of a nested instance: under nothing', () => {
    const r = resolveIdentityParents(orphans(1, true), reader({ O }));
    expect(r.parentOf(12)).toBe(0);
  });
});

describe('identity parents — an OWNED nested root and its owner link', () => {
  // OUTER: Root(1) > Slot(2) > nested row 3 (prefab N). Two instances of OUTER — X at 100, Y at 200 — each
  // with its own nested root (X's 103, Y's 203) under its own Slot (102, 202). The case R8 could not answer
  // from the document: every row and every document is shared, only the entity says whose it is.
  const OUTER = doc([1, 0], [2, 1], [3, 2, 'N']);
  const N = doc([1, 0], [2, 1]);
  const docs = reader({ OUTER, N });
  const outer = (over: Partial<Record<number, Partial<IdentityNode>>> = {}): IdentityNode[] => {
    const base: IdentityNode[] = [
      { id: 100, parentId: 0, guid: 'x', pi: { source: 'OUTER', localId: 1, rootInstanceId: 100 } },
      { id: 102, parentId: 100, guid: 'x-slot', pi: { source: 'OUTER', localId: 2, rootInstanceId: 100 } },
      { id: 103, parentId: 102, guid: 'x-n', pi: { source: 'N', localId: 1, rootInstanceId: 103, parentLocalId: 3 } },
      { id: 200, parentId: 0, guid: 'y', pi: { source: 'OUTER', localId: 1, rootInstanceId: 200 } },
      { id: 202, parentId: 200, guid: 'y-slot', pi: { source: 'OUTER', localId: 2, rootInstanceId: 200 } },
      { id: 203, parentId: 202, guid: 'y-n', pi: { source: 'N', localId: 1, rootInstanceId: 203, parentLocalId: 3 } },
    ];
    return base.map((n) => ({ ...n, ...(over[n.id] ?? {}) }));
  };
  const linked = (to: string) => ({ source: 'N', localId: 1, rootInstanceId: 103, parentLocalId: 3, ownerGuid: to });

  it('unmoved: its owner is its live parent\'s frame, and its identity parent its row\'s', () => {
    const r = resolveIdentityParents(outer(), docs);
    expect(r.ownerOf(103)).toBe(100);
    expect(r.of(103)).toEqual({ parentId: 102, extra: [] });
  });

  it('moved into the OTHER instance with its link: still X\'s — owner and template parent both', () => {
    const r = resolveIdentityParents(outer({ 103: { parentId: 202, pi: linked('x') } }), docs);
    expect(r.ownerOf(103)).toBe(100);
    expect(r.of(103)).toEqual({ parentId: 102, extra: [] });
    expect(r.moved(103)).toBe(true);
  });

  it('moved there WITHOUT a link, the live parent answers — Y — which is why every move writes one', () => {
    const r = resolveIdentityParents(outer({ 103: { parentId: 202 } }), docs);
    expect(r.ownerOf(103)).toBe(200);
  });

  it('a link the owner\'s document contradicts is ignored', () => {
    const other = doc([1, 0], [2, 1]);                  // no row 3 expanding N
    const r = resolveIdentityParents(outer({ 100: { pi: { source: 'OTHER', localId: 1, rootInstanceId: 100 } }, 103: { parentId: 202, pi: linked('x') } }), reader({ OUTER, N, OTHER: other }));
    expect(r.ownerOf(103)).toBe(200);
  });

  it('a link naming something that is not a frame root is ignored', () => {
    const r = resolveIdentityParents(outer({ 103: { parentId: 202, pi: linked('x-slot') } }), docs);
    expect(r.ownerOf(103)).toBe(200);
  });

  it('a member whose row parent is the NESTED row walks from that nested instance\'s root — a row of its owner\'s frame', () => {
    // OUTER row 4 hangs under nested row 3. Its row parent is X's nested root (103), found in X's frame by the
    // row that expanded it — not by the root's own localId, which is the CHILD document's.
    const withChild = doc([1, 0], [2, 1], [3, 2, 'N'], [4, 3]);
    const r = resolveIdentityParents([
      ...outer(),
      { id: 105, parentId: 100, guid: 'x-under', pi: { source: 'OUTER', localId: 4, rootInstanceId: 100 } },
    ], reader({ OUTER: withChild, N }));
    expect(r.of(105)).toEqual({ parentId: 103, extra: [] });
  });

  it('its members walk its own document', () => {
    const r = resolveIdentityParents([
      ...outer(),
      { id: 104, parentId: 100, guid: 'x-n-leaf', pi: { source: 'N', localId: 2, rootInstanceId: 103 } },
    ], docs);
    expect(r.of(104)).toEqual({ parentId: 103, extra: [] });
  });
});

describe('identity parents — a nested row under a nested row (close-out review)', () => {
  // O: Root(1) > QRow(2, prefab Q) > ZRow(3, prefab Z). The editor's prefab-edit save writes this shape when a
  // nested root is dragged under another nested root. Z's root hangs under Q's ROOT, whose `rootInstanceId`
  // is itself — reading that as the owner put ZRoot in Q's frame, where row 3 is QB, and ZRoot took QB's guid.
  const O = doc([1, 0], [2, 1, 'Q'], [3, 2, 'Z']);
  const Q = doc([1, 0], [2, 1], [3, 2]);
  const Z = doc([1, 0], [2, 1]);
  const nodes: IdentityNode[] = [
    { id: 100, parentId: 0, guid: 'o', pi: { source: 'O', localId: 1, rootInstanceId: 100 } },
    { id: 102, parentId: 100, guid: 'q', pi: { source: 'Q', localId: 1, rootInstanceId: 102, parentLocalId: 2 } },
    { id: 103, parentId: 102, guid: 'qa', pi: { source: 'Q', localId: 2, rootInstanceId: 102 } },
    { id: 104, parentId: 103, guid: 'qb', pi: { source: 'Q', localId: 3, rootInstanceId: 102 } },
    { id: 105, parentId: 102, guid: 'z', pi: { source: 'Z', localId: 1, rootInstanceId: 105, parentLocalId: 3 } },
    { id: 106, parentId: 105, guid: 'zl', pi: { source: 'Z', localId: 2, rootInstanceId: 105 } },
  ];
  const r = () => resolveIdentityParents(nodes, reader({ O, Q, Z }));

  it('the inner nested root belongs to the OUTER frame, where its row is — and reads as unmoved', () => {
    expect(r().ownerOf(105)).toBe(100);
    expect(r().of(105)).toEqual({ parentId: 102, extra: [] });
    expect(r().moved(105)).toBe(false);
  });

  it('and does not take the inner frame\'s row of the same number from the member that owns it', () => {
    expect(r().of(104)).toEqual({ parentId: 103, extra: [] });
  });

  it('a nested row directly under the ROOT row is still that root\'s own frame\'s', () => {
    expect(r().ownerOf(102)).toBe(100);
  });

  // Close-out review 2: when the owner's document is missing, or CONTRADICTS the row (a dropped or renumbered row,
  // read for a frame whose own record was lost), the root must not walk that document from its row number — which
  // names QB in Q's — but keep its live parent, as before Phase 6. Mutation: drop the `expands` check in `of()`.
  it('a document that does not expand the row: the live parent, not the member at that number', () => {
    const O_NEW = doc([1, 0], [2, 1, 'Q']);           // row 3 gone
    for (const docs of [{ Q, Z }, { O: O_NEW, Q, Z }] as Record<string, TemplateDoc>[]) {
      const rr = resolveIdentityParents(nodes, reader(docs));
      expect(rr.of(105)).toEqual({ parentId: 102, extra: [] });
      expect(rr.moved(105)).toBe(false);
      expect(rr.of(105)).not.toEqual(rr.of(104));
    }
  });
});

describe('frameDocReader — which document a frame was expanded from', () => {
  const Tag = trait({ n: 0 });
  const OLD = doc([1, 0], [2, 1]);
  const NEW = doc([1, 0], [2, 1], [3, 1]);

  it('a frame root\'s own record wins over the source\'s latest — Apply rebuilds one instance at a time', () => {
    const world = createWorld();
    const a = world.spawn(Tag);
    const b = world.spawn(Tag);
    noteFrameDoc(world, 'P', OLD, a);
    noteFrameDoc(world, 'P', NEW, b);
    const read = frameDocReader(world, () => undefined);
    expect(read('P', a.id())).toBe(OLD);
    expect(read('P', b.id())).toBe(NEW);
    expect(read('P')).toBe(NEW);
    world.destroy();
  });

  it('a root\'s record answers only for the source it was recorded under (a re-tag)', () => {
    const world = createWorld();
    const a = world.spawn(Tag);
    noteFrameDoc(world, 'P', OLD, a);
    expect(frameDocReader(world, (s) => (s === 'Q' ? NEW : undefined))('Q', a.id())).toBe(NEW);
    world.destroy();
  });

  it('a destroyed root\'s record does not answer for the entity that reuses its index', () => {
    const world = createWorld();
    const a = world.spawn(Tag);
    noteFrameDoc(world, 'P', OLD, a);
    const id = a.id();
    a.destroy();
    const reused = world.spawn(Tag);
    expect(reused.id()).toBe(id);                      // koota's LIFO free list
    noteFrameDoc(world, 'P', NEW);                      // the source's latest, no root
    expect(frameDocReader(world, () => undefined)('P', reused.id())).toBe(NEW);
    world.destroy();
  });

  it('nothing recorded: the fallback', () => {
    const world = createWorld();
    expect(frameDocReader(world, () => OLD)('P', 5)).toBe(OLD);
    world.destroy();
  });

  it('the runtime cache stands under the editor fallback, so a device still reads a document', () => {
    const world = createWorld();
    setRuntimeFrameDocFallback(() => NEW);
    try {
      expect(frameDocReader(world, () => undefined)('P')).toBe(NEW);
      expect(frameDocReader(world, () => OLD)('P')).toBe(OLD);
    } finally { setRuntimeFrameDocFallback(undefined); world.destroy(); }
  });

  it('records of dead roots are swept as the map grows, so runtime spawns do not accumulate them', () => {
    const world = createWorld();
    const live = world.spawn(Tag);
    noteFrameDoc(world, 'P', OLD, live);
    for (let i = 0; i < 200; i++) { const e = world.spawn(Tag); noteFrameDoc(world, 'P', NEW, e); e.destroy(); }
    expect(frameDocRootCount(world)).toBeLessThan(80);
    expect(frameDocReader(world, () => undefined)('P', live.id())).toBe(OLD);
    world.destroy();
  });
});
