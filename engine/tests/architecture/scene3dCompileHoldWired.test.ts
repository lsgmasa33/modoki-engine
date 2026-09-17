/** `Scene3D` is wired to the #1246 compile holds the way their tests assume.
 *
 *  Each mechanism is tested where it lives — `borrowRendererTarget` in `precompileSession.test.ts`,
 *  the overlay renewal in `heldFramePaintWait.test.ts`, the gate's `onKick` in
 *  `liveCompileGate.test.ts`. What those suites cannot see is whether production CONSULTS them, and
 *  the close-out review showed nothing did: deleting the frame loop's borrow guard, or either gate's
 *  `onKick`, left every test green. The guard it drops is the GPU-process crash on an iPad mini 5 (a
 *  frame drawn into a scene-pass compile's bound target); the `onKick` it drops lifts the loading
 *  overlay over held frames.
 *
 *  A source scan rather than a mount, for the reason `viewportBringUpWired.test.ts` gives: `Scene3D`
 *  is a component, and mounting one in jsdom asserts the mock. Read through the shared scanner, so a
 *  mention in a comment cannot satisfy it; whitespace-collapsed, so a reflow cannot red it.
 */

import { describe, it, expect } from 'vitest';
import { expectInOrder } from '@modoki/engine/testing/inOrder';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCENE3D = 'engine/packages/modoki/src/runtime/rendering/Scene3D.tsx';
const code = readScannedSource(path.join(repoRoot, SCENE3D)).code.replace(/\s+/g, ' ');
const occurrences = (needle: string) => code.split(needle).length - 1;

/** The body of the frame loop — from its declaration to the paint mark that ends a submitted frame. */
function between(startNeedle: string, endNeedle: string): string {
  const start = code.indexOf(startNeedle);
  expect(start, `${SCENE3D} no longer contains ${startNeedle}`).toBeGreaterThanOrEqual(0);
  const end = code.indexOf(endNeedle, start);
  expect(end, `${SCENE3D} no longer contains ${endNeedle} after ${startNeedle}`).toBeGreaterThanOrEqual(0);
  return code.slice(start, end + endNeedle.length);
}

const BORROW_GUARD = 'if (isRendererTargetBorrowed(renderer)) { heldFrames.held(); return; } heldFrames.released();';
const STAGE_GUARD = 'if (isPrecompileActive(renderer, rawNow())) return;';
const IDLE_GATE = 'if (idleGrace.shouldIdle(isSimRunning() || isSkeletalPreviewing())) return;';

describe('Scene3D consults the #1246 compile holds', () => {
  it('holds every frame while a scene-pass compile has the target bound — before EITHER submit', () => {
    expect(occurrences(BORROW_GUARD), 'exactly one borrow guard, renewing the overlay wait as it holds').toBe(1);
    expectInOrder(code, [BORROW_GUARD, STAGE_GUARD, "gpuPassScope('postfx', () => postfxStack!.render())"]);
    expectInOrder(code, [BORROW_GUARD, "gpuPassScope('scene', () => renderer.render(scene, activeCamera))", 'markScenePainted();']);
  });

  it('a paused surface keeps asking its holds — the borrow precedes the idle gate, and only a submitted frame spends grace (#1252)', () => {
    const frame = between('function renderFrame() {', 'idleGrace.submitted(); }');
    // Past the idle gate a paused surface stopped reaching the borrow guard once grace ran out, so
    // the overlay's wait stopped renewing. Before the sync too: a borrowed frame costs nothing else.
    expectInOrder(frame, [BORROW_GUARD, IDLE_GATE, 'syncEnvironment(world, scene, renderer);']);
    // The stage session too (#1239 C): under its stubbed `render`, the sync's PMREM derivation
    // draws nothing and caches an empty IBL; and a paused surface must still see its ceiling.
    expect(occurrences(STAGE_GUARD), 'exactly one stage-session guard').toBe(1);
    expectInOrder(frame, [BORROW_GUARD, STAGE_GUARD, IDLE_GATE, 'syncEnvironment(world, scene, renderer);']);
    // Spent at the paint mark and nowhere else: a frame a gate or stage session holds drew nothing,
    // and spending grace on it stopped the loop before the gate's ceiling release was ever seen.
    expect(frame, 'grace is spent right after the paint mark that only a submitted frame reaches').toContain('markScenePainted(); idleGrace.submitted(); }');
    expect(occurrences('idleGrace.submitted()')).toBe(1);
    expect(occurrences(IDLE_GATE)).toBe(1);
  });

  it('promises the loading overlay each gate\'s hold as it kicks', () => {
    expect(occurrences('createLiveCompileGate({'), 'a new gate needs the same promise — extend this guard').toBe(2);
    expect(occurrences('onKick: extendScenePaintWait,'), 'both the live and the stack compile gate').toBe(2);
  });

  it('renews the overlay wait through the tested module, bounded by its budget', () => {
    const deps = between('createHeldFramePaintWait({', '});');
    expect(deps).toContain('extend: extendScenePaintWait,');
    expect(deps).toContain('stepMs: LIVE_COMPILE_MAX_HOLD_MS,');
    expect(deps).toContain('maxMs: HELD_FRAME_PAINT_WAIT_MAX_MS,');
  });

  it('the offscreen capture draws and restores its target inside a turn on the compile queue — no compile can overlap it', () => {
    // The balanced body of the queued callback: the draw, the readback and the restore must all be
    // in it, or a compile can bind its target over the capture's (or restore the capture's over the
    // live frames). And the capture must reach the draw ONLY through that callback.
    const entry = 'const offscreenRender: SceneRenderer = async (opts) => {';
    const wrapper = between(entry, '};');
    const open = 'runExclusivePrecompileWithin(installed, CAPTURE_TURN_WAIT_MS, async () => {';
    expectInOrder(wrapper, ['if (scope.disposed) throw new Error(', 'const installed = renderer;']);
    expect(wrapper).toContain(open);
    expect(wrapper, 'a turn that arrives after teardown or a rebuild must not draw').toContain('if (scope.disposed || renderer !== installed) {');
    // Pinned INSIDE the callback, in order: a `return captureAtTurn(opts)` moved after the turn (with
    // `return turn.value` replaced) still contains the text, and draws once the turn has ended.
    expectInOrder(wrapper, [open, 'if (scope.disposed || renderer !== installed) {', 'return captureAtTurn(opts); });', 'if (!turn.ran) {', 'return turn.value;']);
    expect(occurrences('captureAtTurn('), 'captureAtTurn must be reachable only from the queued callback').toBe(1);
    expect(occurrences("registerSceneRenderer(offscreenRender, 'game-3d');")).toBe(1);
    const body = between('const captureAtTurn: SceneRenderer = async (opts) => {', "dataUrl: captureCanvas.toDataURL('image/jpeg', quality) };");
    expectInOrder(body, ['capturing = true;', 'r.setRenderTarget(rt);', 'r.render(scene, cam);', 'boundedCaptureReadback(', 'r.setRenderTarget(prevRT);']);
  });
});
