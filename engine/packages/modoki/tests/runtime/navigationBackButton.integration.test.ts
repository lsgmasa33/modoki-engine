/** A real Back button, driven through the real binding path and a real scene swap.
 *
 *  Everything else that touches navigation either calls `navigationManager.back()`
 *  directly or mocks `SceneManager` wholesale, so the chain a player actually travels —
 *  a click on an authored button → `applyBindings` → the input lock → `dispatchUIAction`
 *  → `NavigationManager.back()` → the REAL `SceneManager.loadScene` → `onWorldSwap` →
 *  the history pop → the `canGoBack` read source → the button's own visibility — had
 *  never run end to end. `docs/managers-and-systems.md` § NavigationManager records why.
 *
 *  ⚠️ **What this file does and does not catch, measured — because the obvious claim for
 *  it is too strong.** Run against the shapes #808 went through: it fails on pre-#808
 *  (1 of 2), and PASSES on the deferral shape that shipped and was wrong. So it is not
 *  "the test that would have caught all six": it closes the *chain* gap, and the
 *  interleaving gap is closed by the 32 unit tests in `navigationManager.test.ts`, which
 *  can put a swap and a promise resolution at different points. Two different holes;
 *  this file is only one of them. Deciding it made the other suite redundant would be
 *  the same over-claim, in the other direction.
 *
 *  Nothing is mocked here except `fetch`, which serves the two scene documents. The
 *  scene load, the world swap, the manager registry, the action registry, the read-source
 *  registry, the binding resolver and the input lock are all the shipped ones.
 *
 *  ⚠️ The button binds `visibleBinding`, not a disabled state. `docs/managers-and-systems.md`
 *  describes "a Back button binds `disabled={!canGoBack}`" as the motivating example and
 *  the engine has no such binding: a read source reaches a UI element through
 *  `UIBinding.visibleBinding`/`textBinding` only (`ui/bindingResolver.ts`), and the one
 *  `disabled` field that exists — `UIToggle.disabled` — is written by a `set` binding, not
 *  read from the registry. So the shipped shape is "the Back button HIDES at the root",
 *  and this test pins that rather than the doc's aspiration.
 *
 *  ⚠️ koota caps a PROCESS at 16 worlds and every `loadScene` mints one, so this file
 *  stays deliberately small and releases the world it leaves behind. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { completeResponse } from '../stubs/assetResponse';
import { registerTrait } from '../../src/runtime/core/ecs/traitRegistry';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { UIAction } from '../../src/runtime/traits/UIAction';
import { UIBinding } from '../../src/runtime/traits/UIBinding';
import { sceneManager } from '../../src/runtime/scene/SceneManager';
import { navigationManager } from '../../src/runtime/managers/NavigationManager';
import { registerManager, unregisterManager } from '../../src/runtime/managers/managerRegistry';
import { getCurrentWorld } from '../../src/runtime/core/ecs/world';
import { applyBindings, type UIActionBinding } from '../../src/runtime/ui/bindings';
import { evalVisibility } from '../../src/runtime/ui/bindingResolver';
import { getReadValue, __resetReadSourcesForTesting } from '../../src/runtime/core/readSourceRegistry';
import { setPlayState } from '../../src/runtime/core/playState';
import { setManualNow, advanceManual, restoreRealClock } from '../../src/runtime/core/clock';
import { SCENE_FORMAT_VERSION } from '../../src/runtime/core/version';

// The scene loader spawns traits by NAME out of the real registry, so the three the
// authored button uses have to be in it — the app registers these at startup
// (`engine/app/ecs/registerTraits.ts`), which a package test does not run.
registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: {} });
registerTrait({ name: 'UIAction', trait: UIAction, category: 'component', fields: {} });
registerTrait({ name: 'UIBinding', trait: UIBinding, category: 'component', fields: {} });

const BACK_GUID = 'back-button-guid';

/** Every scene carries the same Back button, exactly as an authored HUD would. */
const sceneWithBackButton = (name: string) => ({
  id: `scene-${name}`,
  version: SCENE_FORMAT_VERSION,
  resources: [],
  entities: [
    {
      id: 1,
      traits: {
        EntityAttributes: { name: `BackButton-${name}`, parentId: 0, guid: BACK_GUID },
        UIAction: { bindings: [{ event: 'click', kind: 'call', action: 'engine.navigateBack' }] },
        UIBinding: { visibleBinding: 'canGoBack' },
      },
    },
  ],
});

const SCENES: Record<string, unknown> = {
  '/scenes/A.json': sceneWithBackButton('A'),
  '/scenes/B.json': sceneWithBackButton('B'),
};

