/** dispatch-action op — every "did not dispatch" answer must be a SURFACED failure (MCP re-audit F8),
 *  and a handler that REFUSES must be reported as one (#1129).
 *
 *  The op signals a no-op via `{dispatched:false, reason}` at HTTP 200. The MCP client's
 *  `isFailureBody` inspects `ok`/`error`/`errors` — NOT `dispatched` — so before F8 an unknown action
 *  name / stale targetGuid / not-playing dispatch was emitted as a non-error tool call. F5: with no
 *  animator trait, `switchableClipNames` is empty (indistinguishable from clips-not-loaded), so the
 *  clip-name guard was skipped and the op answered `dispatched:true` while `engine.playClip` only
 *  console.warned. Both are now `{ok:false, dispatched:false}`.
 *
 *  #1129: the op no longer re-derives any action's preconditions. A handler refuses by RETURNING
 *  `refuseAction(...)`, and the op maps that to `ok:false`. So the table below dispatches the REAL
 *  engine handlers — a stub handler cannot refuse, which is exactly the blind spot the old
 *  pre-flight-based tests had. One row per refusal condition, per action. */

import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import {
  createTestWorld, type TestWorld, Transform, EntityAttributes, destroyEntity, Director, setTimeline, clearTimelineCache, normalizeTimeline,
  Animator, SkeletalAnimator, AudioSource, VideoPlayer, HapticSettings, setAnimSet, clearAnimSetCache,
  registerEngineActions, registerAudioControls, registerVideoControls, registerHapticControls, registerQualityControls, registerIapControls,
} from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; clearTimelineCache(); clearAnimSetCache(); vi.restoreAllMocks(); });

type DispatchReply = { ok?: boolean; dispatched: boolean; reason?: string; known?: string[]; slavedTo?: string };

describe('dispatch-action: a no-op is a surfaced failure (F8)', () => {
  it('an unknown action name → ok:false, dispatched:false, with the known list', async () => {
    game = createTestWorld({ actions: { 'my.real': () => {} } });
    const r = await runAgentOp('dispatch-action', { name: 'totally.bogus' }) as DispatchReply;
    expect(r.ok).toBe(false);
    expect(r.dispatched).toBe(false);
    expect(r.known).toContain('my.real');
  });

  it('a stale targetGuid → ok:false, dispatched:false', async () => {
    game = createTestWorld({ actions: { 'my.real': () => {} } });
    const r = await runAgentOp('dispatch-action', { name: 'my.real', targetGuid: 'ghost-guid' }) as DispatchReply;
    expect(r.ok).toBe(false);
    expect(r.dispatched).toBe(false);
    expect(r.reason).toMatch(/stale|no entity/i);
  });

  // #1223 close-out: targetGuid resolves through the shared resolver, so a stale runtime guid says why.
  // Mutation: drop the `stale` spread from the op's targetGuid refusal.
  it('a despawned runtime targetGuid → NOT_FOUND with stale:"despawned"', async () => {
    game = createTestWorld({ actions: { 'my.real': () => {} } });
    const shot = game.spawn(Transform(), EntityAttributes({ name: 'Shot' }));
    const guid = (shot.get(EntityAttributes) as { guid: string }).guid;
    destroyEntity(shot);
    const r = await runAgentOp('dispatch-action', { name: 'my.real', targetGuid: guid }) as DispatchReply & { code?: string; stale?: string };
    expect(r).toMatchObject({ ok: false, dispatched: false, code: 'NOT_FOUND', stale: 'despawned' });
  });

  it('a valid action DOES dispatch — ok is NOT false, dispatched:true, and the handler ran', async () => {
    let hits = 0;
    game = createTestWorld({ actions: { 'my.real': () => { hits++; } } });
    const r = await runAgentOp('dispatch-action', { name: 'my.real' }) as DispatchReply;
    expect(r.dispatched).toBe(true);
    expect(r.ok).not.toBe(false); // success carries no ok:false, so isFailureBody passes it
    expect(hits).toBe(1);
  });
});

const PARENT_TL = 'bridge-parent.timeline.json';
const CHILD_TL = 'bridge-child.timeline.json';

