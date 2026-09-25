/** create-entity / duplicate-entity / delete-entities — the RUNTIME (undo-free) twins registered in
 *  agentBridge so the DEVICE has them (#166 P2, docs/mcp-tool-conventions.md §9).
 *
 *  In an editor session these op names are replaced at startup by the editor's undoable versions;
 *  what runs here is what a phone runs. The rules pinned below are the ones whose absence would be
 *  a false success: a copy that silently drops its children, two entities sharing one guid, and a
 *  partial delete reported alongside a miss. */

import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { found } from '@modoki/engine/testing/inOrder';
import { createTestWorld, type TestWorld, Transform, EntityAttributes,
  getCurrentWorld, setCurrentWorld, setTimeScale, getTimeScale, sceneManager, reparentRefusal,
  stepOneFrame, Time, Input, UIAction, getTraitByName } from '@modoki/engine/runtime';
import { Transient } from '../../packages/modoki/src/runtime/core/traits/Transient';
import { updateContactIndex } from '../../packages/modoki/src/runtime/physics/physicsContactIndex';
import { isRuntimeGuid, deriveMemberGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { setTemplateKey, templateKeyOf } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { createWorld } from 'koota';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { runAgentOp, hasAgentOp, listAgentOps, relayResponseFor, registerRelayResponder, simStepDefaultTimeout, SIM_STEP_MAX_TIMEOUT_MS, inferAssetDefType } from '../../app/debug/agentBridge';
import { ASSET_SCHEMA_TYPES } from '../../packages/modoki/src/runtime/assets/assetSchemas';
import { DEVICE_READ_ASSET_DEF_TYPES } from '../../tools/game-debug-mcp/src/mcp-tools';
import { classifyReadAssetDef, probePathFor, probeServedTypes, type ReadAssetDefProbe }
  from '../tools/readAssetDefServed';

registerAllTraits();

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; });

type CreateReply = { ok?: boolean; error?: string; options?: string[]; id?: number; guid?: string; name?: string; saved?: boolean };
type DupReply = { ok?: boolean; error?: string; created?: number; entitiesPerCopy?: number; roots?: Array<{ id: number; guid: string | null }> };
type DelReply = { ok?: boolean; error?: string; deleted?: string[]; deletedNoGuidIds?: number[] };

async function sceneGuids(): Promise<string[]> {
  const s = await runAgentOp('scene-state', { trait: 'Transform', full: true }) as
    { entities: Array<{ guid: string; traits: Record<string, unknown> }> };
  return s.entities.filter((e) => e.traits.Transform).map((e) => e.guid);
}

describe('create-entity (runtime twin)', () => {
  it('creates an entity and hands back a STABLE guid, not just a live id', async () => {
    game = createTestWorld({});
    const r = await runAgentOp('create-entity', { spec: { kind: 'primitive', mesh: 'sphere' } }) as CreateReply;
    expect(r.ok).not.toBe(false);
    expect(r.id).toBeTypeOf('number');
    // An agent told only a numeric id has an address that expires on the next scene reload.
    expect(r.guid).toBeTruthy();
    expect(r.guid).not.toBe(String(r.id));
    // …and DURABLE (#1210): spawnEntity gave it a runtime guid, which a Play→Stop revert kills.
    expect(isRuntimeGuid(r.guid)).toBe(false);
    expect(r.saved).toBe(false);
  });

  it('refuses an unknown primitive with the valid list, creating nothing', async () => {
    game = createTestWorld({});
    const before = (await sceneGuids()).length;
    const r = await runAgentOp('create-entity', { spec: { kind: 'primitive', mesh: 'pyramid' } }) as CreateReply;
    expect(r.ok).toBe(false);
    expect(r.options).toContain('sphere');
    expect((await sceneGuids()).length).toBe(before);
  });

  // #1070: the light/preset checks used to THROW out of the spec builders, escaping this op's own
  // `{ok:false, options}` convention — the device relay flattened the throw into a bare error string.
  // An unknown kind was worse: the builder returned undefined and the destructuring threw a TypeError.
  // A throw here would REJECT `runAgentOp`, so awaiting a plain reply is itself the assertion.
  it.each([
    { spec: { kind: 'light', light: 'pont' }, option: 'point' },
    { spec: { kind: 'ui', preset: 'toString' }, option: 'view' },
    { spec: { kind: 'pyramid' }, option: 'camera' },
    // #1216 C-3: `{kind:'primitive', mseh:'cube'}` built the default sphere and answered ok.
    { spec: { kind: 'primitive', mseh: 'cube' }, option: 'mesh' },
    { spec: { kind: 'empty', name: 'Probe' }, option: 'kind' },
  ])('refuses $spec in its own {ok:false, options} shape, creating nothing (#1070)', async ({ spec, option }) => {
    game = createTestWorld({});
    const before = (await sceneGuids()).length;
    const r = await runAgentOp('create-entity', { spec }) as CreateReply;
    expect(r.ok).toBe(false);
    expect(r.options).toContain(option);
    expect((await sceneGuids()).length).toBe(before);
  });

  it('a light with no `light` field gets the default rather than a refusal', async () => {
    game = createTestWorld({});
    const r = await runAgentOp('create-entity', { spec: { kind: 'light' } }) as CreateReply;
    expect(r.ok).not.toBe(false);
    expect(r.name).toBe('Point Light');
  });

  it('refuses a stale parentGuid rather than silently creating an orphan', async () => {
    game = createTestWorld({});
    const r = await runAgentOp('create-entity', { spec: { kind: 'primitive', mesh: 'sphere' }, parentGuid: 'ghost' }) as CreateReply;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ghost/);
  });

  it('requires a spec', async () => {
    game = createTestWorld({});
    expect(((await runAgentOp('create-entity', {})) as CreateReply).ok).toBe(false);
  });
});

