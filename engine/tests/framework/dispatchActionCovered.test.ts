// @vitest-environment jsdom
/** dispatch-action refuses when every SHOWN control carrying the action is COVERED at its hit point
 *  (#1418) — #1406's gate saw only hidden controls, so an always-drawn HUD button under a full-screen
 *  modal stayed dispatchable (measured live: Wordweave's Dictionary opened under Settings).
 *
 *  jsdom has no layout and no hit test, so each node gets a rect and `elementFromPoint` answers
 *  from a table keyed by the aim point's x — the op's REAL occlusion recipe (`coveringElementAt`)
 *  runs on top of that. Each accept-side row is a fail-open case the gate must not refuse. */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTestWorld, type TestWorld, EntityAttributes, UIElement, UIAction, RenderableUI } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();

type Reply = { ok?: boolean; dispatched: boolean; gate?: string; carriers?: string[]; coveredBy?: string[]; reason?: string };

let game: TestWorld | undefined;
let hits = 0;
/** aim x → what `elementFromPoint` reports there. */
let topAt = new Map<number, Element | null>();
const realElementFromPoint = document.elementFromPoint;

beforeEach(() => {
  hits = 0;
  topAt = new Map();
  document.body.innerHTML = '';
  Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  document.elementFromPoint = (x: number) => topAt.get(Math.round(x)) ?? null;
});
afterEach(() => { game?.dispose(); game = undefined; document.elementFromPoint = realElementFromPoint; });

/** A node for entity `id`, laid out as a 20x20 box centred on (cx, 100). */
function node(id: number, cx: number, parent: Element): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-entity-id', String(id));
  el.getBoundingClientRect = () => ({ left: cx - 10, top: 90, width: 20, height: 20, right: cx + 10, bottom: 110, x: cx - 10, y: 90, toJSON() {} }) as DOMRect;
  parent.appendChild(el);
  return el;
}
function host(kind: 'game' | 'preview' | 'none'): Element {
  if (kind === 'none') return document.body;
  const h = document.createElement('div');
  h.setAttribute(kind === 'game' ? 'data-game-view-area' : 'data-ui-preview-frame', '');
  document.body.appendChild(h);
  return h;
}

function world() {
  game = createTestWorld({ actions: { 'game.zoom': () => { hits++; } } });
  const modal = game.spawn(RenderableUI(), UIElement({}), EntityAttributes({ guid: 'modal', name: 'Modal' }));
  const carrier = (name: string) => game!.spawn(
    RenderableUI(), UIElement({}),
    UIAction({ bindings: [{ event: 'click', kind: 'call', action: 'game.zoom' }] }),
    EntityAttributes({ guid: name.toLowerCase(), name }),
  );
  return { modal, carrier };
}
const dispatch = () => runAgentOp('dispatch-action', { name: 'game.zoom' }) as Promise<Reply>;

