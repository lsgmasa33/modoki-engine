/** Runtime guids (#1210) — `spawnEntity` gives every entity spawned with an empty
 *  `EntityAttributes.guid` an address, so a code-spawned entity (a shot, a board cell, an imported
 *  model part) is addressable by guid instead of by an id that every reload reassigns.
 *
 *  Each case pins one mechanism and names the mutation that must turn it red:
 *  - the mint itself, and that it touches only empty guids on EntityAttributes carriers;
 *  - ORDER: minted before `registerEntity`, so `@spawn` and the guid index see it;
 *  - DETERMINISM: identical harness runs mint identical guids (the harness restores the generation);
 *  - STALENESS: a guid from another world MISSES rather than naming that world's entity — the
 *    generation is an engine-owned counter, not koota's reused world id or a per-world restart;
 *  - the re-mint ALIAS: a save that replaces the runtime guid with a durable one does not strand an
 *    agent holding the runtime one; a despawn does;
 *  - the fill-if-empty sites that now actually receive a runtime guid (guidSeed, prefab roots). */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld } from 'koota';
import {
  createTestWorld, type TestWorld, Transform, EntityAttributes, PrefabInstance, BoneAttachment, CameraFrame,
  registerUIAction, unregisterUIAction, dispatchUIAction, dispatchGameAction,
  spawnEntity, destroyEntity, findEntityByGuid, getCurrentWorld, spawnPrefabInstance, Time, Input, getAllEntities,
} from '@modoki/engine/runtime';
import {
  instantiatePrefabAsync, instantiatePrefab, setPrefabSource, serializeScene, captureInstanceStructure, rebuildInstance, type PrefabFile,
} from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import {
  isRuntimeGuid, parseRuntimeGuid, deriveGuid, isGuid, durableGuid,
} from '../../packages/modoki/src/runtime/core/assetRefRules';
import { _getRuntimeGuidGeneration, _runtimeAddressRows, getGuidIndex, rebuildGuidIndexSync } from '../../packages/modoki/src/runtime/core/ecs/world';
import { setActiveCameraFrame } from '../../packages/modoki/src/runtime/rendering/scene3DSync';
import { computeLayoutBounds } from '../../app/debug/layoutDump';
import { runAgentOp } from '../../app/debug/agentBridge';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefab';
import { isSkippedByPrimarySave } from '../../packages/modoki/src/editor/scene/serialize';
import { Transient } from '../../packages/modoki/src/runtime/core/traits/Transient';

registerAllTraits();

const guidOf = (e: { get(t: unknown): unknown }) => (e.get(EntityAttributes) as { guid: string }).guid;

let tw: TestWorld | undefined;
afterEach(() => { tw?.dispose(); tw = undefined; });

