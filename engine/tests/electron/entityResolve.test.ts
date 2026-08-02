// @vitest-environment jsdom
/** Unit: `entityResolve` — turning `{guid}`/`{name}`/`{id}` into a point, and reporting how far
 *  the occlusion check could actually see.
 *
 *  This is the half `inputRoutes.test.ts` cannot reach: those tests drive a FAKE renderer, so
 *  they pin the host seam (resolve-before-dispatch, precedence, provenance passthrough) while
 *  every decision that matters — ambiguity, off-screen, zero rect, UI-vs-canvas — lives here.
 *
 *  Everything this file asserts is a REFUSAL or a qualification, and that is the point. The
 *  failure being designed out is not a crash; it is a click that lands somewhere plausible and
 *  reports success. `getAllEntities`/`collectScreenBounds` are mocked (no ECS world, no
 *  renderer) and jsdom's rects/hit-test are stubbed, exactly as `domResolve.test.ts` does. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getAllEntities = vi.fn();
const collectScreenBounds = vi.fn();
// F15 (docs/enact.md): the surface's own hit-test, as `entityResolve.ts` now consults it.
// Defaults to `undefined` (no picker registered) so every PRE-EXISTING test in this file keeps
// exercising the old `occlusionScope:'canvas'` fallback unchanged — only the tests that opt in by
// setting a return value exercise the new `'entity'` scope.
const pickAt = vi.fn();
vi.mock('@modoki/engine/runtime', () => ({
  getAllEntities: (...a: unknown[]) => getAllEntities(...a),
  collectScreenBounds: (...a: unknown[]) => collectScreenBounds(...a),
  pickAt: (...a: unknown[]) => pickAt(...a),
}));

const { resolveEntityPointReport } = await import('../../app/debug/entityResolve');

type Ent = { id: number; name: string; guid?: string; layer?: '2d' | '3d' | 'ui'; parentId?: number };

const PUCK: Ent = { id: 7, name: 'Puck', guid: 'g-puck', layer: '3d' };
const BUTTON: Ent = { id: 9, name: 'StartButton', guid: 'g-start', layer: 'ui' };

/** A 3D entity's bounds as the registered providers would report them. */
const bounds = (over: Partial<{ screen: { x: number; y: number; w: number; h: number } | null; onScreen: boolean }> = {}) => [{
  id: 7, layer: '3d' as const, surface: 'game-3d', screen: { x: 380, y: 280, w: 40, h: 40 }, onScreen: true, ...over,
}];

/** A 3D aim, with the surface a 2D/3D aim now REQUIRES. Spelled out via a helper so the tests read
 *  as "aim at the puck" and the mandatory parameter does not drown the assertion. */
const aimPuck = (spec: Record<string, unknown> = {}) => resolveEntityPointReport({ guid: 'g-puck', surface: 'game-3d', ...spec });

function stubRect(el: Element, r: { left: number; top: number; width: number; height: number }) {
  el.getBoundingClientRect = () => ({
    left: r.left, top: r.top, width: r.width, height: r.height,
    right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => ({}),
  }) as DOMRect;
}
const stubTopmost = (el: Element | null) => { document.elementFromPoint = () => el as Element; };

