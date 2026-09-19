/** A parent from ANOTHER scene is a scene move, never a silent cross-scene link (#1429).
 *
 *  An entity is saved in its own `sourceScene`'s file, and its parent must be saved in the same one.
 *  Before #1429 several paths could put a primary entity under a base entity without moving it. The
 *  save then baked the child into the base through a prefab instance's `added` channel (under a
 *  member), or dropped it from both files (under a non-member). The owner's ruling (option C) makes
 *  such a reparent an explicit, prompted move into the parent's scene. A CREATE under a base entity
 *  is simply born there, with no prompt (option A).
 *
 *  One case per entry point, all against the one plan (`planReparent`), each driven the way
 *  production drives it. The mutation that turns each red is named above it. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestWorld, type TestWorld, setPlayState, Transform, EntityAttributes, getCurrentWorld,
} from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved, serializeScene, undo, redo, planReparent } from '@modoki/engine/editor';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefab';
import { isSceneDirty, clearAllSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { PrefabInstance } from '../../packages/modoki/src/runtime/traits/PrefabInstance';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

const BASE = 'b1429000-0000-4000-8000-000000000001';
const BASE_FILE = { path: '/assets/scenes/Base1429.json', guid: BASE };

let game: TestWorld | undefined;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  markSceneSaved();
  clearAllSceneDirty();
});
afterEach(() => { game?.dispose(); game = undefined; clearAllSceneDirty(); });

type Ent = { id(): number; get(t: unknown): unknown };
const attrs = (id: number) => (getCurrentWorld().entities.find((e) => e.id() === id)!.get(EntityAttributes)) as { parentId: number; sourceScene: string; guid: string; name: string };
const guidOf = (e: Ent) => (e.get(EntityAttributes) as { guid: string }).guid;
const spawn = (name: string, extra: Record<string, unknown> = {}) =>
  game!.spawn(Transform(), EntityAttributes({ name, guid: crypto.randomUUID(), ...extra })) as unknown as Ent;
/** Link a live entity into a prefab instance the way an instantiate does. */
const link = (e: Ent, localId: number, rootInstanceId: number, parentLocalId = 0) =>
  (getCurrentWorld().entities.find((x) => x.id() === e.id()) as any).add(PrefabInstance({ source: 'x', localId, rootInstanceId, parentLocalId }));
const namesIn = async (scene?: typeof BASE_FILE) =>
  JSON.stringify((await serializeScene(scene ? { scene } : undefined)).entities);

describe('planReparent — the one decision every reparent entry point asks (#1429)', () => {
  // Mutation: make planReparent compare nothing (return same-scene whenever nothing refuses).
  it('a parent from another scene is a scene move; the same scene and the root are plain reparents', () => {
    const baseParent = spawn('BaseParent', { sourceScene: BASE });
    const primaryParent = spawn('PrimaryParent');
    const kid = spawn('Kid');
    expect(planReparent(kid.id(), baseParent.id())).toEqual({ kind: 'scene-move', from: '', to: BASE });
    expect(planReparent(kid.id(), primaryParent.id())).toEqual({ kind: 'same-scene' });
    expect(planReparent(baseParent.id(), 0)).toEqual({ kind: 'same-scene' });
  });

  // Mutation: drop the `instance-member` refusal in planReparent.
  it('a non-root prefab member is refused rather than split across two scene files', () => {
    const root = spawn('InstRoot');
    const member = spawn('Member', { parentId: root.id() });
    (getCurrentWorld().entities.find((e) => e.id() === root.id()) as any).add(PrefabInstance({ source: 'x', localId: 1, rootInstanceId: root.id() }));
    (getCurrentWorld().entities.find((e) => e.id() === member.id()) as any).add(PrefabInstance({ source: 'x', localId: 2, rootInstanceId: root.id() }));
    const baseParent = spawn('BaseParent', { sourceScene: BASE });
    expect(planReparent(member.id(), baseParent.id())).toEqual({ kind: 'refused', reason: 'instance-member' });
    // The instance ROOT may move: it carries its whole instance with it.
    expect(planReparent(root.id(), baseParent.id())).toMatchObject({ kind: 'scene-move', to: BASE });
  });

  // Mutation: drop the `ownedNested` check in sceneMovePrefabRefusal. (Review finding: an owned nested
  // root has rootInstanceId === itself, so a member-only check let it leave its outer instance.)
  it('an OWNED nested instance root cannot leave its outer instance, but moves with it', () => {
    const outer = spawn('Ship');
    const engine = spawn('Engine', { parentId: outer.id() });
    const part = spawn('Part', { parentId: engine.id() });
    link(outer, 1, outer.id());
    link(engine, 1, engine.id(), 1); // expanded from the outer prefab's row: parentLocalId > 0
    link(part, 2, engine.id());
    const baseParent = spawn('BaseParent', { sourceScene: BASE });
    expect(planReparent(engine.id(), baseParent.id())).toEqual({ kind: 'refused', reason: 'instance-member' });
    expect(planReparent(outer.id(), baseParent.id())).toMatchObject({ kind: 'scene-move' });
  });

  // Mutation: check only the moved entity's own link (not its subtree's) in sceneMovePrefabRefusal.
  it('a plain entity holding a member of an instance that stays behind is refused', () => {
    const root = spawn('InstRoot');
    const added = spawn('AddedChild', { parentId: root.id() });
    const member = spawn('Member', { parentId: added.id() });
    link(root, 1, root.id());
    link(member, 2, root.id());
    const baseParent = spawn('BaseParent', { sourceScene: BASE });
    expect(planReparent(added.id(), baseParent.id())).toEqual({ kind: 'refused', reason: 'instance-member' });
  });

  // Mutation: drop the `into-instance` return in sceneMovePrefabRefusal. (Review finding: reparentEntity
  // unpacks a stored root dropped inside an instance; a scene move cannot, so it must refuse.)
  it('a stored instance root may move under a plain base entity, but not under a base instance member', () => {
    const coin = spawn('Coin');
    link(coin, 1, coin.id());
    const kit = spawn('Kit', { sourceScene: BASE });
    const slot = spawn('Slot', { parentId: kit.id(), sourceScene: BASE });
    link(kit, 1, kit.id());
    link(slot, 2, kit.id());
    const plainBase = spawn('BaseParent', { sourceScene: BASE });
    expect(planReparent(coin.id(), slot.id())).toEqual({ kind: 'refused', reason: 'into-instance' });
    expect(planReparent(coin.id(), plainBase.id())).toMatchObject({ kind: 'scene-move', to: BASE });
  });
});

