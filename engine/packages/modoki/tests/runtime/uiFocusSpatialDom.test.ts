/** @vitest-environment jsdom */
/** Spatial focus nav over REAL UI DOM rects (QA-UI-0002).
 *
 *  The sibling `uiFocusSystem.test.ts` proves spatial nav against a *registered bounds
 *  provider* — which no UI host has ever registered. UI rects live only in the DOM, so in a
 *  real game `collectScreenBounds()` returned nothing for a UI entity and the spatial
 *  fallback silently never fired: focus BLOCKED on a nav link whose target had been
 *  disabled instead of skipping past it. These tests drive the DOM path the fix reads. */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/core/pipeline';
import { Input, setDigital } from '../../src/runtime/traits/Input';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { UIFocusable } from '../../src/runtime/traits/UIFocusable';
import { uiFocusSystem } from '../../src/runtime/ui/uiFocusSystem';
import { resetFocus, focusedGuid } from '../../src/runtime/ui/focusManager';

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; resetFocus(); document.body.innerHTML = ''; });

/** A UI node as `UINode` renders it, with a fixed rect (jsdom measures everything as 0). */
function node(host: HTMLElement, entityId: number, rect: { x: number; y: number; w: number; h: number }) {
  const el = document.createElement('div');
  el.setAttribute('data-entity-id', String(entityId));
  el.getBoundingClientRect = () => ({
    left: rect.x, top: rect.y, width: rect.w, height: rect.h,
    right: rect.x + rect.w, bottom: rect.y + rect.h, x: rect.x, y: rect.y, toJSON: () => ({}),
  }) as DOMRect;
  host.appendChild(el);
  return el;
}

function gameHost(): HTMLElement {
  const host = document.createElement('div');
  host.setAttribute('data-game-view-area', '');
  document.body.appendChild(host);
  return host;
}

function mkGame() {
  return createTestWorld({ systems: [{ name: 'uiFocus', fn: uiFocusSystem, priority: SYSTEM_PRIORITY.GAME }] });
}

describe('uiFocusSystem — spatial nav over UI DOM rects', () => {
  it('falls through to the next candidate when the explicit link target is disabled', () => {
    game = mkGame();
    game.spawn(Input);
    // The QA-UI-0002 chain: Start → Options → Quit, with Options disabled at runtime.
    const start = game.spawn(EntityAttributes({ guid: 'start', name: 'start' }), UIFocusable({ autoFocus: true, focusOrder: 0, navDown: 'options' }));
    const options = game.spawn(EntityAttributes({ guid: 'options', name: 'options' }), UIFocusable({ focusable: false, focusOrder: 1, navDown: 'quit' }));
    const quit = game.spawn(EntityAttributes({ guid: 'quit', name: 'quit' }), UIFocusable({ focusOrder: 2, navUp: 'options' }));

    const host = gameHost();
    node(host, start.id(), { x: 100, y: 0, w: 200, h: 40 });
    node(host, options.id(), { x: 100, y: 60, w: 200, h: 40 });
    node(host, quit.id(), { x: 100, y: 120, w: 200, h: 40 });

    game.step(1);
    expect(focusedGuid()).toBe('start');

    setDigital(game.world, 'navDown', true);
    game.step(1);
    // Skips the disabled Options and lands on Quit — it must NOT stay on Start.
    expect(focusedGuid()).toBe('quit');
  });

  it('measures within ONE host — the SceneView preview mount does not perturb the game move', () => {
    game = mkGame();
    game.spawn(Input);
    const a = game.spawn(EntityAttributes({ guid: 'a', name: 'a' }), UIFocusable({ autoFocus: true }));
    const b = game.spawn(EntityAttributes({ guid: 'b', name: 'b' }), UIFocusable({}));

    const host = gameHost();
    node(host, a.id(), { x: 0, y: 0, w: 10, h: 10 });
    node(host, b.id(), { x: 0, y: 100, w: 10, h: 10 }); // below in the GAME host

    // The same two entities mounted again in SceneView's preview, laid out left-to-right.
    // Document order puts this host FIRST, so a naive querySelector would read these rects.
    const preview = document.createElement('div');
    preview.setAttribute('data-ui-preview-frame', '');
    document.body.insertBefore(preview, host);
    node(preview, a.id(), { x: 500, y: 500, w: 10, h: 10 });
    node(preview, b.id(), { x: 600, y: 500, w: 10, h: 10 });

    setDigital(game.world, 'navDown', true);
    game.step(1);
    expect(focusedGuid()).toBe('b'); // 'b' is below 'a' in the game host
  });

  it('a zero-size (unrendered) node is not a nav target', () => {
    game = mkGame();
    game.spawn(Input);
    const a = game.spawn(EntityAttributes({ guid: 'a', name: 'a' }), UIFocusable({ autoFocus: true }));
    const b = game.spawn(EntityAttributes({ guid: 'b', name: 'b' }), UIFocusable({}));
    const host = gameHost();
    node(host, a.id(), { x: 0, y: 0, w: 10, h: 10 });
    node(host, b.id(), { x: 0, y: 100, w: 0, h: 0 });

    setDigital(game.world, 'navDown', true);
    game.step(1);
    expect(focusedGuid()).toBe('a');
  });
});
