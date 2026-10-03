/** #1947 (#2046 S7.6): a placed prefab instance goes last among its siblings, as Unity appends one.
 *
 *  It used to keep its template root's own `sortOrder` — usually 0, tying with every sibling at it — so `compareSiblings`
 *  broke the tie by the fresh guid and the instance landed wherever that sorted, usually near the top. The door's `place`
 *  now writes the end order live and in the record's placement (its one home, § 10.4), and the instantiate's redo puts
 *  back the order it recorded rather than a new end (#1941's rule). Driven through the real routes over the fuzzer's
 *  fixture (O1, P1, H1 placed and Plain plain, all at the top level): the placement, undo, redo, save and reload. */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';

vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, authored } from './prefabFuzz/harness';
import { getCurrentWorld, getTraitByName, readTraitData, writeTraitField } from '@modoki/engine/runtime';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { storedInstance } from '../../packages/modoki/src/runtime/prefab/instanceStore';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const ea = () => getTraitByName('EntityAttributes')!;
const orderOf = (id: number) => (readTraitData(id, ea()) as { sortOrder: number }).sortOrder;
const topLevel = () => authored().filter((e) => e.parentId === 0);
const byGuid = (g: string) => authored().find((e) => e.guid === g)!;

describe('a placed prefab instance goes last among its siblings (#1947)', () => {
  // Mutation: `place` keeps the template root's order (`opts.sortOrder ?? attrs.sortOrder ?? 0`) — the new instance ties.
  it('the new instance is ordered after every sibling, live, in its record and after a save and reload', async () => {
    const f = await startRun(be, async () => {}, 'order-place');
    // Spread the siblings so "last" is not "tied at the top": 0, 1, 2 … in scene order, then one far above them.
    topLevel().forEach((e, i) => writeTraitField(e.id, ea(), 'sortOrder', i));
    const plain = authored().find((e) => e.name === 'Plain')!;
    writeTraitField(plain.id, ea(), 'sortOrder', 40);
    const rootId = (await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test' }))!;
    await settle();
    const guid = authored().find((e) => e.id === rootId)!.guid!;
    expect(orderOf(rootId)).toBe(41);
    expect(storedInstance(getCurrentWorld(), guid)?.record.placement.sortOrder).toBe(41);
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(orderOf(byGuid(guid).id)).toBe(41);
  });

  // Mutation: the redo respawns with no order (`respawn(rootGuid, undefined)`) — it lands at the new end, 61.
  it('the redo puts the instance back at the order it had, not at a new end', async () => {
    const f = await startRun(be, async () => {}, 'order-redo');
    topLevel().forEach((e, i) => writeTraitField(e.id, ea(), 'sortOrder', i));
    const n = topLevel().length;
    const rootId = (await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test' }))!;
    await settle();
    const guid = authored().find((e) => e.id === rootId)!.guid!;
    expect(orderOf(rootId)).toBe(n);
    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    // A sibling moved far down meanwhile, by no step on the stack: a new end would now be 61.
    writeTraitField(authored().find((e) => e.name === 'Plain')!.id, ea(), 'sortOrder', 60);
    expect((await undoStep('redo')).did).toBe(true);
    await settle();
    expect(orderOf(byGuid(guid).id)).toBe(n);
    expect(storedInstance(getCurrentWorld(), guid)?.record.placement.sortOrder).toBe(n);
  });
});