describe('duplicate-entity (runtime twin)', () => {
  it('copies N times, each copy with a FRESH guid', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 3 }), EntityAttributes({ guid: 'src', name: 'Src' }));

    const r = await runAgentOp('duplicate-entity', { guid: 'src', count: 3 }) as DupReply;

    expect(r.ok).not.toBe(false);
    expect(r.created).toBe(3);
    const guids = r.roots!.map((x) => x.guid);
    // Two entities answering to one address would break every read tool that aims by guid.
    expect(new Set(guids).size).toBe(3);
    expect(guids).not.toContain('src');
    expect((await sceneGuids()).length).toBe(4);
  });

  it('INCLUDES descendants — a copy that dropped them would be a false success', async () => {
    game = createTestWorld({});
    const parent = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'p', name: 'Parent' }));
    game.spawn(Transform({ x: 1 }), EntityAttributes({ guid: 'c1', name: 'Child1', parentId: parent.id() }));
    game.spawn(Transform({ x: 2 }), EntityAttributes({ guid: 'c2', name: 'Child2', parentId: parent.id() }));

    const r = await runAgentOp('duplicate-entity', { guid: 'p' }) as DupReply;

    expect(r.ok).not.toBe(false);
    expect(r.entitiesPerCopy).toBe(3);      // the parent + both children
    expect((await sceneGuids()).length).toBe(6);
  });

  // #1338 — the device twin of the editor duplicate. Mutations: drop the `remapGuidValues` call
  // (both ref tests red), drop `carryEntityIdFields` (the rootInstanceId test red), or shallow-copy
  // the snapshot again (the aliasing test red).
  const uiActionOf = (e: { get(t: unknown): unknown }) =>
    e.get(getTraitByName('UIAction')!.trait) as { bindings: Array<{ event: string; target: string }> };
  const find = (pred: (ea: { name: string; guid: string }, id: number) => boolean) =>
    [...getCurrentWorld().entities].find((e) => e.has(EntityAttributes) && pred(e.get(EntityAttributes) as never, e.id()))!;

  it('carries a ref INSIDE the copy to the copy, and leaves a ref outside it alone', async () => {
    game = createTestWorld({});
    game.spawn(Transform(), EntityAttributes({ guid: 'out', name: 'Out' }));
    const panel = game.spawn(Transform(), EntityAttributes({ guid: 'panel', name: 'Panel' }),
      UIAction({ bindings: [{ event: 'click', action: 'noop', target: 'kid' }, { event: 'hover', action: 'noop', target: 'out' }] } as never));
    game.spawn(Transform(), EntityAttributes({ guid: 'kid', name: 'Kid', parentId: panel.id() }));

    const r = await runAgentOp('duplicate-entity', { guid: 'panel', count: 2 }) as DupReply;
    expect(r.ok).not.toBe(false);
    for (const root of r.roots!) {
      const copy = find((_, id) => id === root.id);
      const kid = find((ea) => ea.name === 'Kid' && (ea as unknown as { parentId: number }).parentId === root.id);
      expect(uiActionOf(copy).bindings.map((b) => b.target)).toEqual([(kid.get(EntityAttributes) as { guid: string }).guid, 'out']);
    }
    expect(uiActionOf(panel).bindings.map((b) => b.target)).toEqual(['kid', 'out']);
  });

  it('a copy shares its bindings array with neither the source nor another copy', async () => {
    game = createTestWorld({});
    const src = game.spawn(Transform(), EntityAttributes({ guid: 'src', name: 'Src' }),
      UIAction({ bindings: [{ event: 'click', action: 'noop', target: '' }] } as never));
    const r = await runAgentOp('duplicate-entity', { guid: 'src', count: 2 }) as DupReply;
    const [a, b] = r.roots!.map((root) => uiActionOf(find((_, id) => id === root.id)).bindings);
    expect(a).not.toBe(uiActionOf(src).bindings);
    // …nor with each other: one call's copies are cloned one by one (#1338 review).
    expect(a).not.toBe(b);
  });

  // #1430 — a template-added node (a `TemplateAddedKey`, no PrefabInstance) inside a copied WHOLE
  // instance keeps its key and gets the guid a reload derives; a copy of a member hands out no key.
  // Mutations: drop `setTemplateKey` in `duplicateEntityLive` (the first red), or read the key
  // unconditionally below the copy root in `planCopyGuids` (`const key = ctx ? keyOf(node) : ''` —
  // the second red: the device has no member strip to hide it).
  const KEY = 'dddddddd-0000-4000-8000-000000001430';
  const keyedInstance = () => {
    const PI = getTraitByName('PrefabInstance')!;
    const root = game!.spawn(Transform(), EntityAttributes({ guid: 'aaaaaaaa-0000-4000-8000-0000000014d1', name: 'Root' }),
      PI.trait({ source: 'p', localId: 1, rootInstanceId: 0 }));
    root.set(PI.trait, { ...(root.get(PI.trait) as object), rootInstanceId: root.id() });
    const member = game!.spawn(Transform(), EntityAttributes({ name: 'Member', parentId: root.id() }),
      PI.trait({ source: 'p', localId: 2, rootInstanceId: root.id() }));
    const extra = game!.spawn(Transform(), EntityAttributes({ name: 'Extra', parentId: member.id() }));
    setTemplateKey(extra, KEY);
    return { root, member, extra };
  };
  const copiedExtra = (sourceExtraId: number) => find((ea, id) => ea.name === 'Extra' && id !== sourceExtraId);

  it('a copied instance keeps its template-added node keyed, on the guid a reload derives (#1430)', async () => {
    game = createTestWorld({});
    const { extra } = keyedInstance();
    const r = await runAgentOp('duplicate-entity', { guid: 'aaaaaaaa-0000-4000-8000-0000000014d1' }) as DupReply;
    const copy = copiedExtra(extra.id());
    expect(templateKeyOf(copy)).toBe(KEY);
    expect((copy.get(EntityAttributes) as { guid: string }).guid).toBe(deriveMemberGuid(r.roots![0]!.guid!, [2, `+${KEY}`]));
  });

  it('a copied member hands its template-added node no key (#1430)', async () => {
    game = createTestWorld({});
    const { member, extra } = keyedInstance();
    const memberGuid = (member.get(EntityAttributes) as { guid: string }).guid;
    const r = await runAgentOp('duplicate-entity', memberGuid ? { guid: memberGuid } : { id: member.id() }) as DupReply;
    expect(r.ok).not.toBe(false);
    expect(templateKeyOf(copiedExtra(extra.id()))).toBe('');
  });

  it('a copied prefab instance names ITS OWN roots in rootInstanceId (a nested instance, its own)', async () => {
    game = createTestWorld({});
    const PI = getTraitByName('PrefabInstance')!;
    const root = game.spawn(Transform(), EntityAttributes({ guid: 'aaaaaaaa-0000-4000-8000-0000000000d1', name: 'Root' }),
      PI.trait({ source: 'p', localId: 1, rootInstanceId: 0 }));
    root.set(PI.trait, { ...(root.get(PI.trait) as object), rootInstanceId: root.id() });
    const member = game.spawn(Transform(), EntityAttributes({ name: 'Member', parentId: root.id() }),
      PI.trait({ source: 'p', localId: 2, rootInstanceId: root.id() }));
    const nest = game.spawn(Transform(), EntityAttributes({ name: 'Nest', parentId: member.id() }),
      PI.trait({ source: 'q', localId: 1, parentLocalId: 2, rootInstanceId: 0 }));
    nest.set(PI.trait, { ...(nest.get(PI.trait) as object), rootInstanceId: nest.id() });

    const r = await runAgentOp('duplicate-entity', { guid: 'aaaaaaaa-0000-4000-8000-0000000000d1' }) as DupReply;
    const rootOf = (e: { get(t: unknown): unknown }) => (e.get(PI.trait) as { rootInstanceId: number }).rootInstanceId;
    const cRoot = find((_, id) => id === r.roots![0]!.id);
    const cMember = find((ea, id) => ea.name === 'Member' && id !== member.id());
    const cNest = find((ea, id) => ea.name === 'Nest' && id !== nest.id());
    expect([rootOf(cRoot), rootOf(cMember), rootOf(cNest)]).toEqual([cRoot.id(), cRoot.id(), cNest.id()]);
    expect([rootOf(root), rootOf(member), rootOf(nest)]).toEqual([root.id(), root.id(), nest.id()]);
  });

  it('a stale guid duplicates nothing and says so', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'src', name: 'Src' }));
    const r = await runAgentOp('duplicate-entity', { guid: 'ghost' }) as DupReply;
    expect(r.ok).toBe(false);
    expect((await sceneGuids()).length).toBe(1);
  });

  it('an out-of-range count is refused rather than clamped', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'src', name: 'Src' }));
    const r = await runAgentOp('duplicate-entity', { guid: 'src', count: 5000 }) as DupReply;
    expect(r.ok).toBe(false);
    expect((await sceneGuids()).length).toBe(1);
  });
});

describe('delete-entities (runtime twin)', () => {
  it('deletes by guid and reports which', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'A' }));
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'b', name: 'B' }));

    const r = await runAgentOp('delete-entities', { guids: ['a'] }) as DelReply;

    expect(r.ok).not.toBe(false);
    expect(r.deleted).toEqual(['a']);
    expect(r.deletedNoGuidIds).toBeUndefined();
    expect(await sceneGuids()).toEqual(['b']);
  });

  it('ONE unresolvable ref deletes NOTHING — a partial delete leaves the caller unable to tell', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'A' }));
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'b', name: 'B' }));

    const r = await runAgentOp('delete-entities', { guids: ['a', 'ghost'] }) as DelReply;

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ghost/);
    expect((await sceneGuids()).sort()).toEqual(['a', 'b']);
  });

  it('requires at least one ref', async () => {
    game = createTestWorld({});
    expect(((await runAgentOp('delete-entities', {})) as DelReply).ok).toBe(false);
  });
});