describe('spawnEntity mints a runtime guid (#1210)', () => {
  it('gives an empty guid a runtime guid, and leaves an authored guid alone', () => {
    tw = createTestWorld({});
    const shot = tw.spawn(Transform(), EntityAttributes({ name: 'Shot' }));
    const authored = tw.spawn(Transform(), EntityAttributes({ name: 'Auth', guid: 'a1111111-1111-4111-8111-111111111111' }));
    expect(isRuntimeGuid(guidOf(shot))).toBe(true);
    expect(guidOf(authored)).toBe('a1111111-1111-4111-8111-111111111111');
  });

  // #1248. Mutation: drop the EntityAttributes add in `spawnEntity`.
  it('gives an entity spawned WITHOUT EntityAttributes the trait and a runtime guid that resolves', () => {
    tw = createTestWorld({});
    const bare = tw.spawn(Transform());
    expect(bare.has(EntityAttributes)).toBe(true);
    expect(isRuntimeGuid(guidOf(bare))).toBe(true);
    expect(findEntityByGuid(guidOf(bare))).toBe(bare);
    // The harness's own Time singleton is spawned bare too.
    const time = getCurrentWorld().queryFirst(Time)!;
    expect(isRuntimeGuid(guidOf(time))).toBe(true);
  });

  // #1248. Mutation: drop the `Input` registration in registerTraits.ts.
  it('the Input singleton reads as a RESOURCE, so the Hierarchy will not delete it', () => {
    tw = createTestWorld({});
    tw.spawn(Input(), Transient);
    const row = getAllEntities().find((e) => e.traits.includes('Input'));
    expect(row?.isResource).toBe(true);
    expect(row?.name).toBe('Input (resource)');
  });

  it('mints before registerEntity: @spawn carries the guid, and the index resolves it at once', () => {
    tw = createTestWorld({});
    const shot = tw.spawn(Transform(), EntityAttributes({ name: 'Shot' }));
    const spawn = tw.events({ type: '@spawn' }).at(-1)!;
    expect((spawn.payload as { entity: unknown }).entity).toBe(guidOf(shot));
    expect(findEntityByGuid(guidOf(shot))).toBe(shot);
  });

  it('identical harness runs mint identical guids and journal identical payloads', () => {
    const run = () => {
      const t = createTestWorld({});
      const guids = [0, 1, 2].map((i) => guidOf(t.spawn(Transform({ x: i }), EntityAttributes({ name: `n${i}` }))));
      const events = JSON.stringify(t.events().map((e) => [e.tick, e.type, e.payload]));
      t.dispose();
      return { guids, events };
    };
    const a = run();
    const b = run();
    expect(b.guids).toEqual(a.guids);
    expect(b.events).toEqual(a.events);
    expect(new Set(a.guids).size).toBe(3);
  });

  it('a runtime guid from another world misses instead of naming that world\'s entity', () => {
    tw = createTestWorld({});
    const inA = tw.spawn(Transform(), EntityAttributes({ name: 'A' }));
    const worldB = createWorld();
    try {
      // Spawn in B until it reaches A's ordinal (the harness's own Time took an earlier one since
      // #1248), so the two guids differ ONLY in generation.
      const target = parseRuntimeGuid(guidOf(inA))!.ordinal;
      let inB = spawnEntity(worldB, Transform(), EntityAttributes({ name: 'B' }));
      while (parseRuntimeGuid(guidOf(inB))!.ordinal < target) inB = spawnEntity(worldB, Transform(), EntityAttributes({ name: 'B' }));
      expect(parseRuntimeGuid(guidOf(inB))!.ordinal).toBe(parseRuntimeGuid(guidOf(inA))!.ordinal);
      expect(findEntityByGuid(guidOf(inA), worldB)).toBeUndefined();
      expect(findEntityByGuid(guidOf(inB), worldB)).toBe(inB);
      expect(findEntityByGuid(guidOf(inA), tw.world)).toBe(inA);
    } finally { worldB.destroy(); }
  });

  it('still names its entity after a save re-mints a durable guid over it, and misses once despawned', () => {
    tw = createTestWorld({});
    const shot = tw.spawn(Transform(), EntityAttributes({ name: 'Shot' }));
    const runtime = guidOf(shot);
    shot.set(EntityAttributes, { ...(shot.get(EntityAttributes) as object), guid: 'b2222222-2222-4222-8222-222222222222' });
    expect(findEntityByGuid(runtime)).toBe(shot);
    destroyEntity(shot);
    expect(findEntityByGuid(runtime)).toBeUndefined();
    // …and a later spawn never takes the dead one's address.
    const next = tw.spawn(Transform(), EntityAttributes({ name: 'Next' }));
    expect(guidOf(next)).not.toBe(runtime);
    expect(findEntityByGuid(runtime)).toBeUndefined();
  });

  it('a despawn releases its address row, so a per-shot spawner does not grow the table', () => {
    tw = createTestWorld({});
    const base = _runtimeAddressRows(tw.world);
    for (let i = 0; i < 200; i++) destroyEntity(tw.spawn(Transform(), EntityAttributes({ name: 'Shot' })));
    expect(_runtimeAddressRows(tw.world)).toBe(base);
    tw.spawn(Transform(), EntityAttributes({ name: 'Kept' }));
    expect(_runtimeAddressRows(tw.world)).toBe(base + 1); // the probe counts live rows, not nothing
  });

  it('runtime guids stay out of the guid index — they resolve through the address table', () => {
    tw = createTestWorld({});
    const shot = tw.spawn(Transform(), EntityAttributes({ name: 'Shot' }));
    expect(getGuidIndex(tw.world).has(guidOf(shot))).toBe(false);
    expect(findEntityByGuid(guidOf(shot))).toBe(shot); // …and still resolve
    const saved = tw.spawn(Transform(), EntityAttributes({ name: 'Saved', guid: 'f5555555-5555-4555-8555-555555555555' }));
    expect(getGuidIndex(tw.world).get('f5555555-5555-4555-8555-555555555555')).toBe(saved); // durable ones do enter it
    rebuildGuidIndexSync(tw.world); // the self-healing rescan follows the same rule
    expect(getGuidIndex(tw.world).has(guidOf(shot))).toBe(false);
    expect(getGuidIndex(tw.world).get('f5555555-5555-4555-8555-555555555555')).toBe(saved);
  });

  it('dispose restores the generation counter it found — never resets it', () => {
    // A world outside any harness takes a generation first, as the editor's world would.
    const outside = createWorld();
    try {
      spawnEntity(outside, Transform(), EntityAttributes({ name: 'Outside' }));
      const before = _getRuntimeGuidGeneration();
      const t = createTestWorld({});
      t.spawn(Transform(), EntityAttributes({ name: 'In' }));
      expect(_getRuntimeGuidGeneration()).toBe(before + 1);
      t.dispose();
      expect(_getRuntimeGuidGeneration()).toBe(before);
    } finally { outside.destroy(); }
  });
});

