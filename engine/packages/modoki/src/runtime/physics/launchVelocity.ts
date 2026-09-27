/** The velocity a Rapier body is CREATED with — shared by physics2DSystem and physics3DSystem.
 *
 *  `RigidBody2D/3D.vx…` are solver READ-BACK: `runtimeOnly`, so the Play snapshot and every save
 *  drop them (#1592 — an authored `vx` launched once, then Stop restored 0 and a save lost it).
 *  The authored launch velocity lives in the separate `initial*` fields instead (the "different
 *  field for the runtime state" strategy, docs/engine-concepts.md § authored-overwrite).
 *
 *  An entity launches ONCE per Play, tracked by its runtimeOnly `RigidBody*.launched` flag — on the
 *  ENTITY, not the body record, because a structural rebuild and a scene swap that CARRIES the
 *  entity into a fresh physics world both create a new record for a body that has already flown.
 *  Stop clears the flag and the read-back (`resetLaunchOnStop`); without that, Stop CARRIES
 *  Persistent / kept-base entities with runtimeOnly fields intact, so the next Play either never
 *  launched them or mistook the old read-back for a code-written velocity. Four shapes were tried
 *  before this one; docs/physics-2d.md records why each failed.
 *
 *  - Already launched → the live velocity, whatever it is.
 *  - Not yet → what code wrote into the read-back fields before the body existed (a spawned
 *    projectile's `vx`, a carried body thrown at release) if any of it is non-zero, else the
 *    authored `initial*`. Linear and angular are decided independently. */
export function launchVelocity(launched: boolean, current: readonly number[], initial: readonly number[]): readonly number[] {
  if (launched) return current;
  return current.some((v) => v !== 0) ? current : initial;
}

/** Has this entity already launched? Marks it launched when it gets a DYNAMIC body now — a
 *  kinematic/static body ignores linvel, so marking it would swallow `initial*` for a body released
 *  later (kinematic → dynamic rebuild). Mutates `rb`: call inside the body pass's `updateEach`,
 *  which writes it back. */
export function takeLaunch(rb: { bodyType: string; launched: boolean }): boolean {
  if (rb.bodyType !== 'dynamic') return true;
  if (rb.launched) return true;
  rb.launched = true;
  return false;
}

/** Play→Stop: un-launch every body and zero its read-back, so an entity Stop carries into the
 *  restored world launches afresh on the next Play (see the header). */
export function resetLaunchOnStop(rb: { launched: boolean }, readBack: readonly string[]): void {
  rb.launched = false;
  for (const k of readBack) (rb as Record<string, unknown>)[k] = 0;
}