describe('agent reparent-entity: a scene move needs moveToScene: true (#1429)', () => {
  // Mutation: drop the `p.moveToScene !== true` refusal in agentEditorOps.ts's reparent-entity.
  it('without the flag it is refused with what the move would do, and nothing changes', async () => {
    const baseParent = spawn('BaseParent', { sourceScene: BASE });
    const kid = spawn('Kid');
    const err = await runAgentOp('reparent-entity', { guid: guidOf(kid), parentGuid: guidOf(baseParent) }).then(() => new Error('not refused'), (e: Error) => e);
    expect(err).toMatchObject({ code: 'REFUSED_BY_OP' });
    expect(String(err.message)).toMatch(/moveToScene: true/);
    expect(String(err.message)).toMatch(/Its new parent "BaseParent" belongs to scene/);
    expect(attrs(kid.id())).toMatchObject({ parentId: 0, sourceScene: '' });
    expect(isSceneDirty(BASE)).toBe(false);
  });

  // Mutation: route applyReparent's scene-move branch to reparentEntity (the old refusing path).
  it('with the flag the subtree moves into the parent\'s scene, the base saves it, and one undo restores it', async () => {
    const baseParent = spawn('BaseParent', { sourceScene: BASE });
    const kid = spawn('Kid');
    const grandkid = spawn('Grandkid', { parentId: kid.id() });
    const r = await runAgentOp('reparent-entity', { guid: guidOf(kid), parentGuid: guidOf(baseParent), moveToScene: true }) as { movedToScene?: { count: number } };
    expect(r.movedToScene?.count).toBe(2);
    expect(attrs(kid.id())).toMatchObject({ parentId: baseParent.id(), sourceScene: BASE });
    expect(attrs(grandkid.id()).sourceScene).toBe(BASE);
    expect(isSceneDirty(BASE)).toBe(true);
    expect(await namesIn(BASE_FILE)).toMatch(/"Kid"/);
    expect(await namesIn()).not.toMatch(/"Kid"/);

    await undo();
    expect(attrs(kid.id())).toMatchObject({ parentId: 0, sourceScene: '' });
    expect(attrs(grandkid.id()).sourceScene).toBe('');
    expect(await namesIn()).toMatch(/"Grandkid"/);
  });

  // Mutation: none needed beyond the first case: this pins the prose of a refusal that used to blame a cycle.
  it('a same-scene no-op says nothing changed, not that the move is illegal', async () => {
    const parent = spawn('P');
    const kid = spawn('Kid', { parentId: parent.id() });
    await expect(runAgentOp('reparent-entity', { guid: guidOf(kid), parentGuid: guidOf(parent) }))
      .rejects.toThrow(/nothing changed/);
  });
});

describe('apply-scene-ops: a cross-scene parentId write is refused, not applied (#1429)', () => {
  // Mutation: drop the `plan?.kind === 'scene-move'` error in apply-scene-ops' setTrait branch. This was
  // the route that reached the defect: it checked only reparentRefusal and wrote the link.
  it('names reparent-entity {moveToScene} and leaves the entity where it was', async () => {
    const baseParent = spawn('BaseParent', { sourceScene: BASE });
    const kid = spawn('Kid');
    const r = await runAgentOp('apply-scene-ops', {
      ops: [{ op: 'setTrait', entity: { guid: guidOf(kid) }, trait: 'EntityAttributes', fields: { parentId: baseParent.id() } }],
    }) as { errors: string[] };
    expect(r.errors.join('\n')).toMatch(/scene move — use reparent-entity with moveToScene: true/);
    expect(attrs(kid.id())).toMatchObject({ parentId: 0, sourceScene: '' });
  });
});

