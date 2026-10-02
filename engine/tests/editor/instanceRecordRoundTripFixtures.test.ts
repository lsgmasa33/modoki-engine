/** #2008 P2 over hand-built inputs (#2001 S3): every class of record the corpus and the fuzzer's saved scenes do not reach
 *  (`instanceRecordRoundTrip.test.ts`, `instanceRecordRoundTripFuzz.test.ts`) round-trips through the writer and the
 *  parser the same way: `parse(serialize(parse(old))) ≡ parse(old)`, the same bytes on a second save, and the same fold,
 *  from the original documents and from the documents rewritten as v10. Each fixture first proves it reaches its class.
 *  The documents are the parser's own fixture shapes (`parseInstanceRecord.test.ts`). */

import { describe, it, expect } from 'vitest';
import { parseTemplateLists } from '../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import { foldInstance } from '../../packages/modoki/src/runtime/prefab/foldInstance';
import type { ParsedInstance, PrefabDoc, PrefabReader, TemplateOverrideList } from '../../packages/modoki/src/runtime/prefab/instanceRecord';
import type { AddedEntity, SceneEntityEntry } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { asData, ownAsLinked, roundTripEntry, roundTripTemplateRow, toV10Docs } from './instanceRecordRoundTrip';

const G = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000002008`;
const N1 = G(1), N2 = G(2), N3 = G(3), NQ1 = G(11), NQ2 = G(12), NQ3 = G(13);
const ROOT = G(100);

/** Q: root 1 → 2 "Lamp" (Light), 3 "Deco" (Sprite). P: root 1 "Ship" → 2 "Hull", 3 a nested row of Q whose template
 *  list removes Q's 2, removes Q-3's Sprite and adds keyed node k1. */
const Q: PrefabDoc = {
  id: 'Q', rootLocalId: 1, entities: [
    { localId: 1, nodeGuid: NQ1, name: 'QRoot', traits: { EntityAttributes: { name: 'QRoot', sortOrder: 0 } } },
    { localId: 2, nodeGuid: NQ2, name: 'Lamp', traits: { EntityAttributes: { name: 'Lamp', parentId: 1 }, Light: { intensity: 1 } } },
    { localId: 3, nodeGuid: NQ3, name: 'Deco', traits: { EntityAttributes: { name: 'Deco', parentId: 1 }, Sprite: { tint: '#fff' } } },
  ],
};
const K1 = (extra: Partial<AddedEntity> = {}): AddedEntity => ({ parentLocalId: 1, guid: '', key: 'k1', name: 'Glow', traits: { Light: { intensity: 2 }, Sprite: { tint: '#000' } }, children: [], ...extra });
const P: PrefabDoc = {
  id: 'P', rootLocalId: 1, entities: [
    { localId: 1, nodeGuid: N1, name: 'Ship', traits: { EntityAttributes: { name: 'Ship', sortOrder: 4 }, Transform: { x: 0, y: 0 } } },
    { localId: 2, nodeGuid: N2, name: 'Hull', traits: { EntityAttributes: { name: 'Hull', parentId: 1 }, Sprite: { tint: '#fff' }, Light: { intensity: 1 } } },
    {
      localId: 3, nodeGuid: N3, name: 'Engine', prefab: 'Q', traits: { EntityAttributes: { name: 'Engine', parentId: 1 } },
      overrides: { 1: { EntityAttributes: { name: 'Engine', sortOrder: 0 } } },
      removed: [2], removedTraits: { 3: ['Sprite'] }, added: [K1()],
    },
  ],
};
const reader = (...ds: PrefabDoc[]): PrefabReader => {
  const m = new Map(ds.map((d) => [d.id!, d]));
  return (g) => (m.has(g) ? { doc: m.get(g)! } : { missing: true });
};
const ALL = reader(P, Q);
const entry = (extra: Partial<SceneEntityEntry> = {}): SceneEntityEntry => ({
  id: 7, name: 'Ship', prefab: 'P', guid: ROOT, traits: { PrefabInstance: { source: 'P', localId: 1, rootInstanceId: ROOT } }, ...extra,
});

/** Scene-form fixtures: the entry, the documents the load reads, and what the parse must show to reach the class. */
const SCENE: Array<{ name: string; entry: SceneEntityEntry; docs: PrefabDoc[]; reaches: (p: ParsedInstance) => unknown }> = [
  { name: 'an unparseable value (held.unparsed)', entry: entry({ removed: 'x' as unknown as number[] }), docs: [P, Q], reaches: (p) => p.record.held.unparsed },
  {
    name: 'a missing prefab: legacy channels and whole-list rows held, identity rows carried',
    entry: entry({
      prefab: 'GONE', traits: { PrefabInstance: { source: 'GONE', localId: 1 }, EntityAttributes: { sortOrder: 2 } },
      overrides: { 1: { EntityAttributes: { name: 'Kept' } }, 5: { Light: { intensity: 2 } } },
      members: { [`/${G(20)}`]: { guid: G(21), traits: { Light: { intensity: 3 } } }, [`/${G(22)}`]: { guid: G(23), added: [] } },
    }),
    docs: [P, Q], reaches: (p) => p.record.held.pendingLegacy?.members,
  },
  {
    name: 'a localId that names no row: held, and a node added on it re-anchored at "/"',
    entry: entry({ overrides: { 12: { Light: { intensity: 1 } } }, removed: [12], added: [{ parentLocalId: 12, guid: G(30), name: 'Stray', traits: {}, children: [] }] }),
    docs: [P, Q], reaches: (p) => p.record.held.pendingLegacy && p.record.list.rows.get('/')?.own,
  },
  {
    name: 'a path through a missing nested prefab, held for that path only',
    entry: entry({ overrides: { 2: { Light: { intensity: 7 } } }, nestedOverrides: { 3: { 2: { Light: { intensity: 3 } } } } }),
    docs: [P], reaches: (p) => p.record.held.pendingLegacy?.nestedOverrides,
  },
  {
    name: 'placement: a renamed root, its order, folder and sourceScene, and the root\'s own edits',
    entry: entry({
      traits: { PrefabInstance: { source: 'P', localId: 1 }, EntityAttributes: { parentId: G(90), editorFolder: 'Fleet', sourceScene: 'base.scene.json' } },
      overrides: { 1: { EntityAttributes: { name: 'Renamed', sortOrder: 9, isActive: false }, Transform: { x: 5 } } },
    }),
    docs: [P, Q], reaches: (p) => p.record.placement.sourceScene && p.record.placement.editorFolder && p.record.list.rows.get('/')?.traits,
  },
  {
    name: 'legacy moves: a localId move and a v17 row\'s parent, traitRemovals and own',
    entry: entry({
      moved: { 2: G(60) },
      members: { [`/${N3}/${NQ3}`]: { guid: G(61), parent: G(62), traitRemovals: { Sprite: false }, own: [{ parentLocalId: 0, guid: G(63), name: 'Tag', traits: {}, children: [] }] } },
    }),
    docs: [P, Q], reaches: (p) => p.record.list.rows.get(`/${N2}`)?.parent && p.record.list.rows.get(`/${N3}/${NQ3}`)?.own,
  },
  {
    name: 'whole-list pins (nestedStructure slot): a chain node copied, one omitted, a new one added',
    entry: entry({ nestedStructure: { 3: { removed: [2], added: [{ parentLocalId: 1, guid: G(70), key: 'k1', name: 'Glow', traits: { Light: { intensity: 9 } }, children: [] }, { parentLocalId: 1, guid: G(71), name: 'New', traits: {}, children: [] }] } } }),
    docs: [P, Q], reaches: (p) => p.record.list.rows.get(`/${N3}/a+k1`)?.traits && p.record.list.rows.get(`/${N3}`)?.own,
  },
];

describe('#2008 P2 over fixtures: scene form', () => {
  for (const f of SCENE) {
    it(f.name, () => {
      const read = reader(...f.docs);
      const { first, second, bytes1, bytes2 } = roundTripEntry(f.entry, read);
      expect(f.reaches(first), 'the fixture reaches its class').toBeTruthy();
      expect(asData(second.record), 'parse(serialize(rec)) ≡ rec').toEqual(asData(first.record));
      expect(ownAsLinked(second.ownContent), 'own content').toEqual(ownAsLinked(first.ownContent));
      expect(bytes2, 'a second save writes the same bytes').toBe(bytes1);
      const fold = asData(foldInstance(read, first.record));
      expect(asData(foldInstance(read, second.record)), 'the same instance').toEqual(fold);
      const v10 = toV10Docs(new Map(f.docs.map((d) => [d.id!, d])), read);
      expect(asData(foldInstance((g) => (v10.has(g) ? { doc: v10.get(g)! } : { missing: true }), second.record)), 'the same instance from v10 documents').toEqual(fold);
    });
  }
});

/** A document R whose row 2 is a nested row of Q, carrying `node` as a template-added node. */
const R = (node: AddedEntity): PrefabDoc => ({
  id: 'R', rootLocalId: 1, entities: [
    { localId: 1, nodeGuid: G(200), traits: {} },
    { localId: 2, nodeGuid: G(201), prefab: 'Q', traits: { EntityAttributes: { parentId: 1 } }, added: [node] },
  ],
});
const refNode = (extra: Partial<AddedEntity>): AddedEntity => ({ parentLocalId: 1, guid: '', key: 'kr', name: 'Ref', traits: {}, children: [], prefab: 'Q', ...extra });
const ownOf = (l: TemplateOverrideList) => l.rows.get('/')?.own?.[0];

/** Template-form fixtures: a document, the reader, which row, and what its list must show to reach the class. */
const TEMPLATE: Array<{ name: string; doc: PrefabDoc; read: PrefabReader; lid: number; reaches: (l: TemplateOverrideList) => unknown }> = [
  { name: 'a row whose nested prefab is missing (list.held.pendingLegacy)', doc: P, read: reader(P), lid: 3, reaches: (l) => l.held?.pendingLegacy },
  { name: 'a row value in no shape a reader takes (list.held.unparsed)', doc: { ...P, entities: [P.entities[0]!, P.entities[1]!, { ...P.entities[2]!, removed: 'x' as never }] }, read: ALL, lid: 3, reaches: (l) => l.held?.unparsed },
  { name: 'a template reference node whose prefab is missing (node held)', doc: R(refNode({ prefab: 'GONE', overrides: { 2: { Light: { intensity: 6 } } } })), read: reader(Q), lid: 2, reaches: (l) => ownOf(l)?.held?.pendingLegacy },
  { name: 'a template reference node: its channels → members, its templateMoved → a parent token', doc: R(refNode({ overrides: { 2: { Light: { intensity: 6 } } }, templateMoved: { 2: '@member:3' } })), read: reader(Q), lid: 2, reaches: (l) => ownOf(l)?.members?.[`/${NQ2}`]?.parent },
  { name: 'a legacy KEYED move kept as a parent on the node row (#1883 C)', doc: R(refNode({ added: [K1()], templateMoved: { '+k1': '@member:2' } })), read: reader(Q), lid: 2, reaches: (l) => ownOf(l)?.members?.['/a+k1']?.parent },
  { name: 'a template-added node with children', doc: R({ ...K1({ key: 'kp' }), children: [K1({ key: 'kc', name: 'Child' })] }), read: reader(Q), lid: 2, reaches: (l) => ownOf(l)?.children.length },
];

describe('#2008 P2 over fixtures: template form', () => {
  for (const f of TEMPLATE) {
    it(f.name, () => {
      const read: PrefabReader = (g) => (g === f.doc.id ? { doc: f.doc } : f.read(g));
      const { list } = parseTemplateLists(f.doc, f.doc.id!, read).rows.get(f.lid)!;
      expect(f.reaches(list), 'the fixture reaches its class').toBeTruthy();
      const { again, bytes1, bytes2 } = roundTripTemplateRow(f.doc.entities.find((r) => r.localId === f.lid)!, list, read);
      expect(asData(again), 'parse(serialize(list)) ≡ list').toEqual(asData(list));
      expect(bytes2, 'a second save writes the same bytes').toBe(bytes1);
    });
  }

  it('a document-level `moved` (prefab v4): one move lands on a row as a parent token, one is held at document level', () => {
    const PM: PrefabDoc = { ...P, id: 'PM', moved: { '3.2': '@member:2', '2': '@member:3' } };
    const read = reader(PM, Q);
    const before = parseTemplateLists(PM, 'PM', read);
    expect(before.docHeld?.moved, 'held at document level').toBeTruthy();
    expect(before.rows.get(3)!.list.rows.get(`/${NQ2}`)?.parent, 'a parent token on the row').toBeTruthy();
    const v10 = toV10Docs(new Map([['PM', PM]]), read).get('PM')!;
    expect(Object.keys(v10.moved ?? {}), 'the move a row took is not stated again at document level').toEqual(['2']);
    const after = parseTemplateLists(v10, 'PM', read);
    expect(asData(after.rows), 'every row\'s list').toEqual(asData(before.rows));
    expect(after.docHeld, 'the document-level remainder').toEqual(before.docHeld);
  });
});

describe('a document\'s held `moved` round-trips through the writer (#2007 close-out: the parser holds a non-record one whole)', () => {
  it('a non-record moved is written back as it was; named-nothing entries as their record', async () => {
    const { parseTemplateLists } = await import('../../packages/modoki/src/runtime/prefab/parseInstanceRecord');
    const { serializeTemplateDocHeld } = await import('../../packages/modoki/src/runtime/prefab/serializeInstanceRecord');
    const doc = (moved: unknown) => ({ id: 'D', rootLocalId: 1, moved, entities: [{ localId: 1, nodeGuid: 'aaaaaaaa-0000-4000-8000-0000000000d1', traits: {} }] }) as never;
    const read = () => ({ missing: true as const });
    for (const moved of ['junk', 7, ['x']]) expect(serializeTemplateDocHeld(parseTemplateLists(doc(moved), 'D', read).docHeld)).toEqual({ moved });
    expect(serializeTemplateDocHeld(parseTemplateLists(doc({ '9.9': '@member:1' }), 'D', read).docHeld)).toEqual({ moved: { '9.9': '@member:1' } });
    expect(serializeTemplateDocHeld(undefined)).toEqual({});
  });
});
