/** #1883 ruling C (owner 2026-10-01, built in #1914 R4): a LEGACY prefab-level `moved` of a KEYED node — written before
 *  #1869 refused restructuring an instance — is Unity's unused override. It is ignored at load (the node sits at its
 *  template place) and kept verbatim by every save, the prefab-edit save included, which regenerated `moved` from the
 *  live world and so dropped it (#1883's L2, OBSERVED on work-ai at fc638d509).
 *
 *  The fuzzer's fixture (`prefabFuzz/harness.ts`): O's row N (localId 2, a P) adds the keyed node Extra (`k-extra`); this
 *  file gives O a legacy move of it, `2.+k-extra`, under O's own root. */

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
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { invalidatePrefab } from '../../packages/modoki/src/runtime/loaders/meshTemplateCache';
import { setPrefabCache } from '../../packages/modoki/src/editor/scene/prefabCache';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const MOVE = { '2.+k-extra': '@member:2' };

describe('#1883 ruling C: a legacy move of a keyed node is ignored at load and kept by the prefab-edit save', () => {
  // Mutation: drop `keptMoves` from `savePrefabEditReport`'s `serializePrefab` call — the first save (of the v4 `moved`)
  // writes no record; drop `keepKeyedNodeParents` from `serializePrefabEditWorld` — the second save (of the v10 row)
  // writes none (both measured, #2001 S6). And for the edit world: apply every move in `applyEditWorldMoves` (`appliedMoves(prefab.moved)` →
  // `prefab.moved`) — Extra shows under OR.
  it('a no-op prefab-edit save of O writes the move back, from a v4 document and from the v10 row it then holds; the edit world shows the node at its template place', async () => {
    const f = await startRun(be, async () => {}, 'keyed-legacy-move');
    const doc = JSON.parse(be.read(f.prefabs.O.path)!) as Record<string, unknown>;
    be.write(f.prefabs.O.path, `${JSON.stringify({ ...doc, moved: MOVE }, null, 2)}\n`);
    invalidatePrefab(f.prefabs.O.path);
    setPrefabCache(f.prefabs.O.guid, null);
    expect(await openPrefabForEditing({ path: f.prefabs.O.path, name: 'O' }, { confirmDiscard: async () => true })).toBeFalsy();
    const extra = authored().find((e) => e.name === 'Extra')!;
    expect(authored().find((e) => e.id === extra.parentId)?.name).toBe('A');
    expect((await savePrefabEditReport({})).saved).toBe(true);
    await exitPrefabEditing();
    await settle();
    // Prefab v10 (#2001 S6): the move is a `parent` record on the row of the frame holding the node, its token one frame
    // up (it was written from the document's root), and the document states no `moved`.
    const saved = () => JSON.parse(be.read(f.prefabs.O.path)!) as { moved?: unknown; entities: Array<{ localId: number; members?: Record<string, unknown> }> };
    const kept = () => saved().entities.find((e) => e.localId === 2)!.members?.['/a+k-extra'];
    expect(saved().moved).toBeUndefined();
    expect(kept()).toEqual({ parent: '@member:^.2' });
    // …and the v10 row reads the same way: not shown, and written back by the next save, which captures the live tree
    // and so cannot restate a record that applies nowhere.
    expect(await openPrefabForEditing({ path: f.prefabs.O.path, name: 'O' }, { confirmDiscard: async () => true })).toBeFalsy();
    const again = authored().find((e) => e.name === 'Extra')!;
    expect(authored().find((e) => e.id === again.parentId)?.name).toBe('A');
    expect((await savePrefabEditReport({})).saved).toBe(true);
    await exitPrefabEditing();
    await settle();
    expect(saved().moved).toBeUndefined();
    expect(kept()).toEqual({ parent: '@member:^.2' });
  });
});
