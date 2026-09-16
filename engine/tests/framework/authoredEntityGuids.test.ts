/** Derived guids for pre-#1248 scene entries (#1268).
 *
 *  An entry written before #1248 carries no `EntityAttributes`, so it used to spawn bare, take a
 *  RUNTIME guid from `spawnEntity`, and get a random `crypto.randomUUID()` written over it by the
 *  first save — a DIFFERENT one in every clone, which is what makes two clones saving the same
 *  untouched scene conflict. It also moved the entity in the file, because `compareSiblings`
 *  tiebreaks on `guid.localeCompare`.
 *
 *  Each case pins one mechanism and names the mutation that must turn it red:
 *  - the derivation fires only for an entry with NO durable guid from any source;
 *  - the SEED's three parts each participate — scene path, parent path, entity name;
 *  - COLLISION: two entries that would seed identically still get different guids, because a guid
 *    must be unique within one scene file;
 *  - DETERMINISM, the headline: the guid does not depend on the runtime spawn counter, so two
 *    sessions that mint different runtime guids still derive the SAME durable one. This is the case
 *    a random mint passes every single-load assertion of and fails here;
 *  - the ABSENT-path exemption (SceneManager's carried-snapshot respawn derives nothing);
 *  - the STRAY guard: an entry with no traits and no guid must still not spawn. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import {
  getCurrentWorld, setCurrentWorld, getAllEntities, loadSceneFile, spawnEntity, getTraitByName,
  EntityAttributes, findEntityByGuid, type SceneData, SCENE_FORMAT_VERSION,
} from '@modoki/engine/runtime';
import { serializeScene } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import {
  deriveAuthoredEntityGuids, type AuthoredGuidEntry,
} from '../../packages/modoki/src/runtime/loaders/authoredEntityGuids';
import { isRuntimeGuid, durableGuid, isGuid, deriveGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';
import {
  _getRuntimeGuidGeneration, _setRuntimeGuidGeneration,
} from '../../packages/modoki/src/runtime/core/ecs/world';

registerAllTraits();

const SCENE = '/assets/scenes/main.scene.json';

/** The real shape of the 34 affected entries, verbatim from `games/court/.../main.scene.json`. */
const bareTimeEntry = (id = 1): AuthoredGuidEntry => ({ id, name: 'Time (resource)', traits: { Time: {} } });

// ⚠️ No default parameter here, and none on `loadInFreshWorld` below. Passing `undefined`
// explicitly would TRIGGER a default, so the two "no scene path" cases — the whole exemption for
// SceneManager's carried-snapshot respawn — would silently test the opposite of what they claim.
const seedOnly = (entries: AuthoredGuidEntry[], scenePath: string | undefined) =>
  deriveAuthoredEntityGuids(entries, scenePath);

/** koota caps a process at 16 live worlds; release the outgoing one (see sceneRoundTrip.test.ts). */
function swapInFreshWorld() {
  const prev = getCurrentWorld();
  setCurrentWorld(createWorld());
  prev?.destroy();
}

const loadInFreshWorld = async (data: SceneData, scenePath: string | undefined) => {
  swapInFreshWorld();
  await loadSceneFile(JSON.parse(JSON.stringify(data)) as SceneData, {
    fetchPrefab: async () => null,
    loadModels: false,
    scenePath,
  });
};

const sceneWith = (entities: AuthoredGuidEntry[]): SceneData =>
  ({ version: SCENE_FORMAT_VERSION, resources: [], entities } as unknown as SceneData);

describe('deriveAuthoredEntityGuids — which entries it touches', () => {
  // Mutation: drop the `if (guidOf(entry)) continue` skip → the authored guid is overwritten.
  it('derives for an entry with no EntityAttributes, and leaves every entry that already has an identity alone', () => {
    const authored = 'a1111111-1111-4111-8111-111111111111';
    const out = seedOnly([
      bareTimeEntry(1),
      { id: 2, name: 'Authored', traits: { EntityAttributes: { guid: authored } } },
      { id: 3, name: 'PrefabRoot', traits: {}, guid: 'b2222222-2222-4222-8222-222222222222' },
    ], SCENE);
    expect([...out.keys()]).toEqual([1]);
    expect(isGuid(out.get(1)!)).toBe(true);
    expect(durableGuid(out.get(1)!)).toBe(out.get(1)!); // durable, not a runtime address
  });

  // The 13 committed `EntityAttributes`-without-guid rows are all prefab roots carrying a top-level
  // guid, so this shape is the generality case, not today's corpus.
  // Mutation: make `guidOf` read only `entry.guid` → this entry stops being derived for.
  it('derives for an entry that HAS EntityAttributes but no guid in it', () => {
    const out = seedOnly([{ id: 7, name: 'NoGuid', traits: { EntityAttributes: { parentId: '' } } }], SCENE);
    expect(out.has(7)).toBe(true);
  });

  // Mutation: delete the `if (!scenePath) return derived` guard.
  it('derives NOTHING without a scene path — the carried-snapshot respawn has no scene identity', () => {
    expect(seedOnly([bareTimeEntry()], undefined).size).toBe(0);
  });
});