describe('fill-if-empty sites that now receive a runtime guid (#1210)', () => {
  const prefab = (): PrefabFile => ({
    id: 'c3333333-3333-4333-8333-333333333333', version: 2, name: 'Kit', rootLocalId: 1,
    entities: [
      { localId: 1, name: 'Kit', traits: { EntityAttributes: { name: 'Kit', parentId: 0 }, Transform: {} } },
      { localId: 2, name: 'Part', traits: { EntityAttributes: { name: 'Part', parentId: 1 }, Transform: {} } },
    ],
  } as unknown as PrefabFile);

  it('spawnPrefabInstance: guidSeed wins over the root\'s runtime guid', () => {
    tw = createTestWorld({});
    const rootId = spawnPrefabInstance(tw.world, prefab() as never, { source: 'c3333333-3333-4333-8333-333333333333', guidSeed: 'entries|row|3' });
    const root = [...tw.world.entities].find((e) => e.id() === rootId)!;
    expect(guidOf(root)).toBe(deriveGuid('entries|row|3'));
  });

  it('spawnPrefabInstance without a seed still gives the root a DURABLE guid', () => {
    tw = createTestWorld({});
    const rootId = spawnPrefabInstance(tw.world, prefab() as never, { source: 'c3333333-3333-4333-8333-333333333333' });
    const root = [...tw.world.entities].find((e) => e.id() === rootId)!;
    expect(isGuid(guidOf(root)) && !isRuntimeGuid(guidOf(root))).toBe(true);
  });

  it('instantiatePrefabAsync mints a durable root guid over the runtime one, so members derive from it', async () => {
    tw = createTestWorld({});
    const rootId = await instantiatePrefabAsync(prefab());
    const all = [...getCurrentWorld().entities];
    const root = all.find((e) => e.id() === rootId)!;
    const part = all.find((e) => e.has(PrefabInstance) && (e.get(EntityAttributes) as { name: string }).name === 'Part')!;
    expect(durableGuid(guidOf(root))).toBe(guidOf(root));
    expect(guidOf(part)).toBe(deriveGuid(`${guidOf(root)}|2`));
  });

  it('a serialized prefab-instance root carries a durable guid, never its runtime one', async () => {
    tw = createTestWorld({});
    // Hand-spawned (not spawnPrefabInstance, which tags a play-mode spawn Transient and so is never
    // serialized): an instance root with no guid, exactly as an editor-time spawn arrives.
    const root = spawnEntity(tw.world, Transform(), EntityAttributes({ name: 'KitRoot' }),
      PrefabInstance({ source: 'c3333333-3333-4333-8333-333333333333', localId: 1, rootInstanceId: 0 }));
    expect(isRuntimeGuid(guidOf(root))).toBe(true);
    // Cached, so the root is captured as a prefab reference whose identity rides on the top-level
    // `entry.guid` (not EntityAttributes) — the site this pins.
    setPrefabCache('c3333333-3333-4333-8333-333333333333', prefab() as never);
    const scene = await serializeScene();
    const entry = scene.entities.find((e) => (e as { prefab?: string }).prefab === 'c3333333-3333-4333-8333-333333333333');
    expect(entry).toBeDefined();
    const written = (entry as { guid?: string }).guid;
    setPrefabCache('c3333333-3333-4333-8333-333333333333', null);
    expect(isGuid(written) && !isRuntimeGuid(written)).toBe(true);
  });
});