/** A parent Director whose `subdirector` clip drives the child's playhead (#1112). */
function spawnNestedDirectors(g: TestWorld) {
  setTimeline(PARENT_TL, normalizeTimeline({
    id: 'p', name: 'Parent', duration: 6, frameRate: 30,
    tracks: [{ id: 'ctl', name: 'Sub', target: 'Child', type: 'control', clips: [{ start: 2, subdirector: true }] }],
  }));
  setTimeline(CHILD_TL, normalizeTimeline({ id: 'c', name: 'Child', duration: 3, frameRate: 30, tracks: [] }));
  const parent = g.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'p-guid', name: 'Parent' }), Director({ timeline: PARENT_TL }));
  g.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 'c-guid', name: 'Child', parentId: parent.id() }), Director({ timeline: CHILD_TL }));
}

const CLIP_BANK = JSON.stringify([{ name: 'idle', clip: 'g-idle' }, { name: 'walk', clip: 'g-walk' }]);
const plain = (g: TestWorld) => { g.spawn(Transform({ x: 0 }), EntityAttributes({ guid: 't', name: 'Plain' })); };
const keyframe = (g: TestWorld) => { g.spawn(EntityAttributes({ guid: 't', name: 'Rig' }), Animator({ clips: CLIP_BANK, clip: 'idle' })); };
/** A rig whose library animset DECLARES only `run` over a source GLB that has not loaded — the real
 *  shape of a scene mid-load. The roster is incomplete, so no skeletal name may be refused yet.
 *  (Skeletal REFUSALS need a loaded GLB, which this suite cannot load; they are pinned at the handler
 *  level, against a mocked rigged-model cache, in engine/packages/modoki/tests/runtime/switchableClips.test.ts.) */
const skeletalLoading = (g: TestWorld) => {
  setAnimSet('bridge-set', { source: 'bridge-pack.glb', clips: [{ name: 'run' }] });
  g.spawn(EntityAttributes({ guid: 't', name: 'Skel' }), SkeletalAnimator({ animSet: 'bridge-set', clip: 'run' }));
};

type Row = {
  name: string;
  action: string;
  spawn?: (g: TestWorld) => void;
  target?: string;
  params?: Record<string, unknown>;
  payload?: string | number;
  reason: RegExp;
  /** The console channel the refusal must use: a site silent for a player before #1129 stays silent. */
  log: 'warn' | 'error' | false;
  detail?: Record<string, unknown>;
};

