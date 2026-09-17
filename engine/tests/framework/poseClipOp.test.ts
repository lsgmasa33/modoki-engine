/** `pose-clip` / `exit-pose-envelope` / `open-animation-editor` (#288 gap 2).
 *
 *  `modoki_set_playhead` writes the editor's playhead NUMBER and nothing else — its own
 *  description says so, and a render taken after it shows the unchanged pose. The path that
 *  actually poses lived inside three `useCallback`s in `AnimationEditor`, so an agent could move
 *  the playhead and could not pose the rig. QA-ANIM-0002 wrote `Animator.time` directly instead,
 *  which happens to work only because `animationSystem` samples every frame regardless of
 *  `playing`.
 *
 *  Two things are worth pinning here, and neither is the sampling (`sampleClip` has its own tests):
 *
 *   1. **The refusals are distinct.** "No clip open" and "clip open but bound to nothing" send the
 *      caller to different fixes, and a pose that applies ZERO channels is a failure, not a quiet
 *      success (§5: a no-op is a failure when the caller asked for a change).
 *   2. **The envelope is reversible from the agent surface.** An agent that can OPEN the preview
 *      envelope and cannot close it wedges the editor — the envelope pins the run-mode at `scrub`,
 *      which is exactly what blocks the human's Cmd+S.
 *
 *  The end-to-end pose was verified LIVE rather than here (see `liveCoverage.ts`): posing needs a
 *  loaded clip bound to a real entity, and the value it writes has to be observed changing.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { runAgentOp } from '../../app/debug/agentBridge';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { useEditorStore, onPoseEnvelopeExited, exitPoseEnvelope } from '@modoki/engine/editor';
import { setRunMode, getRunMode } from '../../packages/modoki/src/runtime/core/playState';
import { poseClipAtTime } from '@modoki/engine/editor';
import * as preview from '../../packages/modoki/src/editor/scene/timelinePreview';
import { enterPreviewMode, exitPreviewMode, getModeOwner } from '../../packages/modoki/src/editor/scene/playMode';
import { registerAsset, unregisterAsset } from '../../packages/modoki/src/runtime/loaders/assetManifest';
import { newGuid } from '../../packages/modoki/src/runtime/core/assetRefRules';

registerAllTraits();
registerEditorAgentOps();

/** ⚠️ The run mode defaults to `'playing'` in this environment, and `enterScrubMode` deliberately
 *  refuses to downgrade a live Play — so without this the envelope never opens, `getModeOwner()`
 *  stays null, and every envelope assertion below would test the guard instead of the feature. A
 *  real editor starts stopped. (Measured while writing this file: `['playing','playing',null]`.) */
beforeEach(() => { setRunMode('stopped'); });

type Reply = { ok?: boolean; code?: string; error?: string; options?: string[]; hint?: string;
  posed?: boolean; applied?: number; playhead?: number; boundClip?: string | null;
  clampedFrom?: number; exited?: boolean; restored?: boolean };

const pose = (params: unknown) => runAgentOp('pose-clip', params) as Promise<Reply>;
const exitEnv = (params?: unknown) => runAgentOp('exit-pose-envelope', params ?? {}) as Promise<Reply>;

const CLIP = { name: 'probe', duration: 2, frameRate: 60, loop: false, tracks: [] };

afterEach(async () => {
  // Tear the envelope down even when a test failed part-way: it is global state shared with the
  // Timeline panel, and a leaked one makes the NEXT test's "nothing is open" refusal impossible.
  await exitPoseEnvelope(true).catch(() => {});
  setRunMode('stopped');
  useEditorStore.setState({ editingAnimationClip: null, animatorRootEntityId: null } as never);
  vi.restoreAllMocks();
});