/** Review of Phase 1 (#1210): the paths that COPY an entity or a guid, and the string-ref form. */
describe('copies and string refs under a real mint (#1210)', () => {
  const KIT = 'c3333333-3333-4333-8333-333333333333';
  const NESTED = 'c4444444-4444-4444-8444-444444444444';
  const kit = (): PrefabFile => ({
    id: KIT, version: 2, name: 'Kit', rootLocalId: 1,
    entities: [
      { localId: 1, name: 'Kit', traits: { EntityAttributes: { name: 'Kit', parentId: 0 }, Transform: {} } },
      { localId: 2, name: 'Part', traits: { EntityAttributes: { name: 'Part', parentId: 1 }, Transform: {} } },
    ],
  } as unknown as PrefabFile);
  const byName = (name: string) => [...getCurrentWorld().entities]
    .find((e) => e.has(EntityAttributes) && (e.get(EntityAttributes) as { name: string }).name === name)!;
  afterEach(() => { setPrefabCache(KIT, null); setPrefabCache(NESTED, null); });

  it('spawning with a COPIED runtime guid re-mints it: the copy answers to its own address', () => {
    tw = createTestWorld({});
    const original = tw.spawn(Transform(), EntityAttributes({ name: 'Original' }));
    const copy = tw.spawn(Transform(), EntityAttributes({ name: 'Copy', guid: guidOf(original) }));
    expect(isRuntimeGuid(guidOf(copy))).toBe(true);
    expect(guidOf(copy)).not.toBe(guidOf(original));
    expect(findEntityByGuid(guidOf(copy))).toBe(copy);
    expect(findEntityByGuid(guidOf(original))).toBe(original);
  });

  it('a snapshot of an instance with a runtime-guid ADDED child writes no runtime guid — node or trait', async () => {
    tw = createTestWorld({});
    setPrefabCache(KIT, kit() as never);
    const rootId = instantiatePrefab(kit() as never);
    setPrefabSource(rootId, KIT);
    const part = byName('Part');
    const added = spawnEntity(tw.world, Transform({ x: 3 }), EntityAttributes({ name: 'Spark', parentId: part.id() }));
    expect(isRuntimeGuid(guidOf(added))).toBe(true);
    expect(rootId).toBeGreaterThan(0);
    const scene = await serializeScene(); // the Play snapshot path: throws under vitest on a leak
    const entry = scene.entities.find((e) => (e as { prefab?: string }).prefab === KIT) as { added?: Array<{ guid: string; traits: Record<string, { guid?: string }> }> };
    const node = entry.added!.find((n) => (n.traits.EntityAttributes as { name?: string }).name === 'Spark')!;
    expect(node.guid).toBe('');
    expect(node.traits.EntityAttributes.guid).toBeUndefined();
  });

  it('a user-added NESTED instance holding a runtime guid is captured unguided', () => {
    tw = createTestWorld({});
    setPrefabCache(KIT, kit() as never);
    setPrefabCache(NESTED, { ...kit(), id: NESTED, name: 'Nested' } as never);
    const rootId = instantiatePrefab(kit() as never);
    const part = byName('Part');
    const nested = spawnEntity(tw.world, Transform(), EntityAttributes({ name: 'Inner', parentId: part.id() }),
      PrefabInstance({ source: NESTED, localId: 1, rootInstanceId: 0 }));
    nested.set(PrefabInstance, { ...(nested.get(PrefabInstance) as object), rootInstanceId: nested.id() });
    expect(isRuntimeGuid(guidOf(nested))).toBe(true);
    const node = captureInstanceStructure(rootId, kit() as never).added.find((n) => (n as { prefab?: string }).prefab === NESTED)!;
    expect(node).toBeDefined();
    expect(node.guid).toBe('');
  });

  it('a guid-STRING ref to a live entity\'s runtime guid is written as that entity\'s durable guid', async () => {
    tw = createTestWorld({});
    const target = tw.spawn(Transform(), EntityAttributes({ name: 'Hand' }));
    tw.spawn(Transform(), EntityAttributes({ name: 'Sword' }), BoneAttachment({ target: guidOf(target), bone: 'R' }));
    const scene = await serializeScene();
    const hand = scene.entities.find((e) => e.name === 'Hand')!;
    const sword = scene.entities.find((e) => e.name === 'Sword')!;
    const handGuid = (hand.traits.EntityAttributes as { guid: string }).guid;
    expect(isRuntimeGuid(handGuid)).toBe(false);
    expect((sword.traits.BoneAttachment as { target: string }).target).toBe(handGuid);
  });

  it('…and a string ref whose runtime target is gone still trips rather than being written', async () => {
    tw = createTestWorld({});
    const target = tw.spawn(Transform(), EntityAttributes({ name: 'Gone' }));
    const dead = guidOf(target);
    destroyEntity(target);
    tw.spawn(Transform(), EntityAttributes({ name: 'Sword2' }), BoneAttachment({ target: dead, bone: 'R' }));
    await expect(serializeScene()).rejects.toThrow(/runtime guid/);
  });

  it('rebuildInstance does not copy the old root\'s runtime guid onto the new root', () => {
    tw = createTestWorld({});
    const rootId = instantiatePrefab(kit() as never);
    const oldGuid = guidOf([...tw.world.entities].find((e) => e.id() === rootId)!);
    expect(isRuntimeGuid(oldGuid)).toBe(true);
    const newRootId = rebuildInstance(rootId, KIT, kit() as never, {}, {});
    const newRoot = [...tw.world.entities].find((e) => e.id() === newRootId)!;
    expect(guidOf(newRoot)).not.toBe(oldGuid);
    expect(findEntityByGuid(guidOf(newRoot))).toBe(newRoot);
  });

  it('on the Play SNAPSHOT a ref to an added child written unguided trips, rather than naming nothing after Stop', async () => {
    tw = createTestWorld({});
    setPrefabCache(KIT, kit() as never);
    const rootId = instantiatePrefab(kit() as never);
    setPrefabSource(rootId, KIT);
    const added = spawnEntity(tw.world, Transform(), EntityAttributes({ name: 'Grip', parentId: byName('Part').id() }));
    spawnEntity(tw.world, Transform(), EntityAttributes({ name: 'Blade' }), BoneAttachment({ target: guidOf(added), bone: 'R' }));
    await expect(serializeScene()).rejects.toThrow(/runtime guid/);
    // The SAVE path writes the mint onto the live child before capture, so the ref follows it.
    const scene = await serializeScene({ assignGuids: true });
    const blade = scene.entities.find((e) => e.name === 'Blade')!;
    expect((blade.traits.BoneAttachment as { target: string }).target).toBe(guidOf(added));
    expect(isRuntimeGuid(guidOf(added))).toBe(false);
  });
});