const REFUSALS: Row[] = [
  // ui.scrollTo (the guid-less-target refusal is unreachable here — the op addresses by guid — and is
  // covered at the handler level in engineActions.test.ts)
  { name: 'ui.scrollTo: no target', action: 'ui.scrollTo', reason: /no target entity/, log: 'warn' },
  { name: 'ui.scrollTo: target is not a scroll view', action: 'ui.scrollTo', spawn: plain, target: 't', reason: /not a scroll view/, log: 'warn' },
  // engine.toggleAnimator
  { name: 'engine.toggleAnimator: no target', action: 'engine.toggleAnimator', reason: /no target entity/, log: 'warn' },
  { name: 'engine.toggleAnimator: no animator trait', action: 'engine.toggleAnimator', spawn: plain, target: 't', reason: /no SkeletalAnimator or Animator/, log: 'warn' },
  // engine.playClip
  { name: 'engine.playClip: no target', action: 'engine.playClip', params: { clip: 'walk' }, reason: /no target entity/, log: 'warn' },
  { name: 'engine.playClip: no clip name', action: 'engine.playClip', spawn: keyframe, target: 't', reason: /no clip name/, log: 'warn' },
  { name: 'engine.playClip: no animator trait', action: 'engine.playClip', spawn: plain, target: 't', params: { clip: 'walk' }, reason: /no Animator \/ SpriteAnimator \/ SkeletalAnimator/, log: 'warn' },
  { name: 'engine.playClip: unknown keyframe clip', action: 'engine.playClip', spawn: keyframe, target: 't', params: { clip: 'Walk' }, reason: /no clip named "Walk".*Known clips: idle, walk/, log: 'warn', detail: { known: ['idle', 'walk'] } },
  // engine.director
  { name: 'engine.director: no target', action: 'engine.director', params: { action: 'pause' }, reason: /no target entity/, log: 'warn' },
  { name: 'engine.director: no Director trait', action: 'engine.director', spawn: plain, target: 't', params: { action: 'pause' }, reason: /has no Director trait/, log: 'warn' },
  { name: 'engine.director: slaved sub-director', action: 'engine.director', spawn: spawnNestedDirectors, target: 'c-guid', params: { action: 'pause' }, reason: /SLAVED sub-director/, log: 'warn', detail: { slavedTo: 'p-guid' } },
  { name: 'engine.director: unknown verb', action: 'engine.director', spawn: (g) => { g.spawn(EntityAttributes({ guid: 't' }), Director({ timeline: 'x' })); }, target: 't', params: { action: 'rewind' }, reason: /unknown action "rewind"/, log: 'warn' },
  // audio.* — silent for a player, reported to the op
  { name: 'audio.play: no target', action: 'audio.play', reason: /\[audio\.play\] no target entity/, log: false },
  { name: 'audio.play: no AudioSource', action: 'audio.play', spawn: plain, target: 't', reason: /\[audio\.play\] target has no AudioSource/, log: false },
  { name: 'audio.pause: no AudioSource', action: 'audio.pause', spawn: plain, target: 't', reason: /\[audio\.pause\] target has no AudioSource/, log: false },
  { name: 'audio.toggle: no AudioSource', action: 'audio.toggle', spawn: plain, target: 't', reason: /\[audio\.toggle\] target has no AudioSource/, log: false },
  { name: 'audio.stop: no AudioSource', action: 'audio.stop', spawn: plain, target: 't', reason: /\[audio\.stop\] target has no AudioSource/, log: false },
  { name: 'audio.setClip: no clip', action: 'audio.setClip', spawn: (g) => { g.spawn(EntityAttributes({ guid: 't' }), AudioSource({})); }, target: 't', params: { key: 'missing' }, reason: /\[audio\.setClip\] no clip/, log: false },
  { name: 'audio.toggleCrossfade: no AudioSource', action: 'audio.toggleCrossfade', spawn: plain, target: 't', reason: /\[audio\.toggleCrossfade\] target has no AudioSource/, log: false },
  { name: 'audio.setBusVolume: no value', action: 'audio.setBusVolume', params: { bus: 'music' }, reason: /no numeric `value`/, log: false },
  // The one warn here is `setBusVolume`'s own (audioService.ts, pre-#1129); the refusal adds no second.
  { name: 'audio.setBusVolume: unknown bus', action: 'audio.setBusVolume', params: { bus: 'nope', value: 50 }, reason: /unknown bus "nope"/, log: 'warn' },
  { name: 'audio.playOneShot: no clip', action: 'audio.playOneShot', reason: /\[audio\.playOneShot\] no clip/, log: false },
  // video.*
  { name: 'video.play: no target', action: 'video.play', reason: /\[video\.play\] no target entity/, log: false },
  { name: 'video.pause: no VideoPlayer', action: 'video.pause', spawn: plain, target: 't', reason: /\[video\.pause\] target has no VideoPlayer/, log: false },
  { name: 'video.toggle: no VideoPlayer', action: 'video.toggle', spawn: plain, target: 't', reason: /\[video\.toggle\] target has no VideoPlayer/, log: false },
  { name: 'video.stop: no target', action: 'video.stop', reason: /\[video\.stop\] no target entity/, log: false },
  { name: 'video.stop: no VideoPlayer', action: 'video.stop', spawn: plain, target: 't', reason: /\[video\.stop\] target has no VideoPlayer/, log: false },
  { name: 'video.skip: no target', action: 'video.skip', reason: /\[video\.skip\] no target entity/, log: false },
  { name: 'video.seek: no target', action: 'video.seek', params: { seconds: 2 }, reason: /\[video\.seek\] no target entity/, log: false },
  { name: 'video.seek: no VideoPlayer', action: 'video.seek', spawn: plain, target: 't', params: { seconds: 2 }, reason: /\[video\.seek\] target has no VideoPlayer/, log: false },
  { name: 'video.seek: non-finite seconds', action: 'video.seek', spawn: (g) => { g.spawn(EntityAttributes({ guid: 't' }), VideoPlayer({})); }, target: 't', params: { seconds: 'soon' }, reason: /seconds must be a finite number/, log: false },
  { name: 'video.setClip: no clip', action: 'video.setClip', spawn: (g) => { g.spawn(EntityAttributes({ guid: 't' }), VideoPlayer({})); }, target: 't', reason: /\[video\.setClip\] no `clip`/, log: false },
  { name: 'video.setClip: no VideoPlayer', action: 'video.setClip', spawn: plain, target: 't', params: { clip: 'some-guid' }, reason: /\[video\.setClip\] target has no VideoPlayer/, log: false },
  // haptics.* / quality.set / iap.buy
  { name: 'haptics.toggle: no HapticSettings', action: 'haptics.toggle', reason: /no HapticSettings entity/, log: false },
  { name: 'haptics.set: enabled is not a boolean', action: 'haptics.set', params: { enabled: 'yes' }, reason: /must be a boolean/, log: false },
  { name: 'haptics.set: no HapticSettings', action: 'haptics.set', params: { enabled: false }, reason: /no HapticSettings entity/, log: false },
  { name: 'quality.set: not a tier', action: 'quality.set', params: { tier: 'ultra' }, reason: /"ultra" is not a tier/, log: false },
  { name: 'iap.buy: no product id', action: 'iap.buy', reason: /needs a product id/, log: 'error' },
];

