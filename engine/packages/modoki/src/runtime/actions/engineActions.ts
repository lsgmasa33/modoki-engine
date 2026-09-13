/** Engine built-in UIActions — app lifecycle (reload / quit) + animator and Director control.
 *
 *  Scene navigation (engine.loadScene / engine.navigateBack) lives in
 *  NavigationManager, which owns the history stack. These lifecycle actions have
 *  no state, so they stay as plain built-ins registered once at startup. */

import { registerUIAction, refuseAction } from '../core/actionRegistry';
import { shutdownRealmThenReload } from '../core/realmShutdown';
import { SkeletalAnimator } from '../traits/SkeletalAnimator';
import { Animator } from '../traits/Animator';
import { SpriteAnimator } from '../traits/SpriteAnimator';
import { Director } from '../traits/Director';
import { findSlavingParent, seekLandsAt } from '../timeline/timelineSystem';
import { findEntityById } from '../core/ecs/world';
import { animatorHasClip } from '../animation/animClipBank';
import { spriteAnimHasClip } from '../loaders/spriteAnimCache';
import { scrollToEntry } from '../ui/scrollApi';
import { EntityAttributes } from '../core/traits/EntityAttributes';
import { ANIMATOR_CLIP_TRAITS, switchableClipNames, skeletalClipRoster } from '../animation/switchableClips';

/** A UIAction `target` is an entity handle; the scroll API addresses by GUID (the only
 *  hot-reload-stable address). One hop, in one place. */
function guidOfEntity(target: { has(t: unknown): boolean; get(t: unknown): unknown }): string {
  if (!target.has(EntityAttributes)) return '';
  return ((target.get(EntityAttributes) as { guid?: string }).guid) || '';
}

/** `name (guid)` for a warn message — the two addresses a human and an agent respectively need to
 *  find the entity again. Falls back to the runtime id when neither is authored, which is better
 *  than an empty string even though ids are reassigned on every scene reload. */
function describeEntity(entity: { has(t: unknown): boolean; get(t: unknown): unknown; id(): number }): string {
  const attr = entity.has(EntityAttributes)
    ? (entity.get(EntityAttributes) as { name?: string; guid?: string })
    : undefined;
  const name = attr?.name || `entity ${entity.id()}`;
  return attr?.guid ? `'${name}' (${attr.guid})` : `'${name}'`;
}

let registered = false;

// ⚠️ Every refusal below is `return refuseAction(...)`, not `console.warn` + `return` (#1129): the
// dispatch-action agent op reads the returned refusal to answer `ok:false`, and holds NO copy of these
// preconditions — so a refusal that only warns is reported to an agent as a success.

