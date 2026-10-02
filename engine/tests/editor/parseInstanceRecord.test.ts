/** `parseInstanceRecord` (#2001 S1, #2006): one fixture per conversion row of the design's § 5.2, as amended by
 *  § 10.3–10.5 and the hub's rulings of 2026-10-02 (root name; the refined format rule). Pure: in-memory documents and a
 *  reader, no world. Each test names the row it proves. */
import { describe, it, expect } from 'vitest';
import {
  parseInstanceRecord, parseReferenceNode, type ParseOptions, parseTemplateList, parseTemplateLists, preV5NodeGuid,
} from '../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import type { PrefabDoc, PrefabReader, SceneTargetRecord, TemplateTargetRecord } from '../../packages/modoki/src/runtime/prefab/instanceRecord';
import type { AddedEntity, SceneEntityEntry } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { serializeInstanceRecord } from '../../packages/modoki/src/runtime/prefab/serializeInstanceRecord';
import { foldInstance } from '../../packages/modoki/src/runtime/prefab/foldInstance';
import { HELD_REMAINDER } from '../../packages/modoki/src/runtime/prefab/instanceRecord';

const G = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000002006`;
const N1 = G(1), N2 = G(2), N3 = G(3), NQ1 = G(11), NQ2 = G(12), NQ3 = G(13);
const ROOT = G(100);

/** P: root 1 "Ship" (sortOrder 4) → 2 "Hull" (Sprite, Light), 3 a nested row of Q whose own template list removes Q's 2,
 *  removes Q-3's Sprite and adds keyed node k1 at Q's root. Q: root 1 → 2 (Light), 3 (Sprite). */
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
const docs = new Map<string, PrefabDoc>([['P', P], ['Q', Q]]);
const reader = (m: Map<string, PrefabDoc> = docs): PrefabReader => (g) => (m.has(g) ? { doc: m.get(g)! } : { missing: true });
/** A file before the instance model (v20): what every case here reads unless it names its version. */
const V15 = { sceneVersion: 15 };

const entry = (extra: Partial<SceneEntityEntry> = {}): SceneEntityEntry => ({
  id: 7, name: 'Ship', prefab: 'P', guid: ROOT, traits: { PrefabInstance: { source: 'P', localId: 1, rootInstanceId: ROOT } }, ...extra,
});
const row = (r: Map<string, SceneTargetRecord | TemplateTargetRecord>, k: string) => r.get(k);

describe('parseInstanceRecord — scene entry, legacy localId channels (§ 5.2)', () => {
  it('overrides[lid] → that row\'s traits; the root lid → "/", minus the placement fields', () => {
    const { record } = parseInstanceRecord(entry({
      overrides: { 1: { Transform: { x: 5 }, EntityAttributes: { sortOrder: 7, name: 'Renamed', isActive: false } }, 2: { Sprite: { tint: '#f00' } } },
    }), reader(), V15);
    expect(row(record.list.rows, '/')?.traits).toEqual({ Transform: { x: 5 }, EntityAttributes: { isActive: false } });
    expect(row(record.list.rows, `/${N2}`)?.traits).toEqual({ Sprite: { tint: '#f00' } });
    expect(record.placement).toMatchObject({ sortOrder: 7, name: 'Renamed' });
  });

  it('removed[lid] → removed: true', () => {
    const { record } = parseInstanceRecord(entry({ removed: [2] }), reader(), V15);
    expect(row(record.list.rows, `/${N2}`)?.removed).toBe(true);
  });

  it('removedTraits[lid] → traitRemovals true per named trait', () => {
    const { record } = parseInstanceRecord(entry({ removedTraits: { 2: ['Light'] } }), reader(), V15);
    expect(row(record.list.rows, `/${N2}`)?.traitRemovals).toEqual({ Light: true });
  });

  it('added (anchored by parentLocalId) → own of the anchor row, content carried by guid', () => {
    const node: AddedEntity = { parentLocalId: 2, guid: G(50), name: 'Badge', traits: { Sprite: { tint: '#0f0' } }, children: [] };
    const { record, ownContent } = parseInstanceRecord(entry({ added: [node] }), reader(), V15);
    expect(row(record.list.rows, `/${N2}`)?.own).toEqual([{ guid: G(50) }]);
    expect(ownContent.get(G(50))).toBe(node);
  });

  it('moved[lid] (scene v15) → a legacy parent record, the guid kept', () => {
    const { record } = parseInstanceRecord(entry({ moved: { 2: G(60) } }), reader(), V15);
    expect(row(record.list.rows, `/${N2}`)?.parent).toBe(G(60));
  });

  it('nestedOverrides[path][lid] → the row keyed through each frame; the inner ROOT is the reference row\'s key', () => {
    const { record } = parseInstanceRecord(entry({
      nestedOverrides: { 3: { 2: { Light: { intensity: 3 } }, 1: { EntityAttributes: { isActive: false } } } },
    }), reader(), V15);
    expect(row(record.list.rows, `/${N3}/${NQ2}`)?.traits).toEqual({ Light: { intensity: 3 } });
    expect(row(record.list.rows, `/${N3}`)?.traits).toEqual({ EntityAttributes: { isActive: false } });
  });

  it('a nested root stated by overrides[lidR] AND nestedOverrides[R][root]: the frame-level value wins', () => {
    const { record } = parseInstanceRecord(entry({
      overrides: { 3: { Transform: { x: 1 } } }, nestedOverrides: { 3: { 1: { Transform: { x: 2, y: 9 } } } },
    }), reader(), V15);
    expect(row(record.list.rows, `/${N3}`)?.traits).toEqual({ Transform: { x: 1, y: 9 } });
  });
});

describe('parseInstanceRecord — pins: whole lists against the chain (§ 5.2)', () => {
  it('nestedStructure slot `removed`: named → removed; removed by the chain and not named → restored', () => {
    const { record } = parseInstanceRecord(entry({ nestedStructure: { 3: { removed: [3], added: [K1()] } } }), reader(), V15);
    expect(row(record.list.rows, `/${N3}/${NQ3}`)?.removed).toBe(true);
    expect(row(record.list.rows, `/${N3}/${NQ2}`)?.removed).toBe(false);
  });

  it('nestedStructure slot `removedTraits`: true per named trait; false per chain removal it does not name', () => {
    const { record } = parseInstanceRecord(entry({ nestedStructure: { 3: { removed: [2], removedTraits: { 2: ['Light'] }, added: [K1()] } } }), reader(), V15);
    expect(row(record.list.rows, `/${N3}/${NQ2}`)?.traitRemovals).toEqual({ Light: true });
    expect(row(record.list.rows, `/${N3}/${NQ3}`)?.traitRemovals).toEqual({ Sprite: false });
  });

  it('nestedStructure slot `added`: a copy of a chain node → its node row (every stated field; an unstated component removed); a chain node it omits → removed; a new node → own', () => {
    const copy: AddedEntity = { parentLocalId: 1, guid: G(70), key: 'k1', name: 'Glow', traits: { Light: { intensity: 9 } }, children: [] };
    const fresh: AddedEntity = { parentLocalId: 1, guid: G(71), name: 'New', traits: {}, children: [] };
    const both = parseInstanceRecord(entry({ nestedStructure: { 3: { removed: [2], added: [copy, fresh] } } }), reader(), V15);
    const r = row(both.record.list.rows, `/${N3}/a+k1`) as SceneTargetRecord;
    expect(r.traits).toEqual({ Light: { intensity: 9 } });
    expect(r.traitRemovals).toEqual({ Sprite: true });
    expect(r.guid).toBe(G(70));
    expect(row(both.record.list.rows, `/${N3}`)?.own).toEqual([{ guid: G(71) }]);
    const none = parseInstanceRecord(entry({ nestedStructure: { 3: { removed: [2], added: [] } } }), reader(), V15);
    expect(row(none.record.list.rows, `/${N3}/a+k1`)?.removed).toBe(true);
  });

  it('a member row\'s whole `added` (v16) pins the chain\'s nodes at that member', () => {
    const copy: AddedEntity = { parentLocalId: 0, guid: G(72), key: 'k1', name: 'Glow', traits: { Light: { intensity: 4 }, Sprite: { tint: '#000' } }, children: [] };
    const { record } = parseInstanceRecord(entry({ members: { [`/${N3}`]: { guid: G(80), added: [copy] } } }), reader(), V15);
    expect(row(record.list.rows, `/${N3}/a+k1`)?.traits).toEqual({ Light: { intensity: 4 }, Sprite: { tint: '#000' } });
    expect(row(record.list.rows, `/${N3}/a+k1`)?.removed).toBeUndefined();
    const empty = parseInstanceRecord(entry({ members: { [`/${N3}`]: { guid: G(80), added: [] } } }), reader(), V15);
    expect(row(empty.record.list.rows, `/${N3}/a+k1`)?.removed).toBe(true);
  });

  it('a member row\'s whole `removedTraits` (v16): named → true; removed by the chain and not named → false', () => {
    const { record } = parseInstanceRecord(entry({ members: { [`/${N3}/${NQ3}`]: { guid: G(81), removedTraits: [] } } }), reader(), V15);
    expect(row(record.list.rows, `/${N3}/${NQ3}`)?.traitRemovals).toEqual({ Sprite: false });
  });
});

describe('parseInstanceRecord — rows and precedence (§ 10.3, § 10.4)', () => {
  it('a row wins over a legacy channel on the same field, and the load warns', () => {
    const { record, warnings } = parseInstanceRecord(entry({
      overrides: { 2: { Sprite: { tint: 'legacy' }, Light: { intensity: 5 } } },
      members: { [`/${N2}`]: { guid: G(82), traits: { Sprite: { tint: 'row' } } } },
    }), reader(), V15);
    expect(row(record.list.rows, `/${N2}`)?.traits).toEqual({ Sprite: { tint: 'row' }, Light: { intensity: 5 } });
    expect(warnings.some((w) => w.code === 'rowWins' && w.key === `/${N2}`)).toBe(true);
  });

  it('a row\'s whole removedTraits replaces the legacy list for that member', () => {
    const { record, warnings } = parseInstanceRecord(entry({
      removedTraits: { 2: ['Light'] }, members: { [`/${N2}`]: { guid: G(83), removedTraits: ['Sprite'] } },
    }), reader(), V15);
    expect(row(record.list.rows, `/${N2}`)?.traitRemovals).toEqual({ Sprite: true });
    expect(warnings.some((w) => w.code === 'rowWins')).toBe(true);
  });

  it('pins are kept verbatim, a gone member\'s included (§ 10.4, L2)', () => {
    const { record } = parseInstanceRecord(entry({ members: { [`/${G(99)}`]: { guid: G(84), name: 'Gone' } } }), reader(), V15);
    expect(row(record.list.rows, `/${G(99)}`)).toEqual({ guid: G(84), name: 'Gone' });
  });

  it('a v17 row carries traitRemovals, own and parent as they are', () => {
    const own: AddedEntity = { parentLocalId: 0, guid: G(85), name: 'Own', traits: {}, children: [] };
    const { record, ownContent } = parseInstanceRecord(entry({
      members: { [`/${N2}`]: { guid: G(86), traitRemovals: { Light: true }, own: [own], parent: G(87) } },
    }), reader(), V15);
    expect(row(record.list.rows, `/${N2}`)).toEqual({ guid: G(86), traitRemovals: { Light: true }, own: [{ guid: G(85) }], parent: G(87) });
    expect(ownContent.get(G(85))).toBe(own);
  });

  it('a hand-written /<row>/<innerRoot> alias is read as /<row>, with a warning (§ 2.1)', () => {
    const { record, warnings } = parseInstanceRecord(entry({ members: { [`/${N3}/${NQ1}`]: { guid: G(88), traits: { Transform: { x: 3 } } } } }), reader(), V15);
    expect(row(record.list.rows, `/${N3}`)?.traits).toEqual({ Transform: { x: 3 } });
    expect(row(record.list.rows, `/${N3}/${NQ1}`)).toBeUndefined();
    expect(warnings.some((w) => w.code === 'aliasCanonicalised')).toBe(true);
  });
});

describe('parseInstanceRecord — the root\'s default overrides (placement)', () => {
  it('sortOrder absent from the entry → the template root\'s, not 0 (§ 10.4, L4)', () => {
    expect(parseInstanceRecord(entry(), reader(), V15).record.placement.sortOrder).toBe(4);
  });

  it('name: the root override, else the entry\'s own name, else the template root\'s (hub ruling 2026-10-02)', () => {
    expect(parseInstanceRecord(entry({ overrides: { 1: { EntityAttributes: { name: 'Ov' } } } }), reader(), V15).record.placement.name).toBe('Ov');
    expect(parseInstanceRecord(entry({ name: 'Live' }), reader(), V15).record.placement.name).toBe('Live');
    expect(parseInstanceRecord(entry({ name: undefined }), reader(), V15).record.placement.name).toBe('Ship');
  });

  it('parent and editorFolder come from the entry\'s EntityAttributes; the entry\'s folder beats the override\'s', () => {
    const { record } = parseInstanceRecord(entry({
      traits: { PrefabInstance: { source: 'P', localId: 1 }, EntityAttributes: { parentId: G(90), editorFolder: 'Fish' } },
      overrides: { 1: { EntityAttributes: { editorFolder: 'Other' } } },
    }), reader(), V15);
    expect(record.placement).toMatchObject({ parent: G(90), editorFolder: 'Fish' });
    expect(row(record.list.rows, '/')).toBeUndefined();
  });

  it('sourceScene: the entry\'s, else the root override\'s; "" is absent, as for editorFolder (writer contract, #2008)', () => {
    const at = (ea: Record<string, unknown>, ov?: Record<string, unknown>) => parseInstanceRecord(entry({
      traits: { PrefabInstance: { source: 'P', localId: 1 }, EntityAttributes: ea }, ...(ov ? { overrides: { 1: { EntityAttributes: ov } } } : {}),
    }), reader(), V15).record;
    expect(at({ sourceScene: 'BASE' }, { sourceScene: 'OV' }).placement.sourceScene).toBe('BASE');
    expect(at({ sourceScene: '' }, { sourceScene: 'OV' }).placement.sourceScene).toBe('OV');
    const none = at({ sourceScene: '', editorFolder: '' });
    expect('sourceScene' in none.placement || 'editorFolder' in none.placement).toBe(false);
    expect(row(at({}, { sourceScene: 'OV' }).list.rows, '/')).toBeUndefined();
  });

  it('#2008 P2 D1: the "/" row\'s root defaults leave the list for the placement, their one home; the row wins over the override', () => {
    const r = parseInstanceRecord(entry({
      overrides: { 1: { EntityAttributes: { name: 'Ov', sortOrder: 2 } } },
      members: { '/': { traits: { EntityAttributes: { name: 'RowName', sortOrder: 6, isActive: false } } } },
    }), reader(), V15).record;
    expect(r.placement).toMatchObject({ name: 'RowName', sortOrder: 6 });
    expect(row(r.list.rows, '/')?.traits).toEqual({ EntityAttributes: { isActive: false } });
    // Emptied, the row itself goes: a v20 renamed root is no list record at all.
    expect(row(parseInstanceRecord(entry({ members: { '/': { traits: { EntityAttributes: { name: 'Only' } } } } }), reader(), V15).record.list.rows, '/')).toBeUndefined();
  });

  it('#2008 P2 D1: the same on the missing-prefab path; a "/" row parentId is held verbatim, as the override\'s is', () => {
    const r = parseInstanceRecord(entry({ members: { '/': { traits: { EntityAttributes: { name: 'RowName', parentId: G(97) } } } } }), reader(new Map()), V15).record;
    expect(r.placement.name).toBe('RowName');
    expect(row(r.list.rows, '/')).toBeUndefined();
    expect(r.held.unparsed).toEqual({ members: { '/': { traits: { EntityAttributes: { parentId: G(97) } } } } });
  });

  it('#2008 P2 D2: a resolved entry\'s stored sortOrder (where v20 writes the placement) beats the template\'s; the override beats it', () => {
    const at = (extra: Partial<SceneEntityEntry>) => parseInstanceRecord(entry({ traits: { PrefabInstance: { source: 'P', localId: 1 }, EntityAttributes: { sortOrder: 91 } }, ...extra }), reader(), V15).record.placement.sortOrder;
    expect(at({})).toBe(91);
    expect(at({ overrides: { 1: { EntityAttributes: { sortOrder: 3 } } } })).toBe(3);
  });

  it('a numeric parentId (files before v12) goes through the caller\'s resolver', () => {
    const { record } = parseInstanceRecord(entry({ traits: { PrefabInstance: { source: 'P' }, EntityAttributes: { parentId: 3 } } }), reader(), { ...V15, parentGuid: (r) => (r === 3 ? G(91) : '') });
    expect(record.placement.parent).toBe(G(91));
  });

  it('the entry\'s legacy root Transform lands under the root override; extra root traits land last', () => {
    const { record } = parseInstanceRecord(entry({
      traits: { PrefabInstance: { source: 'P' }, Transform: { x: 1, y: 2 }, Rotate3D: { speed: 1 } },
      overrides: { 1: { Transform: { x: 5 } } },
    }), reader(), V15);
    expect(row(record.list.rows, '/')?.traits).toEqual({ Transform: { x: 5, y: 2 }, Rotate3D: { speed: 1 } });
  });
});

describe('parseInstanceRecord — what cannot be named is held verbatim (format rule, hub refinement 2026-10-02)', () => {
  it('a value no reader takes → held.unparsed under its channel name', () => {
    const { record } = parseInstanceRecord(entry({ removed: 'x' as unknown as number[] }), reader(), V15);
    expect(record.held.unparsed).toEqual({ removed: 'x' });
  });

  it('a missing prefab: legacy channels held whole; identity rows carried; whole-list rows held; placement from the stored values', () => {
    const { record } = parseInstanceRecord(entry({
      prefab: 'GONE', traits: { PrefabInstance: { source: 'GONE', localId: 1 }, EntityAttributes: { sortOrder: 2 } },
      overrides: { 1: { EntityAttributes: { name: 'Kept' } }, 5: { Light: { intensity: 2 } } },
      members: { [`/${G(20)}`]: { guid: G(21), traits: { Light: { intensity: 3 } } }, [`/${G(22)}`]: { guid: G(23), added: [] } },
    }), reader(), V15);
    expect(record.held.pendingLegacy).toEqual({
      overrides: { 1: { EntityAttributes: { name: 'Kept' } }, 5: { Light: { intensity: 2 } } },
      members: { [`/${G(22)}`]: { guid: G(23), added: [] } },
    });
    expect(row(record.list.rows, `/${G(20)}`)).toEqual({ guid: G(21), traits: { Light: { intensity: 3 } } });
    expect(record.placement).toMatchObject({ name: 'Kept', sortOrder: 2 });
  });

  it('a localId that names no row of a present document → held; an added node on it → re-anchored at "/"', () => {
    const node: AddedEntity = { parentLocalId: 12, guid: G(30), name: 'Stray', traits: {}, children: [] };
    const { record } = parseInstanceRecord(entry({ overrides: { 12: { Light: { intensity: 1 } } }, removed: [12], added: [node] }), reader(), V15);
    expect(record.held.pendingLegacy).toEqual({ overrides: { 12: { Light: { intensity: 1 } } }, removed: [12] });
    expect(row(record.list.rows, '/')?.own).toEqual([{ guid: G(30) }]);
  });

  it('a path through a missing nested prefab is held for that path only', () => {
    const { record } = parseInstanceRecord(entry({
      overrides: { 2: { Light: { intensity: 7 } } }, nestedOverrides: { 3: { 2: { Light: { intensity: 3 } } } },
    }), reader(new Map([['P', P]])), V15);
    expect(record.held.pendingLegacy).toEqual({ nestedOverrides: { 3: { 2: { Light: { intensity: 3 } } } } });
    expect(row(record.list.rows, `/${N2}`)?.traits).toEqual({ Light: { intensity: 7 } });
  });

  it('a scene that held embeddedPrefabs: noted, not read (§ 5.4)', () => {
    const { record, warnings } = parseInstanceRecord(entry(), reader(), { ...V15, sceneHadCopies: true });
    expect(record.held.ignoredCopies).toBe(true);
    expect(warnings.some((w) => w.code === 'ignoredCopies')).toBe(true);
  });
});

describe('parseInstanceRecord — pre-v5 documents (§ 2.7, § 10.5)', () => {
  it('a row with no nodeGuid is keyed by the in-memory derivation, deterministic in (document, localId)', () => {
    const P4: PrefabDoc = { id: 'P4', rootLocalId: 1, entities: P.entities.slice(0, 2).map(({ nodeGuid: _n, ...r }) => r) };
    const { record } = parseInstanceRecord(entry({ prefab: 'P4', overrides: { 2: { Light: { intensity: 2 } } } }), reader(new Map([['P4', P4]])), V15);
    const key = `/${preV5NodeGuid('P4', 2)}`;
    expect(row(record.list.rows, key)?.traits).toEqual({ Light: { intensity: 2 } });
    expect(preV5NodeGuid('P4', 2)).toBe(preV5NodeGuid('P4', 2));
    expect(preV5NodeGuid('P4', 2)).not.toBe(preV5NodeGuid('P4', 3));
  });
});

describe('parseReferenceNode — a nested instance the scene added', () => {
  it('its channels are its own record; root name/sortOrder are its placement', () => {
    const node: AddedEntity = {
      parentLocalId: 2, guid: G(40), name: 'Inner', traits: {}, children: [], prefab: 'Q',
      overrides: { 1: { EntityAttributes: { sortOrder: 2 } }, 2: { Light: { intensity: 4 } } },
    };
    const { record } = parseReferenceNode(node, reader(), { ...V15, parent: G(41) });
    expect(record).toMatchObject({ rootGuid: G(40), source: 'Q', placement: { parent: G(41), sortOrder: 2, name: 'Inner' } });
    expect(row(record.list.rows, `/${NQ2}`)?.traits).toEqual({ Light: { intensity: 4 } });
    expect(row(record.list.rows, '/')).toBeUndefined();
  });
});

describe('a held "/" row still gives up its root defaults (#2008 round 3, D1\'s sibling on the missing-prefab branch)', () => {
  const node: AddedEntity = { parentLocalId: 1, guid: G(54), name: 'N', traits: {}, children: [] };
  const gone = (members: object, extra: Partial<SceneEntityEntry> = {}) => parseInstanceRecord(entry({ prefab: 'GONE', traits: { PrefabInstance: { source: 'GONE', localId: 1 } }, members, ...extra } as never), reader(), V15).record;

  it('the row\'s name is the placement\'s ("/" row > entry name); the remainder is held without it', () => {
    const rec = gone({ '/': { traits: { EntityAttributes: { name: 'Y' } }, added: [] } }, { name: 'X' });
    expect(rec.placement.name).toBe('Y');
    expect(rec.held.pendingLegacy?.members).toEqual({ '/': { added: [] } });
  });

  it('a "/" row with only a whole added list: held as it was, and a write then a reparse states the same record', () => {
    const rec = gone({ '/': { added: [node] } });
    const written = serializeInstanceRecord(rec, { identity: new Map(), sceneOwned: () => undefined }).entry as Record<string, unknown>;
    const again = parseInstanceRecord({ ...written, id: 7, traits: { ...(written.traits as object), PrefabInstance: { source: 'GONE', localId: 1 } } } as never, reader(), V15).record;
    expect(again.held).toEqual(rec.held);
    expect(again.placement).toEqual(rec.placement);
  });
});

describe('a TEMPLATE "/" row held under a missing child keeps its root fields verbatim: a template list has no placement (rule 9)', () => {
  it('held whole, name included', () => {
    const row0 = { '/': { traits: { EntityAttributes: { name: 'Y' } }, added: [] } };
    const { list } = parseTemplateList({ ...P.entities[2]!, members: row0 } as never, reader(new Map([['P', P]])));
    expect(list.held?.pendingLegacy?.members).toEqual(row0);
    expect(list.rows.size).toBe(0);
  });
});

describe('the root row\'s held parentId merges into what unparsed already holds (#2008 round 3)', () => {
  it('a malformed sibling row stays held beside it', () => {
    const { record } = parseInstanceRecord(entry({ members: { '/': { traits: { EntityAttributes: { parentId: 'pp' } } }, '/junk': 'garbage' } as never }), reader(), V15);
    expect((record.held.unparsed as { members: Record<string, unknown> }).members).toEqual({ '/': { traits: { EntityAttributes: { parentId: 'pp' } } }, '/junk': 'garbage' });
  });
});

describe('a scene reference node\'s templateMoved (#2007 review, item 8)', () => {
  const node = (extra: Partial<AddedEntity> = {}): AddedEntity => ({ parentLocalId: 2, guid: G(45), name: 'Inner', traits: {}, children: [], prefab: 'Q', templateMoved: { 2: '@member:3' }, ...extra });

  it('resolved: each move is a parent record carrying its member token, which the fold resolves as a template move', () => {
    const { record } = parseReferenceNode(node(), reader(), V15);
    expect(row(record.list.rows, `/${NQ2}`)?.parent).toBe('@member:3');
    const f = foldInstance(reader(), record, { schema: { component: () => true, field: () => true } });
    expect(f.nodes.get(`/${NQ2}`)?.parent).toEqual({ key: `/${NQ3}` });
  });

  it('missing: held verbatim with the rest (rule 9)', () => {
    expect((parseReferenceNode(node(), reader(new Map()), V15).record.held.pendingLegacy as Record<string, unknown> | undefined)?.templateMoved).toEqual({ 2: '@member:3' });
  });
});

describe('parseTemplateList — a prefab reference row (template form)', () => {
  it('overrides["1"], removed, removedTraits and added → the template list; "/" keeps name and sortOrder (§ 10.4); no pins', () => {
    const { list } = parseTemplateList(P.entities[2]!, reader());
    expect(row(list.rows, '/')?.traits).toEqual({ EntityAttributes: { name: 'Engine', sortOrder: 0 } });
    expect(row(list.rows, `/${NQ2}`)?.removed).toBe(true);
    expect(row(list.rows, `/${NQ3}`)?.traitRemovals).toEqual({ Sprite: true });
    expect(row(list.rows, '/')?.own).toEqual([{ key: 'k1', name: 'Glow', traits: { Light: { intensity: 2 }, Sprite: { tint: '#000' } }, children: [] }]);
    for (const r of list.rows.values()) expect('guid' in r).toBe(false);
  });

  it('a template reference node: its channels become its `members`, its templateMoved a parent token', () => {
    const node: AddedEntity = { parentLocalId: 1, guid: '', key: 'kr', name: 'Ref', traits: {}, children: [], prefab: 'Q', overrides: { 2: { Light: { intensity: 6 } } }, templateMoved: { 2: '@member:3' } };
    const R: PrefabDoc = { id: 'R', rootLocalId: 1, entities: [{ localId: 1, nodeGuid: G(200), traits: {} }, { localId: 2, nodeGuid: G(201), prefab: 'Q', traits: { EntityAttributes: { parentId: 1 } }, added: [node] }] };
    const { list } = parseTemplateList(R.entities[1]!, reader(new Map([['R', R], ['Q', Q]])));
    const tn = row(list.rows, '/')?.own?.[0] as { key: string; members?: Record<string, TemplateTargetRecord> };
    expect(tn.key).toBe('kr');
    expect(tn.members?.[`/${NQ2}`]).toEqual({ traits: { Light: { intensity: 6 } }, parent: '@member:3' });
  });

  it('a document-level `moved` (prefab v4) lands on the reference row whose frame holds the member, the token rebased one frame up', () => {
    const PM: PrefabDoc = { ...P, id: 'PM', moved: { '3.2': '@member:2', '2': '@member:3' } };
    const { rows, docHeld } = parseTemplateLists(PM, 'PM', reader(new Map([['PM', PM], ['Q', Q]])));
    expect(row(rows.get(3)!.list.rows, `/${NQ2}`)?.parent).toBe('@member:^.2');
    expect(docHeld).toEqual({ moved: { 2: '@member:3' } });
  });

  it('held (hub ruling 2026-10-02): a row whose nested prefab is missing keeps its channels verbatim in `list.held`', () => {
    const { list } = parseTemplateList(P.entities[2]!, reader(new Map([['P', P]])));
    expect(list.held?.pendingLegacy).toMatchObject({ overrides: { 1: { EntityAttributes: { name: 'Engine' } } }, removed: [2], removedTraits: { 3: ['Sprite'] } });
    expect(list.held && 'heldOwn' in list.held).toBe(false);
    // Resolved, nothing is held: the slot is absent, not an empty bag.
    expect(parseTemplateList(P.entities[2]!, reader()).list.held).toBeUndefined();
  });

  it('held: a template value in no shape a reader takes goes to `list.held.unparsed`', () => {
    const { list } = parseTemplateList({ ...P.entities[2]!, removed: 'x' as never }, reader());
    expect(list.held?.unparsed).toEqual({ removed: 'x' });
  });

  it('held: a template reference node whose prefab is missing keeps its channels on the node', () => {
    const node: AddedEntity = { parentLocalId: 1, guid: '', key: 'kr', name: 'Ref', traits: {}, children: [], prefab: 'GONE', overrides: { 2: { Light: { intensity: 6 } } } };
    const R: PrefabDoc = { id: 'R', rootLocalId: 1, entities: [{ localId: 1, nodeGuid: G(200), traits: {} }, { localId: 2, nodeGuid: G(201), prefab: 'Q', traits: { EntityAttributes: { parentId: 1 } }, added: [node] }] };
    const { list } = parseTemplateList(R.entities[1]!, reader(new Map([['R', R], ['Q', Q]])));
    const tn = row(list.rows, '/')?.own?.[0] as { held?: { pendingLegacy?: unknown } };
    expect(tn.held?.pendingLegacy).toEqual({ overrides: { 2: { Light: { intensity: 6 } } } });
  });

  it('a legacy KEYED move (#1883 ruling C) is kept as a parent on the node row', () => {
    const node: AddedEntity = { parentLocalId: 1, guid: '', key: 'kr', name: 'Ref', traits: {}, children: [], prefab: 'Q', added: [K1()], templateMoved: { '+k1': '@member:2' } };
    const R: PrefabDoc = { id: 'R', rootLocalId: 1, entities: [{ localId: 1, nodeGuid: G(200), traits: {} }, { localId: 2, nodeGuid: G(201), prefab: 'Q', traits: { EntityAttributes: { parentId: 1 } }, added: [node] }] };
    const { list } = parseTemplateList(R.entities[1]!, reader(new Map([['R', R], ['Q', Q]])));
    const tn = row(list.rows, '/')?.own?.[0] as { members?: Record<string, TemplateTargetRecord> };
    expect(tn.members?.['/a+k1']?.parent).toBe('@member:2');
  });
});

describe('parseInstanceRecord gap B — a scene-added node that states no guid (rule 5, hub 2026-10-02, re-ruled)', () => {
  const bare = (name: string, parentLocalId: number): AddedEntity => ({ parentLocalId, guid: '', name, traits: {}, children: [] });
  const linked = (e: SceneEntityEntry, key: string, opts: Partial<ParseOptions> = {}): string[] =>
    ((parseInstanceRecord(JSON.parse(JSON.stringify(e)) as SceneEntityEntry, reader(), { ...V15, ...opts }).record.list.rows.get(key) as SceneTargetRecord | undefined)?.own ?? []).map((r) => r.guid);

  it('is linked by a derived guid: non-empty, the same on every parse of the same file, different per anchor', () => {
    const e = entry({ added: [bare('AtRoot', 1), bare('AtHull', 2)] });
    const [atRoot] = linked(e, '/');
    const [atHull] = linked(e, `/${N2}`);
    expect(atRoot).toMatch(/^[0-9a-f]{8}-/);
    expect(linked(e, '/')).toEqual([atRoot]);
    expect(linked(e, `/${N2}`)).toEqual([atHull]);
    expect(atRoot).not.toBe(atHull);
    // Keyed by its own anchor, not by what else the file adds elsewhere: alone, the Hull node links the same guid.
    expect(linked(entry({ added: [bare('AtHull', 2)] }), `/${N2}`)).toEqual([atHull]);
  });

  it('the content handed to the first projection carries the derived guid', () => {
    const e = entry({ added: [bare('AtRoot', 1)] });
    const { record, ownContent } = parseInstanceRecord(e, reader(), V15);
    const g = (record.list.rows.get('/') as SceneTargetRecord).own![0]!.guid;
    expect(ownContent.get(g)?.name).toBe('AtRoot');
  });

  it('two at one anchor never share a guid (#1882: the second moves)', () => {
    const [a, b] = linked(entry({ added: [bare('First', 2), bare('Second', 2)] }), `/${N2}`);
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it('never takes a guid the file or the scene already holds: the NEW node moves, the holder keeps its guid', () => {
    const plain = linked(entry({ added: [bare('N', 2)] }), `/${N2}`)[0]!;
    // The same guid pinned by a member row of this file …
    const e = entry({ added: [bare('N', 2)], members: { [`/${N3}`]: { guid: plain } } });
    const { record } = parseInstanceRecord(e, reader(), V15);
    expect((record.list.rows.get(`/${N2}`) as SceneTargetRecord).own![0]!.guid).not.toBe(plain);
    expect((record.list.rows.get(`/${N3}`) as SceneTargetRecord).guid).toBe(plain);
    // … or held by another entity of the scene.
    expect(linked(entry({ added: [bare('N', 2)] }), `/${N2}`, { held: (g: string) => g === plain })[0]).not.toBe(plain);
  });
});

describe('parseTemplateList gap A — a template-form copy erasing a chain reference node\'s values (rule 1 + rule 6, hub 2026-10-02)', () => {
  // R (a row of the owner's document) instances Q2. Q2's row S instances Z; S's own template list adds reference node kn
  // (instancing W) and sets W-2's Light to 5. R's slot at S restates kn WITHOUT that value: today the copy replaces kn
  // wholesale, so W-2 shows W's own value, 1.
  const W: PrefabDoc = { id: 'W', rootLocalId: 1, entities: [
    { localId: 1, nodeGuid: G(301), traits: {} },
    { localId: 2, nodeGuid: G(302), traits: { EntityAttributes: { parentId: 1 }, Light: { intensity: 1 } } },
  ] };
  const Z: PrefabDoc = { id: 'Z', rootLocalId: 1, entities: [{ localId: 1, nodeGuid: G(311), traits: {} }] };
  const kn = (overrides?: AddedEntity['overrides']): AddedEntity => ({ parentLocalId: 1, guid: '', key: 'kn', name: 'Kn', traits: {}, children: [], prefab: 'W', ...(overrides ? { overrides } : {}) });
  const Q2: PrefabDoc = { id: 'Q2', rootLocalId: 1, entities: [
    { localId: 1, nodeGuid: G(321), traits: {} },
    { localId: 4, nodeGuid: G(324), prefab: 'Z', traits: { EntityAttributes: { parentId: 1 } }, added: [kn({ 2: { Light: { intensity: 5 } } })] },
  ] };
  const m = new Map<string, PrefabDoc>([['W', W], ['Z', Z], ['Q2', Q2]]);
  const owner = (copy: AddedEntity) => ({ localId: 9, nodeGuid: G(330), prefab: 'Q2', traits: {}, nestedStructure: { 4: { added: [copy] } } });
  const target = `/${G(324)}/a+kn/${G(302)}`;

  it('a value the copy does not restate is recorded with the value it shows today, and the load warns', () => {
    const { list, warnings } = parseTemplateList(owner(kn()), reader(m));
    expect(list.rows.get(target)?.traits).toEqual({ Light: { intensity: 1 } });
    expect(warnings.some((w) => w.message.includes('gap A') && w.message.includes('Light.intensity'))).toBe(true);
  });

  it('a copy whose chain node\'s prefab is missing, or carrying a statement that names nothing, is held as a REMAINDER of the slot (HELD_REMAINDER)', () => {
    const noW = new Map<string, PrefabDoc>([['Z', Z], ['Q2', Q2]]);
    expect(parseTemplateList(owner(kn()), reader(noW)).list.held?.pendingLegacy?.nestedStructure).toEqual({ 4: { added: [kn()], [HELD_REMAINDER]: true } });
    const dangling = { ...kn(), removed: [99] };
    expect(parseTemplateList(owner(dangling), reader(m)).list.held?.pendingLegacy?.nestedStructure).toEqual({ 4: { added: [dangling], [HELD_REMAINDER]: true } });
  });

  it('a value the copy restates is the copy\'s, with no warning', () => {
    const { list, warnings } = parseTemplateList(owner(kn({ 2: { Light: { intensity: 8 } } })), reader(m));
    expect(list.rows.get(target)?.traits).toEqual({ Light: { intensity: 8 } });
    expect(warnings.some((w) => w.message.includes('gap A'))).toBe(false);
  });
});

describe('a held REMAINDER of a whole list keeps its meaning on reload (hub ruling 2026-10-02, #2006, option C)', () => {
  const all = { component: () => true, field: () => true };
  /** One save→reload: parse, write with the S3 writer, and hand the written entry back as a file states it. */
  const save = (e: SceneEntityEntry, m = docs) => {
    const parsed = parseInstanceRecord(e, reader(m), V15), rec = parsed.record;
    // The scene-owned content the editor holds for each linked node: what this parse read.
    const written = serializeInstanceRecord(rec, { identity: new Map(), sceneOwned: (g) => parsed.ownContent.get(g) }).entry as Record<string, unknown>;
    return { rec, file: { ...written, id: 7, traits: { ...(written.traits as object), PrefabInstance: { source: e.prefab, localId: 1 } } } as unknown as SceneEntityEntry };
  };
  const view = (e: SceneEntityEntry, m = docs) => {
    const f = foldInstance(reader(m), parseInstanceRecord(e, reader(m), V15).record, { schema: all });
    return Object.fromEntries([...f.nodes].map(([k, n]) => [k, { parent: n.parent, traits: n.traits }]));
  };
  /** Two save→reload cycles: what shows never changes, and the second and third writes are byte-identical. */
  const cycles = (e: SceneEntityEntry, m = docs) => {
    const a = save(e, m), b = save(a.file, m), c = save(b.file, m);
    expect(view(a.file, m)).toEqual(view(e, m));
    expect(view(b.file, m)).toEqual(view(e, m));
    expect(JSON.stringify(c.file)).toBe(JSON.stringify(b.file));
    expect(JSON.stringify(b.file)).toBe(JSON.stringify(a.file));
    return a;
  };

  it('a slot whose removed names a gone member (99): only 99 is held, marked; on reload 2 stays removed and no other chain node goes', () => {
    const e = entry({ nestedStructure: { 3: { removed: [99, 2], added: [K1({ traits: { Light: { intensity: 5 } } })], removedTraits: { 3: ['Sprite'] } } } });
    const a = cycles(e);
    expect(a.rec.held.pendingLegacy?.nestedStructure).toEqual({ 3: { removed: [99], [HELD_REMAINDER]: true } });
    const shown = view(a.file);
    expect(shown[`/${N3}/${NQ2}`]).toBeUndefined();
    expect(shown[`/${N3}/${NQ3}`]).toBeDefined();
    expect(shown[`/${N3}/a+k1`]?.traits.Light).toEqual({ intensity: 5 });
  });

  it('a slot whose only remainder is a move of a gone member: held, marked; on reload the slot\'s lists still stand', () => {
    const e = entry({ nestedStructure: { 3: { removed: [2], added: [K1()], removedTraits: { 3: ['Sprite'] }, moved: { 99: G(70) } } } });
    const a = cycles(e);
    expect(a.rec.held.pendingLegacy?.nestedStructure).toEqual({ 3: { moved: { 99: G(70) }, [HELD_REMAINDER]: true } });
    const shown = view(a.file);
    expect(shown[`/${N3}/${NQ2}`]).toBeUndefined();
    expect(shown[`/${N3}/a+k1`]).toBeDefined();
  });

  it('a row\'s whole added list where one copy waits on a missing prefab (#2008 P2): the copy is held, marked; its customised sibling survives', () => {
    const KR: AddedEntity = { parentLocalId: 1, guid: '', key: 'kr', name: 'Ref', prefab: 'M-missing', traits: {}, children: [] };
    const PM: PrefabDoc = { ...P, entities: P.entities.map((x) => (x.localId === 3 ? { ...x, added: [K1(), KR] } : x)) };
    const m = new Map<string, PrefabDoc>([['P', PM], ['Q', Q]]);
    const e = entry({ members: { [`/${N3}`]: { added: [{ ...KR, name: 'Ref2' }, K1({ traits: { Light: { intensity: 9 } } })] } } as never });
    const a = cycles(e, m);
    expect(a.rec.held.pendingLegacy?.members).toEqual({ [`/${N3}`]: { added: [{ ...KR, name: 'Ref2' }], [HELD_REMAINDER]: true } });
    expect(view(a.file, m)[`/${N3}/a+k1`]?.traits.Light).toEqual({ intensity: 9 });
  });

  it('the marker scopes to the row\'s added: a row written with own beside the held remainder keeps both (#2008 round 3)', () => {
    const KR: AddedEntity = { parentLocalId: 1, guid: '', key: 'kr', name: 'Ref', prefab: 'M-missing', traits: {}, children: [] };
    const PM: PrefabDoc = { ...P, entities: P.entities.map((x) => (x.localId === 3 ? { ...x, added: [K1(), KR] } : x)) };
    const m = new Map<string, PrefabDoc>([['P', PM], ['Q', Q]]);
    const fresh: AddedEntity = { parentLocalId: 1, guid: G(53), name: 'Fresh', traits: {}, children: [] };
    const a = cycles(entry({ members: { [`/${N3}`]: { added: [KR, K1(), fresh] } } as never }), m);
    const written = (a.file as unknown as { members: Record<string, Record<string, unknown>> }).members[`/${N3}`]!;
    expect(written[HELD_REMAINDER]).toBe(true);
    expect(written.own).toBeDefined();
    const f = foldInstance(reader(m), parseInstanceRecord(a.file, reader(m), V15).record, { schema: all });
    expect(f.anchors.get(`/${N3}`)).toEqual([{ guid: G(53) }]);
  });

  it('the marker is what makes it additive: the same held slot WITHOUT it is a whole list again (today\'s v19 meaning)', () => {
    const marked = entry({ nestedStructure: { 3: { removed: [99], [HELD_REMAINDER]: true } as never } });
    const bare = entry({ nestedStructure: { 3: { removed: [99] } } });
    expect(view(marked)[`/${N3}/a+k1`]).toBeDefined();
    expect(view(bare)[`/${N3}/a+k1`]).toBeUndefined();
    // An element of a marked remainder that NOW names a chain node converts (the prefab gained it back).
    const named = view(entry({ nestedStructure: { 3: { removed: [3], [HELD_REMAINDER]: true } as never } }));
    expect(named[`/${N3}/${NQ3}`]).toBeUndefined();
    expect(named[`/${N3}/a+k1`]).toBeDefined();
  });

  it('a row remainder replaces nothing: legacy nodes at the same anchor stay', () => {
    const legacy: AddedEntity = { parentLocalId: 2, guid: G(50), name: 'Old', traits: {}, children: [] };
    const p = parseInstanceRecord(entry({ added: [legacy], members: { [`/${N2}`]: { added: [], [HELD_REMAINDER]: true } } as never }), reader(), V15);
    expect(row(p.record.list.rows, `/${N2}`)?.own).toEqual([{ guid: G(50) }]);
  });

  it('a reference copy carrying templateMoved is held whole, as a remainder: its tokens are written from the copy\'s frame (item 8)', () => {
    const KR: AddedEntity = { parentLocalId: 1, guid: '', key: 'kr', name: 'Ref', prefab: 'Q', traits: {}, children: [] };
    const PM: PrefabDoc = { ...P, entities: P.entities.map((x) => (x.localId === 3 ? { ...x, added: [K1(), KR] } : x)) };
    const m = new Map<string, PrefabDoc>([['P', PM], ['Q', Q]]);
    const moved = { ...KR, templateMoved: { 2: '@member:3' } };
    const { record } = parseInstanceRecord(entry({ members: { [`/${N3}`]: { added: [moved, K1()] } } as never }), reader(m), V15);
    expect(record.held.pendingLegacy?.members).toEqual({ [`/${N3}`]: { added: [moved], [HELD_REMAINDER]: true } });
  });
});

describe('values in no shape a reader takes are kept verbatim, never dropped (I18; close-out review, #2008)', () => {
  it('a slot\'s removedTraits list given as a bare string (splitMalformedChannels does not look inside a slot): held, not split into characters', () => {
    const { record } = parseInstanceRecord(entry({ nestedStructure: { 3: { removed: [2], added: [K1()], removedTraits: { 3: 'Sprite' as never } } } }), reader(), V15);
    expect(row(record.list.rows, `/${N3}/${NQ3}`)?.traitRemovals).toEqual({ Sprite: false });
    expect(record.held.pendingLegacy?.nestedStructure).toEqual({ 3: { removedTraits: { 3: 'Sprite' }, [HELD_REMAINDER]: true } });
    // At top level the shared splitter already takes it (unparsed).
    expect(parseInstanceRecord(entry({ removedTraits: { 2: 'Light' as never } }), reader(), V15).record.held.unparsed).toEqual({ removedTraits: { 2: 'Light' } });
  });

  it('a row\'s whole added list replaces the legacy nodes at its anchor, and their content goes with them (no unlinked content)', () => {
    const legacy: AddedEntity = { parentLocalId: 2, guid: G(48), name: 'Old', traits: {}, children: [] };
    const fresh: AddedEntity = { parentLocalId: 2, guid: G(49), name: 'New', traits: {}, children: [] };
    const p = parseInstanceRecord(entry({ added: [legacy], members: { [`/${N2}`]: { added: [fresh] } } as never }), reader(), V15);
    expect(row(p.record.list.rows, `/${N2}`)?.own).toEqual([{ guid: G(49) }]);
    expect([...p.ownContent.keys()]).toEqual([G(49)]);
  });

  it('a member row\'s removedTraits given as a bare string: unparsed, not dropped (the shared splitter takes it)', () => {
    const { record } = parseInstanceRecord(entry({ members: { [`/${N2}`]: { guid: G(52), removedTraits: 'Light' } } as never }), reader(), V15);
    expect(record.held.unparsed).toEqual({ members: { [`/${N2}`]: { removedTraits: 'Light' } } });
  });

  it('a member row\'s non-boolean traitRemovals value: unparsed; its boolean siblings convert', () => {
    const { record } = parseInstanceRecord(entry({ members: { [`/${N2}`]: { guid: G(46), traitRemovals: { Sprite: 'yes', Light: true } } } as never }), reader(), V15);
    expect(row(record.list.rows, `/${N2}`)?.traitRemovals).toEqual({ Light: true });
    expect(record.held.unparsed).toEqual({ members: { [`/${N2}`]: { traitRemovals: { Sprite: 'yes' } } } });
  });

  it('a non-record templateMoved on a reference node, and on a template reference node: unparsed', () => {
    const node: AddedEntity = { parentLocalId: 2, guid: G(47), name: 'Inner', traits: {}, children: [], prefab: 'Q', templateMoved: 'x' as never };
    expect(parseReferenceNode(node, reader(), V15).record.held.unparsed).toEqual({ templateMoved: 'x' });
    const R: PrefabDoc = { id: 'R', rootLocalId: 1, entities: [{ localId: 1, nodeGuid: G(200), traits: {} }, { localId: 2, nodeGuid: G(201), prefab: 'Q', traits: { EntityAttributes: { parentId: 1 } }, added: [{ ...node, guid: '', key: 'kr', parentLocalId: 1 }] }] };
    const tn = row(parseTemplateList(R.entities[1]!, reader(new Map([['R', R], ['Q', Q]]))).list.rows, '/')?.own?.[0] as { held?: { unparsed?: unknown } };
    expect(tn.held).toEqual({ unparsed: { templateMoved: 'x' } });
  });

  it('a non-record document-level moved: held at document level as unparsed', () => {
    expect(parseTemplateLists({ ...P, id: 'PX', moved: 'x' as never }, 'PX', reader()).docHeld).toEqual({ unparsed: { moved: 'x' } });
  });
});

describe('a v20 entry\'s own name is not read: the "/" row is the root name\'s one home (hub ruling 2026-10-02, P11)', () => {
  const named = entry({ name: 'X', traits: { PrefabInstance: { source: 'P', localId: 1 }, EntityAttributes: { name: 'X' } } });

  it('no "/" name: the template root\'s, with a warning; before v20 the entry\'s name still reads', () => {
    const v20 = parseInstanceRecord(named, reader(), { sceneVersion: 20 });
    expect(v20.record.placement.name).toBe('Ship');
    expect(v20.warnings.some((w) => w.code === 'rootNameMissing')).toBe(true);
    const v19 = parseInstanceRecord(named, reader(), { sceneVersion: 19 });
    expect(v19.record.placement.name).toBe('X');
    expect(v19.warnings.some((w) => w.code === 'rootNameMissing')).toBe(false);
  });

  it('a "/" name is the name, with no warning', () => {
    const p = parseInstanceRecord({ ...named, members: { '/': { traits: { EntityAttributes: { name: 'Y' } } } } } as never, reader(), { sceneVersion: 20 });
    expect(p.record.placement.name).toBe('Y');
    expect(p.warnings.some((w) => w.code === 'rootNameMissing')).toBe(false);
  });

  it('missing prefab: neither the entry\'s name nor its stored name reads in v20', () => {
    const gone = { ...named, prefab: 'GONE', traits: { PrefabInstance: { source: 'GONE', localId: 1 }, EntityAttributes: { name: 'X' } } } as never;
    expect(parseInstanceRecord(gone, reader(), { sceneVersion: 20 }).record.placement.name).toBe('Missing Prefab');
    expect(parseInstanceRecord(gone, reader(), V15).record.placement.name).toBe('X');
  });
});

describe('close-out review round 2 (parser)', () => {
  const noQ = reader(new Map([['P', P]]));
  it('a row\'s whole lists under a missing frame are held verbatim (marker kept), and read back against the chain once it returns', () => {
    const e = entry({ members: { [`/${N3}`]: { added: [K1({ traits: { Light: { intensity: 7 } } })] }, [`/${N3}/${NQ3}`]: { removedTraits: [] } } as never });
    const r = parseInstanceRecord(e, noQ, V15).record;
    expect(r.held.pendingLegacy?.members).toEqual({ [`/${N3}`]: { added: [K1({ traits: { Light: { intensity: 7 } } })] }, [`/${N3}/${NQ3}`]: { removedTraits: [] } });
    expect(row(r.list.rows, `/${N3}`)?.own).toBeUndefined();
    const marked = parseInstanceRecord(entry({ members: { [`/${N3}`]: { added: [K1()], [HELD_REMAINDER]: true } } as never }), noQ, V15).record;
    expect(marked.held.pendingLegacy?.members).toEqual({ [`/${N3}`]: { added: [K1()], [HELD_REMAINDER]: true } });
  });

  it('v20: the stored order (the placement) outranks a held legacy root override; before v20 the override wins', () => {
    const e = entry({ traits: { PrefabInstance: { source: 'P', localId: 1 }, EntityAttributes: { sortOrder: 7 } }, overrides: { 1: { EntityAttributes: { sortOrder: 3 } } } });
    expect(parseInstanceRecord(e, reader(), { sceneVersion: 20 }).record.placement.sortOrder).toBe(7);
    expect(parseInstanceRecord(e, reader(), V15).record.placement.sortOrder).toBe(3);
  });

  it('a reference copy with a malformed channel is held whole, not read lossily', () => {
    const PM: PrefabDoc = { ...P, entities: P.entities.map((x) => (x.localId === 3 ? { ...x, added: [K1({ prefab: 'Q' })] } : x)) };
    const m = new Map<string, PrefabDoc>([['P', PM], ['Q', Q]]);
    const bad = K1({ prefab: 'Q', overrides: { 2: { Light: 5 } } as never });
    const r = parseInstanceRecord(entry({ members: { [`/${N3}`]: { added: [bad] } } as never }), reader(m), V15).record;
    expect(r.held.pendingLegacy?.members).toEqual({ [`/${N3}`]: { added: [bad], [HELD_REMAINDER]: true } });
    const badRow = K1({ prefab: 'Q', members: { junk: {} } as never });
    expect(parseInstanceRecord(entry({ members: { [`/${N3}`]: { added: [badRow] } } as never }), reader(m), V15).record.held.pendingLegacy?.members).toEqual({ [`/${N3}`]: { added: [badRow], [HELD_REMAINDER]: true } });
  });

  it('a members key no reader takes, or a row that is not a record: kept in unparsed, not skipped', () => {
    const r = parseInstanceRecord(entry({ members: { junk: { guid: 'x' }, [`/${N2}`]: 'nope' } as never }), reader(), V15).record;
    expect(r.held.unparsed).toEqual({ members: { junk: { guid: 'x' }, [`/${N2}`]: 'nope' } });
  });
});

describe('close-out review round 3 (parser)', () => {
  it('template form: a row keyed through the owner\'s own template-added node is not held (no chain lists that node)', () => {
    const W: PrefabDoc = { id: 'W', rootLocalId: 1, entities: [{ localId: 1, nodeGuid: G(301), traits: {} }, { localId: 2, nodeGuid: G(302), traits: { EntityAttributes: { parentId: 1 } } }] };
    const KR: AddedEntity = { parentLocalId: 1, guid: '', key: 'kr', name: 'Ref', prefab: 'W', traits: {}, children: [] };
    const Z: AddedEntity = { parentLocalId: 0, guid: '', key: 'z', name: 'Zed', traits: {}, children: [] };
    const owner = { ...P.entities[2]!, added: [K1(), KR], members: { [`/a+kr/${G(302)}`]: { added: [Z] } } };
    const { list } = parseTemplateList(owner as never, reader(new Map<string, PrefabDoc>([['P', P], ['Q', Q], ['W', W]])));
    expect(list.held?.pendingLegacy).toBeUndefined();
  });

  it('a bad members row keeps every part of it, including a part the shared splitter moved out first', () => {
    const r = parseInstanceRecord(entry({ members: { junk: { guid: 'x', traits: { Light: 5 } } } as never }), reader(), V15).record;
    expect(r.held.unparsed).toEqual({ members: { junk: { guid: 'x', traits: { Light: 5 } } } });
    const r2 = parseInstanceRecord(entry({ members: { [`/${N2}`]: { traits: { Light: 5 }, traitRemovals: { Sprite: 'x' } } } as never }), reader(), V15).record;
    expect(r2.held.unparsed).toEqual({ members: { [`/${N2}`]: { traits: { Light: 5 }, traitRemovals: { Sprite: 'x' } } } });
  });
});

describe('close-out review round 4 (parser)', () => {
  it('a whole-list row at a gone member is held verbatim: no template copy pinned as a scene-owned node, no restore dropped', () => {
    const copy = K1({ guid: G(60) });
    const mine: AddedEntity = { parentLocalId: 1, guid: G(61), name: 'Mine', traits: {}, children: [] };
    const r = parseInstanceRecord(entry({ members: { [`/${N3}/${G(999)}`]: { added: [copy, mine], removedTraits: [] } } as never }), reader(), V15);
    expect(r.record.held.pendingLegacy?.members).toEqual({ [`/${N3}/${G(999)}`]: { added: [copy, mine], removedTraits: [] } });
    expect(r.ownContent.has(G(60))).toBe(false);
    expect(row(r.record.list.rows, `/${N3}/${G(999)}`)?.own).toBeUndefined();
  });
});

describe('hub ruling (a), #1831 hunt seed 7078a: a scene-added reference node at an unresolved placeholder', () => {
  it('whose own prefab resolves gets its own record; its link stays held; one anchored inside the missing frame waits', () => {
    const QR = { parentLocalId: 1, guid: G(71), name: 'QR', prefab: 'Q', traits: {}, children: [] };
    const QIn = { parentLocalId: 2, guid: G(72), name: 'QIn', prefab: 'Q', traits: {}, children: [] };
    const QGone = { parentLocalId: 1, guid: G(73), name: 'QGone', prefab: 'Q-missing', traits: {}, children: [] };
    const e = { id: 9, name: 'HR', prefab: 'H-trashed', guid: G(70), traits: { PrefabInstance: { source: 'H-trashed', localId: 1 } }, added: [QR, QIn, QGone] } as never;
    const r = parseInstanceRecord(e, reader(), V15);
    expect([...r.ownContent.keys()]).toEqual([G(71)]);
    expect(r.record.held.pendingLegacy?.added).toEqual([QR, QIn, QGone]);
    const own = parseReferenceNode(r.ownContent.get(G(71)) as never, reader(), V15);
    expect(own.record.source).toBe('Q');
    expect(own.record.held.pendingLegacy).toBeUndefined();
    // The v16 row form at the root: the same.
    const row = parseInstanceRecord({ id: 9, name: 'HR', prefab: 'H-trashed', guid: G(70), traits: { PrefabInstance: { source: 'H-trashed', localId: 1 } }, members: { '/': { added: [QR] } } } as never, reader(), V15);
    expect([...row.ownContent.keys()]).toEqual([G(71)]);
  });
});

describe('close-out review: a scene REFERENCE node keeps #2019 beside and #2020 stray holds (only the token hold is entry-only)', () => {
  const RN = (extra: object) => ({ parentLocalId: 0, guid: G(95), name: 'RN', prefab: 'P', traits: {}, children: [], ...extra }) as never;
  const n = (k: number) => ({ parentLocalId: 3, guid: G(k), name: `N${k}`, traits: {}, children: [] });
  it('#2019: before v20 a legacy node at the nested root sits beside the row\'s whole list', () => {
    const r = parseReferenceNode(RN({ added: [n(96)], members: { [`/${N3}`]: { added: [n(97)] } } }), reader(), V15);
    expect((row(r.record.list.rows, `/${N3}`)?.own ?? []).map((o) => (o as { guid: string }).guid).sort()).toEqual([G(96), G(97)].sort());
  });
  it('#2020: a whole removedTraits row on a plain template-added node is held, not applied', () => {
    const r = parseReferenceNode(RN({ members: { [`/${N3}/a+k1`]: { removedTraits: ['Light'] } } }), reader(), { sceneVersion: 20 });
    expect(r.record.held.pendingLegacy?.members).toEqual({ [`/${N3}/a+k1`]: { removedTraits: ['Light'] } });
  });
  it('a row and its alias at one nested root: the same nodes whichever comes first', () => {
    const alias = `/${N3}/${NQ1}`;
    const own = (members: object) => (row(parseInstanceRecord(entry({ added: [n(98)], members } as never), reader(), V15).record.list.rows, `/${N3}`)?.own ?? []).map((o) => (o as { guid: string }).guid).sort();
    expect(own({ [`/${N3}`]: { added: [n(97)] }, [alias]: { added: [n(99)] } })).toEqual(own({ [alias]: { added: [n(99)] }, [`/${N3}`]: { added: [n(97)] } }));
    // A row's own links too: the canonical row's `own` survives an alias's whole list after it.
    expect(own({ [`/${N3}`]: { own: [n(96)] }, [alias]: { added: [n(99)] } })).toContain(G(96));
  });
});
