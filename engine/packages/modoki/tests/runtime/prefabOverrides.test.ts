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
type Opts = {
  overrides?: OverrideMap; nestedOverrides?: Record<string, OverrideMap>; removedTraits?: Record<number, string[]>;
  members?: Record<string, unknown>; nestedStructure?: Record<string, unknown>;
};
/** A member of a NESTED frame: the nested rows' localIds down to it, its localId there, and the source it spawns under. */
type At = { path: number[]; localId: number; source: string };

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
async function expectParity(prefab: unknown, opts: Opts = {}, member?: number | At) {
  const { instantiatePrefabIntoWorld } = await getLoader();
  const { effectivePrefabRootTraits, effectivePrefabMemberTraits, effectivePrefabMemberTraitsAt } = await getPure();
  const get = (ref: string) => cachedPrefabs.get(ref) ?? null;
  const all = { ...opts, ...(await spawnerRules()) };
  const pure = member === undefined
    ? effectivePrefabRootTraits(prefab, get, all)
    : typeof member === 'number'
      ? effectivePrefabMemberTraits(prefab, member, get, all)
      : effectivePrefabMemberTraitsAt(prefab, member.path, member.localId, get, all);
  const structure = opts.removedTraits || opts.members ? { removedTraits: opts.removedTraits, members: opts.members } : undefined;
  const rootId = instantiatePrefabIntoWorld(
    testWorld, prefab as never, 0, undefined, 'P', opts.overrides,
    structure as never, undefined, opts.nestedOverrides, opts.nestedStructure as never,
  );
  const entity = member === undefined ? (rootId ? idIndex.get(rootId) : undefined)
    : typeof member === 'number' ? spawnedMember(member) : spawnedAt(member);
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

/** The spawned member `at.localId` of a frame expanded from `at.source` (fixtures give each source one frame). */
function spawnedAt(at: At) {
  let found: any;
  testWorld.query(PrefabInstance).updateEach(([pi], e) => {
    const p = pi as Record<string, unknown>;
    if (!found && p.source === at.source && p.localId === at.localId) found = idIndex.get(e.id());
  });
  return found;
}

const leaf = (id: string, ui: Record<string, unknown>) => ({
  id, rootLocalId: 1,
  entities: [
    { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: `${id}Root`, parentId: 0 }, UIElement: ui } },
    { localId: 2, traits: { Transform: { x: 0 }, EntityAttributes: { name: `${id}Kid`, parentId: 1 } } },
  ],
});
/** A prefab whose ROOT row is a nested-instance reference — the #1031 shape, the Prefab Variant form. Not supported until
 *  a variants stage (owner, 2026-10-02, #2042): the spawner builds nothing from it and the pure readers answer null. */
const nestingRoot = (id: string, childId: string, row: Record<string, unknown> = {}) => ({
  id, rootLocalId: 1,
  entities: [{ localId: 1, prefab: childId, traits: { EntityAttributes: { name: `${id}Ref`, parentId: 0 } }, ...row }],
});

/** A plain-rooted prefab nesting `childId` at row 2: the supported shape the #1031 composition is tested on since the
 *  variant form became unsupported (#2042). The child's root is member 2, asked by path as `CHILD_ROOT(childId)`. */
const hosting = (id: string, childId: string, row: Record<string, unknown> = {}) => ({
  id, rootLocalId: 1,
  entities: [
    { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: `${id}Root`, parentId: 0 } } },
    { localId: 2, prefab: childId, traits: { EntityAttributes: { name: `${id}Ref`, parentId: 1 } }, ...row },
  ],
});
const CHILD_ROOT = (source: string, path: number[] = [2]): At => ({ path, localId: 1, source });

