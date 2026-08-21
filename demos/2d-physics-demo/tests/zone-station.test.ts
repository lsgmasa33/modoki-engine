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
  Renderable2D, zone2DSystem, clearZoneState,
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
    // A Zone2D box's tested area is its Transform SCALE (full size). Renderable2D's
    // width/height are HALF-extents, and they are multiplied by that same scale — so the drawn
    // box is `width * 2 * sx` by `height * 2 * sy`. The two agree only at 0.5.
    //
    // Measured, because this is easy to get backwards and I did: `width: 1` under `sx: 260`
    // draws 520 design px over a zone that tests 260, and the bar visibly overhangs the arena
    // wall. Asserting the RELATION rather than the literal 0.5 keeps this honest if either
    // side is re-authored.
    expect(tf.sx).toBeGreaterThan(1);
    expect(tf.sy).toBeGreaterThan(1);
    expect((r2d.width ?? 0) * 2 * (tf.sx ?? 0)).toBe(tf.sx);
    expect((r2d.height ?? 0) * 2 * (tf.sy ?? 0)).toBe(tf.sy);
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

  it('restores the AUTHORED tint, not a constant, so an Inspector re-colour survives', () => {
    const on = zoneStations[0].traits?.OnZone2D as { onEnter: string; onExit: string };
    // Deliberately NOT the scene's tint and NOT either constant in game.ts — this stands in
    // for the owner having re-coloured the station live. A handler that writes a hardcoded
    // idle back on exit passes every other case in this file and fails this one.
    const RECOLOURED = { color: 0x123456, opacity: 0.8 };

    tw = createTestWorld({ systems: [ZONE] });
    game.registerSystems?.();
    const zone = tw.spawn(
      Transform({ x: 0, y: 0, sx: 100, sy: 40 }),
      Zone2D({ shape: 'box' }),
      OnZone2D({ onEnter: on.onEnter, onExit: on.onExit }),
      Renderable2D({ sprite: 'square', ...RECOLOURED }),
    );
    const occupant = tw.spawn(Transform({ x: 500, y: 0 }), ZoneOccupant);
    const tintOf = () => {
      const r = zone.get(Renderable2D) as { color: number; opacity: number };
      return { color: r.color, opacity: r.opacity };
    };
    const moveTo = (e: Entity, x: number) => e.set(Transform, { ...(e.get(Transform) as object), x });

    moveTo(occupant, 0); tw.step(1);
    expect(tintOf()).not.toEqual(RECOLOURED);    // it did light up
    moveTo(occupant, 500); tw.step(1);
    expect(tintOf()).toEqual(RECOLOURED);        // ...and came back to what was authored
  });

  it('stays lit until the LAST occupant leaves, and still restores the authored tint', () => {
    const on = zoneStations[0].traits?.OnZone2D as { onEnter: string; onExit: string };
    const AUTHORED = { color: 0x123456, opacity: 0.8 };

    tw = createTestWorld({ systems: [ZONE] });
    game.registerSystems?.();
    const zone = tw.spawn(
      Transform({ x: 0, y: 0, sx: 100, sy: 40 }),
      Zone2D({ shape: 'box' }),
      OnZone2D({ onEnter: on.onEnter, onExit: on.onExit }),
      Renderable2D({ sprite: 'square', ...AUTHORED }),
    );
    const a = tw.spawn(Transform({ x: 500, y: 0 }), ZoneOccupant);
    const b = tw.spawn(Transform({ x: 500, y: 5 }), ZoneOccupant);
    const tintOf = () => {
      const r = zone.get(Renderable2D) as { color: number; opacity: number };
      return { color: r.color, opacity: r.opacity };
    };
    const moveTo = (e: Entity, x: number) => e.set(Transform, { ...(e.get(Transform) as object), x });

    moveTo(a, 0); tw.step(1);
    const hot = tintOf();
    moveTo(b, 0); tw.step(1);
    // Un-refcounted, this second enter would remember HOT as the idle tint — and the
    // station would never come back, which is invisible until someone watches it.
    expect(tintOf()).toEqual(hot);

    moveTo(a, 500); tw.step(1);
    expect(tintOf()).toEqual(hot);               // b is still inside
    moveTo(b, 500); tw.step(1);
    expect(tintOf()).toEqual(AUTHORED);          // last one out restores what was authored
  });

  it('survives a Stop taken while occupied — a duplicate enter must not strand the tint', () => {
    const on = zoneStations[0].traits?.OnZone2D as { onEnter: string; onExit: string };
    const AUTHORED = { color: 0x123456, opacity: 0.8 };

    tw = createTestWorld({ systems: [ZONE] });
    game.registerSystems?.();
    const zone = tw.spawn(
      Transform({ x: 0, y: 0, sx: 100, sy: 40 }),
      Zone2D({ shape: 'box' }),
      OnZone2D({ onEnter: on.onEnter, onExit: on.onExit }),
      Renderable2D({ sprite: 'square', ...AUTHORED }),
    );
    const occupant = tw.spawn(Transform({ x: 500, y: 0 }), ZoneOccupant);
    const tintOf = () => {
      const r = zone.get(Renderable2D) as { color: number; opacity: number };
      return { color: r.color, opacity: r.opacity };
    };
    const moveTo = (e: Entity, x: number) => e.set(Transform, { ...(e.get(Transform) as object), x });

    moveTo(occupant, 0); tw.step(1);             // enter
    expect(tintOf()).not.toEqual(AUTHORED);

    // Stop clears the engine's occupancy WITHOUT firing exits, so the next Play re-fires
    // `enter` for whoever is still inside — a SECOND enter with no exit in between.
    // `clearZoneState` is exactly what the editor's Stop does; this reproduces it headlessly.
    clearZoneState(tw.world);
    tw.step(1);                                  // the duplicate enter
    expect(tintOf()).not.toEqual(AUTHORED);

    moveTo(occupant, 500); tw.step(1);           // the ONE exit that follows
    // A counter would sit at 2 here and never restore — the station would stay lit forever.
    expect(tintOf()).toEqual(AUTHORED);
  });

  it('does not carry a session\'s stash into the next world, where ids are reused', () => {
    const on = zoneStations[0].traits?.OnZone2D as { onEnter: string; onExit: string };
    const OLD = { color: 0x111111, opacity: 0.3 };
    const RECOLOURED = { color: 0x222222, opacity: 0.7 };
    const spawnStation = (tint: { color: number; opacity: number }) => tw!.spawn(
      Transform({ x: 0, y: 0, sx: 100, sy: 40 }),
      Zone2D({ shape: 'box' }),
      OnZone2D({ onEnter: on.onEnter, onExit: on.onExit }),
      Renderable2D({ sprite: 'square', ...tint }),
    );
    const moveTo = (e: Entity, x: number) => e.set(Transform, { ...(e.get(Transform) as object), x });

    // SESSION 1: an occupant walks in and the session ends while it is still inside — exactly
    // what pressing Stop leaves behind, since Stop clears occupancy without firing exits.
    tw = createTestWorld({ systems: [ZONE] });
    game.registerSystems?.();
    const first = spawnStation(OLD);
    const occ1 = tw.spawn(Transform({ x: 500, y: 0 }), ZoneOccupant);
    moveTo(occ1, 0); tw.step(1);
    tw.dispose();

    // SESSION 2: a fresh world. Stop reverts by rebuilding the world, and koota ids are
    // per-world slot indices that restart at 0 — so the station is handed the SAME id. The
    // owner has re-coloured it in the Inspector in the meantime.
    tw = createTestWorld({ systems: [ZONE] });
    const second = spawnStation(RECOLOURED);
    const occ2 = tw.spawn(Transform({ x: 500, y: 0 }), ZoneOccupant);

    // Guard against this test going vacuous: it only proves anything if the id really is
    // reused. If a future harness change stops reusing ids, fail here rather than pass for
    // the wrong reason.
    expect(second.id()).toBe(first.id());

    moveTo(occ2, 0); tw.step(1);
    moveTo(occ2, 500); tw.step(1);
    const r = second.get(Renderable2D) as { color: number; opacity: number };
    // Session 1's stash would restore OLD here — the shadowing bug, laundered through a cache.
    expect({ color: r.color, opacity: r.opacity }).toEqual(RECOLOURED);
  });
});
