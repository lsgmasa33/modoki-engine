/** zone2DSystem — the producer behind `Zone2DEvents` + the declarative `OnZone2D` trait, the 2D
 *  twin of `zone3DSystem`. Each frame (while the sim runs) it samples every `ZoneOccupant` world
 *  position (x, y) and tests it against every `Zone2D` area, handing the (zone × occupant)
 *  containment to `runZoneTriggers`, which diffs against last frame and fans enter/exit to the
 *  journal (`@zone`) + the `zone2DEvents` bus + the `OnZone2D` action. Pure geometry — no Rapier.
 *
 *  Registered AFTER transform propagation (see app pipeline) and internally sim-gated (clears the
 *  occupancy baseline when stopped, so the next Play re-fires `enter` for what is already inside).
 *  The occupant is tested in the zone's LOCAL frame (rotation `rz` undone first), so a rotated
 *  box/capsule contains correctly. Scale→area mapping matches `Zone2D`:
 *   - `circle`  radius = sx
 *   - `box`     full size = scale (half-extents sx/2, sy/2)
 *   - `capsule` radius = sx, total height = sy (vertical pill along local Y) */

import type { Entity, World } from 'koota';
import { Zone2D } from '../traits/Zone2D';
import { ZoneOccupant } from '../traits/ZoneOccupant';
import { OnZone2D } from '../traits/OnZone2D';
import { Transform } from '../core/traits/Transform';
import { zone2DEvents } from './Zone2DEvents';
import { getPlayState } from '../core/playState';
import {
  runZoneTriggers, clearZoneState, makeFireOnZone, readWorldTRS,
  type ZoneCandidate, type OccupantSample,
} from './zoneTriggerCore';
import { buildEntityIndex, isEntityActiveInHierarchy } from '../core/ecs/entityIndex';

const fireOnZone2D = makeFireOnZone(OnZone2D);
const EMPTY: OccupantSample[] = [];   // shared empty occupant list for the no-zones flush path

/** Build a 2D containment predicate from a zone's world pose, capturing centre/rotation/scale.
 *  `pose` is `readWorldTRS`'s shared singleton — every field is copied to a closure-local BEFORE
 *  returning. Rotation is a single angle `rz`; the occupant offset is rotated by `-rz` into the
 *  zone's local frame. */
function makeContains2D(shape: string, pose: { x: number; y: number; rz: number; sx: number; sy: number }): ZoneCandidate['contains'] {
  const cx = pose.x, cy = pose.y;
  const sx = Math.abs(pose.sx) || 1e-6, sy = Math.abs(pose.sy) || 1e-6;
  const cos = Math.cos(-pose.rz), sin = Math.sin(-pose.rz);
  return (x, y) => {
    const ox = x - cx, oy = y - cy;
    const dx = ox * cos - oy * sin;   // rotate offset by -rz into the zone's local frame
    const dy = ox * sin + oy * cos;
    switch (shape) {
      case 'box': return Math.abs(dx) <= sx / 2 && Math.abs(dy) <= sy / 2;
      case 'capsule': {
        const half = Math.max(0, sy / 2 - sx);           // segment half-length (caps add sx each end)
        const cyy = Math.max(-half, Math.min(half, dy));  // nearest point on the segment axis
        return dx * dx + (dy - cyy) * (dy - cyy) <= sx * sx;
      }
      case 'circle':
      default: return dx * dx + dy * dy <= sx * sx;
    }
  };
}

/** Deactivated zones/occupants are DROPPED from this frame's lists, which makes the existing
 *  membership diff synthesize their `exit` events for free — the same path a DESPAWNED zone
 *  already takes ("removing a zone fires exit for all its occupants", docs/zones.md). That is
 *  the deliberate semantic: switching a trigger volume off means it is GONE while off, not
 *  paused, so the enter/exit ledger stays BALANCED — code that counted an enter always gets its
 *  exit. (Matches Unity, where disabling a trigger collider fires OnTriggerExit.) Re-activating
 *  fires a fresh `enter` for whoever is still inside, so a one-shot "first time here" handler
 *  needs its own guard. Contrast `Director`, which FREEZES on deactivation — a playhead has no
 *  ledger to keep balanced, so resuming where it stopped is the useful behaviour there.
 *
 *  Uses `isEntityActiveInHierarchy` (runtime/core/ecs/entityIndex.ts) rather than the renderers'
 *  `deactivatedEntities`: although these systems run at TRANSFORM+2 (so that set would be current,
 *  unlike timelineSystem's case), it is produced by a THREE module the headless harness never
 *  registers — the guard would be permanently inert in headless games and untestable. */
export function zone2DSystem(world: World): void {
  const play = getPlayState();
  if (play === 'stopped') { clearZoneState(world, '2d'); return; } // fresh baseline on next Play
  if (play === 'paused') return;                                   // freeze: keep membership, emit nothing

  const found: { entity: Entity; shape: string }[] = [];
  world.query(Zone2D, Transform).updateEach(([zone], entity) => {
    found.push({ entity, shape: zone.shape });
  });
  // No zones at all: skip occupant sampling AND the index build (mirrors physics' empty-body
  // early-out). Still run the diff with empty inputs so a zone removed this frame flushes exits
  // for its prior occupants (runZoneTriggers is a cheap no-op when both are empty).
  if (found.length === 0) { runZoneTriggers(world, '2d', [], EMPTY, zone2DEvents, fireOnZone2D, '@zone'); return; }

  const index = buildEntityIndex(world);
  const zones: ZoneCandidate[] = [];
  for (const f of found) {
    if (!isEntityActiveInHierarchy(index, f.entity.id())) continue; // inactive zone → its occupants exit
    zones.push({ entity: f.entity, contains: makeContains2D(f.shape, readWorldTRS(f.entity)) });
  }
  // Every zone inactive is the same as no zones — but the diff must still run to flush the exits.
  if (zones.length === 0) { runZoneTriggers(world, '2d', zones, EMPTY, zone2DEvents, fireOnZone2D, '@zone'); return; }

  const occupants: OccupantSample[] = [];
  world.query(ZoneOccupant, Transform).updateEach((_v, entity) => {
    if (!isEntityActiveInHierarchy(index, entity.id())) return; // inactive occupant → exits every zone
    const p = readWorldTRS(entity);
    occupants.push({ entity, x: p.x, y: p.y, z: 0 });
  });

  runZoneTriggers(world, '2d', zones, occupants, zone2DEvents, fireOnZone2D, '@zone');
}