const ACCEPTS: Array<Omit<Row, 'reason' | 'log' | 'detail'> & { check?: (g: TestWorld) => void }> = [
  { name: 'engine.toggleAnimator on an Animator', action: 'engine.toggleAnimator', spawn: keyframe, target: 't' },
  { name: 'engine.playClip: a known keyframe clip', action: 'engine.playClip', spawn: keyframe, target: 't', params: { clip: 'walk' } },
  {
    name: 'engine.playClip: skeletal whose source GLB is still loading writes an UNDECLARED name', action: 'engine.playClip', spawn: skeletalLoading, target: 't', params: { clip: 'jump' },
    check: (g) => {
      const [e] = g.query(SkeletalAnimator);
      expect(e.get(SkeletalAnimator)!.clip).toBe('jump');
    },
  },
  {
    // An EMPTY skeletal list is ambiguous (the GLB/animset may not have loaded) — the name is written
    // for the render layer to validate, never refused.
    name: 'engine.playClip: skeletal with an unloaded clip list writes the name', action: 'engine.playClip', target: 't', params: { clip: 'anything' },
    spawn: (g) => { g.spawn(EntityAttributes({ guid: 't' }), SkeletalAnimator({ animSet: '', clip: '' })); },
    check: (g) => {
      const [e] = g.query(SkeletalAnimator);
      expect(e.get(SkeletalAnimator)!.clip).toBe('anything');
    },
  },
  { name: 'engine.director on a Director', action: 'engine.director', spawn: (g) => { g.spawn(EntityAttributes({ guid: 't' }), Director({ timeline: 'x' })); }, target: 't', params: { action: 'pause' } },
  { name: 'engine.director on the PARENT of a slaved pair', action: 'engine.director', spawn: spawnNestedDirectors, target: 'p-guid', params: { action: 'pause' } },
  { name: 'audio.pause on an AudioSource', action: 'audio.pause', spawn: (g) => { g.spawn(EntityAttributes({ guid: 't' }), AudioSource({})); }, target: 't' },
  { name: 'video.pause on a VideoPlayer', action: 'video.pause', spawn: (g) => { g.spawn(EntityAttributes({ guid: 't' }), VideoPlayer({})); }, target: 't' },
  { name: 'haptics.toggle with HapticSettings', action: 'haptics.toggle', spawn: (g) => { g.spawn(HapticSettings({})); } },
];

describe('dispatch-action reports every handler refusal (#1129)', () => {
  beforeAll(() => {
    registerEngineActions(); registerAudioControls(); registerVideoControls();
    registerHapticControls(); registerQualityControls(); registerIapControls();
  });

  it.each(REFUSALS)('$name → ok:false, dispatched:false', async (row) => {
    game = createTestWorld({});
    row.spawn?.(game);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await runAgentOp('dispatch-action', {
      name: row.action, ...(row.target ? { targetGuid: row.target } : {}), params: row.params, payload: row.payload,
    }) as DispatchReply & Record<string, unknown>;

    expect(r.ok).toBe(false);
    expect(r.dispatched).toBe(false);
    expect(r.reason).toMatch(row.reason);
    for (const [k, v] of Object.entries(row.detail ?? {})) expect(r[k]).toEqual(v);
    expect(warn).toHaveBeenCalledTimes(row.log === 'warn' ? 1 : 0);
    expect(error).toHaveBeenCalledTimes(row.log === 'error' ? 1 : 0);
  });

  it.each(ACCEPTS)('ACCEPT SIDE: $name → dispatched:true', async (row) => {
    game = createTestWorld({});
    row.spawn?.(game);
    const r = await runAgentOp('dispatch-action', {
      name: row.action, ...(row.target ? { targetGuid: row.target } : {}), params: row.params,
    }) as DispatchReply;
    expect(r.reason).toBeUndefined();
    expect(r.dispatched).toBe(true);
    expect(r.ok).not.toBe(false);
    row.check?.(game);
  });
});
