/** #2101 (hunt seed 8494) — Detach P1, edit P's A.z to -4 in prefab edit, Create Prefab "A" from the detached A (still at
 *  z 0, so the file says 0). The walk to the ends: the Detach's undo re-links A to P, showing P's -4 (right); its redo
 *  re-runs the detach on the live tree (#1665), so plain A keeps -4; the Create's redo re-tags A in place against the
 *  file (z 0) and seats a record built from the live tree, which states no z. Live -4 against record + document 0: the
 *  next rebuild moved A. The redo now shows the instance from its record (hub ruling (a), 2026-10-05).
 *
 *  Driven through the prefab fuzzer's harness, on its fixture. Mutation: drop the reprojection after the redo's tag in
 *  `createPrefab` (`assetOps.ts`) → A is -4 after the redo, and the rebuild moves it to 0; drop `putLiveValuesBack` in
 *  its undo → the undo of the redo leaves A at 0. */

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
import { boot, bridge, memoryStorage, startRun, settle, authored, piOf } from './prefabFuzz/harness';
import { pushAction } from '@modoki/engine/editor';
import { getTraitByName, readTraitData } from '@modoki/engine/runtime';
import { detachPrefabInstanceWithUndo } from '../../packages/modoki/src/editor/undo/detachPrefabUndo';
import { writeTraitFieldWithUndo, addTraitToEntitiesWithUndo, removeTraitFromEntitiesWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { openPrefabForEditing, savePrefabEditReport, exitPrefabEditing } from '../../packages/modoki/src/editor/scene/prefabEdit';
import { createPrefabFromEntity } from '../../packages/modoki/src/editor/panels/assetOps';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';
import { reprojectFromStore } from '../../packages/modoki/src/editor/instance/instanceReproject';
import { whyWorldNotAuthored } from '../../packages/modoki/src/editor/scene/authoredWorld';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

describe('#2101: redo of Create Prefab after its source drifted shows the prefab file\'s values', () => {
  it('Detach → edit P → Create Prefab, then undo and redo to the ends: A is at the file\'s z, and a rebuild leaves it there', async () => {
    const f = await startRun(be, async () => {}, 'create-redo-drift');
    const tf = getTraitByName('Transform')!;
    const p1 = authored().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8002-'))!;
    const aGuid = authored().find((e) => e.name === 'A' && piOf(e.id)?.rootInstanceId === p1.id)!.guid!;
    const a = () => authored().find((e) => e.guid === aGuid)!;
    const z = () => (readTraitData(a().id, tf) as { z: number }).z;

    expect(await detachPrefabInstanceWithUndo(p1.id, 'Detach prefab', '[test]')).toBeTruthy();
    await settle();
    expect(await openPrefabForEditing({ path: f.prefabs.P.path, name: 'P' }, { confirmDiscard: async () => true })).toBeFalsy();
    const aEdit = authored().find((e) => e.name === 'A')!;
    expect(writeTraitFieldWithUndo(aEdit.id, tf, 'z', -4)).toBeFalsy();
    expect((await savePrefabEditReport({})).saved).toBe(true);
    await exitPrefabEditing();
    await settle();
    expect(z(), 'premise: the detached A keeps z 0').toBe(0);

    const made = await createPrefabFromEntity(a().id, `${f.root}/prefabs/A.prefab.json`, 'Save prefab "A"', async () => true);
    if (!made || made === 'declined' || 'refused' in made) throw new Error(`premise: Create Prefab (${JSON.stringify(made)})`);
    pushAction(made.action);
    await settle();

    expect((await undoStep('undo')).did, 'undo Create Prefab').toBe(true);
    expect((await undoStep('undo')).did, 'undo Detach').toBe(true);
    await settle();
    expect(z(), 'premise: re-linked to P, A shows P\'s -4').toBe(-4);
    expect((await undoStep('redo')).did, 'redo Detach').toBe(true);
    await settle();
    expect(z(), 'premise: the redone detach keeps the live -4 (#1665)').toBe(-4);
    expect((await undoStep('redo')).did, 'redo Create Prefab').toBe(true);
    await settle();

    expect(piOf(a().id)?.rootInstanceId, 'A is an instance root again').toBe(a().id);
    expect(z(), 'the redo shows the file\'s z').toBe(0);
    expect(reprojectFromStore(a().id), 'the rebuild runs').toBeTruthy();
    await settle();
    expect(z(), 'a rebuild leaves it there').toBe(0);
    expect(whyWorldNotAuthored()).toBeNull();

    // The undo of that redo returns the state the redo started from (#2144 close-out review): plain A at -4.
    expect((await undoStep('undo')).did, 'undo the redone Create Prefab').toBe(true);
    await settle();
    expect(piOf(a().id), 'A is plain again').toBeUndefined();
    expect(z(), 'at the -4 the redo replaced').toBe(-4);
    expect(whyWorldNotAuthored()).toBeNull();
  }, 120_000);
  // The same walk for a COMPONENT (#2101 close-out review, observed): P's A gains Rotate3D, P1 is detached (its A keeps
  // it), P's A loses it, then Create Prefab "A" (its file has Rotate3D). Redone after the walk, the projection gives A the
  // file's Rotate3D, which the redone Detach had not; the undo of that redo takes it off again. Mutation: drop the removal
  // loop in `putLiveValuesBack` (`assetOps.ts`) → A keeps Rotate3D after the undo.
  it('a component the redo\'s projection added goes again with the undo of that redo', async () => {
    const f = await startRun(be, async () => {}, 'create-redo-drift-component');
    const rot = getTraitByName('Rotate3D')!;
    const editA = async (fn: (id: number) => unknown) => {
      expect(await openPrefabForEditing({ path: f.prefabs.P.path, name: 'P' }, { confirmDiscard: async () => true })).toBeFalsy();
      expect(fn(authored().find((e) => e.name === 'A')!.id)).toBeFalsy();
      expect((await savePrefabEditReport({})).saved).toBe(true);
      await exitPrefabEditing();
      await settle();
    };
    await editA((id) => addTraitToEntitiesWithUndo([id], rot, { axis: 'y', speed: 2 }));
    const p1 = authored().find((e) => e.guid?.startsWith('ffffffff-0000-4000-8002-'))!;
    const aGuid = authored().find((e) => e.name === 'A' && piOf(e.id)?.rootInstanceId === p1.id)!.guid!;
    const a = () => authored().find((e) => e.guid === aGuid)!;
    const hasRot = () => a().traits.includes('Rotate3D');
    expect(await detachPrefabInstanceWithUndo(p1.id, 'Detach prefab', '[test]')).toBeTruthy();
    await settle();
    await editA((id) => removeTraitFromEntitiesWithUndo([id], rot));
    expect(hasRot(), 'premise: the detached A keeps Rotate3D').toBe(true);

    const made = await createPrefabFromEntity(a().id, `${f.root}/prefabs/A.prefab.json`, 'Save prefab "A"', async () => true);
    if (!made || made === 'declined' || 'refused' in made) throw new Error(`premise: Create Prefab (${JSON.stringify(made)})`);
    pushAction(made.action);
    await settle();
    for (const dir of ['undo', 'undo', 'redo'] as const) expect((await undoStep(dir)).did, dir).toBe(true);
    await settle();
    expect(hasRot(), 'premise: the redone Detach has no Rotate3D (P lost it)').toBe(false);
    expect((await undoStep('redo')).did, 'redo Create Prefab').toBe(true);
    await settle();
    expect(hasRot(), 'premise: shown from its record, A has the file\'s Rotate3D').toBe(true);
    expect((await undoStep('undo')).did, 'undo the redone Create Prefab').toBe(true);
    await settle();
    expect(hasRot(), 'the undo takes the component the redo added off again').toBe(false);
    expect(whyWorldNotAuthored()).toBeNull();
  }, 120_000);
});
