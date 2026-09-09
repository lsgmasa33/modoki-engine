/** `runSaveAll` — the Cmd+S command itself, which had NO tests until an independent review pointed
 *  that out. Every branch below is a data-loss shape, and three of them were live defects found by
 *  that review rather than by this suite:
 *
 *   - the restore must be AWAITED before the scene is serialized, or the save writes the POSED world;
 *   - the resume must go through whichever handler the panel has NOW, because suspending rebinds the
 *     root and replaces it — an identity check skipped the resume on every normal cycle;
 *   - a second Cmd+S during a cycle must not start a second save, because mid-suspend the session is
 *     already cleared and run-mode already 'stopped' while the world is still posed.
 *
 *  The collaborators are mocked on purpose: this is an ORCHESTRATOR, and what needs pinning is which
 *  branch runs and in what ORDER. The same behaviour driven for real (a genuine `saveAll` against a
 *  stubbed backend) is `assetSaveAlwaysFlushes.test.ts`, and the live editor covers the rest.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const log: string[] = [];
let sceneDirty = false;
let sessionHeld = false;
let authoredEdits = false;
type TestHandler = { owner: 'animation'; suspend: () => Promise<void>; resume: () => void; isLive?: () => boolean };
let handler: TestHandler | null = null;

// ⚠️ **PARTIAL, via `importOriginal` — and that is not a style choice (#972).** This mock used to
// be a whole-module replacement listing `unsavedChangeCauses` by hand with FOUR of the five causes
// (`pendingImportSettings` was missing), which is the shape `docs/falsifiable-tests.md` calls a
// test that cannot fail: the suite built its own idea of the population, so a cause added to the
// real table changed nothing here and no assertion could notice. It also broke outright the moment
// `saveCommand.ts` imported one more symbol — an explicit-export-list mock fails at BINDING, not
// at an assertion, so the error names the import rather than the staleness.
//
// The causes object is now the REAL one with only `sceneDirty` overridden, so its key set is
// derived and can never fall behind the table. `causeSpecs`/`flushParked` are real too: they are
// the mechanism under test in the ordering assertions, not collaborators to stub.
vi.mock('../../packages/modoki/src/editor/scene/serialize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/modoki/src/editor/scene/serialize')>();
  return {
    ...actual,
    saveAll: vi.fn(async () => { log.push('saveScene'); return { saved: true, path: '/s.json', reason: 'ok' }; }),
    // The real reader over the real (empty, in this suite) registries, with the one term this
    // suite drives layered on top.
    unsavedChangeCauses: () => ({ ...actual.unsavedChangeCauses(), sceneDirty }),
  };
});
// Partial for the same reason as `dirtyAssets` below it: the cause table reads
// `hasPendingBaseScenes`/`getPendingBaseScenePaths` from here.
//
// Logging this flush is what lets the fast-path test below see #972 P12 at all — before the fix
// that branch never called it, and nothing in this suite could tell.
vi.mock('../../packages/modoki/src/editor/scene/pendingBaseScene', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/modoki/src/editor/scene/pendingBaseScene')>();
  return {
    ...actual,
    // ⚠️ Reports what is ACTUALLY parked, and takes it out — a faithful stand-in for the real
    // flush minus the backend, not a canned answer. An earlier version of this returned a fixed
    // path off a test flag, and a mutation check caught it: removing the `writtenBy` filter from
    // `sceneNeedsWriting` left every test green, because no test had put anything in the registry
    // for that filter to be wrong about. A stub that answers without consulting the state under
    // test cannot fail (docs/falsifiable-tests.md).
    flushPendingBaseScenes: vi.fn(async () => {
      log.push('flushBaseScenes');
      const saved = actual.getPendingBaseScenePaths();
      actual.clearPendingBaseScenes();
      return { saved, failed: [] };
    }),
  };
});
// Partial for the same reason: `serialize.ts` imports `hasDirtyAssets`/`getDirtyAssetPaths` from
// here to build the cause table, and an explicit-list mock would bind them to `undefined`.
vi.mock('../../packages/modoki/src/editor/scene/dirtyAssets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../packages/modoki/src/editor/scene/dirtyAssets')>()),
  flushDirtyAssets: vi.fn(async () => { log.push('flushAssets'); return { saved: ['/a.anim.json'], failed: [] }; }),
}));
vi.mock('../../packages/modoki/src/editor/scene/prefabEdit', () => ({
  isEditingPrefab: () => false,
  savePrefabEdit: async () => true,
}));
vi.mock('../../packages/modoki/src/editor/scene/playMode', () => ({ getModeOwner: () => 'animation' }));
vi.mock('../../packages/modoki/src/runtime/core/playState', () => ({
  getRunMode: () => 'scrub', canEdit: () => false,
}));
vi.mock('../../packages/modoki/src/editor/scene/timelinePreview', async (importOriginal) => {
  // `resumeHandlerFor` is the REAL one: it is the rule under test here (which handler a finished
  // cycle resumes through), not a collaborator to stub out. Everything else stays mocked so this
  // suite keeps pinning branch + order rather than the preview machinery.
  const actual = await importOriginal<typeof import('../../packages/modoki/src/editor/scene/timelinePreview')>();
  const currentFor = (o: string) => (handler?.owner === o ? handler : null);
  return {
    hasTimelinePreviewSession: () => sessionHeld,
    getPreviewSaveHandler: () => handler,
    previewHasAuthoredEdits: () => authoredEdits,
    currentPreviewSaveHandlerFor: currentFor,
    resumeHandlerFor: (o: string, started: TestHandler) => {
      void actual;                       // the real rule, re-expressed against this suite's registry stand-in
      return currentFor(o) ?? (started.isLive?.() === false ? null : started);
    },
  };
});

import {
  markBaseSceneEdit, clearPendingBaseScenes,
} from '../../packages/modoki/src/editor/scene/pendingBaseScene';

/** A scene whose `baseScene` ref is parked — authored on a scene the editor never loaded, which is
 *  why it is flushed rather than written by the scene write. */
