/**
 * #953 phase 5 — every emitter on the three event-bus factories isolates each handler through
 * `notifyListeners`. A handler that throws must not starve the handlers registered after it, must
 * not escape into the PRODUCER that called `__emit*` (the physics reconciler, the zone-trigger
 * system, the timeline system), and is reported as a `console.error` naming the bus and the
 * emitter. Error, not warn, is the owner's #953 ruling: a game handler's throw spends the crash
 * budget like any other listener defect.
 *
 * One row per emitter, driven through the REAL factories. Reverting any single emitter to a bare
 * loop reddens exactly its row (escape + starvation); reverting it to the pre-#953 try + warn
 * reddens it too (the `console.error` / no-`warn` assertions).
 *
 * The world is a plain object: the buses only key a `WeakMap` by it and never touch koota, so a
 * real `World` would spend a slot in koota's module-level 16-world pool for nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Entity, World } from 'koota';
import { createZoneEventBus } from '../../src/runtime/zones/zoneEventBus';
import { createPhysicsEventBus } from '../../src/runtime/physics/physicsEventBus';
import { createTimelineEventBus } from '../../src/runtime/timeline/timelineEventBus';

const W = {} as World;
const ENT = {} as Entity;

interface EmitterCase {
  label: string;
  subscribe: (cb: () => void) => void;
  emit: () => void;
}

const zone = createZoneEventBus('ZoneIsolation', 'zoneIso').events;
const physics = createPhysicsEventBus('PhysicsIsolation', 'physicsIso').events;
const timeline = createTimelineEventBus('TimelineIsolation', 'timelineIso').events;

const CASES: Array<[string, EmitterCase]> = [
  ['zone.__emitZone', {
    label: '[zoneIso:zone]',
    subscribe: (cb) => { zone.onZone(cb, W); },
    emit: () => zone.__emitZone(W, ENT, ENT, 'enter'),
  }],
  ['physics.__emitSensor', {
    label: '[physicsIso:sensor]',
    subscribe: (cb) => { physics.onSensor(cb, W); },
    emit: () => physics.__emitSensor(W, ENT, ENT, 'enter'),
  }],
  ['physics.__emitCollision', {
    label: '[physicsIso:collision]',
    subscribe: (cb) => { physics.onCollision(cb, W); },
    emit: () => physics.__emitCollision(W, ENT, ENT, 'exit'),
  }],
  ['physics.__emitContact', {
    label: '[physicsIso:contact]',
    subscribe: (cb) => { physics.onContact(cb, W); },
    emit: () => physics.__emitContact(W, ENT, ENT, { point: [0, 0], normal: [0, 1], speed: 3 }),
  }],
  ['timeline.__emitStart', {
    label: '[timelineIso:start]',
    subscribe: (cb) => { timeline.onSequenceStart(cb, W); },
    emit: () => timeline.__emitStart(W, ENT),
  }],
  ['timeline.__emitEnd', {
    label: '[timelineIso:end]',
    subscribe: (cb) => { timeline.onSequenceEnd(cb, W); },
    emit: () => timeline.__emitEnd(W, ENT),
  }],
  ['timeline.__emitMarker', {
    label: '[timelineIso:marker]',
    subscribe: (cb) => { timeline.onMarker(cb, W); },
    emit: () => timeline.__emitMarker(W, ENT, 'spawn', 0.5),
  }],
];

describe('event-bus emitters isolate each handler (#953)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(CASES)('%s: a throwing handler does not starve the next, escape, or report as a warning', (_name, c) => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const after = vi.fn();
    c.subscribe(() => { throw new Error('game handler boom'); });
    c.subscribe(after);

    expect(() => c.emit()).not.toThrow();

    expect(after).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]![0])).toContain(c.label);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