export function registerEngineActions(): void {
  if (registered) return;
  registered = true;

  // engine.reload — hard reload of the web view. Dispatch the realm-shutdown tasks (native ad SDK
  // teardown, #587) BEFORE tearing the realm down, so they run rather than race the reload.
  // Fire-and-forget deliberately, unlike `resumeReload.ts`'s `deps.reload()`: a UIAction has no
  // caller waiting to hear back and no `reloading` latch to un-stick on failure, so there is
  // nothing an `await` here would let a `catch` do.
  registerUIAction('engine.reload', () => {
    if (typeof window === 'undefined') return;
    void shutdownRealmThenReload(() => window.location.reload());
  });

  // ui.scrollTo — move a scroll view to an entry, with no game code.
  //  The binding's `target` is the scroll-view entity; `params.x`/`params.y` are ENTRY
  //  coordinates (the units an author thinks in — "page 3", not "pixel 1863"), and the system
  //  converts them using the entry size it already resolves. `params.behavior` is
  //  'instant' | 'smooth', the only two values the CSS backend can genuinely honour.
  registerUIAction('ui.scrollTo', ({ target, params }) => {
    if (!target) return refuseAction('[ui.scrollTo] no target entity — point the binding at the scroll view');
    const guid = guidOfEntity(target);
    if (!guid) return refuseAction('[ui.scrollTo] target has no guid');
    const p = (params ?? {}) as { x?: number; y?: number; behavior?: 'instant' | 'smooth' };
    const ok = scrollToEntry(guid, { x: p.x, y: p.y }, { behavior: p.behavior });
    if (!ok) return refuseAction(`[ui.scrollTo] ${describeEntity(target)} is not a scroll view (needs UIScrollView + UIEntries)`);
    return undefined;
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
    if (!target) return refuseAction('[engine.toggleAnimator] no target entity — set the binding target to an animator entity');
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
    if (!toggled) return refuseAction(`[engine.toggleAnimator] ${describeEntity(target)} has no SkeletalAnimator or Animator trait`);
    return undefined;
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
  //  (`spriteAnimHasClip`) validate synchronously against the bank/clipSet. Skeletal clips live in
  //  the GLB/animsets, which may not have loaded yet, so a skeletal name is refused only when its
  //  roster is COMPLETE (every source loaded — `skeletalClipRoster`), non-empty, and lacks the name;
  //  otherwise the write goes through for the render layer (whose driveAnimator warns and falls back to
  //  the first clip on a name it has no action for, and merges a still-loading source when it arrives). That rule used
  //  to live only in the agent bridge's pre-flight, so an agent was refused a typo'd skeletal clip that
  //  an authored button silently wrote (#1129, owner 2026-09-14).
  registerUIAction('engine.playClip', {
    params: { clip: { type: 'string', tooltip: 'Clip NAME to play — must exist on the target animator (keyframe/sprite bank, or a GLB/animset clip for skeletal)' } },
    handler: ({ target, params, payload }) => {
      if (!target) return refuseAction('[engine.playClip] no target entity — set the binding target to an animator entity');
      const name = (typeof params?.clip === 'string' && params.clip) ? params.clip
        : (typeof payload === 'string' ? payload : '');
      if (!name) return refuseAction('[engine.playClip] no clip name (set the `clip` param or bind $value)');
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
        const roster = skeletalClipRoster(target.id());
        if (!roster.complete || roster.names.length === 0 || roster.names.includes(name)) {
          target.set(SkeletalAnimator, { ...skel, clip: name, playing: true }); // render layer validates + crossfades
          switched = true;
        }
      }

      if (!hasAnimator) {
        return refuseAction(`[engine.playClip] ${describeEntity(target)} has no Animator / SpriteAnimator / SkeletalAnimator trait — nothing to drive`);
      }
      if (!switched) {
        const known = [...ANIMATOR_CLIP_TRAITS].flatMap((t) => switchableClipNames(target.id(), t));
        return refuseAction(
          `[engine.playClip] no clip named "${name}" on ${describeEntity(target)}'s animator(s) (names are case-sensitive)${known.length ? `. Known clips: ${known.join(', ')}` : ''}`,
          { detail: { known } },
        );
      }
      return undefined;
    },
  });

  // engine.director — play / pause / toggle / restart the target's Director, and optionally seek
  //  or change its rate. The Director is the timeline's own player, so this is the cutscene twin
  //  of engine.toggleAnimator: same `playing` flag, same "write the field, the system picks it up
  //  next frame" shape.
  //
  //  ⚠️ **Why this action has to exist at all** (#1093). It was the ONE playable component with no
  //  runtime affordance — every animator flavour had two, and a Director had none — so the only
  //  lever on a running cutscene was a scene edit. `/api/scene-mutate` refuses those while the game
  //  is Playing (by design: edits during Play are discarded on Stop), which left a cutscene
  //  unpausable by an agent, by a device, AND by a Pause button somebody authors into the game.
  //  That last one is the reason this is an engine action rather than agent tooling.
  //
  //  ⚠️ `restart` clears `started`, and that IS load-bearing: `timelineSystem` reads
  //  `justStarted = !dir.started` to fire the once-only sequence-start fan-out, and skips a
  //  non-advancing first frame via `if (advanced <= 0 && !dir.started) return`. Rewinding `time`
  //  alone would replay the sequence with its start events silently missing.
  //
  //  ⚠️ It also rewrites `lastTime`, and that is NOT load-bearing — purely keeping the read-back
  //  coherent. `Director.lastTime` is written by the system and read by NOTHING (verified
  //  repo-wide, #1093); the edge-detection window is `(dir.time, advance(dir.time, …)]`, taken from
  //  `time`, never from `lastTime`. Two docblocks claimed otherwise and were corrected in the same
  //  change — do not reintroduce a seek "fix" that resets `lastTime` to prevent a replay it cannot
  //  cause.
  registerUIAction('engine.director', {
    params: {
      action: {
        type: 'enum', options: ['play', 'pause', 'toggle', 'restart'],
        tooltip: 'play = resume, pause = hold, toggle = flip, restart = rewind to 0 and play (re-fires the sequence-start events)',
      },
      time: { type: 'number', tooltip: 'Optional: seek the playhead to this time in seconds, kept inside the timeline (clamped, or wrapped when looping). A paused Director is re-posed at the new time (keyframe + activation tracks). Does NOT re-fire sequence-start or the markers it skips (use restart for that), but a seek onto the end still fires the end once.' },
      speed: { type: 'number', tooltip: 'Optional: playback rate multiplier (1 = normal, 0.5 = half speed). Forward only — a negative rate is clamped to 0, because reverse playback is not supported.' },
    },
    handler: ({ target, params, payload, world }) => {
      if (!target) return refuseAction('[engine.director] no target entity — set the binding target to an entity carrying a Director');
      const dir = target.get(Director);
      if (!dir) {
        return refuseAction(`[engine.director] ${describeEntity(target)} has no Director trait — Directors live on the entity that owns the timeline`);
      }
      // ⚠️ REFUSE on a parent-driven child, before any transport verb is interpreted (#1112).
      //
      //  A Director slaved to a parent's `subdirector` clip has a playhead that is a pure FUNCTION
      //  of the parent's — `driveSubdirector` writes `time = parentTime − clip.start` back onto it
      //  every in-span frame — so `playing`/`speed` here would never be read and `time`/`started`
      //  would be overwritten on the next frame. Writing them anyway is what this issue was: the
      //  flag moved, the agent bridge answered `dispatched:true`, and the cutscene kept playing,
      //  with the still-moving playhead as the only symptom.
      //
      //  ALL SIX verbs refuse, uniformly (owner, 2026-09-12), rather than forwarding the transport
      //  ones to the parent: forwarding is coherent only for play/pause/toggle — a forwarded `time`
      //  would have to be re-expressed as `clip.start + t` on the parent, and a forwarded `speed`
      //  would re-rate every OTHER track on the parent's timeline, not just this child. So the
      //  caller is handed the parent's address and decides for itself.
      //
      //  This is the choke point all three surfaces share (an authored button, the agent bridge's
      //  dispatch-action op, and its device twin), which is why the refusal lives HERE and ONLY here:
      //  the bridge reads the returned refusal, and `slavedTo` carries the parent's guid so an agent's
      //  retry is mechanical. ⚠️ Never the runtime id as that address — ids are reassigned on every
      //  scene hot-reload, so a retry against one drives whatever now holds it.
      const slaving = findSlavingParent(world, target.id());
      if (slaving) {
        const parent = findEntityById(slaving.parentId, world);
        const where = parent ? describeEntity(parent) : `entity ${slaving.parentId}`;
        const parentGuid = parent ? guidOfEntity(parent) : '';
        return refuseAction(
          `[engine.director] ${describeEntity(target)} is a SLAVED sub-director, DRIVEN by a parent's subdirector clip (parent ${where}, track '${slaving.trackId}') — its playhead is computed from the parent's every frame, so play/pause/toggle/restart/seek/speed on it cannot take effect. Refused, nothing written. Target the parent instead${parentGuid ? '' : ' (it carries no guid — re-read the hierarchy to aim at it)'}.`,
          { detail: parentGuid ? { slavedTo: parentGuid } : {} },
        );
      }
      const action = (typeof params?.action === 'string' && params.action) ? params.action
        : (typeof payload === 'string' && payload ? payload : 'toggle');
      const next = { ...dir };
      switch (action) {
        case 'play': next.playing = true; break;
        case 'pause': next.playing = false; break;
        case 'toggle': next.playing = !dir.playing; break;
        case 'restart':
          next.time = 0;
          next.lastTime = 0;
          next.started = false;   // see the docblock — this is what re-arms the start fan-out
          next.playing = true;
          break;
        default:
          return refuseAction(`[engine.director] unknown action "${action}" (expected play|pause|toggle|restart)`);
      }
      // Seeking is orthogonal to the transport action, so it applies AFTER and wins — `{action:
      // 'restart', time: 3}` means "start this playthrough over, from 3s", which is the only
      // reading under which both arguments survive.
      //
      // ⚠️ `started` is deliberately NOT cleared here. Seeking moves the playhead WITHIN a
      // playthrough; re-firing the once-only start fan-out on every scrub would make a timeline
      // scrubbed backwards fire its start events repeatedly. `restart` above is the way to ask
      // for that, and it says so in its tooltip.
      if (typeof params?.time === 'number' && Number.isFinite(params.time)) {
        // Wrapped into the timeline AT WRITE (#1113): clamped to [0, duration], or wrapped when the
        // Director loops. It used to be floored only, leaving the rest to `advance()` — which never
        // runs for a PAUSED Director, so `{action:'pause', time: 999}` read back 999 for as long as
        // it stayed paused. `seekLandsAt` is `timelineSystem`'s own wrap rule, not a copy of it.
        //
        // What makes a paused seek re-pose, and a seek onto the end still fire `@sequence end`, is
        // NOT here: `timelineSystem` detects the write itself, so a game system setting
        // `Director.time` directly gets both too.
        next.time = seekLandsAt(next.timeline, next.loop, params.time);
        next.lastTime = next.time;
      }
      // ⚠️ Clamped at 0: REVERSE PLAYBACK IS NOT SUPPORTED, and failing silently is worse than
      // refusing. `timelineSystem` calls it explicitly deferred, and its `crossed()` edge test
      // returns false for every tick where `advanced <= 0` — so a negative rate rewinds the
      // playhead while markers, audio cues, activation edges, skeletal triggers and `@sequence`
      // all stay silent, and anything latched on the way forward stays latched. An authored
      // rewind button would look like it worked and leave the scene wrong.
      if (typeof params?.speed === 'number' && Number.isFinite(params.speed)) {
        if (params.speed < 0) {
          console.warn(`[engine.director] speed ${params.speed} clamped to 0 — reverse playback is not supported (timelineSystem defers it; markers and cues do not fire while rewinding)`);
        }
        next.speed = Math.max(0, params.speed);
      }
      target.set(Director, next);
      return undefined;
    },
  });
}
