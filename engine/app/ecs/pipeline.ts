/** ECS Pipeline — registers engine systems with the modoki pipeline.
 *  Game-specific systems are registered via GameDefinition.registerSystems(). */

import {
  registerSystem, runPipeline as modokiRunPipeline,
  timeSystem, uiTreeProjection, rotate3DSystem, timelineSystem, animationSystem, spriteAnimationSystem,
  physics2DSystem, physics3DSystem, zone2DSystem, zone3DSystem, inputSystem, characterInputSystem, characterInput3DSystem, characterAnimationSystem, uiFocusSystem, hapticsSystem, skin2DSystem, audioSystem, setAudioWorldPositionResolver, materialInstanceSystem, SYSTEM_PRIORITY,
  videoSystem, setVideoUrlResolver, resolveVideoUrl,
  setVideoSourceResolver, setVideoDownloader, resolveVideoSource,
  VideoCache, CacheApiBackend, hasCacheStorage, setActiveVideoCache,
} from '@modoki/engine/runtime';
import { transformPropagationSystem, worldTransforms } from '@modoki/engine/runtime';

// Spatial audio reads WORLD positions for nested rigs via the Three-computed worldTransforms
// cache — injected here so the engine's audioSystem stays THREE-free (P3). Audio runs after
// transform propagation, so the cache is this frame's final poses.
setAudioWorldPositionResolver((id) => worldTransforms.get(id));

/** Per-game video cache ceiling. A code constant for now — a structural fallback rather than a
 *  tunable, per the single-source-of-truth rule in CLAUDE.md. It becomes a `project.config.json`
 *  knob the first time a game needs to differ, not before. See docs/video.md. */
const VIDEO_CACHE_BUDGET_MB = 256;