describe('sim-step (runtime twin)', () => {
  it('re-freezes the world even when the frames never arrive', async () => {
    game = createTestWorld({});
    const world = getCurrentWorld();
    setTimeScale(world, 0);                       // paused, as sim-step requires

    // A headless world runs no rAF loop, so this exercises the timeout path — which is exactly the
    // backgrounded-app case on a phone. The load-bearing guarantee is not the count but the
    // RE-FREEZE: a step that gave up while leaving timeScale at 1 would silently un-pause the
    // world an agent believes is frozen, and every measurement after it would be wrong.
    const r = await runAgentOp('sim-step', { frames: 3, timeoutMs: 150 }) as
      { ok?: boolean; error?: string; stepped?: number; requested?: number };

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/frame loop/i);
    expect(r.stepped).toBe(0);
    expect(r.requested).toBe(3);
    expect(getTimeScale(world)).toBe(0);
  });

  it('REFUSES a frame count or scale it would have had to change, instead of clamping (#1213 C-9)', async () => {
    game = createTestWorld({});
    const world = getCurrentWorld();
    setTimeScale(world, 0);
    // `frames:'abc'` is the sharp one: it became NaN, which no frame count reaches, so the call sat
    // out its whole timeout. A refusal answers at once — the short test timeout would catch a wait.
    for (const params of [{ frames: 601 }, { frames: 0 }, { frames: 2.5 }, { frames: 'abc' }, { scale: -1 }, { scale: 0 }, { timeoutMs: 'soon' }]) {
      const r = await runAgentOp('sim-step', params) as { ok?: boolean; code?: string; error?: string; stepped?: number };
      expect(r, JSON.stringify(params)).toMatchObject({ ok: false, code: 'REFUSED_BY_OP' });
      expect(r.error).toMatch(/Nothing was stepped/);
      expect(r.stepped).toBeUndefined();
    }
    expect(getTimeScale(world)).toBe(0);
  });

  it('refuses to step a RUNNING world, naming how to pause it', async () => {
    game = createTestWorld({});
    // A test world runs at timeScale 1 — stepping it is meaningless, and silently pausing it would
    // be a side effect the caller never asked for (the editor's step op makes the same refusal).
    const r = await runAgentOp('sim-step', { frames: 1 }) as { ok?: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/set-timescale/);
  });

  it('an ordinary step (no world swap) is UNCHANGED — real progress, no worldReplaced flag', async () => {
    game = createTestWorld({});
    const world = getCurrentWorld();
    setTimeScale(world, 0);

    const p = runAgentOp('sim-step', { frames: 2, timeoutMs: 1000 }) as
      Promise<{ ok?: boolean; stepped?: number; timeScale?: number; worldReplaced?: boolean }>;
    // No rAF loop runs headless — drive the registered frame callback directly, exactly like a
    // real frame would (frameDriver.test.ts uses the same `stepOneFrame` for this).
    stepOneFrame();
    stepOneFrame();
    const r = await p;

    expect(r.ok).toBe(true);
    expect(r.stepped).toBe(2);
    expect(r.worldReplaced).toBeUndefined();
    expect(getTimeScale(world)).toBe(0);   // re-frozen
  });

  // ── #486 finding B — a scene swap mid-step must not assemble a reply from two worlds. ──

  it('a world REPLACED mid-step resolves honestly (no hang, no crash), and touches the old world no further', async () => {
    game = createTestWorld({});
    const world = getCurrentWorld();
    setTimeScale(world, 0);

    // getTime/setTimeScale both go through world.queryFirst / world.query — spying on THOSE two
    // is what proves the destroyed world is never queried again after the swap, which is the
    // actual defect (a query on a destroyed koota world can throw, swallowing `resolve`).
    const queryFirstSpy = vi.spyOn(world, 'queryFirst');
    const querySpy = vi.spyOn(world, 'query');

    const p = runAgentOp('sim-step', { frames: 3, timeoutMs: 1000 }) as
      Promise<{ ok?: boolean; error?: string; stepped?: number; requested?: number; worldReplaced?: boolean }>;
    const callsAtSwap = queryFirstSpy.mock.calls.length + querySpy.mock.calls.length;

    // Simulate a scene load swapping in a NEW world mid-step, destroying the one sim-step
    // captured — the two-world atomic swap (`SceneManager.loadScene`'s `setCurrentWorld(promotedWorld)` + `destroyWorldWhenSafe`).
    const otherWorld = createWorld();
    setCurrentWorld(otherWorld);

    stepOneFrame(); // drives the registered frame callback synchronously

    const r = await p;

    expect(r.ok).toBe(false);
    expect(r.worldReplaced).toBe(true);
    expect(r.stepped).toBe(0);
    expect(r.requested).toBe(3);
    // Nothing queried the OLD world after the swap — the load-bearing assertion.
    expect(queryFirstSpy.mock.calls.length + querySpy.mock.calls.length).toBe(callsAtSwap);

    setCurrentWorld(world);
    otherWorld.destroy();
  });
});

