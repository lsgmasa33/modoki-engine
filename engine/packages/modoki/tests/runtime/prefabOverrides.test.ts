/** #1031 — `effectivePrefabRootTraits` / `effectivePrefabMemberTraits` (pure) against
 *  `instantiatePrefabIntoWorld` (the spawner).
 *
 *  The pure functions exist so the pool provider and the validator can answer "what would this member
 *  of a spawned instance carry?" without spawning anything. Their whole value is agreeing with the
 *  spawner, and the part that cannot be shared by construction is the merge ORDER (control flow inside
 *  the spawner). So the parity cases spawn the SAME fixture through the real spawner and compare field
 *  by field; the unit cases after them pin what parity cannot see (termination, no mutation,
 *  document-keyed names, the shared per-trait fold). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({ name: '' as string, parentId: 0, guid: '' as string });
const PrefabInstance = trait({ source: '' as string, localId: 0, rootInstanceId: 0, parentLocalId: 0 });
const UIElement = trait({ width: 0, widthUnit: '%' as string, height: 0, heightUnit: '%' as string, marginBottom: 0 });

let testWorld: ReturnType<typeof createWorld>;
const cachedPrefabs = new Map<string, unknown>();

// Same doubles as nestedPrefabInstantiate.test.ts: the real `spawnEntity` registers into the id
// index `findEntityById` reads, so the double does too.
const idIndex = new Map<number, any>();
vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => idIndex.set(e.id(), e),
  spawnEntity: (world: any, ...traits: any[]) => { const e = world.spawn(...traits); idIndex.set(e.id(), e); return e; },
  setStructureCallback: vi.fn(),
  indexEntityGuid: () => {},
  findEntityById: (id: number) => idIndex.get(id),
  findEntityByGuid: () => undefined,
}));

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: {} },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: {} },
    { name: 'PrefabInstance', trait: PrefabInstance, category: 'component', fields: {} },
    { name: 'UIElement', trait: UIElement, category: 'component', fields: {} },
  ];
  return { getAllTraits: () => traits, getTraitByName: (n: string) => traits.find(t => t.name === n) };
});

vi.mock('../../src/runtime/loaders/meshTemplateCache', () => ({
  loadModelTemplates: vi.fn().mockResolvedValue(undefined),
  getCachedPrefab: (guid: string) => cachedPrefabs.get(guid) ?? null,
}));

vi.mock('../../src/runtime/ui/uiTreeStore', () => ({ markUIDirty: vi.fn() }));

beforeEach(() => { testWorld = createWorld(); cachedPrefabs.clear(); idIndex.clear(); });
afterEach(() => { testWorld.destroy(); });

const getLoader = () => import('../../src/runtime/loaders/loadSceneFile');
const getPure = () => import('../../src/runtime/loaders/prefabOverrides');

type OverrideMap = Record<number, Record<string, Record<string, unknown>>>;
type Opts = { overrides?: OverrideMap; nestedOverrides?: Record<string, OverrideMap>; removedTraits?: Record<number, string[]> };

/** The provider's two rules, built from the SAME registry double the spawner reads. */
async function spawnerRules() {
  const { isPersistentTraitField } = await import('../../src/runtime/core/ecs/traitSchema');
  const { getTraitByName } = await import('../../src/runtime/core/ecs/traitRegistry');
  return {
    acceptField: (t: string, f: string) => {
      const meta = getTraitByName(t);
      return !!meta && isPersistentTraitField(meta as never, f);
    },
    traitKind: (t: string) => {
      const meta = getTraitByName(t);
      return meta ? (meta.category === 'tag' ? 'tag' as const : 'component' as const) : undefined;
    },
  };
}

/** The spawned entity for member `localId` of the instance spawned with source 'P': a plain row's own
 *  entity, or — for a nested-instance row — the child root the spawner stamped `parentLocalId` on. */
function spawnedMember(localId: number) {
  let found: any;
  testWorld.query(PrefabInstance).updateEach(([pi], e) => {
    const p = pi as Record<string, unknown>;
    if (found) return;
    if ((p.source === 'P' && p.localId === localId) || p.parentLocalId === localId) found = idIndex.get(e.id());
  });
  return found;
}

/** Resolve with the pure function AND spawn through the real spawner, then require them to agree:
 *  one resolves iff the other produced the entity; every field the pure answer carries is on it; and
 *  every spawned field that differs from the trait default is in the pure answer. `member` omitted
 *  compares the ROOT. */
