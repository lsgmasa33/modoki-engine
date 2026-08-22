/**
 * Cmd+S inside a preview envelope must put the envelope BACK.
 *
 * The save cycle is `suspend()` → save → `resume()`. Resuming through the CURRENT registration is
 * right when a rebind replaced it, and returns nothing when the owner panel DEREGISTERED itself —
 * which is exactly what the Timeline panel does, because its registration effect is guarded on
 * being inside the envelope and `suspend()` is what leaves it. Measured on `games/timeline-demo`
 * (bug `tSv0EWjWICpEl9HSjRe9`, QA-TIMELINE-0007): the file was written correctly every time, and
 * `runMode` was left `"stopped"` with the world un-posed while the panel still displayed `t 4.00s`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setPreviewSaveHandler, clearPreviewSaveHandler, resumeHandlerFor,
  currentPreviewSaveHandlerFor, type PreviewSaveHandler,
} from '../../src/editor/scene/timelinePreview';

const handler = (
  owner: PreviewSaveHandler['owner'], tag: string, live = true,
): PreviewSaveHandler & { tag: string } => ({
  owner, tag,
  isLive: () => live,
  suspend: () => Promise.resolve(),
  resume: () => {},
});

describe('resumeHandlerFor', () => {
  beforeEach(() => {
    // Leave the registry empty between cases — it is module state.
    const cur = currentPreviewSaveHandlerFor('timeline') ?? currentPreviewSaveHandlerFor('animation');
    if (cur) clearPreviewSaveHandler(cur);
  });

  it('falls back to the pre-cycle handler when the suspend DEREGISTERED the owner', () => {
    // The reported case. Nothing is registered when the save finishes.
    const started = handler('timeline', 'started');
    setPreviewSaveHandler(started);
    clearPreviewSaveHandler(started);                 // what `suspend()` triggers via the effect teardown
    expect(currentPreviewSaveHandlerFor('timeline')).toBeNull();
    expect(resumeHandlerFor('timeline', started)).toBe(started);
  });

  it('prefers the CURRENT registration when a rebind replaced the handler', () => {
    // The pre-existing case this must not regress: the restore reassigns entity ids, the panel
    // re-resolves its root and re-registers, and the fresh handler is the one bound to it.
    const started = handler('timeline', 'started');
    const rebound = handler('timeline', 'rebound');
    setPreviewSaveHandler(started);
    setPreviewSaveHandler(rebound);
    expect(resumeHandlerFor('timeline', started)).toBe(rebound);
  });

  it('does not resume through the OTHER panel', () => {
    // The Animation panel registering during a Timeline cycle must not hijack the resume — that
    // would pose the wrong asset's root and is why the handler carries an owner tag at all.
    const started = handler('timeline', 'started');
    setPreviewSaveHandler(started);
    clearPreviewSaveHandler(started);
    setPreviewSaveHandler(handler('animation', 'other'));
    expect(resumeHandlerFor('timeline', started)).toBe(started);
  });

  it('returns NULL when the owner panel actually closed', () => {
    // The case the fallback must NOT swallow: resuming a panel that unmounted re-enters scrub
    // mode with nobody to drive it, wedging the run-mode with the world posed. `isLive` is the
    // only thing that distinguishes this from the deregistered case above — both present as
    // "the owner has no registration".
    const started = handler('timeline', 'started', /* live */ false);
    setPreviewSaveHandler(started);
    clearPreviewSaveHandler(started);
    expect(resumeHandlerFor('timeline', started)).toBeNull();
  });

  it('FAILS OPEN when isLive throws — a completed save must not be reported as failed', () => {
    // Found by the close-out review. This runs AFTER the scene has been written; a throw here
    // escapes runSaveAllOnce's try, is re-thrown by the SECOND call in its catch, and surfaces as
    // a failed save that actually succeeded — with the envelope left suspended forever. Exactly
    // the bug this function exists to fix, reopened through its own guard. Unreachable with
    // today's two ref-read implementations; `isLive` being an optional method on a public
    // interface is what invites it.
    const started: PreviewSaveHandler = {
      owner: 'timeline',
      isLive: () => { throw new Error('panel exploded'); },
      suspend: () => Promise.resolve(),
      resume: () => {},
    };
    expect(() => resumeHandlerFor('timeline', started)).not.toThrow();
    expect(resumeHandlerFor('timeline', started)).toBe(started);   // treated as alive
  });

  it('assumes a handler that does not answer isLive is alive', () => {
    // Optional field: a handler predating it keeps the replaced-handler behaviour rather than
    // silently losing its resume.
    const started: PreviewSaveHandler = { owner: 'animation', suspend: () => Promise.resolve(), resume: () => {} };
    expect(resumeHandlerFor('animation', started)).toBe(started);
  });

  it('prefers a live CURRENT registration even when the captured one says it is dead', () => {
    // Ordering: the panel remounting and re-registering is the strongest evidence there is.
    const started = handler('timeline', 'started', /* live */ false);
    const fresh = handler('timeline', 'fresh');
    setPreviewSaveHandler(fresh);
    expect(resumeHandlerFor('timeline', started)).toBe(fresh);
  });
});
