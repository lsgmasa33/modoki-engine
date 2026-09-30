/** `frameRespell` (runtime/loaders/frameRespell.ts) reads nothing until a lookup MISSES (#1876 close-out review).
 *
 *  A caller builds one per token and hands it to `memberPathLookup`, whose exact lookup almost always hits. Built
 *  eagerly, it read the frame's document every time — `frameDocReader` maps the whole world by entity — so a scene load
 *  holding N tokens over N entities went quadratic (measured 126 ms → 2.2 s at 8,000 entities).
 *
 *  The read is observed through the frame-doc FALLBACK: a world that never expanded the source falls through to it.
 *  Mutation: build the reader and read the document before returning the closure — the fallback is read at
 *  construction, and the first assertion goes red. Its own file, because it replaces the module-level fallback. */

import { describe, it, expect, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { getTraitByName, spawnEntity } from '@modoki/engine/runtime';
import { setFrameDocFallback } from '../../packages/modoki/src/runtime/core/ecs/identityParents';
import { frameRespell } from '../../packages/modoki/src/runtime/loaders/frameRespell';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();
afterEach(() => setFrameDocFallback(undefined));

describe('frameRespell is lazy', () => {
  it('reads the frame\'s document on the first call, not when it is built — and once', () => {
    const world = createWorld();
    const pi = getTraitByName('PrefabInstance')!;
    const root = spawnEntity(world, pi.trait({ source: 'src-guid' }));
    root.set(pi.trait, { ...(root.get(pi.trait) as object), rootInstanceId: root.id() });
    const reads: string[] = [];
    setFrameDocFallback((source) => { reads.push(source); return { rootLocalId: 1, entities: [{ localId: 1 }] }; });
    const respell = frameRespell(world, root.id());
    expect(reads).toEqual([]);
    expect(respell([2, '+K'])).toEqual(['+K']); // premise: it respells through the document it read
    respell([3, '+J']);
    expect(reads).toEqual(['src-guid']);
    world.destroy();
  });
});