async function expectParity(prefab: unknown, opts: Opts = {}, member?: number) {
  const { instantiatePrefabIntoWorld } = await getLoader();
  const { effectivePrefabRootTraits, effectivePrefabMemberTraits } = await getPure();
  const get = (ref: string) => cachedPrefabs.get(ref) ?? null;
  const all = { ...opts, ...(await spawnerRules()) };
  const pure = member === undefined
    ? effectivePrefabRootTraits(prefab, get, all)
    : effectivePrefabMemberTraits(prefab, member, get, all);
  const rootId = instantiatePrefabIntoWorld(
    testWorld, prefab as never, 0, undefined, 'P', opts.overrides,
    opts.removedTraits ? { removedTraits: opts.removedTraits } : undefined, undefined, opts.nestedOverrides,
  );
  const entity = member === undefined ? (rootId ? idIndex.get(rootId) : undefined) : spawnedMember(member);
  expect(pure === null, `pure resolves iff the spawner produced the entity (root id: ${rootId})`).toBe(entity === undefined);
  if (!entity || !pure) return { pure };
  const live = entity.has(UIElement) ? { ...(entity.get(UIElement) as Record<string, unknown>) } : undefined;
  const authored = pure.UIElement as Record<string, unknown> | undefined;
  expect(authored === undefined, 'UIElement is present in one answer and not the other').toBe(live === undefined);
  if (live && authored) {
    for (const [field, v] of Object.entries(authored)) expect(live[field], `pure says ${field}=${String(v)}`).toEqual(v);
    const defaults = (UIElement as unknown as { schema: Record<string, unknown> }).schema;
    for (const [field, v] of Object.entries(live)) {
      if (v !== defaults[field]) expect(authored[field], `spawned ${field}=${String(v)} must be in the pure answer`).toEqual(v);
    }
  }
  return { pure };
}

const leaf = (id: string, ui: Record<string, unknown>) => ({
  id, rootLocalId: 1,
  entities: [
    { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: `${id}Root`, parentId: 0 }, UIElement: ui } },
    { localId: 2, traits: { Transform: { x: 0 }, EntityAttributes: { name: `${id}Kid`, parentId: 1 } } },
  ],
});
/** A prefab whose ROOT row is a nested-instance reference — the #1031 shape. */
const nestingRoot = (id: string, childId: string, row: Record<string, unknown> = {}) => ({
  id, rootLocalId: 1,
  entities: [{ localId: 1, prefab: childId, traits: { EntityAttributes: { name: `${id}Ref`, parentId: 0 } }, ...row }],
});