describe('load-scene (runtime twin)', () => {
  it('requires a path and reports the currently-loaded scene', async () => {
    game = createTestWorld({});
    const r = await runAgentOp('load-scene', {}) as { ok?: boolean; error?: string; current?: string | null };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/requires \{ path \}/);
    expect(r).toHaveProperty('current');
  });

  it('a path that THROWS is a failure, and says the previous scene is still loaded', async () => {
    game = createTestWorld({});
    const r = await runAgentOp('load-scene', { path: '/definitely/not/a/scene.scene.json' }) as
      { ok?: boolean; error?: string; current?: string | null };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/definitely\/not\/a\/scene/);
  });

  it('a load that RESOLVES without switching is a failure — the readback, not the throw', async () => {
    game = createTestWorld({});
    // This is the branch P5 exists for and the one the throw-path test above does NOT reach:
    // `loadScene` resolves without saying which scene is now active, so a load that quietly
    // fails to switch is indistinguishable from success unless the op looks at the active path
    // afterwards. Mutation-checked: deleting
    // the `after !== p.path` check in agentBridge turns this red (the throw test alone stayed
    // green, which is how this gap was found).
    //
    // `getNext()` is stubbed to null here too — it mimics the same "couldn't read our own id"
    // fallback path that a real superseded-detection miss would take, so this exercises the
    // ORIGINAL path-comparison check rather than the myId-based branches below.
    const loadSpy = vi.spyOn(sceneManager, 'loadScene').mockResolvedValue({ keptBaseGuids: new Set<string>() });
    const nextSpy = vi.spyOn(sceneManager, 'getNext').mockReturnValue(null);
    try {
      const r = await runAgentOp('load-scene', { path: '/looks/fine.scene.json' }) as
        { ok?: boolean; error?: string; current?: string | null };
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/did not switch/i);
      expect(r.error).toMatch(/Check the path exists in this build\./);
    } finally {
      loadSpy.mockRestore();
      nextSpy.mockRestore();
    }
  });

  // ── #1425 — a manager that failed to start is reported, not a failure: the scene IS loaded. ──

  for (const [label, startupErrors, expected] of [
    ['names the manager in `warnings`', [{ manager: 'boomManager', error: new Error('init boom') }],
      ['manager "boomManager" failed to start (the scene is still loaded): init boom']],
    ['a clean load carries no `warnings` key', [], undefined],
  ] as const) {
    it(`a load that swapped in: ok:true, and ${label}`, async () => {
      game = createTestWorld({});
      const loadSpy = vi.spyOn(sceneManager, 'loadScene').mockResolvedValue({ keptBaseGuids: new Set<string>(), startupErrors: [...startupErrors] });
      const nextSpy = vi.spyOn(sceneManager, 'getNext').mockReturnValue({ id: 5, path: '/requested.scene.json', state: 'loading' } as never);
      const curSpy = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ id: 5, path: '/requested.scene.json', state: 'active' } as never);
      try {
        const r = await runAgentOp('load-scene', { path: '/requested.scene.json' }) as { ok?: boolean; warnings?: string[] };
        expect(r.ok).toBe(true);
        expect(r.warnings).toEqual(expected);
      } finally {
        loadSpy.mockRestore();
        nextSpy.mockRestore();
        curSpy.mockRestore();
      }
    });
  }

  // ── #486 finding A — a superseded load must not blame the requested path. ──

  it('superseded by a load of a DIFFERENT scene — ok:false, names the active scene, never blames the path', async () => {
    game = createTestWorld({});
    // `getNext()` hands back OUR allocated id (1); by the time the load resolves, `getCurrent()`
    // reports a DIFFERENT id whose path is a different scene — exactly what a later load winning
    // the swap looks like from the op's point of view.
    const loadSpy = vi.spyOn(sceneManager, 'loadScene').mockResolvedValue({ keptBaseGuids: new Set<string>() });
    const nextSpy = vi.spyOn(sceneManager, 'getNext').mockReturnValue({ id: 1, path: '/requested.scene.json', state: 'loading' } as never);
    const curSpy = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ id: 2, path: '/other.scene.json', state: 'active' } as never);
    try {
      const r = await runAgentOp('load-scene', { path: '/requested.scene.json' }) as
        { ok?: boolean; error?: string; superseded?: boolean; current?: string | null };
      expect(r.ok).toBe(false);
      expect(r.superseded).toBe(true);
      expect(r.current).toBe('/other.scene.json');
      expect(r.error).toMatch(/other\.scene\.json/);
      expect(r.error).not.toMatch(/Check the path exists/);
    } finally {
      loadSpy.mockRestore();
      nextSpy.mockRestore();
      curSpy.mockRestore();
    }
  });

  it('an OLDER id still active is not "superseded" — a load that never installed keeps the path message (#486 A)', async () => {
    game = createTestWorld({});
    // The discriminator is `cur.id > myId`, not `cur.id !== myId`. Scene ids are monotonic
    // (`nextSceneId++`), so a SMALLER active id means nothing newer ever installed and our own
    // load simply never became primary — reporting that as "a LATER scene load won the swap"
    // would assert from evidence that only says "the current id is not mine", which is the very
    // over-claim #486 A is about. This case must keep the original bad-path wording.
    const loadSpy = vi.spyOn(sceneManager, 'loadScene').mockResolvedValue({ keptBaseGuids: new Set<string>() });
    const nextSpy = vi.spyOn(sceneManager, 'getNext').mockReturnValue({ id: 7, path: '/requested.scene.json', state: 'loading' } as never);
    const curSpy = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ id: 3, path: '/old.scene.json', state: 'active' } as never);
    try {
      const r = await runAgentOp('load-scene', { path: '/requested.scene.json' }) as
        { ok?: boolean; error?: string; superseded?: boolean };
      expect(r.ok).toBe(false);
      expect(r.superseded).toBeUndefined();          // NOT claimed
      expect(r.error).toMatch(/Check the path exists/);
      expect(r.error).not.toMatch(/superseded/);
    } finally {
      loadSpy.mockRestore();
      nextSpy.mockRestore();
      curSpy.mockRestore();
    }
  });

  it('superseded by a concurrent load of the SAME path — ok:true with a note, worldEntityTotal omitted', async () => {
    game = createTestWorld({});
    // A different id won the swap, but it loaded the SAME requested path — the caller's requested
    // end state is actually true, just not because of THIS op's own load.
    const loadSpy = vi.spyOn(sceneManager, 'loadScene').mockResolvedValue({ keptBaseGuids: new Set<string>() });
    const nextSpy = vi.spyOn(sceneManager, 'getNext').mockReturnValue({ id: 1, path: '/requested.scene.json', state: 'loading' } as never);
    const curSpy = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ id: 2, path: '/requested.scene.json', state: 'active' } as never);
    try {
      const r = await runAgentOp('load-scene', { path: '/requested.scene.json' }) as
        { ok?: boolean; note?: string; worldEntityTotal?: number; current?: string | null };
      expect(r.ok).toBe(true);
      expect(r.note).toMatch(/superseded/i);
      expect(r.current).toBe('/requested.scene.json');
      expect(r.worldEntityTotal).toBeUndefined();
    } finally {
      loadSpy.mockRestore();
      nextSpy.mockRestore();
      curSpy.mockRestore();
    }
  });

  it('ordinary success is UNCHANGED — no false "superseded", worldEntityTotal present', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'A' }));
    const loadSpy = vi.spyOn(sceneManager, 'loadScene').mockResolvedValue({ keptBaseGuids: new Set<string>() });
    // getNext()/getCurrent() report the SAME id — our own load won, exactly like the ordinary case.
    const nextSpy = vi.spyOn(sceneManager, 'getNext').mockReturnValue({ id: 7, path: '/requested.scene.json', state: 'loading' } as never);
    const curSpy = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ id: 7, path: '/requested.scene.json', state: 'active' } as never);
    try {
      const r = await runAgentOp('load-scene', { path: '/requested.scene.json' }) as
        { ok?: boolean; superseded?: boolean; note?: string; current?: string | null; worldEntityTotal?: number };
      expect(r.ok).toBe(true);
      expect(r.superseded).toBeUndefined();
      expect(r.note).toBeUndefined();
      expect(r.current).toBe('/requested.scene.json');
      expect(r.worldEntityTotal).toBeTypeOf('number');
    } finally {
      loadSpy.mockRestore();
      nextSpy.mockRestore();
      curSpy.mockRestore();
    }
  });

  // The op's other success return: `getNext()` already cleared, so there is no id to compare and the
  // path read back decides. #1223 D3 renamed its count too. Mutation: `entityCount` on that return.
  it('a success decided by the path alone (no id to compare) also reports worldEntityTotal', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'A' }));
    const loadSpy = vi.spyOn(sceneManager, 'loadScene').mockResolvedValue({ keptBaseGuids: new Set<string>() });
    const nextSpy = vi.spyOn(sceneManager, 'getNext').mockReturnValue(null as never);
    const curSpy = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ id: 7, path: '/requested.scene.json', state: 'active' } as never);
    try {
      const r = await runAgentOp('load-scene', { path: '/requested.scene.json' }) as
        { ok?: boolean; current?: string | null; worldEntityTotal?: number; entityCount?: number };
      expect(r.ok).toBe(true);
      expect(r.worldEntityTotal).toBeGreaterThanOrEqual(1);
      expect(r.entityCount).toBeUndefined();
    } finally {
      loadSpy.mockRestore();
      nextSpy.mockRestore();
      curSpy.mockRestore();
    }
  });
});

// ── Close-out review findings (#166). Each of these failed before its fix. ──

