/** Scene v17 NODE rows (#1516) — the pure halves: the key grammar, the load-side fold
 *  (`foldMemberRowChannels` → `applyNodeRows`, `own`, `traitRemovals`) and the save-side diff
 *  (`diffFrameAdded`). The round trip through a real save and load is `nestedRowFieldSave.test.ts`. */
import { describe, it, expect } from 'vitest';
import { formatNodeRowKey, parseNodeRowKey, nodeRowKey, parseMemberRowKey, formatMemberRowKey } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { foldMemberRowChannels, applyNodeRows } from '../../packages/modoki/src/runtime/loaders/prefabOverrides';
import { diffFrameAdded, type NodeDiffDeps } from '../../packages/modoki/src/editor/scene/nodeRowDiff';
import type { AddedEntity } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';

const G1 = 'aaaaaaaa-0000-4000-8000-000000001516';
const G2 = 'bbbbbbbb-0000-4000-8000-000000001516';

const node = (key: string | undefined, x: number, extra: Partial<AddedEntity> = {}): AddedEntity => ({
  parentLocalId: 1, guid: '', ...(key ? { key } : {}), name: key ?? 'n', children: [],
  traits: { EntityAttributes: { name: key ?? 'n', parentId: 0, guid: '' }, Transform: { x } }, ...extra,
});

describe('node row key grammar', () => {
  it('a node row key is a frame chain and one a+<key> LAST; a member key never parses as one', () => {
    expect(formatNodeRowKey([G1], 'k1')).toBe(`/${G1}/a+k1`);
    expect(parseNodeRowKey(`/${G1}/a+k1`)).toEqual({ frame: [G1], nodeKey: 'k1' });
    expect(parseNodeRowKey(`/${G1}/${G2}`)).toBeNull();
    expect(parseNodeRowKey('/a+k1')).toBeNull(); // no frame: a node is never at the top frame
    // Mutation: test the leading `a` instead of `a+` in `nodeRowKey` — a guid starting with `a` reads as a node.
    expect(nodeRowKey(G1)).toBe('');
    // The member grammar stays guid-only, so no MEMBER key can end in a node component.
    expect(parseMemberRowKey(`/${G1}/a+k1`)).toEqual([]);
    expect(formatMemberRowKey([G1, 'a+k1'])).toBe('');
  });

  it('refuses a key that cannot name a node (empty, or holding the separator)', () => {
    expect(formatNodeRowKey([G1], '')).toBe('');
    expect(formatNodeRowKey([G1], 'a/b')).toBe('');
    expect(formatNodeRowKey([], 'k1')).toBe('');
  });
});

describe('applyNodeRows', () => {
  it('merges a row\'s fields over the node, leaving its siblings as the chain has them', () => {
    const { nodes, hit } = applyNodeRows([node('k1', 1), node('k2', 1)], new Map([['k1', { traits: { Transform: { x: 5 } } }]]));
    expect(nodes!.map((n) => (n.traits.Transform as { x: number }).x)).toEqual([5, 1]);
    expect([...hit]).toEqual(['k1']);
  });

  it('removed drops the node and its subtree; a row naming no node is not hit', () => {
    const tree = [node('k1', 1, { children: [node('k1c', 0)] }), node('k2', 1)];
    const { nodes, hit } = applyNodeRows(tree, new Map([['k1', { removed: true }], ['gone', { traits: { Transform: { x: 9 } } }]]));
    expect(nodes!.map((n) => n.key)).toEqual(['k2']);
    expect(hit.has('gone')).toBe(false);
  });

  it('reaches a node inside another\'s children, adds and drops traits, and appends own children', () => {
    const own = node(undefined, 7, { guid: G2 });
    const tree = [node('k1', 1, { children: [node('k1c', 0, { traits: { Transform: { x: 0 }, UIAction: {} } })] })];
    const { nodes } = applyNodeRows(tree, new Map([
      ['k1', { own: [own] }],
      ['k1c', { traits: { UIFocusable: { a: 1 } }, traitRemovals: { UIAction: true } }],
    ]));
    const kids = nodes![0]!.children;
    expect(kids.map((n) => n.guid || n.key)).toEqual(['k1c', G2]);
    expect(Object.keys(kids[0]!.traits).sort()).toEqual(['Transform', 'UIFocusable']);
  });

  it('a REFERENCE node takes only removed', () => {
    const ref = node('kr', 0, { prefab: G1 });
    const { nodes } = applyNodeRows([ref], new Map([['kr', { traits: { Transform: { x: 5 } } }]]));
    expect(nodes![0]).toBe(ref);
  });

  it('never mutates its input', () => {
    const tree = [node('k1', 1)];
    const before = JSON.stringify(tree);
    applyNodeRows(tree, new Map([['k1', { traits: { Transform: { x: 5 } }, traitRemovals: { EntityAttributes: true } }]]));
    expect(JSON.stringify(tree)).toBe(before);
  });
});