describe('effectivePrefabRootTraits agrees with the spawner (#1031)', () => {
  it('a plain root, with an outer override folded on', async () => {
    const { pure } = await expectParity(leaf('Leaf', { width: 40, widthUnit: 'px' }),
      { overrides: { 1: { UIElement: { height: 50, heightUnit: 'px' } } } });
    expect(pure?.UIElement).toEqual({ width: 40, widthUnit: 'px', height: 50, heightUnit: 'px' });
  });

  it('a NESTED-INSTANCE root is the child root plus the row override — not the row\'s own traits', async () => {
    cachedPrefabs.set('Child', leaf('Child', { width: 30, widthUnit: '%', height: 10, heightUnit: 'px' }));
    const { pure } = await expectParity(nestingRoot('Parent', 'Child', { overrides: { 1: { UIElement: { height: 50 } } } }));
    expect(pure?.UIElement).toEqual({ width: 30, widthUnit: '%', height: 50, heightUnit: 'px' });
    // The row's own `EntityAttributes` is read only for `parentId`; the root entity is the child's.
    expect((pure?.EntityAttributes as { name?: string }).name).toBe('ChildRoot');
  });

  it('two levels deep, the OUTERMOST layer wins', async () => {
    cachedPrefabs.set('Child', leaf('Child', { height: 10, heightUnit: 'px' }));
    cachedPrefabs.set('Mid', nestingRoot('Mid', 'Child', { overrides: { 1: { UIElement: { height: 50 } } } }));
    const top = nestingRoot('Top', 'Mid', { overrides: { 1: { UIElement: { height: 70 } } } });
    expect((await expectParity(top)).pure?.UIElement).toMatchObject({ height: 70 });
    expect((await expectParity(top, { overrides: { 1: { UIElement: { height: 90 } } } })).pure?.UIElement)
      .toMatchObject({ height: 90 });
  });

  it('path-keyed nestedOverrides reach two levels down, over the inner row\'s own override', async () => {
    cachedPrefabs.set('Child', leaf('Child', { width: 30 }));
    cachedPrefabs.set('Mid', nestingRoot('Mid', 'Child', { overrides: { 1: { UIElement: { width: 55 } } } }));
    const top = nestingRoot('Top', 'Mid', { nestedOverrides: { 1: { 1: { UIElement: { width: 77 } } } } });
    expect((await expectParity(top)).pure?.UIElement).toMatchObject({ width: 77 });
    // An outer layer's deeper path wins over the row's own nested override at the same depth.
    expect((await expectParity(top, { nestedOverrides: { '1.1': { 1: { UIElement: { width: 88 } } } } })).pure?.UIElement)
      .toMatchObject({ width: 88 });
  });

  it('removedTraits on the root is applied — by the nested row, and by an outer layer', async () => {
    cachedPrefabs.set('Child', leaf('Child', { width: 30 }));
    expect((await expectParity(nestingRoot('Parent', 'Child', { removedTraits: { 1: ['UIElement'] } }))).pure)
      .not.toHaveProperty('UIElement');
    expect((await expectParity(leaf('Leaf', { width: 30 }), { removedTraits: { 1: ['UIElement'] } })).pure)
      .not.toHaveProperty('UIElement');
  });

  it('an override field the trait does not persist is dropped by both', async () => {
    const { pure } = await expectParity(leaf('Leaf', { width: 30 }),
      { overrides: { 1: { UIElement: { bogus: 5, height: 20 } } } });
    expect(pure?.UIElement).toEqual({ width: 30, height: 20 });
  });

  it('an override naming a trait the member LACKS adds it — even when no field of it is accepted', async () => {
    // #1031 review F2: the spawner adds a known trait whenever the entity lacks it, at its defaults,
    // whether or not any override field survived the filter. The first draft of the pure path added
    // it only when something was accepted — a comment claimed the spawner did the same.
    const bare = { id: 'Bare', rootLocalId: 1, entities: [{ localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'B', parentId: 0 } } }] };
    expect((await expectParity(bare, { overrides: { 1: { UIElement: {} } } })).pure?.UIElement).toEqual({});
    expect((await expectParity(bare, { overrides: { 1: { UIElement: { renamedAway: 5 } } } })).pure?.UIElement).toEqual({});
  });

  it('an override naming a trait nothing registers is skipped by both', async () => {
    const { pure } = await expectParity(leaf('Leaf', { width: 30 }), { overrides: { 1: { Mystery: { a: 1 } } } });
    expect(pure).not.toHaveProperty('Mystery');
  });

  it('no root produced ⇔ null: an uncached child, and a root localId no row carries', async () => {
    // `Missing` is never cached.
    await expectParity(nestingRoot('Parent', 'Missing'));
    // No `rootLocalId`: the spawner's rule is `?? 1`, NOT "the first row" — this prefab spawns no root.
    await expectParity({ id: 'Seven', entities: [{ localId: 7, traits: { Transform: { x: 0 }, UIElement: { width: 9 } } }] });
  });
});

describe('effectivePrefabMemberTraits — any member, not just the root (#1031 review F1)', () => {
  it('a plain non-root member is its own row plus the outer override for its localId', async () => {
    const host = { id: 'Host', rootLocalId: 1, entities: [
      { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'HostRoot', parentId: 0 } } },
      { localId: 2, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Row', parentId: 1 }, UIElement: { width: 12, widthUnit: 'px' } } },
    ] };
    const { pure } = await expectParity(host, { overrides: { 2: { UIElement: { height: 8, heightUnit: 'px' } } } }, 2);
    expect(pure?.UIElement).toEqual({ width: 12, widthUnit: 'px', height: 8, heightUnit: 'px' });
  });

  it('a NESTED non-root member is the child root plus the row override — the validator\'s instance-override case', async () => {
    cachedPrefabs.set('Child', leaf('Child', { width: 30, height: 10, heightUnit: 'px' }));
    const host = { id: 'Host', rootLocalId: 1, entities: [
      { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'HostRoot', parentId: 0 } } },
      { localId: 3, prefab: 'Child', traits: { EntityAttributes: { name: 'Ref', parentId: 1 } }, overrides: { 1: { UIElement: { height: 44 } } } },
    ] };
    const { pure } = await expectParity(host, {}, 3);
    expect(pure?.UIElement).toEqual({ width: 30, height: 44, heightUnit: 'px' });
  });
});

