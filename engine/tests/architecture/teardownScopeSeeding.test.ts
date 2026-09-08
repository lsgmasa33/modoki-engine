/** The release path is established BEFORE the first acquisition, at all five bring-ups (#858).
 *
 *  WHAT THIS COVERS THAT NOTHING ELSE CAN. `teardownScope.test.ts` proves the mechanism (LIFO,
 *  idempotent, per-step catch, add-after-dispose). What it cannot see is whether a viewport
 *  actually USES it, and — the part that is the whole bug — whether the scope is handed to the
 *  teardown path before the first thing is taken. A scope created halfway down a bring-up is
 *  exactly as leaky as the closure it replaced.
 *
 *  ⚠️ DELIBERATELY A SOURCE GUARD, and the reason is a constraint rather than a preference. The
 *  seam #858 asks for is "make `setup()` throw from the inside, then assert the module-level slots
 *  are null" — and that needs the panel MOUNTED, which `CLAUDE.md` § Tests forbids in jsdom
 *  ("never mount a panel in jsdom: that asserts the mock"). SceneView's bring-up is ~2,200 lines
 *  over a real WebGPU renderer, an orbit camera and a post-FX stack; a jsdom mount of it would
 *  prove something about the fakes and nothing about the viewport. So the honest split is:
 *  behaviour is tested on the mechanism, ORDER is tested here, and neither claims to be the other.
 *
 *  Read through `readScannedSource`, so a marker sitting in a COMMENT cannot satisfy it (#812) —
 *  which matters more here than usual, because every one of these sites now carries a long comment
 *  explaining the very call the guard is looking for.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => readScannedSource(path.join(repoRoot, rel)).code;

/** `seed` is what makes the release path reachable; every `acquisitions` entry takes something
 *  that must be released; every `releases` entry is the `scope.add` that gives it back.
 *
 *  ⚠️ `acquisitions` alone is NOT coverage, and an earlier cut of this file pretended otherwise —
 *  it asserted only that the seed came first in source order, which **a file with zero `scope.add`
 *  calls would pass**. `releases` is what makes the guard say something about whether the thing is
 *  actually given back. Add a row here whenever a bring-up takes something new.
 *
 *  ⚠️ `releases` is PRESENCE-only — it cannot see WHERE the `scope.add` sits, so an entry would
 *  still be satisfied by a push stranded inside the terminal closure or after an early `return`.
 *  It pins "this release is registered on the scope at all", which is the regression that actually
 *  happens (a release quietly moved back, or dropped in a refactor); it does not pin reachability.
 *  The `acquisitions` half is what carries ordering. */