/** Close-out review (#1210): the re-mint alias only holds where a lookup goes THROUGH findEntityByGuid.
 *  Each case reads a runtime guid, re-mints the entity durable (what a save / ensureGuid does), then
 *  addresses it by the OLD runtime guid through a live, entity-addressed path. */
describe('entity-addressed paths follow a re-minted runtime guid (#1210)', () => {
  const remint = (e: { set(t: unknown, v: unknown): void; get(t: unknown): unknown }, durable: string) =>
    e.set(EntityAttributes, { ...(e.get(EntityAttributes) as object), guid: durable });

  it('dispatchUIAction / dispatchGameAction hand the handler the entity, not undefined', () => {
    tw = createTestWorld({});
    const e = tw.spawn(Transform(), EntityAttributes({ name: 'Target' }));
    const runtime = guidOf(e);
    remint(e, 'a6666666-6666-4666-8666-666666666666');
    const seen: unknown[] = [];
    registerUIAction('probe.target1210', ({ target }) => { seen.push(target); });
    try {
      dispatchUIAction('probe.target1210', { targetGuid: runtime });
      dispatchGameAction('probe.target1210', { targetGuid: runtime });
    } finally { unregisterUIAction('probe.target1210'); }
    expect(seen).toEqual([e, e]);
  });

  it('resolve-refs names a live entity by the runtime guid its @spawn journal event carried', async () => {
    tw = createTestWorld({});
    const e = tw.spawn(Transform(), EntityAttributes({ name: 'Bullet' }));
    const runtime = guidOf(e);
    remint(e, 'a7777777-7777-4777-8777-777777777777');
    const r = await runAgentOp('resolve-refs', { refs: [runtime] }) as { resolved: Record<string, { name: string; alive: boolean }> };
    expect(r.resolved[runtime]).toEqual({ name: 'Bullet', alive: true });
  });

  it('get_layout_bounds by guid does not report a re-minted runtime guid as unresolved', () => {
    tw = createTestWorld({});
    const e = tw.spawn(Transform(), EntityAttributes({ name: 'Panel' }));
    const runtime = guidOf(e);
    remint(e, 'a8888888-8888-4888-8888-888888888888');
    const r = computeLayoutBounds({ guids: [runtime] }) as { unresolved?: unknown[] };
    expect(r.unresolved ?? []).not.toContain(runtime);
  });

  it('setActiveCameraFrame by guid activates the frame a re-minted runtime guid names', () => {
    tw = createTestWorld({});
    const frame = tw.spawn(Transform(), EntityAttributes({ name: 'Shot' }), CameraFrame({}));
    const runtime = guidOf(frame);
    remint(frame, 'a9999999-9999-4999-8999-999999999999');
    expect(setActiveCameraFrame(tw.world, { guid: runtime })).toBe(true);
    expect((frame.get(CameraFrame) as { active: boolean }).active).toBe(true);
  });
});

