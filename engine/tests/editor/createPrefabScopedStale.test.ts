/** #2046 S7.5 (D-8d): Create Prefab marks stale only the records of the tree it tags, untags or relinks — every other
 *  tree keeps its exact list, fresh, through the create, its undo and its redo (rule 8).
 *
 *  Before S7.5 the tag, the untag and the commit's rebuild each marked the WHOLE store stale (`staleAround`), so a Create
 *  Prefab on one plain tree made every instance in the scene re-seed its record from a capture on its next write. The
 *  fixture is the fuzzer's: O1, P1 and H1 are placed instances, Plain is a plain tree; P1 carries a field override so its
 *  record is not empty. Driven through the real routes: the Inspector's write, Create Prefab, undo and redo. */

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
import { pushAction } from '@modoki/engine/editor';
import { getCurrentWorld, getTraitByName } from '@modoki/engine/runtime';
import { createPrefabFromEntity } from '../../packages/modoki/src/editor/panels/assetOps';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { storedInstances } from '../../packages/modoki/src/runtime/prefab/instanceStore';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const byName = (name: string) => authored().find((e) => e.name === name)!;
/** The entity named `name` under the fixture's scene entry `k` (its root guid `ffffffff-…-8<k>-…`, as `startRun` mints). */
function under(k: number, name: string): number {
  const topId = authored().find((e) => e.guid?.startsWith(`ffffffff-0000-4000-8${k.toString(16).padStart(3, '0')}-`))!.id;
  const inTree = (id: number): boolean => { for (let at = id; at; at = authored().find((e) => e.id === at)?.parentId ?? 0) if (at === topId) return true; return false; };
  const hits = authored().filter((e) => e.name === name && inTree(e.id));
  expect(hits).toHaveLength(1);
  return hits[0].id;
}
/** Every stored instance outside Plain's tree: its exact list. */
function othersState(plainGuids: ReadonlySet<string>): Record<string, { record: string }> {
  const json = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => x instanceof Map ? [...x.entries()] : x instanceof Set ? [...x] : x);
  const out: Record<string, { record: string }> = {};
  for (const [g, s] of storedInstances(getCurrentWorld())) if (!plainGuids.has(g)) out[g] = { record: json(s.record) };
  return out;
}

describe('Create Prefab changes only its own tree\'s records (#2046 S7.5)', () => {
  it('every other instance keeps its exact list through the create, its undo and its redo', async () => {
    const f = await startRun(be, async () => {}, 'scoped-stale');
    expect(writeTraitFieldWithUndo(under(2, 'A'), getTraitByName('Transform')!, 'x', 5)).toBeNull();
    await settle();
    const plainGuids = new Set([byName('Plain').guid!, byName('Leaf').guid!]);
    const before = othersState(plainGuids);
    // Premise: the other trees are stored, fresh, and P1's list states the override.
    expect(Object.keys(before).length).toBeGreaterThanOrEqual(3);
    expect(Object.values(before).some((s) => /"x":5\b/.test(s.record))).toBe(true);

    const r = await createPrefabFromEntity(byName('Plain').id, `${f.root}/prefabs/NewPlain.prefab.json`, 'Save prefab "Plain"', async () => false);
    if (!r || r === 'declined' || 'refused' in r) throw new Error(`create: ${r && r !== 'declined' ? r.refused : r}`);
    pushAction(r.action);
    await settle();
    expect(othersState(plainGuids)).toEqual(before);

    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(othersState(plainGuids)).toEqual(before);

    expect((await undoStep('redo')).did).toBe(true);
    await settle();
    expect(othersState(plainGuids)).toEqual(before);
  });
});