beforeEach(() => {
  document.body.innerHTML = '';
  // mockReset, not just mockReturnValue: these are module-level vi.fn()s, so `restoreAllMocks`
  // leaves their CALL HISTORY intact and any "was it called?" assertion would silently read
  // calls from an earlier test.
  getAllEntities.mockReset().mockReturnValue([PUCK, BUTTON]);
  collectScreenBounds.mockReset().mockReturnValue(bounds());
  pickAt.mockReset().mockReturnValue(undefined); // no picker registered — the pre-existing default
  // jsdom has no layout; give the window a viewport so the in-window guard has something real
  // to compare against.
  Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('addressing', () => {
  it('resolves by guid', () => {
    stubTopmost(document.createElement('canvas'));
    expect(aimPuck()).toMatchObject({ ok: true, entity: { id: 7 } });
  });

  it('resolves by unique name', () => {
    stubTopmost(document.createElement('canvas'));
    expect(resolveEntityPointReport({ name: 'Puck', surface: 'game-3d' })).toMatchObject({ ok: true, entity: { guid: 'g-puck' } });
  });

  it('REFUSES an ambiguous name instead of taking the first match', () => {
    // The whole reason this is an error: three entities called "Enemy" and a first-match rule
    // gives a click that succeeds on the wrong one, indistinguishable from success.
    getAllEntities.mockReturnValue([
      { id: 1, name: 'Enemy', guid: 'g-a', layer: '3d' },
      { id: 2, name: 'Enemy', guid: 'g-b', layer: '3d' },
    ]);
    const r = resolveEntityPointReport({ name: 'Enemy', surface: 'game-3d' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('2 entities are named');
    expect(r.error).toContain('address by guid');
  });

  it('resolves by id, but guid wins when both are given', () => {
    stubTopmost(document.createElement('canvas'));
    expect(resolveEntityPointReport({ id: 7, surface: 'game-3d' })).toMatchObject({ ok: true, entity: { id: 7 } });
    // A stale id alongside a guid must not steer the aim — ids are reassigned on every reload.
    getAllEntities.mockReturnValue([PUCK, { ...BUTTON, id: 7, guid: 'g-other' }]);
    expect(aimPuck({ id: 7 })).toMatchObject({ entity: { guid: 'g-puck' } });
  });

  it('reports a miss as a result, never a throw', () => {
    expect(resolveEntityPointReport({ guid: 'nope', surface: 'game-3d' })).toMatchObject({ ok: false, error: expect.stringContaining('no entity with guid') });
    expect(resolveEntityPointReport({})).toMatchObject({ ok: false, error: expect.stringContaining('provide an entity') });
  });
});

describe('2D/3D entities (canvas scope)', () => {
  it('aims at the centre of the projected rect', () => {
    stubTopmost(document.createElement('canvas'));
    expect(aimPuck()).toMatchObject({ ok: true, x: 400, y: 300 });
  });

  it('reports occlusionScope "canvas" — the weaker guarantee, stated as such', () => {
    stubTopmost(document.createElement('canvas'));
    const r = aimPuck();
    // `occluded:false` here means "the click reaches the canvas", NOT "nothing is in front of
    // the mesh". The scope field is what stops the two being confused.
    expect(r).toMatchObject({ occluded: false, occlusionScope: 'canvas', hitTarget: 'canvas' });
  });

  it('detects a panel covering the canvas', () => {
    const overlay = document.createElement('div');
    overlay.id = 'modal';
    stubTopmost(overlay);
    expect(aimPuck()).toMatchObject({ occluded: true, hitTarget: 'div#modal' });
  });

  it('treats a child of the canvas as reaching it', () => {
    const canvas = document.createElement('canvas');
    const inner = document.createElement('span');
    canvas.appendChild(inner);
    document.body.appendChild(canvas);
    stubTopmost(inner);
    expect(aimPuck()).toMatchObject({ occluded: false });
  });

  it('REFUSES an off-screen entity rather than clicking where it would be', () => {
    collectScreenBounds.mockReturnValue(bounds({ onScreen: false }));
    const r = aimPuck();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('off-screen');
  });

  it('REFUSES a zero-size projection', () => {
    collectScreenBounds.mockReturnValue(bounds({ screen: { x: 10, y: 10, w: 0, h: 0 } }));
    expect(aimPuck()).toMatchObject({ ok: false, error: expect.stringContaining('zero-size') });
  });

  it('REFUSES when the rect overlaps the viewport but its CENTRE does not', () => {
    // The subtle one. `onScreen` only means the rect INTERSECTS the viewport, so a mostly
    // off-screen mesh can be "on screen" with a centre outside the window — clicking it would
    // land outside the window entirely. Clamping to the edge would look like success.
    collectScreenBounds.mockReturnValue(bounds({ screen: { x: -400, y: 300, w: 380, h: 40 }, onScreen: true }));
    const r = aimPuck();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('only partly visible');
  });

  it('explains a missing bounds provider instead of failing opaquely', () => {
    collectScreenBounds.mockReturnValue([]);
    expect(aimPuck()).toMatchObject({
      ok: false, error: expect.stringContaining('no screen bounds'),
    });
  });
});

describe('UI entities (element scope)', () => {
  function mountButton() {
    const el = document.createElement('div');
    el.setAttribute('data-entity-id', '9');
    el.id = 'start';
    document.body.appendChild(el);
    stubRect(el, { left: 100, top: 60, width: 40, height: 40 });
    return el;
  }

  it('uses the real DOM rect, and reports element scope', () => {
    const el = mountButton();
    stubTopmost(el);
    expect(resolveEntityPointReport({ guid: 'g-start' })).toMatchObject({
      ok: true, x: 120, y: 80, occluded: false, occlusionScope: 'element',
    });
  });

  it('detects an element-level cover — the guarantee canvas scope cannot make', () => {
    mountButton();
    const modal = document.createElement('div');
    modal.className = 'modal';
    stubTopmost(modal);
    expect(resolveEntityPointReport({ guid: 'g-start' })).toMatchObject({
      occluded: true, occlusionScope: 'element', hitTarget: 'div.modal',
    });
  });

  it('does NOT treat a descendant as occlusion (the event still bubbles)', () => {
    const el = mountButton();
    const label = document.createElement('span');
    el.appendChild(label);
    stubTopmost(label);
    expect(resolveEntityPointReport({ guid: 'g-start' })).toMatchObject({ occluded: false });
  });

  it('REFUSES a UI entity with no rendered node', () => {
    // No DOM node mounted: the entity exists in the ECS but isn't on screen.
    expect(resolveEntityPointReport({ guid: 'g-start' })).toMatchObject({
      ok: false, error: expect.stringContaining('no rendered DOM node'),
    });
  });

  it('REFUSES a zero-rect node (hidden / not laid out)', () => {
    const el = mountButton();
    stubRect(el, { left: 0, top: 0, width: 0, height: 0 });
    stubTopmost(el);
    expect(resolveEntityPointReport({ guid: 'g-start' })).toMatchObject({
      ok: false, error: expect.stringContaining('zero-size rect'),
    });
  });

  it('never consults the bounds providers for a UI entity', () => {
    const el = mountButton();
    stubTopmost(el);
    resolveEntityPointReport({ guid: 'g-start' });
    expect(collectScreenBounds).not.toHaveBeenCalled();
  });
});

/** Several surfaces, one entity — the case that silently mis-aimed.
 *
 *  `collectScreenBounds` returns a rect PER PROVIDER, and one entity routinely has more than
 *  one: with the editor's Scene and Game panels both open, every 3D entity is measured twice
 *  through two different cameras. MEASURED live on `games/3d-test` (backend 5181), entity
 *  `cube`, `get_layout_bounds ids=[2]` → `count: 2`, `{x:755,y:312,w:47,h:45}` and
 *  `{x:76,y:-63,w:496,h:372}`, both `onScreen: true`.
 *
 *  The old code did `.find()` and aimed at whichever came first — i.e. it chose between two
 *  live answers by Set iteration order, and when it chose the panel that is not on top the
 *  click landed in the wrong viewport and still reported success. These pin the replacement:
 *  choose only when the choice is forced, otherwise REFUSE and say what the options are. */
describe('multi-surface entities', () => {
  const twoSurfaces = [
    { id: 7, layer: '3d' as const, surface: 'game-3d', screen: { x: 755, y: 312, w: 47, h: 45 }, onScreen: true },
    { id: 7, layer: '3d' as const, surface: 'scene-view', screen: { x: 76, y: 60, w: 496, h: 372 }, onScreen: true },
  ];

  it('REFUSES a 2D/3D aim with NO surface, and names the ones on screen', () => {
    // The refusal is about the MISSING parameter, not about the count — see the single-surface
    // test below. Naming what is actually measured is what turns one round trip into the fix.
    collectScreenBounds.mockReturnValue(twoSurfaces);
    const r = resolveEntityPointReport({ guid: 'g-puck' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must say WHICH on-screen surface/);
    expect(r.error).toMatch(/'game-3d'/);
    expect(r.error).toMatch(/'scene-view'/);
    // The error must carry the fix, not just the complaint.
    expect(r.error).toMatch(/Pass surface:'game-3d'/);
  });

  it('REFUSES a 2D/3D aim with no surface even when only ONE surface has the entity', () => {
    // The dangerous half, and the reason this is required rather than merely disambiguating.
    // Succeeding here would confirm an aim the caller never specified: an agent that believed it
    // was clicking the GameView, while only the SceneView had the entity, would get `ok:true` and
    // a wrong belief — recorded only in a `surface` field it had no reason to re-read.
    collectScreenBounds.mockReturnValue([twoSurfaces[1]]);
    const r = resolveEntityPointReport({ guid: 'g-puck' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must say WHICH on-screen surface/);
    expect(r.error).toMatch(/only one/); // says why it is required anyway
  });

  it('aims when `surface` picks one — and the point is that surface\'s, not the other\'s', () => {
    collectScreenBounds.mockReturnValue(twoSurfaces);
    stubTopmost(document.createElement('canvas'));
    expect(resolveEntityPointReport({ guid: 'g-puck', surface: 'scene-view' }))
      .toMatchObject({ ok: true, x: 324, y: 246, surface: 'scene-view' });
    expect(resolveEntityPointReport({ guid: 'g-puck', surface: 'game-3d' }))
      .toMatchObject({ ok: true, x: 778.5, y: 334.5, surface: 'game-3d' });
  });

  it('reports `surface` on the ordinary single-surface aim too', () => {
    // Not only in the ambiguous case: "I tapped the cube" is unverifiable without knowing
    // WHICH on-screen cube was tapped, and in the editor there are routinely two.
    collectScreenBounds.mockReturnValue([{ ...bounds()[0], surface: 'game-3d' }]);
    stubTopmost(document.createElement('canvas'));
    expect(aimPuck()).toMatchObject({ ok: true, surface: 'game-3d' });
  });

  it('does NOT refuse when only ONE of the surfaces is actually aimable', () => {
    // Ambiguity is about a real CHOICE. An off-screen rect in the other panel is not a choice,
    // and refusing there would break the common "the Game panel is showing it, the Scene panel
    // is looking elsewhere" case.
    collectScreenBounds.mockReturnValue([
      twoSurfaces[0],
      { ...twoSurfaces[1], onScreen: false },
    ]);
    stubTopmost(document.createElement('canvas'));
    expect(aimPuck()).toMatchObject({ ok: true, surface: 'game-3d' });
  });

  it('explains WHY the chosen surface is not aimable, naming that surface', () => {
    // Scoped to the surface asked for: reporting the OTHER panel's reason would answer a question
    // the caller did not ask.
    collectScreenBounds.mockReturnValue([
      { ...twoSurfaces[0], onScreen: false },
      { ...twoSurfaces[1], screen: { x: 10, y: 10, w: 0, h: 0 } },
    ]);
    expect(resolveEntityPointReport({ guid: 'g-puck', surface: 'game-3d' }).error).toMatch(/game-3d: off-screen/);
    expect(resolveEntityPointReport({ guid: 'g-puck', surface: 'scene-view' }).error).toMatch(/scene-view: zero-size/);
  });

  it('rejects a `surface` the entity is not measured in, listing the ones it IS', () => {
    collectScreenBounds.mockReturnValue(twoSurfaces);
    const r = resolveEntityPointReport({ guid: 'g-puck', surface: 'game-2d' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no bounds in surface 'game-2d'/);
    expect(r.error).toMatch(/game-3d, scene-view/);
  });

  it('names an UNLABELLED provider rather than dropping it from the message', () => {
    // A provider that forgets `surface` must still appear in the "which surface?" list — otherwise
    // the fix for this bug silently hides the next one like it.
    collectScreenBounds.mockReturnValue([twoSurfaces[0], { ...twoSurfaces[1], surface: undefined }]);
    expect(resolveEntityPointReport({ guid: 'g-puck' }).error).toMatch(/unlabelled-3d/);
  });

  /** REGRESSION (independent review, 2026-07-30). This block used to assert the OPPOSITE — that a
   *  UI entity "is one DOM node: nothing to choose", and that `surface` is refused on that ground.
   *  It is not one node. The editor mounts a UIRenderer in BOTH SceneView's
   *  `[data-ui-preview-frame]` and GameView's `[data-game-view-area]`, and every UINode stamps
   *  `data-entity-id` — so with both panels open the aim took `querySelector`'s first match in
   *  document order and reported success, while `surface` (the one way to say which was meant) was
   *  rejected. A tap intended for the running game could land in the Scene panel's preview. */
  function mountIn(host: 'preview' | 'game' | null, id = '9'): Element {
    const frame = document.createElement('div');
    if (host === 'preview') frame.setAttribute('data-ui-preview-frame', '');
    if (host === 'game') frame.setAttribute('data-game-view-area', '');
    const el = document.createElement('div');
    el.setAttribute('data-entity-id', id);
    frame.appendChild(el);
    document.body.appendChild(frame);
    stubRect(el, { left: 10, top: 20, width: 100, height: 40 });
    return el;
  }

  it('REFUSES a UI aim that is rendered in TWO hosts, naming both', () => {
    mountIn('preview');
    const inGame = mountIn('game');
    stubTopmost(inGame);
    const r = resolveEntityPointReport({ guid: 'g-start' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rendered in 2 surfaces/);
    expect(r.error).toMatch(/scene-view/);
    expect(r.error).toMatch(/game-ui/);
  });

  it('aims in the surface the caller names, not the first in document order', () => {
    // The preview frame is appended FIRST, so document order would pick it. Asking for the game
    // surface must get the game node — that is the whole bug.
    mountIn('preview');
    const inGame = mountIn('game');
    stubRect(inGame, { left: 500, top: 300, width: 40, height: 20 });
    stubTopmost(inGame);
    expect(resolveEntityPointReport({ guid: 'g-start', surface: 'game-ui' }))
      .toMatchObject({ ok: true, x: 520, y: 310, surface: 'game-ui', occlusionScope: 'element' });
  });

  it('a SINGLE-host UI aim still works without `surface`, and echoes which it used', () => {
    // Unlike 2D/3D, `surface` is not demanded when there is only one node: a shipped game has
    // exactly one, so requiring it there would break correct calls to buy nothing.
    const el = mountIn('game');
    stubTopmost(el);
    expect(resolveEntityPointReport({ guid: 'g-start' }))
      .toMatchObject({ ok: true, surface: 'game-ui', occlusionScope: 'element' });
  });

  it('a UI node in NEITHER known host is labelled unlabelled-ui, not guessed at', () => {
    const el = mountIn(null);
    stubTopmost(el);
    expect(resolveEntityPointReport({ guid: 'g-start' })).toMatchObject({ ok: true, surface: 'unlabelled-ui' });
  });

  it('CORRECTS a caller who names a surface the entity is not in', () => {
    const el = mountIn('game');
    stubTopmost(el);
    const r = resolveEntityPointReport({ guid: 'g-start', surface: 'scene-view' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rendered only in 'game-ui'/);
  });
});

/** F15 — see `docs/enact.md`. `pickAt` is the
 *  surface's own hit-test; every test above leaves it at the default `undefined` ("no picker"),
 *  which is exactly the pre-existing `'canvas'`-scope behaviour these tests pin as unchanged. The
 *  ones below opt IN by giving `pickAt` a return value, exercising the `'entity'` scope it unlocks. */
describe('2D/3D entities with a pick provider (entity scope)', () => {
  it('centre-hit: occluded:false, occlusionScope "entity", aimedAt "centre"', () => {
    stubTopmost(document.createElement('canvas'));
    pickAt.mockReturnValue(7); // the surface's hit-test says the puck itself is at the aim point
    expect(aimPuck()).toMatchObject({ ok: true, occluded: false, occlusionScope: 'entity', aimedAt: 'centre' });
  });

  it('an occluder in front REFUSES, naming the covering ENTITY (not the canvas)', () => {
    getAllEntities.mockReturnValue([PUCK, BUTTON, { id: 99, name: 'Wall', guid: 'g-wall', layer: '3d' }]);
    stubTopmost(document.createElement('canvas'));
    pickAt.mockReturnValue(99); // the wall, every sample
    const r = aimPuck();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Wall');
    expect(r.error).toContain('allowOccluded:true'); // the escape hatch is discoverable from the error
  });

  it('the SAME call with allowOccluded:true dispatches and reports what was actually hit', () => {
    getAllEntities.mockReturnValue([PUCK, BUTTON, { id: 99, name: 'Wall', guid: 'g-wall', layer: '3d' }]);
    stubTopmost(document.createElement('canvas'));
    pickAt.mockReturnValue(99);
    const r = aimPuck({ allowOccluded: true });
    expect(r).toMatchObject({ ok: true, occluded: true, occlusionScope: 'entity' });
    expect(r.occludedByEntity).toMatchObject({ id: 99, name: 'Wall', guid: 'g-wall' });
  });

  it('a concave shape whose AABB centre misses is found via the sampled search', () => {
    // The centre pick misses (torus/L-shape/crescent case); the first sample thereafter hits.
    stubTopmost(document.createElement('canvas'));
    let call = 0;
    pickAt.mockImplementation(() => { call++; return call === 1 ? null : 7; });
    const r = aimPuck();
    expect(r).toMatchObject({ ok: true, occluded: false, occlusionScope: 'entity', aimedAt: 'sampled' });
    expect(r.samplesTried).toBeGreaterThan(1);
  });

  it('fully hidden REFUSES with a message distinct from the off-screen refusal', () => {
    // Every sample (centre + the whole grid) reports the wall, never the puck — nothing found it.
    getAllEntities.mockReturnValue([PUCK, BUTTON, { id: 99, name: 'Wall', guid: 'g-wall', layer: '3d' }]);
    stubTopmost(document.createElement('canvas'));
    pickAt.mockReturnValue(99);
    const r = aimPuck();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('is not clickable');
    expect(r.error).not.toContain('off-screen');
    // Distinct from the actual off-screen refusal message (separate code path, asserted above).
    const offscreen = (() => {
      collectScreenBounds.mockReturnValue(bounds({ onScreen: false }));
      return aimPuck();
    })();
    expect(offscreen.error).not.toBe(r.error);
  });

  it('a hit on a CHILD entity of the target counts as hitting the target', () => {
    // A model is routinely one parent entity with its parts as children; the picker answers with
    // whichever part the ray struck, so an exact-id match would call this occluded by its own arm.
    getAllEntities.mockReturnValue([PUCK, BUTTON, { id: 8, name: 'Arm', guid: 'g-arm', layer: '3d', parentId: 7 }]);
    stubTopmost(document.createElement('canvas'));
    pickAt.mockReturnValue(8);
    expect(aimPuck()).toMatchObject({ ok: true, occluded: false, occlusionScope: 'entity' });
  });

  it('a surface with NO registered picker keeps the "canvas" fallback — the call still succeeds', () => {
    stubTopmost(document.createElement('canvas'));
    pickAt.mockReturnValue(undefined); // explicit, though it is also the describe-level default
    expect(aimPuck()).toMatchObject({ ok: true, occlusionScope: 'canvas' });
  });
});
