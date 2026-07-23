/** Integration: the `/api/input/*` host routes — specifically the resolve-then-dispatch
 *  seam that selector-aware input rests on.
 *
 *  The ordering is the whole point. An agent that reads an element's coordinates in one
 *  call and taps them in the next is aiming at where the element WAS; anything that moved
 *  in between (a camera orbit, a re-render, a scroll) turns the tap into a silent miss.
 *  So these tests record the ORDER of the renderer resolve vs. the trusted dispatch, not
 *  merely that both happened. Reverting to a resolve-after-dispatch (or a client-resolved)
 *  implementation must fail here.
 *
 *  Both dependencies are injected — no Electron window, no DOM. That is why the routes
 *  were lifted out of `main.ts` in the first place. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createInputRoutes, resolvePoint, type InputOps } from '../../electron/inputRoutes';

/** Ordered log of everything that happened, so we can assert on sequence.
 *  Actor-lease traffic is recorded SEPARATELY (`leaseCalls`) — it brackets every route, so
 *  folding it into `calls` would bury the resolve-vs-dispatch ordering these tests exist to
 *  pin, in noise identical on every single one of them. */
let calls: string[];
let leaseCalls: { open?: boolean; id?: number }[];

function makeOps(): InputOps {
  return {
    tap: vi.fn(async (x, y) => { calls.push(`tap(${x},${y})`); }),
    drag: vi.fn(async (from, to) => { calls.push(`drag(${from.x},${from.y}→${to.x},${to.y})`); }),
    hover: vi.fn(async (x, y) => { calls.push(`hover(${x},${y})`); }),
    scroll: vi.fn(async (x, y, dx, dy, m?) => { calls.push(`scroll(${x},${y},${dx},${dy}${m ? `,[${m.join('+')}]` : ''})`); }),
    pointerDown: vi.fn(async (x, y, o) => { calls.push(`pdown(${x},${y},${o?.button ?? 'left'})`); }),
    pointerMove: vi.fn(async (x, y, o) => { calls.push(`pmove(${x},${y},${o?.button ?? 'left'})`); }),
    pointerUp: vi.fn(async (x, y, o) => { calls.push(`pup(${x},${y},${o?.button ?? 'left'})`); }),
    pressKey: vi.fn(async (k) => { calls.push(`key(${k})`); return { activeElement: null, gameSwallows: false }; }),
    typeText: vi.fn(async (t) => { calls.push(`type(${t})`); return { typed: t.length, editable: true, activeElement: null }; }),
    focusElement: vi.fn(async (s) => { calls.push(`focus(${s ?? ''})`); return { view: true, focused: s ?? null, blurred: null, ok: true }; }),
  };
}

/** A renderer that resolves `#kebab` to (210,110) and everything else to a miss. */
function makeRenderer(overrides?: Record<string, unknown>) {
  return vi.fn(async (op: string, params: unknown) => {
    if (op === 'actor-lease') {
      const p = (params ?? {}) as { open?: boolean; id?: number };
      leaseCalls.push(p);
      return p.open ? { id: 42 } : { ok: true };
    }
    calls.push(`renderer:${op}`);
    if (op === 'resolve-dom-point') {
      const sel = (params as { selector: string }).selector;
      if (sel === '#kebab') return { ok: true, x: 210, y: 110, matched: 'button#kebab', hitTarget: 'button#kebab', occluded: false };
      if (sel === '#covered') return { ok: true, x: 50, y: 60, matched: 'button#covered', hitTarget: 'div.menu', occluded: true };
      return { ok: false, error: `no element matches selector "${sel}"` };
    }
    if (op === 'set-focus-scope') {
      const wanted = (params as { panel: string }).panel;
      // The real op returns the store's value AFTER the set — a panel that is not open
      // leaves the scope unchanged, which is how the route detects the failure.
      return { ok: true, focusedPanel: wanted === 'not-open' ? null : wanted };
    }
    if (op === 'enact-handles') {
      const wanted = (params as { ids: string[] }).ids;
      // computeHandles annotates each handle with onScreen / occludedBy / meta.disabled (F1). The
      // resolve closure used to drop them; these fixtures cover each un-clickable state.
      const known: Array<{ id: string; x: number; y: number; onScreen?: boolean; occludedBy?: string; meta?: { disabled?: boolean } }> = [
        { id: 'bone.0', x: 11, y: 22 },
        { id: 'bone.1', x: 90, y: 80 },
        { id: 'bone.off', x: -5, y: 400, onScreen: false },
        { id: 'bone.disabled', x: 30, y: 30, onScreen: true, meta: { disabled: true } },
        { id: 'bone.covered', x: 40, y: 40, onScreen: true, occludedBy: 'div.modal' },
      ];
      return { handles: known.filter((h) => wanted.includes(h.id)) };
    }
    return overrides?.[op] ?? null;
  });
}