describe('lifecycle: findings from the close-out review', () => {
  it('duplicating an entity in a CYCLIC hierarchy terminates instead of hanging', async () => {
    game = createTestWorld({});
    const a = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'A' }));
    const b = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'b', name: 'B', parentId: a.id() }));
    // Build the cycle DIRECTLY on the trait, bypassing set-traits' guard — a scene file or game
    // code could produce this state too, so the walk must survive it on its own.
    a.set(EntityAttributes, { ...(a.get(EntityAttributes) as object), parentId: b.id() } as never);

    // Before the fix this never returned: `out` grew exactly as fast as the loop index, so the
    // device app hung until it was killed. The 5s budget is the real assertion.
    const r = await Promise.race([
      runAgentOp('duplicate-entity', { guid: 'a' }) as Promise<DupReply>,
      new Promise<'HUNG'>((res) => setTimeout(() => res('HUNG'), 5000)),
    ]);

    expect(r).not.toBe('HUNG');
    expect((r as DupReply).ok).not.toBe(false);
  }, 10000);

  it('a malformed count is REFUSED, not silently turned into one copy', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'src', name: 'Src' }));

    // Before the fix: {ok:true, created:1} — the caller asked for 5 and nothing said otherwise.
    const r = await runAgentOp('duplicate-entity', { guid: 'src', count: '5' }) as DupReply;

    expect(r.ok).toBe(false);
    expect((await sceneGuids()).length).toBe(1);
  });

  it('a non-integer count is refused too', async () => {
    game = createTestWorld({});
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'src', name: 'Src' }));
    expect((await runAgentOp('duplicate-entity', { guid: 'src', count: 2.5 }) as DupReply).ok).toBe(false);
  });

  it('deleting a PARENT and its child in one call reports both real guids, not a stringified id', async () => {
    game = createTestWorld({});
    const p = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'p', name: 'P' }));
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'c', name: 'C', parentId: p.id() }));

    // Deleting P cascades to C, so reading C's guid AFTERWARDS found no entity — once a live
    // entity id disguised as a guid, which a caller would then use for a nonsensical lookup.
    const r = await runAgentOp('delete-entities', { guids: ['p', 'c'] }) as DelReply;

    expect(r.ok).not.toBe(false);
    expect(r.deleted?.sort()).toEqual(['c', 'p']);
    expect(await sceneGuids()).toEqual([]);
  });
});

/** #1199, reshaped by #1210. A live id reported as a guid is not addressable: every guid-addressed op
 *  refuses it. #1199 made each producer say `null` for a guid-less entity instead. #1210 then made a
 *  guid-less NAMED entity impossible: `spawnEntity` mints a RUNTIME guid for any entity spawned with
 *  EntityAttributes, so the rows now carry an address that RESOLVES. `null` remains only for an entity
 *  with no EntityAttributes at all. One case per producer: they were four copies once. */
describe('reply rows carry an address that resolves, never an id disguised as a guid (#1199, #1210)', () => {
  type Row = { id: number; guid: string | null; name: string };
  type StateReply = { entities: Row[] };

  it('scene-state INDEX and FULL rows carry the runtime guid, it resolves, and the id-shaped value does not', async () => {
    game = createTestWorld({});
    const bare = game.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'Bare' }));
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'real', name: 'Real' }));

    let reported = '';
    for (const params of [{}, { full: true }]) {
      const s = await runAgentOp('scene-state', params) as StateReply;
      const row = s.entities.find((e) => e.name === 'Bare')!;
      expect(row.id).toBe(bare.id());
      expect(isRuntimeGuid(row.guid)).toBe(true);
      reported = row.guid!;
      expect(s.entities.find((e) => e.name === 'Real')!.guid).toBe('real');
    }
    // The address it reports is an address: it finds exactly that entity.
    const byReported = await runAgentOp('scene-state', { guid: reported }) as StateReply;
    expect(byReported.entities.map((e) => e.id)).toEqual([bare.id()]);
    // The premise of #1199, still pinned: the id is not an address.
    const byOldValue = await runAgentOp('scene-state', { guid: String(bare.id()) }) as StateReply;
    expect(byOldValue.entities).toEqual([]);
  });

  it('contacts name a code-spawned partner by its runtime guid, and an EntityAttributes-less one as `id:<n>`', async () => {
    game = createTestWorld({});
    const ball = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'ball', name: 'Ball' }));
    const floor = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'floor', name: 'Floor' }));
    const debris = game.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'Debris' }));
    const bare = game.spawn(Transform({ x: 0 }));
    bare.remove(EntityAttributes); // un-guidable: since #1248 only a REMOVED EntityAttributes leaves no guid
    // The index takes PACKED entities (`valueOf()`, #868) and reports partner ids.
    updateContactIndex(getCurrentWorld(), ball.valueOf(), floor.valueOf(), false, 'enter');
    updateContactIndex(getCurrentWorld(), ball.valueOf(), debris.valueOf(), false, 'enter');
    updateContactIndex(getCurrentWorld(), ball.valueOf(), bare.valueOf(), false, 'enter');

    const s = await runAgentOp('scene-state', { guid: 'ball', contacts: true }) as
      { entities: Array<{ contacts?: string[] }> };
    const debrisGuid = (debris.get(EntityAttributes) as { guid: string }).guid;
    expect(isRuntimeGuid(debrisGuid)).toBe(true);
    expect(s.entities[0].contacts?.sort()).toEqual(['floor', debrisGuid, `id:${bare.id()}`].sort());
  });

  it('set-traits readback rows carry the runtime guid of a code-spawned target, and null for an un-guidable one', async () => {
    game = createTestWorld({});
    const named = game.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'Bare' }));
    const r = await runAgentOp('set-traits', { guid: (named.get(EntityAttributes) as { guid: string }).guid, set: { 'Transform.x': 3 } }) as
      { ok?: boolean; entities?: Row[] };
    expect(r.ok).not.toBe(false);
    expect(r.entities?.[0].guid).toBe((named.get(EntityAttributes) as { guid: string }).guid);
    expect(isRuntimeGuid(r.entities?.[0].guid)).toBe(true);

    const bare = game.spawn(Transform({ x: 0 }));
    bare.remove(EntityAttributes); // un-guidable (#1248: only a removed EntityAttributes leaves no guid)
    // …which is the one entity `{id}` may still name (#1223 D2).
    const r2 = await runAgentOp('set-traits', { id: bare.id(), set: { 'Transform.x': 3 } }) as
      { ok?: boolean; entities?: Row[] };
    expect(r2.ok).not.toBe(false);
    expect(r2.entities?.[0].guid).toBeNull();
  });

  // #1223 P2: named like the editor op — `deleted` lists guids and `deletedNoGuidIds` the ids of any target
  // with none. It was a count beside `guids: [null]`, which said something was deleted and not which.
  // Mutation: in deleteEntitiesLive, report `guidListFields` over no ids (drop the guid-less split).
  it('delete-entities reports the runtime guid, and the id of an un-guidable entity in deletedNoGuidIds', async () => {
    game = createTestWorld({});
    const named = game.spawn(Transform({ x: 0 }), EntityAttributes({ name: 'Bare' }));
    const namedGuid = (named.get(EntityAttributes) as { guid: string }).guid;
    // #1223 D2: an id for an entity that HAS a guid refuses the whole call, and deletes nothing.
    // Mutation: in deleteEntitiesLive, push every non-ok ref to `missing` instead of returning addressFailure.
    const byId = await runAgentOp('delete-entities', { id: named.id() }) as { ok?: boolean; code?: string; options?: string[] };
    expect(byId).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', options: [namedGuid] });
    expect(named.isAlive()).toBe(true);
    const r = await runAgentOp('delete-entities', { guid: namedGuid }) as DelReply;
    expect(r.ok).not.toBe(false);
    expect(isRuntimeGuid(namedGuid)).toBe(true);
    expect(r.deleted).toEqual([namedGuid]);

    const bare = game.spawn(Transform({ x: 0 }));
    bare.remove(EntityAttributes); // un-guidable (#1248: only a removed EntityAttributes leaves no guid)
    const r2 = await runAgentOp('delete-entities', { id: bare.id() }) as DelReply;
    expect(r2.ok).not.toBe(false);
    expect(r2).toMatchObject({ deleted: [], deletedNoGuidIds: [bare.id()] });
  });
});

