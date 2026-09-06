/** GPU-loss teardown behaviour for `previewScene.ts`, the one surface wired in #795 that is a
 *  plain factory rather than a React panel — so its loss path can be driven for real.
 *
 *  WHAT COVERS THE OTHER THREE (`ShaderPreview.tsx`, `ModelPreview.tsx`, `ParticleEditor.tsx`),
 *  and what does not:
 *   - `tests/runtime/rendererLossHandling.test.ts` proves the shared detection primitives fire,
 *     guard staleness, log, and detach — in isolation.
 *   - `tests/editor/previewLossPolicy.test.ts` proves the shared policy logs and runs its
 *     teardown exactly once, guarded against a throw. That is the DECISION, and per `CLAUDE.md`
 *     § Editor Panels it lives in a plain `.ts` beside the panels precisely so it can be tested
 *     without mounting them.
 *   - `tests/architecture/rendererLossHandling.test.ts` proves each construction site actually
 *     attaches — mutation-checked against `ParticleEditor.tsx` and `ModelPreview.tsx`.
 *
 *  ⚠️ What is NOT covered for those three: a real fire-and-observe run through the mounted panel.
 *  An earlier draft of this file asserted it with regexes over the panels' SOURCE (matching
 *  `makePreviewLossPolicy({ label: 'ShaderPreview', teardown })` and the literal text of the
 *  cleanup statement). Those were removed deliberately: they pinned formatting rather than
 *  behaviour, so a reformat would redden them while a genuinely wrong teardown that kept the
 *  same shape would pass. A name-checking assertion reports spelling, not correctness — better
 *  to leave the gap visible here than to paper it with a test that cannot see the defect. The
 *  honest instrument for those three is an e2e spec driving the real panel; not written.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';

// previewScene.ts is a plain factory (no React) — its behaviour is exercised directly.
vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    target = { set() {} };
    addEventListener() {}
    removeEventListener() {}
    update() { return false; }
    dispose() {}
  },
}));
vi.mock('three/examples/jsm/environments/RoomEnvironment.js', () => ({
  RoomEnvironment: class { dispose() {} },
}));
vi.mock('../../src/runtime/rendering/scene3DSync', () => ({ applyRendererColorConfig: () => {} }));
vi.mock('../../src/runtime/core/gpuContextTracking', () => ({
  noteGpuContextCreated: () => {},
  noteGpuContextDestroyed: () => {},
}));

// Every constructed instance, so a test can assert on call counts without `createPreviewScene`
// handing the renderer back (finding 6, adversarial review of #795: a mutation-checkable
// assertion needs something to count, and the previous version of this fake gave it nothing to
// count against).
const rendererInstances: FakeWebGLRenderer[] = [];
class FakeWebGLRenderer {
  domElement = document.createElement('canvas');
  disposed = false;
  contextLost = false;
  disposeCalls = 0;
  constructor() { rendererInstances.push(this); }
  setPixelRatio() {}
  setSize() {}
  setClearColor() {}
  render() {}
  // The REAL `WEBGL_lose_context.loseContext()` (what `forceContextLoss()` calls) dispatches
  // `webglcontextlost` on the canvas SYNCHRONOUSLY (verified against
  // `THREE.WebGLRenderer.forceContextLoss`, which forwards to the extension) — modeled here for
  // realism. It does NOT re-enter `dispose()`'s own loss handler: `dispose()` calls `detachLoss()`
  // (which removes the canvas's listeners) several statements BEFORE this `forceContextLoss()`
  // runs, so by the time this dispatches, nothing is listening (finding 2, second adversarial
  // review of #795 — an earlier version of this comment claimed the opposite, that the `isDisposed`
  // guard was what stopped a re-entrant call here; mutation-checked false, see that finding).
  forceContextLoss() { this.contextLost = true; this.domElement.dispatchEvent(new Event('webglcontextlost', { cancelable: true })); }
  dispose() { this.disposeCalls++; this.disposed = true; }
}
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return {
    ...actual,
    WebGLRenderer: FakeWebGLRenderer,
    PMREMGenerator: class { fromScene() { return { texture: { dispose() {} } }; } dispose() {} },
  };
});

describe('previewScene.ts — a lost context tears the scene down via its OWN dispose()', () => {
  it('firing webglcontextlost on the renderer canvas runs dispose (removes the canvas from the DOM)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createPreviewScene } = await import('../../src/editor/panels/previewScene');
    const container = document.createElement('div');
    const handle = createPreviewScene(container);
    const canvas = container.querySelector('canvas')!;
    const renderer = rendererInstances[rendererInstances.length - 1];
    expect(canvas).toBeTruthy();
    expect(container.contains(canvas)).toBe(true);

    const e = new Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(e);

    // dispose()'s last step removes the renderer's canvas from the DOM — observable proof the
    // loss ran the SAME dispose() the panel's own unmount calls, not a separate path.
    expect(container.contains(canvas)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(err).toHaveBeenCalled();
    expect(handle.disposed).toBe(true);

    // dispose() is idempotent (#795: a lost-context teardown and an unmount can both call it) —
    // calling it again directly must not throw, AND must not re-run the teardown (finding 6,
    // adversarial review of #795: `.not.toThrow()` alone passes with or without the `isDisposed`
    // guard, because every step it re-runs is individually idempotent or wrapped in try/catch —
    // nothing THROWS either way. `disposeCalls` staying at 1 is the assertion that can actually
    // fail — mutation-checked: deleting the guard reddens THIS assertion, not one placed right
    // after the event fire above, which the guard never reaches — see the fake's own comment).
    expect(() => handle.dispose()).not.toThrow();
    expect(renderer.disposeCalls).toBe(1);
  });

  it('exposes `disposed` so a caller (Preview3DShell) can stop populating a dead handle (finding 2)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createPreviewScene } = await import('../../src/editor/panels/previewScene');
    const container = document.createElement('div');
    const handle = createPreviewScene(container);
    expect(handle.disposed).toBe(false);
    handle.dispose();
    expect(handle.disposed).toBe(true);
  });

  it('clears content added AFTER a first dispose() when a second call comes in (finding 2)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createPreviewScene } = await import('../../src/editor/panels/previewScene');
    const container = document.createElement('div');
    const handle = createPreviewScene(container);
    handle.dispose(); // e.g. the GPU-loss teardown
    // A caller that populated AGAINST `disposed` (the bug this test guards, not the fix) would add
    // content onto a dead handle here — model that directly rather than reaching into internals.
    const THREE = await import('three');
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    handle.contentRoot.add(mesh);
    expect(handle.contentRoot.children.length).toBe(1);
    handle.dispose(); // e.g. the panel's own unmount, running after the loss
    expect(handle.contentRoot.children.length).toBe(0);
  });
});
