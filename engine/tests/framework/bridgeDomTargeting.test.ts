/** Synthetic device input must land on the DOM UI element under the aim, not the canvas (#299).
 *
 *  THE DEFECT: `dispatchTapAt`/`handlePointer` recognised only `<button>`/`<a>` as DOM targets and
 *  sent everything else at the game canvas. An on-screen control built from a `div` — the engine
 *  `UIRenderer`'s output, a game's touch d-pad (`[data-modoki-touch]`) — got an event whose `target`
 *  was the CANVAS, so every `e.target`/`closest(...)` handler missed. Measured on the Galaxy A23
 *  (forest-camp): a `device_pointer` down on the d-pad left `CharacterController3D.moveX` at 0 and a
 *  `device_tap` on the aim button never toggled archery — both replying a clean `ok (canvas:only)`.
 *  That is the false-success shape this surface exists to refuse, and no test could see it because
 *  every existing bridge test aims at a bare canvas with no DOM UI in front of it.
 *
 *  jsdom has no layout, so `document.elementFromPoint` is stubbed per case (tests/setup.ts defaults
 *  it to a miss). That is not stubbing out the thing under test: what is under test is WHICH element
 *  we dispatch on given a hit-test result — the hit-test itself is the browser's. */

import { describe, it, expect, afterEach } from 'vitest';
import { handleTap, handlePointer, releaseHeldPointer, _resetHeldPointerForTests } from '../../app/debug/bridge';

const baselineElementFromPoint = document.elementFromPoint;

afterEach(() => {
  _resetHeldPointerForTests();
  document.elementFromPoint = baselineElementFromPoint;
  document.body.innerHTML = '';
});

function hitTestReturns(el: Element | null) {
  document.elementFromPoint = () => el;
}

/** Record the pointer events an element actually receives (AT that element, not bubbled through). */
function record(el: Element): Array<{ type: string; target: string }> {
  const seen: Array<{ type: string; target: string }> = [];
  for (const t of ['pointerdown', 'pointermove', 'pointerup']) {
    el.addEventListener(t, (e) => seen.push({ type: t, target: (e.target as Element).tagName }));
  }
  return seen;
}

function canvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  document.body.appendChild(c);
  return c;
}

/** An engine `UIRenderer`-shaped control: a plain div carrying the `data-entity-id` the game UI
 *  renderer actually emits (the editor's `data-ui-id` handles are not on this surface). */
function uiControl(id: string): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('data-entity-id', id);
  document.body.appendChild(el);
  return el;
}

/** The shape measured on the A23: a game's own touch control, carrying NO convention this code
 *  knows about. Kept distinct from `uiControl` on purpose — the fix must be generic, so a test that
 *  only ever aims at a `data-ui-id` element could not tell "dispatches at DOM UI" from "dispatches
 *  at elements the bridge recognises". */
function gameTouchControl(): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('data-touch-control', 'moveLeft');
  document.body.appendChild(el);
  return el;
}

describe('device_tap aims at DOM UI, not through it (#299)', () => {
  it('THE REGRESSION: a tap on a touch-control div is dispatched ON the div, not the canvas', async () => {
    const c = canvas();
    const dpad = gameTouchControl();
    const onCanvas = record(c);
    const onDpad = record(dpad);
    hitTestReturns(dpad);

    const reply = await handleTap({ x: 100, y: 700 });

    expect(onDpad.map((e) => e.type)).toEqual(['pointerdown', 'pointerup']);
    expect(onCanvas).toEqual([]);              // before the fix this was the ONLY element that saw it
    expect(onDpad[0].target).toBe('DIV');      // the fact the handler reads — it was CANVAS before
    expect(reply).toContain('dom:div');
    expect(reply).not.toContain('canvas:');
  });

  it('the events still bubble to `window`, so the Input seam sees them exactly as before', async () => {
    // Dispatching on the element rather than the canvas must not cost the engine's source-agnostic
    // pointer source its input — `pointerSource` listens on `window`, and these bubble.
    canvas();
    const dpad = gameTouchControl();
    hitTestReturns(dpad);
    const atWindow: string[] = [];
    const on = (e: Event) => atWindow.push(e.type);
    for (const t of ['pointerdown', 'pointerup']) window.addEventListener(t, on);

    await handleTap({ x: 100, y: 700 });

    for (const t of ['pointerdown', 'pointerup']) window.removeEventListener(t, on);
    expect(atWindow).toEqual(['pointerdown', 'pointerup']);
  });

  it('sends the FULL sequence a finger produces — pointer, mouse, and a click', async () => {
    // Pointer events alone are not enough, and this nearly shipped inside the fix: the engine
    // `UIRenderer` binds React `onClick`, so a control driven with only pointerdown/pointerup stays
    // as silent as it was before #299 — the same defect wearing a different event name.
    canvas();
    const el = uiControl('start-button');
    hitTestReturns(el);
    const order: string[] = [];
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.addEventListener(t, () => order.push(t));
    }

    const reply = await handleTap({ x: 10, y: 10 });

    expect(order).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    expect(reply).toContain('dom:div[data-entity-id=');
  });

  it('the click carries the aim coordinates, not (0,0)', async () => {
    // `el.click()` would fire a click with no coordinates; a handler that reads clientX/clientY —
    // or positions something at the tap — would silently act on the origin.
    canvas();
    const el = uiControl('coords');
    hitTestReturns(el);
    let at = '';
    el.addEventListener('click', (e) => { at = `${(e as MouseEvent).clientX},${(e as MouseEvent).clientY}`; });

    await handleTap({ x: 42, y: 99 });

    expect(at).toBe('42,99');
  });

  it('a <button> is activated once — the click reaches it by bubbling, like a finger\'s', async () => {
    canvas();
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    let clicked = 0;
    btn.addEventListener('click', () => { clicked++; });
    hitTestReturns(btn);

    const reply = await handleTap({ x: 10, y: 10 });

    expect(clicked).toBe(1); // exactly once — not zero, and not doubled by a separate el.click()
    expect(reply).toContain('dom:button');
  });

  it('a click lands on the enclosing button when the aim hits an inner span', async () => {
    canvas();
    const btn = document.createElement('button');
    const label = document.createElement('span');
    btn.appendChild(label);
    document.body.appendChild(btn);
    let clicked = 0;
    btn.addEventListener('click', () => { clicked++; });
    hitTestReturns(label);

    await handleTap({ x: 10, y: 10 });

    expect(clicked).toBe(1);
  });

  it('<body> is NEVER a UI target — it means "no canvas covers the point", not "tap the page"', async () => {
    // Caught while writing this file: without the explicit exclusion, a hit-test answering `body`
    // (which is what a real miss looks like, and what jsdom's stub returns) made the bridge report
    // `ok (dom:body)` on a page with NO canvas at all, where the honest answer is a refusal.
    hitTestReturns(document.body);
    expect(await handleTap({ x: 10, y: 20 })).toMatch(/^Error: No canvas element found/);
  });

  it('an element CONTAINING the canvas is a container, not UI — the aim is for the surface beneath', async () => {
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const c = document.createElement('canvas');
    wrapper.appendChild(c);
    const onCanvas = record(c);
    const onWrapper = record(wrapper);
    hitTestReturns(wrapper);

    const reply = await handleTap({ x: 10, y: 20 });

    expect(onCanvas.map((e) => e.type)).toEqual(['pointerdown', 'pointerup']);
    // The wrapper still SEES them by bubbling; what matters is that it is not the dispatch target.
    expect(onWrapper.every((e) => e.target === 'CANVAS')).toBe(true);
    expect(reply).toContain('canvas:');
  });
});

