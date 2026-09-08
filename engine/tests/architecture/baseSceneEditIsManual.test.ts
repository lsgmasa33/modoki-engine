/** Two ABSENCES and one ORDERING that #831's Scene half depends on, and that no behavioural test
 *  can see.
 *
 *  `SceneAssetView` is a `.tsx` and does not get mounted (docs/editor.md § Panels), and `saveAll`
 *  needs a live world, a scene path and a backend — so what is left is a source scan. Its limit,
 *  stated rather than implied: it proves the source does not NAME a writer and that two calls
 *  appear in a given order, not that no writer is reachable through something else it calls.
 *  The behaviour these protect is covered in `tests/editor/pendingBaseScene.test.ts`. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';

const SRC = path.resolve(__dirname, '../../packages/modoki/src/editor');

describe('the Scene inspector no longer writes on a field change (#831)', () => {
  it('SceneAssetView calls no write route of its own', () => {
    const code = readScannedSource(path.join(SRC, 'panels/assetViews/SceneAssetView.tsx')).code;
    // Non-vacuity: the file must actually have been read, and must be routing the edit.
    expect(code).toContain('applyBaseSceneEdit');
    for (const forbidden of ['/api/scene-mutate', '/api/write-file', '/api/asset-write', 'backendFetch']) {
      expect(code, `SceneAssetView still references \`${forbidden}\` — a base-scene edit must reach `
        + 'disk only through a save, or #831 is back on this view')
        .not.toContain(forbidden);
    }
  });
});

describe('the panel makes its routing decision ONCE (#831 re-review, finding 4)', () => {
  it('`fileDirect` comes from the route `write` actually took, not from a render-time copy', () => {
    // ⚠️ Two reads of `getCurrentScenePath()` — one at render, one at apply time — disagree by
    // construction whenever the scene changed between them, and taking `fileDirect` from the stale
    // one makes an edit INVISIBLE: the live route deletes the park and `_isFileDirect: true`
    // suppresses the edit-version bump, so no badge, `hasUnsavedChanges()` false, and Cmd+S writes
    // nothing. One read, recorded, used for both.
    const code = readScannedSource(path.join(SRC, 'panels/assetViews/SceneAssetView.tsx')).code;
    expect(code).toContain('lastRoute.current = applyBaseSceneEdit(');
    expect(code).toContain("fileDirect: lastRoute.current === 'parked'");
    const reads = code.match(/getCurrentScenePath\(\)/g) ?? [];
    expect(reads.length, 'a SECOND read of the current scene path is a second routing decision, and '
      + 'the two cannot be kept in step — that is the defect, not the duplication')
      .toBe(1);
  });
});

describe('saveAll flushes pending base scenes LAST (#831)', () => {
  it('the flush is issued after the asset flush and after the scene write', () => {
    // ⚠️ Not a style point. `/api/scene-mutate` refuses while the editor reports unsaved work, and
    // `hasUnsavedChanges()` counts parked asset docs, a dirty scene AND these entries. Run the
    // flush before the asset flush or before the scene write and every mutation 409s against the
    // very save that is trying to persist it — a deadlock with no error anyone would read as one.
    const code = readScannedSource(path.join(SRC, 'scene/serialize.ts')).code;
    const saveAllAt = code.indexOf('export async function saveAll(');
    expect(saveAllAt, 'saveAll was renamed — this guard cannot vouch for a function it cannot find')
      .toBeGreaterThan(-1);
    const body = code.slice(saveAllAt);

    const assetFlush = body.indexOf('await flushDirtyAssets()');
    const sceneWrite = body.indexOf('await saveScene(opts)');
    // ⚠️ The CALL, not the declaration. An earlier version of this guard matched
    // `flushPendingBaseScenes()` — which first appears inside `withBaseScenes`' body — so moving
    // the AWAIT above `saveScene`, the exact refactor this exists to catch, left it green. The
    // declaration is checked too, because a helper declared before the scene write reads as though
    // it runs there and is the shape a reader would move.
    const baseFlushCall = body.indexOf('await withBaseScenes()');
    const baseFlushDecl = body.indexOf('const withBaseScenes =');
    for (const [label, at] of [
      ['flushDirtyAssets', assetFlush], ['saveScene', sceneWrite],
      ['await withBaseScenes()', baseFlushCall], ['const withBaseScenes =', baseFlushDecl],
    ] as const) {
      expect(at, `saveAll no longer contains \`${label}\` — the ordering this guard asserts has no subject`).toBeGreaterThan(-1);
    }
    // …and the helper must actually flush, or the names above vouch for nothing.
    expect(body.slice(baseFlushDecl, baseFlushCall)).toContain('flushPendingBaseScenes()');
    expect(assetFlush).toBeLessThan(sceneWrite);
    expect(sceneWrite, 'flushPendingBaseScenes must be AWAITED after the scene write, or it 409s '
      + 'against the editor\'s own unsaved-work guard').toBeLessThan(baseFlushCall);
    expect(sceneWrite, 'and declared after it too — a helper declared above the scene write reads '
      + 'as though it runs there').toBeLessThan(baseFlushDecl);
  });

  it('the PREFAB-edit branch flushes them too, and after its own save', () => {
    // That branch returns before `saveAll`, so it needs its own flush — the same #259 reasoning it
    // already applies to parked ASSET docs: a base ref on a scene the editor never loaded has
    // nothing to do with which world is open. AFTER `savePrefabEdit` for the same reason as above:
    // the prefab world's unsaved edits are exactly what the route refuses on.
    const code = readScannedSource(path.join(SRC, 'scene/saveCommand.ts')).code;
    const branch = code.slice(code.indexOf('if (isEditingPrefab())'));
    const prefabSave = branch.indexOf('await savePrefabEdit()');
    const baseFlush = branch.indexOf('await flushPendingBaseScenes()');
    expect(prefabSave, 'the prefab-edit branch no longer calls savePrefabEdit').toBeGreaterThan(-1);
    expect(baseFlush, 'the prefab-edit branch does not flush pending base scenes — Cmd+S there '
      + 'leaves the edit pending and says nothing').toBeGreaterThan(-1);
    expect(prefabSave).toBeLessThan(baseFlush);
  });
});