let ops: InputOps;
let requestRenderer: ReturnType<typeof makeRenderer>;
let routes: ReturnType<typeof createInputRoutes>;

const post = (urlPath: string, body: unknown) =>
  routes({ method: 'POST', urlPath, query: new URLSearchParams(), body });

beforeEach(() => {
  calls = [];
  leaseCalls = [];
  ops = makeOps();
  requestRenderer = makeRenderer();
  routes = createInputRoutes({ ops, requestRenderer });
});

describe('routing', () => {
  it('declines non-input paths and non-POST methods, so the caller falls through', async () => {
    expect(await post('/api/capture-viewport', {})).toBeNull();
    expect(await routes({ method: 'GET', urlPath: '/api/input/tap', query: new URLSearchParams(), body: {} })).toBeNull();
    expect(await post('/api/input/unknown', {})).toBeNull();
  });
});

describe('tap', () => {
  it('taps explicit coordinates without asking the renderer anything', async () => {
    const res = await post('/api/input/tap', { x: 769, y: 310 });
    expect(res).toMatchObject({ kind: 'json', body: { ok: true, tapped: { x: 769, y: 310, button: 'left', clickCount: 1 } } });
    expect(calls).toEqual(['tap(769,310)']);
    // The renderer is asked for NOTHING but the actor lease — no resolution round-trip.
    expect(requestRenderer.mock.calls.every(([op]) => op === 'actor-lease')).toBe(true);
    // A coordinate tap carries no provenance fields — nothing was matched.
    expect((res as { body: Record<string, unknown> }).body.matched).toBeUndefined();
  });

  it('REGRESSION: resolves the selector BEFORE dispatching the trusted click', async () => {
    await post('/api/input/tap', { selector: '#kebab' });
    expect(calls).toEqual(['renderer:resolve-dom-point', 'tap(210,110)']);
    expect(ops.tap).toHaveBeenCalledWith(210, 110, expect.anything());
  });

  it('reports matched / hitTarget / occluded so a covered target is visible without a screenshot', async () => {
    const res = await post('/api/input/tap', { selector: '#covered' });
    expect(res).toMatchObject({
      kind: 'json',
      body: { ok: true, tapped: { x: 50, y: 60 }, matched: 'button#covered', hitTarget: 'div.menu', occluded: true },
    });
  });

  it('an occluded target is REPORTED, not refused — occlusion is provenance, not a veto', async () => {
    // The agent may know the overlay is harmless (a pointer-events:none scrim), or may be
    // deliberately clicking the thing on top. Silently swallowing the dispatch would be a
    // far worse surprise than a click that lands somewhere the response names.
    await post('/api/input/tap', { selector: '#covered' });
    expect(ops.tap).toHaveBeenCalledWith(50, 60, expect.anything());
  });

  it('400s on a selector that matches nothing, and dispatches NO input', async () => {
    const res = await post('/api/input/tap', { selector: '#ghost' });
    expect(res).toMatchObject({ kind: 'json', status: 400, body: { error: 'tap: no element matches selector "#ghost"' } });
    expect(ops.tap).not.toHaveBeenCalled();
  });

  it('400s when given neither a selector nor coordinates', async () => {
    const res = await post('/api/input/tap', {});
    expect(res).toMatchObject({ status: 400, body: { error: 'tap: provide a selector or {x,y}' } });
    expect(ops.tap).not.toHaveBeenCalled();
  });

  it('a selector wins over stale coordinates passed alongside it', async () => {
    await post('/api/input/tap', { selector: '#kebab', x: 1, y: 2 });
    expect(ops.tap).toHaveBeenCalledWith(210, 110, expect.anything());
  });

  it('forwards button, clickCount and modifiers', async () => {
    await post('/api/input/tap', { x: 5, y: 6, button: 'right', clickCount: 2, modifiers: ['shift'] });
    expect(ops.tap).toHaveBeenCalledWith(5, 6, { button: 'right', clickCount: 2, modifiers: ['shift'] });
  });
});