describe('deriveAuthoredEntityGuids — every part of the seed participates', () => {
  // Mutation: drop `scene:${scenePath}` from the seed → both scenes derive the same guid, and
  // 34 files would share one identity.
  it('gives the same entry in two different scene files different guids', () => {
    const a = seedOnly([bareTimeEntry()], '/assets/scenes/a.scene.json').get(1);
    const b = seedOnly([bareTimeEntry()], '/assets/scenes/b.scene.json').get(1);
    expect(a).not.toBe(b);
  });

  // ⚠️ ONE derived entry per call, deliberately. Putting both Labels in ONE list cannot test the
  // parent path at all: they would share a base seed, the `|dup:` ordinal would separate them
  // anyway, and the case passes with `parentPathOf` deleted. (It did — the mutation survived until
  // this was split.) Two calls, one derived entry each, is what isolates the parent path.
  // Mutation: drop `${parentPathOf(entry)}` from the seed → the two Labels collide.
  it('gives a same-named entry under differently-named parents different guids', () => {
    const P1 = 'c3333333-3333-4333-8333-333333333333';
    const P2 = 'd4444444-4444-4444-8444-444444444444';
    const under = (parentName: string, parentGuid: string) => seedOnly([
      { id: 1, name: parentName, traits: { EntityAttributes: { guid: parentGuid } } },
      { id: 2, name: 'Label', traits: { EntityAttributes: { parentId: parentGuid } } },
    ], SCENE).get(2);
    expect(under('Panel A', P1)).toBeDefined();
    expect(under('Panel A', P1)).not.toBe(under('Panel B', P2));
  });

  // Same reason as above: one derived entry per call, or the ordinal masks the name.
  // Mutation: drop `/${entry.name ?? ''}` from the seed → the two roots collide.
  it('gives differently-named roots different guids', () => {
    const named = (name: string) => seedOnly([{ id: 1, name, traits: { Time: {} } }], SCENE).get(1);
    expect(named('Time (resource)')).not.toBe(named('Input (resource)'));
  });

  // A guid MUST be unique within one scene file (sceneGuidUniqueness.test.ts). Two entries can
  // legitimately share a name under a shared parent, so the ordinal is what keeps that true.
  // Mutation: always seed with `base` (drop the `|dup:${n}` branch).
  it('gives two IDENTICALLY-named roots different guids', () => {
    const out = seedOnly([bareTimeEntry(1), bareTimeEntry(2), bareTimeEntry(3)], SCENE);
    expect(new Set([out.get(1), out.get(2), out.get(3)]).size).toBe(3);
  });

  // The ordinal has to separate a derived guid from the ones ALREADY IN THE FILE, not just from
  // other derived ones — otherwise it does not deliver the within-file uniqueness it exists for.
  // The reachable input is a file holding BOTH halves of this migration: a merge that kept both
  // sides, a partial revert, or the old shape pasted into a migrated file.
  // Mutation: build `taken` from nothing (`new Set()`) instead of `byGuid.keys()` → the guid-less
  // twin derives exactly the stored guid and two live entities answer to one address.
  it('does not derive a guid that an entry in the same file already holds', () => {
    const stored = seedOnly([bareTimeEntry(1)], SCENE).get(1)!;
    const out = seedOnly([
      { id: 1, name: 'Time (resource)', traits: { Time: {}, EntityAttributes: { parentId: '', guid: stored } } },
      { id: 2, name: 'Time (resource)', traits: { Time: {} } }, // the pre-#1248 shape, still present
    ], SCENE);
    expect(out.get(2)).not.toBe(stored);
    // Pin the VALUE, not just 'different': `not.toBe(stored)` alone would also pass if the
    // function started returning a random guid, which is the defect this whole change removes.
    expect(out.get(2)).toBe(deriveGuid(`scene:${SCENE}|path:/Time (resource)|dup:1`));
  });

  // `reserved` covers the guids that are spoken for but NOT in `entities` — SceneManager filters the
  // list before the loader sees it (`filterPersistentDuplicates`, `filterDuplicateChainGuids`), and
  // a row dropped because a carried Persistent entity already covers it takes its guid out with it
  // while that entity is very much alive.
  // Mutation: drop the `for (const g of reserved ?? [])` loop.
  it('does not derive a guid passed in as reserved', () => {
    const wouldDerive = seedOnly([bareTimeEntry()], SCENE).get(1)!;
    const out = deriveAuthoredEntityGuids([bareTimeEntry()], SCENE, [wouldDerive]);
    expect(out.get(1)).not.toBe(wouldDerive);
    expect(out.get(1)).toBe(deriveGuid(`scene:${SCENE}|path:/Time (resource)|dup:1`));
  });

  // Mutation: hoist `taken` to module scope so it persists across calls → the second call sees
  // the first's guids as already claimed, advances past them, and the two results diverge.
  it('is a pure function of its inputs — two calls agree', () => {
    const entries = () => [bareTimeEntry(1), bareTimeEntry(2)];
    expect([...seedOnly(entries(), SCENE).values()]).toEqual([...seedOnly(entries(), SCENE).values()]);
  });

  // Mutation: remove the MAX_PARENT_DEPTH cap → this hangs instead of returning (a timeout IS the
  // red). The cap is the only termination guarantee; see the note beside `parentPathOf`.
  it('terminates on a parentId cycle', () => {
    const A = 'e5555555-5555-4555-8555-555555555555';
    const B = 'f6666666-6666-4666-8666-666666666666';
    const out = seedOnly([
      { id: 1, name: 'A', traits: { EntityAttributes: { guid: A, parentId: B } } },
      { id: 2, name: 'B', traits: { EntityAttributes: { guid: B, parentId: A } } },
      { id: 3, name: 'Bare', traits: { EntityAttributes: { parentId: A } } },
    ], SCENE);
    expect(out.has(3)).toBe(true);
  });
});