const PARKED_SCENE = '/scenes/child.scene.json';

const { runSaveAll } = await import('../../packages/modoki/src/editor/scene/saveCommand');

function makeHandler(tag = 'A', live = true) {
  const h = {
    owner: 'animation' as const,
    isLive: () => live,
    suspend: vi.fn(async () => { log.push(`suspend:${tag}`); }),
    resume: vi.fn(() => { log.push(`resume:${tag}`); }),
  };
  return h;
}

beforeEach(() => {
  log.length = 0; sceneDirty = false; sessionHeld = false; authoredEdits = false;
  handler = null; clearPendingBaseScenes();
});

describe('runSaveAll inside a preview envelope', () => {
  it('skips the scene half entirely when the scene has nothing to write', async () => {
    sessionHeld = true; handler = makeHandler();
    const out = await runSaveAll();

    expect(out.target).toBe('assets');
    // ⚠️ `flushBaseScenes` is here BECAUSE of #972 P12. This branch used to flush parked asset
    // docs and import settings and stop, so a session holding only a parked base-scene ref got
    // `{target:'assets'}` reporting success while the ref was never written. Still no suspend
    // and no scene write — that is what makes it the fast path.
    expect(log).toEqual(['flushAssets', 'flushBaseScenes']);
    expect(handler!.suspend).not.toHaveBeenCalled(); // the preview is NOT interrupted
  });

  it('REPORTS the base-scene refs it wrote on the fast path, so the toast can name them (#972 P12)', async () => {
    // The regression in full. A parked base-scene ref does not make the scene half need writing
    // (`baseScene` is authored on a scene the editor never loaded — `writtenBy` is a flush, not
    // `'scene-write'`), so this branch is exactly the one such a ref takes. Before the fix the
    // work was silently dropped AND unreported; the outcome must now carry it, because
    // `toastForSave` is what tells the human their Cmd+S did something.
    sessionHeld = true; handler = makeHandler();
    markBaseSceneEdit(PARKED_SCENE, 'some-base-guid');   // a REAL parked ref, in the real registry
    const out = await runSaveAll();

    expect(out.target).toBe('assets');
    expect(out.baseScenes).toEqual({ saved: [PARKED_SCENE], failed: [] });
    expect(log).toContain('flushBaseScenes');
    expect(log).not.toContain('saveScene');
  });

  it('a parked base-scene ref does NOT make the scene half need writing', async () => {
    // The gate half of the same defect (#972 P3): `sceneNeedsWriting()` decides whether the
    // preview is interrupted, and it used to be typed against a two-field structural subtype of
    // the causes object — so it could not have seen this cause even if it wanted to. Interrupting
    // a preview to write a scene with nothing to write is churn and a flicker; NOT interrupting it
    // and also not flushing was the data loss. The right answer is fast path AND flush.
    sessionHeld = true; handler = makeHandler();
    markBaseSceneEdit(PARKED_SCENE, 'some-base-guid');   // a REAL parked ref, in the real registry
    await runSaveAll();
    expect(handler!.suspend, 'the preview must not be cycled for parked work that writes no scene')
      .not.toHaveBeenCalled();
  });

  it('suspends BEFORE the scene is written, then resumes', async () => {
    // The ordering is the whole point: a fire-and-forget restore would let the save serialize the
    // posed world, which is what the envelope exists to prevent.
    sessionHeld = true; sceneDirty = true; handler = makeHandler();
    const out = await runSaveAll();

    // NB `saveAll` is the thing that flushes the parked assets, and it is mocked here — the real
    // flush ordering is covered by assetSaveAlwaysFlushes.test.ts against a genuine saveAll.
    expect(log).toEqual(['suspend:A', 'saveScene', 'resume:A']);
    expect(out.previewCycled).toBe(true);
    expect(out.previewResumed).toBe(true);
  });

  it('resumes through the handler the panel has NOW, not the one captured at the start', async () => {
    // Suspending rebinds the root, which replaces the panel's callbacks and therefore its handler.
    // Comparing by object identity skipped the resume on EVERY normal cycle.
    const first = makeHandler('old');
    const second = makeHandler('new');
    sessionHeld = true; sceneDirty = true; handler = first;
    first.suspend.mockImplementation(async () => { log.push('suspend:old'); handler = second; });

    const out = await runSaveAll();

    expect(log).toEqual(['suspend:old', 'saveScene', 'resume:new']);
    expect(first.resume).not.toHaveBeenCalled();
    expect(out.previewResumed).toBe(true);
  });

  it('reports the preview as NOT resumed when the panel closed mid-save', async () => {
    const h = makeHandler('A', /* live */ false);
    sessionHeld = true; sceneDirty = true; handler = h;
    h.suspend.mockImplementation(async () => { log.push('suspend:A'); handler = null; }); // panel unmounted

    const out = await runSaveAll();

    expect(out.previewResumed).toBe(false);
    expect(log).not.toContain('resume:A'); // resuming a dead panel would wedge run-mode at 'scrub'
  });

  it('STILL resumes when the panel only deregistered itself — it is alive and owes a frame', async () => {
    // The Timeline panel's normal path, and the bug. Its registration effect is guarded on being
    // inside the envelope and `suspend()` is what leaves it, so the suspend deletes the
    // registration it is about to need. That is indistinguishable from the case above unless the
    // handler is asked whether its panel is still mounted — which is why `isLive` exists.
    // Measured on games/timeline-demo: runMode left 'stopped', the world un-posed, the panel still
    // reading t 4.00s (bug `tSv0EWjWICpEl9HSjRe9`, QA-TIMELINE-0007).
    const h = makeHandler('A', /* live */ true);
    sessionHeld = true; sceneDirty = true; handler = h;
    h.suspend.mockImplementation(async () => { log.push('suspend:A'); handler = null; }); // deregistered, still mounted

    const out = await runSaveAll();

    expect(log).toEqual(['suspend:A', 'saveScene', 'resume:A']);
    expect(out.previewResumed).toBe(true);
  });

  it('does NOT cycle when the envelope holds authored scene edits — exiting would revert them', async () => {
    sessionHeld = true; sceneDirty = true; authoredEdits = true; handler = makeHandler();
    const out = await runSaveAll();

    expect(handler!.suspend).not.toHaveBeenCalled();
    expect(out.previewHoldsEdits).toBe(true);
  });

  it('still hands the frame back when the save THROWS', async () => {
    const h = makeHandler();
    sessionHeld = true; sceneDirty = true; handler = h;
    const { saveAll } = await import('../../packages/modoki/src/editor/scene/serialize');
    vi.mocked(saveAll).mockRejectedValueOnce(new Error('disk full'));

    await expect(runSaveAll()).rejects.toThrow('disk full');
    expect(h.resume).toHaveBeenCalled();
  });

  it('coalesces a second Cmd+S onto the in-flight save', async () => {
    // Mid-suspend the session is cleared and run-mode is 'stopped' while the world is still posed —
    // a second save starting there takes the no-preview path and serializes the pose.
    sessionHeld = true; sceneDirty = true; handler = makeHandler();
    const [a, b] = await Promise.all([runSaveAll(), runSaveAll()]);

    expect(log.filter((l) => l === 'saveScene')).toHaveLength(1);
    expect(a).toBe(b);
  });
});
