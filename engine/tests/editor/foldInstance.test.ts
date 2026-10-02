/** `foldInstance` (#2001 S2, #2007): the pure fold, case by case. Pure — in-memory documents, a reader and an injected
 *  schema, no world. The end-to-end proof (the fold equals what today's spawner spawns, over the corpus and the fuzzer's
 *  saved scenes) is the oracle, `foldInstanceOracle.test.ts`. */
import { describe, it, expect } from 'vitest';
import { foldInstance, type FoldSchema } from '../../packages/modoki/src/runtime/prefab/foldInstance';
import { parseInstanceRecord, memberIdentities } from '../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import { memberToken } from '../../packages/modoki/src/runtime/core/templateRefs';
import { parseSteps } from '../../packages/modoki/src/runtime/core/assetRefRules';
import type { PrefabDoc, PrefabReader, InstanceRecord } from '../../packages/modoki/src/runtime/prefab/instanceRecord';
import type { AddedEntity, SceneEntityEntry } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';

const G = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000002007`;
const N1 = G(1), N2 = G(2), N3 = G(3), NQ1 = G(11), NQ2 = G(12), NQ3 = G(13);
const ROOT = G(100);
const REGISTERED = new Set(['EntityAttributes', 'Transform', 'Sprite', 'Light', 'Ref']);
const schema: FoldSchema = { component: (n) => REGISTERED.has(n), field: (t, f) => !(t === 'Sprite' && f === 'stale') };

const Q: PrefabDoc = {
  id: 'Q', rootLocalId: 1, entities: [
    { localId: 1, nodeGuid: NQ1, traits: { EntityAttributes: { name: 'QRoot', sortOrder: 0 } } },
    { localId: 2, nodeGuid: NQ2, traits: { EntityAttributes: { name: 'Lamp', parentId: 1 }, Light: { intensity: 1 }, Ref: { to: '@member:3' } } },
    { localId: 3, nodeGuid: NQ3, traits: { EntityAttributes: { name: 'Deco', parentId: 1 }, Sprite: { tint: '#fff' } } },
  ],
};
const K1: AddedEntity = { parentLocalId: 1, guid: '', key: 'k1', name: 'Glow', traits: { EntityAttributes: { name: 'Glow' }, Light: { intensity: 2 } }, children: [] };
const P: PrefabDoc = {
  id: 'P', rootLocalId: 1, entities: [
    { localId: 1, nodeGuid: N1, traits: { EntityAttributes: { name: 'Ship', sortOrder: 4 }, Transform: { x: 0 } } },
    { localId: 2, nodeGuid: N2, traits: { EntityAttributes: { name: 'Hull', parentId: 1 }, Sprite: { tint: '#fff' }, Light: { intensity: 1 } } },
    {
      localId: 3, nodeGuid: N3, prefab: 'Q', traits: { EntityAttributes: { name: 'Engine', parentId: 1 } },
      overrides: { 1: { EntityAttributes: { name: 'Engine', sortOrder: 1 } } }, removed: [2], removedTraits: { 3: ['Sprite'] }, added: [K1],
    },
  ],
};
const docs = new Map<string, PrefabDoc>([['P', P], ['Q', Q]]);
const reader = (m: Map<string, PrefabDoc> = docs): PrefabReader => (g) => (m.has(g) ? { doc: m.get(g)! } : { missing: true });
const entry = (extra: Partial<SceneEntityEntry> = {}): SceneEntityEntry => ({
  id: 7, name: 'Ship', prefab: 'P', guid: ROOT, traits: { PrefabInstance: { source: 'P', localId: 1 } }, ...extra,
});
const fold = (e: SceneEntityEntry, m = docs) => {
  const rec: InstanceRecord = parseInstanceRecord(e, reader(m), { sceneVersion: 15 }).record;
  return foldInstance(reader(m), rec, { schema });
};
const causes = (f: ReturnType<typeof fold>) => f.unused.map((u) => `${u.key} ${u.part.kind}${'trait' in u.part ? `:${u.part.trait}` : ''}${'field' in u.part ? `.${u.part.field}` : ''} ${u.cause}`);

describe('foldInstance — the chain (§ 2.4)', () => {
  it('expands every frame: the document\'s rows, a nested row\'s frame under its template list, the template\'s added node', () => {
    const f = fold(entry());
    expect([...f.nodes.keys()].sort()).toEqual(['/', `/${N2}`, `/${N3}`, `/${N3}/${NQ3}`, `/${N3}/a+k1`].sort());
    expect(f.nodes.get(`/${N3}`)?.parent).toEqual({ key: '/' });
    expect(f.nodes.get(`/${N3}/${NQ3}`)?.parent).toEqual({ key: `/${N3}` });
    expect(f.nodes.get(`/${N3}/a+k1`)).toMatchObject({ parent: { key: `/${N3}` }, templateKey: 'k1', traits: { Light: { intensity: 2 } } });
    // The template list removed Q's Sprite on member 3, and named the nested root.
    expect(f.nodes.get(`/${N3}/${NQ3}`)?.traits.Sprite).toBeUndefined();
    expect(f.nodes.get(`/${N3}`)?.traits.EntityAttributes).toMatchObject({ name: 'Engine', sortOrder: 1 });
  });

  it('the root takes its placement (name, sortOrder): the default overrides', () => {
    const f = fold(entry({ overrides: { 1: { EntityAttributes: { name: 'Mine', sortOrder: 9 } } } }));
    expect(f.nodes.get('/')?.traits.EntityAttributes).toMatchObject({ name: 'Mine', sortOrder: 9 });
    expect(f.nodes.get('/')?.parent).toBeNull();
    expect(f.nodes.get('/')?.sortOrder).toBe(9);
    // The rest of the placement: editorFolder and sourceScene land on the root's EntityAttributes too.
    const g = fold(entry({ traits: { PrefabInstance: { source: 'P', localId: 1 }, EntityAttributes: { editorFolder: 'Fleet', sourceScene: 'BASE' } } }));
    expect(g.nodes.get('/')?.traits.EntityAttributes).toMatchObject({ editorFolder: 'Fleet', sourceScene: 'BASE' });
  });

  it('the instance\'s own list wins field by field over every inner layer (rule 6)', () => {
    const f = fold(entry({ nestedOverrides: { 3: { 1: { EntityAttributes: { name: 'Outer' } } } }, overrides: { 2: { Sprite: { tint: '#f00' } } } }));
    expect(f.nodes.get(`/${N3}`)?.traits.EntityAttributes).toMatchObject({ name: 'Outer', sortOrder: 1 });
    expect(f.nodes.get(`/${N2}`)?.traits).toMatchObject({ Sprite: { tint: '#f00' }, Light: { intensity: 1 } });
  });

  it('removed: false restores what an inner layer removed; traitRemovals false restores a component', () => {
    const f = fold(entry({ members: { [`/${N3}/${NQ2}`]: { guid: G(50), removed: false }, [`/${N3}/${NQ3}`]: { guid: G(51), traitRemovals: { Sprite: false } } } }));
    expect(f.nodes.has(`/${N3}/${NQ2}`)).toBe(true);
    expect(f.nodes.get(`/${N3}/${NQ3}`)?.traits.Sprite).toEqual({ tint: '#fff' });
  });

  it('a scene move (`parent`): to a member the list pins, by its key; to a scene-owned node, by its guid (§ 10.4, L8)', () => {
    const f = fold(entry({ members: { [`/${N3}`]: { guid: G(53) }, [`/${N2}`]: { guid: G(54), parent: G(53) }, [`/${N3}/${NQ3}`]: { guid: G(55), parent: G(56) } } }));
    expect(f.nodes.get(`/${N2}`)?.parent).toEqual({ key: `/${N3}` });
    expect(f.nodes.get(`/${N3}/${NQ3}`)?.parent).toEqual({ guid: G(56) });
  });

  it('a template move: the row\'s list moves a nested member by member token, resolved in the nested frame', () => {
    const PT: PrefabDoc = { ...P, id: 'PT', entities: P.entities.map((e) => (e.localId === 3 ? { ...e, removed: [], members: { [`/${NQ3}`]: { parent: '@member:2' } } } : e)) };
    const m = new Map<string, PrefabDoc>([['PT', PT], ['Q', Q]]);
    const f = fold(entry({ prefab: 'PT', traits: { PrefabInstance: { source: 'PT', localId: 1 } } }), m);
    expect(f.nodes.get(`/${N3}/${NQ3}`)?.parent).toEqual({ key: `/${N3}/${NQ2}` });
  });

  it('a removal takes the member\'s subtree with it, a nested frame included', () => {
    const f = fold(entry({ removed: [3] }));
    expect([...f.nodes.keys()].filter((k) => k.startsWith(`/${N3}`))).toEqual([]);
  });

  it('a record on a template-added node applies to it', () => {
    const f = fold(entry({ members: { [`/${N3}/a+k1`]: { traits: { Light: { intensity: 7 } } } } }));
    expect(f.nodes.get(`/${N3}/a+k1`)?.traits.Light).toEqual({ intensity: 7 });
  });

  it('member tokens are rebased per frame, as the spawner rebases them (`rebaseMemberTokens`)', () => {
    const f = fold(entry({ members: { [`/${N3}/${NQ2}`]: { guid: G(52), removed: false } } }));
    expect(f.nodes.get(`/${N3}/${NQ2}`)?.traits.Ref).toEqual({ to: '@member:3.3' });
  });
});

describe('foldInstance — scene-owned nodes and placeholders', () => {
  it('an own node hangs at its anchor; under a removed anchor it is held (heldNode)', () => {
    const node: AddedEntity = { parentLocalId: 2, guid: G(60), name: 'Badge', traits: {}, children: [] };
    expect(fold(entry({ added: [node] })).anchors.get(`/${N2}`)).toEqual([{ guid: G(60) }]);
    const gone = fold(entry({ added: [node], removed: [2] }));
    expect(gone.anchors.has(`/${N2}`)).toBe(false);
    expect(causes(gone)).toContain(`/${N2} own heldNode`);
  });

  it('a missing nested prefab: a placeholder at its key, and the records under it wait (unresolved)', () => {
    const f = fold(entry({ nestedOverrides: { 3: { 3: { Sprite: { tint: '#0f0' } } } }, members: { [`/${N3}/${NQ3}`]: { guid: G(61), traits: { Light: { intensity: 2 } } } } }), new Map([['P', P]]));
    expect(f.placeholders.get(`/${N3}`)).toEqual({ source: 'Q', reason: 'missing', parent: { key: '/' } });
    expect(causes(f)).toContain(`/${N3}/${NQ3} field:Light.intensity unresolved`);
  });

  it('a missing instance prefab: one placeholder at "/", every record unresolved', () => {
    const f = fold(entry({ members: { [`/${N2}`]: { guid: G(62), traits: { Light: { intensity: 2 } } } } }), new Map());
    expect(f.placeholders.get('/')).toEqual({ source: 'P', reason: 'missing', parent: null });
    expect(f.nodes.size).toBe(0);
    expect(causes(f)).toEqual([`/${N2} field:Light.intensity unresolved`]);
  });
});

describe('foldInstance — unused records carry their cause (§ 10.4)', () => {
  it('gone: no such member; a member an inner layer removed; a removal with nothing to act on', () => {
    const f = fold(entry({ members: {
      [`/${G(99)}`]: { guid: G(70), traits: { Light: { intensity: 1 } } },
      [`/${N3}/${NQ2}`]: { guid: G(71), traits: { Light: { intensity: 4 } } },
      [`/${N2}`]: { guid: G(72), traitRemovals: { Transform: true, Sprite: false } },
    } }));
    expect(causes(f)).toEqual(expect.arrayContaining([
      `/${G(99)} field:Light.intensity gone`,
      `/${N3}/${NQ2} field:Light.intensity gone`,
      `/${N2} traitRemoval:Transform gone`,
      `/${N2} traitRemoval:Sprite gone`,
    ]));
  });

  it('a record on a member the instance ITSELF removed is not unused: reverting the removal brings it back (rule 3)', () => {
    const f = fold(entry({ removed: [2], overrides: { 2: { Light: { intensity: 9 } } } }));
    expect(causes(f).filter((c) => c.startsWith(`/${N2} field`))).toEqual([]);
  });

  it('unregistered: a component this build does not register (I24); unknownField: a field a registered one does not persist', () => {
    const f = fold(entry({ overrides: { 2: { Bogus: { a: 1 }, Sprite: { stale: 1 } } } }));
    expect(causes(f)).toEqual(expect.arrayContaining([`/${N2} field:Bogus.a unregistered`, `/${N2} field:Sprite.stale unknownField`]));
    expect(fold(entry({ overrides: { 2: { Bogus: { a: 1 } } } })).nodes.get(`/${N2}`)?.traits.Bogus).toEqual({ a: 1 });
  });

  it('a held legacy record whose localId names no row is unused, gone (format rule, hub refinement 2026-10-02)', () => {
    expect(causes(fold(entry({ overrides: { 12: { Light: { intensity: 1 } } } })))).toContain('/ legacy gone');
  });

  it('unused comes in a stable order (key, part, cause), whatever order the rows were stated in (#2008 P2)', () => {
    const a = fold(entry({ overrides: { 2: { Bogus: { a: 1 } }, 3: { Bogus: { b: 1 } } } }));
    const b = fold(entry({ overrides: { 3: { Bogus: { b: 1 } }, 2: { Bogus: { a: 1 } } }, members: {} }));
    const c = fold(entry({ members: { [`/${N3}`]: { guid: G(57), traits: { Bogus: { b: 1 } } }, [`/${N2}`]: { guid: G(58), traits: { Bogus: { a: 1 } } } } }));
    expect(causes(a)).toEqual(causes(b));
    expect(causes(c)).toEqual(causes(a));
    expect(causes(a)[0]!.startsWith(`/${N2}`)).toBe(true);
  });

  it('a legacy move of a template-keyed node (#1883 ruling C) is unused, gone', () => {
    expect(causes(fold(entry({ members: { [`/${N3}/a+k1`]: { parent: G(80) } } })))).toContain(`/${N3}/a+k1 parent gone`);
  });
});

describe('foldInstance — the close-out review\'s cases (#2007), each one the corpus and the fuzz seeds never reach', () => {
  const row = (localId: number, name: string, parentId: number, extra: object = {}) => ({ localId, nodeGuid: G(localId + 500), traits: { EntityAttributes: { name, parentId } }, ...extra });
  const docsOf = (...ds: PrefabDoc[]) => new Map(ds.map((d) => [d.id!, d] as const));
  const at = (m: Map<string, PrefabDoc>, source: string, extra: Partial<SceneEntityEntry> = {}) =>
    fold(entry({ prefab: source, traits: { PrefabInstance: { source, localId: 1 } }, ...extra }), m);
  const K = (lid: number) => `/${G(lid + 500)}`;

  it('item 3: a placeholder hangs where its row would, and goes with a removed ancestor; its records then follow rule 3', () => {
    const PR: PrefabDoc = { id: 'PR', rootLocalId: 1, entities: [row(1, 'Ship', 0), row(2, 'A', 1), row(3, 'R', 2, { prefab: 'GONE' })] };
    const m = docsOf(PR);
    expect(at(m, 'PR').placeholders.get(K(3))).toEqual({ source: 'GONE', reason: 'missing', parent: { key: K(2) } });
    const cut = at(m, 'PR', { removed: [2], nestedOverrides: { 3: { 1: { Light: { intensity: 2 } } } } });
    expect([...cut.placeholders.keys()]).toEqual([]);
    expect(cut.unused).toEqual([]);
  });

  it('item 4: a member the instance moved to a scene node survives the removal of its template ancestor (the cascade stops there)', () => {
    const PX: PrefabDoc = { id: 'PX', rootLocalId: 1, entities: [row(1, 'Ship', 0), row(2, 'A', 1), row(3, 'X', 2), row(4, 'Y', 3)] };
    const f = at(docsOf(PX), 'PX', { removed: [2], moved: { 3: G(200) } });
    expect(f.nodes.get(K(3))?.parent).toEqual({ guid: G(200) });
    expect(f.nodes.has(K(4))).toBe(true);
    expect(f.nodes.has(K(2))).toBe(false);
  });

  it('item 5: a template move two frames deep resolves from the frame that STATED it', () => {
    const T: PrefabDoc = { id: 'T', rootLocalId: 1, entities: [row(31, 'TRoot', 0), row(32, 'Tx', 31)].map((r, i) => ({ ...r, localId: i + 1, traits: { EntityAttributes: { name: r.traits.EntityAttributes.name, parentId: i ? 1 : 0 } } })) };
    const Qd: PrefabDoc = { id: 'QD', rootLocalId: 1, entities: [row(21, 'QRoot', 0), row(22, 'S', 0, { prefab: 'T' }), row(23, 'Qx', 0)].map((r, i) => ({ ...r, localId: i + 1, traits: { EntityAttributes: { name: r.traits.EntityAttributes.name, parentId: i ? 1 : 0 } } })) };
    const P0: PrefabDoc = { id: 'PD', rootLocalId: 1, entities: [row(11, 'Ship', 0), row(12, 'R', 0, { prefab: 'QD' })].map((r, i) => ({ ...r, localId: i + 1, traits: { EntityAttributes: { name: r.traits.EntityAttributes.name, parentId: i ? 1 : 0 } } })) };
    const m0 = docsOf(T, Qd, P0);
    const byId = new Map([...memberIdentities('PD', {}, reader(m0))].map(([p, id]) => [id, p] as const));
    const PD: PrefabDoc = { ...P0, moved: { [byId.get('/2/2/2')!]: memberToken(0, parseSteps(byId.get('/2/3')!)) } };
    const f = at(docsOf(T, Qd, PD), 'PD');
    const key = (name: string) => [...f.nodes.values()].find((n) => (n.traits.EntityAttributes as { name?: string }).name === name)!.key;
    expect(f.nodes.get(key('Tx'))?.parent).toEqual({ key: key('Qx') });
  });

  it('item 6: a prefab that contains itself folds to a Damaged placeholder, not a stack overflow', () => {
    const C1: PrefabDoc = { id: 'C1', rootLocalId: 1, entities: [row(1, 'One', 0), row(2, 'Two', 1, { prefab: 'C2' })] };
    const C2: PrefabDoc = { id: 'C2', rootLocalId: 1, entities: [row(1, 'Two', 0), row(2, 'Back', 1, { prefab: 'C1' })] };
    const f = at(docsOf(C1, C2), 'C1');
    expect([...f.placeholders.values()]).toEqual([expect.objectContaining({ source: 'C1', reason: 'damaged' })]);
  });

  it('item 7: a held reference copy waiting on a missing prefab is unresolved, never gone (rules 7 and 9)', () => {
    const PM: PrefabDoc = { ...P, id: 'PM', entities: P.entities.map((e) => (e.localId === 3 ? { ...e, added: [{ parentLocalId: 1, guid: '', key: 'kr', name: 'Ref', prefab: 'M-missing', traits: {}, children: [] }] } : e)) };
    const f = at(docsOf(PM, Q), 'PM', { members: { [`/${N3}`]: { added: [{ parentLocalId: 1, guid: '', key: 'kr', name: 'Ref', prefab: 'M-missing', traits: { EntityAttributes: { name: 'Ref2' } }, children: [] }] } } as never });
    const held = f.unused.filter((u) => u.part.kind === 'legacy');
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((u) => u.cause === 'unresolved')).toBe(true);
  });

  it('parent null is the instance root only: a top-frame row whose parent names no row hangs under the instance\'s parent', () => {
    const PO: PrefabDoc = { id: 'PO', rootLocalId: 1, entities: [row(1, 'Ship', 0), row(2, 'Lost', 77)] };
    const f = at(docsOf(PO), 'PO', { traits: { PrefabInstance: { source: 'PO', localId: 1 }, EntityAttributes: { parentId: G(90) } } });
    expect(f.nodes.get('/')?.parent).toBeNull();
    expect(f.nodes.get(K(2))?.parent).toEqual({ guid: G(90) });
  });

  it('item 9 (#2017): a record on a template-added REFERENCE node\'s root applies once (its frame applies it; the outer frame only its removal)', () => {
    const KD: PrefabDoc = { id: 'KD', rootLocalId: 1, entities: [row(41, 'KRoot', 0), row(42, 'KChild', 0)].map((r, i) => ({ ...r, localId: i + 1, traits: { EntityAttributes: { name: r.traits.EntityAttributes.name, parentId: i ? 1 : 0 } } })) };
    const PK: PrefabDoc = { ...P, id: 'PK', entities: P.entities.map((e) => (e.localId === 3 ? { ...e, added: [{ parentLocalId: 1, guid: '', key: 'k', name: 'Ref', prefab: 'KD', traits: {}, children: [] }] } : e)) };
    const own = { parentLocalId: 0, guid: G(300), name: 'Mine', traits: {}, children: [] };
    const f = at(docsOf(PK, Q, KD), 'PK', { members: { [`/${N3}/a+k`]: { traits: { Light: { intensity: 3 } }, own: [own] } } as never });
    expect(f.anchors.get(`/${N3}/a+k`)).toEqual([{ guid: G(300) }]);
    expect(f.nodes.get(`/${N3}/a+k`)?.traits.Light).toEqual({ intensity: 3 });
  });
});

describe('foldInstance — a document\'s own v4 moved of a DIRECT row (#2009 F1, win seed 6858)', () => {
  it('a row moved under a nested instance\'s member hangs there; a token naming no member leaves it in place', () => {
    const PM: PrefabDoc = { ...P, id: 'PM', moved: { 2: '@member:3.3' } } as PrefabDoc;
    expect(fold(entry({ prefab: 'PM', traits: { PrefabInstance: { source: 'PM', localId: 1 } } }), new Map([['PM', PM], ['Q', Q]])).nodes.get(`/${N2}`)?.parent).toEqual({ key: `/${N3}/${NQ3}` });
    const PX: PrefabDoc = { ...P, id: 'PX', moved: { 2: '@member:3.99' } } as PrefabDoc;
    expect(fold(entry({ prefab: 'PX', traits: { PrefabInstance: { source: 'PX', localId: 1 } } }), new Map([['PX', PX], ['Q', Q]])).nodes.get(`/${N2}`)?.parent).toEqual({ key: '/' });
    // The root's place is the placement's, never a document move.
    const PR: PrefabDoc = { ...P, id: 'PR', moved: { 1: '@member:3.3' } } as PrefabDoc;
    expect(fold(entry({ prefab: 'PR', traits: { PrefabInstance: { source: 'PR', localId: 1 } } }), new Map([['PR', PR], ['Q', Q]])).nodes.get('/')?.parent).toBeNull();
  });

  it('a scene move of the same row still wins: the document\'s move is structure, under every layer', () => {
    const PM: PrefabDoc = { ...P, id: 'PM', moved: { 2: '@member:3.3' } } as PrefabDoc;
    const f = fold(entry({ prefab: 'PM', traits: { PrefabInstance: { source: 'PM', localId: 1 } }, members: { [`/${N2}`]: { parent: G(90) } } as never }), new Map([['PM', PM], ['Q', Q]]));
    expect(f.nodes.get(`/${N2}`)?.parent).toEqual({ guid: G(90) });
  });
});

describe('foldInstance — a held reference copy is keyed by the node it stands for, and waits (hub ruling 2026-10-02, #2016)', () => {
  const KR: AddedEntity = { parentLocalId: 1, guid: '', key: 'kr', name: 'Ref', prefab: 'M-missing', traits: {}, children: [] };
  const PM: PrefabDoc = { ...P, id: 'PM', entities: P.entities.map((x) => (x.localId === 3 ? { ...x, added: [K1, KR] } : x)) } as PrefabDoc;
  const m = new Map<string, PrefabDoc>([['PM', PM], ['Q', Q]]);
  const at = (e: Partial<SceneEntityEntry>) => fold(entry({ prefab: 'PM', traits: { PrefabInstance: { source: 'PM', localId: 1 } }, ...e }), m);

  it('a row\'s held copy: one record at <frame>/a+<key>, part [members, row, added, i], cause unresolved (its prefab is missing: never removable)', () => {
    const f = at({ members: { [`/${N3}`]: { added: [{ ...KR, name: 'Ref2' }, K1] } } as never });
    expect(f.unused).toEqual([{ key: `/${N3}/a+kr`, part: { kind: 'legacy', path: ['members', `/${N3}`, 'added', '0'] }, cause: 'unresolved' }]);
  });

  it('a slot\'s held copy likewise; the rest of the slot is one record per field at the root, so no path contains another', () => {
    const f = at({ nestedStructure: { 3: { added: [{ ...KR, name: 'Ref2' }, K1], removed: [99] } } });
    expect(f.unused).toEqual([
      { key: '/', part: { kind: 'legacy', path: ['nestedStructure', '3', 'removed'] }, cause: 'gone' },
      { key: `/${N3}/a+kr`, part: { kind: 'legacy', path: ['nestedStructure', '3', 'added', '0'] }, cause: 'unresolved' },
    ]);
  });
});

describe('foldInstance — close-out review round 2', () => {
  const docOf = (id: string, moved: Record<string, string>, entities = P.entities): PrefabDoc => ({ ...P, id, entities, moved } as PrefabDoc);
  const inst = (id: string, m: Map<string, PrefabDoc>) => fold(entry({ prefab: id, traits: { PrefabInstance: { source: id, localId: 1 } } }), m);
  // P's rows plus row 4 (Mast) under row 2 (Hull).
  const withMast = [...P.entities, { localId: 4, nodeGuid: G(4), traits: { EntityAttributes: { name: 'Mast', parentId: 2 } } }];

  it('a document move names its row by member TREE path (2.4), not a bare localId', () => {
    const m = new Map([['PT', docOf('PT', { '2.4': '@member:3.3' }, withMast)], ['Q', Q]]);
    expect(inst('PT', m).nodes.get(`/${G(4)}`)?.parent).toEqual({ key: `/${N3}/${NQ3}` });
    // A bare localId that is no tree path names nothing: the row stays.
    const m2 = new Map([['PB', docOf('PB', { 4: '@member:3.3' }, withMast)], ['Q', Q]]);
    expect(inst('PB', m2).nodes.get(`/${G(4)}`)?.parent).toEqual({ key: `/${N2}` });
  });

  it('a document move into the row\'s own subtree is refused (moveMember refuses it)', () => {
    // Engine (3, nested Q) hangs under Hull (2); moving Hull under Engine's Deco would make a cycle.
    const ents = P.entities.map((e) => (e.localId === 3 ? { ...e, traits: { EntityAttributes: { name: 'Engine', parentId: 2 } } } : e));
    const m = new Map([['PC', docOf('PC', { 2: '@member:2.3.3' }, ents)], ['Q', Q]]);
    expect(inst('PC', m).nodes.get(`/${N2}`)?.parent).toEqual({ key: '/' });
  });

  it('a token climbing out of the document (^) names nothing in its own moved', () => {
    const QM: PrefabDoc = { ...Q, moved: { 3: '@member:^.2' } } as PrefabDoc;
    const f = fold(entry(), new Map([['P', P], ['Q', QM]]));
    expect(f.nodes.get(`/${N3}/${NQ3}`)?.parent).toEqual({ key: `/${N3}` });
  });

  it('a held copy whose node SHOWS (it carries a templateMoved) is never gone', () => {
    const W: PrefabDoc = { id: 'W', rootLocalId: 1, entities: [{ localId: 1, nodeGuid: G(301), traits: {} }, { localId: 2, nodeGuid: G(302), traits: { EntityAttributes: { parentId: 1 } } }, { localId: 3, nodeGuid: G(303), traits: { EntityAttributes: { parentId: 1 } } }] };
    const KR: AddedEntity = { parentLocalId: 1, guid: '', key: 'kr', name: 'Ref', prefab: 'W', traits: {}, children: [] };
    const PM: PrefabDoc = { ...P, id: 'PM', entities: P.entities.map((x) => (x.localId === 3 ? { ...x, added: [K1, KR] } : x)) } as PrefabDoc;
    const f = fold(entry({ prefab: 'PM', traits: { PrefabInstance: { source: 'PM', localId: 1 } }, members: { [`/${N3}`]: { added: [{ ...KR, templateMoved: { 2: '@member:3' } }, K1] } } as never }), new Map([['PM', PM], ['Q', Q], ['W', W]]));
    expect(f.nodes.has(`/${N3}/a+kr`)).toBe(true);
    expect(f.unused).toEqual([{ key: `/${N3}/a+kr`, part: { kind: 'legacy', path: ['members', `/${N3}`, 'added', '0'] }, cause: 'unresolved' }]);
  });

  it('a held row under the instance\'s own removal is kept and not reported (rule 3)', () => {
    // Engine (nested, its prefab missing) hangs under Hull, which the scene removes: the placeholder is cut.
    const PH: PrefabDoc = { ...P, id: 'PH', entities: P.entities.map((e) => (e.localId === 3 ? { ...e, traits: { EntityAttributes: { name: 'Engine', parentId: 2 } } } : e)) } as PrefabDoc;
    const f = fold(entry({ prefab: 'PH', traits: { PrefabInstance: { source: 'PH', localId: 1 } }, members: { [`/${N2}`]: { removed: true }, [`/${N3}/${NQ3}`]: { removedTraits: [] } } as never }), new Map([['PH', PH]]));
    expect(f.unused.filter((u) => u.part.kind === 'legacy')).toEqual([]);
  });

  it('a row whose frame is missing: its whole lists are held, and wait (unresolved), never gone', () => {
    const f = fold(entry({ members: { [`/${N3}`]: { added: [K1] }, [`/${N3}/${NQ3}`]: { removedTraits: [] } } as never }), new Map([['P', P]]));
    expect(f.unused.map((u) => [u.key, u.part, u.cause])).toEqual([
      [`/${N3}/${NQ3}`, { kind: 'legacy', path: ['members', `/${N3}/${NQ3}`] }, 'unresolved'],
      [`/${N3}/a+k1`, { kind: 'legacy', path: ['members', `/${N3}`, 'added', '0'] }, 'unresolved'],
    ]);
  });
});

describe('foldInstance — close-out review round 3', () => {
  it('document moves settle as today\'s drain: a move whose target is still inside the row waits for the others', () => {
    // Engine (nested Q) under Hull; Hull goes under Engine's Deco, Engine goes under Bay: no cycle once both settle.
    const ents = [
      ...P.entities.map((e) => (e.localId === 3 ? { ...e, traits: { EntityAttributes: { name: 'Engine', parentId: 2 } } } : e)),
      { localId: 5, nodeGuid: G(5), traits: { EntityAttributes: { name: 'Bay', parentId: 1 } } },
    ];
    const PS = { ...P, id: 'PS', entities: ents, moved: { 2: '@member:2.3.3', '2.3': '@member:5' } } as PrefabDoc;
    const f = fold(entry({ prefab: 'PS', traits: { PrefabInstance: { source: 'PS', localId: 1 } } }), new Map([['PS', PS], ['Q', Q]]));
    expect(f.nodes.get(`/${N2}`)?.parent).toEqual({ key: `/${N3}/${NQ3}` });
    expect(f.nodes.get(`/${N3}`)?.parent).toEqual({ key: `/${G(5)}` });
  });

  it('a whole-list row naming a gone member of an intact frame is held verbatim and unused AT its key, as today keeps it', () => {
    const f = fold(entry({ members: { [`/${N3}/a+k1/a+k2`]: { removedTraits: ['Light'] } } as never }));
    expect(f.unused).toEqual([{ key: `/${N3}/a+k1/a+k2`, part: { kind: 'legacy', path: ['members', `/${N3}/a+k1/a+k2`] }, cause: 'gone' }]);
  });
});

describe('foldInstance — every own link is projected or held, never neither (#2018)', () => {
  const node = (n: number) => ({ parentLocalId: 0, guid: G(n), name: `S${n}`, traits: {}, children: [] });
  const noQ = new Map<string, PrefabDoc>([['P', P]]);

  it('on a gone member: held (heldNode), as today keeps it unshown', () => {
    const f = fold(entry({ members: { [`/${G(99)}`]: { own: [node(70)] } } as never }));
    expect(f.unused).toContainEqual({ key: `/${G(99)}`, part: { kind: 'own', guid: G(70) }, cause: 'heldNode' });
    expect([...f.anchors.values()].flat()).toEqual([]);
  });

  it('AT a placeholder: hangs from it (today shows it: under the instance root, or the copy\'s root)', () => {
    const f = fold(entry({ members: { [`/${N3}`]: { own: [node(71)] } } as never }), noQ);
    expect(f.placeholders.has(`/${N3}`)).toBe(true);
    expect(f.anchors.get(`/${N3}`)).toEqual([{ guid: G(71) }]);
    expect(f.unused.filter((u) => u.part.kind === 'own')).toEqual([]);
  });

  it('INSIDE a placeholder\'s frame: waits with every record there (unresolved), never gone', () => {
    const f = fold(entry({ members: { [`/${N3}/${NQ2}`]: { own: [node(72)] } } as never }), noQ);
    expect(f.unused).toContainEqual({ key: `/${N3}/${NQ2}`, part: { kind: 'own', guid: G(72) }, cause: 'unresolved' });
  });
});

describe('foldInstance — every move settles in ONE queue, as today\'s drain (close-out review round 4; outcomes observed through today\'s load)', () => {
  const NA = G(502), NB = G(503), NC = G(504);
  const doc = (id: string, moved: Record<string, string>): PrefabDoc => ({
    id, rootLocalId: 1, moved, entities: [
      { localId: 1, nodeGuid: G(501), traits: { EntityAttributes: { name: 'Root' } } },
      { localId: 2, nodeGuid: NA, traits: { EntityAttributes: { name: 'A', parentId: 1 } } },
      { localId: 3, nodeGuid: NB, traits: { EntityAttributes: { name: 'B', parentId: 2 } } },
      { localId: 4, nodeGuid: NC, traits: { EntityAttributes: { name: 'C', parentId: 1 } } },
    ],
  } as PrefabDoc);
  const run = (moved: Record<string, string>, members: object) =>
    fold(entry({ prefab: 'M', traits: { PrefabInstance: { source: 'M', localId: 1 } }, members: { [`/${NA}`]: { guid: G(80) }, ...members } as never }), new Map([['M', doc('M', moved)]]));

  it('the instance\'s move beats the document\'s for its member, and a cycle left at the end is refused (no cycle emitted)', () => {
    const f = run({ 2: '@member:2.3', '2.3': '@member:4' }, { [`/${NB}`]: { parent: G(80) } });
    expect(f.nodes.get(`/${NA}`)?.parent).toEqual({ key: '/' });
    expect(f.nodes.get(`/${NB}`)?.parent).toEqual({ key: `/${NA}` });
  });

  it('a document move into the row\'s child waits for the instance to move the child out, then applies', () => {
    const f = run({ 2: '@member:2.3' }, { [`/${NB}`]: { parent: G(90) } });
    expect(f.nodes.get(`/${NB}`)?.parent).toEqual({ guid: G(90) });
    expect(f.nodes.get(`/${NA}`)?.parent).toEqual({ key: `/${NB}` });
  });

  it('a document move pair crossing each other: the instance\'s move of one frees the other', () => {
    const f = run({ 2: '@member:2.3', '2.3': '@member:2' }, { [`/${NB}`]: { parent: G(90) } });
    expect(f.nodes.get(`/${NA}`)?.parent).toEqual({ key: `/${NB}` });
  });

  it('an instance move into the member\'s own subtree is refused', () => {
    const f = run({}, { [`/${NB}`]: { guid: G(81) }, [`/${NA}`]: { guid: G(80), parent: G(81) } });
    expect(f.nodes.get(`/${NA}`)?.parent).toEqual({ key: '/' });
  });
});

describe('foldInstance — a removal of a row whose prefab is missing removes its placeholder (close-out review round 4)', () => {
  const noQ = new Map<string, PrefabDoc>([['P', P]]);
  it('the instance\'s removal: no placeholder, its records kept unreported (rule 3)', () => {
    const f = fold(entry({ removed: [3] }), noQ);
    expect(f.placeholders.has(`/${N3}`)).toBe(false);
    expect(f.unused.filter((u) => u.key === `/${N3}` || u.key.startsWith(`/${N3}/`))).toEqual([]);
  });
  it('a row restoring it (removed: false) over the legacy removal keeps the placeholder (a row wins, § 10.3)', () => {
    const f = fold(entry({ removed: [3], members: { [`/${N3}`]: { removed: false } } as never }), noQ);
    expect(f.placeholders.has(`/${N3}`)).toBe(true);
  });
});

describe('foldInstance — close-out review round 5 (outcomes observed through today\'s load)', () => {
  const NA = G(602), NB = G(603), NC = G(604), ND = G(605);
  const M5: PrefabDoc = { id: 'M5', rootLocalId: 1, entities: [
    { localId: 1, nodeGuid: G(601), traits: { EntityAttributes: { name: 'Root' } } },
    { localId: 2, nodeGuid: NA, traits: { EntityAttributes: { name: 'A', parentId: 1 } } },
    { localId: 3, nodeGuid: NB, traits: { EntityAttributes: { name: 'B', parentId: 2 } } },
    { localId: 4, nodeGuid: NC, traits: { EntityAttributes: { name: 'C', parentId: 1 } } },
    { localId: 5, nodeGuid: ND, traits: { EntityAttributes: { name: 'D', parentId: 3 } } },
  ] };
  const at5 = (members: object, doc: PrefabDoc = M5) => fold(entry({ prefab: doc.id!, traits: { PrefabInstance: { source: doc.id!, localId: 1 } }, members: members as never }), new Map([[doc.id!, doc]]));

  it('a held row\'s scene-owned node at a gone member is the user\'s own: heldNode, never gone', () => {
    const mine = { parentLocalId: 0, guid: G(61), name: 'Mine', traits: {}, children: [] };
    const f = fold(entry({ members: { [`/${G(999)}`]: { added: [mine] } } as never }));
    expect(f.unused).toEqual([{ key: `/${G(999)}`, part: { kind: 'legacy', path: ['members', `/${G(999)}`, 'added', '0'] }, cause: 'heldNode' }]);
  });

  it('a refused move of a member that outlived its removed parent only by moving: lifted to the nearest ancestor that stays', () => {
    const f = at5({ [`/${NA}`]: { removed: true }, [`/${ND}`]: { guid: G(81) }, [`/${NB}`]: { parent: G(81) } });
    expect(f.nodes.has(`/${NA}`)).toBe(false);
    expect(f.nodes.get(`/${NB}`)?.parent).toEqual({ key: '/' });
  });

  it('a move to a removed node fails: the member stays at its row (instance move, and a document move)', () => {
    expect(at5({ [`/${NC}`]: { guid: G(83), removed: true }, [`/${NB}`]: { parent: G(83) } }).nodes.get(`/${NB}`)?.parent).toEqual({ key: `/${NA}` });
    const doc = { ...M5, id: 'M5d', moved: { '2.3': '@member:4' } } as PrefabDoc;
    expect(at5({ [`/${NC}`]: { removed: true } }, doc).nodes.get(`/${NB}`)?.parent).toEqual({ key: `/${NA}` });
  });

  it('a move to a placeholder fails (its parent is gone): the member stays', () => {
    const f = fold(entry({ members: { [`/${N3}`]: { guid: G(82) }, [`/${N2}`]: { parent: G(82) } } as never }), new Map([['P', P]]));
    expect(f.nodes.get(`/${N2}`)?.parent).toEqual({ key: '/' });
  });

  it('a template-keyed node\'s ignored legacy move does not save it from its anchor\'s removal', () => {
    const PK = { ...P, id: 'PK', entities: P.entities.map((e) => (e.localId === 3 ? { ...e, removed: [], added: [{ parentLocalId: 3, guid: '', key: 'k3', name: 'K3', traits: {}, children: [] }] } : e)) } as PrefabDoc;
    const f = fold(entry({ prefab: 'PK', traits: { PrefabInstance: { source: 'PK', localId: 1 } }, members: { [`/${N3}/${NQ3}`]: { removed: true }, [`/${N3}/a+k3`]: { parent: G(90) } } as never }), new Map([['PK', PK], ['Q', Q]]));
    expect(f.nodes.has(`/${N3}/a+k3`)).toBe(false);
  });

  it('an outer move naming nothing replaces the inner one: the member stays at its row', () => {
    const QM = { ...Q, id: 'QM', moved: { 3: '@member:2' } } as PrefabDoc;
    const PM = (moved?: object) => ({ id: 'PM5', rootLocalId: 1, entities: [
      { localId: 1, nodeGuid: G(611), traits: { EntityAttributes: { name: 'Root' } } },
      { localId: 2, nodeGuid: G(612), prefab: 'QM', traits: { EntityAttributes: { name: 'R', parentId: 1 } } },
    ], ...(moved ? { moved } : {}) } as PrefabDoc);
    const run = (d: PrefabDoc) => fold(entry({ prefab: 'PM5', traits: { PrefabInstance: { source: 'PM5', localId: 1 } } }), new Map([['PM5', d], ['QM', QM]]));
    expect(run(PM()).nodes.get(`/${G(612)}/${NQ3}`)?.parent).toEqual({ key: `/${G(612)}/${NQ2}` });
    expect(run(PM({ '2.3': '@member:2.99' })).nodes.get(`/${G(612)}/${NQ3}`)?.parent).toEqual({ key: `/${G(612)}` });
  });
});

describe('foldInstance — final review', () => {
  it('a failed move of the instance root leaves it at its placement (parent null), never its own parent', () => {
    expect(fold(entry({ members: { '/': { parent: `@member:2` } } as never })).nodes.get('/')?.parent).toBeNull();
    expect(fold(entry({ members: { '/': { parent: G(81) }, [`/${N2}`]: { guid: G(81) } } as never })).nodes.get('/')?.parent).toBeNull();
  });

  it('a keyed copy in a held slot whose path names nothing is gone (removable junk), not unresolved', () => {
    const f = fold(entry({ nestedStructure: { 9: { added: [{ ...K1, key: 'kk' }] } } }));
    expect(f.unused).toContainEqual({ key: '/', part: { kind: 'legacy', path: ['nestedStructure', '9', 'added', '0'] }, cause: 'gone' });
  });

  it('a held row stating an empty added list is still reported', () => {
    expect(fold(entry({ members: { [`/${G(999)}`]: { added: [] } } as never })).unused).toEqual([{ key: `/${G(999)}`, part: { kind: 'legacy', path: ['members', `/${G(999)}`, 'added'] }, cause: 'gone' }]);
  });
});

describe('foldInstance — a cycle is a document containing itself, not a frame hanging in its own kind (fuzz seed 6)', () => {
  it('P\'s row R (of Q) adds a reference node of S, and S nests Q: expanded, no cycle', () => {
    const S: PrefabDoc = { id: 'S', rootLocalId: 1, entities: [
      { localId: 1, nodeGuid: G(701), traits: { EntityAttributes: { name: 'S' } } },
      { localId: 2, nodeGuid: G(702), prefab: 'Q', traits: { EntityAttributes: { name: 'QinS', parentId: 1 } } },
    ] };
    const PS: PrefabDoc = { id: 'PS', rootLocalId: 1, entities: [
      { localId: 1, nodeGuid: G(711), traits: { EntityAttributes: { name: 'Root' } } },
      { localId: 2, nodeGuid: G(712), prefab: 'Q', traits: { EntityAttributes: { name: 'R', parentId: 1 } },
        added: [{ parentLocalId: 1, guid: '', key: 'ks', prefab: 'S', name: 'S', traits: {}, children: [] }] } as never,
    ] };
    const f = fold(entry({ prefab: 'PS', traits: { PrefabInstance: { source: 'PS', localId: 1 } } }), new Map([['PS', PS], ['Q', Q], ['S', S]]));
    expect([...f.placeholders.keys()]).toEqual([]);
    expect(f.nodes.has(`/${G(712)}/a+ks/${G(702)}`)).toBe(true);
  });
});

describe('foldInstance — G2 (hub rule): a field and a removal of the same component are both kept; the field is inert while the removal stands', () => {
  it('the instance states both: the component is removed, the field is neither applied nor unused', () => {
    const f = fold(entry({ members: { [`/${N2}`]: { traits: { Light: { intensity: 5 } }, traitRemovals: { Light: true } } } as never }));
    expect(f.nodes.get(`/${N2}`)?.traits.Light).toBeUndefined();
    expect(f.unused).toEqual([]);
  });

  it('a prefab removes it and the instance edits a field: inert; the instance restoring the component applies the field again', () => {
    const PR: PrefabDoc = { id: 'PR', rootLocalId: 1, entities: [
      { localId: 1, nodeGuid: G(801), traits: { EntityAttributes: { name: 'Root' } } },
      { localId: 2, nodeGuid: G(802), prefab: 'Q', traits: { EntityAttributes: { name: 'R', parentId: 1 } }, members: { [`/${NQ2}`]: { traitRemovals: { Light: true } } } } as never,
    ] };
    const run = (row: object) => fold(entry({ prefab: 'PR', traits: { PrefabInstance: { source: 'PR', localId: 1 } }, members: { [`/${G(802)}/${NQ2}`]: row } as never }), new Map([['PR', PR], ['Q', Q]]));
    const removed = run({ traits: { Light: { intensity: 5 } } });
    expect(removed.nodes.get(`/${G(802)}/${NQ2}`)?.traits.Light).toBeUndefined();
    expect(removed.unused).toEqual([]);
    expect(run({ traits: { Light: { intensity: 5 } }, traitRemovals: { Light: false } }).nodes.get(`/${G(802)}/${NQ2}`)?.traits.Light).toEqual({ intensity: 5 });
  });
});