describe('through loadSceneFile — the guid survives to the spawned entity', () => {
  beforeEach(() => { swapInFreshWorld(); });
  afterEach(() => { swapInFreshWorld(); });

  const readGuid = (name: string): string => {
    const ent = getAllEntities().find((x) => x.name === name);
    if (!ent) throw new Error(`no entity named ${name}`);
    const handle = [...getCurrentWorld().entities].find(
      (h) => (h as unknown as { id(): number }).id() === ent.id,
    ) as unknown as { get(t: unknown): { guid: string } };
    return handle.get(EntityAttributes).guid;
  };

  // THE HEADLINE CASE. The defect was that each session minted its own guid, so anything that
  // asserts on ONE load passes happily. Advancing the runtime spawn counter between loads is what
  // separates a derived guid from a minted one.
  // Mutation: revert `authoredGuid` at the stand-in site to `entry.guid` → the entity falls back to
  // a runtime guid, which differs per generation, and this goes red.
  it('derives the SAME guid in two sessions whose runtime guids differ', async () => {
    const data = sceneWith([bareTimeEntry()]);

    await loadInFreshWorld(data, SCENE);
    const first = readGuid('Time (resource)');

    // Advance the world generation the way a real second session would (world.ts salts it at app
    // start precisely so a reload does not re-issue identical runtime guids).
    _setRuntimeGuidGeneration(_getRuntimeGuidGeneration() + 41);
    await loadInFreshWorld(data, SCENE);
    const second = readGuid('Time (resource)');

    expect(isRuntimeGuid(first)).toBe(false);
    expect(durableGuid(first)).toBe(first);
    expect(second).toBe(first);
  });

  // Mutation: pass `scenePath` at SceneManager's carried-snapshot call / make the loader default it
  // → this entity stops taking a runtime guid and the carry path re-keys mid-swap.
  it('falls back to a runtime guid when the loader is given no scene path', async () => {
    await loadInFreshWorld(sceneWith([bareTimeEntry()]), undefined);
    expect(isRuntimeGuid(readGuid('Time (resource)'))).toBe(true);
  });

  // ⚠️ Asserted by COUNT, not by name. The stand-in EntityAttributes carries only a guid — the
  // entry-level `name` is not an EntityAttributes field — so a phantom spawned here would have no
  // name and a `find(x => x.name === 'Stray')` would read `undefined` whether or not it spawned.
  // That is exactly how this case passed with the guard deleted.
  // Mutation: drop the `traitArgs.length > 0 ?` guard on the stand-in → the stray spawns as a
  // phantom entity that no previous build had.
  it('still does not spawn an entry with no traits and no guid', async () => {
    await loadInFreshWorld(sceneWith([{ id: 1, name: 'Stray', traits: {} }]), SCENE);
    expect(getAllEntities().length).toBe(0);
  });

  // The loader has TWO routes to a derived guid and they need separate cover: the stand-in above
  // (no EntityAttributes at all) and this one (the trait is present but carries no guid). Testing
  // only `deriveAuthoredEntityGuids` leaves this branch unwired-but-green.
  // Mutation: revert the EA-present branch to `entry.guid && !fieldData.guid` → this entity keeps
  // its runtime guid and the first save mints a random one over it.
  // A persisted RUNTIME guid is not an identity — `durableGuid()` reads it as absent, which is how
  // `deriveAuthoredEntityGuids` classifies the entry, so the stamp gate has to agree. With a raw
  // `!fieldData.guid` check it does not: the derived guid is computed, thrown away, overwritten by
  // mintRuntimeGuid, and the first save mints a random v4 — #1268 intact. The committed corpus
  // cannot hold this input (noRuntimeGuidsOnDisk.test.ts), but a user project can.
  // Mutation: revert the gate to `!fieldData.guid`.
  it('replaces a persisted RUNTIME guid with the derived one', async () => {
    const runtimeGuid = '00000000-0abc-0001-0000-000000000003';
    expect(isRuntimeGuid(runtimeGuid), 'premise: that literal is a runtime guid').toBe(true);
    const entry = { id: 1, name: 'Stale', traits: { EntityAttributes: { name: 'Stale', guid: runtimeGuid } } };
    await loadInFreshWorld(sceneWith([entry]), SCENE);
    expect(isRuntimeGuid(readGuid('Stale'))).toBe(false);
    expect(readGuid('Stale')).toBe(seedOnly([entry], SCENE).get(1)!);
  });

  // The sibling of the case above, through the OTHER door: a runtime guid at ENTRY level. The
  // classifier reads it through durableGuid and derives, so both consumers must agree — taking
  // `entry.guid` raw discards the derived value AND stamps the runtime guid into EntityAttributes,
  // which the first save persists (noRuntimeGuidsOnDisk forbids exactly that value on disk).
  // Mutation: revert either `durableGuid(entry.guid)` back to `entry.guid`.
  it('does not treat a RUNTIME guid at entry level as an identity', async () => {
    const runtimeGuid = '00000000-0abc-0001-0000-000000000004';
    expect(isRuntimeGuid(runtimeGuid), 'premise: that literal is a runtime guid').toBe(true);
    const entry = { id: 1, name: 'StaleRoot', guid: runtimeGuid, traits: { Time: {} } };
    const expected = seedOnly([entry], SCENE).get(1)!;
    await loadInFreshWorld(sceneWith([entry]), SCENE);
    // Aimed by guid: the stand-in EntityAttributes carries only a guid, so this entity has no
    // `EntityAttributes.name` to look it up by — the same reason the prefab-root case aims this way.
    expect(findEntityByGuid(expected), 'the derived guid names the spawned entry').toBeTruthy();
    expect(findEntityByGuid(runtimeGuid), 'the runtime guid was not kept as an identity').toBeFalsy();
  });

  // ⚠️ The SAME defect through the third door, and it needs its own case: `authoredGuid` feeds the
  // EntityAttributes branch while `standInGuid` feeds the no-EntityAttributes one, so an entry with
  // BOTH a runtime `entry.guid` and a guidless EntityAttributes exercises a line the two cases above
  // never reach. Reverting that line alone turned nothing red until this existed.
  // Mutation: revert `durableGuid(entry.guid)` at the `authoredGuid` site.
  it('does not stamp a runtime entry.guid into a present EntityAttributes', async () => {
    const runtimeGuid = '00000000-0abc-0001-0000-000000000005';
    expect(isRuntimeGuid(runtimeGuid), 'premise: that literal is a runtime guid').toBe(true);
    const entry = { id: 1, name: 'Both', guid: runtimeGuid, traits: { EntityAttributes: { name: 'Both' } } };
    await loadInFreshWorld(sceneWith([entry]), SCENE);
    expect(isRuntimeGuid(readGuid('Both'))).toBe(false);
    expect(readGuid('Both')).toBe(seedOnly([entry], SCENE).get(1)!);
  });

  it('fills a present-but-guidless EntityAttributes with the derived guid', async () => {
    const derived = seedOnly([{ id: 1, name: 'NoGuid', traits: { EntityAttributes: { name: 'NoGuid' } } }], SCENE).get(1)!;
    await loadInFreshWorld(sceneWith([{ id: 1, name: 'NoGuid', traits: { EntityAttributes: { name: 'NoGuid' } } }]), SCENE);
    expect(readGuid('NoGuid')).toBe(derived);
    expect(isRuntimeGuid(readGuid('NoGuid'))).toBe(false);
  });

  // The loader must SUPPLY the live world's guids as reserved, not merely accept them — the unit
  // case above proves the parameter works, this proves it is wired. The scenario is real: a carried
  // `Persistent` entity makes SceneManager filter its shadowing row out of `entities`, so the file
  // handed to the loader no longer mentions a guid that a live entity is using.
  // Mutation: pass nothing (or `[]`) as the third argument in `loadSceneFile` → the bare entry
  // derives the live entity's guid and two entities answer to one address.
  it('will not hand a guid to an entry that a LIVE entity already holds', async () => {
    const collides = seedOnly([bareTimeEntry()], SCENE).get(1)!;
    swapInFreshWorld();
    // An entity already in the world — the carried-Persistent shape, minus the carry machinery.
    spawnEntity(getCurrentWorld(), getTraitByName('EntityAttributes')!.trait({ name: 'Carried', guid: collides }));
    await loadSceneFile(sceneWith([bareTimeEntry()]) as SceneData, {
      fetchPrefab: async () => null, loadModels: false, scenePath: SCENE,
    });
    expect(readGuid('Time (resource)')).not.toBe(collides);
    // ⚠️ `.name` via the trait, not off the handle — a koota handle has no `.name` (#1138), so
    // `findEntityByGuid(g).name` reads undefined and an assertion on it passes for the wrong reason.
    const carried = findEntityByGuid(collides) as unknown as { get(t: unknown): { name?: string } } | undefined;
    expect(carried, 'the live entity still owns that guid').toBeTruthy();
    expect(carried!.get(EntityAttributes).name).toBe('Carried');
  });

  // Mutation: prefer `authoredGuids.get(entry.id)` over `entry.guid` in the stand-in → a prefab
  // root's scene-authored identity is replaced and every ref into the instance dangles.
  // Looked up BY GUID, not by name: the stand-in is deliberately guid-only (the entry-level `name`
  // is not an EntityAttributes field), which is the whole reason `findEntityByGuid` has to resolve
  // it for pass 2's self-referencing rootInstanceId.
  it('leaves a prefab root on its own top-level guid', async () => {
    const rootGuid = 'b2222222-2222-4222-8222-222222222222';
    await loadInFreshWorld(sceneWith([{ id: 1, name: 'Root', traits: {}, guid: rootGuid }]), SCENE);
    expect(findEntityByGuid(rootGuid)).toBeTruthy();
  });
});

