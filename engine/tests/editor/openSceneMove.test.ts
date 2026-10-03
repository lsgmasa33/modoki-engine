/** #2078 (B3 rule 12): a rename or move of the OPEN scene's file, or of a loaded base's, moves the editor's record of
 *  which file is open. `/api/move-file` marks the move as the editor's own, so no watcher event says the file left;
 *  before the fix the next save recreated the OLD path carrying the scene's id, the scan re-minted that copy, and the
 *  edits went to a file nothing references while the renamed one kept the guid (observed live in `games/sling`).
 *
 *  Driven through the real router (`makeFuzzBackend`): the move is `/api/move-file`, whose relay runs the renderer's
 *  `applyAssetPathMoves`, and the save writes the scratch directory. */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';

// The move lands the file at its new path, then trashes the old one; the suite's trash guard refuses a real trash.
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) fs.rmSync(p, { recursive: true, force: true });
    return { failed: [] };
  },
}));
import { makeFuzzBackend, ROOT_URL } from './prefabFuzz/backend';
import { boot, bridge, memoryStorage, startRun, settle } from './prefabFuzz/harness';
import { getAllEntities, getTraitByName, readTraitDataFull, writeTraitField } from '@modoki/engine/runtime';
import { emptySpecs } from '../../packages/modoki/src/runtime/scene/entityCreateSpecs';
import { createEntityWithUndo } from '../../packages/modoki/src/editor/undo/entityActions';
import { registerAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { applyAssetPathMoves } from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { saveAll, loadSceneReporting, getCurrentScenePath } from '../../packages/modoki/src/editor/scene/serialize';
import { markSceneDirty } from '../../packages/modoki/src/editor/scene/sceneDirty';
import { sceneManager } from '../../packages/modoki/src/runtime/scene/SceneManager';
import { SCENE_FORMAT_VERSION } from '../../packages/modoki/src/runtime/core/version';
import { canUndo, activeHistoryKey } from '../../packages/modoki/src/editor/undo/undoManager';
import { enterPlay, stopPlay, enterScrubMode, exitPreviewMode } from '../../packages/modoki/src/editor/scene/playMode';
import { beginTimelinePreviewSession, endTimelinePreviewSession } from '../../packages/modoki/src/editor/scene/timelinePreview';
import { normScenePath } from '../../packages/modoki/src/runtime/scene/scenePathKey';

const be = makeFuzzBackend();
vi.stubGlobal('fetch', (input: string | URL, init?: { method?: string; body?: string }) => be.fetch(input, init));
vi.stubGlobal('window', { __modokiElectron: { bridge } });
vi.stubGlobal('localStorage', memoryStorage());
boot(be);

const move = async (from: string, to: string) => {
  expect(to).not.toBe(from);
  const res = await be.fetch('/api/move-file', { method: 'POST', body: JSON.stringify({ from, to }) });
  const body = await res.json() as { ok?: boolean; error?: string };
  expect(body.error).toBeUndefined();
  await settle();
};
const named = (name: string) => getAllEntities().find((e) => e.name === name);
const addRoot = (name: string) => {
  const { specs } = emptySpecs(0);
  createEntityWithUndo(`Create ${name}`, 0, specs.map((s) => (s.name === 'EntityAttributes' ? { ...s, data: { ...s.data, name } } : s)), () => {});
  expect(named(name)).toBeDefined();
};
const doc = (url: string) => JSON.parse(be.read(url)!) as { id: string; createdAt?: string; entities: { traits?: { EntityAttributes?: { name?: string } } }[] };
const writeScene = (url: string, guid: string) => {
  be.write(url, `${JSON.stringify({ id: guid, version: SCENE_FORMAT_VERSION, name: 'Other', createdAt: '2026-01-01T00:00:00.000Z', resources: [], entities: [] }, null, 2)}\n`);
  registerAsset(guid, url, 'scene');
};
const names = (url: string) => doc(url).entities.map((e) => e.traits?.EntityAttributes?.name);

describe('a move of the open scene file (#2078)', () => {
  it('the next save writes the renamed file, with its id, and does not recreate the old path', async () => {
    const f = await startRun(be, async () => {}, 'open-scene-move');
    const createdAt = doc(f.scenePath).createdAt;
    expect(createdAt).toBeTruthy();
    const renamed = f.scenePath.replace(/\.json$/, ' renamed.json');
    await move(f.scenePath, renamed);
    expect(getCurrentScenePath()).toBe(renamed);

    addRoot('AfterRename');
    const r = await saveAll({ allowDialog: false });
    expect(r.saved).toBe(true);

    expect(be.read(f.scenePath), 'the save recreated the old path').toBeUndefined();
    expect(doc(renamed).id).toBe(f.sceneGuid);
    // The loaded entry moved with it, so the save still reads the file's own stamp rather than minting one.
    expect(doc(renamed).createdAt).toBe(createdAt);
    expect(names(renamed)).toContain('AfterRename');

    // The undo stack moved with it: reopening the renamed file is a same-key load, which keeps the stack.
    expect(canUndo()).toBe(true);
    expect((await loadSceneReporting(renamed)).outcome).toBe('loaded');
    await settle();
    expect(canUndo(), 'the reload swapped the stack out under the new key').toBe(true);
  });

  it('a PARKED undo stack follows its scene file, and is not inherited by a new file at the old path', async () => {
    const f = await startRun(be, async () => {}, 'parked-history-move');
    addRoot('Parked');
    expect((await saveAll({ allowDialog: false })).saved).toBe(true);
    const other = `${ROOT_URL}/scenes/Other.scene.json`;
    writeScene(other, '00002078-0000-4000-8000-000000000002');
    expect((await loadSceneReporting(other)).outcome).toBe('loaded'); // parks the fixture scene's stack
    await settle();
    expect(canUndo()).toBe(false);

    const renamed = f.scenePath.replace(/\.json$/, ' renamed.json');
    await move(f.scenePath, renamed);
    // A new scene at the old path is a different document: it must not get the moved scene's stack.
    writeScene(f.scenePath, '00002078-0000-4000-8000-000000000003');
    expect((await loadSceneReporting(f.scenePath)).outcome).toBe('loaded');
    await settle();
    expect(canUndo(), 'a new file at the old path inherited the moved scene\'s undo stack').toBe(false);
    expect((await loadSceneReporting(renamed)).outcome).toBe('loaded');
    await settle();
    expect(canUndo(), 'the moved scene lost its parked undo stack').toBe(true);
  });

  it('a loaded BASE that moved is written at its new path', async () => {
    const f = await startRun(be, async () => {}, 'base-scene-move');
    // A primary with a base: the fixture scene becomes the base of a new primary.
    const primary = `${ROOT_URL}/scenes/Primary.scene.json`;
    const primaryGuid = '00002078-0000-4000-8000-000000000001';
    be.write(primary, `${JSON.stringify({
      id: primaryGuid, version: SCENE_FORMAT_VERSION, name: 'Primary', createdAt: '2026-01-01T00:00:00.000Z',
      baseScene: f.sceneGuid, resources: [], entities: [],
    }, null, 2)}\n`);
    registerAsset(primaryGuid, primary, 'scene');
    expect((await loadSceneReporting(primary)).outcome).toBe('loaded');
    await settle();
    const base = [...sceneManager.getLoadedScenes().values()].find((e) => e.role === 'base');
    expect(base?.path).toBe(f.scenePath);

    const movedBase = f.scenePath.replace(/\.json$/, ' moved.json');
    await move(f.scenePath, movedBase);
    expect([...sceneManager.getLoadedScenes().values()].find((e) => e.role === 'base')?.path).toBe(movedBase);

    markSceneDirty(f.sceneGuid); // an in-place edit of a base entity: Save All writes the base to its loaded entry's path
    const r = await saveAll({ allowDialog: false }) as { saved: boolean; extraSaved?: { path: string }[] };
    expect(r.saved).toBe(true);
    expect(r.extraSaved?.map((e) => e.path)).toEqual([movedBase]);
    expect(be.read(f.scenePath), 'the save recreated the base at its old path').toBeUndefined();
    expect(doc(movedBase).id).toBe(f.sceneGuid);
  });
});

describe('the other records of the open scene file follow a move too (#2078 close-out review)', () => {
  it('a rename during Play: Stop still reverts to the authored world', async () => {
    const f = await startRun(be, async () => {}, 'play-move');
    expect((await enterPlay()).kind).toBe('started');
    await settle();
    await move(f.scenePath, f.scenePath.replace(/\.json$/, ' renamed.json'));
    // Left on the old path, the snapshot read the rename as "the scene changed during Play" and was not restored.
    expect(await stopPlay()).toMatchObject({ kind: 'stopped', reverted: true });
    await settle();
  });

  it('a rename during a timeline preview: ending the session still puts the authored world back', async () => {
    const f = await startRun(be, async () => {}, 'preview-move');
    const transform = getTraitByName('Transform')!;
    const plainY = () => readTraitDataFull(named('Plain')!.id, transform)?.y;
    expect(plainY()).toBe(0);
    enterScrubMode('timeline');
    expect(await beginTimelinePreviewSession()).toBe(true);
    writeTraitField(named('Plain')!.id, transform, 'y', 5); // what a scrub poses
    await move(f.scenePath, f.scenePath.replace(/\.json$/, ' renamed.json'));
    await endTimelinePreviewSession({ restore: true });
    exitPreviewMode('timeline');
    await settle();
    expect(plainY(), 'the posed value stayed as the authored one').toBe(0);
  });

  it('a FOLDER move that carries the open scene', async () => {
    const f = await startRun(be, async () => {}, 'folder-move');
    const createdAt = doc(f.scenePath).createdAt;
    addRoot('InFolder');
    const oldDir = f.scenePath.slice(0, f.scenePath.lastIndexOf('/'));
    const moved = `${oldDir}2${f.scenePath.slice(oldDir.length)}`;
    await move(oldDir, `${oldDir}2`);
    expect(getCurrentScenePath()).toBe(moved);
    expect(canUndo()).toBe(true);
    expect((await saveAll({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath), 'the save recreated the old path').toBeUndefined();
    expect(doc(moved).createdAt).toBe(createdAt);
    expect(names(moved)).toContain('InFolder');
  });

  it('a scene opened under another spelling (a typed ./ segment, #1791) is still found by the move', async () => {
    const f = await startRun(be, async () => {}, 'dot-move');
    const dotted = f.scenePath.replace(/\/scenes\//, '/scenes/./');
    expect((await loadSceneReporting(dotted)).outcome).toBe('loaded');
    await settle();
    addRoot('Dotted');
    const renamed = f.scenePath.replace(/\.json$/, ' renamed.json');
    await move(f.scenePath, renamed);
    expect(getCurrentScenePath()).toBe(renamed);
    expect(activeHistoryKey()).toBe(normScenePath(renamed));
    expect((await saveAll({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath), 'the save recreated the old path').toBeUndefined();
    expect(names(renamed)).toContain('Dotted');
  });
});

describe('the guid confirms the move (#2078 re-reviews)', () => {
  it('a move whose manifest rebuild FAILED still moves the open scene (exact spelling), and Cmd+S writes the new path', async () => {
    const f = await startRun(be, async () => {}, 'lagging-manifest-move');
    addRoot('Lagging');
    const renamed = f.scenePath.replace(/\.json$/, ' renamed.json');
    be.failManifestRebuilds = true;
    try {
      await move(f.scenePath, renamed);
    } finally {
      be.failManifestRebuilds = false;
    }
    expect(getCurrentScenePath()).toBe(renamed);
    expect(activeHistoryKey()).toBe(normScenePath(renamed));
    be.pushManifest(); // the watcher's later push
    expect((await saveAll({ allowDialog: false })).saved).toBe(true);
    expect(be.read(f.scenePath), 'the save recreated the old path').toBeUndefined();
    expect(names(renamed)).toContain('Lagging');
  });

  it('a move of ANOTHER file sharing the open scene\'s key moves neither the scene nor its undo stack', async () => {
    const f = await startRun(be, async () => {}, 'shared-key-move');
    addRoot('StaysPut');
    // `Fu%7Az.json` is a different file whose key is the open scene's: normScenePath decodes `%7A` to `z`.
    const twin = f.scenePath.replace(/Fuzz\.json$/, 'Fu%7Az.json');
    expect(normScenePath(twin)).toBe(normScenePath(f.scenePath));
    const twinTo = f.scenePath.replace(/Fuzz\.json$/, 'B.json');
    registerAsset('00002078-0000-4000-8000-0000000000b1', twinTo, 'scene'); // where the route put the twin
    const before = { path: getCurrentScenePath(), key: activeHistoryKey() };
    applyAssetPathMoves([{ from: twin, to: twinTo }]);
    expect(getCurrentScenePath()).toBe(before.path);
    expect(activeHistoryKey(), 'the live undo key followed another file').toBe(before.key);
    expect([...sceneManager.getLoadedScenes().values()].find((e) => e.role === 'primary')?.path).toBe(f.scenePath);
    expect(canUndo()).toBe(true);
  });
});
