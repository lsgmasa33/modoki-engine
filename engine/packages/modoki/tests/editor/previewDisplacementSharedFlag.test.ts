/** Confirms the #810 follow-up regression is REAL before fixing it (coordinator ask): with both
 *  TimelineEditor and AnimationEditor docked, `isPreviewPlaying` is ONE store flag shared by both
 *  panels' preview effects (`TimelineEditor.tsx` / `AnimationEditor.tsx`, both
 *  `useEditorStore((s) => s.isPreviewPlaying)`). A displaced-owner callback that "stops its own
 *  preview" by calling `setPreviewPlaying(false)` does not stop ITS OWN loop — it stops BOTH,
 *  because both panels' preview effects are keyed on that one flag.
 *
 *  This exercises the REAL `playMode.ts` mode-owner registry and the REAL editor store — the
 *  same two modules both panels actually call into — with the two panels' relevant call
 *  sequences modeled inline (Animation enters synchronously with no async gap; Timeline's own
 *  entry is gated behind an awaited `beginTimelinePreviewSession()`, so it lands one microtask
 *  later — see `TimelineEditor.tsx`'s preview effect). The displaced-callback body below is the
 *  ORIGINAL (buggy) one-liner from the first #810 pass, before the follow-up fix replaced it with
 *  a per-panel `previewLoopGuard`. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { setRunMode } from '../../src/runtime/core/playState';
import { enterPreviewMode, enterScrubMode, getModeOwner, registerModeOwnerDisplaced } from '../../src/editor/scene/playMode';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { createPreviewLoopGuard } from '../../src/editor/panels/previewLoopGuard';

afterEach(() => { setRunMode('stopped'); });

describe('#810 follow-up: displacement must not touch the SHARED isPreviewPlaying flag', () => {
  it('reproduces the regression: the buggy displaced-callback body stops BOTH panels off one ▶ press', async () => {
    setRunMode('stopped');
    useEditorStore.getState().setPreviewPlaying(false);

    // The buggy callback body from the first #810 pass — kept here verbatim (not as production
    // code, both panels have since been fixed) purely to prove the MECHANISM is what broke it.
    const buggyDisplacedCallback = () => { useEditorStore.getState().setPreviewPlaying(false); };
    const unregister = registerModeOwnerDisplaced('animation', buggyDisplacedCallback);

    // ▶ pressed: the shared flag flips true, both panels' preview effects fire.
    useEditorStore.getState().setPreviewPlaying(true);

    // Animation's effect body runs SYNCHRONOUSLY (no await before its `enterPreviewMode` call).
    enterPreviewMode(true, 'animation');
    expect(useEditorStore.getState().isPreviewPlaying).toBe(true); // still true — nothing displaced it yet

    // Timeline's effect body awaits `beginTimelinePreviewSession()` first, so its own
    // `enterPreviewMode` call lands one microtask later.
    await Promise.resolve();
    enterPreviewMode(true, 'timeline'); // displaces 'animation' → its callback fires

    // THE BUG: Timeline just took over and is still legitimately previewing, but the shared flag
    // reads false — Animation's displaced callback stopped BOTH panels, including the one that
    // just started.
    expect(useEditorStore.getState().isPreviewPlaying).toBe(false);

    unregister();
  });
});

describe('#810 follow-up: the CORRECTED pattern (previewLoopGuard) does not touch the flag', () => {
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextId: number;

  beforeEach(() => {
    rafCallbacks = new Map();
    nextId = 1;
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
      const id = nextId++;
      rafCallbacks.set(id, fn);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { rafCallbacks.delete(id); });
  });

  afterEach(() => { vi.unstubAllGlobals(); setRunMode('stopped'); });

  it('▶ in the ANIMATION panel keeps playing in the Animation panel, with the Timeline docked', async () => {
    // The regression the previous version of this test certified as CORRECT. It asserted the
    // Animation guard was stopped, which is true and beside the point: it never modelled WHICH
    // panel the ▶ came from, so it passed whether playback worked or not. The Timeline ALWAYS
    // lands second (its entry sits behind an await), so it always won `_modeOwner` and always
    // stopped Animation's loop -- and with no timeline doc open the Timeline's own tick
    // early-returns every frame, so pressing ▶ in the Animation panel played NOTHING.
    setRunMode('stopped');
    useEditorStore.getState().setPreviewPlaying(false);

    const animationGuard = createPreviewLoopGuard();
    const unregister = registerModeOwnerDisplaced('animation', () => { animationGuard.stop(); });

    // ▶ pressed in the ANIMATION panel — it claims the preview.
    useEditorStore.getState().setPreviewPlaying(true, 'animation');
    animationGuard.arm(requestAnimationFrame(() => {}));
    enterPreviewMode(true, 'animation');

    // The Timeline panel is docked and its effect fires on the same flag flip — but it now returns
    // at `previewOwner && previewOwner !== 'timeline'` before taking the mode. Modelled by simply
    // NOT calling enterPreviewMode for 'timeline', which is exactly what that guard produces.
    await Promise.resolve();
    const owner = useEditorStore.getState().previewOwner;
    expect(owner).toBe('animation');

    expect(animationGuard.stopped).toBe(false);   // the Animation panel is still playing
    expect(getModeOwner()).toBe('animation');     // and still owns the run mode
    expect(useEditorStore.getState().isPreviewPlaying).toBe(true);

    unregister();
  });

  it('a genuine cross-panel takeover still displaces: a Timeline scrub stops the Animation loop, flag intact', async () => {
    // Displacement must still WORK — this is the case #810 exists for, as distinct from the two
    // panels racing off one ▶ press above. Here Animation owns a live preview and the user drags
    // the Timeline's ruler, which is a real transfer of a single-valued RunMode.
    setRunMode('stopped');
    useEditorStore.getState().setPreviewPlaying(false);

    const animationGuard = createPreviewLoopGuard();
    const unregister = registerModeOwnerDisplaced('animation', () => { animationGuard.stop(); });

    useEditorStore.getState().setPreviewPlaying(true, 'animation');
    animationGuard.arm(requestAnimationFrame(() => {}));
    enterPreviewMode(true, 'animation');
    expect(animationGuard.stopped).toBe(false);

    enterScrubMode('timeline'); // the ruler drag — a real takeover, not a shared-flag race

    expect(animationGuard.stopped).toBe(true);                          // told it lost the mode
    expect(getModeOwner()).toBe('timeline');
    expect(useEditorStore.getState().isPreviewPlaying).toBe(true);      // shared flag untouched

    unregister();
  });
});
