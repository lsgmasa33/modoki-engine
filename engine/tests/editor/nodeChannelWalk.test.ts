/** #1880 F3b: ONE channel set for "the nodes inside a node" (`nodeChannels` / `mapNodeChannels`), which every such walk
 *  uses — `collectReferenceNodeRows` (the load's and rebuild's pins), the rebuild's `withoutKeptNodes`, and the capture's
 *  `liveTemplateKeys`. The three listed their own channels and disagreed: #1877 L4's kept reference node inside another
 *  was missed by a walk that took `children` alone, and `liveTemplateKeys` still gated each channel on the node's kind. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestWorld, type TestWorld, spawnEntity, getCurrentWorld, EntityAttributes } from '@modoki/engine/runtime';
import { nodeChannels, mapNodeChannels, collectReferenceNodeRows, type AddedEntity } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { liveTemplateKeys } from '../../packages/modoki/src/editor/scene/prefabCapture';
import { setTemplateKey } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { indexEntityGuid } from '../../packages/modoki/src/runtime/core/ecs/world';
import { registerAllTraits } from '../../app/ecs/registerTraits';

registerAllTraits();

const g = (n: number) => `dddddddd-0000-4000-8000-0000001880${String(n).padStart(2, '0')}`;
const node = (name: string, extra: Partial<AddedEntity> = {}): AddedEntity =>
  ({ parentLocalId: 0, guid: '', name, traits: {}, children: [], ...extra }) as AddedEntity;
/** A reference node carrying a node in EVERY channel: `added`, `children`, `nestedStructure[*].added`, a member row's
 *  `added` and its `own`. Each inner node is itself a reference node, so the pin walk has something to find in each. */
const everyChannel = (): AddedEntity => node('Outer', {
  prefab: 'p', guid: g(1),
  added: [node('InAdded', { prefab: 'p', guid: g(2) })],
  children: [node('InChildren', { prefab: 'p', guid: g(3) })],
  nestedStructure: { 2: { added: [node('InSlot', { prefab: 'p', guid: g(4) })] } } as never,
  members: { '/m': { added: [node('InRowAdded', { prefab: 'p', guid: g(5) })], own: [node('InRowOwn', { prefab: 'p', guid: g(6) })] } } as never,
});
const names = (lists: AddedEntity[][]) => lists.map((l) => l.map((n) => n.name));

describe('the one channel set (#1880 F3b)', () => {
  // Mutation: drop any one channel from `nodeChannels` — its name leaves this list, and the pin walk below misses it.
  it('every channel, in one order', () => {
    expect(names(nodeChannels(everyChannel()))).toEqual([['InAdded'], ['InChildren'], ['InSlot'], ['InRowAdded'], ['InRowOwn']]);
  });

  it('mapNodeChannels rewrites each channel, and leaves an absent one absent', () => {
    const mapped = mapNodeChannels(everyChannel(), (list) => list.map((n) => ({ ...n, name: `${n.name}!` })));
    expect(names(nodeChannels(mapped))).toEqual([['InAdded!'], ['InChildren!'], ['InSlot!'], ['InRowAdded!'], ['InRowOwn!']]);
    const bare = mapNodeChannels(node('Bare', { children: undefined as never }), (l) => l);
    expect('added' in bare || 'nestedStructure' in bare || 'members' in bare).toBe(false);
  });

  it('the pin walk finds a reference node in every channel', () => {
    expect(collectReferenceNodeRows([everyChannel()]).map(([guid]) => guid)).toEqual([g(1), g(2), g(3), g(4), g(5), g(6)]);
  });
});

describe('liveTemplateKeys: the flags choose which nodes the walk enters, never which channels (#1880 F3b)', () => {
  let game: TestWorld | undefined;
  beforeEach(() => { game = createTestWorld({}); });
  afterEach(() => { game?.dispose(); game = undefined; });
  const keyed = (guid: string, key: string) => {
    const e = spawnEntity(getCurrentWorld(), EntityAttributes({ name: key, guid }));
    indexEntityGuid(e);
    setTemplateKey(e, key);
  };

  // Mutation: gate a reference node's channels as before (only `added`/`nestedStructure`/member rows, never `children`) —
  // the key inside the reference node's `children` is missed with `intoReferences`.
  it('a keyed node in a reference node\'s children or member row `own` is found only when the walk enters references', () => {
    keyed(g(10), 'k-top'); keyed(g(11), 'k-child'); keyed(g(12), 'k-own');
    const tree = [node('Ref', { prefab: 'p', guid: g(10),
      children: [node('C', { guid: g(11) })],
      members: { '/m': { own: [node('O', { guid: g(12) })] } } as never })];
    expect([...liveTemplateKeys(tree).values()]).toEqual(['k-top']);
    expect([...liveTemplateKeys(tree, true).values()]).toEqual(['k-top']); // `deep` enters plain nodes only
    expect([...liveTemplateKeys(tree, true, true).values()].sort()).toEqual(['k-child', 'k-own', 'k-top']);
  });

  it('`deep` enters a plain node\'s channels', () => {
    keyed(g(20), 'k-plain'); keyed(g(21), 'k-under');
    const tree = [node('Plain', { guid: g(20), children: [node('U', { guid: g(21) })] })];
    expect([...liveTemplateKeys(tree).values()]).toEqual(['k-plain']);
    expect([...liveTemplateKeys(tree, true).values()].sort()).toEqual(['k-plain', 'k-under']);
  });
});
