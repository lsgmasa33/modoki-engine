import { trait } from 'koota';

/** Tag trait — an **opt-in, per-entity** freeze for animation + Rotate3D.
 *  Add it (e.g. via the editor's Add Component) to stop just that entity's keyframe
 *  animation and procedural rotation while the rest of the sim keeps running.
 *
 *  It is NOT how global pause works: editor Pause/Stop drives `playState`, which
 *  gates the whole TIME/GAME/ANIMATION pipeline tier (see playState.ts). There is
 *  no built-in producer that adds this tag, and `timeSystem` does NOT consult it
 *  (it can't affect global time anyway) — only `animationSystem`/`rotate3DSystem`
 *  honor it. */
export const Paused = trait();