describe('drag', () => {
  it('resolves BOTH endpoints before the single trusted drag', async () => {
    await post('/api/input/drag', { from: { selector: '#kebab' }, to: { x: 400, y: 400 } });
    expect(calls).toEqual(['renderer:resolve-dom-point', 'drag(210,110→400,400)']);
  });

  it('reports per-endpoint provenance only where a selector was used', async () => {
    const res = await post('/api/input/drag', { from: { selector: '#covered' }, to: { x: 9, y: 9 } });
    expect(res).toMatchObject({ body: { ok: true, fromTarget: { occluded: true, hitTarget: 'div.menu' } } });
    expect((res as { body: Record<string, unknown> }).body.toTarget).toBeUndefined();
  });

  it('400s naming WHICH endpoint failed, and drags nothing', async () => {
    const res = await post('/api/input/drag', { from: { x: 1, y: 1 }, to: { selector: '#ghost' } });
    expect(res).toMatchObject({ status: 400, body: { error: 'to: no element matches selector "#ghost"' } });
    expect(ops.drag).not.toHaveBeenCalled();
  });

  it('a missing endpoint is a 400, not a crash', async () => {
    expect(await post('/api/input/drag', { to: { x: 1, y: 1 } })).toMatchObject({ status: 400, body: { error: /^from:/ } });
  });

  it('does not dispatch when the FIRST endpoint fails, even though the second is valid', async () => {
    await post('/api/input/drag', { from: { selector: '#ghost' }, to: { selector: '#kebab' } });
    expect(ops.drag).not.toHaveBeenCalled();
    // ...and it short-circuits: the second endpoint was never resolved. Counted over
    // RESOLUTION traffic only — the actor lease brackets every route and is not a resolve.
    expect(calls.filter((c) => c === 'renderer:resolve-dom-point')).toHaveLength(1);
  });

  // A zero-length "drag" is a CLICK: mouseDown+mouseUp at one pixel is what Blink synthesizes a
  // click from. Measured against the live editor 2026-07-22 — `{from:{700,200},to:{700,200}}`
  // over empty SceneView space returned ok:true and CLEARED the human's selection (entity 38 →
  // null) via the deselect gesture, while telling the agent it had dragged.
  it('refuses a zero-length drag instead of dispatching a click under the name "drag"', async () => {
    const res = await post('/api/input/drag', { from: { x: 700, y: 200 }, to: { x: 700, y: 200 } });
    expect(ops.drag).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: 400 });
    const err = (res as { body: { error?: string } }).body.error ?? '';
    expect(err).toMatch(/same point/i);
    expect(err).toMatch(/modoki_tap/); // names the op the caller actually wanted
  });

  it('refuses it when both endpoints are SELECTORS resolving to the same centre', async () => {
    // The non-obvious route in: two different selectors can name the same element, or two
    // elements whose centres coincide. The coordinates only become equal after resolution.
    const res = await post('/api/input/drag', { from: { selector: '#kebab' }, to: { selector: '#kebab' } });
    expect(ops.drag).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: 400 });
  });

  it('still dispatches a ONE-PIXEL drag — only the degenerate case is refused', async () => {
    // Sub-threshold drags are app semantics (SceneView cancels its deselect past 4px), not this
    // route's business: it delivered exactly the gesture asked for and echoes the true endpoints.
    // Guarding a minimum travel distance here would be an arbitrary policy in the wrong layer.
    await post('/api/input/drag', { from: { x: 700, y: 200 }, to: { x: 701, y: 200 } });
    expect(ops.drag).toHaveBeenCalledWith({ x: 700, y: 200 }, { x: 701, y: 200 }, expect.anything());
  });

  it('forwards steps, button and modifiers to the trusted drag', async () => {
    await post('/api/input/drag', { from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, steps: 30, button: 'middle', modifiers: ['shift'] });
    expect(ops.drag).toHaveBeenCalledWith({ x: 1, y: 2 }, { x: 3, y: 4 }, { steps: 30, button: 'middle', modifiers: ['shift'] });
  });
});

describe('hover and scroll', () => {
  it('hover accepts a selector', async () => {
    await post('/api/input/hover', { selector: '#kebab' });
    expect(calls).toEqual(['renderer:resolve-dom-point', 'hover(210,110)']);
  });

  it('scroll accepts a selector and defaults both deltas to 0', async () => {
    await post('/api/input/scroll', { selector: '#kebab' });
    expect(ops.scroll).toHaveBeenCalledWith(210, 110, 0, 0, undefined);
  });

  it('scroll passes BOTH deltas through with their DOM sign', async () => {
    await post('/api/input/scroll', { x: 1, y: 2, deltaX: -40, deltaY: 120 });
    expect(ops.scroll).toHaveBeenCalledWith(1, 2, -40, 120, undefined);
  });

  it('scroll forwards modifiers (Ctrl/Cmd+wheel zoom) and echoes them', async () => {
    const res = await post('/api/input/scroll', { x: 1, y: 2, deltaY: -120, modifiers: ['control'] });
    expect(ops.scroll).toHaveBeenCalledWith(1, 2, 0, -120, ['control']);
    expect((res as { body: { scrolled?: { modifiers?: string[] } } }).body.scrolled?.modifiers).toEqual(['control']);
  });

  it('scroll OMITS the modifiers echo when none (or an empty array) are given', async () => {
    const bare = await post('/api/input/scroll', { x: 1, y: 2, deltaY: -120 });
    expect('modifiers' in (bare as { body: { scrolled: object } }).body.scrolled).toBe(false);
    const empty = await post('/api/input/scroll', { x: 1, y: 2, deltaY: -120, modifiers: [] });
    expect('modifiers' in (empty as { body: { scrolled: object } }).body.scrolled).toBe(false);
  });

  it('hover forwards its modifiers', async () => {
    await post('/api/input/hover', { x: 1, y: 2, modifiers: ['alt'] });
    expect(ops.hover).toHaveBeenCalledWith(1, 2, ['alt']);
  });

  it('hover 400s with no target', async () => {
    expect(await post('/api/input/hover', {})).toMatchObject({ status: 400 });
    expect(ops.hover).not.toHaveBeenCalled();
  });
});

