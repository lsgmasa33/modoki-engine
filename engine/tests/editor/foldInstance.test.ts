/** `foldInstance` (#2001 S2, #2007): the pure fold, case by case. Pure — in-memory documents, a reader and an injected
 *  schema, no world. The end-to-end proof (the fold equals what today's spawner spawns, over the corpus and the fuzzer's
 *  saved scenes) is the oracle, `foldInstanceOracle.test.ts`. */
import { describe, it, expect } from 'vitest';
import { foldInstance, type FoldSchema } from '../../packages/modoki/src/runtime/prefab/foldInstance';
import { parseInstanceRecord } from '../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
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
  const rec: InstanceRecord = parseInstanceRecord(e, reader(m)).record;
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
    expect(f.placeholders.get(`/${N3}`)).toEqual({ source: 'Q', reason: 'missing' });
    expect(causes(f)).toContain(`/${N3}/${NQ3} field:Light.intensity unresolved`);
  });

  it('a missing instance prefab: one placeholder at "/", every record unresolved', () => {
    const f = fold(entry({ members: { [`/${N2}`]: { guid: G(62), traits: { Light: { intensity: 2 } } } } }), new Map());
    expect(f.placeholders.get('/')).toEqual({ source: 'P', reason: 'missing' });
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

  it('a legacy move of a template-keyed node (#1883 ruling C) is unused, gone', () => {
    expect(causes(fold(entry({ members: { [`/${N3}/a+k1`]: { parent: G(80) } } })))).toContain(`/${N3}/a+k1 parent gone`);
  });
});
