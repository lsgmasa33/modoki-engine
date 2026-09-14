/** The zone reactions refuse by RETURNING `refuseAction` when `params.self` is missing (#1185).
 *
 *  `params.self` is the zone Entity, and only the engine's own collision/zone dispatch can supply it —
 *  an agent's JSON params never can. So EVERY `modoki_dispatch_action` of these four actions used to
 *  tint nothing, still journal a `zone`/`zoneTrigger` event for a crossing that never happened, and
 *  answer `dispatched:true`. Both halves are pinned: the returned refusal AND the absent event. The
 *  accept rows prove the same dispatch with a real `self` still tints and journals, so a guard that
 *  refused everything would go red. The authored wiring itself is `zone-station.test.ts`'s job. */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, dispatchUIAction, isActionRefusal, Renderable3DPrimitive } from '@modoki/engine/runtime';
import { game } from '../game';

let tw: ReturnType<typeof createTestWorld> | undefined;
afterEach(() => {
  game.unregisterSystems?.();
  if (tw) { tw.dispose(); tw = undefined; }
});

const CASES = [
  { action: 'sensorZone3D/enter', event: 'zone', phase: 'enter' },
  { action: 'sensorZone3D/exit', event: 'zone', phase: 'exit' },
  { action: 'triggerZone3D/enter', event: 'zoneTrigger', phase: 'enter' },
  { action: 'triggerZone3D/exit', event: 'zoneTrigger', phase: 'exit' },
] as const;

describe('3d-physics-demo — zone reactions without params.self refuse (#1185)', () => {
  it.each(CASES)('$action with no self is a refusal and journals no $event event', async ({ action, event }) => {
    tw = createTestWorld({});
    await game.registerSystems?.();
    const body = tw.spawn(Renderable3DPrimitive({ color: 0xffffff }));
    const r = dispatchUIAction(action, { target: body, params: { other: body } });
    expect(isActionRefusal(r)).toBe(true);
    expect((r as { reason: string }).reason).toMatch(/params\.self/);
    expect(tw.events({ type: event })).toHaveLength(0);
  });

  // The refusal text invites a retry with the zone GUID, and a string passes a bare `!self` check — then
  // `self.id()` throws instead of refusing. Koota entities are numbers, so only a number is a `self`.
  it.each(CASES)('$action with a GUID STRING as self is a refusal, not a throw', async ({ action, event }) => {
    tw = createTestWorld({});
    await game.registerSystems?.();
    const r = dispatchUIAction(action, { params: { self: 'a1b2c3d4-0000-4000-8000-000000000001' } });
    expect(isActionRefusal(r)).toBe(true);
    expect(tw.events({ type: event })).toHaveLength(0);
  });

  it.each(CASES)('ACCEPT: $action WITH self returns no refusal and journals the $phase', async ({ action, event, phase }) => {
    tw = createTestWorld({});
    await game.registerSystems?.();
    const zone = tw.spawn(Renderable3DPrimitive({ color: 0x123456 }));
    const body = tw.spawn(Renderable3DPrimitive({ color: 0xffffff }));
    const r = dispatchUIAction(action, { target: body, params: { self: zone, other: body } });
    expect(isActionRefusal(r)).toBe(false);
    expect(tw.events({ type: event }).map((e) => (e.payload as { phase: string }).phase)).toEqual([phase]);
  });
});