describe('dispatch-action refuses a control that is shown but COVERED (#1418)', () => {
  it('a carrier under a game modal → refused as control-covered, naming the cover by entity; the handler does not run', async () => {
    const { modal, carrier } = world();
    const g = host('game');
    node(carrier('ZoomIn').id(), 100, g);
    topAt.set(100, node(modal.id(), 500, g));
    const r = await dispatch();
    expect(r).toMatchObject({ ok: false, dispatched: false, gate: 'control-covered', carriers: ['ZoomIn'], coveredBy: ['Modal'] });
    expect(r.reason).toMatch(/ZoomIn under Modal/);
    expect(hits).toBe(0);
  });

  it('a shipped game (no editor host): any cover counts → refused', async () => {
    const { modal, carrier } = world();
    node(carrier('ZoomIn').id(), 100, host('none'));
    topAt.set(100, node(modal.id(), 500, host('none')));
    expect((await dispatch()).gate).toBe('control-covered');
  });

  it('mounted twice (SceneView preview + Game): the GAME node is judged, whichever comes first', async () => {
    const { modal, carrier } = world();
    const id = carrier('ZoomIn').id();
    const preview = node(id, 300, host('preview'));
    topAt.set(300, preview); // the preview copy is cleanly hit
    const g = host('game');
    node(id, 100, g);
    topAt.set(100, node(modal.id(), 500, g));
    expect((await dispatch()).gate).toBe('control-covered');
  });

  it('ACCEPT SIDE: the carrier is on top at its centre → dispatched', async () => {
    const { carrier } = world();
    const el = node(carrier('ZoomIn').id(), 100, host('game'));
    topAt.set(100, el);
    expect((await dispatch()).dispatched).toBe(true);
    expect(hits).toBe(1);
  });

  it('ACCEPT SIDE: one of two carriers is reachable → dispatched', async () => {
    const { modal, carrier } = world();
    const g = host('game');
    node(carrier('ZoomIn').id(), 100, g);
    topAt.set(100, node(modal.id(), 500, g));
    const other = node(carrier('ZoomInToo').id(), 200, g);
    topAt.set(200, other);
    expect((await dispatch()).dispatched).toBe(true);
  });

  it('ACCEPT SIDE (fail open): the carrier has no DOM node yet — shown this turn, not rendered', async () => {
    world().carrier('ZoomIn');
    expect((await dispatch()).dispatched).toBe(true);
  });

  it('ACCEPT SIDE (fail open): the cover is EDITOR chrome outside the Game host', async () => {
    const { carrier } = world();
    node(carrier('ZoomIn').id(), 100, host('game'));
    const menu = document.createElement('div');
    document.body.appendChild(menu);
    topAt.set(100, menu);
    expect((await dispatch()).dispatched).toBe(true);
  });

  it('ACCEPT SIDE (fail open): the carrier\'s centre is off the window', async () => {
    const { modal, carrier } = world();
    const g = host('game');
    node(carrier('ZoomIn').id(), 1100, g); // innerWidth is 1000
    topAt.set(1100, node(modal.id(), 500, g));
    expect((await dispatch()).dispatched).toBe(true);
  });

  // Close-out review: the DOM is the last render, so a modal the agent closed THIS frame is still
  // drawn. Measured live — `modoki_batch [settingsClose, dictionaryOpen]` was refused as
  // "DictionaryOpenButton under SettingsPanel", one frame before a player's tap would reach it.
  it('ACCEPT SIDE (fail open): the cover is still drawn but its entity is hidden in the ECS — closed this frame', async () => {
    const { modal, carrier } = world();
    const g = host('game');
    node(carrier('ZoomIn').id(), 100, g);
    topAt.set(100, node(modal.id(), 500, g));
    modal.set(UIElement, { ...modal.get(UIElement)!, isVisible: false });
    expect((await dispatch()).dispatched).toBe(true);
  });

  it('... and the same when the cover\'s entity is gone from the world entirely', async () => {
    const { modal, carrier } = world();
    const g = host('game');
    node(carrier('ZoomIn').id(), 100, g);
    topAt.set(100, node(modal.id(), 500, g));
    modal.destroy();
    expect((await dispatch()).dispatched).toBe(true);
  });

  // Close-out review 2: the stale check must not stop at the INNERMOST entity. A child hidden this
  // frame inside a modal that stays up leaves the modal covering the carrier.
  it('a child hidden this frame inside a modal that stays up → still refused, naming the MODAL', async () => {
    const { modal, carrier } = world();
    const g = host('game');
    node(carrier('ZoomIn').id(), 100, g);
    const tab = game!.spawn(RenderableUI(), UIElement({ isVisible: false }), EntityAttributes({ guid: 'tab', name: 'Tab', parentId: modal.id() }));
    topAt.set(100, node(tab.id(), 500, node(modal.id(), 500, g)));
    const r = await dispatch();
    expect(r).toMatchObject({ gate: 'control-covered', coveredBy: ['Modal'] });
  });

  // Close-out review 3: the outward walk must stop at the carrier's OWN ancestor. Wordweave's
  // RevealHintPanel and TutorialBand sit under HUD Root beside every GapButtonRow carrier.
  function hudWithOverlay(overlayVisible: boolean) {
    const { carrier } = world();
    const hud = game!.spawn(RenderableUI(), UIElement({}), EntityAttributes({ guid: 'hud', name: 'HUD Root' }));
    const zoom = carrier('ZoomIn');
    zoom.set(EntityAttributes, { ...zoom.get(EntityAttributes)!, parentId: hud.id() });
    const overlay = game!.spawn(RenderableUI(), UIElement({ isVisible: overlayVisible }), EntityAttributes({ guid: 'hint', name: 'HintPanel', parentId: hud.id() }));
    const hudEl = node(hud.id(), 500, host('game'));
    node(zoom.id(), 100, hudEl);
    topAt.set(100, node(overlay.id(), 100, hudEl));
    return hudEl;
  }
  it('ACCEPT SIDE (fail open): a sibling overlay closed this frame under the carrier\'s own shown HUD root → dispatched, not "under HUD Root"', async () => {
    hudWithOverlay(false);
    expect((await dispatch()).dispatched).toBe(true);
  });
  it('... and the same sibling overlay still shown → refused, naming the OVERLAY', async () => {
    hudWithOverlay(true);
    expect(await dispatch()).toMatchObject({ gate: 'control-covered', coveredBy: ['HintPanel'] });
  });
  it('the shared ancestor\'s OWN drawing on top (no entity of its own) counts, named from the DOM', async () => {
    const hudEl = hudWithOverlay(false);
    const deco = document.createElement('span');
    deco.id = 'hud-frame';
    hudEl.appendChild(deco);
    topAt.set(100, deco);
    expect(await dispatch()).toMatchObject({ gate: 'control-covered', coveredBy: ['span#hud-frame'] });
  });

  it('a cover that belongs to no UI entity (engine overlay DOM inside the host) still counts', async () => {
    const { carrier } = world();
    const g = host('game');
    node(carrier('ZoomIn').id(), 100, g);
    const overlay = document.createElement('div');
    overlay.id = 'debug-menu';
    g.appendChild(overlay);
    topAt.set(100, overlay);
    expect((await dispatch()).gate).toBe('control-covered');
  });

  it('ACCEPT SIDE (fail open): the carrier\'s centre is outside a scrolling ancestor\'s clip — a player can scroll to it', async () => {
    const { modal, carrier } = world();
    const g = host('game');
    const scroller = document.createElement('div');
    scroller.style.overflow = 'hidden';
    scroller.getBoundingClientRect = () => ({ left: 0, top: 0, width: 50, height: 800, right: 50, bottom: 800, x: 0, y: 0, toJSON() {} }) as DOMRect;
    g.appendChild(scroller);
    node(carrier('ZoomIn').id(), 100, scroller); // centre x=100, clip ends at x=50
    topAt.set(100, node(modal.id(), 500, g));
    expect((await dispatch()).dispatched).toBe(true);
  });

  // In a SHIPPED game (no host marker): inside the editor's Game host a null top already fails open
  // through the host check, which would hide this branch (mutation-checked).
  it('ACCEPT SIDE (fail open): nothing at all at the carrier\'s centre', async () => {
    node(world().carrier('ZoomIn').id(), 100, host('none')); // topAt has no entry → elementFromPoint null
    expect((await dispatch()).dispatched).toBe(true);
  });

  it('ACCEPT SIDE (fail open): an environment with no hit test at all (jsdom) → dispatched, not a thrown error', async () => {
    const { modal, carrier } = world();
    const g = host('game');
    node(carrier('ZoomIn').id(), 100, g);
    node(modal.id(), 500, g);
    (document as { elementFromPoint?: unknown }).elementFromPoint = undefined;
    expect((await dispatch()).dispatched).toBe(true);
  });

  it('ACCEPT SIDE (fail open): a zero-size rect cannot be aimed at', async () => {
    const { modal, carrier } = world();
    const g = host('game');
    const el = node(carrier('ZoomIn').id(), 100, g);
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
    topAt.set(0, node(modal.id(), 500, g));
    expect((await dispatch()).dispatched).toBe(true);
  });
});
