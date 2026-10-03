/** #2001 S6 entry criterion (design § 10.7, hub ruling 2026-10-02): the format flip is a storage change and must not move
 *  a mark. A v20 entry states the root's name on its `"/"` row ALWAYS (a default override, U10b), where today's entry
 *  states it only when the instance was renamed; `statedRootDefaults` marks what the owner states, so read as-is a v20
 *  load marked the name on every root. Each pair below is one instance in both forms (a twin): their roots must show the
 *  same mark set. The fuzzer's P1 holds the same over every op (`prefabFuzz/s5Seams.ts`).
 *
 *  Mutation: make `statedRootDefaults` take the "/" row's name at v20 as it does before v20 — the NOT-renamed pair goes
 *  red (the v20 twin gains `EntityAttributes.name`); the renamed pair stays green, which is why both are here. */
import { describe, it, expect, beforeEach } from 'vitest';
import { createWorld } from 'koota';
import { getCurrentWorld, setCurrentWorld, instantiatePrefabIntoWorld } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { INSTANCE_MODEL_SCENE_VERSION, SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { getOverrideMarkSet } from '../../packages/modoki/src/runtime/loaders/overrideMarks';
import { findEntityById } from '../../packages/modoki/src/runtime/core/ecs/world';

registerAllTraits();

const P = 'cccccccc-0000-4000-8000-0000000020aa';
const row = (localId: number, name: string, parentId: number, nodeGuid: string) => ({
  localId, name, nodeGuid, traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 } },
});
const doc = { id: P, version: 5, name: 'P', rootLocalId: 1, entities: [
  row(1, 'Ship', 0, 'eeeeeeee-0000-4000-8000-0000000020a1'), row(2, 'Hull', 1, 'eeeeeeee-0000-4000-8000-0000000020a2'),
] };

/** The root's marks after spawning one instance of P from `channels`, read as a scene of `sceneVersion`. */
function rootMarks(rootGuid: string, sceneVersion: number, channels: { overrides?: Record<number, Record<string, Record<string, unknown>>>; members?: Record<string, unknown> }): string[] {
  const world = getCurrentWorld();
  const root = instantiatePrefabIntoWorld(world, doc as never, 0, undefined, P, channels.overrides as never,
    channels.members ? { members: channels.members as never } : undefined, undefined, undefined, undefined,
    { read: (g: string) => (g === P ? doc : undefined) as never, rootGuid, sceneVersion });
  expect(root).toBeTruthy();
  return [...(getOverrideMarkSet(findEntityById(root, world) as never) ?? [])].sort();
}

/** One instance in today's form (the root override) and in v20's (the "/" row, the name always stated). */
const today = (name?: string) => ({ overrides: { 1: { EntityAttributes: { sortOrder: 3, ...(name ? { name } : {}) } } } });
const v20 = (name: string) => ({ members: { '/': { traits: { EntityAttributes: { name } } } } });

describe('#2001 S6: a v20 root shows the marks its today-form twin shows (§ 10.7)', () => {
  beforeEach(() => setCurrentWorld(createWorld()));

  it('NOT renamed: the "/" row states the template root\'s name, and the name is not marked', () => {
    const a = rootMarks('dddddddd-0000-4000-8000-0000000020b1', SCENE_FORMAT_VERSION, today());
    const b = rootMarks('dddddddd-0000-4000-8000-0000000020b2', INSTANCE_MODEL_SCENE_VERSION, v20('Ship'));
    expect(b).toEqual(a);
    expect(a).toEqual(['EntityAttributes.sortOrder']);
  });

  it('renamed: both forms mark the name', () => {
    const a = rootMarks('dddddddd-0000-4000-8000-0000000020b3', SCENE_FORMAT_VERSION, today('Flagship'));
    const b = rootMarks('dddddddd-0000-4000-8000-0000000020b4', INSTANCE_MODEL_SCENE_VERSION, v20('Flagship'));
    expect(b).toEqual(a);
    expect(a).toEqual(['EntityAttributes.name', 'EntityAttributes.sortOrder']);
  });
});
