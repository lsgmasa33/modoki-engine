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
    // Window deliverability brackets every route like the lease does — kept out of `calls`
    // (and overridable per-test) for the same reason: it is identical noise on every test and
    // would bury the resolve-vs-dispatch ordering these tests exist to pin.
    if (op === 'input-deliverability') return overrides?.['input-deliverability'] ?? { visibilityState: 'visible', hasFocus: true };
    calls.push(`renderer:${op}`);
    if (op === 'resolve-dom-point') {
      const sel = (params as { selector: string }).selector;
      if (sel === '#kebab') return { ok: true, x: 210, y: 110, matched: 'button#kebab', hitTarget: 'button#kebab', occluded: false };
      if (sel === '#covered') return { ok: true, x: 50, y: 60, matched: 'button#covered', hitTarget: 'div.menu', occluded: true };
      // Scrolled out of its own list: occluded, but by the chrome BEHIND it, not by something on top.
      if (sel === '#scrolled-out') return { ok: true, x: 20, y: 483, matched: 'div#scrolled-out', hitTarget: 'div.flexlayout__splitter', occluded: true, clipped: true };
      return { ok: false, error: `no element matches selector "${sel}"` };
    }
    if (op === 'resolve-entity-point') {
      const spec = (params ?? {}) as { guid?: string; name?: string; id?: number; allowOccluded?: boolean };
      // 'Puck' is a 3D scene entity — canvas-scope occlusion, nothing covering it.
      // Hit-test found NO element: the point is clipped away or past the window edge. `hitTarget`
      // is the shared NOTHING_AT_POINT sentinel, not a describable cover.
      if (spec.name === 'EdgeCube') {
        return {
          ok: true, x: 1000, y: 300,
          entity: { id: 11, name: 'EdgeCube', guid: 'g-edge', layer: '3d' },
          matched: 'EdgeCube [g-edge]', hitTarget: 'nothing (clipped or off-window)',
          occluded: true, occlusionScope: 'canvas', surface: 'game-3d',
        };
      }
      // 'entity' scope, picker FOUND the target, and a modal covers the canvas over it — the
      // combination the suite had no fixture for.
      if (spec.name === 'CoveredHero') {
        return {
          ok: true, x: 420, y: 260,
          entity: { id: 12, name: 'CoveredHero', guid: 'g-covhero', layer: '3d' },
          matched: 'CoveredHero [g-covhero]', hitTarget: 'div.modal',
          occluded: true, occlusionScope: 'entity', surface: 'scene-view',
          occludedByEntity: null, aimedAt: 'centre',
        };
      }
      if (spec.guid === 'g-puck' || spec.name === 'Puck') {
        return {
          ok: true, x: 400, y: 300,
          entity: { id: 7, name: 'Puck', guid: 'g-puck', layer: '3d' },
          matched: 'Puck [g-puck]', hitTarget: 'canvas', occluded: false, occlusionScope: 'canvas',
        };
      }
      // A UI entity that something is covering — element-scope, so `occluded` is trustworthy.
      if (spec.name === 'StartButton') {
        return {
          ok: true, x: 120, y: 80,
          entity: { id: 9, name: 'StartButton', guid: 'g-start', layer: 'ui' },
          matched: 'StartButton [g-start]', hitTarget: 'div.modal', occluded: true, occlusionScope: 'element',
        };
      }
      // F15: a 2D/3D entity on an 'entity'-scope surface, sitting behind a wall. Mirrors what
      // `entityResolve.ts` itself returns — a refusal by default, a resolved report of what was
      // actually hit when `allowOccluded` rides along on `spec`.
      if (spec.guid === 'g-hero' || spec.name === 'Hero') {
        if (!spec.allowOccluded) {
          return {
            ok: false,
            error: "entity Hero [g-hero] is not clickable in 'game-3d': a click at its aim point "
              + 'selects Wall [g-wall], not it. Pass allowOccluded:true to click anyway and see what happens.',
          };
        }
        return {
          ok: true, x: 500, y: 250,
          entity: { id: 11, name: 'Hero', guid: 'g-hero', layer: '3d' },
          matched: 'Hero [g-hero]', hitTarget: 'canvas (entity: Wall [g-wall])',
          occluded: true, occlusionScope: 'entity',
          occludedByEntity: { id: 12, name: 'Wall', guid: 'g-wall' },
          aimedAt: 'centre',
        };
      }
      if (spec.name === 'Enemy') return { ok: false, error: '3 entities are named "Enemy" (g-a, g-b, g-c) — address by guid' };
      return { ok: false, error: `no entity with guid ${JSON.stringify(spec.guid ?? spec.name ?? spec.id)}` };
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
      // `occlusionChecked` mirrors what `computeHandles` really emits: TRUE only for a handle whose
      // provider named an owning DOM element. No Canvas2D/SVG provider does, so `bone.canvas`
      // below is the realistic shape for a keyframe/bone/vertex handle — the majority case that
      // the old `occluded: occludedBy !== undefined` derivation answered `false` for, asserting a
      // check that never ran.
      const known: Array<{ id: string; x: number; y: number; onScreen?: boolean; clipped?: boolean; occludedBy?: string; occlusionChecked?: boolean; meta?: { disabled?: boolean } }> = [
        { id: 'bone.0', x: 11, y: 22, occlusionChecked: true },
        { id: 'bone.1', x: 90, y: 80, occlusionChecked: true },
        { id: 'bone.off', x: -5, y: 400, onScreen: false },
        { id: 'bone.disabled', x: 30, y: 30, onScreen: true, meta: { disabled: true } },
        { id: 'bone.covered', x: 40, y: 40, onScreen: true, occludedBy: 'div.modal', occlusionChecked: true },
        { id: 'bone.canvas', x: 60, y: 60, onScreen: true },
        // Inside the window, outside its own panel's clip box (testboard AceYUBoBXbcGtIIFmzGb).
        { id: 'grad.clipped', x: 200, y: 863, onScreen: false, clipped: true, occlusionChecked: true },
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
  routes({ method: 'POST', urlPath, query: new URLSearchParams(), body, tokenCheck: 'ok' });

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
    expect(await routes({ method: 'GET', urlPath: '/api/input/tap', query: new URLSearchParams(), body: {}, tokenCheck: 'ok' })).toBeNull();
    expect(await post('/api/input/unknown', {})).toBeNull();
  });
});

