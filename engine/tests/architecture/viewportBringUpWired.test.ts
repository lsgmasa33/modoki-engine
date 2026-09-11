/** The 3D viewports are WIRED to the decisions `viewportBringUp.ts` pins — a tested module nothing
 *  calls correctly is not a fix (#824, #1052).
 *
 *  #824 moved Scene3D's bring-up decisions out of its effect closure so a test could reach them, and
 *  `tests/runtime/viewportBringUp.test.ts` now pins each decision. What that suite cannot see is how
 *  a viewport USES the module — which is the same gap #824 was filed for, one layer out. Measured
 *  by the close-out review: `rebuild: bringUp.boot` (the rebuild silently loses its bound) and a
 *  no-op capture slot (`retire` that clears nothing, so #819's retirement never happens) both left
 *  all 144 tests across the bring-up, recovery and 3D sync suites green. #1052 then wired the
 *  editor's `SceneView.tsx` to the same module, and this guard covers that caller too.
 *
 *  Deliberately a source scan rather than a mount: both callers are components, and CLAUDE.md rules
 *  out mounting one in jsdom ("that asserts the mock"). The shape follows
 *  `videoTextureTeardownReachable.test.ts` — the behaviour is tested where it lives, and this only
 *  proves production reaches it the right way. Read through the ONE shared scanner (#419), so a
 *  mention in a comment cannot satisfy it.
 *
 *  ⚠️ **Every needle is anchored by the delimiter that ENDS its value** (`,` or the closing brace).
 *  The first version matched bare prefixes, and its own review showed what that buys:
 *  `isDisposed: () => disposed && false` and `current: () => captureRT && null` — the latter
 *  disables #819's retirement exactly as a no-op `retire` would — both passed. A prefix match
 *  cannot tell a value from the start of a longer, wrong one.
 *
 *  ⚠️ Known limit: `callArgument` counts braces inside string literals too (the scanner blanks
 *  comments, not strings). An unbalanced `'}'` inside one of these calls would end the slice early.
 *  None exists today; if one is added, this guard needs a real parser.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCENE3D = 'engine/packages/modoki/src/runtime/rendering/Scene3D.tsx';
const SCENEVIEW = 'engine/packages/modoki/src/editor/panels/SceneView.tsx';

/** One viewport's source — comment-stripped and whitespace-collapsed, so a reflow does not red the
 *  guard and a comment does not green it — with call-scoped helpers over it. */
