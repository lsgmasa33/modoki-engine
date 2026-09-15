/** #1223 P3 / #1216 P1-1 — the DEVICE page aims at an entity.
 *
 *  `bridge.ts`'s `resolveAim` handled only a selector and screenshot pixels, so `device_tap` and its
 *  siblings could reach a 2D/3D game entity only by coordinates read off an earlier screenshot, while
 *  `resolve-entity-point` sat registered on the device unused. These pin what the page PUTS ON THE
 *  WIRE to that op, what it does with each answer, and what reply string leaves the page. The
 *  resolver's own rules are `entityResolve.test.ts`'s job. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeDeviceRefusal } from '../../tools/shared/deviceRefusal';

const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
let entityAnswer: (params: Record<string, unknown>) => unknown = () => null;
let domAnswer: Record<string, unknown> = {};

vi.mock('../../app/debug/agentBridge', () => ({
  runAgentOp: async (op: string, params?: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    calls.push({ op, params: p });
    if (op === 'resolve-entity-point') return entityAnswer(p);
    if (op === 'resolve-dom-point') return domAnswer;
    return null;
  },
}));

const { handleTap, handleDrag, handleHover, handlePointer, handleResolveAim, _resetHeldPointerForTests }
  = await import('../../app/debug/bridge');

/** A 3D entity on a canvas surface with no picker: the realistic shipped-game answer. */
const cube = (over: Record<string, unknown> = {}) => ({
  ok: true, x: 40, y: 60, entity: { id: 1201, name: 'Cube', guid: 'g-cube', layer: '3d' },
  matched: 'Cube [g-cube]', hitTarget: 'canvas', occluded: false, occlusionScope: 'canvas', surface: 'game-3d', ...over,
});
const entityCalls = () => calls.filter((c) => c.op === 'resolve-entity-point').map((c) => c.params);

beforeEach(() => {
  calls.length = 0;
  // The game surface a tap dispatches into — without one every dispatch answers "No canvas element found".
  document.body.innerHTML = '<canvas></canvas>';
  entityAnswer = () => cube();
  domAnswer = {};
});
afterEach(() => { _resetHeldPointerForTests(); });

describe('device_tap {entity} resolves on the page, inside the call', () => {
  it('sends the entity spec with the tap gesture, and taps at the resolved point', async () => {
    const reply = await handleTap({ entity: { guid: 'g-cube', surface: 'game-3d' } });
    expect(entityCalls()).toEqual([{ guid: 'g-cube', surface: 'game-3d', gesture: 'tap', allowOccluded: false }]);
    expect(reply).toMatch(/^ok/);
    expect(reply).toContain('entity "Cube" guid=g-cube');
    expect(reply).toContain('surface=game-3d');
  });

  it('a refusal leaves the page with its code, options and stale in the tail', async () => {
    entityAnswer = () => ({ ok: false, code: 'NOT_FOUND', stale: 'world-swapped', error: 'no live entity has guid "00000000-0002-0000-0000-000000000001"' });
    const reply = await handleTap({ entity: { guid: '00000000-0002-0000-0000-000000000001', surface: 'game-3d' } });
    // Prefixed by the gesture, as the editor route's `tap: …` is — never a doubled `entity: entity:`.
    expect(reply.startsWith('Error: tap: no live entity')).toBe(true);
    expect(decodeDeviceRefusal(reply)).toMatchObject({ code: 'NOT_FOUND', stale: 'world-swapped' });

    entityAnswer = () => ({ ok: false, code: 'AMBIGUOUS', options: ['g-a', 'g-b'], error: '2 LIVE entities are named "Enemy"' });
    expect(decodeDeviceRefusal(await handleTap({ entity: { name: 'Enemy', surface: 'game-2d' } })))
      .toMatchObject({ code: 'AMBIGUOUS', options: ['g-a', 'g-b'] });
  });
});

describe('a covered entity is refused unless allowOccluded — the editor route\'s rule', () => {
  /** The resolver refuses a PICKER-occluded aim itself; DOM covering (a modal over the canvas) comes
   *  back `ok` with `occluded:true`, and only the caller can refuse it. */
  const covered = () => cube({ occluded: true, hitTarget: 'div.modal' });

  it('refuses OCCLUDED by default and dispatches nothing', async () => {
    entityAnswer = covered;
    const pressed: Event[] = [];
    document.querySelector('canvas')!.addEventListener('pointerdown', (e) => pressed.push(e));
    const reply = await handleTap({ entity: { name: 'Cube', surface: 'game-3d' } });
    expect(decodeDeviceRefusal(reply)).toMatchObject({ code: 'OCCLUDED' });
    expect(pressed).toEqual([]);
    expect(reply).toContain('covered by div.modal');
  });

  it('a top-level allowOccluded reaches the entity spec, and the tap goes through', async () => {
    entityAnswer = covered;
    const reply = await handleTap({ entity: { name: 'Cube', surface: 'game-3d' }, allowOccluded: true });
    expect(entityCalls()[0].allowOccluded).toBe(true);
    expect(reply).toMatch(/^ok/);
    expect(reply).toContain('OCCLUDED by div.modal (allowOccluded)');
  });
});