describe('sustained pointer (held across calls)', () => {
  it('down → move → up threads ONE button and holds between calls', async () => {
    const d = await post('/api/input/pointer', { action: 'down', x: 10, y: 20, button: 'left' });
    expect((d as { body: { pointer: { held: boolean } } }).body.pointer.held).toBe(true);
    // move/up reuse the held button even though none is passed
    await post('/api/input/pointer', { action: 'move', x: 30, y: 40 });
    const u = await post('/api/input/pointer', { action: 'up', x: 50, y: 60 });
    expect((u as { body: { pointer: { held: boolean } } }).body.pointer.held).toBe(false);
    expect(calls).toEqual(['pdown(10,20,left)', 'pmove(30,40,left)', 'pup(50,60,left)']);
  });

  it('the held button carries a non-left button into move/up', async () => {
    await post('/api/input/pointer', { action: 'down', x: 1, y: 1, button: 'right' });
    await post('/api/input/pointer', { action: 'move', x: 2, y: 2 });
    expect(calls).toEqual(['pdown(1,1,right)', 'pmove(2,2,right)']);
  });

  it('409s a move/up when nothing is held, and a second down while held', async () => {
    expect(await post('/api/input/pointer', { action: 'move', x: 1, y: 1 })).toMatchObject({ status: 409 });
    expect(await post('/api/input/pointer', { action: 'up', x: 1, y: 1 })).toMatchObject({ status: 409 });
    expect(ops.pointerMove).not.toHaveBeenCalled();
    await post('/api/input/pointer', { action: 'down', x: 1, y: 1 });
    expect(await post('/api/input/pointer', { action: 'down', x: 2, y: 2 })).toMatchObject({ status: 409 });
    expect(ops.pointerDown).toHaveBeenCalledOnce();
  });

  it('400s an unknown action and resolves a selector like the other routes', async () => {
    expect(await post('/api/input/pointer', { action: 'wiggle', x: 1, y: 1 })).toMatchObject({ status: 400 });
    await post('/api/input/pointer', { action: 'down', selector: '#kebab' });
    expect(ops.pointerDown).toHaveBeenCalledWith(210, 110, { button: 'left', modifiers: undefined });
  });

  it('a FAILED down (bad selector) holds NOTHING — a later move still 409s', async () => {
    expect(await post('/api/input/pointer', { action: 'down', selector: '#ghost' })).toMatchObject({ status: 400 });
    expect(ops.pointerDown).not.toHaveBeenCalled();
    // nothing got held, so a move is still "no pointer is held"
    expect(await post('/api/input/pointer', { action: 'move', x: 1, y: 1 })).toMatchObject({ status: 409 });
  });

  it('a FAILED move (bad selector) does NOT drop the hold — a later up still releases', async () => {
    await post('/api/input/pointer', { action: 'down', x: 1, y: 1 });
    expect(await post('/api/input/pointer', { action: 'move', selector: '#ghost' })).toMatchObject({ status: 400 });
    expect(ops.pointerMove).not.toHaveBeenCalled();
    // the hold survived the failed move, so up succeeds and clears it
    const u = await post('/api/input/pointer', { action: 'up', x: 2, y: 2 });
    expect((u as { body: { pointer: { held: boolean } } }).body.pointer.held).toBe(false);
    expect(ops.pointerUp).toHaveBeenCalledOnce();
  });
});

describe('createInputRoutes.resetHeldPointer', () => {
  it('clears a held press so the next down is not 409d as already-held', async () => {
    const routesWithReset = createInputRoutes({ ops, requestRenderer });
    await routesWithReset({ method: 'POST', urlPath: '/api/input/pointer', query: new URLSearchParams(), body: { action: 'down', x: 1, y: 1 } });
    // a second down would 409 — until we reset (simulating a renderer reload)
    routesWithReset.resetHeldPointer();
    const afterReset = await routesWithReset({ method: 'POST', urlPath: '/api/input/pointer', query: new URLSearchParams(), body: { action: 'down', x: 2, y: 2 } });
    expect((afterReset as { body: { pointer: { held: boolean } } }).body.pointer.held).toBe(true);
  });
});