describe('effectivePrefabRootTraits — what parity cannot see (#1031)', () => {
  it('a prefab that nests ITSELF resolves to null after at most one re-entry — the ancestor guard, not the depth cap', async () => {
    // ⚠️ Counting `getPrefab` calls is what makes this falsifiable (#1031 review F5): with the ancestor
    // guard removed, the depth cap ALONE still returns null, after ~64 calls — so a bare
    // `toBeNull()` was green whichever guard did the work.
    const { effectivePrefabRootTraits } = await getPure();
    const noId = { rootLocalId: 1, entities: [{ localId: 1, prefab: 'Self', traits: {} }] };
    const withId = { id: 'Loop', rootLocalId: 1, entities: [{ localId: 1, prefab: 'Loop', traits: {} }] };
    const get = vi.fn((ref: string) => (ref === 'Self' ? noId : ref === 'Loop' ? withId : null));
    expect(effectivePrefabRootTraits(noId, get)).toBeNull();
    expect(get.mock.calls.length, 'no id: re-entered once under its ref, then refused').toBeLessThanOrEqual(2);
    get.mockClear();
    expect(effectivePrefabRootTraits(withId, get)).toBeNull();
    expect(get.mock.calls.length, 'with an id: refused on the first re-entry').toBeLessThanOrEqual(1);
  });

  it('a resolver that throws is an unresolved child, not a crash', async () => {
    const { effectivePrefabRootTraits } = await getPure();
    expect(effectivePrefabRootTraits(nestingRoot('P', 'Boom'), () => { throw new Error('boom'); })).toBeNull();
  });

  it('mutates neither the prefab files nor the override maps', async () => {
    const { effectivePrefabRootTraits } = await getPure();
    const deepFreeze = <T>(o: T): T => {
      if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
      return o;
    };
    const child = deepFreeze(leaf('Child', { width: 30, height: 10 }));
    const parent = deepFreeze(nestingRoot('Parent', 'Child', { overrides: { 1: { UIElement: { height: 50 } } }, removedTraits: { 1: ['Transform'] } }));
    const outer = deepFreeze({ 1: { UIElement: { width: 60 } } });
    const out = effectivePrefabRootTraits(parent, () => child, { overrides: outer });
    expect(out?.UIElement).toEqual({ width: 60, height: 50 });
    expect(out).not.toHaveProperty('Transform');
    expect(child.entities[0].traits.UIElement).toEqual({ width: 30, height: 10 });
  });

  it('a tag trait (`true`) is kept, a tag override adds the tag, and a component override on a tag-shaped value folds only its fields', async () => {
    const { effectivePrefabRootTraits } = await getPure();
    const prefab = { rootLocalId: 1, entities: [{ localId: 1, traits: { Hidden: true } }] };
    const asTag = (t: string) => (t === 'Hidden' || t === 'Marked' ? 'tag' as const : 'component' as const);
    expect(effectivePrefabRootTraits(prefab, () => null, { traitKind: asTag, overrides: { 1: { Hidden: {}, Marked: {} } } }))
      .toMatchObject({ Hidden: true, Marked: true });
  });

  it('document-keyed names (`__proto__`) are carried as data, never through the setter (#986)', async () => {
    const { effectivePrefabRootTraits } = await getPure();
    const prefab = JSON.parse('{"rootLocalId":1,"entities":[{"localId":1,"traits":{"__proto__":{"a":1},"UIElement":{"width":3}}}]}');
    const overrides = JSON.parse('{"1":{"UIElement":{"__proto__":{"polluted":true},"height":5}}}');
    const out = effectivePrefabRootTraits(prefab, () => null, { overrides })!;
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    const ui = out.UIElement as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(ui, '__proto__')).toBe(true);
    expect(ui.height).toBe(5);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('foldTraitOverride — the per-trait rule the spawner and the pure path share (#1031)', () => {
  it('an accepted override wins, a refused field is reported and dropped, and nothing is mutated', async () => {
    const { foldTraitOverride } = await getPure();
    const current = Object.freeze({ width: 1, height: 2 });
    const fields = Object.freeze({ height: 9, stale: 4 });
    const { merged, accepted, rejected } = foldTraitOverride(current, fields, (f) => f !== 'stale');
    expect(merged).toEqual({ width: 1, height: 9 });
    expect(accepted).toEqual(['height']);
    expect(rejected).toEqual(['stale']);
  });

  it('with no current value, the merge is exactly the accepted fields (the spawner\'s added-trait case)', async () => {
    const { foldTraitOverride } = await getPure();
    expect(foldTraitOverride(undefined, { a: 1, b: 2 }, (f) => f === 'a').merged).toEqual({ a: 1 });
  });
});
