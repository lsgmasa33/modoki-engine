/** Recycled indices in the zone stations (#1198): koota hands a destroyed entity's index to the next spawn,
 *  so the handlers key both the zone and its occupants by `packedOf`.
 *
 *  - **Occupant.** A body destroyed inside a station and a newcomer spawned onto its index share `id()`.
 *    The engine's Zone trigger path sends every ENTER before every EXIT in one pass
 *    (`runtime/zones/zoneTriggerCore.ts`), so the newcomer's enter lands first: keyed by bare id it is a
 *    duplicate add, and the dead body's exit then deletes it, dropping the station to idle with the
 *    newcomer inside. The first case drives that through the real zone system; the second drives the
 *    handlers directly for both stations. (The physics sensor path sends a removal exit before the step's
 *    enter, so for `sensorZone` that order is not produced by the engine today; the case is kept as the
 *    handler contract, not as a reproduction.)
 *  - **Zone.** The dispatch drops events whose `self` is dead, so a zone despawned while occupied never
 *    gets its exits and its occupancy entry is stranded. A new zone on that index must not inherit it. */

import { describe, it, expect, afterEach } from 'vitest';
import type { Entity } from 'koota';
import {
  createTestWorld, dispatchUIAction, destroyEntity, SYSTEM_PRIORITY,
  Transform, Zone2D, ZoneOccupant, OnZone2D, Renderable2D, zone2DSystem,
} from '@modoki/engine/runtime';
import { game } from '../game';

const ZONE = { name: 'zone', fn: zone2DSystem, priority: SYSTEM_PRIORITY.TRANSFORM + 2 };

let tw: ReturnType<typeof createTestWorld> | undefined;
afterEach(() => {
  game.unregisterSystems?.();
  if (tw) { tw.dispose(); tw = undefined; }
});

const IDLE = { color: 0x123456, opacity: 0.25 };
const OTHER_IDLE = { color: 0x654321, opacity: 0.5 };
const colourOf = (e: Entity) => { const r = e.get(Renderable2D) as { color: number; opacity: number }; return { color: r.color, opacity: r.opacity }; };

describe('2d-physics-demo — zone occupancy survives a recycled index (#1198)', () => {
  it('through the real zone system: a body replaced on its index inside the station keeps it lit', async () => {
    tw = createTestWorld({ systems: [ZONE] });
    await game.registerSystems?.();
    const zone = tw.spawn(
      Transform({ x: 0, y: 0, sx: 100, sy: 40 }), Zone2D({ shape: 'box' }),
      OnZone2D({ onEnter: 'triggerZone/enter', onExit: 'triggerZone/exit' }),
      Renderable2D({ sprite: 'square', ...IDLE }),
    );
    const inside = { x: 0, y: 0 };
    const dead = tw.spawn(Transform(inside), ZoneOccupant);
    tw.step(1);
    const lit = colourOf(zone);
    expect(lit).not.toEqual(IDLE);

    destroyEntity(dead); // createTestWorld made its world current
    const newcomer = tw.spawn(Transform(inside), ZoneOccupant);
    expect(newcomer.id()).toBe(dead.id()); // the premise: the index was reclaimed
    tw.step(1);
    expect(colourOf(zone), 'the newcomer is still inside, so the station stays lit').toEqual(lit);

    newcomer.set(Transform, { ...(newcomer.get(Transform) as object), x: 500 });
    tw.step(1);
    expect(colourOf(zone), 'the last occupant left: the authored colour comes back').toEqual(IDLE);
  });

  it.each(['sensorZone', 'triggerZone'])('%s handlers: a newcomer\'s enter before the dead body\'s exit keeps the station lit', async (station) => {
    tw = createTestWorld({});
    await game.registerSystems?.();
    const zone = tw.spawn(Renderable2D({ sprite: 'square', ...IDLE }));
    const send = (self: Entity, phase: 'enter' | 'exit', other: Entity) =>
      dispatchUIAction(`${station}/${phase}`, { target: other, params: { self, other } });

    const dead = tw.spawn(Renderable2D({ color: 0xffffff, opacity: 1 }));
    send(zone, 'enter', dead);
    const lit = colourOf(zone);
    expect(lit).not.toEqual(IDLE);

    destroyEntity(dead);
    const newcomer = tw.spawn(Renderable2D({ color: 0xffffff, opacity: 1 }));
    expect(newcomer.id()).toBe(dead.id());

    send(zone, 'enter', newcomer);
    send(zone, 'exit', dead);
    expect(colourOf(zone), 'the newcomer is still inside, so the station stays lit').toEqual(lit);
    send(zone, 'exit', newcomer);
    expect(colourOf(zone), 'the last occupant left: the authored colour comes back').toEqual(IDLE);
  });

  it.each(['sensorZone', 'triggerZone'])('%s handlers: a new zone on a despawned-while-occupied zone\'s index restores ITS OWN colour', async (station) => {
    tw = createTestWorld({});
    await game.registerSystems?.();
    const send = (self: Entity, phase: 'enter' | 'exit', other: Entity) =>
      dispatchUIAction(`${station}/${phase}`, { target: other, params: { self, other } });
    const body = tw.spawn(Renderable2D({ color: 0xffffff, opacity: 1 }));

    const oldZone = tw.spawn(Renderable2D({ sprite: 'square', ...IDLE }));
    send(oldZone, 'enter', body);
    destroyEntity(oldZone); // despawned while occupied: the engine drops its exits (self is dead)

    const newZone = tw.spawn(Renderable2D({ sprite: 'square', ...OTHER_IDLE }));
    expect(newZone.id()).toBe(oldZone.id());
    send(newZone, 'enter', body);
    expect(colourOf(newZone)).not.toEqual(OTHER_IDLE);
    send(newZone, 'exit', body);
    expect(colourOf(newZone), 'the new zone\'s authored colour, not the dead zone\'s').toEqual(OTHER_IDLE);
  });
});
