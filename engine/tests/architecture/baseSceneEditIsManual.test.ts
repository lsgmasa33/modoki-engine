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
import { causeSpecs, flushParked } from '../../packages/modoki/src/editor/scene/serialize';

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

describe('the base-scene flush runs LAST, and that rule is DATA (#831, #972)', () => {
  // ⚠️ Not a style point. `/api/scene-mutate` refuses while the editor reports unsaved work, and
  // `hasUnsavedChanges()` counts parked asset docs, a dirty scene AND these entries. Run the
  // base-scene flush before the scene write and every mutation 409s against the very save that is
  // trying to persist it — a deadlock with no error anyone would read as one.
  //
  // ⚠️ **This used to be a source-order scan, and #972 Phase 1 moved the rule into the cause
  // table.** The old guard read `saveAll`'s textual layout for `await flushDirtyAssets()` …
  // `await saveScene(opts)` … `await withBaseScenes()`, because the ordering lived nowhere else.
  // It now lives on `CAUSE_SPECS[cause].writtenBy.flush`, so the primary assertion is on the DATA
  // — a refactor cannot move a phase tag the way it can move a line. The source scan is KEPT for
  // what data alone cannot say: that each save site actually runs the two phases in that order.
  it('every cause declares which side of the scene write flushes it', () => {
    const specs = causeSpecs();
    expect(specs.pendingBaseScenes.writtenBy, 'a base-scene ref flushed BEFORE the scene write '
      + '409s against the editor\'s own unsaved-work guard')
      .toEqual({ flush: 'after-scene', run: expect.any(Function) });
    expect(specs.dirtyAssetPaths.writtenBy).toEqual({ flush: 'before-scene', run: expect.any(Function) });
    expect(specs.pendingImportSettings.writtenBy).toEqual({ flush: 'before-scene', run: expect.any(Function) });
    // The two scene-written causes have no flush of their own — the scene write IS their write.
    expect(specs.sceneDirty.writtenBy).toBe('scene-write');
    expect(specs.dirtyScenes.writtenBy).toBe('scene-write');
  });

  it('flushParked returns exactly the causes its phase declares, and no others', async () => {
    // Behavioural, not a scan — the runner is what turns the phase tags above into an order, so a
    // tag nothing reads would leave the previous test asserting a decoration.
    //
    // Safe to call for real with the registries empty: all three flushes take their batch out
    // first and no-op on an empty one, so this issues no `/api/*` request. What it proves is the
    // KEY SET, which is the half that decides whether a save site can miss a cause.
    expect(Object.keys(await flushParked('before-scene')).sort())
      .toEqual(['dirtyAssetPaths', 'pendingImportSettings']);
    expect(Object.keys(await flushParked('after-scene')))
      .toEqual(['pendingBaseScenes']);
  });

  it('saveAll runs the before-scene phase, then the scene write, then the after-scene phase', () => {
    const code = readScannedSource(path.join(SRC, 'scene/serialize.ts')).code;
    const saveAllAt = code.indexOf('export async function saveAll(');
    expect(saveAllAt, 'saveAll was renamed — this guard cannot vouch for a function it cannot find')
      .toBeGreaterThan(-1);
    const body = code.slice(saveAllAt);

    const before = body.indexOf("await flushParked('before-scene')");
    const sceneWrite = body.indexOf('await saveScene(opts)');
    // ⚠️ The CALL, not the declaration. An earlier version of this guard matched the flush name,
    // which first appears inside `withBaseScenes`' body — so moving the AWAIT above `saveScene`,
    // the exact refactor this exists to catch, left it green. The declaration is checked too,
    // because a helper declared before the scene write reads as though it runs there.
    const afterCall = body.indexOf('await withBaseScenes()');
    const afterDecl = body.indexOf('const withBaseScenes =');
    for (const [label, at] of [
      ["flushParked('before-scene')", before], ['saveScene', sceneWrite],
      ['await withBaseScenes()', afterCall], ['const withBaseScenes =', afterDecl],
    ] as const) {
      expect(at, `saveAll no longer contains \`${label}\` — the ordering this guard asserts has no subject`).toBeGreaterThan(-1);
    }
    // …and the helper must actually run the after-scene phase, or the names above vouch for nothing.
    expect(body.slice(afterDecl, afterCall)).toContain("flushParked('after-scene')");
    expect(before).toBeLessThan(sceneWrite);
    expect(sceneWrite, 'the after-scene phase must be AWAITED after the scene write, or it 409s '
      + 'against the editor\'s own unsaved-work guard').toBeLessThan(afterCall);
    expect(sceneWrite, 'and declared after it too — a helper declared above the scene write reads '
      + 'as though it runs there').toBeLessThan(afterDecl);
  });

  it('the PREFAB-edit branch runs both phases too, and the after-scene one behind its own save', () => {
    // That branch returns before `saveAll`, so it needs its own flush — the same #259 reasoning it
    // already applies to parked ASSET docs: a base ref on a scene the editor never loaded has
    // nothing to do with which world is open. AFTER `savePrefabEdit` for the same reason as above:
    // the prefab world's unsaved edits are exactly what the route refuses on.
    const code = readScannedSource(path.join(SRC, 'scene/saveCommand.ts')).code;
    const branch = code.slice(code.indexOf('if (isEditingPrefab())'));
    const before = branch.indexOf("await flushParked('before-scene')");
    const prefabSave = branch.indexOf('await savePrefabEdit()');
    const after = branch.indexOf("await flushParked('after-scene')");
    expect(prefabSave, 'the prefab-edit branch no longer calls savePrefabEdit').toBeGreaterThan(-1);
    expect(before, 'the prefab-edit branch does not flush before-scene parked work').toBeGreaterThan(-1);
    expect(after, 'the prefab-edit branch does not flush pending base scenes — Cmd+S there '
      + 'leaves the edit pending and says nothing').toBeGreaterThan(-1);
    expect(before).toBeLessThan(prefabSave);
    expect(prefabSave).toBeLessThan(after);
  });

  it('the PREVIEW fast path flushes EVERY phase, not a hand-picked pair (#972 P12)', () => {
    // The defect this replaces: the branch named `flushDirtyAssets` and `flushPendingMeta` and
    // stopped, so a session with a preview live and ONLY a parked base-scene ref got
    // `{target:'assets'}` reporting success while the ref was never written. It writes no scene,
    // so both phases run here back to back — the order still holds, there is simply nothing
    // between them.
    const code = readScannedSource(path.join(SRC, 'scene/saveCommand.ts')).code;
    const at = code.indexOf('if (preview && !needsAuthoredWorld)');
    expect(at, 'the preview fast path was renamed — this guard has no subject').toBeGreaterThan(-1);
    const branch = code.slice(at, code.indexOf('if (preview && previewHasAuthoredEdits())'));
    const before = branch.indexOf("flushParked('before-scene')");
    const after = branch.indexOf("flushParked('after-scene')");
    expect(before, 'the preview fast path does not flush before-scene parked work').toBeGreaterThan(-1);
    expect(after, 'the preview fast path does not flush after-scene parked work — a parked '
      + 'base-scene ref is silently lost on Cmd+S under a preview (#972 P12)').toBeGreaterThan(-1);
    expect(before).toBeLessThan(after);
    // Non-vacuity: it must not have gone back to naming individual flushes.
    for (const named of ['flushDirtyAssets(', 'flushPendingMeta(', 'flushPendingBaseScenes(']) {
      expect(branch, `the fast path names \`${named}\` directly again — the set must be derived `
        + 'from the cause table, or it goes stale the next time a cause is added')
        .not.toContain(named);
    }
  });
});