describe('a CREATE under a base entity is born in that base (#1429, owner option A)', () => {
  const PATH = '/p1429.prefab.json';
  afterEach(() => { setPrefabCache(PATH, null); });

  /** A two-entity prefab instantiated live, then stamped as a BASE's instance — what a scene chain load
   *  produces. Returns the member the issue parents under. */
  async function baseInstance(): Promise<{ root: number; slot: number }> {
    setPrefabCache(PATH, {
      id: 'c1429000-0000-4000-8000-000000000001', version: 2, name: 'Kit', rootLocalId: 1,
      entities: [
        { localId: 1, name: 'Kit', traits: { EntityAttributes: { name: 'Kit', parentId: 0 }, Transform: {} } },
        { localId: 2, name: 'Slot', traits: { EntityAttributes: { name: 'Slot', parentId: 1 }, Transform: {} } },
      ],
    } as never);
    const { rootId } = await runAgentOp('prefab', { action: 'instantiate', path: PATH }) as { rootId: number };
    const slot = getCurrentWorld().entities.find((e) => (e.get(EntityAttributes) as { name: string } | undefined)?.name === 'Slot')!.id();
    for (const id of [rootId, slot]) {
      const e = getCurrentWorld().entities.find((x) => x.id() === id)!;
      e.set(EntityAttributes, { ...(e.get(EntityAttributes) as object), sourceScene: BASE });
    }
    clearHistory(); markSceneSaved(); clearAllSceneDirty();
    return { root: rootId, slot };
  }

  // Mutation: drop `adoptParentScene(currentId)` from entityActions.ts's createEntityWithUndo. This is
  // the issue's own shape: a primary child under a base prefab member, which the base's `added` would bake.
  it('create-entity under a base prefab MEMBER stamps the new entity into the base and dirties it', async () => {
    const { slot } = await baseInstance();
    const r = await runAgentOp('create-entity', { spec: { kind: 'empty' }, parentGuid: attrs(slot).guid }) as { id: number };
    expect(attrs(r.id)).toMatchObject({ parentId: slot, sourceScene: BASE });
    expect(isSceneDirty(BASE)).toBe(true);
  });

  // Mutation: move `adoptParentScene(currentId)` in createEntityWithUndo to AFTER `snapshotEntity`. The
  // live entity is still stamped, but redo respawns the unstamped snapshot. (Review finding 4.)
  it('redo of a create under a base entity brings it back stamped, and dirties the base again', async () => {
    const baseParent = spawn('BaseParent', { sourceScene: BASE });
    const r = await runAgentOp('create-entity', { spec: { kind: 'empty' }, parentGuid: guidOf(baseParent) }) as { guid: string };
    await undo();
    clearAllSceneDirty();
    await redo();
    const back = getCurrentWorld().entities.find((e) => (e.get(EntityAttributes) as { guid?: string } | undefined)?.guid === r.guid)!;
    expect((back.get(EntityAttributes) as { sourceScene: string }).sourceScene).toBe(BASE);
    expect(isSceneDirty(BASE)).toBe(true);
  });

  // Mutation: drop `adoptParentScene(rootId)` from prefab.ts's instantiatePrefabInstance.
  it('instantiating a prefab under a base entity stamps the whole instance into the base', async () => {
    const baseParent = spawn('BaseParent', { sourceScene: BASE });
    setPrefabCache(PATH, {
      id: 'c1429000-0000-4000-8000-000000000002', version: 2, name: 'Kit', rootLocalId: 1,
      entities: [
        { localId: 1, name: 'Kit', traits: { EntityAttributes: { name: 'Kit', parentId: 0 }, Transform: {} } },
        { localId: 2, name: 'Slot', traits: { EntityAttributes: { name: 'Slot', parentId: 1 }, Transform: {} } },
      ],
    } as never);
    const { rootId } = await runAgentOp('prefab', { action: 'instantiate', path: PATH, parentGuid: guidOf(baseParent) }) as { rootId: number };
    const slot = getCurrentWorld().entities.find((e) => (e.get(EntityAttributes) as { name: string } | undefined)?.name === 'Slot')!.id();
    expect(attrs(rootId).sourceScene).toBe(BASE);
    expect(attrs(slot).sourceScene).toBe(BASE);
    expect(isSceneDirty(BASE)).toBe(true);
  });

  // Mutation: drop `adoptParentScene(currentId)` from createEntityWithUndo — the non-member half, through
  // apply-scene-ops' addEntity, the other create path that shares it.
  it('apply-scene-ops addEntity under a base NON-member is saved by the base, not dropped from both files', async () => {
    const baseParent = spawn('BaseParent', { sourceScene: BASE });
    await runAgentOp('apply-scene-ops', { ops: [{ op: 'addEntity', name: 'Born1429', parentId: guidOf(baseParent), traits: { Transform: {} } }] });
    expect(await namesIn(BASE_FILE)).toMatch(/"Born1429"/);
    expect(await namesIn()).not.toMatch(/"Born1429"/);
  });
});
