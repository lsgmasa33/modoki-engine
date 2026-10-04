/** #1872 B — a step that REPLACES a parked prefab replaces the park, the document the editor shows (#1868 D-i), not the
 *  bytes an older Save left in the file. `readPriorDocument` takes the park first, once for every prefab writer; four of
 *  them spelled that inline and three read the file. Two of the three, here:
 *
 *  - The rigged regenerate (`writeModelPrefab`, the Model inspector's Re-import) merges the fresh skeleton over what is
 *    there. Over the file, a child the user hung on a bone that only the park holds was dropped from the write: the
 *    data-loss case.
 *  - The agent's `prefab create` over an existing prefab (a Replace) matches the tree's nodes against the rows it
 *    replaces, by name (`nodeGuidsFor`, #1686). Over the file, a node only the park holds was minted a fresh
 *    `nodeGuid`, which unkeys every instance's edits and pinned guids for it.
 *
 *  And over a park kept across an outside change of the file, the write refuses as a conflict (the commit's D-a rule)
 *  rather than overwriting that change: read from the file, it matched the outside bytes and wrote over them.
 *
 *  Mutation: drop the park read from `readPriorDocument` — all three red. (The third, the model re-import's Replace in
 *  `Assets.tsx`, reads through the same line; `priorDocumentRead.test.ts` pins the read itself.)
 *
 *  Driven through the prefab fuzzer's harness: the real backend route, the commit and both caches. */

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
import { boot, bridge, memoryStorage, startRun, settle, authored, flushWatcher } from './prefabFuzz/harness';
import { runAgentOp } from '../../app/debug/agentBridge';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { parkPrefab, parkedPrefab, parkedPrefabEntry } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import { writeModelPrefab } from '../../packages/modoki/src/editor/panels/assetViews/modelPrefabWrite';
import { emptySpecs } from '../../packages/modoki/src/runtime/scene/entityCreateSpecs';
import { createEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import type { PrefabFile } from '../../packages/modoki/src/editor/scene/prefab';
import { placePrefabFromPath } from '../../packages/modoki/src/editor/scene/prefabPlace';
import { applyToPrefabWithUndo } from '../../packages/modoki/src/editor/undo/applyPrefabUndo';
import { previewApply } from '../../packages/modoki/src/editor/scene/prefabApply';
import { collectInstanceOverrideKeys } from '../../packages/modoki/src/editor/scene/prefabOverrideKeys';
import { applyTargetOptions } from '../../packages/modoki/src/editor/scene/prefabApplyOptions';
import { initialTargets, toApplyTargets } from '../../packages/modoki/src/editor/panels/applyDialogModel';
import { getCachedPrefabSync, preloadNestedPrefabsForSubtree } from '../../packages/modoki/src/editor/scene/prefabCache';
import { undoStep } from '../../packages/modoki/src/editor/undo/undoManager';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', be.fetch);
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const row = (localId: number, name: string, parentId: number, extra: Record<string, unknown> = {}) => ({
  localId, name, nodeGuid: `9${String(localId).padStart(7, '0')}-0000-4000-8000-0000000${String(1872 * 10 + localId)}`,
  traits: { EntityAttributes: { name, parentId, guid: '' }, Transform: { x: 0, y: 0, z: 0 }, ...extra },
});
const fileText = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;

describe('a Replace of a parked prefab reads the park (#1872 B)', () => {
  it('the rigged regenerate merges over the PARK: a child the user hung on a bone, parked, is in the write', async () => {
    const f = await startRun(be, async () => {}, 'parkedRigRegenerate');
    const path = `${f.root}/prefabs/Rig.prefab.json`;
    const guid = 'aaaaaaaa-0000-4000-8000-000000001872';
    const skeleton = [row(1, 'Rig', 0), row(2, 'Hip', 1, { Bone: { name: 'hip' } })];
    const onDisk = { id: guid, version: 5, name: 'Rig', rootLocalId: 1, entities: skeleton };
    const park = { ...onDisk, entities: [...skeleton, row(3, 'Sword', 2)] };
    be.write(path, fileText(onDisk));
    registerAsset(guid, path, 'prefab');
    parkPrefab(path, park, onDisk);
    // The re-import's fresh serialization: the skeleton only, which is all a GLB knows.
    const fresh = { id: guid, version: 5, name: 'Rig', rootLocalId: 1, entities: skeleton.map((r) => ({ ...r, nodeGuid: undefined })) };
    const res = await writeModelPrefab(path, fresh as unknown as PrefabFile, { exists: true, rigged: true });
    await settle();
    expect(res).toEqual({ ok: true });
    const written = JSON.parse(be.read(path)!) as PrefabFile;
    expect(written.entities.map((e) => e.name).sort()).toEqual(['Hip', 'Rig', 'Sword']);
    expect(parkedPrefab(path), 'the write that read the park retires it').toBeUndefined();
  });

  it('over a park kept across an OUTSIDE change of the file, the regenerate refuses as a conflict and the file keeps it', async () => {
    // It reads the park, and the commit checks a park-equal expectation against the park's own baseline (D-a) — which
    // the outside edit is not. Read from the file instead, the write matched it and overwrote the outside change unasked.
    const f = await startRun(be, async () => {}, 'parkedRigOutsideChange');
    const path = `${f.root}/prefabs/Rig.prefab.json`;
    const guid = 'aaaaaaaa-0000-4000-8000-000000001874';
    const skeleton = [row(1, 'Rig', 0), row(2, 'Hip', 1, { Bone: { name: 'hip' } })];
    const onDisk = { id: guid, version: 5, name: 'Rig', rootLocalId: 1, entities: skeleton };
    be.write(path, fileText(onDisk));
    registerAsset(guid, path, 'prefab');
    parkPrefab(path, { ...onDisk, entities: [...skeleton, row(3, 'Sword', 2)] }, onDisk);
    const outside = fileText({ ...onDisk, entities: [...skeleton, row(4, 'Pulled', 1)] });
    const before = be.snapshot();
    be.write(path, outside); // a pull, after the park; the watcher keeps a parked prefab's park over it (#1868)
    await flushWatcher(be, before);
    await settle();
    expect(parkedPrefabEntry(path)?.fileChanged, 'premise: the watcher kept the park over the change').toBe(true);
    const fresh = { id: guid, version: 5, name: 'Rig', rootLocalId: 1, entities: skeleton.map((r) => ({ ...r, nodeGuid: undefined })) };
    const res = await writeModelPrefab(path, fresh as unknown as PrefabFile, { exists: true, rigged: true });
    await settle();
    expect(res.unreadable).toBeFalsy();
    expect(res.unreadable ? undefined : res.ok).toBe(false);
    expect(be.read(path)).toBe(outside);
    // The cause, said (close-out review): a conflict carries no `error`, and the panel logged a causeless failure.
    // Mutation: drop the conflict's reason in `writeModelPrefab` — red.
    expect(res.unreadable ? '' : res.error).toMatch(/unsaved changes in the editor/);
  });

  it("the agent's create over a prefab parked across an outside change refuses with the park's cause and its exits", async () => {
    // Its old wording ("changed on disk while this create was writing it … Retry") was false twice over there: the file
    // changed before the create, and a retry meets the same park. Mutation: word every conflict as the non-parked one
    // in `prefabConflictReason` — red.
    const f = await startRun(be, async () => {}, 'parkedAgentConflict');
    const path = `${f.root}/prefabs/Kit.prefab.json`;
    const guid = 'aaaaaaaa-0000-4000-8000-000000001875';
    const onDisk = { id: guid, version: 5, name: 'Kit', rootLocalId: 1, nextLocalId: 3, entities: [row(1, 'Kit', 0), row(2, 'Bolt', 1)] };
    be.write(path, fileText(onDisk));
    registerAsset(guid, path, 'prefab');
    parkPrefab(path, { ...onDisk, entities: [...onDisk.entities, row(3, 'Nut', 1)] }, onDisk);
    const before = be.snapshot();
    be.write(path, fileText({ ...onDisk, entities: [...onDisk.entities, row(4, 'Pulled', 1)] }));
    await flushWatcher(be, before);
    await settle();
    const { specs } = emptySpecs(0);
    const kit = createEntityWithUndo('Create Kit', 0, specs.map((s) => (s.name === 'EntityAttributes' ? { ...s, data: { ...s.data, name: 'Kit' } } : s)), () => {})!;
    await settle();
    const kitGuid = authored().find((e) => e.id === kit)!.guid!;
    const err = await runAgentOp('prefab', { action: 'create', entityGuid: kitGuid, path, replace: true }).then(() => null, (e: unknown) => e as { message?: string; options?: string[] });
    expect(err?.message).toMatch(/unsaved changes in the editor/);
    expect(err?.message).not.toMatch(/while this create was writing/);
    expect(JSON.stringify(err)).toMatch(/modoki_discard_asset_edits/);
  });

  it("the agent's prefab create over a parked prefab keeps the PARK's node identity for a node only it holds", async () => {
    const f = await startRun(be, async () => {}, 'parkedAgentReplace');
    const path = `${f.root}/prefabs/Kit.prefab.json`;
    const guid = 'aaaaaaaa-0000-4000-8000-000000001873';
    const onDisk = { id: guid, version: 5, name: 'Kit', rootLocalId: 1, nextLocalId: 4, entities: [row(1, 'Kit', 0), row(2, 'Bolt', 1)] };
    const park = { ...onDisk, entities: [...onDisk.entities, row(3, 'Nut', 1)] };
    be.write(path, fileText(onDisk));
    registerAsset(guid, path, 'prefab');
    parkPrefab(path, park, onDisk);
    // A plain tree with the same names, saved over Kit by the agent.
    const make = (parent: number, name: string) => {
      const { specs } = emptySpecs(parent);
      return createEntityWithUndo(`Create ${name}`, parent, specs.map((s) => (s.name === 'EntityAttributes' ? { ...s, data: { ...s.data, name } } : s)), () => {})!;
    };
    const kit = make(0, 'Kit');
    make(kit, 'Bolt');
    make(kit, 'Nut');
    await settle();
    const kitGuid = authored().find((e) => e.id === kit)!.guid!;
    const res = await runAgentOp('prefab', { action: 'create', entityGuid: kitGuid, path, replace: true }) as { ok?: boolean };
    await settle();
    expect(res.ok).toBe(true);
    const written = JSON.parse(be.read(path)!) as PrefabFile;
    expect(written.id).toBe(guid);
    const nodeOf = (name: string) => written.entities.find((e) => e.name === name)?.nodeGuid;
    expect(nodeOf('Bolt')).toBe(row(2, 'Bolt', 1).nodeGuid);
    expect(nodeOf('Nut'), "the park's row, not a minted one").toBe(row(3, 'Nut', 1).nodeGuid);
  });

  it("a park an undo made keeps the file's localId mark: a row minted over it never takes the undone row's number (I4)", async () => {
    // An Apply adds row 3 to Q and raises its mark to 4; its undo restores the old Q in memory and parks it. The rigged
    // regenerate then mints a new bone over the PARK: with the old document's mark it took 3, the number the undone
    // row held, which #1774 forbids (a localId-keyed channel orphaned by that row would attach to the new one).
    // Mutation: drop the raise in `restorePrefabsInMemory` — red.
    const f = await startRun(be, async () => {}, 'parkedMark');
    const qId = (await placePrefabFromPath(f.prefabs.Q.path, { tag: 'test', parentId: 0 }))!;
    await settle();
    const { specs } = emptySpecs(qId);
    createEntityWithUndo('Create Z', qId, specs.map((s) => (s.name === 'EntityAttributes' ? { ...s, data: { ...s.data, name: 'Z' } } : s)), () => {});
    await preloadNestedPrefabsForSubtree(qId);
    const prefab = getCachedPrefabSync(f.prefabs.Q.guid)!;
    const sel = new Set(collectInstanceOverrideKeys(qId, prefab).all);
    const targets = toApplyTargets(initialTargets(applyTargetOptions(qId, prefab, [...sel])), sel);
    const pv = await previewApply(qId, new Set(sel), targets);
    expect((await applyToPrefabWithUndo(qId, sel, targets, { expect: pv.fingerprint })).applied).toBe(true);
    await settle();
    const applied = JSON.parse(be.read(f.prefabs.Q.path)!) as PrefabFile;
    const zId = applied.entities.find((e) => e.name === 'Z')!.localId;
    expect((await undoStep('undo')).did).toBe(true);
    await settle();
    expect(parkedPrefab(f.prefabs.Q.path), 'premise: the undo parked Q').toBeDefined();
    const fresh = { id: f.prefabs.Q.guid, version: 5, name: 'Q', rootLocalId: 1, entities: [row(1, 'QR', 0), row(2, 'Spine', 1, { Bone: { name: 'spine' } })].map((r) => ({ ...r, nodeGuid: undefined })) };
    expect(await writeModelPrefab(f.prefabs.Q.path, fresh as unknown as PrefabFile, { exists: true, rigged: true })).toEqual({ ok: true });
    await settle();
    const written = JSON.parse(be.read(f.prefabs.Q.path)!) as PrefabFile;
    const spine = written.entities.find((e) => e.name === 'Spine')!;
    expect(spine.localId).toBeGreaterThan(zId);
  });
});