describe('sim-step: the default budget covers the frame count it advertises', () => {
  it('scales with frames, so the documented max frames:600 fits its own timeout', () => {
    // Regression: a flat 3000ms default covered only ~90-190 real frames, so the op's own
    // advertised maximum failed by default. Tested directly because asserting it through the op
    // would mean waiting out a real timeout — which is how the flat default survived a mutation
    // check until this arithmetic was extracted.
    expect(simStepDefaultTimeout(1)).toBe(3000);          // small steps keep the floor
    expect(simStepDefaultTimeout(600)).toBe(20000);       // the advertised max gets the full budget
    expect(simStepDefaultTimeout(600)).toBe(SIM_STEP_MAX_TIMEOUT_MS);
    expect(simStepDefaultTimeout(200)).toBeGreaterThan(3000);   // ~8.5s: 200 frames at 30fps needs it
    expect(simStepDefaultTimeout(100)).toBeGreaterThanOrEqual(100 * 33);
  });
});

describe('read-asset-def (runtime twin, #166 P7)', () => {
  it('requires a path, and refuses a filename whose kind it cannot infer — listing the kinds', async () => {
    game = createTestWorld({});
    const noPath = await runAgentOp('read-asset-def', {}) as { ok?: boolean; error?: string };
    expect(noPath.ok).toBe(false);

    const unknown = await runAgentOp('read-asset-def', { path: '/x/thing.json' }) as
      { ok?: boolean; error?: string; options?: string[] };
    expect(unknown.ok).toBe(false);
    expect(unknown.options).toContain('particle');
    // The 7 kinds that are actually dispatched below (#842b) — material is deliberately excluded,
    // it gets its own refusal rather than being an "unsupported type" option.
    expect(unknown.options).toEqual(
      expect.arrayContaining(['particle', 'animation', 'spriteanim', 'timeline', 'rig2d', 'shader', 'animset']),
    );
    expect(unknown.options).not.toContain('material');
  });

  it('an asset NOTHING has loaded is said so, never returned as an empty def', async () => {
    game = createTestWorld({});
    // The dangerous shape is a bare null/{} — it reads as "the asset is empty" rather than
    // "nothing in this build ever loaded it", and those call for opposite next moves.
    const r = await runAgentOp('read-asset-def', { path: '/nope/absent.particle.json' }) as
      { ok?: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in the live particle cache/i);
  });

  it('a shader miss ERRORS through the shader cache too (#842b — device surface parity)', async () => {
    // Proves the device dispatch actually has a `shader` arm, not just the suffix inference and
    // the advertised `options` — a miss must route to "not in the live cache", not "unsupported
    // type", which is exactly the bug this whole fix closes.
    const r = await runAgentOp('read-asset-def', { path: '/assets/fx/glow.shader.json' }) as
      { ok?: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in the live shader cache/i);
  });

  it('reads a LIVE animset back on the device surface too (#842b)', async () => {
    const { setAnimSet, clearAnimSetCache } = await import('@modoki/engine/runtime');
    setAnimSet('/assets/fx/hero.animset.json', { source: 'guid-of-glb', clips: [{ name: 'walk', speed: 2 }] });
    const r = await runAgentOp('read-asset-def', { path: '/assets/fx/hero.animset.json' }) as
      { ok?: boolean; type?: string; def?: { clips: { speed?: number }[] } };
    expect(r.ok).not.toBe(false);
    expect(r.type).toBe('animset');
    expect(r.def?.clips[0].speed).toBe(2);
    clearAnimSetCache();
  });

  it('material refuses explicitly on the device surface too, and never as "unsupported type"', async () => {
    const r = await runAgentOp('read-asset-def', { path: '/assets/fx/glow.mat.json' }) as
      { ok?: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/only the compiled THREE\.Material is retained/);
    expect(r.error).not.toMatch(/unsupported type/);
  });

  it('infers the kind from every suffix the project uses', async () => {
    for (const [file, kind] of [
      ['a.particle.json', 'particle'], ['a.anim.json', 'animation'], ['a.timeline.json', 'timeline'],
      ['a.spriteanim.json', 'spriteanim'], ['a.rig2d.json', 'rig2d'],
    ] as const) {
      expect(inferAssetDefType(`/x/${file}`), file).toBe(kind);
    }
    expect(inferAssetDefType('/x/a.json')).toBeNull();
  });
});

describe('hierarchy legality is ONE rule (#166 P7)', () => {
  it('reparentRefusal names self-parent and cycle distinctly, and allows a legal move', async () => {
    game = createTestWorld({});
    const a = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'A' }));
    const b = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'b', name: 'B', parentId: a.id() }));
    const c = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'c', name: 'C' }));

    // This is the rule the editor's undoable reparent and the device's direct parentId write now
    // SHARE — a second copy is what P7 removed, and what let the device create a hierarchy the
    // editor considered illegal.
    expect(reparentRefusal(a.id(), a.id())).toBe('self-parent');
    expect(reparentRefusal(a.id(), b.id())).toBe('cycle');   // b is a's child
    expect(reparentRefusal(a.id(), c.id())).toBeNull();      // unrelated: legal
    expect(reparentRefusal(a.id(), 0)).toBeNull();           // scene root: always legal
  });

  // #1248: every entity carries EntityAttributes, so Time and Input are Hierarchy rows. A child under the
  // Transient singleton is dropped from every save; a singleton under an entity dies with its subtree.
  // Mutation: drop the `resource` line in hierarchy.ts's reparentRefusal.
  it('reparentRefusal refuses a resource as the child AND as the parent, and set-traits says why', async () => {
    game = createTestWorld({});
    const a = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'A' }));
    const input = game.spawn(Input(), Transient);
    const time = getCurrentWorld().queryFirst(Time)!;

    expect(reparentRefusal(a.id(), input.id())).toBe('resource');   // under Input
    expect(reparentRefusal(a.id(), time.id())).toBe('resource');    // under Time
    expect(reparentRefusal(input.id(), a.id())).toBe('resource');   // Input under an entity
    expect(reparentRefusal(input.id(), 0)).toBeNull();              // a resource at the root stays legal

    const r = await runAgentOp('set-traits', { guid: 'a', set: { 'EntityAttributes.parentId': input.id() } }) as { ok?: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/resource entity/);
  });

  // #1248. Mutation: drop the parentRefusal check in liveLifecycle.ts's createEntityLive.
  it('device create-entity under a resource parentGuid is refused, and nothing is created', async () => {
    game = createTestWorld({});
    const input = game.spawn(Input(), Transient);
    const guid = (input.get(EntityAttributes) as { guid: string }).guid;
    const before = getCurrentWorld().entities.length;
    const r = await runAgentOp('create-entity', { spec: { kind: 'empty' }, parentGuid: guid }) as { ok?: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/is a resource/);
    expect(getCurrentWorld().entities.length).toBe(before);
  });

  // #1248. Mutation: drop the isResourceEntity refusal in liveLifecycle.ts's duplicateEntityLive.
  it('duplicate-entity refuses a resource — a copy of Input would share its per-frame maps', async () => {
    game = createTestWorld({});
    const input = game.spawn(Input(), Transient);
    const r = await runAgentOp('duplicate-entity', { guid: (input.get(EntityAttributes) as { guid: string }).guid }) as { ok?: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/is a resource/);
    expect(getCurrentWorld().query(Input).length).toBe(1);
    // Accept side: an ordinary entity still duplicates.
    game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'A' }));
    const ok = await runAgentOp('duplicate-entity', { guid: 'a' }) as { ok?: boolean };
    expect(ok.ok).not.toBe(false);
  });
});

