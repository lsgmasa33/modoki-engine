/** moveEntityToScene / promoteEntityToScene / demoteEntityToScene — base-scene-
 *  and-persistence-plan.md Phase 14: "change which scene FILE authors this
 *  subtree" (promote = level → base, demote = base → primary). Mirrors
 *  entityActions.test.ts's mock scaffolding (same source module, so this file
 *  needs its own vi.mock calls — they're hoisted per-file, not shared). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld, trait } from 'koota';

const Transform = trait({
  x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1,
});
const EntityAttributes = trait({
  name: '' as string,
  isActive: true as boolean,
  sortOrder: 0,
  parentId: 0,
  guid: '' as string,
  layer: '' as '' | '3d' | '2d' | 'ui',
  sourceScene: '' as string,
  editorFolder: '' as string,
});
const PrefabInstance = trait({ source: '', localId: 0, rootInstanceId: 0, parentLocalId: 0 });
// entityRef-typed field, mirrors AttachTo.target — used to prove the rekey
// rewrite sweeps registry-declared entityRef fields.
const AttachTo = trait({ target: '' as string });
// AoS 'bindings' field, mirrors UIAction — the case a generic entityRef sweep
// can't see inside (§0.4 of the Phase 14 plan investigation).
const UIAction = trait(() => ({ bindings: [] as Array<{ event: string; target?: string }> }));

let testWorld: ReturnType<typeof createWorld>;
const entityIndex = new Map<number, any>();

vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  findEntityById: (id: number) => entityIndex.get(id),
  registerEntity: (entity: any) => entityIndex.set(entity.id(), entity),
  unregisterEntity: (entity: any) => entityIndex.delete(entity.id()),
  setStructureCallback: vi.fn(),
  findEntityByGuid: (guid: string, world: any = testWorld) => {
    let found: any;
    world.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { if (!found && ea.guid === guid) found = e; });
    return found;
  },
  indexEntityGuid: () => {},
  getGuidIndex: (world: any = testWorld) => {
    const m = new Map<string, any>();
    world.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { const g = ea.guid; if (g && !m.has(g)) m.set(g, e); });
    return m;
  },
  rebuildGuidIndexSync: () => {},
}));

const traitDefs = [
  {
    name: 'Transform', trait: Transform, category: 'component' as const,
    fields: {
      x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
      rx: { type: 'number' }, ry: { type: 'number' }, rz: { type: 'number' },
      sx: { type: 'number' }, sy: { type: 'number' }, sz: { type: 'number' },
    },
  },
  {
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component' as const,
    fields: {
      name: { type: 'string' }, isActive: { type: 'boolean' },
      sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } },
      guid: { type: 'string' }, layer: { type: 'string' },
      sourceScene: { type: 'string', hidden: true, runtimeOnly: true },
      editorFolder: { type: 'string', hidden: true },
    },
  },
  {
    name: 'PrefabInstance', trait: PrefabInstance, category: 'component' as const,
    fields: {
      source: { type: 'string' }, localId: { type: 'number' },
      rootInstanceId: { type: 'number', entityId: { onMissing: 'stripTrait' } }, parentLocalId: { type: 'number' },
    },
  },
  {
    name: 'AttachTo', trait: AttachTo, category: 'component' as const,
    fields: { target: { type: 'entityRef' } },
  },
  {
    name: 'UIAction', trait: UIAction, category: 'component' as const,
    fields: { bindings: { type: 'bindings' } },
  },
];

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
  getAllTraits: () => traitDefs,
  getTraitByName: (name: string) => traitDefs.find(t => t.name === name),
  transformName: (n: string) => n,
}));

vi.mock('../../src/runtime/core/ecs/transformPropagationSystem', () => ({
  worldTransforms: new Map(),
}));

let pushedActions: { label: string; undo: () => void | Promise<void>; redo: () => void | Promise<void>; affectedScenes?: string[] }[] = [];
vi.mock('../../src/editor/undo/undoManager', () => ({
  pushAction: (action: any) => { pushedActions.push(action); },
}));

// sceneDirty.ts is real (light, no SceneManager import) — track its marks directly.
import { dirtySceneGuidsSnapshot, clearAllSceneDirty } from '../../src/editor/scene/sceneDirty';

beforeEach(() => {
  testWorld = createWorld();
  entityIndex.clear();
  pushedActions = [];
  clearAllSceneDirty();
});

afterEach(() => {
  testWorld.destroy();
});

function spawn(name: string, opts: Partial<{ parentId: number; sourceScene: string; guid: string; sortOrder: number; editorFolder: string }> = {}) {
  const e = testWorld.spawn(
    Transform({}),
    EntityAttributes({ name, parentId: opts.parentId ?? 0, sourceScene: opts.sourceScene ?? '', guid: opts.guid ?? '', sortOrder: opts.sortOrder ?? 0, editorFolder: opts.editorFolder ?? '' }),
  );
  entityIndex.set(e.id(), e);
  return e;
}

async function getModule() {
  return import('../../src/editor/undo/entityActions');
}

function attrOf(id: number) {
  let out: any = null;
  testWorld.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { if (e.id() === id) out = { ...ea }; });
  return out;
}

const BASE = 'base-guid-1';

describe('moveEntityToScene — promote (level → base)', () => {
  it('re-stamps sourceScene across the whole subtree', async () => {
    const { moveEntityToScene } = await getModule();
    const root = spawn('Root');
    const child = spawn('Child', { parentId: root.id() });
    const grandchild = spawn('Grandchild', { parentId: child.id() });

    const res = moveEntityToScene(root.id(), BASE);
    expect(res.ok).toBe(true);
    expect(res.movedIds.sort()).toEqual([root.id(), child.id(), grandchild.id()].sort());
    expect(attrOf(root.id()).sourceScene).toBe(BASE);
    expect(attrOf(child.id()).sourceScene).toBe(BASE);
    expect(attrOf(grandchild.id()).sourceScene).toBe(BASE);
  });

  it('clears the root parentId when its parent stays behind (lands at target scene root)', async () => {
    const { moveEntityToScene } = await getModule();
    const parent = spawn('Parent'); // stays primary
    const moved = spawn('Moved', { parentId: parent.id() });

    const res = moveEntityToScene(moved.id(), BASE);
    expect(res.ok).toBe(true);
    expect(res.reRooted).toBe(true);
    expect(attrOf(moved.id()).parentId).toBe(0);
  });

  it('reparents under an explicit row target already in the target scene, instead of re-rooting', async () => {
    const { moveEntityToScene } = await getModule();
    const baseRow = spawn('BaseRow', { sourceScene: BASE });
    const parent = spawn('Parent'); // primary, stays behind
    const moved = spawn('Moved', { parentId: parent.id() });

    const res = moveEntityToScene(moved.id(), BASE, { newParentId: baseRow.id() });
    expect(res.ok).toBe(true);
    expect(res.reRooted).toBe(false);
    expect(attrOf(moved.id()).parentId).toBe(baseRow.id());
    // Old parent left behind, untouched, still primary.
    expect(attrOf(parent.id()).sourceScene).toBe('');
  });

  it('falls back to re-rooting when newParentId is not actually in the target scene', async () => {
    const { moveEntityToScene } = await getModule();
    const wrongScene = spawn('WrongScene', { sourceScene: 'other-base' });
    const moved = spawn('Moved');

    const res = moveEntityToScene(moved.id(), BASE, { newParentId: wrongScene.id() });
    expect(res.ok).toBe(true);
    expect(res.reRooted).toBe(true);
    expect(attrOf(moved.id()).parentId).toBe(0);
  });

  it('leaves descendants\' parentId intact — only the ROOT re-roots/reparents', async () => {
    const { moveEntityToScene } = await getModule();
    const root = spawn('Root');
    const child = spawn('Child', { parentId: root.id() });

    moveEntityToScene(root.id(), BASE);
    expect(attrOf(child.id()).parentId).toBe(root.id()); // unchanged
  });

  it('assigns a sortOrder that does not collide with the target scene\'s existing roots', async () => {
    const { moveEntityToScene } = await getModule();
    spawn('ExistingBaseRootA', { sourceScene: BASE, sortOrder: 3 });
    spawn('ExistingBaseRootB', { sourceScene: BASE, sortOrder: 7 });
    const moved = spawn('Moved', { sortOrder: 1 });

    moveEntityToScene(moved.id(), BASE);
    expect(attrOf(moved.id()).sortOrder).toBe(8); // max(3,7) + 1
  });

  it('clears editorFolder when the root GAINS a parent, keeps it when re-rooting', async () => {
    const { moveEntityToScene } = await getModule();
    const baseRow = spawn('BaseRow', { sourceScene: BASE });
    const movedA = spawn('MovedA', { editorFolder: 'Rig' });
    const movedB = spawn('MovedB', { editorFolder: 'Rig' });

    moveEntityToScene(movedA.id(), BASE, { newParentId: baseRow.id() });
    expect(attrOf(movedA.id()).editorFolder).toBe(''); // gained a parent → cleared

    moveEntityToScene(movedB.id(), BASE); // re-roots, no parent
    expect(attrOf(movedB.id()).editorFolder).toBe('Rig'); // stays a root → kept
  });

  it('returns {ok:false, reason:"same-scene"} when the target equals the current scene', async () => {
    const { moveEntityToScene } = await getModule();
    const e = spawn('E', { sourceScene: BASE });
    const res = moveEntityToScene(e.id(), BASE);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('same-scene');
    expect(pushedActions).toHaveLength(0);
  });

  it('warns when the subtree contains a PrefabInstance root', async () => {
    const { moveEntityToScene } = await getModule();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = testWorld.spawn(Transform({}), EntityAttributes({ name: 'InstanceRoot', parentId: 0, guid: 'inst-1' }),
      PrefabInstance({ source: 'p.json', localId: 1, rootInstanceId: 0 }));
    entityIndex.set(root.id(), root);
    root.set(PrefabInstance, { ...root.get(PrefabInstance)!, rootInstanceId: root.id() });

    moveEntityToScene(root.id(), BASE);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toContain('InstanceRoot');
    warnSpy.mockRestore();
  });

  it('marks BOTH the base and (implicitly) the primary dirty, and does not set _isFileDirect', async () => {
    const { moveEntityToScene } = await getModule();
    const e = spawn('E');
    moveEntityToScene(e.id(), BASE);
    expect(dirtySceneGuidsSnapshot().has(BASE)).toBe(true);
    expect((pushedActions[0] as any)._isFileDirect).toBeUndefined();
    expect(pushedActions[0].affectedScenes).toContain(BASE);
  });
});

describe('moveEntityToScene — demote (base → primary), the mirror', () => {
  it('re-stamps sourceScene back to primary and re-roots', async () => {
    const { moveEntityToScene } = await getModule();
    const baseParent = spawn('BaseParent', { sourceScene: BASE });
    const e = spawn('E', { sourceScene: BASE, parentId: baseParent.id() });

    const res = moveEntityToScene(e.id(), '');
    expect(res.ok).toBe(true);
    expect(attrOf(e.id()).sourceScene).toBe('');
    expect(attrOf(e.id()).parentId).toBe(0);
  });
});

describe('moveEntityToScene — undo/redo', () => {
  it('undo restores sourceScene, parentId, sortOrder and editorFolder for every entity in ONE step', async () => {
    const { moveEntityToScene } = await getModule();
    const baseRow = spawn('BaseRow', { sourceScene: BASE });
    const parent = spawn('Parent');
    const root = spawn('Root', { parentId: parent.id(), sortOrder: 2, editorFolder: '' });
    const child = spawn('Child', { parentId: root.id() });

    moveEntityToScene(root.id(), BASE, { newParentId: baseRow.id() });
    expect(pushedActions).toHaveLength(1);

    pushedActions[0].undo();
    expect(attrOf(root.id())).toEqual(expect.objectContaining({ sourceScene: '', parentId: parent.id(), sortOrder: 2 }));
    expect(attrOf(child.id()).sourceScene).toBe('');
  });

  it('redo re-applies the whole move', async () => {
    const { moveEntityToScene } = await getModule();
    const root = spawn('Root');
    moveEntityToScene(root.id(), BASE);
    pushedActions[0].undo();
    expect(attrOf(root.id()).sourceScene).toBe('');
    pushedActions[0].redo();
    expect(attrOf(root.id()).sourceScene).toBe(BASE);
  });

  it('preserves world pose across the parent change (decision: preserve, not jump)', async () => {
    const mod = await import('../../src/runtime/core/ecs/transformPropagationSystem');
    const wt = mod.worldTransforms as Map<number, any>;
    wt.clear();
    const { moveEntityToScene } = await getModule();
    const baseRow = spawn('BaseRow', { sourceScene: BASE });
    const parent = spawn('Parent');
    const e = testWorld.spawn(Transform({ x: 10 }), EntityAttributes({ name: 'E', parentId: parent.id() }));
    entityIndex.set(e.id(), e);
    wt.set(baseRow.id(), { x: 5, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
    wt.set(e.id(), { x: 10, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });

    moveEntityToScene(e.id(), BASE, { newParentId: baseRow.id() });
    let x = NaN;
    testWorld.query(Transform).updateEach(([tf]: any[], ent: any) => { if (ent.id() === e.id()) x = tf.x; });
    expect(x).toBeCloseTo(5, 5); // world x=10 under a parent whose world x=5 → local x=5
    wt.clear();
  });
});

describe('moveEntityToScene — guid rekey (machinery, not wired to the Hierarchy UI yet)', () => {
  it('mints a new guid and rewrites a pointing entityRef field in the SAME undo action', async () => {
    const { moveEntityToScene } = await getModule();
    const moved = spawn('Moved', { guid: 'g-moved' });
    const referrer = testWorld.spawn(Transform({}), EntityAttributes({ name: 'Referrer', parentId: 0 }), AttachTo({ target: 'g-moved' }));
    entityIndex.set(referrer.id(), referrer);

    const res = moveEntityToScene(moved.id(), BASE, { rekeyGuids: new Set(['g-moved']) });
    expect(res.rekeyed).toHaveLength(1);
    const newGuid = res.rekeyed[0].newGuid;
    expect(newGuid).not.toBe('g-moved');
    expect(attrOf(moved.id()).guid).toBe(newGuid);
    let target = '';
    testWorld.query(AttachTo).updateEach(([a]: any[]) => { target = a.target; });
    expect(target).toBe(newGuid);

    // Undo restores both the old guid AND the old ref value.
    pushedActions[0].undo();
    expect(attrOf(moved.id()).guid).toBe('g-moved');
    testWorld.query(AttachTo).updateEach(([a]: any[]) => { target = a.target; });
    expect(target).toBe('g-moved');
  });

  it('rewrites UIAction.bindings[].target — the AoS field a generic entityRef sweep cannot see', async () => {
    const { moveEntityToScene } = await getModule();
    const moved = spawn('Moved', { guid: 'g-moved-2' });
    const referrer = testWorld.spawn(Transform({}), EntityAttributes({ name: 'Ref', parentId: 0 }),
      UIAction({ bindings: [{ event: 'click', target: 'g-moved-2' }, { event: 'submit', target: 'other' }] }));
    entityIndex.set(referrer.id(), referrer);

    const res = moveEntityToScene(moved.id(), BASE, { rekeyGuids: new Set(['g-moved-2']) });
    const newGuid = res.rekeyed[0].newGuid;
    let bindings: any[] = [];
    testWorld.query(UIAction).updateEach(([u]: any[]) => { bindings = u.bindings; });
    expect(bindings[0].target).toBe(newGuid);
    expect(bindings[1].target).toBe('other'); // untouched — didn't match
  });
});