describe('foldMemberRowChannels — v17 channels', () => {
  const doc = { rootLocalId: 1, entities: [{ localId: 1, nodeGuid: G1 }, { localId: 2, nodeGuid: G2 }] };

  it('a direct a+ row is a node row, applied over the lower layer\'s added nodes', () => {
    const f = foldMemberRowChannels(doc, { '/a+k1': { traits: { Transform: { x: 5 } } } }, { added: [node('k1', 1), node('k2', 1)] });
    expect(f.added!.map((n) => (n.traits.Transform as { x: number }).x)).toEqual([5, 1]);
  });

  it('own APPENDS after the lower layer\'s nodes, where added replaces them', () => {
    // Mutation: apply `own` as `added` (replace) — k1 is gone.
    const mine = node(undefined, 3, { guid: G2, parentLocalId: 0 });
    const f = foldMemberRowChannels(doc, { [`/${G2}`]: { own: [mine] } }, { added: [node('k1', 1, { parentLocalId: 2 })] });
    expect(f.added!.map((n) => n.key ?? n.guid)).toEqual(['k1', G2]);
    expect(f.added![1]!.parentLocalId).toBe(2);
  });

  it('traitRemovals edits the LOWER layer\'s removal list per trait — true adds, false restores', () => {
    // Mutation: ignore `false` in `mergeTraitRemovals` — UIAction stays removed.
    const f = foldMemberRowChannels(doc, { [`/${G2}`]: { traitRemovals: { UIFocusable: true, UIAction: false } } },
      { removedTraits: { 2: ['UIAction', 'Other'] } });
    expect(f.removedTraits![2]!.sort()).toEqual(['Other', 'UIFocusable']);
  });

  it('traitRemovals over a v16 removedTraits edits THAT list, and a v16 list alone still replaces', () => {
    const over = foldMemberRowChannels(doc, { [`/${G2}`]: { removedTraits: ['A'], traitRemovals: { B: true } } }, { removedTraits: { 2: ['C'] } });
    expect(over.removedTraits![2]!.sort()).toEqual(['A', 'B']);
    const v16 = foldMemberRowChannels(doc, { [`/${G2}`]: { removedTraits: ['A'] } }, { removedTraits: { 2: ['C'] } });
    expect(v16.removedTraits![2]).toEqual(['A']);
  });

  it('a v16 added still REPLACES the lower layer\'s list', () => {
    const f = foldMemberRowChannels(doc, { [`/${G2}`]: { added: [node(undefined, 3, { guid: G2 })] } }, { added: [node('k1', 1, { parentLocalId: 2 })] });
    expect(f.added!.map((n) => n.key ?? n.guid)).toEqual([G2]);
  });

  it('a whole list replaces only the nodes the TEMPLATE anchors at its member — one re-anchored there stays (#1872)', () => {
    // k1's anchor, localId 3, is gone from the document, so the load re-anchors it to the root; a whole list the scene
    // pinned at the root BEFORE the anchor went never held it, and replacing it lost the node (the close-out review's
    // pin-first order). A list pinned over it says so with a node row on its key (`diffFrameAdded`, below). Mutation:
    // filter on `placedAnchor(doc, n.parentLocalId)` — k1 is dropped.
    const f = foldMemberRowChannels(doc, { [`/${G1}`]: { added: [node(undefined, 3, { guid: G2 })] } },
      { added: [node('k1', 1, { parentLocalId: 3 }), node('k2', 1)] });
    expect(f.added!.map((n) => n.key ?? n.guid)).toEqual(['k1', G2]);
  });

  it('in TEMPLATE form a whole list that names a re-anchored node by key replaces it; one that does not, keeps it (#1872 re-review)', () => {
    // A prefab's own rows carry the node's key in the list, and a removed row on that key removed the list's copy too.
    // The key is the statement there. Mutation: drop the key-named clause — k1 comes twice.
    const f = foldMemberRowChannels(doc, { [`/${G1}`]: { added: [node('k1', 7)] } }, { added: [node('k1', 1, { parentLocalId: 3 }), node('k2', 1)] });
    expect(f.added!.map((n) => `${n.key}:${(n.traits.Transform as { x: number }).x}`)).toEqual(['k1:7']);
    // A list that does not name it (pinned before the anchor went) leaves the template's node to the load's re-anchor.
    const g = foldMemberRowChannels(doc, { [`/${G1}`]: { added: [node('k9', 7)] } }, { added: [node('k1', 1, { parentLocalId: 3 })] });
    expect(g.added!.map((n) => n.key)).toEqual(['k1', 'k9']);
    // A key the lower list uses twice names neither copy (third review): the root copy goes as the list's own anchor,
    // the re-anchored one stays. Mutation: drop the once-only test — both go.
    const h = foldMemberRowChannels(doc, { [`/${G1}`]: { added: [node('kd', 7)] } }, { added: [node('kd', 1), node('kd', 2, { parentLocalId: 3 })] });
    expect(h.added!.map((n) => `${n.key}:${(n.traits.Transform as { x: number }).x}`)).toEqual(['kd:2', 'kd:7']);
  });

  it('own and traitRemovals on a NESTED row\'s member row are forwarded to that frame', () => {
    // Mutation: drop `row.own || row.traitRemovals` from the nested forward test — nothing is forwarded.
    const nestedDoc = { rootLocalId: 1, entities: [{ localId: 1, nodeGuid: G1 }, { localId: 2, nodeGuid: G2, prefab: 'p' }] };
    const f = foldMemberRowChannels(nestedDoc, { [`/${G2}`]: { traitRemovals: { A: true } } }, {});
    expect(f.forwardRoot?.get(2)).toEqual({ traitRemovals: { A: true } });
    const g = foldMemberRowChannels(nestedDoc, { [`/${G2}`]: { own: [] } }, {});
    expect(g.forwardRoot?.get(2)).toEqual({ own: [] });
  });
});

