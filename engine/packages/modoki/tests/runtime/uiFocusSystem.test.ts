/** uiFocusSystem — headless focus navigation (Phase 3, Part B).
 *
 *  Drives the whole focus path deterministically with NO renderer: spawn focusable UI
 *  entities, register uiFocusSystem, set the Input resource (nav/confirm/cancel), step,
 *  and assert the focused GUID moves and that "confirm" fires the SAME click bindings a
 *  tap would (observed via the journal). Explicit nav links are used so no on-screen
 *  rects are needed (spatial nav is unit-tested in focusManager.test.ts). */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { SYSTEM_PRIORITY } from '../../src/runtime/systems/pipeline';
import { Input, setDigital } from '../../src/runtime/traits/Input';
import { EntityAttributes } from '../../src/runtime/traits/EntityAttributes';
import { UIElement } from '../../src/runtime/traits/UIElement';
import { UIFocusable } from '../../src/runtime/traits/UIFocusable';
import { UIAction } from '../../src/runtime/traits/UIAction';
import { uiFocusSystem } from '../../src/runtime/systems/uiFocusSystem';
import { registerBoundsProvider, type EntityScreenBounds } from '../../src/runtime/rendering/screenBounds';
import {
  useFocusStore, resetFocus, pushScope, consumePendingActivation, focusedGuid,
} from '../../src/runtime/ui/focusManager';
import { emit } from '../../src/runtime/systems/journal';

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; resetFocus(); });

/** A focusable UI entity addressed by GUID. */
function focusable(g: TestWorld, guid: string, focus: Partial<Record<string, unknown>> = {}, action?: unknown) {
  const traits: unknown[] = [EntityAttributes({ guid, name: guid }), UIFocusable({ ...focus })];
  if (action) traits.push(action);
  return g.spawn(...traits);
}

function mkGame(extra?: { actions?: Record<string, unknown> }) {
  return createTestWorld({
    systems: [{ name: 'uiFocus', fn: uiFocusSystem, priority: SYSTEM_PRIORITY.GAME }],
    actions: extra?.actions as any,
  });
}