describe('hierarchy: the cycle-safety bound must not cut a LEGAL deep chain short', () => {
  it('detects an ancestor at the far end of a chain as long as the world allows', async () => {
    game = createTestWorld({});
    // A 60-deep chain in a 60-entity world is the worst legal case: the walk from the deepest
    // node to the root traverses every link. `isAncestorOf` bounds itself with `hops++ <=
    // byId.size` to survive an ALREADY-cyclic graph — if that bound is ever tightened below the
    // entity count, this walk ends early and returns false, which ALLOWS a reparent that would
    // create a cycle. Silent, and only reproducible on a deep hierarchy.
    const ids: number[] = [];
    let parentId = 0;
    for (let i = 0; i < 60; i++) {
      const e = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: `n${i}`, name: `N${i}`, parentId }));
      parentId = e.id();
      ids.push(parentId);
    }
    const root = ids[0], deepest = ids[ids.length - 1];

    expect(reparentRefusal(root, deepest)).toBe('cycle');   // root under its own deepest descendant
    expect(reparentRefusal(deepest, root)).toBeNull();      // the legal direction stays legal
  });

  it('terminates on an already-cyclic graph instead of hanging', async () => {
    game = createTestWorld({});
    const a = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'a', name: 'A' }));
    const b = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'b', name: 'B', parentId: a.id() }));
    // Author the cycle directly on the trait, bypassing every guard — a scene file can do this.
    a.set(EntityAttributes, { ...(a.get(EntityAttributes) as object), parentId: b.id() } as never);

    const c = game.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'c', name: 'C' }));
    // Asking about an unrelated entity must still RETURN, walking the poisoned chain safely.
    const answered = await Promise.race([
      Promise.resolve().then(() => reparentRefusal(c.id(), a.id())),
      new Promise((res) => setTimeout(() => res('HUNG'), 3000)),
    ]);
    expect(answered).not.toBe('HUNG');
  }, 8000);
});

/** The DEVICE twin of #855's probe. `device_read_asset_def`'s enum is a second hand-kept copy of
 *  what an op serves, in a package that likewise cannot import the engine — so it drifts for the
 *  same reason and was covered by the same const-vs-const guard. Rationale + the shared classifier:
 *  `engine/tests/tools/readAssetDefServed.ts`. Editor twin: `tests/editor/readAssetDef.test.ts`.
 *
 *  Two surfaces, two files, on purpose: `registerAgentOp` is register-or-replace on one Map, and
 *  importing the editor ops would permanently swap this runtime twin out of the registry. */
describe('device_read_asset_def\'s enum lists exactly what THIS op dispatches (#855)', () => {
  /** The device op RETURNS `{ok:false, error}` where the editor op throws. */
  const probe: ReadAssetDefProbe = async ({ path, type }) => {
    const r = await runAgentOp('read-asset-def', { path, type }) as { ok?: boolean; error?: string };
    return r.ok === false ? (r.error ?? 'refused with no error text') : '';
  };

  it('the probe DISTINGUISHES a dispatched type from one with no arm', async () => {
    // Non-vacuity: an assertion resting on a probe that cannot tell these apart proves nothing.
    game = createTestWorld({});
    expect(classifyReadAssetDef('particle', await probe({ path: probePathFor('particle'), type: 'particle' })))
      .toBe('served');
    expect(classifyReadAssetDef('atlas', await probe({ path: probePathFor('atlas'), type: 'atlas' })))
      .toBe('no-branch');
  });

  it('every type in the device enum is one the op actually dispatches, and no other is', async () => {
    game = createTestWorld({});
    const report = await probeServedTypes(ASSET_SCHEMA_TYPES, probe);
    expect([...DEVICE_READ_ASSET_DEF_TYPES].sort()).toEqual([...report.served].sort());
  });

  it('serves the SAME set as the editor twin — two ops, one advertised contract', async () => {
    // The editor op cannot be probed here (see the header), so this is the honest const-vs-const
    // half: both enums are hand-kept copies, and each is pinned to its OWN op in its own file.
    // What this adds is that the two ops have not diverged from each other.
    const { READ_ASSET_DEF_TYPES_FOR_TESTS } = await import('../../tools/modoki-mcp/src/tools/assets');
    expect([...DEVICE_READ_ASSET_DEF_TYPES].sort()).toEqual([...READ_ASSET_DEF_TYPES_FOR_TESTS].sort());
  });
});

/** #1030 — the membership test behind the relay's DECLINE. The dev server broadcasts
 *  `modoki:request` to every HMR client, so this handler runs in every open tab; a tab without a
 *  given op must say "I do not have this" rather than reject, or it settles the request on the
 *  editor's behalf and a live editor's state repair is skipped silently.
 *
 *  ⚠️ Tested as MEMBERSHIP rather than through `runAgentOp`'s throw, because that is the whole
 *  point: catching `/unknown agent op/` from the dispatch would miscount an op that legitimately
 *  throws those words, and would have RUN the op before deciding whether it existed. */
describe('hasAgentOp — the membership half of the relay decline test (#1030; servesAgentOp adds `accepts`, #1559)', () => {
  it('is true for a registered op and false for an unregistered one', () => {
    const registered = listAgentOps();
    expect(registered.length).toBeGreaterThan(0);
    for (const name of registered) expect(hasAgentOp(name)).toBe(true);
    expect(hasAgentOp('definitely-not-an-op')).toBe(false);
    expect(hasAgentOp('')).toBe(false);
  });

  it('is false for an EDITOR op in a runtime build — the exact tab that used to win the race', () => {
    // `apply-asset-path-moves` is registered inside registerEditorAgentOps(), which a runtime page
    // never calls. This suite is that build: the op is absent, so the client declines, and #1030's
    // counting is what stops that decline standing in for the editor's answer.
    expect(listAgentOps()).not.toContain('apply-asset-path-moves');
    expect(hasAgentOp('apply-asset-path-moves')).toBe(false);
  });

  it('does not RUN the op it is asked about', async () => {
    const { registerAgentOp } = await import('../../app/debug/agentBridge');
    let ran = 0;
    registerAgentOp('probe-1030', () => { ran += 1; return null; });
    expect(hasAgentOp('probe-1030')).toBe(true);
    expect(ran).toBe(0);
  });
});

/** ⚠️ A SOURCE guard, and the only kind available here (#1030 close-out F1).
 *
 *  `relayResponseFor`'s DEFAULTS are `servesAgentOp` and `runAgentOp`, so the handler calls it with
 *  the message alone — nothing to pass is nothing to mis-wire. But an argument can still be ADDED,
 *  and `relayResponseFor(msg, () => true)` makes every client claim every op, restoring #1030's
 *  race with the whole suite green. The handler lives inside `initAgentBridge` behind a live Vite
 *  `hot`, so no behavioural test can reach it; the decision it makes is tested below, and this
 *  pins that the decision is reached with its real collaborators.
 *
 *  If this ever needs to take an override for a genuine reason, delete this guard deliberately and
 *  say why — do not widen the pattern until it passes. */
