/**
 * #851 — the three event-bus factories keep their subscribers per `World`.
 *
 * `zoneEventBus`, `physicsEventBus` and `timelineEventBus` are three instances of ONE shape: a
 * factory closing over `WeakMap<World, Set<Handler>>`, feeding module-level singletons. The issue
 * is explicit that they should be fixed at the FACTORY contract once rather than in three suites
 * separately — three shapes of one test is the state #828 was filed to stop.
 *
 * What was green before: every consuming suite (`zone2DEvents`, `zone3DEvents`,
 * `prefabTimelineZoneIntegration`, the physics event specs) builds ONE `tw` per test and only
 * ever calls `__clear` on that single world. Collapse each `WeakMap` to a bare `Set` and all of
 * them still pass.
 *
 * Each bus is driven through its REAL factory (not a stand-in), with the world passed
 * EXPLICITLY — a bus whose subscribe API defaults to `getCurrentWorld()` would otherwise let a
 * test measure `setCurrentWorld` instead of the map's own keying.
 */
import { describe, it, expect } from 'vitest';
import type { Entity, World } from 'koota';
import { twoWorlds } from '../helpers/twoWorlds';
import { createZoneEventBus } from '../../src/runtime/zones/zoneEventBus';
import { createPhysicsEventBus } from '../../src/runtime/physics/physicsEventBus';
import { createTimelineEventBus } from '../../src/runtime/timeline/timelineEventBus';

/** One bus, reduced to the three operations the contract is about. `emit` must deliver to the
 *  handlers registered for THAT world and no other. */
interface BusCase {
  name: string;
  make: () => {
    subscribe: (cb: () => void, world: World) => () => void;
    emit: (world: World) => void;
    clear: (world: World) => void;
  };
}

// A koota Entity is never inspected by these buses — they only route by World and hand the
// entity through — so a cast keeps the cases readable without spinning up real entities.
const ENT = {} as Entity;

const CASES: BusCase[] = [
  {
    name: 'zoneEventBus',
    make: () => {
      const { events } = createZoneEventBus('ZoneTest', 'zoneTest');
      return {
        subscribe: (cb, world) => events.onZone(cb, world),
        emit: (world) => events.__emitZone(world, ENT, ENT, 'enter'),
        clear: (world) => events.__clear(world),
      };
    },
  },
  {
    name: 'physicsEventBus',
    make: () => {
      const { events } = createPhysicsEventBus('PhysTest', 'physTest');
      return {
        subscribe: (cb, world) => events.onSensor(cb, world),
        emit: (world) => events.__emitSensor(world, ENT, ENT, 'enter'),
        clear: (world) => events.__clear(world),
      };
    },
  },
  {
    name: 'timelineEventBus (starts)',
    make: () => {
      const { events } = createTimelineEventBus('TimelineTest', 'timelineTest');
      return {
        subscribe: (cb, world) => events.onSequenceStart(cb, world),
        emit: (world) => events.__emitStart(world, ENT),
        clear: (world) => events.__clear(world),
      };
    },
  },
  // ⚠️ `timelineEventBus` keeps THREE SEPARATE maps — `startsByWorld`, `endsByWorld` and
  // `markersByWorld` — not one. They share a `setFor` helper, which makes them look like one
  // mechanism, but collapsing `endsByWorld` alone is invisible to a case that only drives
  // `onSequenceStart`. One case per map, or two thirds of this member is unpinned.
  {
    name: 'timelineEventBus (ends)',
    make: () => {
      const { events } = createTimelineEventBus('TimelineTest', 'timelineTest');
      return {
        subscribe: (cb, world) => events.onSequenceEnd(cb, world),
        emit: (world) => events.__emitEnd(world, ENT),
        clear: (world) => events.__clear(world),
      };
    },
  },
  {
    name: 'timelineEventBus (markers)',
    make: () => {
      const { events } = createTimelineEventBus('TimelineTest', 'timelineTest');
      return {
        subscribe: (cb, world) => events.onMarker(cb, world),
        emit: (world) => events.__emitMarker(world, ENT, 'act', 0),
        clear: (world) => events.__clear(world),
      };
    },
  },
];

describe.each(CASES)('$name keeps subscribers per World (#851)', ({ make }) => {
  it('an emit on world B does not reach world A’s subscriber', () => {
    const { a, b } = twoWorlds();
    const bus = make();
    let hitA = 0;
    let hitB = 0;
    bus.subscribe(() => { hitA += 1; }, a);
    bus.subscribe(() => { hitB += 1; }, b);

    bus.emit(b);

    // The load-bearing assertion is the ZERO. Under a shared subscriber Set, B's emit reaches
    // A's handler too — and an assertion that only checked `hitB === 1` would not notice.
    expect(hitA, 'world A’s subscriber fired for an emit on world B — the subscriber set is shared').toBe(0);
    expect(hitB).toBe(1);
  });

  it('__clear(A) leaves world B’s subscribers alive', () => {
    const { a, b } = twoWorlds();
    const bus = make();
    let hitA = 0;
    let hitB = 0;
    bus.subscribe(() => { hitA += 1; }, a);
    bus.subscribe(() => { hitB += 1; }, b);

    bus.clear(a);
    bus.emit(a);
    bus.emit(b);

    expect(hitA, 'clearing world A should drop A’s subscribers').toBe(0);
    // The half a single-world suite can never see: a `__clear` that wipes a shared Set silently
    // unsubscribes every OTHER world too. Every consuming suite today clears its only world, so
    // this cannot fail there by construction.
    expect(hitB, '__clear(A) also dropped world B’s subscribers — the state is shared').toBe(1);
  });

  it('CONTROL: two subscribers on the SAME world both fire — the bus is not simply inert', () => {
    // Without this, a bus that delivered to NOBODY would satisfy both assertions above.
    const { a } = twoWorlds();
    const bus = make();
    let n = 0;
    bus.subscribe(() => { n += 1; }, a);
    bus.subscribe(() => { n += 1; }, a);
    bus.emit(a);
    expect(n).toBe(2);
  });
});
