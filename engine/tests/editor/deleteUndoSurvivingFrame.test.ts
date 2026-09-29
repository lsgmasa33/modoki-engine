/** #1820 residual — Delete's undo of a ROW of a prefab frame that SURVIVES the delete, after a SAVED edit of that frame's
 *  template. Leaving prefab edit already rebased the surviving frame onto the saved document, so no stale-frame record was
 *  left for `rebaseRespawned` to see, and the respawned row stayed on the OLD document: a template value frozen as the
 *  row's own, a member the template dropped (lost on reload), a nested root's parent row. The delete now records each
 *  surviving frame's document; the undo translates the rows onto the current one (`survivingFrameRows`), or REFUSES
 *  before anything respawns when the current document dropped a row it would bring back.
 *
 *  Driven through the prefab fuzzer's harness (the real backend route, SceneManager, both prefab caches, prefab edit's
 *  world swaps and the undo stack), on its fixture: P1 is an instance of P (R → A → B, R → C). Mutations, each run
 *  separately: never re-record the frame (the translate branch) → the first case goes red (A keeps z 0); never throw (the
 *  refuse branch) → the second goes red (the undo reports did=true and brings B back); skip owned rows → the third. */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';

// The OS trash, stubbed to delete from the scratch directory, as prefabFuzz.test.ts does.
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { makeFuzzBackend } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle, authored, piOf, worldTree, type Fixture } from './prefabFuzz/harness';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { deleteEntitiesWithUndo, writeTraitFieldWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { findEntityByGuid } from '../../packages/modoki/src/runtime/core/ecs/world';
import { getTraitByName } from '../../packages/modoki/src/runtime/core/ecs/traitRegistry';
import { readTraitData } from '../../packages/modoki/src/runtime/core/ecs/entityUtils';
import { saveScene, loadSceneReporting } from '../../packages/modoki/src/editor/scene/serialize';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const transform = () => getTraitByName('Transform')!;
/** P1's member named `name` (O1's nested P has members of the same names). P1 is the scene's entry 2, by its guid. */
function memberOfP1(name: string): { id: number; guid: string } {
  const p1 = authored().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8002-'))!;
  const e = authored().find((x) => x.name === name && piOf(x.id)?.rootInstanceId === p1.id)!;
  expect(e, `P1's ${name}`).toBeTruthy();
  return { id: e.id, guid: e.guid! };
}
const tf = (guid: string) => {
  const e = findEntityByGuid(guid);
  return e ? (readTraitData(e.id(), transform()) as { x: number; y: number; z: number }) : undefined;
};

/** Edit P in prefab edit (`edit` gets P's live member of that name), save, leave. */
async function savedEditOfP(f: Fixture, edit: (member: (name: string) => number) => void, which: 'P' | 'O' = 'P'): Promise<void> {
  expect(await openPrefabForEditing({ path: f.prefabs[which].path, name: which }, { confirmDiscard: async () => true })).toBeFalsy();
  edit((name) => authored().find((e) => e.name === name)!.id);
  expect((await savePrefabEditReport({})).saved).toBe(true);
  await exitPrefabEditing();
  await settle();
}

describe("Delete's undo of a row of a frame that survives the delete (#1820 residual)", () => {
  it('the saved edit changed the row: the undo translates it onto the current document, keeping its own override', async () => {
    const f = await startRun(be, async () => {}, 'surviving-frame-translate');
    const a = memberOfP1('A');
    // An override of A's own, before the delete: it must survive the translation.
    expect(writeTraitFieldWithUndo(a.id, transform(), 'y', 9)).toBeNull();
    deleteEntitiesWithUndo([a.id]);
    await settle();
    expect(findEntityByGuid(a.guid)).toBeFalsy();

    await savedEditOfP(f, (member) => { expect(writeTraitFieldWithUndo(member('A'), transform(), 'z', 8)).toBeNull(); });

    const u = await undoStep('undo');
    await settle();
    expect(u.did).toBe(true);
    // The template's NEW z, the template's x, and the instance's own y — not the old document's z 0 frozen as A's own.
    expect(tf(a.guid)).toMatchObject({ x: 2, y: 9, z: 8 });
    // B, A's child row, came back with it.
    expect(tf(memberOfP1('B').guid)).toMatchObject({ x: 3 });
  }, 120_000);

  it('the saved edit dropped a row the undo would bring back: it REFUSES, and nothing changed (I19)', async () => {
    const f = await startRun(be, async () => {}, 'surviving-frame-refuse');
    const b = memberOfP1('B');
    deleteEntitiesWithUndo([b.id]);
    await settle();

    await savedEditOfP(f, (member) => { deleteEntitiesWithUndo([member('B')]); });

    const before = JSON.stringify(worldTree());
    const u = await undoStep('undo');
    await settle();
    expect(u.did).toBe(false);
    expect(u.failed?.refused).toBe(true);
    expect(findEntityByGuid(b.guid)).toBeFalsy();
    // No entity respawned, no mark changed, no trait written.
    expect(JSON.stringify(worldTree())).toBe(before);
  }, 120_000);

  it('an OWNED nested root (O1\'s N, a row of O) is translated too, and keeps the new value across a save and reload', async () => {
    // Mutation: skip owned rows in \`survivingFrameRows\` — N comes back at the old document's x.
    const f = await startRun(be, async () => {}, 'surviving-frame-owned');
    const isN = (id: number) => piOf(id)?.rootInstanceId === id && piOf(id)?.source === f.prefabs.P.guid;
    const n = authored().find((e) => isN(e.id) && !e.guid?.startsWith('ffffffff-0000-4000-8002-'))!;
    expect(n, 'O1\'s nested N').toBeTruthy();
    deleteEntitiesWithUndo([n.id]);
    await settle();
    // In O's prefab edit, N (the reference row's expansion) moves to x 7.
    await savedEditOfP(f, (member) => { void member; expect(writeTraitFieldWithUndo(authored().find((e) => isN(e.id))!.id, transform(), 'x', 7)).toBeNull(); }, 'O');
    const u = await undoStep('undo');
    await settle();
    expect(u.did).toBe(true);
    expect(tf(n.guid!)).toMatchObject({ x: 7 });
    expect((await saveScene({ allowDialog: false })).saved).toBe(true);
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(tf(n.guid!)).toMatchObject({ x: 7 });
  }, 120_000);

  it('the accept side, no template change: the undo brings the row back as it was', async () => {
    await startRun(be, async () => {}, 'surviving-frame-unchanged');
    const b = memberOfP1('B');
    deleteEntitiesWithUndo([b.id]);
    await settle();
    const u = await undoStep('undo');
    await settle();
    expect(u.did).toBe(true);
    expect(tf(b.guid)).toMatchObject({ x: 3, z: 0 });
  }, 120_000);
});
