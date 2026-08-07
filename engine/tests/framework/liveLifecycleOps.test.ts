/** create-entity / duplicate-entity / delete-entities — the RUNTIME (undo-free) twins registered in
 *  agentBridge so the DEVICE has them (#166 P2, docs/plans/device-authoring-parity-plan.md).
 *
 *  In an editor session these op names are replaced at startup by the editor's undoable versions;
 *  what runs here is what a phone runs. The rules pinned below are the ones whose absence would be
 *  a false success: a copy that silently drops its children, two entities sharing one guid, and a
 *  partial delete reported alongside a miss. */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld, Transform, EntityAttributes,
  getCurrentWorld, setTimeScale, getTimeScale, sceneManager, reparentRefusal } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { runAgentOp, simStepDefaultTimeout, SIM_STEP_MAX_TIMEOUT_MS, inferAssetDefType } from '../../app/debug/agentBridge';

registerAllTraits();

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; });

type CreateReply = { ok?: boolean; error?: string; options?: string[]; id?: number; guid?: string; name?: string; saved?: boolean };
type DupReply = { ok?: boolean; error?: string; created?: number; entitiesPerCopy?: number; roots?: Array<{ id: number; guid: string }> };
type DelReply = { ok?: boolean; error?: string; deleted?: number; guids?: string[] };

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
    expect(r.deleted).toBe(1);
    expect(r.guids).toEqual(['a']);
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

  it('refuses to step a RUNNING world, naming how to pause it', async () => {
    game = createTestWorld({});
    // A test world runs at timeScale 1 — stepping it is meaningless, and silently pausing it would
    // be a side effect the caller never asked for (the editor's step op makes the same refusal).
    const r = await runAgentOp('sim-step', { frames: 1 }) as { ok?: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/set-timescale/);
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
    // `loadScene` resolves `void`, so a load that quietly fails to switch is indistinguishable
    // from success unless the op looks at the active path afterwards. Mutation-checked: deleting
    // the `after !== p.path` check in agentBridge turns this red (the throw test alone stayed
    // green, which is how this gap was found).
    const spy = vi.spyOn(sceneManager, 'loadScene').mockResolvedValue(undefined as never);
    try {
      const r = await runAgentOp('load-scene', { path: '/looks/fine.scene.json' }) as
        { ok?: boolean; error?: string; current?: string | null };
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/did not switch/i);
    } finally {
      spy.mockRestore();
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

    // Deleting P cascades to C, so reading C's guid AFTERWARDS fell through to String(id) — a live
    // entity id disguised as a guid, which a caller would then use for a nonsensical lookup.
    const r = await runAgentOp('delete-entities', { guids: ['p', 'c'] }) as DelReply;

    expect(r.ok).not.toBe(false);
    expect(r.guids?.sort()).toEqual(['c', 'p']);
    expect(await sceneGuids()).toEqual([]);
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