function scan(rel: string) {
  const code = readScannedSource(path.join(repoRoot, rel)).code.replace(/\s+/g, ' ');
  const occurrences = (needle: string) => code.split(needle).length - 1;
  /** The balanced `{ … }` argument of the first `<callee>({` call — so an assertion is scoped to the
   *  one call it is about, not satisfied by the same text elsewhere in a file of thousands of lines. */
  const callArgument = (callee: string): string => {
    const open = `${callee}({`;
    const start = code.indexOf(open);
    expect(start, `${rel} no longer calls ${callee}({ … }) — update this guard with the new wiring`).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let i = start + open.length - 1; i < code.length; i += 1) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') {
        depth -= 1;
        if (depth === 0) return code.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced braces after ${callee}({ in ${rel}`);
  };
  return { code, occurrences, callArgument };
}

describe('Scene3D is wired to viewportBringUp the way its tests assume (#824)', () => {
  const { code, occurrences, callArgument } = scan(SCENE3D);

  it('hands recovery the BOUNDED rebuild — and nothing else calls either bring-up', () => {
    const recovery = callArgument('createRendererRecovery');
    expect(recovery, 'recovery must rebuild through bringUp.rebuild (bounded by REBUILD_BRINGUP_TIMEOUT_MS)').toContain('rebuild: bringUp.rebuild,');
    // Exactly once each, file-wide: a SECOND `bringUp.boot` (say, a loss handler calling it instead of
    // `recovery.request()`) rebuilds with no bound and no backoff while recovery sits wired and unused.
    expect(occurrences('bringUp.rebuild'), 'bringUp.rebuild must be referenced only as recovery\'s rebuild').toBe(1);
    expect(occurrences('bringUp.boot'), 'bringUp.boot must be called exactly once — the initial bring-up').toBe(1);
  });

  it('runs the FIRST bring-up through the unbounded boot(), and routes losses through recovery', () => {
    expect(code, 'the initial bring-up must stay unbounded — a bound there turned a slow cold start into a permanent failure').toContain('bringUp.boot().catch(');
    expect(code, 'a reported loss must go through recovery\'s single-flight latch and backoff').toContain('recovery.request();');
  });

  it('gives the bring-up the effect\'s real disposal, install and teardown', () => {
    const deps = callArgument('createViewportBringUp');
    expect(deps).toContain('isDisposed: () => disposed,');
    expect(deps).toContain('install: (r) => install(r),');
    expect(deps).toContain('teardown: () => teardown(),');
  });

  it('gives the capture readback a slot that reads AND clears the pooled captureRT (#819)', () => {
    const at = code.indexOf('boundedCaptureReadback(');
    expect(at, `${SCENE3D} no longer calls boundedCaptureReadback`).toBeGreaterThanOrEqual(0);
    const call = code.slice(at, code.indexOf(');', at) + 2);
    // `current` must return the pool's target as-is: the helper retires only when
    // `slot.current() === rt`, so anything that is not exactly `captureRT` disables the retirement.
    expect(call).toContain('{ current: () => captureRT, retire: () => { captureRT = null; } }');
  });
});

describe("the editor's SceneView is wired to viewportBringUp too (#1052)", () => {
  const { code, occurrences, callArgument } = scan(SCENEVIEW);

  it('hands recovery the BOUNDED rebuild, and no longer re-runs an unbounded setup()', () => {
    expect(callArgument('createRendererRecovery'), 'recovery must rebuild through bringUp.rebuild').toContain('rebuild: bringUp.rebuild,');
    expect(occurrences('bringUp.rebuild'), 'bringUp.rebuild must be referenced only as recovery\'s rebuild').toBe(1);
    expect(occurrences('bringUp.boot'), 'bringUp.boot must be called exactly once — the initial bring-up').toBe(1);
    expect(code, 'the initial bring-up must stay unbounded').toContain('bringUp.boot().catch(');
    expect(code, 'a reported loss must go through recovery\'s latch and backoff').toContain('recovery.request();');
    // #1052's defect by name: the rebuild used to be `teardownViewport(); discardRenderer(container); await setup();`.
    // A bare call only — a method like `x.setup()` added later elsewhere in the file must not red this.
    expect((code.match(/(^|[^.\w$])setup\(\)/g) ?? []).length, 'a bare setup() call is the unbounded bring-up #1052 removed').toBe(0);
  });

  it('gives the bring-up the effect\'s real disposal, install, teardown and a lease-aware discard', () => {
    const deps = callArgument('createViewportBringUp<WebGPURenderer>');
    expect(deps).toContain('createRenderer: (kind) => createRenderer(kind),');
    expect(deps).toContain('isDisposed: () => outerDisposed,');
    expect(deps).toContain('install: (r, stillCurrent) => install(r, stillCurrent),');
    // The discard is what makes a dead renderer unleasable — see SceneView's recovery comment.
    expect(deps).toContain('teardown: () => { teardownViewport(); discardRenderer(container); initedRef.current = true; },');
    // An arrival after unmount goes back through the lease (a StrictMode remount may be re-acquiring
    // it); anything else is a superseded renderer whose lease the overtaking rebuild already dropped.
    expect(deps).toContain("if (reason === 'disposed') releaseRenderer(container);");
    // …and the superseded renderer really is disposed. An empty branch leaks the GPU device and leaves
    // a second canvas in the container (close-out review: the guard was green with it emptied).
    expect(deps).toContain('else { r.dispose(); r.domElement.remove(); }');
  });

  it("install's post-await re-check decides SUPERSEDED before UNMOUNTED, and gives the lease back only on unmount", () => {
    const install = code.slice(code.indexOf('const install = async ('), code.indexOf('createViewportBringUp<WebGPURenderer>({'));
    const wrap = install.indexOf('renderer.dispose = (...args: Parameters<typeof priorDispose>) => { disposeActiveRenderer(); return priorDispose(...args); };');
    const superseded = install.indexOf('if (!stillCurrent()) {');
    const unmounted = install.indexOf("if (outerDisposed) { noteRendererProgress('viewport unmounted while the KTX2 loader chunk was in flight');");
    expect(wrap, 'the dispose wrap is what makes a lease release also drop the active-renderer registration').toBeGreaterThan(-1);
    expect(superseded, 'install no longer re-checks supersession after setActiveRenderer').toBeGreaterThan(-1);
    expect(unmounted, 'install no longer re-checks unmount after setActiveRenderer').toBeGreaterThan(-1);
    // The wrap must be in place BEFORE a branch can give the lease back, or that release disposes through
    // the unwrapped `dispose` and the dead renderer stays registered as active.
    expect(wrap, 'the dispose wrap must come before the re-checks').toBeLessThan(superseded);
    // Superseded first: its lease was already discarded, so the unmount branch's releaseRenderer would
    // decrement the SUCCESSOR's lease.
    expect(superseded, 'the superseded check must come before the unmount check').toBeLessThan(unmounted);

    const supersededBranch = install.slice(superseded, unmounted);
    // The overtaking rebuild's discardRenderer already disposed the renderer — before the dispose wrap
    // existed — so only the registration taken by setActiveRenderer is still this install's to drop.
    expect(supersededBranch).toContain('disposeActiveRenderer(); return;');
    // …and it must NOT give the lease back. That lease is gone, so a release here takes the SUCCESSOR's
    // from 1 to 0 and its deferred timer disposes the renderer that was just installed: a black viewport.
    // It looks like a missing line next to its neighbour, which is why it is pinned (close-out §2d review:
    // adding it left every other assertion green).
    expect(supersededBranch, 'the superseded branch must not release the lease').not.toContain('releaseRenderer(container)');

    // The unmount branch is the one that DOES release: a StrictMode remount may be re-acquiring it, and
    // without the release an unmount during the await leaks the renderer and its GPU device.
    const unmountedBranch = install.slice(unmounted, install.indexOf('return;', unmounted) + 'return;'.length);
    expect(unmountedBranch, 'an unmount during the await must release its hold on the lease').toContain('releaseRenderer(container); return;');
  });

  it('a boot retries creation, a rebuild makes ONE attempt and leaves retrying to recovery', () => {
    expect(code).toContain("kind === 'boot' ? createWithRetry : () => makeWebGPURenderer(container)");
  });

  it('re-arms the render-on-demand gate INSIDE install, so a renderer adopted late draws too', () => {
    const start = code.indexOf('const install = async (');
    const end = code.indexOf('createViewportBringUp<WebGPURenderer>({');
    expect(start, `${SCENEVIEW} no longer defines install`).toBeGreaterThanOrEqual(0);
    expect(end, 'install must be defined before the bring-up that calls it').toBeGreaterThan(start);
    const installAndAfter = code.slice(start, end);
    expect(installAndAfter.split('gateRef.current.markDirty();').length - 1, 'exactly one markDirty, inside install').toBe(1);
    // At the END — after the frame loop starts. Moved before `setActiveRenderer`'s await or into an
    // early-return branch, a completed install would not re-arm the gate (close-out review).
    const frameLoop = installAndAfter.indexOf('registerFrameCallback(editorFrameKey');
    // Anchor first: a renamed frame key makes indexOf -1, and the ordering check below would then pass
    // however early markDirty moved (close-out §2d review).
    expect(frameLoop, 'install no longer starts its frame loop with registerFrameCallback(editorFrameKey — update this anchor').toBeGreaterThan(-1);
    expect(installAndAfter.indexOf('gateRef.current.markDirty();'), 'markDirty must come after the frame loop is started')
      .toBeGreaterThan(frameLoop);
  });
});