describe('the modoki:request handler is wired to the REAL membership test (#1030)', () => {
  it('calls relayResponseFor with the message alone — no overridden collaborators', () => {
    // ⚠️ Through `readScannedSource`, not `fs.readFileSync` — `commentStripperIsShared.test.ts`
    // (#812) fails any guard that matches a pattern against RAW repo source, because a comment can
    // then satisfy the assertion on its own. It caught this guard's first draft doing exactly that.
    const { code: src } = readScannedSource(
      path.resolve(__dirname, '../../app/debug/agentBridge.ts'));
    const calls = [...src.matchAll(/relayResponseFor\(([^)]*)\)/g)].map((m) => m[1].trim());
    // ⚠️ The DECLARATION matches this pattern too (`relayResponseFor(\n  msg: {…`), so a naive
    // `startsWith('msg')` finds two and the guard fails on a clean tree — which it did. A call
    // site's argument list is one line and carries no type annotation.
    const wired = calls.filter((a) => a.startsWith('msg') && !a.includes(':') && !a.includes('\n'));
    expect(wired, 'no relayResponseFor(msg…) call site found — fix the parser, not the test')
      .toHaveLength(1);
    expect(wired[0], 'the relay handler must not override `has` or `run`').toBe('msg');
  });
});

/** #1030 — the CLIENT half of the fix, which the server's decline counting is inert without.
 *  `relayResponseFor` is the decision the `modoki:request` handler makes; the handler itself lives
 *  behind a live Vite `hot`, so the decision was extracted to be testable at all. */
describe('relayResponseFor — what a client answers to a relayed request (#1030)', () => {
  const msg = { id: 7, op: 'apply-asset-path-moves', params: { moves: [] } };

  it('DECLINES an op it does not have — no error, and the op is never run', async () => {
    let ran = 0;
    const r = await relayResponseFor(msg, () => false, async () => { ran += 1; return 'nope'; });
    expect(r).toEqual({ id: 7, declined: true });
    expect(r.error).toBeUndefined();     // ⚠️ a rejection here is what let a runtime tab win
    expect(ran).toBe(0);                 // ⚠️ membership is asked BEFORE dispatch
  });

  it('answers with the RESULT when it owns the op', async () => {
    const r = await relayResponseFor(msg, () => true, async () => ({ notes: ['ok'] }));
    expect(r).toEqual({ id: 7, result: { notes: ['ok'] } });
    expect(r.declined).toBeUndefined();
  });

  it('reports a THROW as an error, never as a decline — it is an answer', async () => {
    // ⚠️ The distinction the whole fix rests on. Only the client that owns an op can throw from
    // it, so that failure is authoritative and must settle the request immediately; marking it
    // `declined` would make a real failure wait for other clients and then be reported as
    // "nothing has this op".
    const r = await relayResponseFor(msg, () => true, async () => { throw new Error('boom'); });
    expect(r).toEqual({ id: 7, error: 'boom' });
    expect(r.declined).toBeUndefined();
  });

  it('does not special-case an op that THROWS the words "unknown agent op"', async () => {
    // The reason membership is a registry lookup rather than a string test on the throw: an op
    // that mentions those words in its own error would otherwise be miscounted as a decline.
    const r = await relayResponseFor(msg, () => true,
      async () => { throw new Error("cannot proxy: unknown agent op 'inner' on the device"); });
    expect(r.declined).toBeUndefined();
    expect(r.error).toMatch(/unknown agent op 'inner'/);
  });
});

/** #1030 close-out round 4 — the PRODUCER of the announce.
 *
 *  ⚠️ Round 3 gave the server side a seam test and left this side covered by nothing: deleting
 *  `announce(); hot.on('vite:ws:connect', announce);` from `initAgentBridge` left 3,621 tests
 *  green. `modoki:bridge-hello` existed in three places — the producer, the consumer, and a test
 *  that FIRED the event itself, so it exercised only the consumer. That is the same
 *  producer-nobody-wired shape as the bug being fixed, two layers down. */
describe('registerRelayResponder — announce, THEN take the ops (#1030)', () => {
  function fakeHot() {
    const sent: { event: string; data: unknown }[] = [];
    const handlers = new Map<string, (d: never) => void>();
    // ⚠️ ONE ordered log across BOTH calls. Separate `sent`/`on` arrays cannot express "the
    // announce came first" — the previous version compared indices within each list and passed
    // happily with the announce moved to the very end, which is the mutation that matters.
    const log: string[] = [];
    return {
      sent, handlers, log,
      hot: {
        send: (event: string, data: unknown) => { log.push(`send:${event}`); sent.push({ event, data }); },
        on: (event: string, cb: (d: never) => void) => {
          log.push(`on:${event}`);
          // ⚠️ Loud rather than last-wins. A bare `handlers.set` keeps only the LAST listener:
          // measured, a duplicate `hot.on('modoki:request', …)` in `registerRelayResponder` left
          // all 50 tests in this file green. Real Vite ACCUMULATES listeners, so that duplicate
          // means every relayed op runs twice and TWO `modoki:response` frames go back for one
          // request. It is a live merge hazard, not a hypothetical: a conflict resolution that
          // keeps the old inline `hot.on(…)` block AND the new `registerRelayResponder(hot)` call
          // reinstates exactly that, and the gate stays green.
          // (The source guard at `the modoki:request handler is wired to the REAL membership test`
          // only catches the variant that adds a second `relayResponseFor(msg)` call site.)
          if (handlers.has(event)) throw new Error(`a SECOND '${event}' listener was registered — real Vite calls BOTH`);
          handlers.set(event, cb);
        },
      },
    };
  }

  it('ANNOUNCES, and does so BEFORE it can answer anything', () => {
    const f = fakeHot();
    registerRelayResponder(f.hot);

    const announcedAt = found(f.log.indexOf('send:modoki:bridge-hello'), 'a SENT modoki:bridge-hello');
    const tookOpsAt = found(f.log.indexOf('on:modoki:request'), 'a registered modoki:request handler');
    // ⚠️ THE assertion. "Nothing may answer `modoki:request` before it has announced" — a client
    // that can decline while uncounted completes a denominator that was one short, which is
    // #1030. Both-happened is not enough: with the announce moved to the end of the function the
    // weaker version of this test passed.
    expect(announcedAt, 'the op handler was taken BEFORE announcing — a decline could arrive uncounted')
      .toBeLessThan(tookOpsAt);
    // The announce is the first thing SENT, and its body is empty on purpose — the server keys
    // the client off the socket identity, never off the payload.
    expect(f.sent[0]).toEqual({ event: 'modoki:bridge-hello', data: {} });
  });

  it('answers a relayed request through relayResponseFor — declining an op it does not have', async () => {
    const f = fakeHot();
    registerRelayResponder(f.hot);
    const handler = f.handlers.get('modoki:request')!;
    expect(handler).toBeTruthy();
    f.sent.length = 0;
    await handler({ id: 9, op: 'definitely-not-an-op' } as never);
    expect(f.sent).toEqual([{ event: 'modoki:response', data: { id: 9, declined: true } }]);
  });

  it('re-announces when the connect listener fires — cheap, and correct if Vite ever reconnects', () => {
    // ⚠️ This listener CANNOT fire in Vite 8 today (it emits vite:ws:connect once per page, from
    // inside /@vite/client, long before this module is dynamically imported — and it reloads the
    // page rather than reconnecting in place). Kept because it costs nothing and is right if that
    // changes; pinned so it stays correct rather than rotting into a listener that sends the
    // wrong thing. Do NOT cite it as the reconnect mechanism — the fresh page's own announce is.
    const f = fakeHot();
    registerRelayResponder(f.hot);
    f.sent.length = 0;
    f.handlers.get('vite:ws:connect')!(undefined as never);
    expect(f.sent).toEqual([{ event: 'modoki:bridge-hello', data: {} }]);
  });
});
