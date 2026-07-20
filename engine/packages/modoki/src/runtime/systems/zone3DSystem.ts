/** zone3DSystem — the producer behind `Zone3DEvents` + the declarative `OnZone3D` trait. Each
 *  frame (while the sim runs) it samples every `ZoneOccupant` world position and tests it against
 *  every `Zone3D` volume, then hands the (zone × occupant) containment to `runZoneTriggers`, which
 *  diffs against last frame and fans enter/exit to the journal (`@zone`) + the `zone3DEvents` bus +
 *  the `OnZone3D` action. A zone is a PURE geometric test — no Rapier colliders involved.
 *
 *  Registered AFTER transform propagation (see app pipeline) so occupant/zone world poses are this
 *  frame's final positions, and internally sim-gated: when stopped it clears the occupancy baseline
 *  so the next Play re-fires `enter` for whatever is already inside (a clean start-of-play).
 *
 *  Containment matches the editor wireframe (`SceneView` Zone3D gizmo) exactly — same scale→volume
 *  mapping — so "inside" always agrees with what the author sees:
 *   - `sphere`   radius = sx (3D ball)
 *   - `circle`   flat disc in the ground (XZ) plane, radius = sx (Y ignored)
 *   - `cylinder` radius = sx, full height = sy (|dy| ≤ sy/2)
 *   - `capsule`  radius = sx, total height = sy (cylindrical segment + hemispherical caps)
 *   - `box`      full size = scale (half-extents sx/2, sy/2, sz/2)
 *   - `plane`    flat rectangle in the ground plane, size = sx × sz (Y ignored)
 *  The occupant is tested in the zone's LOCAL frame (its rotation is undone first), so a rotated
 *  box/plane/cylinder contains correctly. */

import type { World } from 'koota';
import * as THREE from 'three';
import { Zone3D } from '../traits/Zone3D';
import { ZoneOccupant } from '../traits/ZoneOccupant';
import { OnZone3D } from '../traits/OnZone3D';
import { Transform } from '../traits/Transform';
import { zone3DEvents } from '../managers/Zone3DEvents';
import { getPlayState } from './playState';
import {
  runZoneTriggers, clearZoneState, makeFireOnZone, readWorldTRS,
  type ZoneCandidate, type OccupantSample,
} from './zoneTriggerCore';

const fireOnZone3D = makeFireOnZone(OnZone3D);
const EMPTY: OccupantSample[] = [];   // shared empty occupant list for the no-zones flush path

// Scratch reused by the containment closures (one test runs at a time within a frame).
const _e = new THREE.Euler();
const _v = new THREE.Vector3();

/** Build a containment predicate from a zone's world pose, capturing centre/rotation/scale so it
 *  can be tested against many occupants. `pose` is `readWorldTRS`'s shared singleton — every field
 *  is copied into a closure-local BEFORE returning, so the next `readWorldTRS` can't clobber it. */
function makeContains3D(shape: string, pose: { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }): ZoneCandidate['contains'] {
  const cx = pose.x, cy = pose.y, cz = pose.z;
  const sx = Math.abs(pose.sx) || 1e-6, sy = Math.abs(pose.sy) || 1e-6, sz = Math.abs(pose.sz) || 1e-6;
  const invQ = new THREE.Quaternion().setFromEuler(_e.set(pose.rx, pose.ry, pose.rz, 'XYZ')).invert();
  return (x, y, z) => {
    _v.set(x - cx, y - cy, z - cz).applyQuaternion(invQ);
    const dx = _v.x, dy = _v.y, dz = _v.z;
    switch (shape) {
      case 'box': return Math.abs(dx) <= sx / 2 && Math.abs(dy) <= sy / 2 && Math.abs(dz) <= sz / 2;
      case 'plane': return Math.abs(dx) <= sx / 2 && Math.abs(dz) <= sz / 2;
      case 'circle': return dx * dx + dz * dz <= sx * sx;
      case 'cylinder': return dx * dx + dz * dz <= sx * sx && Math.abs(dy) <= sy / 2;
      case 'capsule': {
        const half = Math.max(0, sy / 2 - sx);           // segment half-length (caps add sx each end)
        const cyy = Math.max(-half, Math.min(half, dy));  // nearest point on the segment axis
        return dx * dx + (dy - cyy) * (dy - cyy) + dz * dz <= sx * sx;
      }
      case 'sphere':
      default: return dx * dx + dy * dy + dz * dz <= sx * sx;
    }
  };
}

export function zone3DSystem(world: World): void {
  const play = getPlayState();
  if (play === 'stopped') { clearZoneState(world, '3d'); return; } // fresh baseline on next Play
  if (play === 'paused') return;                                   // freeze: keep membership, emit nothing

  // Zones first: with none this dimension, skip occupant sampling entirely (mirrors physics'
  // empty-body early-out). Still run the diff with empty inputs so a zone removed this frame
  // flushes exits for its prior occupants (runZoneTriggers is a cheap no-op when both are empty).
  const zones: ZoneCandidate[] = [];
  world.query(Zone3D, Transform).updateEach(([zone], entity) => {
    zones.push({ entity, contains: makeContains3D(zone.shape, readWorldTRS(entity)) });
  });
  if (zones.length === 0) { runZoneTriggers(world, '3d', zones, EMPTY, zone3DEvents, fireOnZone3D, '@zone'); return; }

  const occupants: OccupantSample[] = [];
  world.query(ZoneOccupant, Transform).updateEach((_v2, entity) => {
    const p = readWorldTRS(entity);
    occupants.push({ entity, x: p.x, y: p.y, z: p.z });
  });

  runZoneTriggers(world, '3d', zones, occupants, zone3DEvents, fireOnZone3D, '@zone');
}
