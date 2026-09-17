/** Wait for the Rapier WASM a world NEEDS, before anything ticks it (#1175).
 *
 *  The physics systems init Rapier lazily and SKIP the tick until it resolves
 *  (`if (!isRapierReady()) { void initRapier2D(); return; }`), so a game with no physics
 *  never downloads it. The cost of that laziness was silent: a cold scene ran its first
 *  frames with no physics at all — bodies frozen at their authored pose, no contacts, an
 *  empty @collision journal — and an agent asserting "these two never collide" after N
 *  steps got a false pass that looked exactly like the real one.
 *
 *  So the tick-advancing entry points await this first: `SceneManager.loadScene` on the
 *  staging world before the swap (covers boot, devices and every editor scene load),
 *  `enterPlay`, the editor agent `play`/`resume`/`step` ops (a body added AFTER load; `play` from stopped
 *  gets it inside enterPlay) and the device `sim-step` op (raced against its own timeout budget). The lazy path
 *  in the systems stays as the fallback for a body a game spawns mid-play into a scene
 *  that had none — awaiting there would stall a live frame loop.
 *
 *  The gate is the SAME one the systems use (any `RigidBody2D` / `RigidBody3D` in the
 *  world), so this never loads a Rapier the systems would not have loaded anyway. */

import type { World } from 'koota';
import { RigidBody2D } from '../traits/RigidBody2D';
import { RigidBody3D } from '../traits/RigidBody3D';
import { initRapier2D, isRapierReady } from './rapierLoader';
import { initRapier3D, isRapier3DReady } from './rapier3DLoader';

export type PhysicsReadiness = { ok: true } | { ok: false; error: string };

/** Await one loader, riding its own retry budget. `init()` returns the SAME memoised promise
 *  until a rejection clears it (#541), so a fresh promise after a failure means the loader
 *  granted another attempt; the same one back means it gave up. Identity, not a copy of the
 *  loader's attempt count. */
async function awaitLoader(init: () => Promise<void>, ready: () => boolean): Promise<string | null> {
  let attempt = init();
  for (;;) {
    try {
      await attempt;
      return null;
    } catch (err) {
      if (ready()) return null;
      const next = init();
      if (next === attempt) return err instanceof Error ? err.message : String(err);
      attempt = next;
    }
  }
}

/** Resolve once every Rapier module `world`'s bodies need is instantiated. Never rejects:
 *  a permanent init failure comes back as `{ok:false}` so a caller that must not tick a
 *  physics-less world (the agent `step` op) can refuse, and one that must proceed anyway
 *  (a scene load) can — the loader has already logged the error loudly. */
export async function ensurePhysicsReady(world: World): Promise<PhysicsReadiness> {
  const pending = pendingPhysics(world);
  if (pending.length === 0) return { ok: true };
  const errors: string[] = [];
  await Promise.all(pending.map((m) => awaitLoader(m.init, m.ready).then((e) => { if (e) errors.push(`[${m.name}] ${e}`); })));
  return errors.length === 0 ? { ok: true } : { ok: false, error: errors.join('; ') };
}

export type PhysicsModuleName = 'physics2D' | 'physics3D';
interface PendingModule { name: PhysicsModuleName; init: () => Promise<void>; ready: () => boolean }

/** `ensurePhysicsReady` for ONE module — for a caller whose answer depends on a single dimension
 *  (`scene-query`, #1260). Waiting on both would let the other dimension's slow load mask this one's
 *  permanent failure as "still loading". Never rejects; loads nothing the build strips. */
export async function ensurePhysicsModuleReady(name: PhysicsModuleName): Promise<PhysicsReadiness> {
  const on = name === 'physics2D' ? __MODOKI_MODULE_PHYSICS2D__ : __MODOKI_MODULE_PHYSICS3D__;
  if (!on) return { ok: false, error: `[${name}] not in this build` };
  const e = name === 'physics2D'
    ? await awaitLoader(initRapier2D, isRapierReady)
    : await awaitLoader(initRapier3D, isRapier3DReady);
  return e ? { ok: false, error: `[${name}] ${e}` } : { ok: true };
}

/** The Rapier modules `world`'s bodies need that are NOT instantiated yet (empty = a tick would
 *  simulate). Synchronous — the cheap "is there anything to wait for?" check before an await. */
export function pendingPhysics(world: World): PendingModule[] {
  const out: PendingModule[] = [];
  if (__MODOKI_MODULE_PHYSICS2D__ && !isRapierReady() && world.queryFirst(RigidBody2D) !== undefined) {
    out.push({ name: 'physics2D', init: initRapier2D, ready: isRapierReady });
  }
  if (__MODOKI_MODULE_PHYSICS3D__ && !isRapier3DReady() && world.queryFirst(RigidBody3D) !== undefined) {
    out.push({ name: 'physics3D', init: initRapier3D, ready: isRapier3DReady });
  }
  return out;
}