describe('key, type, focus (unchanged by selectors)', () => {
  it('key requires a non-empty string', async () => {
    expect(await post('/api/input/key', { key: '' })).toMatchObject({ status: 400 });
    await post('/api/input/key', { key: 'Escape', modifiers: ['meta'] });
    expect(ops.pressKey).toHaveBeenCalledWith('Escape', ['meta']);
  });

  it('type requires a string and reports the length typed', async () => {
    expect(await post('/api/input/type', {})).toMatchObject({ status: 400 });
    // An EMPTY string is valid — it is how `clearFirst` empties a field.
    expect(await post('/api/input/type', { text: '', clearFirst: true })).toMatchObject({ body: { ok: true, typed: 0 } });
    expect(await post('/api/input/type', { text: 'hello' })).toMatchObject({ body: { typed: 5 } });
  });

  it('type forwards clearFirst and submitKey, which is how commit-on-blur is exercised', async () => {
    await post('/api/input/type', { text: 'Player', clearFirst: true, submitKey: 'Tab' });
    expect(ops.typeText).toHaveBeenCalledWith('Player', { clearFirst: true, submitKey: 'Tab' });
  });

  // C7 re-audit: typing with nothing editable focused used to report {ok:true, typed:N} into the
  // void. Now the route reflects the renderer's editability verdict as a real failure.
  it('type reports ok:false (not a silent success) when nothing editable is focused', async () => {
    (ops.typeText as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ typed: 0, editable: false, activeElement: 'canvas#viewport' });
    const res = await post('/api/input/type', { text: 'HeroName' });
    expect(res).toMatchObject({ body: { ok: false, typed: 0, activeElement: 'canvas#viewport' } });
    expect((res as { body: { error?: string } }).body.error).toMatch(/cannot receive typed text/i);
  });

  it('distinguishes "nothing focused" from "focused, but rejects text"', async () => {
    // Measured 2026-07-22: after tapping the Inspector's readOnly name field, the single
    // one-size message told the caller to "modoki_tap the target input first" — the step they
    // had just performed correctly. The two failures need different next actions.
    (ops.typeText as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ typed: 0, editable: false, activeElement: null });
    const none = await post('/api/input/type', { text: 'x' });
    expect((none as { body: { error?: string } }).body.error).toMatch(/no element is focused/i);
    expect((none as { body: { error?: string } }).body.error).toMatch(/modoki_tap/);

    (ops.typeText as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ typed: 0, editable: false, activeElement: 'input' });
    const ro = await post('/api/input/type', { text: 'x' });
    const err = (ro as { body: { error?: string } }).body.error ?? '';
    expect(err).toMatch(/readOnly\/disabled/i);
    expect(err).not.toMatch(/modoki_tap the target input first/);
  });

  it('key stays ok:true but surfaces the focused field that stops the GAME sampling it', async () => {
    (ops.pressKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ activeElement: 'input#console-filter', gameSwallows: true });
    const res = await post('/api/input/key', { key: 'ArrowRight' });
    expect(res).toMatchObject({ body: { ok: true, activeElement: 'input#console-filter' } });
    const warning = (res as { body: { warning?: string } }).body.warning ?? '';
    expect(warning).toMatch(/running game/i);
    // The warning must NOT claim the key was swallowed outright. Measured 2026-07-22: `f` framed
    // the selection (camera moved) while the old wording said it "will swallow this key" — the
    // editor's keymap uses a narrower predicate than the game's, so both can be true at once.
    expect(warning).toMatch(/editor shortcuts are unaffected/i);
    expect(warning).not.toMatch(/will swallow this key/i);
  });

  it('focus with no selector blurs, and passes the result straight back', async () => {
    expect(await post('/api/input/focus', {})).toMatchObject({ body: { ok: true, view: true } });
    expect(ops.focusElement).toHaveBeenCalledWith(undefined);
  });
});