describe('round-trip — the derived guid is what gets STORED, and the file then stops changing', () => {
  beforeEach(() => { swapInFreshWorld(); });
  afterEach(() => { swapInFreshWorld(); });

  // This is also the reproduction: before the fix the two serializations differ, because each load
  // took a runtime guid and each save minted a fresh random durable one over it.
  // Mutation: any change that makes the load-time guid non-deterministic.
  it('serializes the same bytes from two independent loads of the same file', async () => {
    const data = sceneWith([bareTimeEntry(1), { id: 2, name: 'Other', traits: { Time: {} } }]);

    await loadInFreshWorld(data, SCENE);
    const firstSave = JSON.stringify((await serializeScene()).entities);

    _setRuntimeGuidGeneration(_getRuntimeGuidGeneration() + 17);
    await loadInFreshWorld(data, SCENE);
    const secondSave = JSON.stringify((await serializeScene()).entities);

    expect(secondSave).toBe(firstSave);
  });

  // Mutation: stop writing the derived guid into EntityAttributes at load → the save falls back to
  // `newGuid()` and the stored value stops matching the derivation.
  it('writes the derived guid into the file, so a later load needs no derivation at all', async () => {
    const data = sceneWith([bareTimeEntry()]);
    const derived = seedOnly([bareTimeEntry()], SCENE).get(1)!;

    await loadInFreshWorld(data, SCENE);
    const saved = await serializeScene();
    const entry = saved.entities.find((e: { name?: string }) => e.name === 'Time (resource)') as
      { traits: { EntityAttributes?: { guid?: string } } };

    expect(entry.traits.EntityAttributes?.guid).toBe(derived);
    // Second round: the entry now carries a guid, so nothing is derived for it any more.
    expect(seedOnly(saved.entities as unknown as AuthoredGuidEntry[], SCENE).size).toBe(0);
  });
});
