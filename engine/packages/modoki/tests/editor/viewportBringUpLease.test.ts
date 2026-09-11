/** SceneView's bring-up wiring over the REAL container lease (#1052 close-out review, finding 1).
 *
 *  `viewportBringUp.test.ts` drives the bring-up decisions with a fake `createRenderer`, and
 *  `rendererLease.test.ts` drives the lease on its own. The defect lived in the seam between them:
 *  #1052 bounded a rebuild, so `rendererRecovery` retries while the timed-out attempt's create is still
 *  running, and when that abandoned create finally REJECTED, the lease's failure handler deleted
 *  whatever lease the container held — the successor's. The successor's renderer then escaped both
 *  `releaseRenderer` and the next rebuild's `discardRenderer`.
 *
 *  So this wires the three real modules the way `SceneView.tsx` wires them — `createRenderer` through
 *  `acquireRenderer`, a teardown that runs the installed release then `discardRenderer`, and the
 *  lease-aware `discard` — with fake renderers and fake timers. It never mounts the panel (CLAUDE.md).
 */
import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import { acquireRenderer, releaseRenderer, discardRenderer, __hasLease } from '../../src/editor/panels/rendererLease';
import { createViewportBringUp } from '../../src/runtime/rendering/viewportBringUp';
import {
  createRendererRecovery, REBUILD_BRINGUP_TIMEOUT_MS, DEFAULT_REBUILD_DELAY_MS,
} from '../../src/runtime/rendering/rendererRecovery';

afterEach(() => { vi.useRealTimers(); });

interface FakeRenderer { id: string; dispose: Mock<() => void>; domElement: { remove: Mock<() => void> } }
const fake = (id: string): FakeRenderer => ({ id, dispose: vi.fn<() => void>(), domElement: { remove: vi.fn<() => void>() } });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

/** The shape of `SceneView.tsx`'s wiring, minus the DOM and three. */
function sceneViewLike() {
  const container = {};
  const creates: Array<{ resolve: (r: FakeRenderer) => void; reject: (e: unknown) => void }> = [];
  const installed: string[] = [];
  /** What install's `scope.add(() => releaseRenderer(container))` holds, drained by teardown. */
  let installedRelease: (() => void) | undefined;
  const makeRenderer = () => new Promise<FakeRenderer>((resolve, reject) => { creates.push({ resolve, reject }); });
  const bringUp = createViewportBringUp<FakeRenderer>({
    createRenderer: () => acquireRenderer(container, makeRenderer),
    isDisposed: () => false,
    install: (r) => { installed.push(r.id); installedRelease = () => releaseRenderer(container); },
    teardown: () => { installedRelease?.(); installedRelease = undefined; discardRenderer(container); },
    discard: (r, reason) => {
      if (reason === 'disposed') releaseRenderer(container);
      else { r.dispose(); r.domElement.remove(); }
    },
  });
  const recovery = createRendererRecovery({ rebuild: bringUp.rebuild, isDisposed: () => false, onError: () => {} });
  return { container, creates, installed, bringUp, recovery };
}

describe("viewportBringUp over SceneView's container lease (#1052)", () => {
  /** Mutation-check target: making `rendererLease.ts`'s failure handler delete unconditionally again
   *  reddens both the lease assertion and the dispose count. */
  it("a timed-out rebuild whose create REJECTS late leaves the successor leased, so the next rebuild still disposes it", async () => {
    vi.useFakeTimers();
    const sv = sceneViewLike();

    const boot = sv.bringUp.boot();
    sv.creates[0].resolve(fake('r0'));
    await boot;

    sv.recovery.request();
    await vi.advanceTimersByTimeAsync(DEFAULT_REBUILD_DELAY_MS);        // rebuild #1: create#2 pending
    expect(sv.creates, 'precondition: rebuild #1 started').toHaveLength(2);
    await vi.advanceTimersByTimeAsync(REBUILD_BRINGUP_TIMEOUT_MS);      // …and times out
    await vi.advanceTimersByTimeAsync(DEFAULT_REBUILD_DELAY_MS * 2);    // the retry: create#3
    expect(sv.creates, 'precondition: recovery retried').toHaveLength(3);
    const r2 = fake('r2');
    sv.creates[2].resolve(r2);
    await flush();
    expect(sv.installed, 'precondition: the retry installed its renderer').toEqual(['r0', 'r2']);
    expect(__hasLease(sv.container), 'precondition: the successor holds the lease').toBe(true);

    sv.creates[1].reject(new Error('the abandoned attempt finally fails'));
    await flush();

    expect(__hasLease(sv.container), "a stale rejection must not delete the successor's lease").toBe(true);

    // What losing the lease cost: the next loss's rebuild could no longer dispose the renderer it replaces.
    sv.recovery.request();
    await vi.advanceTimersByTimeAsync(DEFAULT_REBUILD_DELAY_MS);
    expect(r2.dispose, 'the next rebuild disposes the renderer it replaces').toHaveBeenCalledTimes(1);
    expect(r2.domElement.remove).toHaveBeenCalledTimes(1);
  });
});