describe('handle-aimed input (moved from main.ts intact)', () => {
  it('tap-handle resolves the handle, then taps its live coordinates', async () => {
    const res = await post('/api/input/tap-handle', { id: 'bone.0' });
    expect(calls).toEqual(['renderer:enact-handles', 'tap(11,22)']);
    expect(res).toMatchObject({ body: { ok: true, tappedHandle: { id: 'bone.0', x: 11, y: 22 } } });
  });

  it('drag-handle supports a delta relative to the resolved handle', async () => {
    await post('/api/input/drag-handle', { id: 'bone.0', delta: { dx: 5, dy: -2 } });
    expect(ops.drag).toHaveBeenCalledWith({ x: 11, y: 22 }, { x: 16, y: 20 }, expect.anything());
  });

  it('drag-handle refuses a zero delta — the easiest way to reach the degenerate drag', async () => {
    // `delta:{dx:0,dy:0}` is a TRUTHY object, so it sails past the `if (!to && h.delta)` guard
    // and produces to === from. This route already refuses off-screen and disabled handles;
    // a click wearing a drag's name is the same class of false success.
    const res = await post('/api/input/drag-handle', { id: 'bone.0', delta: { dx: 0, dy: 0 } });
    expect(ops.drag).not.toHaveBeenCalled();
    expect(res).toMatchObject({ body: { ok: false } });
    expect((res as { body: { error?: string } }).body.error).toMatch(/tap-handle/);
  });

  it('drag-handle refuses a destination handle that sits on top of the source', async () => {
    const res = await post('/api/input/drag-handle', { id: 'bone.0', toId: 'bone.0' });
    expect(ops.drag).not.toHaveBeenCalled();
    expect(res).toMatchObject({ body: { ok: false } });
  });

  it('drag-handle drags to an explicit destination', async () => {
    await post('/api/input/drag-handle', { id: 'bone.0', to: { x: 400, y: 300 } });
    expect(ops.drag).toHaveBeenCalledWith({ x: 11, y: 22 }, { x: 400, y: 300 }, expect.anything());
  });

  it('drag-handle drags ONTO another handle, resolving both live (toId)', async () => {
    // Bone-onto-bone reparenting in the Skin editor: both endpoints must be resolved in
    // this call, or the destination is wherever the second handle used to be.
    const res = await post('/api/input/drag-handle', { id: 'bone.0', toId: 'bone.1' });
    expect(calls).toEqual(['renderer:enact-handles', 'renderer:enact-handles', 'drag(11,22→90,80)']);
    expect(res).toMatchObject({ body: { ok: true, draggedHandle: { id: 'bone.0', from: { x: 11, y: 22 }, to: { x: 90, y: 80 } } } });
  });

  it('drag-handle 404s on an unknown toId, naming it, and drags nothing', async () => {
    const res = await post('/api/input/drag-handle', { id: 'bone.0', toId: 'ghost' });
    expect(res).toMatchObject({ status: 404, body: { error: /no live handle with toId 'ghost'/ } });
    expect(ops.drag).not.toHaveBeenCalled();
  });

  it('an explicit `to` wins over toId and delta', async () => {
    await post('/api/input/drag-handle', { id: 'bone.0', to: { x: 1, y: 1 }, toId: 'bone.1', delta: { dx: 9, dy: 9 } });
    expect(ops.drag).toHaveBeenCalledWith({ x: 11, y: 22 }, { x: 1, y: 1 }, expect.anything());
  });

  it('drag-handle forwards steps/button/modifiers', async () => {
    await post('/api/input/drag-handle', { id: 'bone.0', delta: { dx: 1, dy: 1 }, steps: 4, button: 'right', modifiers: ['meta'] });
    expect(ops.drag).toHaveBeenCalledWith({ x: 11, y: 22 }, { x: 12, y: 23 }, { steps: 4, button: 'right', modifiers: ['meta'] });
  });

  // ── F1: the resolve closure used to drop onScreen/occludedBy/disabled, so tap/drag fired
  //    unconditionally and always returned ok:true. Now off-screen / disabled = a genuine miss
  //    (ok:false, dispatch nothing); occluded = still act, but surface `occluded`. ──
  it('tap-handle REFUSES an off-screen handle (ok:false) and dispatches nothing', async () => {
    const res = await post('/api/input/tap-handle', { id: 'bone.off' }) as { body: { ok: boolean; error: string } };
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/off-screen/);
    expect(ops.tap).not.toHaveBeenCalled();
  });

  it('tap-handle REFUSES a disabled handle (ok:false) and dispatches nothing', async () => {
    const res = await post('/api/input/tap-handle', { id: 'bone.disabled' }) as { body: { ok: boolean; error: string } };
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/disabled/);
    expect(ops.tap).not.toHaveBeenCalled();
  });

  it('tap-handle TAPS an occluded handle but surfaces `occluded` (provenance, not a veto)', async () => {
    const res = await post('/api/input/tap-handle', { id: 'bone.covered' }) as { body: Record<string, unknown> };
    expect(ops.tap).toHaveBeenCalledWith(40, 40, expect.anything());
    expect(res.body).toMatchObject({ ok: true, occluded: 'div.modal' });
  });

  it('drag-handle refuses an off-screen FROM, and a blocked toId, dispatching nothing', async () => {
    const r1 = await post('/api/input/drag-handle', { id: 'bone.off', to: { x: 1, y: 1 } }) as { body: { ok: boolean } };
    expect(r1.body.ok).toBe(false);
    const r2 = await post('/api/input/drag-handle', { id: 'bone.0', toId: 'bone.disabled' }) as { body: { ok: boolean; error: string } };
    expect(r2.body).toMatchObject({ ok: false });
    expect(r2.body.error).toMatch(/disabled/);
    expect(ops.drag).not.toHaveBeenCalled();
  });

  it('drag-handle still drags an occluded endpoint but reports `occluded`', async () => {
    const res = await post('/api/input/drag-handle', { id: 'bone.covered', to: { x: 5, y: 5 } }) as { body: Record<string, unknown> };
    expect(ops.drag).toHaveBeenCalledWith({ x: 40, y: 40 }, { x: 5, y: 5 }, expect.anything());
    expect(res.body).toMatchObject({ ok: true, occluded: 'div.modal' });
  });

  it('tap-handle forwards button/clickCount/modifiers', async () => {
    await post('/api/input/tap-handle', { id: 'bone.0', button: 'right', clickCount: 2, modifiers: ['shift'] });
    expect(ops.tap).toHaveBeenCalledWith(11, 22, { button: 'right', clickCount: 2, modifiers: ['shift'] });
  });

  it('404s on an unknown handle id', async () => {
    expect(await post('/api/input/tap-handle', { id: 'nope' })).toMatchObject({ status: 404, body: { error: /no live handle with id 'nope'/ } });
    expect(ops.tap).not.toHaveBeenCalled();
  });

  it('400s when drag-handle has no destination at all', async () => {
    expect(await post('/api/input/drag-handle', { id: 'bone.0' })).toMatchObject({ status: 400, body: { error: /to\{x,y\}, toId, or delta/ } });
  });

  it('400s when the handle id is missing', async () => {
    expect(await post('/api/input/tap-handle', {})).toMatchObject({ status: 400, body: { error: /id \(handle id\) is required/ } });
  });
});

