/** Why `scene-query` found no physics world — and what the caller should do about it (#1260).
 *
 *  A world exists only once the physics system has ticked over at least one rigid body, and is
 *  freed on Stop. "No world" has several causes with DIFFERENT remedies, and a hint that names the
 *  wrong one sends the agent the wrong way: "start the sim" to a sim that is already playing, or
 *  "retry after a frame" to a world that can never be built (a permanent Rapier load failure, a
 *  build with the module stripped). Pure, so every branch is testable directly;
 *  `sceneQueryPhysicsLoad.test.ts` drives the op's own wait with a mocked loader.
 *
 *  `stopped` is decided before any Rapier state: the op does not wait on the loader when stopped,
 *  so a load failure there surfaces on the first query after Play.
 */

export type WorldAbsence =
  | 'no-bodies'          // nothing to simulate — play mode cannot help
  | 'no-physics-module'  // this build strips the module; the system is never registered
  | 'stopped'            // start the sim
  | 'physics-failed'     // Rapier will not load; retrying cannot help
  | 'physics-loading'    // Rapier is still loading — retry
  | 'not-built-yet';     // loaded, in play mode, not ticked since the bodies appeared — retry

export interface AbsenceInput {
  dim: '2d' | '3d';
  hasBodies: boolean;
  moduleInBuild: boolean;
  playState: 'stopped' | 'playing' | 'paused';
  /** The Rapier module for `dim`, when the world has bodies of that dimension:
   *  `ready`, still `loading` after a short wait, or `failed` with the loader's error. */
  rapier: { state: 'ready' } | { state: 'loading' } | { state: 'failed'; error: string };
}

/** Order matters: each check assumes the ones above it passed. */
export function classifyWorldAbsence(i: AbsenceInput): { reason: WorldAbsence; hint: string } {
  const D = i.dim.toUpperCase();
  if (!i.hasBodies) {
    return { reason: 'no-bodies', hint: `A Rapier world is built only for a scene with RigidBody${D} entities, and this one has none — add a body with a Collider${D}.` };
  }
  if (!i.moduleInBuild) {
    return { reason: 'no-physics-module', hint: `This build strips the ${D} physics module, so no ${D} world is ever built — nothing here can be queried in ${D}.` };
  }
  if (i.playState === 'stopped') {
    return { reason: 'stopped', hint: 'A Rapier world is built by the physics system on its first tick and freed on Stop, so a STOPPED sim has none. Start the sim (play), then query.' };
  }
  if (i.rapier.state === 'failed') {
    return { reason: 'physics-failed', hint: `Rapier ${D} failed to load and will not be retried in this session (${i.rapier.error}), so the world can never be built — retrying the query cannot help; relaunch.` };
  }
  if (i.rapier.state === 'loading') {
    return { reason: 'physics-loading', hint: `Rapier ${D} is still loading its WASM, so the world is not built yet. Retry shortly.` };
  }
  return {
    reason: 'not-built-yet',
    hint: `The sim is in play mode and the scene has RigidBody${D} entities, but the physics system has not ticked since `
      + 'they appeared, so the world is not built yet. Retry after a frame; if the sim is paused, step it once.',
  };
}
