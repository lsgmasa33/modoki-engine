/** characterInputSystem — bridges the canonical `Input` resource onto every
 *  CharacterController2D's input fields (Phase 4.5, generalized in the
 *  input-and-ui-focus plan). Reads source-agnostic actions from `Input`, never the
 *  DOM — so a keyboard, gamepad, or a future console pad all drive 2D characters
 *  identically.
 *
 *  Runs at GAME priority (after the INPUT-tier `inputSystem` wrote `Input` this
 *  frame), so it only ticks while the sim is playing. Because it now reads plain
 *  trait data instead of `window`, it is deterministic and CAN run in the headless
 *  harness — a test spawns `Input`, sets its fields, and asserts on `moveX`/`jump`.
 *
 *  Jump preserves the historical 2D binding (W/↑/Space): `jump` covers Space/Enter,
 *  `navUp` covers W/↑ — in 2D there's no forward axis, so up doubles as jump. */

import type { World } from 'koota';
import { CharacterController2D } from '../traits/CharacterController2D';
import { axis, pressed } from '../traits/Input';

export function characterInputSystem(world: World): void {
  const ax = axis(world, 'moveX');
  const jump = pressed(world, 'jump') || pressed(world, 'navUp'); // once per frame (edge)
  world.query(CharacterController2D).updateEach(([cc]: [{ moveX: number; jump: boolean }]) => {
    cc.moveX = ax;
    if (jump) cc.jump = true;                 // consumed by the controller when grounded
  });
}