/** Read the button's OWN authored binding out of the live world and fire it, the way
 *  `UINode`'s click handler does — never a hand-written binding literal, or the test
 *  would stop depending on what the scene actually authored. */
function pressBackButton(): void {
  const world = getCurrentWorld();
  let bindings: UIActionBinding[] | undefined;
  world.query(EntityAttributes, UIAction).forEach((e) => {
    if ((e.get(EntityAttributes) as { guid: string }).guid !== BACK_GUID) return;
    bindings = (e.get(UIAction) as { bindings: UIActionBinding[] }).bindings;
  });
  expect(bindings, 'the loaded scene must carry the authored Back button').toBeDefined();
  applyBindings(bindings, 'click', { selfGuid: BACK_GUID });
}

/** What the renderer would decide for the button, through the real resolver. */
function backButtonVisible(): boolean {
  const world = getCurrentWorld();
  let binding: { visibleBinding: string; visibleOp: string; visibleValue: string } | undefined;
  world.query(EntityAttributes, UIBinding).forEach((e) => {
    if ((e.get(EntityAttributes) as { guid: string }).guid !== BACK_GUID) return;
    binding = e.get(UIBinding) as typeof binding;
  });
  expect(binding, 'the loaded scene must carry the authored visibility binding').toBeDefined();
  return evalVisibility({}, binding!.visibleBinding, binding!.visibleOp || '', binding!.visibleValue || '');
}

describe('a Back button, end to end', () => {
  let realFetch: typeof global.fetch;

  beforeEach(() => {
    realFetch = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const key = Object.keys(SCENES).find((p) => url.endsWith(p));
      if (!key) throw new Error(`unexpected fetch: ${url}`);
      // completeResponse fills in `text()` from `json()` — the loaders read the body as
      // text to tell Vite's SPA `index.html` fallback from a real asset.
      return completeResponse({ ok: true, json: async () => SCENES[key] });
    }) as unknown as typeof global.fetch;

    sceneManager.resetForTesting();
    __resetReadSourcesForTesting();
    setPlayState('playing');            // applyBindings early-returns unless the sim runs
    setManualNow(0);                    // own the input-lock floor — see the second test
    registerManager(navigationManager); // init() registers canGoBack + the two actions
  });

  afterEach(() => {
    unregisterManager('engine.navigation');
    restoreRealClock();
    global.fetch = realFetch;
    try { (getCurrentWorld() as { destroy?: () => void } | null)?.destroy?.(); } catch { /* already gone */ }
  });

  it('hides at the root, appears after navigating, and going back through the button pops the stack', async () => {
    // Boot: a direct sceneManager load, the way the app's own boot path does it. It must
    // NOT record history — nothing was navigated away from.
    await sceneManager.loadScene('/scenes/A.json');
    expect(getReadValue('canGoBack')).toBe(false);
    expect(backButtonVisible()).toBe(false);   // nothing to go back to → hidden

    // The player navigates. Now there IS somewhere to go back to.
    await navigationManager.loadScene('/scenes/B.json');
    expect(sceneManager.getCurrent()?.path).toBe('/scenes/B.json');
    expect(getReadValue('canGoBack')).toBe(true);
    expect(backButtonVisible()).toBe(true);

    // Press the authored button. Everything from here is the shipped chain.
    pressBackButton();
    await vi.waitFor(() => expect(sceneManager.getCurrent()?.path).toBe('/scenes/A.json'));

    // The entry was consumed exactly once: back at the root, button hidden again.
    expect(getReadValue('canGoBack')).toBe(false);
    expect(backButtonVisible()).toBe(false);
  });

  it('a second press at the root is inert — it does not reload or strand the stack', async () => {
    await sceneManager.loadScene('/scenes/A.json');
    await navigationManager.loadScene('/scenes/B.json');

    pressBackButton();
    await vi.waitFor(() => expect(getReadValue('canGoBack')).toBe(false));
    const loadsAfterFirstBack = (global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    // ⚠️ Step past the 300ms input-lock floor first. Without this the second press is
    // swallowed by the LOCK, and the assertion below would pass for a reason that has
    // nothing to do with an empty history — the test would be green and vacuous.
    advanceManual(1000);
    pressBackButton();                       // history is empty — back() must no-op
    await Promise.resolve();
    await Promise.resolve();

    expect((global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(loadsAfterFirstBack);
    expect(getReadValue('canGoBack')).toBe(false);
    expect(sceneManager.getCurrent()?.path).toBe('/scenes/A.json');
  });
});
