/** #1000 — who may release Pixi's process-global resource pools.
 *
 *  The mechanism under test is one boolean handed to `Application.destroy`, so these assert on the
 *  options object our code builds. What they CANNOT assert is that Pixi honours it — that is a
 *  claim about pixi's own source — `AbstractRenderer.destroy`'s
 *  `options === true || (typeof options === 'object' && options.releaseGlobalResources)` test, and
 *  `ViewSystem.destroy`'s boolean-or-object resolution of `removeView` — read rather than executed,
 *  and a mock that modelled it would only be asserting itself. Cited by SYMBOL, not by line: a
 *  dependency's line numbers move on every bump and nothing watches them (#966).
 *
 *  The cross-surface behaviour lives in `canvas2DPool.test.ts` (two pools, per the #828 rule). This
 *  file covers the counting contract those tests rest on. */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  notePixiApplicationCreated,
  destroyPixiApplication,
  livePixiApplicationCount,
  releasePixiGlobalsIfIdle,
  __resetPixiApplicationTrackingForTest,
} from '../../src/runtime/rendering/pixiGlobalResources';
import { GlobalResourceRegistry } from 'pixi.js';

const fakeApp = () => ({ destroy: vi.fn() } as any);

// `restoreAllMocks` is not optional here: the `GlobalResourceRegistry.release` spy below is on a
// MODULE singleton, so without it one test's call count leaks into the next and a
// `not.toHaveBeenCalled()` reads the previous test's call. (It did — caught on first run.)
beforeEach(() => { vi.restoreAllMocks(); __resetPixiApplicationTrackingForTest(); });

describe('pixiGlobalResources (#1000)', () => {
  it('releases the pools for a lone Application', () => {
    const release = notePixiApplicationCreated();
    const app = fakeApp();
    destroyPixiApplication(app, release);
    expect(app.destroy).toHaveBeenCalledWith({ removeView: true, releaseGlobalResources: true });
  });

  it('withholds the release while another Application is live', () => {
    const r1 = notePixiApplicationCreated();
    notePixiApplicationCreated();          // a second surface, still live
    const app = fakeApp();
    destroyPixiApplication(app, r1);
    expect(app.destroy.mock.calls[0][0].releaseGlobalResources).toBe(false);
  });

  it('honours removeView: false so a rebuild keeps its mounted canvas', () => {
    const r = notePixiApplicationCreated();
    const app = fakeApp();
    destroyPixiApplication(app, r, { removeView: false });
    expect(app.destroy.mock.calls[0][0].removeView).toBe(false);
  });

  // ⚠️ The teardown paths are documented as idempotent (`ShaderPreview`'s `teardown` can run from
  // BOTH a context loss and an unmount; `canvas2DPool` clears `slot.releasePixiApp` but a caller
  // could still re-enter). A deregister that decremented twice would drive the count below the
  // number of live Applications and hand the NEXT teardown a release it must not perform — i.e.
  // the original defect, restored through the fix's own back door.
  it('deregister is one-shot, so a teardown running twice cannot under-count', () => {
    const r1 = notePixiApplicationCreated();
    notePixiApplicationCreated();          // one other surface stays live throughout
    r1(); r1(); r1();
    expect(livePixiApplicationCount()).toBe(1);
    const app = fakeApp();
    destroyPixiApplication(app, r1);
    expect(app.destroy.mock.calls[0][0].releaseGlobalResources).toBe(false);
  });

  // The orphaned-init path in `canvas2DPool.initSlotApp`: the Application finished `init()` but
  // bailed before it was registered, so there is nothing to hand back. It must not decrement —
  // that would borrow another surface's registration and release the pools underneath it.
  it('a null deregister does not decrement, so an unregistered Application cannot steal a slot', () => {
    notePixiApplicationCreated();          // one live surface
    const app = fakeApp();
    destroyPixiApplication(app, null);
    expect(app.destroy.mock.calls[0][0].releaseGlobalResources).toBe(false);
    expect(livePixiApplicationCount()).toBe(1);
  });

  it('an unregistered Application DOES release when nothing else is live', () => {
    const app = fakeApp();
    destroyPixiApplication(app, undefined);
    expect(app.destroy.mock.calls[0][0].releaseGlobalResources).toBe(true);
  });

  // ── mayReleaseGlobals, and the deferral it creates ──
  //
  // ⚠️ `mayReleaseGlobals: false` DEFERS a release rather than cancelling one. `rebuildSlotApp` is
  // the only caller, and it suppresses the sweep on the assumption that a replacement Application
  // is coming. When every bring-up rejects, none does — so the deferral has to be redeemable, or
  // the pools are retained for the process lifetime on a device that just failed to bring a
  // renderer back up. Found in review; nothing pinned it at the helper level.
  describe('mayReleaseGlobals (a rebuild is not a terminal teardown)', () => {
    it('suppresses the release even when this is the last live Application', () => {
      const r = notePixiApplicationCreated();
      const app = fakeApp();
      destroyPixiApplication(app, r, { mayReleaseGlobals: false });
      expect(app.destroy.mock.calls[0][0].releaseGlobalResources).toBe(false);
      expect(livePixiApplicationCount(), 'and it still hands the registration back').toBe(0);
    });

    it('releasePixiGlobalsIfIdle redeems that deferral', () => {
      const spy = vi.spyOn(GlobalResourceRegistry, 'release').mockImplementation(() => {});
      const r = notePixiApplicationCreated();
      destroyPixiApplication(fakeApp(), r, { mayReleaseGlobals: false });
      releasePixiGlobalsIfIdle();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('and does NOTHING while another Application is still live', () => {
      const spy = vi.spyOn(GlobalResourceRegistry, 'release').mockImplementation(() => {});
      const r = notePixiApplicationCreated();
      notePixiApplicationCreated();          // a second surface stays live
      destroyPixiApplication(fakeApp(), r, { mayReleaseGlobals: false });
      releasePixiGlobalsIfIdle();
      expect(spy, 'releasing here would sweep the live surface\'s pools — the original defect').not.toHaveBeenCalled();
    });
  });
});
