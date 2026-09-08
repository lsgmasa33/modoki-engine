/** `reloadEditingAsset` — the store action behind a refused asset editor's Retry button (#896).
 *
 *  ⚠️ **This exists because the UI half of #896 had no automated guard of any kind, and two defects
 *  shipped in it.** The panels are `.tsx`, which this repo deliberately does not mount
 *  (`docs/editor.md` § Panels — mounting asserts the mock, not the panel), so a Retry button's
 *  correctness is only testable at the seam BEHIND it. That seam is this action, and the property
 *  worth pinning is not "it reloads" but **what it must NOT touch**: `isPreviewPlaying`,
 *  `previewOwner` and `playheadTime` are shared between the Animation and Timeline panels, and the
 *  first cut of Retry went through `open<X>Editor`, which clobbers all three unconditionally — so
 *  clicking Retry in a refused Timeline stopped the Animation panel's running preview and snapped
 *  the shared playhead to 0. A re-read is not a re-open. */

import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../../src/editor/store/editorStore';

const ASSET = { path: '/assets/anims/walk.anim.json', type: 'animation' as const, name: 'walk' };

/** The fields an editor shares with its sibling panel — none of which a re-read may move. */
function sharedPreviewState() {
  const s = useEditorStore.getState();
  return { isPreviewPlaying: s.isPreviewPlaying, previewOwner: s.previewOwner, playheadTime: s.playheadTime };
}

describe('reloadEditingAsset', () => {
  beforeEach(() => {
    // ⚠️ ALL FIVE slots, not just the two these tests read. The store is a module-level singleton,
    // and the five-editor loop below leaves three of them bound — harmless only because it happens
    // to run last, and spuriously red the moment anyone appends a test after it.
    useEditorStore.setState({
      editingParticleAsset: null, editingParticleDef: null,
      editingSpriteAnimAsset: null, editingSpriteAnimDef: null,
      editingSkinAsset: null, editingSkinDef: null,
      editingAnimationAsset: null, editingAnimationClip: null,
      editingTimelineAsset: null, editingTimelineDoc: null,
      isPreviewPlaying: false, previewOwner: null, playheadTime: 0, isRecording: false,
    });
  });

  it('nulls the loaded document and bumps the nonce the load effect depends on', () => {
    useEditorStore.setState({
      editingAnimationAsset: ASSET,
      editingAnimationClip: { id: 'g', name: 'walk', duration: 1, frameRate: 60, loop: true, tracks: [] },
    });
    const before = useEditorStore.getState().animationEditNonce;

    useEditorStore.getState().reloadEditingAsset('editingAnimationAsset');

    const after = useEditorStore.getState();
    // Both halves matter: nulling the doc is what stops the load effect taking its `if (existing)`
    // early return (and adopting a document nobody read), and the nonce bump is what makes the
    // effect re-run at all. Either alone is not a re-read.
    expect(after.editingAnimationClip).toBeNull();
    expect(after.animationEditNonce).toBe(before + 1);
    expect(after.editingAnimationAsset).toBe(ASSET);   // still open — this is a re-READ, not a close
  });

  it('⚠️ leaves the SHARED preview state alone — the whole reason it is not `openAnimationEditor`', () => {
    // The concrete regression: Animation is previewing; Timeline (docked beside it) is refused; the
    // human clicks Retry on the Timeline.
    useEditorStore.setState({
      editingTimelineAsset: { path: '/assets/tl/intro.timeline.json', type: 'timeline', name: 'intro' },
      editingTimelineDoc: null,
      isPreviewPlaying: true, previewOwner: 'animation', playheadTime: 1.25,
    });
    const before = sharedPreviewState();

    useEditorStore.getState().reloadEditingAsset('editingTimelineAsset');

    expect(sharedPreviewState()).toEqual(before);
    expect(before).toEqual({ isPreviewPlaying: true, previewOwner: 'animation', playheadTime: 1.25 });
  });

  it('is a no-op when that editor is unbound — a stale Retry cannot conjure a reload', () => {
    const before = useEditorStore.getState().animationEditNonce;
    useEditorStore.getState().reloadEditingAsset('editingAnimationAsset');
    expect(useEditorStore.getState().animationEditNonce).toBe(before);
  });

  it('touches only its OWN editor — a Timeline retry does not reload the Animation panel', () => {
    const clip = { id: 'g', name: 'walk', duration: 1, frameRate: 60, loop: true, tracks: [] };
    useEditorStore.setState({
      editingAnimationAsset: ASSET, editingAnimationClip: clip,
      editingTimelineAsset: { path: '/assets/tl/intro.timeline.json', type: 'timeline', name: 'intro' },
    });
    const animNonce = useEditorStore.getState().animationEditNonce;

    useEditorStore.getState().reloadEditingAsset('editingTimelineAsset');

    const after = useEditorStore.getState();
    expect(after.editingAnimationClip).toBe(clip);
    expect(after.animationEditNonce).toBe(animNonce);
  });

  it('maps all five editors to distinct document and nonce slots', () => {
    // ⚠️ Scope, stated because the first version of this test over-claimed it ("so no panel is left
    // reaching for an open action instead"). This proves the TABLE, not the PANELS — and the two are
    // not the same claim: when it was written, all five rows existed and `ParticleEditor` reached for
    // neither the action nor an open action, so the table was complete and a panel was still broken.
    // The panel wiring is guarded by `tests/architecture/assetEditorRefusesUnreadableDoc.test.ts`,
    // which scans the source, because the panels are `.tsx` and this repo does not mount those.
    const cases = [
      ['editingParticleAsset', 'editingParticleDef', 'particleEditNonce'],
      ['editingSpriteAnimAsset', 'editingSpriteAnimDef', 'spriteAnimEditNonce'],
      ['editingSkinAsset', 'editingSkinDef', 'skinEditNonce'],
      ['editingAnimationAsset', 'editingAnimationClip', 'animationEditNonce'],
      ['editingTimelineAsset', 'editingTimelineDoc', 'timelineEditNonce'],
    ] as const;

    for (const [assetField, docField, nonceField] of cases) {
      useEditorStore.setState({ [assetField]: { path: `/a.${assetField}`, type: 'animation', name: 'x' }, [docField]: { id: 'g' } } as never);
      const before = useEditorStore.getState()[nonceField];

      useEditorStore.getState().reloadEditingAsset(assetField);

      const after = useEditorStore.getState();
      expect(after[docField], assetField).toBeNull();
      expect(after[nonceField], assetField).toBe(before + 1);
    }
  });
});
