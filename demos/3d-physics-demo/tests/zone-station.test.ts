/** The Trigger Zone station — the demo's physics-free `Zone3D` trigger.
 *
 *  WHY THIS TEST EXISTS (#296): the engine's declarative zone chain
 *  (`Zone3D` + `ZoneOccupant` + `@zone` + `OnZone3D`) had NO real-project usage at all, so a
 *  regression in it would not have been caught by playing anything we ship. The engine's own
 *  suite (`packages/modoki/tests/runtime/zone3DEvents.test.ts`) already covers the containment
 *  math and the dispatch mechanics — what it CANNOT see is whether this demo is still wired to
 *  them. That is the gap here, and it is the gap that matters: an authored action name that no
 *  longer resolves to a registered handler fails silently (an unwired name is a warning, not a
 *  crash), so the station would keep LOOKING right in the Inspector while reacting to nothing.
 *
 *  So the behavioural case below deliberately builds its station from the SCENE's own authored
 *  values — the action names and the idle colour are read out of the JSON, not restated here.
 *  Rename the action on either side and the tint stops happening, which is the failure this is
 *  for. It also pins the `@zone` journal event a QA pass previously had to rig by hand. */

/// <reference types="node" />
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Entity } from 'koota';
import {
  createTestWorld, SYSTEM_PRIORITY, Transform, Zone3D, ZoneOccupant, OnZone3D,
  Renderable3DPrimitive, zone3DSystem, clearZoneState,
} from '@modoki/engine/runtime';
import { game } from '../game';

const SCENE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../runtime/assets/scenes/physics-showcase.scene.json',
);

interface SceneEntity { name?: string; traits?: Record<string, Record<string, unknown> | undefined> }
const scene = JSON.parse(fs.readFileSync(SCENE_PATH, 'utf8')) as { entities: SceneEntity[] };
const zoneStations = scene.entities.filter((e) => e.traits?.Zone3D);
const occupants = scene.entities.filter((e) => e.traits?.ZoneOccupant);

// The zone systems are internally play-state-gated; run at the production tier (post-transform).
const ZONE = { name: 'zone3D', fn: zone3DSystem, priority: SYSTEM_PRIORITY.TRANSFORM + 2 };

let tw: ReturnType<typeof createTestWorld> | undefined;
afterEach(() => {
  game.unregisterSystems?.();
  if (tw) { tw.dispose(); tw = undefined; }
});

describe('3d-physics-demo — the Zone3D trigger station is authored', () => {
  it('ships exactly one Zone3D station, and it carries NO physics body', () => {
    expect(zoneStations).toHaveLength(1);
    const [station] = zoneStations;
    // The absence IS the demonstration: a Rapier sensor needs a body + a collider, a zone needs
    // neither. If someone "fixes" this by adding one, the station stops making its point.
    expect(station.traits?.RigidBody3D).toBeUndefined();
    expect(station.traits?.Collider3D).toBeUndefined();
    expect(station.traits?.Renderable3DPrimitive).toBeDefined();
  });

  it('wires both phases through OnZone3D, and has occupants to trigger it', () => {
    const on = zoneStations[0].traits?.OnZone3D as { onEnter?: string; onExit?: string } | undefined;
    expect(on?.onEnter).toBeTruthy();
    expect(on?.onExit).toBeTruthy();
    // A zone with no tagged occupant is inert — ZoneOccupant is opt-in, so this is a real way
    // for the station to quietly stop demonstrating anything.
    expect(occupants.length).toBeGreaterThan(0);
  });
});