describe('uiFocusSystem', () => {
  it('autofocuses the scope, then moves focus along explicit nav links', () => {
    game = mkGame();
    game.spawn(Input);
    focusable(game, 'a', { autoFocus: true, focusOrder: 0, navRight: 'b' });
    focusable(game, 'b', { focusOrder: 1, navLeft: 'a' });

    game.step(1);
    expect(focusedGuid()).toBe('a'); // autofocus

    setDigital(game.world, 'navRight', true);
    game.step(1);
    expect(focusedGuid()).toBe('b');

    setDigital(game.world, 'navRight', false);
    setDigital(game.world, 'navLeft', true);
    game.step(1);
    expect(focusedGuid()).toBe('a');
  });

  it('confirm queues activation; draining it fires the focused element\'s click bindings', () => {
    game = mkGame({ actions: { 'menu.play': () => emit('play-pressed', {}) } });
    game.spawn(Input);
    focusable(game, 'a', { autoFocus: true }, UIAction({ bindings: [{ event: 'click', kind: 'call', action: 'menu.play' }] }));

    game.step(1);
    expect(focusedGuid()).toBe('a');

    setDigital(game.world, 'confirm', true);
    game.step(1);
    // The system only QUEUES (applyBindings can't run in a tick — F10).
    expect(useFocusStore.getState().pendingActivateGuid).toBe('a');
    expect(game.events({ type: 'play-pressed' }).length).toBe(0);

    // Draining (as UIRenderer does, outside the tick) fires the same click path a tap runs.
    const activated = consumePendingActivation(game.world);
    expect(activated).toBe('a');
    expect(game.events({ type: 'play-pressed' }).length).toBe(1);
    expect(useFocusStore.getState().pendingActivateGuid).toBe('');
  });

  it('respects scope: focus stays within the active scope; cancel pops it', () => {
    game = mkGame();
    game.spawn(Input);
    focusable(game, 'a', { autoFocus: true });                       // base scope
    focusable(game, 'c', { autoFocus: true, focusScope: 'modal' });  // modal scope

    game.step(1);
    expect(focusedGuid()).toBe('a');

    pushScope('modal');
    game.step(1);
    expect(focusedGuid()).toBe('c'); // autofocus within the newly active scope

    setDigital(game.world, 'cancel', true);
    game.step(1);
    expect(useFocusStore.getState().scopeStack).toEqual(['']); // popped back to base (edge consumed)

    setDigital(game.world, 'cancel', false);
    game.step(1);
    expect(focusedGuid()).toBe('a'); // revealed scope re-autofocuses next tick
  });

  it('excludes a focusable whose ANCESTOR is hidden (matches the renderer prune)', () => {
    game = mkGame();
    game.spawn(Input);
    // A hidden panel container with a visible focusable child (the canonical hide
    // pattern toggles the CONTAINER, not each button).
    const panel = game.spawn(EntityAttributes({ guid: 'panel', name: 'panel' }), UIElement({ isVisible: false }));
    game.spawn(
      EntityAttributes({ guid: 'apply', name: 'apply', parentId: panel.id() }),
      UIElement({ isVisible: true }),
      UIFocusable({ autoFocus: true }),
    );

    game.step(1);
    expect(focusedGuid()).toBe(''); // child under a hidden parent is NOT focusable

    // Reveal the panel → the child becomes focusable and autofocuses.
    game.world.query(UIElement).updateEach(([ui]: any[], e: any) => { if (e.id() === panel.id()) ui.isVisible = true; });
    game.step(1);
    expect(focusedGuid()).toBe('apply');
  });

  it('spatial nav (no explicit links) moves focus to the nearest on-screen candidate', () => {
    game = mkGame();
    game.spawn(Input);
    const a = focusable(game, 'a', { autoFocus: true });
    const b = focusable(game, 'b', {});
    // A bounds provider (as Scene2D/UI would register) placing 'b' to the right of 'a'.
    const rects: Record<number, EntityScreenBounds> = {
      [a.id()]: { id: a.id(), layer: '2d', screen: { x: 0, y: 0, w: 10, h: 10 }, onScreen: true },
      [b.id()]: { id: b.id(), layer: '2d', screen: { x: 100, y: 0, w: 10, h: 10 }, onScreen: true },
    };
    const unregister = registerBoundsProvider(() => Object.values(rects));
    try {
      game.step(1);
      expect(focusedGuid()).toBe('a');
      setDigital(game.world, 'navRight', true);
      game.step(1);
      expect(focusedGuid()).toBe('b'); // resolved spatially via screenBounds
    } finally {
      unregister();
    }
  });

  it('consumePendingActivation is idempotent (two UIRenderers activate once)', () => {
    game = mkGame({ actions: { 'menu.play': () => emit('play-pressed', {}) } });
    game.spawn(Input);
    focusable(game, 'a', { autoFocus: true }, UIAction({ bindings: [{ event: 'click', kind: 'call', action: 'menu.play' }] }));
    game.step(1);
    setDigital(game.world, 'confirm', true);
    game.step(1);

    expect(consumePendingActivation(game.world)).toBe('a'); // first drain fires
    expect(consumePendingActivation(game.world)).toBeNull(); // second drain is a no-op
    expect(game.events({ type: 'play-pressed' }).length).toBe(1); // activated exactly once
  });

  it('does not move focus when nav points outside the active scope', () => {
    game = mkGame();
    game.spawn(Input);
    // 'a' links right to 'x', but 'x' is in a different scope → link is ignored.
    focusable(game, 'a', { autoFocus: true, navRight: 'x' });
    focusable(game, 'x', { focusScope: 'other' });

    game.step(1);
    setDigital(game.world, 'navRight', true);
    game.step(1);
    expect(focusedGuid()).toBe('a'); // stayed — cross-scope link not followed
  });
});
