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
 *  ⚠️ **Every wired value is compared WHOLE, as its node** (#1195). The first version matched bare
 *  prefixes, and its own review showed what that buys: `isDisposed: () => disposed && false` and
 *  `current: () => captureRT && null` — the latter disables #819's retirement exactly as a no-op
 *  `retire` would — both passed. The second anchored each needle on the delimiter ending its value, and
 *  cut the call out by counting braces, which a `'}'` inside a string in that call ended early. Now the
 *  call is found by the parser, each key's value is `propertyValue`, and `printedText` of it must EQUAL
 *  the expected code — so a longer, wrong value and a reflow are told apart without any delimiter.
 */

import { describe, it, expect } from 'vitest';
import { found } from '@modoki/engine/testing/inOrder';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';
import { callsTo, functionsNamed, parseSource, printedText, propertyValue, referencesToPath, ts } from '@modoki/engine/testing/sourceAst';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCENE3D = 'engine/packages/modoki/src/runtime/rendering/Scene3D.tsx';
const SCENEVIEW = 'engine/packages/modoki/src/editor/panels/SceneView.tsx';

/** One viewport's source — comment-stripped; `code` is also whitespace-collapsed for the statement
 *  needles, so a reflow does not red the guard and a comment does not green it — with call-scoped
 *  helpers over its parse. */
function scan(rel: string) {
  const abs = path.join(repoRoot, rel);
  const raw = readScannedSource(abs).code;
  const sf = parseSource(raw, abs);
  const code = raw.replace(/\s+/g, ' ');
  /** READS of a dotted name — not its spelling in a string. */
  const reads = (dotted: string) => referencesToPath(sf, dotted).length;
  /** The printed value `<callee>(…)`'s ONE call gives `key` in its object-literal argument — so an
   *  assertion is scoped to the call it is about, not satisfied by the same text elsewhere in a file of
   *  thousands of lines. */
  const wired = (callee: string, key: string): string => {
    const calls = callsTo(sf, callee);
    expect(calls.length, `${rel} should call ${callee}(…) exactly once — update this guard with the new wiring`).toBe(1);
    const value = propertyValue(calls[0]!.arguments[0], key);
    expect(value, `${rel}: ${callee}({ … }) no longer passes \`${key}\``).toBeDefined();
    return printedText(value!);
  };
  /** The body of the local `const install = …` / `function install` — not the `install:` property that
   *  forwards to it — whitespace-collapsed like `code`. */
  const installFn = () => {
    const fns = functionsNamed(sf, 'install').filter((fn) => !ts.isPropertyAssignment(fn.parent));
    expect(fns.length, `${rel} should define one local install function`).toBe(1);
    return fns[0]!;
  };
  const installBody = (): string => installFn().body.getText(sf).replace(/\s+/g, ' ');
  return { sf, code, reads, wired, installFn, installBody };
}

describe('Scene3D is wired to viewportBringUp the way its tests assume (#824)', () => {
  const { sf, code, reads, wired } = scan(SCENE3D);

  it('hands recovery the BOUNDED rebuild — and nothing else calls either bring-up', () => {
    expect(wired('createRendererRecovery', 'rebuild'), 'recovery must rebuild through bringUp.rebuild (bounded by REBUILD_BRINGUP_TIMEOUT_MS)').toBe('bringUp.rebuild');
    // Exactly once each, file-wide: a SECOND `bringUp.boot` (say, a loss handler calling it instead of
    // `recovery.request()`) rebuilds with no bound and no backoff while recovery sits wired and unused.
    expect(reads('bringUp.rebuild'), 'bringUp.rebuild must be referenced only as recovery\'s rebuild').toBe(1);
    expect(reads('bringUp.boot'), 'bringUp.boot must be called exactly once — the initial bring-up').toBe(1);
  });

  it('runs the FIRST bring-up through the unbounded boot(), and routes losses through recovery', () => {
    expect(code, 'the initial bring-up must stay unbounded — a bound there turned a slow cold start into a permanent failure').toContain('bringUp.boot().catch(');
    expect(code, 'a reported loss must go through recovery\'s single-flight latch and backoff').toContain('recovery.request();');
  });

  it('gives the bring-up the effect\'s real disposal, install and teardown', () => {
    expect(wired('createViewportBringUp', 'isDisposed')).toBe('() => disposed');
    expect(wired('createViewportBringUp', 'install')).toBe('(r) => install(r)');
    expect(wired('createViewportBringUp', 'teardown')).toBe('() => teardown()');
  });

  it('gives the capture readback a slot that reads AND clears the pooled captureRT (#819)', () => {
    // The call's own slot ARGUMENT, not the text up to the first `);` after it — which a `);` inside the
    // first argument (`r.readRenderTargetPixelsAsync(rt, 0, 0, w, h)` is one call away) would end early.
    const calls = callsTo(sf, 'boundedCaptureReadback');
    expect(calls.length, `${SCENE3D} should call boundedCaptureReadback exactly once`).toBe(1);
    // `current` must return the pool's target as-is: the helper retires only when
    // `slot.current() === rt`, so anything that is not exactly `captureRT` disables the retirement.
    const slot = calls[0]!.arguments[2];
    const member = (key: string) => {
      const value = slot && propertyValue(slot, key);
      expect(value, `boundedCaptureReadback's slot no longer passes \`${key}\``).toBeDefined();
      return printedText(value!);
    };
    expect(member('current')).toBe('() => captureRT');
    expect(member('retire')).toBe('() => { captureRT = null; }');
  });
});

describe("the editor's SceneView is wired to viewportBringUp too (#1052)", () => {
  const { sf, code, reads, wired, installFn, installBody } = scan(SCENEVIEW);

  it('hands recovery the BOUNDED rebuild, and no longer re-runs an unbounded setup()', () => {
    expect(wired('createRendererRecovery', 'rebuild'), 'recovery must rebuild through bringUp.rebuild').toBe('bringUp.rebuild');
    expect(reads('bringUp.rebuild'), 'bringUp.rebuild must be referenced only as recovery\'s rebuild').toBe(1);
    expect(reads('bringUp.boot'), 'bringUp.boot must be called exactly once — the initial bring-up').toBe(1);
    expect(code, 'the initial bring-up must stay unbounded').toContain('bringUp.boot().catch(');
    expect(code, 'a reported loss must go through recovery\'s latch and backoff').toContain('recovery.request();');
    // #1052's defect by name: the rebuild used to be `teardownViewport(); discardRenderer(container); await setup();`.
    // A bare call only — a method like `x.setup()` added later elsewhere in the file must not red this.
    expect((code.match(/(^|[^.\w$])setup\(\)/g) ?? []).length, 'a bare setup() call is the unbounded bring-up #1052 removed').toBe(0);
  });

  it('gives the bring-up the effect\'s real disposal, install, teardown and a lease-aware discard', () => {
    expect(wired('createViewportBringUp', 'createRenderer')).toBe('(kind) => createRenderer(kind)');
    expect(wired('createViewportBringUp', 'isDisposed')).toBe('() => outerDisposed');
    expect(wired('createViewportBringUp', 'install')).toBe('(r, stillCurrent) => install(r, stillCurrent)');
    // The discard is what makes a dead renderer unleasable — see SceneView's recovery comment.
    expect(wired('createViewportBringUp', 'teardown')).toBe('() => { teardownViewport(); discardRenderer(container); initedRef.current = true; }');
    // An arrival after unmount goes back through the lease (a StrictMode remount may be re-acquiring
    // it); anything else is a superseded renderer whose lease the overtaking rebuild already dropped.
    // …and the superseded renderer really is disposed. An empty branch leaks the GPU device and leaves
    // a second canvas in the container (close-out review: the guard was green with it emptied).
    expect(wired('createViewportBringUp', 'discard'))
      .toBe("(r, reason) => { if (reason === 'disposed') releaseRenderer(container); else { r.dispose(); r.domElement.remove(); } }");
  });

  it("install's post-await re-check decides SUPERSEDED before UNMOUNTED, and gives the lease back only on unmount", () => {
    // install's own BODY (#1195) — it was the text from `const install = async (` up to the bring-up call.
    const install = installBody();
    const wrap = found(install.indexOf('renderer.dispose = (...args: Parameters<typeof priorDispose>) => { disposeActiveRenderer(); return priorDispose(...args); };'),
      'the dispose wrap (it is what makes a lease release also drop the active-renderer registration)');
    const superseded = found(install.indexOf('if (!stillCurrent()) {'), "install's supersession re-check after setActiveRenderer");
    const unmounted = found(install.indexOf("if (outerDisposed) { noteRendererProgress('viewport unmounted while the KTX2 loader chunk was in flight');"),
      "install's unmount re-check after setActiveRenderer");
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
    // install's own BODY (#1195). It was the text from `const install = async (` to the bring-up call, so a
    // `markDirty` MOVED out of install, to after it, still counted as "inside install".
    const installAndAfter = installBody();
    const bringUpCall = callsTo(sf, 'createViewportBringUp')[0]!;
    expect(installFn().getStart(sf), 'install must be defined before the bring-up that calls it').toBeLessThan(bringUpCall.getStart(sf));
    expect(installAndAfter.split('gateRef.current.markDirty();').length - 1, 'exactly one markDirty, inside install').toBe(1);
    // At the END — after the frame loop starts. Moved before `setActiveRenderer`'s await or into an
    // early-return branch, a completed install would not re-arm the gate (close-out review).
    // found(): a renamed frame key makes indexOf -1, and the ordering check below would then pass
    // however early markDirty moved (close-out §2d review; #1181).
    const frameLoop = found(installAndAfter.indexOf('registerFrameCallback(editorFrameKey'),
      "install's registerFrameCallback(editorFrameKey anchor (update it)");
    expect(installAndAfter.indexOf('gateRef.current.markDirty();'), 'markDirty must come after the frame loop is started')
      .toBeGreaterThan(frameLoop);
  });
});
