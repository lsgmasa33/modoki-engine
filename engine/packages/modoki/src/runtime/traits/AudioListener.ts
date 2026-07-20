import { trait } from 'koota';

/** AudioListener — the "ears" of the scene. Put ONE on the active camera entity;
 *  `audioSystem` drives the Web Audio listener pose from this entity's world
 *  Transform each frame so spatial `AudioSource`s attenuate correctly. Absent /
 *  disabled ⇒ the listener sits at the origin (non-spatial audio is unaffected). */
export const AudioListener = trait({
  enabled: true as boolean,
});