describe('diffFrameAdded', () => {
  /** A live node in scene form: its guid stands for the key the fake `keyOf` reads back. */
  const live = (key: string | undefined, x: number, extra: Partial<AddedEntity> = {}): AddedEntity => ({
    ...node(key, x), key: undefined, guid: key ? `live-${key}` : G2, ...extra,
  });
  const deps: NodeDiffDeps = {
    keyOf: (n) => (n.guid.startsWith('live-') ? n.guid.slice(5) : ''),
    defaultOf: (_t, f) => (f === 'x' || f === 'y' ? 0 : undefined),
    sameReference: (a, b) => JSON.stringify(a.overrides) === JSON.stringify(b.overrides),
    equal: (a, b) => a === b,
  };

  it('an untouched frame states nothing', () => {
    // The chain states y: 0 (a default) and an identity-only EntityAttributes; the live side omits both.
    // Mutation: read a field one side omits as undefined (drop `defaultOf`) — y reads as an edit.
    const chain = [node('k1', 1, { traits: { EntityAttributes: { name: 'k1', parentId: 0, guid: '' }, Transform: { x: 1, y: 0 } } }), node('k2', 1)];
    const d = diffFrameAdded([live('k1', 1, { traits: { EntityAttributes: { name: 'k1' }, Transform: { x: 1 } } }), live('k2', 1)], chain, deps);
    expect(d).toEqual({ nodeRows: new Map(), own: new Map(), whole: new Set(), pinnedOver: new Set() });
  });

  it('an edit to ONE node is that node\'s field, and its sibling states nothing (#1516)', () => {
    const d = diffFrameAdded([live('k1', 5), live('k2', 1)], [node('k1', 1), node('k2', 1)], deps);
    expect([...d.nodeRows]).toEqual([['k1', { traits: { Transform: { x: 5 } } }]]);
  });

  it('a field set BACK to its default is stated as the default', () => {
    // Mutation: skip a field absent from the live bag — the edit to 0 is lost and the chain's 1 comes back.
    // As the live capture writes it: a default-valued field is omitted.
    const d = diffFrameAdded([live('k1', 0, { traits: { EntityAttributes: { name: 'k1' }, Transform: {} } })], [node('k1', 1)], deps);
    expect(d.nodeRows.get('k1')).toEqual({ traits: { Transform: { x: 0 } } });
  });

  it('a deleted node is removed; the scene\'s own node is own; an added and a removed trait are stated', () => {
    const l = live('k1', 1, { traits: { EntityAttributes: { name: 'k1' }, Transform: { x: 1 }, UIFocusable: { a: 1 } } });
    const chain = [node('k1', 1, { traits: { EntityAttributes: { name: 'k1' }, Transform: { x: 1 }, UIAction: {} } }), node('k2', 1)];
    const d = diffFrameAdded([l, live(undefined, 3)], chain, deps);
    expect(d.nodeRows.get('k2')).toEqual({ removed: true });
    expect(d.nodeRows.get('k1')).toEqual({ traits: { UIFocusable: { a: 1 } }, traitRemovals: { UIAction: true } });
    expect(d.own.get(1)!.map((n) => [n.guid, n.parentLocalId])).toEqual([[G2, 0]]);
  });

  it('a node RE-PARENTED under a sibling unlinks: the template copy is removed, the node is the sibling\'s own', () => {
    // The owner's rule: any re-parent of a template-added node cuts its link.
    // Mutation: match live nodes by key across the whole frame — k1 matches in place, and nothing unlinks.
    const d = diffFrameAdded([live('k2', 1, { children: [live('k1', 1)] })], [node('k1', 1), node('k2', 1)], deps);
    expect(d.nodeRows.get('k1')).toEqual({ removed: true });
    expect(d.nodeRows.get('k2')!.own!.map((n) => n.guid)).toEqual(['live-k1']);
  });

  it('a node re-parented under ANOTHER member unlinks the same way', () => {
    const d = diffFrameAdded([live('k1', 1, { parentLocalId: 2 }), live('k2', 1)], [node('k1', 1), node('k2', 1)], deps);
    expect(d.nodeRows.get('k1')).toEqual({ removed: true });
    expect(d.own.get(2)!.map((n) => n.guid)).toEqual(['live-k1']);
    expect(d.nodeRows.has('k2')).toBe(false);
  });

  it('a child of a template node is diffed as its own node row', () => {
    const chain = [node('k1', 1, { children: [node('k1c', 2)] })];
    const d = diffFrameAdded([live('k1', 1, { children: [live('k1c', 4)] })], chain, deps);
    expect([...d.nodeRows]).toEqual([['k1c', { traits: { Transform: { x: 4 } } }]]);
  });

  it('a whole list over a node the load RE-ANCHORED reports it pinned over; a list stated node by node does not (#1872)', () => {
    // k1's template anchor is gone, so the load placed it at the root beside a key-less node, whose list goes whole: the
    // list holds the live k1, and the fold (which replaces only the template's own anchor) would spawn the template's k1
    // beside it. Reported, not written as a row: the writer states it per form. Mutation: drop `pinOver()` — empty.
    const whole = diffFrameAdded([live('k1', 1), live(undefined, 1)], [node('k1', 1), node(undefined, 1)], deps, new Set(['k1']));
    expect([...whole.whole]).toEqual([1]);
    expect([...whole.pinnedOver]).toEqual(['k1']);
    expect(whole.nodeRows.has('k1')).toBe(false);
    // Node by node, k1 is matched on its key already.
    const rows = diffFrameAdded([live('k1', 1)], [node('k1', 1)], deps, new Set(['k1']));
    expect(rows.whole.size).toBe(0);
    expect(rows.pinnedOver.size).toBe(0);
  });

  it('a key used twice elsewhere in the frame does not stop a re-anchored node\'s own unique key from being reported (#1872 re-review)', () => {
    // The duplicate-key branch returned before the rule, so the save wrote no row while the rebuild's own copy of the
    // condition fired: two copies on load. Mutation: drop `pinOver()` from the duplicate branch — k1 is not reported.
    const d = diffFrameAdded([live('k1', 1)], [node('k1', 1), node('kd', 1), node('kd', 1)], deps, new Set(['k1', 'kd']));
    expect([...d.pinnedOver]).toEqual(['k1']); // kd is used twice: no row could name one of them
  });

  it('falls back to the whole list for a key-less chain node, and for a duplicate key', () => {
    // Mutation: drop the `allKeyed` test — a key-less node is diffed and, unmatched, reads as removed.
    const keyless = diffFrameAdded([live('k1', 5)], [node('k1', 1), node(undefined, 1)], deps);
    expect([...keyless.whole]).toEqual([1]);
    expect(keyless.nodeRows.size).toBe(0);
    const dup = diffFrameAdded([live('k1', 5)], [node('k1', 1), node('k1', 1)], deps);
    expect([...dup.whole]).toEqual([1]);
  });

  it('an edited template REFERENCE node falls back; an unchanged one states nothing', () => {
    const ref = (x: number) => node('kr', 0, { prefab: G1, overrides: { 2: { Transform: { x } } } });
    const lref = (x: number) => ({ ...ref(x), guid: 'live-kr' });
    expect([...diffFrameAdded([lref(3)], [ref(3)], deps).whole]).toEqual([]);
    expect([...diffFrameAdded([lref(4), live('k2', 1)], [ref(3), node('k2', 1)], deps).whole]).toEqual([1]);
  });

  it('a second live copy of a template node is the scene\'s own', () => {
    const d = diffFrameAdded([live('k1', 1), live('k1', 1)], [node('k1', 1)], deps);
    expect(d.nodeRows.size).toBe(0);
    expect(d.own.get(1)!.length).toBe(1);
  });
});