const sites: { label: string; rel: string; seed: string; acquisitions: string[]; releases: string[] }[] = [
  {
    label: 'SceneView viewport effect',
    rel: 'engine/packages/modoki/src/editor/panels/SceneView.tsx',
    seed: 'cleanup = scope.dispose;',
    acquisitions: [
      'acquireRenderer(',                          // the GPU device lease
      'attachRendererLossHandling(',
      'setEditorViewportCamera(camera)',           // the five module-level slots
      '_pickBillboardInUI = (clientX',
      'setEcsObjectsRegistry(renderState.ecsObjects)',
      'setFocusEntityHandler(focusEntityInView)',
      'setViewportController({',
      'const unsubSwap = onWorldSwap(',            // fires on EVERY later scene load if leaked
      'const unregisterSurface = registerRenderSurface(',
      'const unregBounds = registerBoundsProvider(',
      'const unregPick = registerPickProvider(',
      'const unregGizmo3DHandles = registerHandleProvider(',
      'const unsubInvalidation = attachInvalidationListener(',
      'registerFrameCallback(editorFrameKey',
    ],
    releases: [
      'scope.add(() => releaseRenderer(container))',
      'scope.add(detachUncapturedError)',
      'scope.add(detachRendererLoss)',
      'scope.add(() => setEditorViewportCamera(null))',
      'scope.add(() => { _pickBillboardInUI = null; })',
      'scope.add(() => setEcsObjectsRegistry(null))',
      'scope.add(setFocusEntityHandler(focusEntityInView))',
      'scope.add(setViewportController({',
      'scope.add(unsubSwap)',
      'scope.add(unsubInvalidation)',
      'scope.add(unregisterSurface)',
      'scope.add(unregBounds)',
      'scope.add(unregPick)',
      'scope.add(unregGizmo3DHandles)',
      'for (const unsub of dirtyUnsubs) scope.add(unsub)',
      'scope.add(() => { unregisterFrameCallback(editorFrameKey); stopFrameDriver(); })',
      "scope.add(() => controls.removeEventListener('change', markViewportDirty))",
      // The seven GLOBAL handlers. Left terminal-only these outlive a failed bring-up and run
      // gesture logic on every pointer move in the editor — not memory, live input.
      "window.removeEventListener('keydown', onSnapKey);",
      "window.removeEventListener('pointermove', onSelectMove);",
      "window.removeEventListener('pointermove', marqueeMove);",
      'scope.add(() => marqueeEl.remove())',
    ],
  },
  {
    label: 'Scene3D install/startRenderLoop',
    rel: 'engine/packages/modoki/src/runtime/rendering/Scene3D.tsx',
    seed: 'cleanupRef.current = () => { installTornDown = true; scope.dispose(); };',
    acquisitions: [
      'attachRendererLossHandling(',
      'attachInvalidationListener(renderState, scene)',
      'registerRenderSurface(getCurrentWorld, renderState)',
      "registerSceneRenderer(offscreenRender, 'game-3d')",
      'registerBoundsProvider(',
      'sceneManager.registerBeforeSwap(prewarmHook)',
      'onForceResize(applyResize)',
    ],
    releases: [
      "scope.add(() => detachRendererLoss(), 'detachRendererLoss')",
      "scope.add(() => detachUncapturedError(), 'detachUncapturedError')",
      "for (const unsub of dirtyUnsubs) scope.add(unsub, 'dirtyUnsub')",
      "scope.add(unsubInvalidation, 'unsubInvalidation')",
      "scope.add(unregisterSurface, 'unregisterSurface')",
      "scope.add(() => unregisterSceneRenderer(offscreenRender), 'unregisterSceneRenderer')",
      "scope.add(unregBounds, 'unregBounds')",
      "scope.add(unsubSwap, 'unsubSwap')",
      "scope.add(() => sceneManager.unregisterBeforeSwap(prewarmHook), 'unregisterBeforeSwap')",
      "scope.add(unregisterForceResize, 'unregisterForceResize')",
    ],
  },
  {
    label: 'ParticleEditor bring-up IIFE',
    rel: 'engine/packages/modoki/src/editor/panels/ParticleEditor.tsx',
    seed: 'cleanupRef.current = scope.dispose;',
    acquisitions: [
      'attachRendererLossHandling(',
      'new OrbitControls(',
      'new ResizeObserver(',
    ],
    releases: [
      'scope.add(() => { disposeActiveRenderer(); renderer.dispose(); renderer.domElement.remove(); })',
      'scope.add(() => detachLoss())',
      'scope.add(() => controls.dispose())',
      'scope.add(() => ro.disconnect())',
    ],
  },
  {
    label: 'ModelPreview mount effect',
    rel: 'engine/packages/modoki/src/editor/panels/ModelPreview.tsx',
    seed: "const scope = createTeardownScope('ModelPreview');",
    acquisitions: [
      'new THREE.WebGLRenderer(',
      'noteGpuContextCreated()',
      'new OrbitControls(',
    ],
    releases: [
      'scope.add(noteGpuContextCreated())',
      'scope.add(teardown)',
      // The two lines the close-out review's finding 1 was about. This panel has TWO entry points
      // into teardown, and the renderer's disposal lives on the scope — so the loss path MUST
      // drain the scope, not call `teardown()`. Reverting that one identifier is a silent
      // regression back to a leaked GL context per context-loss, which nothing else can catch.
      'teardown: () => scope.dispose()',
      'renderer.forceContextLoss();',
    ],
  },
  {
    label: 'Preview3DShell → createPreviewScene',
    rel: 'engine/packages/modoki/src/editor/panels/Preview3DShell.tsx',
    seed: "const scope = createTeardownScope('Preview3DShell');",
    acquisitions: ['createPreviewScene(container, { width, height }, scope)'],
    releases: ['scope.dispose();'],
  },
];

describe('the release path is seeded before the first acquisition (#858)', () => {
  for (const { label, rel, seed, acquisitions, releases } of sites) {
    it(`${label} seeds its scope first`, () => {
      const code = read(rel);

      // Exactly once, so a rename or a duplicated bring-up fails loudly here rather than letting
      // `indexOf` silently answer about the wrong occurrence.
      expect(code.split(seed).length - 1, `${rel}: expected exactly one \`${seed}\``).toBe(1);
      const seedAt = code.indexOf(seed);

      for (const acq of acquisitions) {
        const at = code.indexOf(acq);
        expect(at, `${rel}: acquisition \`${acq}\` not found — if it was renamed, update this guard`)
          .toBeGreaterThan(-1);
        expect(at, `${rel}: \`${acq}\` is taken BEFORE the release path exists. A throw between the `
          + 'two leaves it held by nothing and reachable by nothing — that is #858 exactly.')
          .toBeGreaterThan(seedAt);
      }
    });

    it(`${label} gives each of them back`, () => {
      const code = read(rel);
      for (const rel_ of releases) {
        expect(code, `${rel}: no \`${rel_}\` — the acquisition above is taken and never released, `
          + 'which is the whole defect. If the release moved, update this list; if it was dropped, '
          + 'that is the bug.').toContain(rel_);
      }
    });
  }

  it("Preview3DShell releases the partial build in its catch — the leak #858's census found", () => {
    const code = read('engine/packages/modoki/src/editor/panels/Preview3DShell.tsx');
    // The catch used to `return` having released nothing: `handle` is unassigned when the
    // constructor throws, so there was no `dispose` to call. `scope.dispose()` is what replaced
    // that dead end, and a future tidy-up that drops it restores the leak in full.
    const catchBlock = code.slice(code.indexOf('} catch {'), code.indexOf('handleRef.current = handle;'));
    expect(catchBlock).toContain('scope.dispose();');
  });
});
