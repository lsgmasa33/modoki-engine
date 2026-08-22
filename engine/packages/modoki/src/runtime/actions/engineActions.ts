/** Engine built-in UIActions — app lifecycle (reload / quit) + animator control.
 *
 *  Scene navigation (engine.loadScene / engine.navigateBack) lives in
 *  NavigationManager, which owns the history stack. These lifecycle actions have
 *  no state, so they stay as plain built-ins registered once at startup. */

import { registerUIAction } from '../core/actionRegistry';
import { SkeletalAnimator } from '../traits/SkeletalAnimator';
import { Animator } from '../traits/Animator';
import { SpriteAnimator } from '../traits/SpriteAnimator';
import { animatorHasClip } from '../animation/animClipBank';
import { spriteAnimHasClip } from '../loaders/spriteAnimCache';
import { scrollToEntry } from '../ui/scrollApi';
import { EntityAttributes } from '../core/traits/EntityAttributes';

/** A UIAction `target` is an entity handle; the scroll API addresses by GUID (the only
 *  hot-reload-stable address). One hop, in one place. */
function guidOfEntity(target: { has(t: unknown): boolean; get(t: unknown): unknown }): string {
  if (!target.has(EntityAttributes)) return '';
  return ((target.get(EntityAttributes) as { guid?: string }).guid) || '';
}

let registered = false;

export function registerEngineActions(): void {
  if (registered) return;
  registered = true;

  // engine.reload — hard reload of the web view.
  registerUIAction('engine.reload', () => {
    if (typeof window !== 'undefined') window.location.reload();
  });

  // ui.scrollTo — move a scroll view to an entry, with no game code.
  //  The binding's `target` is the scroll-view entity; `params.x`/`params.y` are ENTRY
  //  coordinates (the units an author thinks in — "page 3", not "pixel 1863"), and the system
  //  converts them using the entry size it already resolves. `params.behavior` is
  //  'instant' | 'smooth', the only two values the CSS backend can genuinely honour.
  registerUIAction('ui.scrollTo', ({ target, params }) => {
    if (!target) {
      console.warn('[ui.scrollTo] no target entity — point the binding at the scroll view');
      return;
    }
    const guid = guidOfEntity(target);
    if (!guid) { console.warn('[ui.scrollTo] target has no guid'); return; }
    const p = (params ?? {}) as { x?: number; y?: number; behavior?: 'instant' | 'smooth' };
    const ok = scrollToEntry(guid, { x: p.x, y: p.y }, { behavior: p.behavior });
    if (!ok) console.warn('[ui.scrollTo] target is not a scroll view (needs UIScrollView + UIEntries)');
  });

  // engine.quit — native-only. On web there is nothing to quit; the app shell
  // can wire Capacitor's App.exitApp() if a real quit is needed on device.
  registerUIAction('engine.quit', () => {
    console.info('[engine.quit] no-op on web');
  });

  // engine.toggleAnimator — flip `playing` on the target entity's animator.
  //  A `call` binding carries a per-instance target GUID (bindings.ts), resolved
  //  to ctx.target, so one global handler pauses/resumes the SPECIFIC rig the
  //  button points at. Both animator flavours are pure-data traits with a
  //  `playing` field (SkeletalAnimator = GLB skeletal clips, Animator = keyframe
  //  .anim.json), so toggling is a plain field write the render sync picks up
  //  next frame. Toggles whichever animator trait(s) the target carries.
  registerUIAction('engine.toggleAnimator', ({ target }) => {
    if (!target) {
      console.warn('[engine.toggleAnimator] no target entity — set the binding target to an animator entity');
      return;
    }
    let toggled = false;
    const skel = target.get(SkeletalAnimator);
    if (skel) {
      target.set(SkeletalAnimator, { ...skel, playing: !skel.playing });
      toggled = true;
    }
    const anim = target.get(Animator);
    if (anim) {
      target.set(Animator, { ...anim, playing: !anim.playing });
      toggled = true;
    }
    if (!toggled) {
      console.warn('[engine.toggleAnimator] target has no SkeletalAnimator or Animator trait');
    }
  });

  // engine.playClip — switch the target's active animation clip BY NAME, across ALL THREE
  //  animator flavours. All three model "the active clip is a NAME" (Animator keyframe,
  //  SpriteAnimator flipbook, SkeletalAnimator GLB), so ONE action drives whichever trait(s)
  //  the target carries — the unified twin of engine.toggleAnimator. The name comes from the
  //  binding's typed `clip` param (or the event `$value`). Writing the name makes each system
  //  pick it up next frame (Unity's Animator.Play): keyframe/sprite reset `time` + set
  //  `playing`; skeletal lets its mixer crossfade per `fadeDuration`.
  //
  //  Guards differ by where the clip list lives: keyframe (`animatorHasClip`) and sprite
  //  (`spriteAnimHasClip`) validate synchronously against the bank/clipSet and no-op+warn on
  //  an unknown name; skeletal clips live in the GLB/animset and are validated at the render
  //  layer (driveAnimator ignores an unknown name), so no synchronous guard here.
  registerUIAction('engine.playClip', {
    params: { clip: { type: 'string', tooltip: 'Clip NAME to play — must exist on the target animator (keyframe/sprite bank, or a GLB/animset clip for skeletal)' } },
    handler: ({ target, params, payload }) => {
      if (!target) {
        console.warn('[engine.playClip] no target entity — set the binding target to an animator entity');
        return;
      }
      const name = (typeof params?.clip === 'string' && params.clip) ? params.clip
        : (typeof payload === 'string' ? payload : '');
      if (!name) {
        console.warn('[engine.playClip] no clip name (set the `clip` param or bind $value)');
        return;
      }
      let hasAnimator = false;
      let switched = false;

      const spr = target.get(SpriteAnimator);
      if (spr) {
        hasAnimator = true;
        if (spriteAnimHasClip(spr, name)) { target.set(SpriteAnimator, { ...spr, clip: name, time: 0, playing: true }); switched = true; }
      }
      const anim = target.get(Animator);
      if (anim) {
        hasAnimator = true;
        if (animatorHasClip(anim, name)) { target.set(Animator, { ...anim, clip: name, time: 0, playing: true }); switched = true; }
      }
      const skel = target.get(SkeletalAnimator);
      if (skel) {
        hasAnimator = true;
        target.set(SkeletalAnimator, { ...skel, clip: name, playing: true }); // render layer validates + crossfades
        switched = true;
      }

      if (!hasAnimator) console.warn('[engine.playClip] target has no Animator / SpriteAnimator / SkeletalAnimator trait');
      else if (!switched) console.warn(`[engine.playClip] no clip named "${name}" on the target's animator(s)`);
    },
  });
}
