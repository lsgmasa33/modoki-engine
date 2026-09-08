/** Guard: `Scene2D.renderFrame()` drains its two deferred-GPU-teardown queues BEFORE the
 *  idle whole-frame skip.
 *
 *  `flushPendingMaskDestroy()` (#455) and `flushPendingVideoDestroy2D(this)` (#476) both exist
 *  because a GPU resource (a mask ramp texture, a pinned video decoder) can be queued for
 *  teardown right as the sim goes idle. If either flush call is missing, or sits BELOW the
 *  `!isSimRunning() && !this._externalDirty && ...` early return, the queued resource is
 *  stranded — held past the idle skip until the surface itself tears down, instead of being
 *  freed on the very next frame.
 *
 *  MEASURED (#476 follow-up): deleting the `flushPendingVideoDestroy2D(this)` call fails NO
 *  existing test — `tests/video/videoTextureSync2D.test.ts` and `tests/runtime/Scene2D.test.ts`
 *  call the flush directly, which proves the module works, not that `renderFrame` wires it in
 *  at the right point. A behavioural test at this seam would need `videoSystem`/`isSimRunning`/
 *  HTMLVideoElement scaffolding the existing suite doesn't have, so this is a source-level guard
 *  instead — cheap, and it fails with a message that names the consequence rather than sending a
 *  future reader to git archaeology. */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';

const SCENE2D_PATH = path.resolve(
  __dirname,
  '../../packages/modoki/src/runtime/rendering/Scene2D.tsx',
);
const src = readScannedSource(SCENE2D_PATH).code;

// Scope to renderFrame()'s body: from its declaration to the next top-level method
// (`private flushPendingMaskDestroy` and friends are earlier in the file, so anchor on the
// distinctive `renderFrame() {` signature and cut off before the next sibling method begins).
const RENDER_FRAME_START = src.indexOf('renderFrame() {');
const RENDER_FRAME_NEXT_METHOD = src.indexOf('\n  private ', RENDER_FRAME_START);
const renderFrameBody =
  RENDER_FRAME_START >= 0 && RENDER_FRAME_NEXT_METHOD > RENDER_FRAME_START
    ? src.slice(RENDER_FRAME_START, RENDER_FRAME_NEXT_METHOD)
    : '';