describe('the other gestures', () => {
  /** The trusted CDP/WDA route resolves each drag end through `handleResolveAim` with `fromSelector`/
   *  `toSelector` as the key — the entity and allowOccluded keys have to follow from it. */
  it('handleResolveAim resolves a drag end\'s fromEntity, with that end\'s own allowOccluded', async () => {
    const aim = await handleResolveAim({ selKey: 'fromSelector', xKey: 'fromX', yKey: 'fromY', gesture: 'drag',
      fromEntity: { guid: 'g-cube', surface: 'game-3d' }, fromAllowOccluded: true, toEntity: { guid: 'g-other' } });
    expect(entityCalls()).toEqual([{ guid: 'g-cube', surface: 'game-3d', gesture: 'drag', allowOccluded: true }]);
    expect(aim).toMatchObject({ x: 40, y: 60 });
  });

  it('device_drag resolves both entity ends', async () => {
    entityAnswer = (p) => cube(p.guid === 'g-b' ? { x: 90, y: 10 } : {});
    const reply = await handleDrag({ fromEntity: { guid: 'g-a', surface: 'game-3d' }, toEntity: { guid: 'g-b', surface: 'game-3d' } });
    expect(entityCalls().map((p) => p.guid)).toEqual(['g-a', 'g-b']);
    expect(reply).not.toMatch(/^Error/);
  });

  /** A held move/up goes to whatever captured the press, so the entity spec's own `allowOccluded:false`
   *  must not re-impose a refusal on it — the editor route forces it the same way. */
  it('device_pointer forces allowOccluded on a HELD move, even over the entity spec\'s own false', async () => {
    await handlePointer({ action: 'down', entity: { guid: 'g-cube', surface: 'game-3d' } });
    entityAnswer = () => cube({ occluded: true, hitTarget: 'div.modal' });
    const reply = await handlePointer({ action: 'move', entity: { guid: 'g-cube', surface: 'game-3d', allowOccluded: false } });
    expect(entityCalls().map((p) => p.allowOccluded)).toEqual([false, true]);
    expect(reply).not.toMatch(/^Error/);
  });

  /** A 2D/3D aim's `hitTarget` is the literal `'canvas'`, which no `describeElement` output equals —
   *  handing it to the drift check would warn "the element under this aim CHANGED" on every canvas aim. */
  it('a canvas entity hover does not claim the element under it changed', async () => {
    const canvas = document.querySelector('canvas')!;
    // A real game canvas carries an id or class, so it is described `canvas#…` — never the resolver's bare `'canvas'`.
    canvas.id = 'game-3d';
    const had = document.elementFromPoint;
    document.elementFromPoint = () => canvas; // jsdom does no layout: the canvas IS what is under the point
    try {
      const reply = await handleHover({ entity: { guid: 'g-cube', surface: 'game-3d' } });
      expect(reply).toMatch(/^ok \(hover canvas\)/);
      expect(reply).not.toContain('CHANGED');
    } finally { document.elementFromPoint = had; }
  });
});

describe('an older app build must refuse an entity aim, not act somewhere else', () => {
  /** The MCP sends an entity aim WITH a selector that matches nothing (`ENTITY_AIM_SKEW_SELECTOR`): a
   *  build predating entity aim resolves that selector, misses and refuses — instead of scrolling the
   *  viewport centre and answering ok. So THIS build must never look at it while an entity is given. */
  it('the entity wins over the skew selector — it is never resolved', async () => {
    const reply = await handleTap({ entity: { guid: 'g-cube', surface: 'game-3d' }, selector: '[data-modoki-app-predates-entity-aim]' });
    expect(reply).toMatch(/^ok/);
    expect(calls.map((c) => c.op)).toEqual(['resolve-entity-point']);
  });

  /** An endpoint key outside the table must not borrow the single-point keys and aim every end at the
   *  top-level entity. */
  it('an unknown selector key reads no entity at all', async () => {
    await handleResolveAim({ selKey: 'midSelector', xKey: 'midX', yKey: 'midY', entity: { guid: 'g-cube', surface: 'game-3d' }, midX: 1, midY: 2 });
    expect(entityCalls()).toEqual([]);
  });
});

describe('a selector aim takes allowOccluded and a code too', () => {
  it('a covered selector is OCCLUDED by default, and allowed through with allowOccluded', async () => {
    domAnswer = { ok: true, x: 5, y: 5, matched: 'button#go', hitTarget: 'div.modal', occluded: true };
    expect(decodeDeviceRefusal(await handleTap({ selector: '#go' }))).toMatchObject({ code: 'OCCLUDED' });
    expect(await handleTap({ selector: '#go', allowOccluded: true })).toMatch(/^ok/);
  });
});