describe('resolvePoint (the shared resolver)', () => {
  it('turns a renderer throw into an error result, never a rejection', async () => {
    const throwing = vi.fn(async () => { throw new Error('renderer wedged'); });
    const r = await resolvePoint({ selector: '#x' }, 'tap', throwing);
    expect(r).toEqual({ error: 'tap: renderer could not resolve selector (renderer wedged)' });
  });

  it('treats a null renderer reply (no tab open) as an error, not as (undefined,undefined)', async () => {
    const nully = vi.fn(async () => null);
    expect(await resolvePoint({ selector: '#x' }, 'tap', nully)).toEqual({ error: 'tap: selector did not resolve' });
  });

  it('rejects an ok reply that is missing coordinates', async () => {
    const partial = vi.fn(async () => ({ ok: true, matched: 'div' }));
    expect(await resolvePoint({ selector: '#x' }, 'tap', partial)).toMatchObject({ error: expect.stringContaining('did not resolve') });
  });

  it('ignores an empty-string selector and falls back to coordinates', async () => {
    const r = await resolvePoint({ selector: '', x: 3, y: 4 }, 'tap', requestRenderer);
    expect(r).toEqual({ point: { x: 3, y: 4 } });
    expect(requestRenderer).not.toHaveBeenCalled();
  });
});


describe('panel-targeted input (focus-scope P7)', () => {
  it('sets the keyboard scope BEFORE dispatching the key', async () => {
    // Order matters: a panel-scoped chord resolves against the focused panel at dispatch
    // time, so focusing after the press would be useless.
    const r = await post('/api/input/key', { key: 'w', panel: 'scene' });
    expect(r.body).toMatchObject({ ok: true, focusedPanel: 'scene' });
    expect(calls).toEqual(['renderer:set-focus-scope', 'key(w)']);
  });

  it('FAILS LOUDLY when the panel is not open, and does NOT press the key', async () => {
    // The silent-failure this exists to prevent: a panel-scoped chord sent at the wrong
    // panel is simply yielded by the dispatcher, so it looks like a successful no-op.
    const r = await post('/api/input/key', { key: 'w', panel: 'not-open' });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain('could not focus panel "not-open"');
    expect(ops.pressKey).not.toHaveBeenCalled();
  });

  it('leaves the key path untouched when no panel is given', async () => {
    const r = await post('/api/input/key', { key: 'z', modifiers: ['meta'] });
    expect(r.body).toMatchObject({ ok: true, pressed: { key: 'z' } });
    expect(r.body).not.toHaveProperty('focusedPanel');
    expect(calls).toEqual(['key(z)']);
  });

  it('focus accepts a panel WITHOUT touching DOM focus', async () => {
    // Keyboard scope and document.activeElement are different questions — clicking a
    // Hierarchy row moves the scope but leaves activeElement on <body>.
    const r = await post('/api/input/focus', { panel: 'hierarchy' });
    expect(r.body).toMatchObject({ ok: true, focusedPanel: 'hierarchy' });
    expect(ops.focusElement).not.toHaveBeenCalled();
  });

  it('focus can set BOTH scope and DOM focus, scope first', async () => {
    await post('/api/input/focus', { panel: 'assets', selector: '#kebab' });
    expect(calls).toEqual(['renderer:set-focus-scope', 'focus(#kebab)']);
  });

  it('focus with no args still blurs (unchanged)', async () => {
    const r = await post('/api/input/focus', {});
    expect(r.body).toMatchObject({ ok: true });
    expect(ops.focusElement).toHaveBeenCalledWith(undefined);
  });
});