// Engine systems
registerSystem('timeSystem', timeSystem, SYSTEM_PRIORITY.TIME);
// Source-agnostic input: merge attached sources (keyboard/pointer/gamepad) into the
// Input resource before GAME systems read it. App-pipeline only (reads the DOM via
// its sources); NOT headless, so the harness stays deterministic (tests set Input).
registerSystem('input', inputSystem, SYSTEM_PRIORITY.INPUT);
// Live keyboard → CharacterController2D input fields (before physics reads them). Sim-gated
// by GAME priority; not registered headless, so the harness stays deterministic.
registerSystem('characterInput', characterInputSystem, SYSTEM_PRIORITY.GAME);
// Live keyboard (WASD + space) → CharacterController3D input fields. App-pipeline only
// (not headless), so the harness stays deterministic. Sim-gated by GAME priority.
registerSystem('characterInput3D', characterInput3DSystem, SYSTEM_PRIORITY.GAME);
// Motion state → SpriteAnimator clip + facing. After input (fresh moveX), before the
// ANIMATION-tier spriteAnimationSystem consumes the chosen clip this same frame.
registerSystem('characterAnimation', characterAnimationSystem, SYSTEM_PRIORITY.GAME);
registerSystem('rotate3D', rotate3DSystem, SYSTEM_PRIORITY.GAME);
// UI focus/navigation: reads the Input resource (nav/confirm/cancel) → moves focus /
// queues activation. GAME tier so it only runs while playing (menus are gameplay);
// after inputSystem (INPUT tier) has this frame's edges. App-pipeline only — the
// activation itself is drained by UIRenderer outside the tick (applyBindings F10).
registerSystem('uiFocus', uiFocusSystem, SYSTEM_PRIORITY.GAME);
// Haptics settings → service. Copies two booleans; never plays anything (a haptic on a per-frame
// path buzzes forever — moments fire from state transitions). INPUT tier so the gates are current
// before this frame's gestures can raise a moment.
registerSystem('haptics', hapticsSystem, SYSTEM_PRIORITY.INPUT);
// Timeline / cutscene sequencer — one tick BEFORE animation (149) so a keyframe-scrub
// Animation track sets Animator.{clip,time} and animationSystem samples that exact pose the
// same frame. Playhead advances on the deterministic sim delta; sim-gated (149 < TRANSFORM),
// so it's inert while stopped/paused. Producer for the TimelineEvents bus + declarative OnSequence.
registerSystem('timeline', timelineSystem, SYSTEM_PRIORITY.ANIMATION - 1);
registerSystem('animation', animationSystem, SYSTEM_PRIORITY.ANIMATION);
registerSystem('spriteAnimation', spriteAnimationSystem, SYSTEM_PRIORITY.ANIMATION);
// Pre-physics world-transform pass (170) — same system as the post-physics one below,
// run BEFORE physics so `worldTransforms` holds this-frame world matrices when physics
// seeds/poses parented bodies. Idempotent (rebuilds the map each call).
registerSystem('transformPropagationPre', transformPropagationSystem, SYSTEM_PRIORITY.TRANSFORM_PREPASS);
// Physics registration is gated on the module flags: a build that excludes a dimension
// (build.modules.physics2d/3d=false / auto-detected unused) neither runs the system nor
// reaches the Rapier loader, so Rolldown DCEs the WASM (see rapierLoader). The flags are
// build-time constants, so the unused branch folds away.
if (__MODOKI_MODULE_PHYSICS2D__) registerSystem('physics2D', physics2DSystem, SYSTEM_PRIORITY.PHYSICS);
// 3D physics (Rapier3D) — shares the PHYSICS tier with 2D; each early-outs when its own
// RigidBody query is empty, so a scene runs whichever dimension it authored.
if (__MODOKI_MODULE_PHYSICS3D__) registerSystem('physics3D', physics3DSystem, SYSTEM_PRIORITY.PHYSICS);
registerSystem('transformPropagation', transformPropagationSystem, SYSTEM_PRIORITY.TRANSFORM);
// CPU 2D sprite skinning — right AFTER transform propagation (201) so it runs even
// when the sim is Stopped (hand-posing Bone2D deforms the mesh live), matching syncBones.
registerSystem('skin2D', skin2DSystem, SYSTEM_PRIORITY.TRANSFORM + 1);
// Zone triggers (2D + 3D) — AFTER transform propagation (202) so occupant/zone world poses are
// this frame's final positions. Registered ≥ TRANSFORM so they tick every frame, but each is
// internally play-state-gated (runs only while Playing; clears its baseline on Stop). Pure
// geometric containment over ZoneOccupant entities — no physics needed. Producers for the
// Zone2DEvents/Zone3DEvents buses + the declarative OnZone2D/OnZone3D actions.
registerSystem('zone2D', zone2DSystem, SYSTEM_PRIORITY.TRANSFORM + 2);
registerSystem('zone3D', zone3DSystem, SYSTEM_PRIORITY.TRANSFORM + 2);
// Audio playback — presentation tier (250), after transform propagation so spatial
// sources read current positions. App-pipeline only (NOT headless) so the harness
// stays deterministic; audioService is itself a no-op without an AudioContext.
registerSystem('audio', audioSystem, SYSTEM_PRIORITY.AUDIO);
// Video playback — presentation tier alongside audio (video's SOUND routes onto the
// audio bus, so they belong at the same stage). App-pipeline only, NOT headless: video
// runs on the browser's media clock and cannot be stepped, so the determinism harness
// must never see it. The GUID→URL resolver is injected for the same reason spatial audio's
// world-position resolver is — it keeps the engine's videoSystem free of the loader stack.
//
// Gated on the module flag: a build that excludes video (build.modules.video = false, or
// 'auto' on a --target playable) never registers the system, never opens a decoder and never
// touches the cache.
//
// What this gate is FOR, measured rather than assumed: the win is the CLIPS, not the code.
// Video has no vendor SDK behind it — unlike Rapier or PixiJS it is ~25 KB of engine source
// reached through the runtime barrel, and a flag-gated dynamic import (the shape
// materialInstanceSystem uses for the 2D broker) was tried and dropped only 3 KB, because the
// barrel's static graph keeps it alive regardless. So the flag does two useful things and one
// it does not: it stops video RUNNING, and it tells the asset shaker to drop the .mp4s (which
// is what actually fits a playable under its cap). It does not strip the JS.
if (__MODOKI_MODULE_VIDEO__) {
  setVideoUrlResolver(resolveVideoUrl);
  setVideoSourceResolver(resolveVideoSource);
  // Downloaded-video cache. Only wired where the Cache API exists — without it a
  // `download` clip falls back to streaming from its URL, which still PLAYS (it just
  // isn't offline-capable). Degrading to "works, but not cached" beats not playing.
  if (hasCacheStorage()) {
    const videoCache = new VideoCache({
      backend: new CacheApiBackend(),
      budgetBytes: VIDEO_CACHE_BUDGET_MB * 1024 * 1024,
      storage: typeof localStorage !== 'undefined' ? localStorage : undefined,
    });
    // Repair index/storage drift once at boot — the browser may have reclaimed our
    // storage since last run, and a stale index would report a cache full of nothing.
    void videoCache.reconcile();
    setVideoDownloader((key, url, onProgress) =>
      videoCache.fetchAndStore(key, url, onProgress && ((p) => onProgress(p.receivedBytes, p.totalBytes))));
    setActiveVideoCache(videoCache);
  }
  registerSystem('video', videoSystem, SYSTEM_PRIORITY.AUDIO);
}
registerSystem('materialInstance', materialInstanceSystem, SYSTEM_PRIORITY.MATERIAL);
registerSystem('uiTreeProjection', uiTreeProjection, SYSTEM_PRIORITY.PROJECTION);

/** Run all registered systems in order. Called once per frame. */
export { modokiRunPipeline as runPipeline };