describe('pose-clip refuses each missing precondition SEPARATELY', () => {
  it('no clip open → NOT_FOUND naming the fix', async () => {
    useEditorStore.setState({ editingAnimationClip: null, animatorRootEntityId: 1 } as never);
    const r = await pose({ t: 0.5 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_FOUND');
    expect(String(r.error)).toMatch(/no animation clip is open/);
    // An AGENT tool, not human UI (#1212 A-14): "the Animation panel" is not something an agent can open.
    expect(r.options?.[0]).toMatch(/modoki_open_animation_editor/);
  });

  it('clip open but UNBOUND → a different NOT_FOUND, naming a different fix', async () => {
    // Collapsing these two would send the caller to the wrong place: "open a clip" and "bind it to
    // an entity" are not the same problem, and the clip IS open in this one.
    useEditorStore.setState({ editingAnimationClip: CLIP, animatorRootEntityId: null } as never);
    const r = await pose({ t: 0.5 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_FOUND');
    expect(r.boundClip).toBe('probe');            // …and it says WHICH clip is open
    expect(String(r.error)).toMatch(/not BOUND to an entity/);
    expect(r.options?.[0]).toMatch(/modoki_set_selection .*Animator/);
  });

  it('a non-finite t is refused before anything is touched', async () => {
    useEditorStore.setState({ editingAnimationClip: CLIP, animatorRootEntityId: 1 } as never);
    for (const t of [undefined, 'x', NaN, Infinity]) {
      const r = await pose(t === undefined ? {} : { t });
      expect(r.ok, `t=${String(t)}`).toBe(false);
      expect(String(r.error)).toMatch(/finite t/);
      expect(r.options?.length, 'a refusal names the fix (#1212 A-14)').toBeGreaterThan(0);
    }
  });
});

describe('a pose that moves NOTHING is reported as a failure', () => {
  it('applied:0 → REFUSED_BY_OP with the two real causes, not a cheerful ok', async () => {
    // The clip has no tracks, so nothing resolves against the bound root. Reporting ok here is the
    // false success the whole envelope exists to avoid — the caller's next act would be to render
    // and wonder why the rig did not move.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    useEditorStore.setState({ editingAnimationClip: CLIP, animatorRootEntityId: 999999 } as never);
    const r = await pose({ t: 0.5 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REFUSED_BY_OP');
    expect(String(r.error)).toMatch(/applied 0 channels/);
    expect(r.options?.length).toBeGreaterThan(1);
    void err;
  });
});

describe('the playhead is clamped, and the clamp is REPORTED', () => {
  it('past the clip duration clamps and says so', async () => {
    // A silent clamp means a later read of `playheadTime` disagrees with what was asked for, and
    // nothing explains the difference.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    useEditorStore.setState({ editingAnimationClip: CLIP, animatorRootEntityId: 999999 } as never);
    const r = await pose({ t: 99 });
    expect(r.playhead).toBe(2);
    expect(r.clampedFrom).toBe(99);
    expect(useEditorStore.getState().playheadTime).toBe(2);
    void err;
  });
});

describe('the envelope is closable from the agent surface', () => {
  it('there is NO way to exit without restoring — restore:false is never honoured', async () => {
    // Every human path in AnimationEditor/TimelineEditor passes restore:true, so a keep-the-pose
    // option would be a capability the editor's own UI cannot reach, and its only effect is to
    // BAKE a preview frame into the authored world — the exact damage the envelope exists to
    // prevent, and the damage that actually cost the owner data (2026-08-19).
    //
    // ⚠️ An envelope must be OPEN for this to assert anything. The first cut of this test called
    // the op with nothing posed, got the "nothing to exit" refusal — which carries no `restored`
    // key — and skipped its own assertion. It passed the mutation check that re-honoured the flag,
    // i.e. it was a tautology dressed as a guard.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    useEditorStore.setState({ editingAnimationClip: CLIP, animatorRootEntityId: 999999 } as never);
    await pose({ t: 0 });                       // opens the envelope
    const r = await exitEnv({ restore: false });
    expect(r.exited, 'the envelope must actually have been open, or this asserts nothing').toBe(true);
    expect(r.restored, 'restore:false must never be honoured').toBe(true);
    void err;
  });

  it('a FAILED session-begin hands the run-mode back instead of wedging the editor', async () => {
    // The run-mode is claimed synchronously BEFORE the snapshot is awaited, and the snapshot is
    // what makes it safe. An unguarded throw would leave `scrub` pinned with no session: Cmd+S
    // blocked, and nothing to revert — the exact wedge the exit tool exists to prevent, reachable
    // without anybody ever calling it.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    useEditorStore.setState({ editingAnimationClip: CLIP, animatorRootEntityId: 999999 } as never);
    const boom = new Error('serializeScene blew up');
    const spy = vi.spyOn(preview, 'beginTimelinePreviewSession').mockRejectedValueOnce(boom);
    await expect(poseClipAtTime(CLIP as never, 999999, 0.5)).rejects.toThrow('serializeScene blew up');
    // The failure must cost a retry, not the editor.
    expect(getRunMode(), 'the run-mode must be handed back on a failed begin').toBe('stopped');
    spy.mockRestore();
    void err;
  });

  it('a session that does NOT open (a restore still landing, #1167) poses nothing, hands the mode back, and says so', async () => {
    // `beginTimelinePreviewSession` resolves false while an Exit's restore is in flight. Posing after
    // that is unrevertible, and reporting it as "applied 0 channels" would send the caller to check
    // their track paths for a problem that is really "try again in a moment".
    useEditorStore.setState({ editingAnimationClip: CLIP, animatorRootEntityId: 999999 } as never);
    const spy = vi.spyOn(preview, 'beginTimelinePreviewSession').mockResolvedValue(false);
    const direct = await poseClipAtTime(CLIP as never, 999999, 0.5);
    // MUTATION TARGET: pose regardless of `opened` in poseClipAtTime and `refused` is absent.
    expect(direct.refused).toBe(true);
    expect(direct.openedSession).toBe(false);
    // MUTATION TARGET: drop that branch's `exitPreviewMode(owner)` and this stays 'scrub' with no session.
    expect(getRunMode(), 'the run-mode must be handed back on a refused begin').toBe('stopped');

    const r = await pose({ t: 0.5 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REFUSED_BY_OP');
    expect(String(r.error)).toMatch(/preview is closing/);
    expect(getRunMode()).toBe('stopped');
    spy.mockRestore();
  });

  // #1212 A-11: the two causes used to share one NOT_AVAILABLE_HERE ("could not look, relaunch")
  // with the discriminator in a `hint` prose field. They have different next steps.
  it('exit with nothing open is NOT_FOUND — nothing to exit — not a cheerful no-op', async () => {
    const r = await exitEnv();
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_FOUND');
    expect((r.options as string[]).join('\n')).toMatch(/modoki_pose_clip/);
  });

  it('exit while the TIMELINE owns the envelope refuses, names the owner, and ends nothing', async () => {
    // Ending ITS session would revert its world mid-run, so refusing is correct — and the caller
    // must be told that is what happened, not that nothing was open.
    enterPreviewMode(true, 'timeline');
    try {
      const r = await exitEnv();
      expect(r.ok).toBe(false);
      expect(r.code).toBe('REFUSED_BY_OP');
      expect((r as { modeOwner?: unknown }).modeOwner).toBe('timeline');
      // The Timeline's REAL agent exit, with its caution — not "a human action" (review, #1212).
      expect((r.options as string[])[0]).toMatch(/^modoki_play_control \{action:'stop'\}.*DESTRUCTIVE/);
      expect(getModeOwner(), 'the refusal must leave the Timeline holding its envelope').toBe('timeline');
    } finally {
      exitPreviewMode('timeline');
    }
  });

  it('exit while PLAYING is not "nothing to exit" — Play holds no owner, and the world is not authored', async () => {
    setRunMode('playing');
    const r = await exitEnv();
    expect(r.code).toBe('REFUSED_BY_OP');
    expect((r as { runMode?: unknown }).runMode).toBe('playing');
    expect((r.options as string[])[0]).toMatch(/modoki_play_control/);
  });

  it('exitPoseEnvelope notifies subscribers — the panel\'s stale-state guard', async () => {
    // AnimationEditor keeps an `inPreview` useState gating its ⏹ button AND the registration of a
    // Cmd+S save handler whose resume() RE-POSES. Without this notification an agent-driven exit
    // would leave that handler live against a closed envelope, so the human's next save would
    // serialize and then re-pose a world the agent had just reverted.
    let fired = 0;
    const off = onPoseEnvelopeExited(() => { fired++; });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    useEditorStore.setState({ editingAnimationClip: CLIP, animatorRootEntityId: 999999 } as never);
    await pose({ t: 0 });          // opens the envelope (and applies 0 — see above)
    await exitPoseEnvelope(true);
    expect(fired).toBe(1);
    off();
    await exitPoseEnvelope(true);  // unsubscribed → no further notifications
    expect(fired).toBe(1);
    void err;
  });
});

/** #1212 A-13: the store is re-pointed BEFORE the 3s load wait, so a timeout refusal describes an
 *  editor that has already left the previous clip. It used to say only "no clip loaded", with the
 *  advice in a `hint` prose field. */
describe('open-animation-editor — a load timeout says the switch already happened', () => {
  const guid = newGuid();
  const PATH = '/assets/anims/probe-a13.anim.json';
  beforeEach(() => { registerAsset(guid, PATH, 'animation' as never); });
  afterEach(() => { unregisterAsset(guid); vi.useRealTimers(); });

  it('names the clip it left, and puts the next steps in options', async () => {
    useEditorStore.setState({ editingAnimationAsset: { path: '/assets/anims/previous.anim.json', type: 'animation', name: 'previous' } } as never);
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const pending = runAgentOp('open-animation-editor', { path: PATH }) as Promise<Record<string, unknown>>;
    await vi.advanceTimersByTimeAsync(3200);
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_AVAILABLE_HERE');
    expect(r.previousPath).toBe('/assets/anims/previous.anim.json');
    expect(String(r.error)).toMatch(/switch is NOT undone.*previous\.anim\.json is no longer open/);
    expect((r.options as string[]).join('\n')).toMatch(/openPanels/);
    expect(r).not.toHaveProperty('hint');
  });

  it('re-opening the SAME clip reports no switch — the accept side', async () => {
    useEditorStore.setState({ editingAnimationAsset: { path: PATH, type: 'animation', name: 'probe' } } as never);
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const pending = runAgentOp('open-animation-editor', { path: PATH }) as Promise<Record<string, unknown>>;
    await vi.advanceTimersByTimeAsync(3200);
    const r = await pending;
    expect(r.code).toBe('NOT_AVAILABLE_HERE');
    expect(r).not.toHaveProperty('previousPath');
    expect(String(r.error)).not.toMatch(/NOT undone/);
    // …but a re-open is not "nothing happened": the store reset the playhead and any pose.
    expect(String(r.error)).toMatch(/re-opened, which reset the playhead/);
  });

  it('a FIRST open (nothing open before) is not called a re-open', async () => {
    useEditorStore.setState({ editingAnimationAsset: null } as never);
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const pending = runAgentOp('open-animation-editor', { path: PATH }) as Promise<Record<string, unknown>>;
    await vi.advanceTimersByTimeAsync(3200);
    const r = await pending;
    expect(String(r.error)).toMatch(/now on \/assets\/anims\/probe-a13\.anim\.json \(nothing was open before\)/);
    expect(String(r.error)).not.toMatch(/re-opened/);
    expect(r).not.toHaveProperty('previousPath');
  });

  it('a mid-call re-point BACK to the previous clip is described as what is open now', async () => {
    // Review finding: the note was written before the wait, so this reply used to say
    // "switched to <path> — <previous> is no longer open" while <previous> WAS the open clip.
    const prev = { path: '/assets/anims/previous.anim.json', type: 'animation', name: 'previous' };
    useEditorStore.setState({ editingAnimationAsset: prev } as never);
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const pending = runAgentOp('open-animation-editor', { path: PATH }) as Promise<Record<string, unknown>>;
    useEditorStore.setState({ editingAnimationAsset: prev, editingAnimationClip: { name: 'previous' } } as never);
    await vi.advanceTimersByTimeAsync(100);
    const r = await pending;
    expect(r.code).toBe('REFUSED_BY_OP');
    expect(String(r.editorNow)).toMatch(/now on \/assets\/anims\/previous\.anim\.json \(the clip that was open before this call\)/);
    expect(JSON.stringify(r)).not.toMatch(/no longer open/);
    useEditorStore.setState({ editingAnimationClip: null } as never);
  });
});
