/** characterInput3DSystem — bridges the canonical `Input` resource onto every
 *  CharacterController3D's input fields (generalized in the input-and-ui-focus
 *  plan). Reads source-agnostic actions from `Input`, never the DOM, so keyboard /
 *  gamepad / native pad all drive 3D characters identically.
 *
 *  Runs at GAME priority (after the INPUT-tier `inputSystem`), so it only ticks
 *  while the sim is playing. Deterministic (plain trait reads) → also harness-safe.
 *
 *  Mapping: moveX → cc.moveX (A/D, ∓X). moveY → cc.moveZ NEGATED — the forward key
 *  (W/↑) reports moveY=+1 but moves into the scene along −Z, matching the prior
 *  axisZ convention. jump ← `jump` action (Space; W is forward here, not jump). */

import type { World } from 'koota';
import { CharacterController3D } from '../traits/CharacterController3D';
import { axis, pressed } from '../traits/Input';

export function characterInput3DSystem(world: World): void {
  const ax = axis(world, 'moveX');
  const az = -axis(world, 'moveY');            // forward (moveY=+1) → −Z
  const jump = pressed(world, 'jump');         // once per frame (edge; Space)
  world.query(CharacterController3D).updateEach(([cc]: [{ moveX: number; moveZ: number; jump: boolean }]) => {
    cc.moveX = ax;
    cc.moveZ = az;
    if (jump) cc.jump = true;                  // consumed by the controller when grounded
  });
}