describe('tap', () => {
  it('taps explicit coordinates without asking the renderer anything', async () => {
    const res = await post('/api/input/tap', { x: 769, y: 310 });
    expect(res).toMatchObject({ kind: 'json', body: { ok: true, tapped: { x: 769, y: 310, button: 'left', clickCount: 1 } } });
    expect(calls).toEqual(['tap(769,310)']);
    // The renderer is asked for NOTHING but the actor lease — no resolution round-trip.
    expect(requestRenderer.mock.calls.every(([op]) => op === 'actor-lease' || op === 'input-deliverability')).toBe(true);
    // A coordinate tap carries no provenance fields — nothing was matched.
    expect((res as { body: Record<string, unknown> }).body.matched).toBeUndefined();
  });

  it('REGRESSION: resolves the selector BEFORE dispatching the trusted click', async () => {
    await post('/api/input/tap', { selector: '#kebab' });
    expect(calls).toEqual(['renderer:resolve-dom-point', 'tap(210,110)']);
    expect(ops.tap).toHaveBeenCalledWith(210, 110, expect.anything());
  });

  /** REVERSED 2026-08-19, deliberately. Two tests here used to assert that a covered selector was
   *  TAPPED and merely reported (`occlusion is provenance, not a veto`), on the grounds that the
   *  agent might know the overlay was harmless and a swallowed dispatch would surprise more than a
   *  click that lands somewhere the response names.
   *
   *  That reasoning does not survive `mcp-tool-conventions.md` §0, which ranks a FALSE SUCCESS as
   *  the worst outcome on this surface — above backwards compatibility — and it was already
   *  contradicted twice on the surface itself: an `entity` aim has refused since 2026-07-29, and
   *  the DEVICE twin refuses a covered selector too (`device_tap`: "an OCCLUDED target is refused
   *  here rather than tapping something else"). The editor's selector path was the sole holdout,
   *  i.e. §9's "a rule implemented twice diverges". The harmless-overlay case is real but rare, and
   *  it now has an explicit name: `allowOccluded:true`. `pointer-events:none` never needed it —
   *  `elementFromPoint` skips such elements, so they never read as occluders. */
  it('REFUSES a covered selector, naming the cover and the escape hatch, and dispatches nothing', async () => {
    const res = await post('/api/input/tap', { selector: '#covered' }) as { status?: number; body: { error: string; code: string } };
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OCCLUDED');
    expect(res.body.error).toMatch(/covered by div\.menu/);
    expect(res.body.error).toMatch(/allowOccluded/);
    expect(ops.tap).not.toHaveBeenCalled();
  });

  it('…and allowOccluded:true taps anyway, still reporting matched / hitTarget / occluded', async () => {
    const res = await post('/api/input/tap', { selector: '#covered', allowOccluded: true });
    expect(res).toMatchObject({
      kind: 'json',
      body: { ok: true, tapped: { x: 50, y: 60 }, matched: 'button#covered', hitTarget: 'div.menu', occluded: true },
    });
    expect(ops.tap).toHaveBeenCalledWith(50, 60, expect.anything());
  });

  it('a RAW {x,y} aim is never refused for occlusion — a coordinate is what you asked for', async () => {
    await post('/api/input/tap', { x: 50, y: 60 });
    expect(ops.tap).toHaveBeenCalledWith(50, 60, expect.anything());
  });

  it('400s on a selector that matches nothing, and dispatches NO input', async () => {
    const res = await post('/api/input/tap', { selector: '#ghost' });
    expect(res).toMatchObject({ kind: 'json', status: 400, body: { error: 'tap: no element matches selector "#ghost"' } });
    expect(ops.tap).not.toHaveBeenCalled();
  });

  it('400s when given no aim at all — and the message names all three modes', async () => {
    const res = await post('/api/input/tap', {});
    expect(res).toMatchObject({ status: 400, body: { error: 'tap: provide an entity {guid|name|id}, a selector, or {x,y}' } });
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

/** The refusal is a property of the AIM, not of `tap` — so it binds every aimed route, and the one
 *  carve-out is stated as a test rather than left to the reader (mcp-tool-conventions.md §9). */
describe('occlusion refusal across the aimed routes', () => {
  it('hover and scroll refuse a covered selector too', async () => {
    const h = await post('/api/input/hover', { selector: '#covered' }) as { body: { code: string } };
    expect(h.body.code).toBe('OCCLUDED');
    expect(ops.hover).not.toHaveBeenCalled();
    const sc = await post('/api/input/scroll', { selector: '#covered', deltaY: 120 }) as { body: { code: string } };
    expect(sc.body.code).toBe('OCCLUDED');
    expect(ops.scroll).not.toHaveBeenCalled();
  });

  it("pointer 'down' refuses, but 'move'/'up' do NOT — they land on whatever captured the press", async () => {
    const down = await post('/api/input/pointer', { action: 'down', selector: '#covered' }) as { body: { code: string } };
    expect(down.body.code).toBe('OCCLUDED');
    expect(ops.pointerDown).not.toHaveBeenCalled();
    // Establish a real held press somewhere clear, then re-aim it ONTO the covered element.
    await post('/api/input/pointer', { action: 'down', x: 10, y: 10 });
    await post('/api/input/pointer', { action: 'move', selector: '#covered' });
    expect(ops.pointerMove).toHaveBeenCalledWith(50, 60, expect.anything());
    await post('/api/input/pointer', { action: 'up', selector: '#covered' });
    expect(ops.pointerUp).toHaveBeenCalledWith(50, 60, expect.anything());
  });
});

describe('drag', () => {
  it('resolves BOTH endpoints before the single trusted drag', async () => {
    await post('/api/input/drag', { from: { selector: '#kebab' }, to: { x: 400, y: 400 } });
    expect(calls).toEqual(['renderer:resolve-dom-point', 'drag(210,110→400,400)']);
  });

  it('reports per-endpoint provenance only where a selector was used', async () => {
    const res = await post('/api/input/drag', { from: { selector: '#covered' }, to: { x: 9, y: 9 }, allowOccluded: true });
    expect(res).toMatchObject({ body: { ok: true, fromTarget: { occluded: true, hitTarget: 'div.menu' } } });
    expect((res as { body: Record<string, unknown> }).body.toTarget).toBeUndefined();
  });

  it('REFUSES a covered endpoint, and a per-endpoint flag can allow just one of the two', async () => {
    const refused = await post('/api/input/drag', { from: { selector: '#covered' }, to: { x: 9, y: 9 } }) as { body: { code: string } };
    expect(refused.body.code).toBe('OCCLUDED');
    expect(ops.drag).not.toHaveBeenCalled();
    // Allow the covered SOURCE alone — the top-level flag is not needed, and not implied.
    await post('/api/input/drag', { from: { selector: '#covered', allowOccluded: true }, to: { x: 9, y: 9 } });
    expect(ops.drag).toHaveBeenCalledWith({ x: 50, y: 60 }, { x: 9, y: 9 }, expect.anything());
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

  it('a scroll with NO delta is refused, not dispatched as a zero-delta no-op (S3.15)', async () => {
    // Pre-fix: `ops.scroll(x, y, 0, 0)` was dispatched and the route answered
    // `ok:true, scrolled:{deltaX:0,deltaY:0}` — nothing moved, reported as success, in the one
    // input family whose siblings (drag, drag-handle) already refuse the analogous no-op.
    const res = await post('/api/input/scroll', { selector: '#kebab' });
    const body = (res as { body: { ok?: boolean; error?: string } }).body;
    expect(body.ok).toBeFalsy();
    expect(body.error).toMatch(/no-op/);
    expect(body.error).toMatch(/deltaY/);
    expect(ops.scroll).not.toHaveBeenCalled();
  });

  it('deltaX alone is enough (the guard refuses NO delta, not a missing deltaY)', async () => {
    await post('/api/input/scroll', { selector: '#kebab', deltaX: -40 });
    expect(ops.scroll).toHaveBeenCalledWith(210, 110, -40, 0, undefined);
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
    await routesWithReset({ method: 'POST', urlPath: '/api/input/pointer', query: new URLSearchParams(), body: { action: 'down', x: 1, y: 1 }, tokenCheck: 'ok' });
    // a second down would 409 — until we reset (simulating a renderer reload)
    routesWithReset.resetHeldPointer();
    const afterReset = await routesWithReset({ method: 'POST', urlPath: '/api/input/pointer', query: new URLSearchParams(), body: { action: 'down', x: 2, y: 2 }, tokenCheck: 'ok' });
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

  it('a SHORT insert is ok:false, naming what actually landed (S3.18)', async () => {
    // `typed` used to be `text.length` — a restatement of the request. sendInputEvent cannot fail,
    // and Chromium's synthetic char path only inserts what it can express as a keyCode, so CJK /
    // emoji / accented input was reported as typed while the field was unchanged.
    (ops.typeText as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      typed: 0, editable: true, activeElement: 'input#name', valueAfter: '',
      error: 'only 0 of 3 requested character(s) reached the field',
    });
    const res = await post('/api/input/type', { text: 'あいう' });
    const body = (res as { body: { ok?: boolean; typed?: number; requested?: number; valueAfter?: string; error?: string } }).body;
    expect(body.ok).toBe(false);
    expect(body.typed).toBe(0);
    expect(body.requested).toBe(3);
    expect(body.valueAfter).toBe('');
    expect(body.error).toMatch(/only 0 of 3/);
  });

  it('a full insert echoes valueAfter so `typed` is checkable, not just asserted (S3.18)', async () => {
    (ops.typeText as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      typed: 5, editable: true, activeElement: 'input#name', valueAfter: 'hello',
    });
    expect(await post('/api/input/type', { text: 'hello' }))
      .toMatchObject({ body: { ok: true, typed: 5, valueAfter: 'hello' } });
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

  it('a focus MISS keeps its named cause and the activeElement echo (S3.7)', async () => {
    // The route must not flatten a named failure back to a bare ok:false — that is what made the
    // tool answer "the operation reported ok:false", with no cause and no distinction between
    // "no element matched" and "the element refused focus".
    (ops.focusElement as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      view: true, focused: null, blurred: null, ok: false,
      error: 'no element matches #nope — re-read the DOM', activeElement: 'body',
    });
    const res = await post('/api/input/focus', { selector: '#nope' });
    const body = (res as { body: { ok?: boolean; error?: string; activeElement?: string | null } }).body;
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/no element matches/);
    expect(body.activeElement).toBe('body');
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
  //    unconditionally and always returned ok:true. Now off-screen / disabled / OCCLUDED are all a
  //    genuine miss (ok:false, dispatch nothing), and `allowOccluded:true` is the escape hatch.
  //    Occluded was a warning-that-still-dispatched until 2026-08-19: a 2D gizmo handle sitting
  //    under the SceneView's own toolbar pressed the TOOLBAR and answered ok:true, which was filed
  //    as "the handle is completely inert" (testboard 5jE5Tip6Qwp7s7YVAYoH — it was not). ──
  it('a SCROLLED-OUT selector is refused with the scroll remedy, not "dismiss the modal"', async () => {
    // The covering element is an anonymous splitter either way, so its name cannot tell the caller
    // which fix applies. `clipped` can.
    const res = await post('/api/input/tap', { selector: '#scrolled-out' }) as { status: number; body: { error: string } };
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SCROLLED OUT/);
    expect(res.body.error).toMatch(/modoki_scroll/);
    expect(res.body.error).not.toMatch(/an open menu, a modal/);
    expect(ops.tap).not.toHaveBeenCalled();
  });

  it('tap-handle REFUSES an off-screen handle (ok:false) and dispatches nothing', async () => {
    const res = await post('/api/input/tap-handle', { id: 'bone.off' }) as { body: { ok: boolean; error: string } };
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/off-screen/);
    expect(ops.tap).not.toHaveBeenCalled();
  });

  it('a CLIPPED handle is refused with the remedy that actually applies, not "scroll it"', async () => {
    // Off the PANEL, not off the window: the press would land on whichever panel owns those
    // pixels, and telling the caller to scroll is wrong for a handle drawn past a viewport edge.
    const res = await post('/api/input/tap-handle', { id: 'grad.clipped' }) as { body: { ok: boolean; error: string } };
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/OUTSIDE its own panel/);
    expect(ops.tap).not.toHaveBeenCalled();
  });

  it('tap-handle REFUSES a disabled handle (ok:false) and dispatches nothing', async () => {
    const res = await post('/api/input/tap-handle', { id: 'bone.disabled' }) as { body: { ok: boolean; error: string } };
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/disabled/);
    expect(ops.tap).not.toHaveBeenCalled();
  });

  it('tap-handle REFUSES an occluded handle, naming the cover and the escape hatch', async () => {
    const res = await post('/api/input/tap-handle', { id: 'bone.covered' }) as { body: { ok: boolean; error: string } };
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/covered by div\.modal/);
    expect(res.body.error).toMatch(/allowOccluded/);
    expect(ops.tap).not.toHaveBeenCalled();
  });

  it('…and allowOccluded:true presses anyway, still reporting `occluded`', async () => {
    const res = await post('/api/input/tap-handle', { id: 'bone.covered', allowOccluded: true }) as { body: Record<string, unknown> };
    expect(ops.tap).toHaveBeenCalledWith(40, 40, expect.anything());
    // S3.17 — `occluded` is a BOOLEAN here, exactly as on tap/hover/drag/pointer; the covering
    // element's identity lives in `occludedBy`. It used to be the STRING itself, so the handle
    // routes disagreed with every other aimed route about what the field means.
    expect(res.body).toMatchObject({ ok: true, occluded: true, occludedBy: 'div.modal' });
  });

  it('…and a CLEAN handle says so explicitly instead of omitting the field (S3.17)', async () => {
    // Omission made "not occluded" and "this route does not report occlusion" identical.
    const res = await post('/api/input/tap-handle', { id: 'bone.0' }) as { body: Record<string, unknown> };
    expect(res.body).toMatchObject({ ok: true, occluded: false, occludedBy: null, occlusionChecked: true });
  });

  it('drag-handle refuses an off-screen FROM, and a blocked toId, dispatching nothing', async () => {
    const r1 = await post('/api/input/drag-handle', { id: 'bone.off', to: { x: 1, y: 1 } }) as { body: { ok: boolean } };
    expect(r1.body.ok).toBe(false);
    const r2 = await post('/api/input/drag-handle', { id: 'bone.0', toId: 'bone.disabled' }) as { body: { ok: boolean; error: string } };
    expect(r2.body).toMatchObject({ ok: false });
    expect(r2.body.error).toMatch(/disabled/);
    expect(ops.drag).not.toHaveBeenCalled();
  });

  it('drag-handle REFUSES a covered source, and drags it under allowOccluded', async () => {
    const refused = await post('/api/input/drag-handle', { id: 'bone.covered', to: { x: 5, y: 5 } }) as { body: { ok: boolean; error: string } };
    expect(refused.body.ok).toBe(false);
    expect(refused.body.error).toMatch(/covered by div\.modal/);
    expect(ops.drag).not.toHaveBeenCalled();
    const forced = await post('/api/input/drag-handle', { id: 'bone.covered', to: { x: 5, y: 5 }, allowOccluded: true }) as { body: Record<string, unknown> };
    expect(ops.drag).toHaveBeenCalledWith({ x: 40, y: 40 }, { x: 5, y: 5 }, expect.anything());
    expect(forced.body).toMatchObject({ ok: true, occluded: true, occludedBy: 'div.modal' });
  });

  it('drag-handle says WHICH endpoint was covered (S3.17)', async () => {
    // The two endpoints used to collapse into one `occluded` field, so a caller could not tell a
    // covered source from a covered destination — and the fixes differ.
    const res = await post('/api/input/drag-handle', { id: 'bone.0', toId: 'bone.covered', allowOccluded: true }) as
      { body: { fromTarget?: Record<string, unknown>; toTarget?: Record<string, unknown> } };
    expect(res.body.fromTarget).toMatchObject({ id: 'bone.0', occluded: false, occludedBy: null, occlusionChecked: true });
    expect(res.body.toTarget).toMatchObject({ id: 'bone.covered', occluded: true, occludedBy: 'div.modal', occlusionChecked: true });
  });

  /** REGRESSION (independent review, 2026-07-30). S3.17 derived `occluded` from
   *  `occludedBy !== undefined`, but `occludedBy` is only produced for a handle whose provider
   *  names an owning DOM element — and NO Canvas2D/SVG provider does. So every keyframe / bone /
   *  vertex / gizmo handle came back `occluded:false, occludedBy:null`: an affirmative "nothing
   *  covers this" for a check that never ran. Before S3.17 the field was absent (absent = unknown),
   *  so the normalisation converted a silence into a wrong answer. `computeHandles` already
   *  distinguishes the two with `occlusionChecked`; the route now honours it. */
  it('a CANVAS handle reports occlusion as UNKNOWN, not as a clean bill of health', async () => {
    const res = await post('/api/input/tap-handle', { id: 'bone.canvas' }) as { body: Record<string, unknown> };
    expect(res.body).toMatchObject({ ok: true, occluded: null, occludedBy: null, occlusionChecked: false });
    // …and it still TAPS: unknown occlusion is not a veto, exactly as a known one is not.
    expect(ops.tap).toHaveBeenCalledWith(60, 60, expect.anything());
  });

  it('drag-handle omits toTarget for a raw destination (there is no handle to inspect)', async () => {
    const res = await post('/api/input/drag-handle', { id: 'bone.0', to: { x: 400, y: 300 } }) as
      { body: { fromTarget?: unknown; toTarget?: unknown } };
    expect(res.body.fromTarget).toBeDefined();
    expect(res.body.toTarget).toBeUndefined();
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

describe('entity-aimed input (the third target surface)', () => {
  /** Editor chrome had `selector` and the canvas editors had handle ids, but a SCENE ENTITY
   *  could only be aimed at with `{x,y}` read from a previous `get_scene_state` call — the
   *  one read-then-act race the Enact design never closed. These tests pin that it is closed
   *  the same way the others are: resolved in the renderer, inside the dispatching call. */

  it('resolves the entity BEFORE dispatching the tap', async () => {
    const res = await post('/api/input/tap', { entity: { guid: 'g-puck' } });
    expect(calls).toEqual(['renderer:resolve-entity-point', 'tap(400,300)']);
    expect((res as { body: { ok: boolean } }).body.ok).toBe(true);
  });

  it('echoes WHICH entity resolved, so a {name} aim is checkable', async () => {
    const res = await post('/api/input/tap', { entity: { name: 'Puck' } });
    expect((res as { body: unknown }).body).toMatchObject({ entity: { id: 7, name: 'Puck', guid: 'g-puck', layer: '3d' } });
  });

  it('reports occlusionScope alongside occluded, so the weak check cannot read as the strong one', async () => {
    // canvas scope: `occluded:false` says nothing about a mesh in FRONT of the target.
    const mesh = await post('/api/input/tap', { entity: { guid: 'g-puck' } });
    expect((mesh as { body: unknown }).body).toMatchObject({ occluded: false, occlusionScope: 'canvas' });
    // element scope, COVERED: this used to dispatch and report {occluded:true, ok:true}. The scope
    // is still reported — on the forced path, which is the only one that presses a covered target.
    const ui = await post('/api/input/tap', { entity: { name: 'StartButton' }, allowOccluded: true });
    expect((ui as { body: unknown }).body).toMatchObject({ occluded: true, occlusionScope: 'element', hitTarget: 'div.modal' });
  });

  it('REFUSES a covered ENTITY aim, on every scope — §3 binds `entity` and `selector` alike', async () => {
    // The OLD expectation (asserted right above until 2026-08-19) was that a UI button under an
    // open modal resolves, dispatches, and comes back ok:true with occluded:true. That is the §0
    // rank-1 false success: the press went to the modal. Only the MESH half of §3's rule was
    // implemented — the picker's "another entity is in front" — while DOM-level covering was a
    // flag on all three scopes.
    const res = await post('/api/input/tap', { entity: { name: 'StartButton' } }) as { status: number; body: { error: string; code?: string } };
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OCCLUDED');
    expect(res.body.error).toMatch(/covered by div\.modal/);
    expect(res.body.error).toMatch(/allowOccluded/);
    expect(ops.tap).not.toHaveBeenCalled();
  });

  it('NOTHING at the point gets its own remedy — you cannot dismiss "nothing"', async () => {
    // centreIsInWindow admits x === innerWidth while elementFromPoint is exclusive at that edge, so
    // a rect flush against the right/bottom of the window resolves to a point with no element at
    // all. The generic message told the caller to "dismiss/move what covers it" — which the same
    // sentence calls "nothing".
    const res = await post('/api/input/tap', { entity: { name: 'EdgeCube', surface: 'game-3d' } }) as { status: number; body: { error: string } };
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/NOTHING at it/);
    expect(res.body.error).toMatch(/Move the camera/);
    expect(res.body.error).not.toMatch(/Dismiss\/move what covers it/);
    expect(ops.tap).not.toHaveBeenCalled();
  });

  it('refuses a covered entity aim on hover, scroll and BOTH drag endpoints too, not just tap', async () => {
    // The guard is shared, but nothing asserted it for these routes — only selector-addressed
    // covers were tested there, so an entity-specific regression could pass the suite.
    const hover = await post('/api/input/hover', { entity: { name: 'StartButton' } }) as { status: number };
    const scroll = await post('/api/input/scroll', { entity: { name: 'StartButton' }, deltaY: 100 }) as { status: number };
    const dragFrom = await post('/api/input/drag', { from: { entity: { name: 'StartButton' } }, to: { x: 5, y: 5 } }) as { status: number };
    const dragTo = await post('/api/input/drag', { from: { x: 5, y: 5 }, to: { entity: { name: 'StartButton' } } }) as { status: number };
    expect([hover.status, scroll.status, dragFrom.status, dragTo.status]).toEqual([400, 400, 400, 400]);
    expect(ops.hover).not.toHaveBeenCalled();
    expect(ops.scroll).not.toHaveBeenCalled();
    expect(ops.drag).not.toHaveBeenCalled();
  });

  it("the 'entity' scope refuses when the picker FOUND the target but a modal covers the canvas", async () => {
    // Two independent occluders, and only the mesh one was ever refused: the pick succeeds, so the
    // surface WOULD select the entity — but the click never reaches the canvas at all.
    const res = await post('/api/input/tap', { entity: { name: 'CoveredHero', surface: 'scene-view' } }) as { status: number; body: { error: string } };
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/covered by div\.modal/);
    expect(ops.tap).not.toHaveBeenCalled();
  });

  it('one flag, one answer: entity.allowOccluded:false + top-level true refuses BOTH kinds of cover', async () => {
    // §9 — the merge was written twice and the copies disagreed in exactly this combination.
    // `resolvePoint` sends the renderer `entity.allowOccluded ?? allowOccluded` = false, so
    // entityResolve refuses a PICKER-occluded aim; a re-derived `!false && !true` in the route
    // waved a DOM-occluded one through. Which cover was in the way decided the behaviour.
    const res = await post('/api/input/tap', {
      entity: { name: 'StartButton', allowOccluded: false }, allowOccluded: true,
    }) as { status: number; body: { code?: string } };
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OCCLUDED');
    expect(ops.tap).not.toHaveBeenCalled();
  });

  it('…and a held gesture\'s move/up is never refused — it goes to whatever captured the press', async () => {
    // The one carve-out §3 names, and it is about DELIVERY rather than aim: what sits under the
    // destination cannot stop a captured drag. inputRoutes forces allowOccluded for non-`down`.
    await post('/api/input/pointer', { action: 'down', entity: { guid: 'g-puck' } });
    const moved = await post('/api/input/pointer', { action: 'move', entity: { name: 'StartButton' } }) as { status: number };
    expect(moved.status).not.toBe(400);
    expect(ops.pointerMove).toHaveBeenCalled();
  });

  it('…and an explicit entity.allowOccluded:false does NOT re-impose a refusal on that move', async () => {
    // The carve-out is about DELIVERY — the press already captured the target — so it overrides
    // the caller's flag instead of losing to it via `??`. Before this, the top-level force reached
    // only the top-level field and the explicit false won at the entity layer, refusing a move
    // mid-gesture and stranding the held press.
    await post('/api/input/pointer', { action: 'down', entity: { guid: 'g-puck' } });
    const moved = await post('/api/input/pointer', {
      action: 'move', entity: { name: 'StartButton', allowOccluded: false },
    }) as { status: number };
    expect(moved.status).not.toBe(400);
    expect(ops.pointerMove).toHaveBeenCalled();
    await post('/api/input/pointer', { action: 'up', entity: { guid: 'g-puck' } });
  });

  it('refuses an ambiguous name instead of picking one — and dispatches nothing', async () => {
    const res = await post('/api/input/tap', { entity: { name: 'Enemy' } });
    expect((res as { status: number }).status).toBe(400);
    expect((res as { body: { error: string } }).body.error).toContain('address by guid');
    expect(calls).toEqual(['renderer:resolve-entity-point']);
  });

  it('takes precedence over selector and {x,y}', async () => {
    await post('/api/input/tap', { entity: { guid: 'g-puck' }, selector: '#kebab', x: 1, y: 2 });
    expect(calls).toEqual(['renderer:resolve-entity-point', 'tap(400,300)']);
  });

  it('an EMPTY entity object falls through to the other aim modes', async () => {
    // `{}` is what a caller sends when it built the field conditionally and had nothing to
    // put in it. Treating that as "aim at entity" would fail every such call with a confusing
    // "provide an entity" while a perfectly good selector sat right beside it.
    await post('/api/input/tap', { entity: {}, selector: '#kebab' });
    expect(calls).toEqual(['renderer:resolve-dom-point', 'tap(210,110)']);
  });

  it('works on hover, scroll, and the sustained pointer too', async () => {
    await post('/api/input/hover', { entity: { guid: 'g-puck' } });
    expect(calls).toContain('hover(400,300)');
    calls.length = 0;
    await post('/api/input/scroll', { entity: { guid: 'g-puck' }, deltaY: 120 });
    expect(calls).toContain('scroll(400,300,0,120)');
    calls.length = 0;
    await post('/api/input/pointer', { action: 'down', entity: { guid: 'g-puck' } });
    expect(calls).toContain('pdown(400,300,left)');
  });

  it('aims BOTH drag endpoints', async () => {
    await post('/api/input/drag', { from: { entity: { guid: 'g-puck' } }, to: { selector: '#kebab' } });
    expect(calls).toEqual([
      'renderer:resolve-entity-point', 'renderer:resolve-dom-point', 'drag(400,300\u2192210,110)',
    ]);
  });

  // F15 (docs/enact.md): an occluded 'entity'-scope aim is a REFUSAL by default, and
  // `allowOccluded` is the escape hatch \u2014 verified here at the HOST seam (the resolver's own
  // decision is pinned in `entityResolve.test.ts`; this checks the route forwards the flag and
  // turns the refusal into a 400 with nothing dispatched).
  it('REFUSES (400) an occluded entity aim by default, and dispatches nothing', async () => {
    const res = await post('/api/input/tap', { entity: { guid: 'g-hero' } });
    expect((res as { status: number }).status).toBe(400);
    expect((res as { body: { error: string } }).body.error).toContain('Wall');
    expect((res as { body: { error: string } }).body.error).toContain('allowOccluded');
    expect(calls).toEqual(['renderer:resolve-entity-point']); // the tap op was never called
  });

  it('threads `allowOccluded` through to the resolver, and reports what was actually hit', async () => {
    const res = await post('/api/input/tap', { entity: { guid: 'g-hero', allowOccluded: true } });
    expect((res as { status?: number }).status).toBeUndefined(); // 200 (no explicit status = ok)
    expect((res as { body: unknown }).body).toMatchObject({
      ok: true, occluded: true, occlusionScope: 'entity',
      occludedByEntity: { id: 12, name: 'Wall', guid: 'g-wall' },
      aimedAt: 'centre',
    });
    expect(calls).toEqual(['renderer:resolve-entity-point', 'tap(500,250)']); // dispatched this time
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
    const r = await post('/api/input/key', { key: 'w', panel: 'scene' }) as { body: unknown };
    expect(r.body).toMatchObject({ ok: true, focusedPanel: 'scene' });
    expect(calls).toEqual(['renderer:set-focus-scope', 'key(w)']);
  });

  it('FAILS LOUDLY when the panel is not open, and does NOT press the key', async () => {
    // The silent-failure this exists to prevent: a panel-scoped chord sent at the wrong
    // panel is simply yielded by the dispatcher, so it looks like a successful no-op.
    const r = await post('/api/input/key', { key: 'w', panel: 'not-open' }) as { status: number; body: { error: string } };
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain('could not focus panel "not-open"');
    expect(ops.pressKey).not.toHaveBeenCalled();
  });

  it('leaves the key path untouched when no panel is given', async () => {
    const r = await post('/api/input/key', { key: 'z', modifiers: ['meta'] }) as { body: unknown };
    expect(r.body).toMatchObject({ ok: true, pressed: { key: 'z' } });
    expect(r.body).not.toHaveProperty('focusedPanel');
    expect(calls).toEqual(['key(z)']);
  });

  it('focus accepts a panel WITHOUT touching DOM focus', async () => {
    // Keyboard scope and document.activeElement are different questions — clicking a
    // Hierarchy row moves the scope but leaves activeElement on <body>.
    const r = await post('/api/input/focus', { panel: 'hierarchy' }) as { body: unknown };
    expect(r.body).toMatchObject({ ok: true, focusedPanel: 'hierarchy' });
    expect(ops.focusElement).not.toHaveBeenCalled();
  });

  it('focus can set BOTH scope and DOM focus, scope first', async () => {
    await post('/api/input/focus', { panel: 'assets', selector: '#kebab' });
    expect(calls).toEqual(['renderer:set-focus-scope', 'focus(#kebab)']);
  });

  it('focus with no args still blurs (unchanged)', async () => {
    const r = await post('/api/input/focus', {}) as { body: unknown };
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

/** A HIDDEN window swallows trusted input whole — Chromium delivers nothing at all while
 *  `document.visibilityState === 'hidden'` (the editor occluded by another app, or minimised).
 *  Before this gate every route answered `ok:true, occluded:false` for input that never
 *  arrived, which is the exact silent-miss class the provenance fields exist to remove: the
 *  reply described what the call AIMED at, not what landed. Measured live 2026-08-18 on backend
 *  5183 — three taps, zero events on a capture-phase `document` listener; raising the window
 *  made the identical call land.
 *
 *  ⚠️ These tests MOCK `visibilityState:'hidden'`, so they still pin the gate exactly — but do
 *  not read them as evidence that a covered window reaches it. Later on 2026-08-18, #243 added
 *  `disable-backgrounding-occluded-windows`, after which a covered window measures 'visible' at
 *  61fps and a MINIMISED one delivers a trusted tap. The gate is near-unreachable on macOS now;
 *  it is kept for the states nobody has measured. See `inputDeliverability` in inputRoutes.ts. */
describe('window deliverability', () => {
  const ROUTES: [string, unknown][] = [
    ['/api/input/tap', { x: 1, y: 2 }],
    ['/api/input/drag', { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }],
    ['/api/input/pointer', { action: 'down', x: 1, y: 2 }],
    ['/api/input/hover', { x: 1, y: 2 }],
    ['/api/input/scroll', { x: 1, y: 2, deltaY: 120 }],
    ['/api/input/key', { key: 'Escape' }],
    ['/api/input/type', { text: 'hi' }],
    ['/api/input/tap-handle', { id: 'bone.0' }],
    ['/api/input/drag-handle', { id: 'bone.0', delta: { dx: 5, dy: 5 } }],
  ];

  it.each(ROUTES)('%s REFUSES while the window is hidden, and dispatches nothing', async (urlPath, body) => {
    requestRenderer = makeRenderer({ 'input-deliverability': { visibilityState: 'hidden', hasFocus: false } });
    routes = createInputRoutes({ ops, requestRenderer });
    const res = await post(urlPath, body);
    expect(res).toMatchObject({ kind: 'json', status: 409, body: { ok: false, code: 'REFUSED_BY_OP', windowVisibility: 'hidden' } });
    // The message names the OBSERVED state, not a guessed cause. It used to assert
    // "HIDDEN/OCCLUDED ... raise the editor window", and #243 made both halves wrong on macOS:
    // `disable-backgrounding-occluded-windows` keeps a covered AND a minimised window at
    // 'visible' (a trusted tap was measured landing while minimised), so occlusion no longer
    // reaches this branch and raising the window is no longer the remedy. Telling a reader to
    // un-cover a window sends them hunting a cause that cannot apply — the failure mode this
    // repo already names: an error message that guesses a cause is worse than one that reports.
    const err = (res as { body: { error: string } }).body.error;
    expect(err).toMatch(/visibilityState "hidden"/);
    expect(err).toMatch(/#243/);
    expect(err).not.toMatch(/Raise the editor window/);
    // Nothing was dispatched, and nothing was even resolved — the refusal is BEFORE the aim.
    expect(calls).toEqual([]);
    // ...and no attribution lease was opened for a dispatch that never happened.
    expect(leaseCalls).toEqual([]);
  });

  it('EXEMPTS /api/input/focus — it dispatches no OS input, so the refusal would be a false claim', () => {
    // `focusElement` is `wc.focus()` + executeJavaScript, which a hidden window still runs. The
    // refusal's stated reason ("Chromium would drop this input") is simply untrue for this route,
    // and a refusal whose cause is false is worse than either answer.
    return (async () => {
      requestRenderer = makeRenderer({ 'input-deliverability': { visibilityState: 'hidden', hasFocus: false } });
      routes = createInputRoutes({ ops, requestRenderer });
      const res = await post('/api/input/focus', { selector: '#kebab' });
      expect(ops.focusElement).toHaveBeenCalledWith('#kebab');
      expect(res).toMatchObject({ kind: 'json', body: { ok: true } });
    })();
  });

  it('an UNRECOGNISED /api/input/* path still falls through while hidden, instead of 409-ing', async () => {
    // The gate must not answer for a path this file does not own — the caller has other handlers
    // to try, and a 409 here would swallow the request whenever the window happened to be hidden.
    requestRenderer = makeRenderer({ 'input-deliverability': { visibilityState: 'hidden', hasFocus: false } });
    routes = createInputRoutes({ ops, requestRenderer });
    expect(await post('/api/input/unknown', {})).toBeNull();
    expect(calls).toEqual([]);
  });

  it('a VISIBLE but unfocused window still dispatches, and says so', async () => {
    // The weaker sibling: input arrives, but Chromium fires no focus/blur/focusin/focusout, so
    // anything the editor does ON a focus event (commit-on-blur, for one) silently does not
    // happen. That is a report, not a veto — the input itself is real.
    requestRenderer = makeRenderer({ 'input-deliverability': { visibilityState: 'visible', hasFocus: false } });
    routes = createInputRoutes({ ops, requestRenderer });
    const res = await post('/api/input/tap', { x: 5, y: 6 });
    expect(ops.tap).toHaveBeenCalledWith(5, 6, expect.anything());
    expect(res).toMatchObject({ kind: 'json', body: { ok: true, windowFocused: false } });
  });

  it('a focused, visible window adds no noise to the response', async () => {
    const res = await post('/api/input/tap', { x: 5, y: 6 });
    expect((res as { body: Record<string, unknown> }).body.windowFocused).toBeUndefined();
    expect((res as { body: Record<string, unknown> }).body.windowVisibility).toBeUndefined();
  });

  it('dispatches when the renderer cannot answer at all — an unknown state must not veto input', async () => {
    // Same rule as the attribution lease: a renderer mid-reload, or one too old to know the op,
    // must not be able to break input. An unqualified tap is a missing hint; a refused one is a
    // broken tool.
    requestRenderer = makeRenderer({ 'input-deliverability': null });
    routes = createInputRoutes({ ops, requestRenderer });
    const res = await post('/api/input/tap', { x: 7, y: 8 });
    expect(ops.tap).toHaveBeenCalledWith(7, 8, expect.anything());
    expect(res).toMatchObject({ body: { ok: true } });
  });
});