describe('Scene2D.renderFrame() drains both deferred-destroy queues before the idle skip (#455, #476)', () => {
  it('locates renderFrame() at all', () => {
    expect(
      RENDER_FRAME_START,
      'could not find `renderFrame() {` in Scene2D.tsx — the method was renamed or restructured; '
      + 'update this guard to match, and re-verify the ordering it checks still holds.',
    ).toBeGreaterThanOrEqual(0);
    expect(
      renderFrameBody.length,
      'could not bound renderFrame()\'s body (no following `private ` method found) — '
      + 'update the scoping in this guard rather than widening the search to the whole file.',
    ).toBeGreaterThan(0);
  });

  const maskFlushIdx = renderFrameBody.indexOf('this.flushPendingMaskDestroy()');
  const videoFlushIdx = renderFrameBody.indexOf('flushPendingVideoDestroy2D(this)');
  const idleSkipIdx = renderFrameBody.indexOf('!isSimRunning() && !this._externalDirty');
  const midPassVideoSyncIdx = renderFrameBody.indexOf('syncVideoTextures2D(');

  it('calls this.flushPendingMaskDestroy() (#455)', () => {
    expect(
      maskFlushIdx,
      'renderFrame() no longer calls this.flushPendingMaskDestroy() — a mask ramp texture queued '
      + 'for teardown by the previous frame is now stranded until the surface tears down (#455).',
    ).toBeGreaterThanOrEqual(0);
  });

  it('calls flushPendingVideoDestroy2D(this) (#476)', () => {
    expect(
      videoFlushIdx,
      'renderFrame() no longer calls flushPendingVideoDestroy2D(this) — a video texture/decoder '
      + 'queued for teardown by the previous frame is now stranded (a pinned decoder, a leaked GPU '
      + 'texture) until the surface tears down (#476 follow-up to #455).',
    ).toBeGreaterThanOrEqual(0);
  });

  it('locates the idle whole-frame skip', () => {
    expect(
      idleSkipIdx,
      'could not find the idle-skip condition (`!isSimRunning() && !this._externalDirty`) in '
      + 'renderFrame() — it was reworded; update this guard to match the new condition text.',
    ).toBeGreaterThanOrEqual(0);
  });

  it('both flush calls happen BEFORE the idle whole-frame skip (#455, #476)', () => {
    expect(
      maskFlushIdx >= 0 && idleSkipIdx >= 0 && maskFlushIdx < idleSkipIdx,
      'this.flushPendingMaskDestroy() must run before the idle-skip `return` — moved below it, a '
      + 'mask ramp texture queued for teardown right as the sim goes idle is stranded until the '
      + 'surface tears down instead of being freed on the very next frame (#455).',
    ).toBe(true);
    expect(
      videoFlushIdx >= 0 && idleSkipIdx >= 0 && videoFlushIdx < idleSkipIdx,
      'flushPendingVideoDestroy2D(this) must run before the idle-skip `return` — moved below it, a '
      + 'pinned video decoder / GPU texture queued for teardown right as the sim goes idle is '
      + 'stranded until the surface tears down instead of being freed on the very next frame '
      + '(#476 follow-up to #455).',
    ).toBe(true);
  });

  it('both flush calls happen before the mid-pass syncVideoTextures2D( call site', () => {
    expect(
      midPassVideoSyncIdx,
      'could not find a syncVideoTextures2D( call inside renderFrame() — it was renamed or moved; '
      + 'update this guard to match.',
    ).toBeGreaterThanOrEqual(0);
    expect(
      maskFlushIdx >= 0 && maskFlushIdx < midPassVideoSyncIdx,
      'this.flushPendingMaskDestroy() must run before the mid-pass syncVideoTextures2D( call — '
      + 'otherwise a future refactor could quietly make the top-of-frame flush redundant, then '
      + 'delete it, re-opening the #455 idle-skip stranding.',
    ).toBe(true);
    expect(
      videoFlushIdx >= 0 && videoFlushIdx < midPassVideoSyncIdx,
      'flushPendingVideoDestroy2D(this) must run before the mid-pass syncVideoTextures2D( call — '
      + 'otherwise a future refactor could quietly make the top-of-frame flush redundant, then '
      + 'delete it, re-opening the #476 idle-skip stranding.',
    ).toBe(true);
  });

  it('no early return sits above either flush call (an ordering check alone can\'t catch this)', () => {
    // Checking flush-before-idle-skip by source POSITION alone has a hole: an early `return`
    // inserted ABOVE both flush calls would strand the queues exactly the way moving the flush
    // below the idle skip does, while still leaving maskFlushIdx/videoFlushIdx < idleSkipIdx true.
    // So also scan the leading slice of the body — start of renderFrame() up to the LATER of the
    // two flush calls — for any `return` statement.
    const lastFlushIdx = Math.max(maskFlushIdx, videoFlushIdx);
    expect(lastFlushIdx, 'both flush call indices must have been found above').toBeGreaterThanOrEqual(0);
    const leadingSlice = renderFrameBody.slice(0, lastFlushIdx);
    const earlyReturnMatch = leadingSlice.match(/\breturn\b/);
    expect(
      earlyReturnMatch,
      'found a `return` above the flush calls in renderFrame() — an early return inserted above '
      + 'the flushes strands a queued GPU resource exactly as moving the flush below the idle skip '
      + 'would (#455, #476): the ordering checks above would still pass because they only compare '
      + 'source positions, not reachability.',
    ).toBeNull();
  });
});
