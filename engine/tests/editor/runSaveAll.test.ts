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
let handler: { owner: 'animation'; suspend: () => Promise<void>; resume: () => void } | null = null;

vi.mock('../../packages/modoki/src/editor/scene/serialize', () => ({
  saveAll: vi.fn(async () => { log.push('saveScene'); return { saved: true, path: '/s.json', reason: 'ok' }; }),
  unsavedChangeCauses: () => ({ sceneDirty, dirtyAssetPaths: [], dirtyScenes: [] }),
}));
vi.mock('../../packages/modoki/src/editor/scene/dirtyAssets', () => ({
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
vi.mock('../../packages/modoki/src/editor/scene/timelinePreview', () => ({
  hasTimelinePreviewSession: () => sessionHeld,
  getPreviewSaveHandler: () => handler,
  previewHasAuthoredEdits: () => authoredEdits,
  currentPreviewSaveHandlerFor: (o: string) => (handler?.owner === o ? handler : null),
}));

const { runSaveAll } = await import('../../packages/modoki/src/editor/scene/saveCommand');

function makeHandler(tag = 'A') {
  const h = {
    owner: 'animation' as const,
    suspend: vi.fn(async () => { log.push(`suspend:${tag}`); }),
    resume: vi.fn(() => { log.push(`resume:${tag}`); }),
  };
  return h;
}

beforeEach(() => { log.length = 0; sceneDirty = false; sessionHeld = false; authoredEdits = false; handler = null; });

describe('runSaveAll inside a preview envelope', () => {
  it('skips the scene half entirely when the scene has nothing to write', async () => {
    sessionHeld = true; handler = makeHandler();
    const out = await runSaveAll();

    expect(out.target).toBe('assets');
    expect(log).toEqual(['flushAssets']);            // no suspend, no scene write
    expect(handler!.suspend).not.toHaveBeenCalled(); // the preview is NOT interrupted
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
    const h = makeHandler();
    sessionHeld = true; sceneDirty = true; handler = h;
    h.suspend.mockImplementation(async () => { log.push('suspend:A'); handler = null; }); // panel closed

    const out = await runSaveAll();

    expect(out.previewResumed).toBe(false);
    expect(log).not.toContain('resume:A'); // resuming a dead panel would wedge run-mode at 'scrub'
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