/** The Inspector's guid label promises "a save replaces it" only for an entity a save writes (#1210).
 *  `isSkippedByPrimarySave` is that rule asked of one entity — pinned against serializeScene itself,
 *  so the label and the serializer cannot disagree. */
describe('isSkippedByPrimarySave agrees with what serializeScene writes (#1210)', () => {
  it('a child of a Transient root (spawned outside the tick, so untagged) and a base-scene entity are skipped; a plain one is not', async () => {
    tw = createTestWorld({});
    const root = tw.spawn(Transform(), EntityAttributes({ name: 'GenRoot' }));
    root.add(Transient);
    const part = tw.spawn(Transform(), EntityAttributes({ name: 'GenPart', parentId: root.id() }));
    const base = tw.spawn(Transform(), EntityAttributes({ name: 'FromBase', sourceScene: 'b1111111-1111-4111-8111-111111111111' }));
    const plain = tw.spawn(Transform(), EntityAttributes({ name: 'Plain' }));
    expect([part, base, plain].map((e) => isSkippedByPrimarySave(e.id()))).toEqual([true, true, false]);
    const written = new Set((await serializeScene()).entities.map((e) => e.name));
    expect([written.has('GenPart'), written.has('FromBase'), written.has('Plain')]).toEqual([false, false, true]);
  });
});
