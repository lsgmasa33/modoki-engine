/** The Trigger Zone station — the demo's physics-free `Zone2D` trigger.
 *
 *  WHY THIS TEST EXISTS (#296): the engine's declarative zone chain
 *  (`Zone2D` + `ZoneOccupant` + `@zone` + `OnZone2D`) had NO real-project usage at all, so a
 *  regression in it would not have been caught by playing anything we ship. The engine's own
 *  suite (`packages/modoki/tests/runtime/zone2DEvents.test.ts`) already covers the containment
 *  math and the dispatch mechanics — what it CANNOT see is whether this demo is still wired to
 *  them. That is the gap here, and it is the gap that matters: an authored action name that no
 *  longer resolves to a registered handler fails silently (an unwired name is a warning, not a
 *  crash), so the station would keep LOOKING right in the Inspector while reacting to nothing.
 *
 *  So the behavioural case below deliberately builds its station from the SCENE's own authored
 *  values — the action names and the idle colour are read out of the JSON, not restated here.
 *  Rename the action on either side and the tint stops happening, which is the failure this is
 *  for. The 3D half of the chain has the same guard in `demos/3d-physics-demo`. */

/// <reference types="node" />
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Entity } from 'koota';
import {
  createTestWorld, SYSTEM_PRIORITY, Transform, Zone2D, ZoneOccupant, OnZone2D,
  Renderable2D, zone2DSystem,
} from '@modoki/engine/runtime';
import { game } from '../game';

const SCENE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../runtime/assets/scenes/physics-playground.scene.json',
);

interface SceneEntity { name?: string; traits?: Record<string, Record<string, unknown> | undefined> }
const scene = JSON.parse(fs.readFileSync(SCENE_PATH, 'utf8')) as { entities: SceneEntity[] };
const zoneStations = scene.entities.filter((e) => e.traits?.Zone2D);
const occupants = scene.entities.filter((e) => e.traits?.ZoneOccupant);

// The zone systems are internally play-state-gated; run at the production tier (post-transform).
const ZONE = { name: 'zone2D', fn: zone2DSystem, priority: SYSTEM_PRIORITY.TRANSFORM + 2 };

let tw: ReturnType<typeof createTestWorld> | undefined;
afterEach(() => {
  game.unregisterSystems?.();
  if (tw) { tw.dispose(); tw = undefined; }
});

describe('2d-physics-demo — the Zone2D trigger station is authored', () => {
  it('ships exactly one Zone2D station, and it carries NO physics body', () => {
    expect(zoneStations).toHaveLength(1);
    const [station] = zoneStations;
    // The absence IS the demonstration: a Rapier sensor needs a body + a collider, a zone needs
    // neither. If someone "fixes" this by adding one, the station stops making its point.
    expect(station.traits?.RigidBody2D).toBeUndefined();
    expect(station.traits?.Collider2D).toBeUndefined();
    expect(station.traits?.Renderable2D).toBeDefined();
  });

  it('sizes the visual to the zone area, so "inside" matches what you see', () => {
    const station = zoneStations[0];
    const tf = station.traits?.Transform as { sx?: number; sy?: number };
    const r2d = station.traits?.Renderable2D as { width?: number; height?: number };
    // A Zone2D box takes its full size from the Transform SCALE, while Renderable2D takes its
    // size from width/height MULTIPLIED by that same scale (measured: sx 260 x width 1 renders
    // 260 design px). So a 1x1 sprite under the zone's scale is the one authoring that keeps the
    // drawn bar and the tested area identical — any other width/height silently desyncs them.
    expect(tf.sx).toBeGreaterThan(1);
    expect(tf.sy).toBeGreaterThan(1);
    expect(r2d.width).toBe(1);
    expect(r2d.height).toBe(1);
  });

  it('wires both phases through OnZone2D, and has occupants to trigger it', () => {
    const on = zoneStations[0].traits?.OnZone2D as { onEnter?: string; onExit?: string } | undefined;
    expect(on?.onEnter).toBeTruthy();
    expect(on?.onExit).toBeTruthy();
    // A zone with no tagged occupant is inert — ZoneOccupant is opt-in, so this is a real way
    // for the station to quietly stop demonstrating anything.
    expect(occupants.length).toBeGreaterThan(0);
  });
});

describe('2d-physics-demo — the authored names resolve to the registered handlers', () => {
  it('tints on enter and restores on exit, and journals both crossings', () => {
    const station = zoneStations[0];
    const on = station.traits?.OnZone2D as { onEnter: string; onExit: string };
    const idle = station.traits?.Renderable2D as { color: number; opacity: number };

    // The demo's REAL handlers, registered exactly as the running game registers them.
    tw = createTestWorld({ systems: [ZONE] });
    game.registerSystems?.();

    const zone = tw.spawn(
      Transform({ x: 0, y: 0, sx: 100, sy: 40 }),
      Zone2D({ shape: 'box' }),
      OnZone2D({ onEnter: on.onEnter, onExit: on.onExit }),
      Renderable2D({ sprite: 'square', color: idle.color, opacity: idle.opacity }),
    );
    const occupant = tw.spawn(Transform({ x: 500, y: 0 }), ZoneOccupant);

    const tintOf = (e: Entity) => {
      const r = e.get(Renderable2D) as { color: number; opacity: number };
      return { color: r.color, opacity: r.opacity };
    };
    const moveTo = (e: Entity, x: number) => e.set(Transform, { ...(e.get(Transform) as object), x });

    expect(tintOf(zone)).toEqual({ color: idle.color, opacity: idle.opacity });

    moveTo(occupant, 0); tw.step(1);
    // Distinguishing: the idle tint is what the scene AUTHORS, so "still idle" cannot tell a
    // handler that ran from one that was never registered. The change is the only proof.
    expect(tintOf(zone)).not.toEqual({ color: idle.color, opacity: idle.opacity });

    moveTo(occupant, 500); tw.step(1);
    expect(tintOf(zone)).toEqual({ color: idle.color, opacity: idle.opacity });

    // The engine's record of the crossing (the Percept-verifiable path)...
    expect(tw.events({ type: '@zone' }).map((e) => (e.payload as { phase: string }).phase))
      .toEqual(['enter', 'exit']);
    // ...and the game's reaction to it, which only exists if the action names resolved.
    expect(tw.events({ type: 'zoneTrigger' }).map((e) => (e.payload as { phase: string }).phase))
      .toEqual(['enter', 'exit']);
  });
});