describe('3d-physics-demo — the authored names resolve to the registered handlers', () => {
  it('tints on enter and restores on exit, and journals both crossings', () => {
    const station = zoneStations[0];
    const on = station.traits?.OnZone3D as { onEnter: string; onExit: string };
    const idleColor = (station.traits?.Renderable3DPrimitive as { color: number }).color;

    // The demo's REAL handlers, registered exactly as the running game registers them.
    tw = createTestWorld({ systems: [ZONE] });
    game.registerSystems?.();

    const zone = tw.spawn(
      Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }),
      Zone3D({ shape: 'box' }),
      OnZone3D({ onEnter: on.onEnter, onExit: on.onExit }),
      Renderable3DPrimitive({ mesh: 'box', color: idleColor }),
    );
    const occupant = tw.spawn(Transform({ x: 10, y: 0, z: 0 }), ZoneOccupant);

    const colorOf = (e: Entity) => (e.get(Renderable3DPrimitive) as { color: number }).color;
    const moveTo = (e: Entity, x: number) => e.set(Transform, { ...(e.get(Transform) as object), x });

    expect(colorOf(zone)).toBe(idleColor);

    moveTo(occupant, 0); tw.step(1);
    const hot = colorOf(zone);
    // Distinguishing: the idle colour is what the scene AUTHORS, so "still idle" cannot tell a
    // handler that ran from one that was never registered. The change is the only proof.
    expect(hot).not.toBe(idleColor);

    moveTo(occupant, 10); tw.step(1);
    expect(colorOf(zone)).toBe(idleColor);

    // The engine's record of the crossing (the Percept-verifiable path)...
    expect(tw.events({ type: '@zone' }).map((e) => (e.payload as { phase: string }).phase))
      .toEqual(['enter', 'exit']);
    // ...and the game's reaction to it, which only exists if the action names resolved.
    expect(tw.events({ type: 'zoneTrigger' }).map((e) => (e.payload as { phase: string }).phase))
      .toEqual(['enter', 'exit']);
  });

  it('restores the AUTHORED colour, not a constant, so an Inspector re-colour survives', () => {
    const on = zoneStations[0].traits?.OnZone3D as { onEnter: string; onExit: string };
    // Deliberately NOT the scene's colour and NOT either constant in game.ts — this stands in
    // for the owner having re-coloured the station live. A handler that writes a hardcoded
    // idle back on exit passes every other case in this file and fails this one.
    const RECOLOURED = 0x123456;

    tw = createTestWorld({ systems: [ZONE] });
    game.registerSystems?.();
    const zone = tw.spawn(
      Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }),
      Zone3D({ shape: 'box' }),
      OnZone3D({ onEnter: on.onEnter, onExit: on.onExit }),
      Renderable3DPrimitive({ mesh: 'box', color: RECOLOURED }),
    );
    const occupant = tw.spawn(Transform({ x: 10, y: 0, z: 0 }), ZoneOccupant);
    const colorOf = () => (zone.get(Renderable3DPrimitive) as { color: number }).color;
    const moveTo = (e: Entity, x: number) => e.set(Transform, { ...(e.get(Transform) as object), x });

    moveTo(occupant, 0); tw.step(1);
    expect(colorOf()).not.toBe(RECOLOURED);      // it did light up
    moveTo(occupant, 10); tw.step(1);
    expect(colorOf()).toBe(RECOLOURED);          // ...and came back to what was authored
  });

  it('stays lit until the LAST occupant leaves, and still restores the authored colour', () => {
    const on = zoneStations[0].traits?.OnZone3D as { onEnter: string; onExit: string };
    const AUTHORED = 0x123456;

    tw = createTestWorld({ systems: [ZONE] });
    game.registerSystems?.();
    const zone = tw.spawn(
      Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }),
      Zone3D({ shape: 'box' }),
      OnZone3D({ onEnter: on.onEnter, onExit: on.onExit }),
      Renderable3DPrimitive({ mesh: 'box', color: AUTHORED }),
    );
    const a = tw.spawn(Transform({ x: 10, y: 0, z: 0 }), ZoneOccupant);
    const b = tw.spawn(Transform({ x: 10, y: 0, z: 1 }), ZoneOccupant);
    const colorOf = () => (zone.get(Renderable3DPrimitive) as { color: number }).color;
    const moveTo = (e: Entity, x: number) => e.set(Transform, { ...(e.get(Transform) as object), x });

    moveTo(a, 0); tw.step(1);
    const hot = colorOf();
    moveTo(b, 0); tw.step(1);
    // Un-refcounted, this second enter would remember HOT as the idle colour — and the
    // station would never come back, which is invisible until someone watches it.
    expect(colorOf()).toBe(hot);

    moveTo(a, 10); tw.step(1);
    expect(colorOf()).toBe(hot);                 // b is still inside
    moveTo(b, 10); tw.step(1);
    expect(colorOf()).toBe(AUTHORED);            // last one out restores what was authored
  });

  it('survives a Stop taken while occupied — a duplicate enter must not strand the tint', () => {
    const on = zoneStations[0].traits?.OnZone3D as { onEnter: string; onExit: string };
    const AUTHORED = 0x123456;

    tw = createTestWorld({ systems: [ZONE] });
    game.registerSystems?.();
    const zone = tw.spawn(
      Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }),
      Zone3D({ shape: 'box' }),
      OnZone3D({ onEnter: on.onEnter, onExit: on.onExit }),
      Renderable3DPrimitive({ mesh: 'box', color: AUTHORED }),
    );
    const occupant = tw.spawn(Transform({ x: 10, y: 0, z: 0 }), ZoneOccupant);
    const colorOf = () => (zone.get(Renderable3DPrimitive) as { color: number }).color;
    const moveTo = (e: Entity, x: number) => e.set(Transform, { ...(e.get(Transform) as object), x });

    moveTo(occupant, 0); tw.step(1);             // enter
    expect(colorOf()).not.toBe(AUTHORED);

    // Stop clears the engine's occupancy WITHOUT firing exits, so the next Play re-fires
    // `enter` for whoever is still inside — a SECOND enter with no exit in between.
    // `clearZoneState` is exactly what the editor's Stop does; this reproduces it headlessly.
    clearZoneState(tw.world);
    tw.step(1);                                  // the duplicate enter
    expect(colorOf()).not.toBe(AUTHORED);

    moveTo(occupant, 10); tw.step(1);            // the ONE exit that follows
    // A counter would sit at 2 here and never restore — the station would stay lit forever.
    expect(colorOf()).toBe(AUTHORED);
  });

  it('does not carry a session\'s stash into the next world, where ids are reused', () => {
    const on = zoneStations[0].traits?.OnZone3D as { onEnter: string; onExit: string };
    const OLD = 0x111111, RECOLOURED = 0x222222;
    const spawnStation = (color: number) => tw!.spawn(
      Transform({ x: 0, y: 0, z: 0, sx: 4, sy: 4, sz: 4 }),
      Zone3D({ shape: 'box' }),
      OnZone3D({ onEnter: on.onEnter, onExit: on.onExit }),
      Renderable3DPrimitive({ mesh: 'box', color }),
    );
    const moveTo = (e: Entity, x: number) => e.set(Transform, { ...(e.get(Transform) as object), x });

    // SESSION 1: an occupant walks in and the session ends while it is still inside — exactly
    // what pressing Stop leaves behind, since Stop clears occupancy without firing exits.
    tw = createTestWorld({ systems: [ZONE] });
    game.registerSystems?.();
    const first = spawnStation(OLD);
    const occ1 = tw.spawn(Transform({ x: 10, y: 0, z: 0 }), ZoneOccupant);
    moveTo(occ1, 0); tw.step(1);
    tw.dispose();

    // SESSION 2: a fresh world. Stop reverts by rebuilding the world, and koota ids are
    // per-world slot indices that restart at 0 — so the station is handed the SAME id. The
    // owner has re-coloured it in the Inspector in the meantime.
    tw = createTestWorld({ systems: [ZONE] });
    const second = spawnStation(RECOLOURED);
    const occ2 = tw.spawn(Transform({ x: 10, y: 0, z: 0 }), ZoneOccupant);

    // Guard against this test going vacuous: it only proves anything if the id really is
    // reused. If a future harness change stops reusing ids, fail here rather than pass for
    // the wrong reason.
    expect(second.id()).toBe(first.id());

    moveTo(occ2, 0); tw.step(1);
    moveTo(occ2, 10); tw.step(1);
    // Session 1's stash would restore OLD here — the shadowing bug, laundered through a cache.
    expect((second.get(Renderable3DPrimitive) as { color: number }).color).toBe(RECOLOURED);
  });
});
