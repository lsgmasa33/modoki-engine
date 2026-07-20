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

import type { World } from 'koota';
import { Zone2D } from '../traits/Zone2D';
import { ZoneOccupant } from '../traits/ZoneOccupant';
import { OnZone2D } from '../traits/OnZone2D';
import { Transform } from '../traits/Transform';
import { zone2DEvents } from '../managers/Zone2DEvents';
import { getPlayState } from './playState';
import {
  runZoneTriggers, clearZoneState, makeFireOnZone, readWorldTRS,
  type ZoneCandidate, type OccupantSample,
} from './zoneTriggerCore';

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

export function zone2DSystem(world: World): void {
  const play = getPlayState();
  if (play === 'stopped') { clearZoneState(world, '2d'); return; } // fresh baseline on next Play
  if (play === 'paused') return;                                   // freeze: keep membership, emit nothing

  // Zones first: with none this dimension, skip occupant sampling (mirrors physics' empty-body
  // early-out). Still run the diff with empty inputs so a zone removed this frame flushes exits.
  const zones: ZoneCandidate[] = [];
  world.query(Zone2D, Transform).updateEach(([zone], entity) => {
    zones.push({ entity, contains: makeContains2D(zone.shape, readWorldTRS(entity)) });
  });
  if (zones.length === 0) { runZoneTriggers(world, '2d', zones, EMPTY, zone2DEvents, fireOnZone2D, '@zone'); return; }

  const occupants: OccupantSample[] = [];
  world.query(ZoneOccupant, Transform).updateEach((_v, entity) => {
    const p = readWorldTRS(entity);
    occupants.push({ entity, x: p.x, y: p.y, z: 0 });
  });

  runZoneTriggers(world, '2d', zones, occupants, zone2DEvents, fireOnZone2D, '@zone');
}