// ── Agent attribution ────────────────────────────────────────────────────────
//
// Trusted input is indistinguishable from a human's by construction, so the renderer cannot
// infer who did it — the injector must declare it. Without this bracket every agent tap
// journals as source:'human' (measured 2026-07-22: modoki_tap on a Hierarchy row produced
// !focus + !select tagged human, while modoki_gizmo — a renderer op — correctly said agent).
describe('actor lease brackets every input dispatch', () => {
  const ROUTES: [string, unknown][] = [
    ['/api/input/tap', { x: 1, y: 2 }],
    ['/api/input/drag', { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }],
    ['/api/input/hover', { x: 1, y: 2 }],
    ['/api/input/scroll', { x: 1, y: 2, deltaY: 100 }],
    ['/api/input/pointer', { action: 'down', x: 1, y: 2 }],
    ['/api/input/key', { key: 'Escape' }],
    ['/api/input/type', { text: 'hi' }],
    ['/api/input/focus', {}],
    ['/api/input/tap-handle', { id: 'bone.0' }],
    ['/api/input/drag-handle', { id: 'bone.0', delta: { dx: 5, dy: 5 } }],
  ];

  it.each(ROUTES)('%s opens and closes a lease', async (urlPath, body) => {
    await post(urlPath, body);
    expect(leaseCalls).toEqual([{ open: true }, { id: 42 }]);
  });

  it('opens the lease BEFORE dispatching, and closes it after', async () => {
    // Ordering is the point: a lease opened after the input has already been delivered
    // attributes nothing, because the editor's handlers have already run and emitted.
    const order: string[] = [];
    (ops.tap as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('tap'); });
    requestRenderer.mockImplementation(async (op: string, params: unknown) => {
      const p = (params ?? {}) as { open?: boolean; id?: number };
      if (op === 'actor-lease') { order.push(p.open ? 'open' : 'close'); return p.open ? { id: 7 } : { ok: true }; }
      return null;
    });
    await post('/api/input/tap', { x: 1, y: 2 });
    expect(order).toEqual(['open', 'tap', 'close']);
  });

  it('closes the lease even when the route THROWS', async () => {
    // The failure that makes a plain flag dangerous: an op that throws mid-dispatch would
    // leave attribution stuck on 'agent' for the rest of the human's session.
    (ops.tap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    await expect(post('/api/input/tap', { x: 1, y: 2 })).rejects.toThrow('boom');
    expect(leaseCalls).toEqual([{ open: true }, { id: 42 }]);
  });

  it('closes the lease on a 400, which returns rather than throws', async () => {
    await post('/api/input/tap', { selector: '#ghost' });
    expect(leaseCalls).toEqual([{ open: true }, { id: 42 }]);
  });

  it('still dispatches when the renderer cannot open a lease', async () => {
    // Mis-attribution is a reporting defect; a refused tap is a broken tool. An old renderer
    // without the op, or a renderer mid-reload, must not be able to break input.
    requestRenderer.mockRejectedValue(new Error('no renderer'));
    const res = await post('/api/input/tap', { x: 9, y: 9 });
    expect(ops.tap).toHaveBeenCalledWith(9, 9, expect.anything());
    expect(res).toMatchObject({ body: { ok: true } });
  });

  it('does not attempt a close when the open never produced an id', async () => {
    requestRenderer.mockImplementation(async (op: string) => (op === 'actor-lease' ? null : null));
    await post('/api/input/tap', { x: 1, y: 1 });
    const closes = requestRenderer.mock.calls.filter(([op, p]) => op === 'actor-lease' && !(p as { open?: boolean })?.open);
    expect(closes).toHaveLength(0);
  });

  it('does NOT bracket a non-input route', async () => {
    expect(await post('/api/capture-viewport', {})).toBeNull();
    expect(leaseCalls).toEqual([]);
  });
});