describe('device_pointer holds its gesture on the DOM element it pressed (#299)', () => {
  it('down on a touch control presses the DIV, and move/up reuse it across calls', async () => {
    const c = canvas();
    const dpad = uiControl('move-left');
    const onCanvas = record(c);
    const onDpad = record(dpad);
    hitTestReturns(dpad);

    const down = await handlePointer({ action: 'down', x: 100, y: 700 });
    // The reply NAMES what it drove — `data-entity-id` is the handle the game `UIRenderer` emits,
    // and being able to read the target off the reply is what makes a wrong aim visible at all.
    expect(down).toContain('dom:div[data-entity-id="move-left"]');
    expect(down).toMatch(/held:true/);

    // Re-aim somewhere else entirely: pointer capture means the gesture stays with what it grabbed,
    // so the hit-test result at the NEW point must not re-target it.
    hitTestReturns(c);
    await handlePointer({ action: 'move', x: 120, y: 700 });
    const up = await handlePointer({ action: 'up', x: 120, y: 700 });

    expect(onDpad.map((e) => e.type)).toEqual(['pointerdown', 'pointermove', 'pointerup']);
    expect(onCanvas).toEqual([]);
    expect(up).toMatch(/held:false/);
  });
});

describe('a press the agent can no longer release is released for it (#299)', () => {
  it('releaseHeldPointer dispatches the matching up at the held point and clears the hold', async () => {
    // The A23 failure: a `down` with no `up` latches `pointerSource.activeId`, which then swallows
    // every REAL finger until the app is force-stopped. The lease dropping is the one moment we know
    // the agent cannot send the `up` itself, so the bridge sends it (see the disconnect handler).
    const c = canvas();
    const seen = record(c);
    hitTestReturns(c);
    await handlePointer({ action: 'down', x: 10, y: 20 });

    const released = releaseHeldPointer();

    expect(released).toMatch(/left at 10\.0,20\.0/);
    expect(seen.map((e) => e.type)).toEqual(['pointerdown', 'pointerup']);
    // and the hold is gone: a later `up` is refused as a stray, not silently re-sent
    expect(await handlePointer({ action: 'up', x: 10, y: 20 })).toMatch(/no pointer is held/);
  });

  it('releases a press held on a DOM ELEMENT at that element, not at the canvas', async () => {
    // The canvas case above cannot see this: `releaseHeldPointer` reads the held TARGET, and a
    // version that reached for the canvas instead would still look correct there.
    const c = canvas();
    const el = uiControl('held-control');
    const onCanvas = record(c);
    const onEl = record(el);
    hitTestReturns(el);
    await handlePointer({ action: 'down', x: 5, y: 5 });

    const released = releaseHeldPointer();

    expect(released).toContain('dom:div[data-entity-id="held-control"]');
    expect(onEl.map((e) => e.type)).toEqual(['pointerdown', 'pointerup']);
    expect(onCanvas).toEqual([]);
  });

  it('is a no-op when nothing is held', async () => {
    expect(releaseHeldPointer()).toBeNull();
  });

  it('still clears the hold when the target is gone and the dispatch throws', async () => {
    const c = canvas();
    hitTestReturns(c);
    await handlePointer({ action: 'down', x: 10, y: 20 });
    c.dispatchEvent = () => { throw new Error('detached'); };

    expect(() => releaseHeldPointer()).not.toThrow();
    expect(await handlePointer({ action: 'move', x: 1, y: 1 })).toMatch(/no pointer is held/);
  });
});