describe('effectivePrefabRootTraits agrees with the spawner (#1031)', () => {
  it('a plain root, with an outer override folded on', async () => {
    const { pure } = await expectParity(leaf('Leaf', { width: 40, widthUnit: 'px' }),
      { overrides: { 1: { UIElement: { height: 50, heightUnit: 'px' } } } });
    expect(pure?.UIElement).toEqual({ width: 40, widthUnit: 'px', height: 50, heightUnit: 'px' });
  });

  it('a NESTED-INSTANCE member is the child root plus the row override — not the row\'s own traits', async () => {
    cachedPrefabs.set('Child', leaf('Child', { width: 30, widthUnit: '%', height: 10, heightUnit: 'px' }));
    const { pure } = await expectParity(hosting('Parent', 'Child', { overrides: { 1: { UIElement: { height: 50 } } } }), {}, CHILD_ROOT('Child'));
    expect(pure?.UIElement).toEqual({ width: 30, widthUnit: '%', height: 50, heightUnit: 'px' });
    // The row's own `EntityAttributes` is read only for `parentId`; the root entity is the child's.
    expect((pure?.EntityAttributes as { name?: string }).name).toBe('ChildRoot');
  });

  it('two levels deep: a variant-form frame inside a variant-form prefab reads null and spawns nothing (#2042)', async () => {
    // Was "the OUTERMOST layer wins" through two nested ROOT rows: the variant form, unsupported since S5 (owner,
    // 2026-10-02). The row-over-layer order it pinned is held on the supported shape by the #1707 cases below.
    cachedPrefabs.set('Child', leaf('Child', { height: 10, heightUnit: 'px' }));
    cachedPrefabs.set('Mid', nestingRoot('Mid', 'Child', { overrides: { 1: { UIElement: { height: 50 } } } }));
    const top = nestingRoot('Top', 'Mid', { overrides: { 1: { UIElement: { height: 70 } } } });
    expect((await expectParity(top)).pure).toBeNull();
    expect((await expectParity(top, { overrides: { 1: { UIElement: { height: 90 } } } })).pure).toBeNull();
  });

  it('path-keyed nestedOverrides into a variant-form frame: null, nothing spawned (#2042)', async () => {
    // Was the reach of path-keyed nestedOverrides through two nested ROOT rows (the variant form, unsupported since S5).
    cachedPrefabs.set('Child', leaf('Child', { width: 30 }));
    cachedPrefabs.set('Mid', nestingRoot('Mid', 'Child', { overrides: { 1: { UIElement: { width: 55 } } } }));
    const top = nestingRoot('Top', 'Mid', { nestedOverrides: { 1: { 1: { UIElement: { width: 77 } } } } });
    expect((await expectParity(top)).pure).toBeNull();
    expect((await expectParity(top, { nestedOverrides: { '1.1': { 1: { UIElement: { width: 88 } } } } })).pure).toBeNull();
  });

  it('removedTraits on the root is applied — by the nested row, and by an outer layer', async () => {
    cachedPrefabs.set('Child', leaf('Child', { width: 30 }));
    expect((await expectParity(hosting('Parent', 'Child', { removedTraits: { 1: ['UIElement'] } }), {}, CHILD_ROOT('Child'))).pure)
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

  it('no root produced ⇔ null: the variant form, and a root localId no row carries', async () => {
    // A root that is a reference spawns nothing and reads null (#2042), whether its child is cached or not.
    // Mutation: drop the `rootReferenceRefusal` check in `instantiatePrefabIntoWorld` — the spawner builds the bare row.
    cachedPrefabs.set('Child', leaf('Child', { width: 30 }));
    expect((await expectParity(nestingRoot('Parent', 'Child'))).pure).toBeNull();
    // `Missing` is never cached.
    await expectParity(nestingRoot('Parent', 'Missing'));
    // No `rootLocalId`: the spawner's rule is `?? 1`, NOT "the first row" — this prefab spawns no root.
    await expectParity({ id: 'Seven', entities: [{ localId: 7, traits: { Transform: { x: 0 }, UIElement: { width: 9 } } }] });
  });
});

/** #1707 — a nested row is composed with the fold the editor's effective base uses (`foldRowStep`), so the pure answer
 *  follows the spawner on the channels it used to skip: a row's member ROWS (prefab v6), an outer whole-frame slot owning
 *  the row's lists, and an outer layer's DEEP member rows. Each was red before #1707 (the old composition took the row's
 *  `overrides`/`removedTraits` and nothing else). */
describe('#1707: a nested row composes its member rows and an outer slot, as the spawner does', () => {
  const G = (n: number) => `a1707000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
  const [gRoot, gKid, gRow] = [G(1), G(2), G(9)];
  /** Child: Root (UIElement `rootUi`) → Kid (UIElement width 5), both with minted identities. */
  const child = (rootUi: Record<string, unknown>) => ({ id: 'Child', rootLocalId: 1, entities: [
    { localId: 1, nodeGuid: gRoot, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'ChildRoot', parentId: 0 }, UIElement: rootUi } },
    { localId: 2, nodeGuid: gKid, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'ChildKid', parentId: 1 }, UIElement: { width: 5, widthUnit: 'px' } } },
  ] });
  /** Host: HostRoot → row 2 (nodeGuid gRow) expanding Child, with `row` merged onto the reference row. */
  const host = (row: Record<string, unknown> = {}) => ({ id: 'Host', rootLocalId: 1, entities: [
    { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'HostRoot', parentId: 0 } } },
    { localId: 2, nodeGuid: gRow, prefab: 'Child', traits: { EntityAttributes: { name: 'Ref', parentId: 1 } }, ...row },
  ] });
  const KID: At = { path: [2], localId: 2, source: 'Child' };

  it('a member row on a variant-form root: null, nothing spawned (#2042)', async () => {
    // Was a nested ROOT row's member row folding into the root (the variant form, unsupported since S5). A row's member
    // row on its frame's members is held on the supported shape by "a member of a nested frame, by path" below; no
    // writer keys a nested frame's root inside the row's own members (it takes the row's key in the frame above).
    cachedPrefabs.set('Child', child({ height: 10, heightUnit: 'px' }));
    expect((await expectParity(nestingRoot('Parent', 'Child', { members: { [`/${gRoot}`]: { traits: { UIElement: { height: 44 } } } } }))).pure).toBeNull();
  });

  it('a member of a nested frame, by path: the row\'s member row on it applies', async () => {
    cachedPrefabs.set('Child', child({}));
    const { pure } = await expectParity(host({ members: { [`/${gKid}`]: { traits: { UIElement: { width: 12 } } } } }), {}, KID);
    expect(pure?.UIElement).toEqual({ width: 12, widthUnit: 'px' });
  });

  it('a member of a nested frame, by path, with no row on it is the child document\'s own', async () => {
    cachedPrefabs.set('Child', child({}));
    expect((await expectParity(host(), {}, KID)).pure?.UIElement).toEqual({ width: 5, widthUnit: 'px' });
  });

  it('an outer whole-frame slot over a variant-form root: null, nothing spawned (#2042)', async () => {
    // Was the slot owning a nested ROOT row's removedTraits (the variant form, unsupported since S5). A slot owning a
    // nested row's lists is held on the supported shape by "a whole-frame slot a prefab ROW carries" below.
    cachedPrefabs.set('Child', child({ height: 10, heightUnit: 'px' }));
    const parent = nestingRoot('Parent', 'Child', { removedTraits: { 1: ['UIElement'] } });
    expect((await expectParity(parent)).pure).toBeNull();
    expect((await expectParity(parent, { nestedStructure: { 1: { added: [], removed: [], removedTraits: {} } } })).pure).toBeNull();
  });

  it('an outer layer\'s DEEP member row reaches the member of the nested frame it names', async () => {
    // Mutation: `topFrame` forwards no rows (`layers: [{ slots }]`) — the width stays 5.
    cachedPrefabs.set('Child', child({}));
    const { pure } = await expectParity(host(), { members: { [`/${gRow}/${gKid}`]: { traits: { UIElement: { width: 33 } } } } }, KID);
    expect(pure?.UIElement).toMatchObject({ width: 33 });
  });

  /** Mid: MidRoot → row 3 expanding Leaf2, removing UIElement from Leaf2's member 2; Leaf2: root → Kid (width 5). */
  const leaf2 = () => ({ id: 'Leaf2', rootLocalId: 1, entities: [
    { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Leaf2Root', parentId: 0 }, UIElement: { width: 1, widthUnit: 'px' } } },
    { localId: 2, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'Leaf2Kid', parentId: 1 }, UIElement: { width: 5, widthUnit: 'px' } } },
  ] });
  const mid = (row: Record<string, unknown> = {}) => ({ id: 'Mid', rootLocalId: 1, entities: [
    { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'MidRoot', parentId: 0 } } },
    { localId: 3, prefab: 'Leaf2', traits: { EntityAttributes: { name: 'Leaf2Ref', parentId: 1 } }, ...row },
  ] });
  const top = (row: Record<string, unknown>) => ({ id: 'Top', rootLocalId: 1, entities: [
    { localId: 1, traits: { Transform: { x: 0 }, EntityAttributes: { name: 'TopRoot', parentId: 0 } } },
    { localId: 2, prefab: 'Mid', traits: { EntityAttributes: { name: 'MidRef', parentId: 1 } }, ...row },
  ] });

  it('a whole-frame slot a prefab ROW carries owns the frame below it, as one passed in does (close-out review)', async () => {
    // Mutation: `foldRowOf` drops the row's `nestedStructure` — Mid's removal stands and UIElement is gone.
    cachedPrefabs.set('Leaf2', leaf2());
    cachedPrefabs.set('Mid', mid({ removedTraits: { 2: ['UIElement'] } }));
    const at: At = { path: [2, 3], localId: 2, source: 'Leaf2' };
    const { pure } = await expectParity(top({ nestedStructure: { 3: { added: [], removed: [], removedTraits: {} } } }), {}, at);
    expect(pure?.UIElement).toEqual({ width: 5, widthUnit: 'px' });
  });

  it('the ROOT of the last nested frame, asked by path, carries what the frame above puts on it (close-out review)', async () => {
    // Top's row 2 overrides Mid's member 3 — Leaf2's root. `[2, 3]` + Leaf2's root is that same entity.
    // Mutation: make `asOuterMember` return its input — width reads Leaf2's own 1.
    cachedPrefabs.set('Leaf2', leaf2());
    cachedPrefabs.set('Mid', mid());
    const { pure } = await expectParity(top({ overrides: { 3: { UIElement: { width: 77 } } } }), {}, { path: [2, 3], localId: 1, source: 'Leaf2' });
    expect(pure?.UIElement).toMatchObject({ width: 77 });
  });

  // A frame whose ROOT row is itself a nested row is the variant form (#2042): unsupported, so nothing is built from it
  // and the pure answer is null at any depth — the whole instance (Top), or a nested frame of it (Mid under a plain Top,
  // which the spawner shows as a Damaged Prefab placeholder carrying none of its traits). `asOuterMember`'s climb through
  // such frames waits for a variants stage. Mutation: drop `variantOnPath` in `effectivePrefabMemberTraitsAt` — both red.
  it('…a variant-form frame at any depth reads null, as the spawner builds no member there', async () => {
    cachedPrefabs.set('Leaf', leaf('Leaf', { width: 1, widthUnit: 'px' }));
    cachedPrefabs.set('Mid', nestingRoot('Mid', 'Leaf'));
    const opts = { overrides: { 1: { UIElement: { width: 90 } } } };
    expect((await expectParity(nestingRoot('Top', 'Mid'), opts, { path: [1, 1], localId: 1, source: 'Leaf' })).pure).toBeNull();
  });

  it('…and one whose root localId is not 1', async () => {
    cachedPrefabs.set('Leaf2', leaf2());
    cachedPrefabs.set('Mid', { id: 'Mid', rootLocalId: 3, entities: [
      { localId: 3, prefab: 'Leaf2', traits: { EntityAttributes: { name: 'Leaf2Ref', parentId: 0 } } },
    ] });
    expect((await expectParity(top({ overrides: {} }), { overrides: { 2: { UIElement: { width: 77 } } } }, { path: [2, 3], localId: 1, source: 'Leaf2' })).pure).toBeNull();
  });

  it('a malformed file reads as unresolved, never a throw — the pool calls this with no try of its own', async () => {
    // `overrides: {1: null}` throws inside `mergeOverrideMaps` once a member row merges over it.
    // Mutation: remove the try/catch in `effectivePrefabMemberTraitsAt` — this throws.
    const { effectivePrefabRootTraits } = await getPure();
    cachedPrefabs.set('Child', child({}));
    const bad = nestingRoot('Parent', 'Child', { overrides: { 1: null }, members: { [`/${gRoot}`]: { traits: { UIElement: { height: 1 } } } } });
    expect(effectivePrefabRootTraits(bad, (ref) => cachedPrefabs.get(ref) ?? null)).toBeNull();
  });

  it('memberAddressOfRowKey resolves a key frame by frame, and refuses what names no member', async () => {
    const { memberAddressOfRowKey } = await getPure();
    cachedPrefabs.set('Child', child({}));
    const get = (ref: string) => cachedPrefabs.get(ref) ?? null;
    expect(memberAddressOfRowKey(host(), `/${gRow}`, get)).toEqual({ path: [], localId: 2 });
    expect(memberAddressOfRowKey(host(), `/${gRow}/${gKid}`, get)).toEqual({ path: [2], localId: 2 });
    expect(memberAddressOfRowKey(host(), `/${gRow}/a+somekey`, get)).toBeNull(); // a node row: no localId
    expect(memberAddressOfRowKey(host(), `/${G(7)}`, get)).toBeNull();           // names no row
    expect(memberAddressOfRowKey(host(), `/${gKid}/${gKid}`, get)).toBeNull();   // not a row of Host
    expect(memberAddressOfRowKey(host(), `/${gRow}/${gKid}`, () => null)).toBeNull(); // the frame does not resolve
  });

  it('memberAddressOfRowKey addresses the "/" row at the prefab root (scene v20 / prefab v10, #2001 S6)', async () => {
    // Mutation: drop the "/" branch — the key splits to one empty component and answers null.
    const { memberAddressOfRowKey } = await getPure();
    const get = (ref: string) => cachedPrefabs.get(ref) ?? null;
    expect(memberAddressOfRowKey(host(), '/', get)).toEqual({ path: [], localId: 1 });
    expect(memberAddressOfRowKey({ ...host(), rootLocalId: 3 }, '/', get)).toEqual({ path: [], localId: 3 });
  });

  it('templateNodeRowMoves spells a node\'s member-token row parents as the legacy templateMoved (#2001 S6)', async () => {
    // Mutations: drop the `.`-join (a nested key spells one localId), or the keyed `+<key>` component — each red.
    const { templateNodeRowMoves } = await getPure();
    cachedPrefabs.set('Child', child({}));
    const get = (ref: string) => cachedPrefabs.get(ref) ?? null;
    const node = { members: {
      [`/${gRow}`]: { parent: '@member:1' },                          // a member of the node's prefab
      [`/${gRow}/${gKid}`]: { parent: '@member:2' },                  // a member of a nested frame
      [`/${gRow}/a+extra`]: { parent: '@member:3' },                  // a keyed node of that frame
      '/': { parent: '@member:4' },                                   // the frame root moves nowhere
      [`/${G(7)}`]: { parent: '@member:5' },                          // names no row: left out
      [`/${gKid}/${gKid}`]: { parent: '@member:6' },                  // not a row of Host: left out
    } };
    expect(templateNodeRowMoves(node, host(), get)).toEqual({ 2: '@member:1', '2.2': '@member:2', '2.+extra': '@member:3' });
    // A guid parent is the scene's own move, never the template's; a row with no parent states no move.
    expect(templateNodeRowMoves({ members: { [`/${gRow}`]: { parent: G(9) }, [`/${gRow}/${gKid}`]: { traits: {} } } }, host(), get)).toEqual({});
    expect(templateNodeRowMoves(undefined, host(), get)).toEqual({});
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

  it('a layer\'s "/" row states the frame\'s ROOT (prefab v10 / scene v20, #2001 S6): its fields land on the root, its removal takes the component', async () => {
    // What a v10 reference row hands the fold (`prefabInstances`' `rowOptions`): the row's `members`, `"/"` included.
    // Before the S6 corpus re-save every corpus row stated its root in `overrides[rootLocalId]`, so nothing read this.
    const { effectivePrefabRootTraits, effectivePrefabMemberTraits } = await getPure();
    const tile = { id: 'Tile', rootLocalId: 1, entities: [
      { localId: 1, traits: { EntityAttributes: { name: 'Tile' }, UIElement: { width: 10, height: 10 }, Light: { intensity: 1 } } },
      { localId: 2, traits: { EntityAttributes: { name: 'Face', parentId: 1 }, UIElement: { width: 5 } } },
    ] };
    const members = { '/': { traits: { EntityAttributes: { name: 'Tile7' }, UIElement: { width: 3 } }, traitRemovals: { Light: true } } };
    const root = effectivePrefabRootTraits(tile, () => null, { members })!;
    expect((root.EntityAttributes as { name?: string }).name).toBe('Tile7');
    expect(root.UIElement).toEqual({ width: 3, height: 10 });
    expect(root.Light).toBeUndefined();
    // Only the root: the row names no other member.
    expect(effectivePrefabMemberTraits(tile, 2, () => null, { members })!.UIElement).toEqual({ width: 5 });
    // And the same root with no layer is the file's own.
    expect(effectivePrefabRootTraits(tile, () => null)!.UIElement).toEqual({ width: 10, height: 10 });
  });

  it('a resolver that throws is an unresolved child, not a crash', async () => {
    const { effectivePrefabRootTraits } = await getPure();
    expect(effectivePrefabRootTraits(nestingRoot('P', 'Boom'), () => { throw new Error('boom'); })).toBeNull();
  });

  it('mutates neither the prefab files nor the override maps', async () => {
    const { effectivePrefabMemberTraitsAt } = await getPure();
    const deepFreeze = <T>(o: T): T => {
      if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
      return o;
    };
    const child = deepFreeze(leaf('Child', { width: 30, height: 10 }));
    const parent = deepFreeze(hosting('Parent', 'Child', { overrides: { 1: { UIElement: { height: 50 } } }, removedTraits: { 1: ['Transform'] } }));
    const outer = deepFreeze({ 2: { UIElement: { width: 60 } } });
    const out = effectivePrefabMemberTraitsAt(parent, [2], 1, () => child, { overrides: outer });
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
