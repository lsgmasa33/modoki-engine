/** Editor Play/Stop controller — Unity-style enter-play / revert-on-stop.
 *
 *  The editor opens a scene in `'stopped'`: game systems are inert (pipeline +
 *  action dispatch gate on `isSimRunning()`), so the authored scene sits still
 *  and Cmd+S serializes clean authored data.
 *
 *  Play snapshots the live world (the same `serializeScene()` the save path
 *  uses) into memory, then flips to `'playing'`. Stop reverts by reloading that
 *  snapshot through `SceneManager` (the proven preload→swap→refcount→selection-
 *  restore path), discarding every play-mode mutation. Pause freezes the sim
 *  without reverting.
 *
 *  This is the guard that makes binding-driven `isVisible` (and any other system
 *  that writes ECS state at runtime) safe: those writes only ever happen while
 *  playing, and Stop throws them away — they never reach disk. */

import { getPlayState, setPlayState, getRunMode, setRunMode, onRunModeChange } from '../../runtime/core/playState';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { sceneLoadGeneration, isSceneLoadInFlight, registerBeforeSceneLoad } from './serialize';
import { captureAuthoredSnapshot, restoreAuthoredSnapshot, currentSceneKey, lastRestoreFailed, authoredRestoreInFlight, type AuthoredSnapshot } from './authoredSnapshot';
import { beginWorldReplacement } from './authoringSettle';
import { undoDepth, truncateUndoTo, beginWorldSwitch } from '../undo/undoManager';
import { editorEmit } from '../editorJournal';
import { notifyListeners } from '../../runtime/core/notifyListeners';
import {
  hasTimelinePreviewSession, endTimelinePreviewSessionReporting, isPreviewRestoreInFlight, cancelPreviewGestures, whenPreviewRestoresLanded,
  holdPreviewSessionsClosed, cancelPendingPreviewBegins,
} from './timelinePreview';
import { setVerboseCapture, isVerboseCaptureActive } from '../../runtime/core/journal';
import { fetchAiSettings, getCachedAiSettings } from '../panels/aiSettingsModel';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { ensurePhysicsReady } from '../../runtime/physics/physicsReady';

/** The authored world captured at the moment Play was pressed — primary, bases (A5) and the key it
 *  belongs to, so a scene swap mid-play can't revert the wrong scene. Captured and restored by
 *  `authoredSnapshot.ts`, the same code the preview session uses (#1547). */
let _snapshot: AuthoredSnapshot | null = null;
/** Undo-stack depth captured at the Play press. On Stop we truncate back to this
 *  so during-Play editor edits (discarded by the revert) don't leave incoherent
 *  undo entries — while ALL pre-Play history is preserved (guid-resolved undo
 *  survives the world rebuild). */
let _undoBarrier = 0;
/** True when THIS Play press auto-opened the Tier-2 @contact capture (via the AI-panel flag),
 *  so Stop closes only what we opened — never a capture a human/MCP opened manually. Without
 *  this, the process-global capture would leak past Stop into edit mode + later worlds. */
let _autoOpenedContact = false;
/** True for the duration of an in-flight `enterPlay()` call — set synchronously at the top,
 *  before the first await, cleared in a `finally`. `getPlayState()` still reads `'stopped'`
 *  for most of that window (it only flips to `'playing'` at the very end), so this is what
 *  lets `stopPlay()` tell "Play is starting" apart from "genuinely stopped" (#470). */
let _entering = false;
/** Set by a `stopPlay()` that arrived while `_entering` was true — a Stop pressed during Play
 *  startup, which would otherwise be silently swallowed by `stopPlay`'s own `'stopped'` early
 *  return (issue #470). `enterPlay()` checks this once it reaches `'playing'` and, if set,
 *  immediately runs the real `stopPlay()` revert. Cleared on every `enterPlay()` exit so a
 *  stale request can never kill a LATER Play press. */
let _stopRequested = false;

/** Enter Play: snapshot the authored world, then start the simulation. */
/** Is the live world being swapped out from under us, by ANY route?
 *
 *  ⚠️ Two signals, because neither alone is enough — and the second was missed on the first pass.
 *  `isSceneLoadInFlight()`/`sceneLoadGeneration()` count only loads through the EDITOR WRAPPER
 *  (`serialize.loadScene`). Several paths swap the world by calling `sceneManager.loadScene`
 *  DIRECTLY and touch neither: `undo/applyPrefabUndo.ts`'s snapshot restore and
 *  `prefabEdit.openPrefabForEditing` are both same-path reloads, which is the case
 *  `stopPlay`'s `snapPath !== path` guard also cannot see — so Play would arm with a snapshot of
 *  the pre-restore world and Stop would put it back over the undone one.
 *
 *  `sceneManager.getNext()` is non-null exactly while a load is pre-swap (it is relinquished AT
 *  the swap), which is the window that matters here: past the swap the world is already the new
 *  one, so a snapshot taken then is of the right world. See docs/async-lifetime.md. */
/** Is a world swap in progress right now — through the `loadScene` wrapper OR straight through
 *  SceneManager? BOTH halves are needed: `prefabEdit.openPrefabForEditing` and `applyPrefabUndo`
 *  call `sceneManager.loadScene` directly and move neither the epoch nor the in-flight count
 *  (see the SCOPE note on `isSceneLoadInFlight`). Exported for the Hierarchy's collapse restore,
 *  which must not key a restore to the editor's scene path until the winning load's tail has
 *  written it.
 *
 *  ⚠️ A THIRD signal, for the same reason: a preview session's restore (`endTimelinePreviewSession`)
 *  also calls `sceneManager.loadScene` directly, and it first awaits `whenUndoIdle()`, so for that
 *  wait `getNext()` is still null while the world about to be discarded is still POSED. Play pressed
 *  then snapshotted the pose and Stop put it back as the authored world (#1167's mechanism, from the
 *  Play side).
 *
 *  ⚠️ A FOURTH, because "past the swap the world is right" (above) is false for an AUTHORED restore
 *  — Stop's, or a preview Exit's once its load starts (#1572). `restoreAuthoredSnapshot` replays the
 *  Persistent roots and bases only AFTER `sceneManager.loadScene` resolves, and that load awaits
 *  manager dispose/init after its swap, with `getNext()` already null. Play pressed in that tail
 *  snapshotted Persistent roots and kept bases still at the previous run's values, and the next Stop put them back
 *  as authored. `authoredRestoreInFlight()` spans the whole restore, replay included. */
export function aSceneSwapIsHappening(): boolean {
  return isSceneLoadInFlight() || sceneManager.getNext() !== null || isPreviewRestoreInFlight()
    || authoredRestoreInFlight();
}

/** What a Play press did (#1574). The toolbar turns a decline into a warn toast (`playPressFeedback.ts`, #1577)
 *  and the agent `play` op builds its reply from it — it cannot read the console, and it used to answer `ok:true` over every
 *  refusal because the state it re-read afterwards ('stopped') looked the same as a Play that had not
 *  been asked for. `message` is the one string both surfaces print. */
export type PlayOutcome =
  | { kind: 'started' }
  | { kind: 'resumed' }
  | { kind: 'already-playing' }
  | { kind: 'refused'; reason: 'already-starting' | 'scene-swap' | 'restore-failed' | 'load-landed'; message: string }
  /** Play reached 'playing', then a Stop queued during startup (#470) ended it. `reverted` is that
   *  Stop's own answer — false when it skipped the revert or its restore THREW (the throw is logged
   *  and folded in here, so the Play press that ran the Stop reports it rather than rejecting). */
  | { kind: 'stopped-during-startup'; reverted: boolean; message: string };

function refusePlay(reason: Extract<PlayOutcome, { kind: 'refused' }>['reason'], message: string, warn = true): PlayOutcome {
  if (warn) console.warn(`[Editor] ${message}`);
  return { kind: 'refused', reason, message };
}

export async function enterPlay(): Promise<PlayOutcome> {
  if (getPlayState() === 'playing') { _stopRequested = false; return { kind: 'already-playing' }; }
  // Resume from Pause without re-snapshotting (the snapshot from the original
  // Play press still represents the authored state to revert to).
  if (getPlayState() === 'paused') {
    _stopRequested = false;
    setPlayState('playing');
    editorEmit('!play', { resume: true });
    return { kind: 'resumed' };
  }
  // Refuse re-entry: a SECOND enterPlay() arriving while one is already mid-startup
  // (getPlayState() still reads 'stopped' for that whole window, same as the premise
  // of `_entering` itself) must not start a second startup — two concurrent runs would
  // both serialize/mutate/flip state independently, and whichever's `finally` clears
  // `_entering` first lets the other's stale tail still land afterwards (adversarial
  // review of #470: a Play double-click followed by Stop left `_snapshot === null`
  // while `playState === 'playing'` — Stop then had nothing to revert). Deliberately
  // does NOT touch `_stopRequested`: a Stop that arrives after this refusal is still
  // meant for the call that IS in flight, and that call's own tail (or its `finally`)
  // is exactly what consumes it — clearing it here would swallow the very Stop #470
  // was written to stop swallowing. No warn: a Play double-click lands here, and it is not news.
  if (_entering) return refusePlay('already-starting', 'Play refused — another Play is still starting up.', false);
  // ⚠️ The generation ALONE is one-sided, and the missing half is the nastier case. A load already
  // in flight when Play is pressed has ALREADY bumped the epoch, so the capture above reads equal
  // on both sides and the check below passes — Play then arms with a snapshot of the pre-swap
  // world. When that load is a reload of the SAME path, `stopPlay`'s `snapPath !== path` guard does
  // not fire either, so Stop restores the stale world over the reloaded one: the exact outcome this
  // guard exists to prevent, entered from the other side. So refuse up front too — this is
  // docs/async-lifetime.md's "Both? Use both."
  if (aSceneSwapIsHappening()) {
    return refusePlay('scene-swap', 'Play refused — a scene load is still in flight. Try again once it lands.');
  }
  // A failed restore may have left the posed (or previous Play) world live; Play's snapshot would take
  // it as authored, and Stop's successful restore would clear the flag that is guarding it (#1548).
  if (lastRestoreFailed()) {
    return refusePlay('restore-failed', 'Play refused — the last Play/preview restore FAILED, so the live world may not be the authored one. Reload the scene first.');
  }

  // Set synchronously, before the first await, so a Stop that arrives while we're
  // mid-startup (getPlayState() still reads 'stopped' below) can tell "Play is
  // starting" apart from "genuinely stopped" — see `_entering`'s doc comment (#470).
  _entering = true;
  // No preview session may open from here until Play owns the world (#1546) — released in `finally`.
  const reopenPreviewSessions = holdPreviewSessionsClosed();
  // Refuses new undo steps until Play owns the world, and names the one in flight (#1579) — released in `finally`.
  // An Apply undo reloads the world after its prefab file write, and `aSceneSwapIsHappening()` above cannot see a step
  // that has not reached that reload yet: Play snapshotted the applied world, the reload landed inside Play, and Stop
  // put the applied world back over a prefab file already at "before". So Play WAITS for it and snapshots the undone
  // world — the #1579 design's choice over refusing: Play starts late by the undo's length, and the `play` op's reply
  // table (#1574) needs no new reason.
  const worldSwitch = beginWorldSwitch();
  // Which scene we are snapshotting. `_entering` refuses a concurrent PLAY, but nothing refuses a
  // concurrent scene LOAD — the menu and the agent `load-scene` op both reach one while the awaits
  // below are in flight. A load landing there leaves `_snapshot`
  // describing a scene that is no longer loaded, and Stop would then restore it OVER the scene the
  // human is now looking at. Counting loads rather than comparing the path is deliberate: a reload
  // of the SAME path is just as fatal here and a path comparison cannot see it.
  const enteredLoadGeneration = sceneLoadGeneration();
  try {
    if (worldSwitch.idle) await worldSwitch.idle;
    // A preview envelope may hold a posed world; revert it to the authored snapshot FIRST so Play
    // captures authored data (not the previewed camera/text), and stand its panel down so its ▶ loop
    // does not go on posing into the Play world (#1546).
    const envelopeDown = takeDownPreviewEnvelope();
    if (envelopeDown) await envelopeDown;
    // Snapshot only — NO `assignGuids` (see captureAuthoredSnapshot). Bases included (A5).
    _snapshot = await captureAuthoredSnapshot();
    // The undo barrier belongs to the SNAPSHOT, not to the moment Play flips: an edit made during the
    // awaits below is not in the snapshot, so Stop's revert discards it in the world and its undo entry
    // must go with it (#1574 close-out re-review — the settings fetch moved ahead of the re-check).
    const barrier = undoDepth();
    // A body added since the scene loaded (the load itself already awaited Rapier) would otherwise
    // run Play's first frames with no physics (#1175). Awaited BEFORE the generation re-check below,
    // so a scene load landing during the WASM fetch is refused exactly like one landing mid-snapshot.
    // A permanent init failure still enters Play — the loader has logged it loudly.
    await ensurePhysicsReady(getCurrentWorld());
    // AI-panel opt-in flag. Read the cache synchronously (the panel primes it) to avoid a backend
    // round-trip on the Play path; only a cold first Play (panel never opened) pays a single fetch.
    // ⚠️ That fetch is an AWAIT, so it sits BEFORE the re-check below with the others: after it, a
    // load landing during the fetch armed Play over the new scene with the old one's snapshot (#1574
    // close-out review).
    const aiSettings = getCachedAiSettings() ?? await fetchAiSettings();
    // A scene load landed while we were snapshotting: everything captured above describes a world
    // that is gone. Refuse to enter Play rather than arm a Stop that would restore the wrong scene.
    // Bail BEFORE `setPlayState('playing')` — past that point Play is externally visible and the
    // snapshot is already load-bearing. The `finally` clears `_entering` and any queued Stop.
    if (sceneLoadGeneration() !== enteredLoadGeneration || aSceneSwapIsHappening()) {
      _snapshot = null;
      return refusePlay('load-landed', 'Play cancelled — a scene load landed while the snapshot was being taken.');
    }
    // Mark the undo barrier at the real Play press (not the paused→playing resume
    // above) so Stop can drop only during-Play edits — taken at the snapshot, above.
    _undoBarrier = barrier;
    // AI-panel opt-in: open the Tier-2 @contact journal watch BEFORE the sim starts, so a
    // physics trace is captured from the first frame (no agent journal action:start needed).
    // Open it ONLY when it isn't already active — so we don't take ownership of (and later close) a
    // capture a human/MCP opened manually. Stop closes only what WE opened (_autoOpenedContact).
    if (aiSettings.captureContactOnLaunch && !isVerboseCaptureActive('@contact')) {
      setVerboseCapture('@contact', true);
      _autoOpenedContact = true;
    }
    setPlayState('playing');
    editorEmit('!play', {});
    // A Stop pressed during the startup window above (getPlayState() still read 'stopped',
    // so stopPlay() couldn't act on it directly) is queued in `_stopRequested`. Honor it now
    // by running the real revert path — same snapshot reload, base restore, and undo
    // truncation a Stop pressed after Play would have gotten (#470).
    if (_stopRequested) {
      _stopRequested = false;
      const lead = 'Play started, but a Stop that arrived during startup ended it';
      let stopped: StopOutcome;
      try {
        stopped = await stopPlay();
      } catch (e) {
        console.error('[Editor] The Stop queued during Play startup failed to restore the authored world:', e);
        return { kind: 'stopped-during-startup', reverted: false, message: `${lead}, and restoring the authored world FAILED (${e instanceof Error ? e.message : String(e)}) — the live world may still be the Play world. Reload the scene before saving or pressing Play.` };
      }
      if (stopped.kind === 'stopped' && stopped.reverted) {
        return { kind: 'stopped-during-startup', reverted: true, message: `${lead} — the world is back to the authored snapshot.` };
      }
      const why = 'reason' in stopped && stopped.reason ? stopped.reason : `the Stop reported '${stopped.kind}'`;
      return { kind: 'stopped-during-startup', reverted: false, message: `${lead} without reverting: ${why}.` };
    }
    return { kind: 'started' };
  } finally {
    worldSwitch.release();
    reopenPreviewSessions();
    _entering = false;
    // Belt-and-braces clear, not a duplicate of the consume above: a SECOND stopPlay() can
    // still land here — e.g. arriving while the tail's own `await stopPlay()` is itself mid-
    // revert (`_entering` is still true then, so `stopPlay()`'s 'stopped' branch queues again)
    // — with nothing left in this function to consume it. And if startup THREW before ever
    // reaching 'playing', any queued stop was never a stop for a real Play and must not survive
    // to poison the next one. Safe either way: a legitimately queued stop was already consumed
    // above, before this runs.
    _stopRequested = false;
  }
}

/** Pause: freeze the simulation, keep the (mutated) play world. */
export function pausePlay(): void {
  // Refuse during Play startup — deliberately, matching enterPlay's own re-entrant-Play
  // refusal, NOT queued like Stop. A dropped Stop lost authored data (#470); a dropped
  // Pause just leaves the sim running, so there's nothing here worth queuing (#513).
  if (_entering) return;
  if (getPlayState() === 'playing') { setPlayState('paused'); editorEmit('!pause', {}); }
}

/** What a Stop did (#1574) — for the agent `stop` op, which used to answer `ok:true` whether or not
 *  the revert it was asked for happened. `reverted` is whether STOP's own restore ran; a skip names
 *  why. A restore that THROWS still throws (the flag `lastRestoreFailed` is set first). */
export type StopOutcome =
  | { kind: 'stopped'; reverted: true }
  | { kind: 'stopped'; reverted: false; reason: string }
  /** A preview envelope was exited. `reverted` is absent when Stop only waited for a restore a
   *  panel had ALREADY started — that restore is the panel's, and its outcome is not Stop's to report. */
  | { kind: 'preview-exited'; reverted?: boolean; reason?: string }
  /** Play is still starting up; the Stop is queued and its tail runs the revert (#470). */
  | { kind: 'queued' }
  | { kind: 'already-stopped' };

/** Stop: revert to the authored snapshot and return to edit mode. Play-mode
 *  mutations are discarded. No-op if never entered Play. */
export async function stopPlay(): Promise<StopOutcome> {
  // Toolbar (or agent) Stop also EXITS a preview envelope — mode 'scrub'/'preview' while
  // getPlayState() reads 'stopped': revert the held session, discard preview mutations and control
  // spawns, return to stopped so saves un-wedge, and stand the owning panel down (#1546 — it used to
  // be left running, and its ▶ loop reopened the envelope a frame later).
  //
  // ⚠️ Not while Play is starting up. `enterPlay` takes its own envelope down and a Stop in that
  // window must reach the #470 queue below, or Play starts anyway. (It drops the mode to 'stopped'
  // before awaiting that restore, so this branch is normally skipped then; a scrub claimed inside
  // the window is refused its session and hands the mode back on its own.)
  const rm = getRunMode();
  if ((rm === 'scrub' || rm === 'preview') && !_entering) {
    const envelopeDown = takeDownPreviewEnvelope();
    const reverted = envelopeDown ? await envelopeDown : undefined;
    editorEmit('!stop', { fromPreview: rm });
    return reverted === false
      ? { kind: 'preview-exited', reverted: false, reason: 'the scene changed since the preview began, so its snapshot was not restored over the new one' }
      : { kind: 'preview-exited', ...(reverted ? { reverted: true } : {}) };
  }
  if (getPlayState() === 'stopped') {
    // A genuine no-op UNLESS an enterPlay() is currently mid-startup — getPlayState() still
    // reads 'stopped' for most of that window (issue #470). In that case queue the Stop so
    // enterPlay's tail can honor it once it reaches 'playing', instead of silently discarding
    // a Stop the user believes took effect.
    if (_entering) { _stopRequested = true; return { kind: 'queued' }; }
    return { kind: 'already-stopped' };
  }
  // Taken BEFORE the mode flips (#1164): `setPlayState('stopped')` below is a settle edge, and a
  // hot reload deferred during Play must replay only after the snapshot restore has landed, or the
  // two loads supersede each other — see `authoringSettle.ts`.
  const releaseReplacement = beginWorldReplacement();
  try {
    setPlayState('stopped');
    closeAutoContactCapture(); // if this Play auto-opened @contact, close it — don't leak into edit mode
    editorEmit('!stop', {});
    const snap = _snapshot;
    _snapshot = null;
    if (!snap) return { kind: 'stopped', reverted: false, reason: 'Play held no authored snapshot, so there was nothing to restore — the live world is the Play world' };
    // Guard: if the active scene changed since Play, the snapshot is for a
    // different scene — reverting it would clobber the current one. Skip.
    if (snap.key !== currentSceneKey()) return { kind: 'stopped', reverted: false, reason: 'the scene changed during Play, so its snapshot was not restored over the new one — the live world keeps whatever Play did to it' };
    // Reload the captured authored scene in place, then replay what the reload carries (bases,
    // Persistent roots). preloaded skips the fetch, so disk is never touched. The world is rebuilt
    // (new ECS ids), but undo actions resolve their targets by stable guid (see entityRef.ts), so
    // PRE-Play history survives — we only truncate the during-Play edits the revert discarded.
    await restoreAuthoredSnapshot(snap);
    truncateUndoTo(_undoBarrier);
    _undoBarrier = 0;
    return { kind: 'stopped', reverted: true };
  } finally {
    releaseReplacement();
  }
}

// ── Editor preview/scrub run-mode transitions (preview-mode-refactor, Phase 1) ──
//
// The two editor-preview run states (`scrub` = idempotent pose while dragging a playhead;
// `preview` = the Timeline ▶ forward playthrough) used to masquerade as `'stopped'`. These funnel
// their RunMode signal through this one controller — the same place Play/Stop/Pause live — so the
// snapshot/session merge in Phase 3 has a single home.
//
// OWNERSHIP (fixes review H1 / plan Risk #5): `RunMode` is a single GLOBAL but BOTH editor panels
// (Timeline + Animation) drive it. Without an owner, panel B's teardown effect (mount / asset-
// switch / unmount) would `exitPreviewMode()` panel A's LIVE preview to `stopped` while A's rAF
// keeps mutating authored traits — silently defeating the Phase-2 save guards. So each panel tags
// its transitions with an `owner` string, and `exitPreviewMode(owner)` refuses to clobber a mode a
// DIFFERENT owner currently holds. Every transition also NO-OPs while a Play is live so a stray
// panel effect (a ruler drag mid-Play) can never downgrade a running simulation.

/** Which panel currently holds a non-stopped scrub/preview mode ('timeline' | 'animation'), or null
 *  when stopped/playing. Guards cross-panel clobbering — see OWNERSHIP above. */
let _modeOwner: string | null = null;

/** The owner of the current non-stopped editor mode, or null. */
export function getModeOwner(): string | null { return _modeOwner; }

/** Owner-change listeners — for a panel that DERIVES "am I previewing" from `getModeOwner()` (#1549).
 *  A separate signal from the run mode on purpose: one panel taking scrub from the other changes the
 *  OWNER while the mode stays 'scrub', so a run-mode subscriber never hears it — which is how the
 *  Animation panel's hand-kept `inPreview` went on showing ⏹ for an envelope the Timeline had taken. */
const _ownerListeners = new Set<() => void>();

/** Subscribe to mode-owner changes (shape fits `useSyncExternalStore`). */
export function onModeOwnerChange(fn: () => void): () => void {
  _ownerListeners.add(fn);
  return () => { _ownerListeners.delete(fn); };
}

/** The ONE writer of `_modeOwner`, so no path can change it without telling the subscribers. */
function setModeOwner(next: string | null): void {
  if (next === _modeOwner) return;
  _modeOwner = next;
  notifyListeners(_ownerListeners, 'playMode:owner', []);
}

/** Displacement callbacks, keyed by owner tag: "you no longer hold the mode — stop running." (#810)
 *
 *  ⚠️ NOT a re-seating stack like `timelinePreview.ts`'s `_saveHandler` registry. `RunMode` is
 *  genuinely single-valued — the moment panel B enters, panel A's preview is over GLOBALLY, there
 *  is no slot to hand back to A later. What A is missing is not ownership but NOTICE: its rAF loop
 *  (`TimelineEditor.tsx`'s preview effect, keyed `[playing, rootId]` — never consults `getRunMode()`
 *  in its tick body) keeps mutating authored traits with nobody telling it to stop, even though
 *  `getRunMode()` already reads B's mode. So this is a one-shot "you were displaced" notification,
 *  not a stack of owners.
 *
 *  One callback per owner tag — a panel re-registers (replacing, not stacking) each time it takes
 *  the mode, since only the CURRENT registration is meaningful once displaced. */
const _displacedCallbacks = new Map<string, () => void>();

/** Register `fn` to run once if `owner` is displaced by a DIFFERENT owner entering scrub/preview.
 *  Returns an unregister function (call it on teardown so a stale callback can't fire into an
 *  unmounted panel). */
export function registerModeOwnerDisplaced(owner: string, fn: () => void): () => void {
  _displacedCallbacks.set(owner, fn);
  return () => { if (_displacedCallbacks.get(owner) === fn) _displacedCallbacks.delete(owner); };
}

/** Tell the previous owner (if any, and if different) that it was just displaced.
 *
 *  ⚠️ ORDERING IS LOAD-BEARING — call this AFTER `_modeOwner`/`setRunMode` have already been
 *  updated to the NEW mode, never before. `TimelineEditor`'s preview-effect cleanup does
 *  `if (getRunMode() === 'preview') enterPreviewMode(false, 'timeline')` (review L1's guard)
 *  precisely to avoid clobbering a scrub/preview some OTHER panel just entered. Notifying the
 *  displaced owner BEFORE the new mode is set would run that cleanup while `getRunMode()` still
 *  read the OLD mode — the guard would pass and the just-entered transition would be clobbered.
 *
 *  ⚠️ **Notifying AFTER makes that guard decline only when the new mode is `'scrub'`** — do not
 *  read this ordering as making re-entry safe in general. When the displacing owner enters
 *  `'preview'`, `getRunMode()` reads `'preview'` and the guard PASSES, so a callback that re-enters
 *  `enterPreviewMode` would clobber the transition and steal the ownership back. The ordering is
 *  necessary, not sufficient; what makes it safe here is that **no registered callback re-enters a
 *  mode transition at all** — both panels' callbacks only stop their own rAF guard. Keep it that
 *  way: a displacement callback is for standing down, never for taking a mode. A callback must never throw into the transition it's reporting — wrapped below, same
 *  convention as `onRendererLost`'s listener loop in `runtime/core/activeRenderer.ts`. */
function notifyDisplaced(previousOwner: string | null, newOwner: string): void {
  if (!previousOwner || previousOwner === newOwner) return;
  const fn = _displacedCallbacks.get(previousOwner);
  if (!fn) return;
  try { fn(); } catch (e) { console.error('[playMode] a mode-owner-displaced callback threw', e); }
}

/** Enter `scrub` (an idempotent pose at time t). No-op during Play. Sticks until an explicit exit
 *  (panel teardown / world-swap / asset-switch) or a transition to preview/play. */
export function enterScrubMode(owner: string): void {
  if (getRunMode() === 'playing') return; // never downgrade a live/paused Play
  const previousOwner = _modeOwner;
  setModeOwner(owner);
  setRunMode('scrub');
  notifyDisplaced(previousOwner, owner);
}

/** Enter forward `preview`; `advancing:false` = a frozen/paused preview frame. No-op during Play. */
export function enterPreviewMode(advancing: boolean, owner: string): void {
  if (getRunMode() === 'playing') return;
  const previousOwner = _modeOwner;
  setModeOwner(owner);
  setRunMode('preview', { advancing });
  notifyDisplaced(previousOwner, owner);
}

/** Pause: hold the live preview as a FROZEN frame (`preview` + `advancing:false`, session still held),
 *  but only when `owner`'s preview is still the live mode. A scrub/⏮ that already set `scrub`, a
 *  teardown that already returned to `stopped`, or another panel that took the mode is left alone —
 *  freezing then would clobber that transition or steal the mode back. #1552: the Animation panel's
 *  pause never called anything, so a paused ▶ kept reporting an advancing preview. */
export function freezePreviewIfOwnedBy(owner: string): void {
  if (getRunMode() !== 'preview' || _modeOwner !== owner) return;
  setRunMode('preview', { advancing: false });
}

/** Return to `stopped` from a scrub/preview (panel teardown, world-swap, asset-switch). No-op
 *  during Play (Stop owns play→stopped) AND when a DIFFERENT panel owns the live mode — a second
 *  editor must never tear down another's active preview/scrub (review H1). */
export function exitPreviewMode(owner: string): void {
  const m = getRunMode();
  if (m !== 'scrub' && m !== 'preview') return;
  if (_modeOwner && _modeOwner !== owner) return; // another panel owns this mode — leave it alone
  setModeOwner(null);
  setRunMode('stopped');
}

/** Take a preview envelope down from OUTSIDE the panel that owns it — Play pressed, toolbar/agent
 *  Stop (#1546). Restores the held session (or lets a restore already landing finish), cancels any
 *  begin still serializing and any grab-while-playing chain, and returns the mode to 'stopped' —
 *  which is what notifies the owning panel (the run-mode listener below).
 *
 *  Order matters: the session end is STARTED before the mode drops, because its synchronous prefix
 *  is what marks the restore in flight — a Cmd+S or a begin in the gap must see that, not a
 *  'stopped' mode over a still-posed world (#1167's window).
 *
 *  Returns the restore to await, or null when there is none — so a Play press with no envelope
 *  reaches its snapshot in the same synchronous run it always did, instead of yielding first. It
 *  resolves to whether THIS call's restore ran, or `undefined` when it only waited for one a panel had
 *  already started (see `StopOutcome`'s 'preview-exited'). */
function takeDownPreviewEnvelope(): Promise<boolean | undefined> | null {
  cancelPreviewGestures();
  cancelPendingPreviewBegins();
  const ending = hasTimelinePreviewSession() ? endTimelinePreviewSessionReporting({ restore: true }).then((r) => r.reverted)
    : isPreviewRestoreInFlight() ? whenPreviewRestoresLanded().then(() => undefined)
      : null;
  const m = getRunMode();
  if (m === 'scrub' || m === 'preview') setRunMode('stopped');
  return ending;
}

/** A scene load out of a preview envelope restores it first (#1548 close-out review) — the one path
 *  `enterPlay` and `stopPlay` already take, so all three leave the envelope the same way. Play is
 *  not an envelope here: a load during Play drops Play as it always has. */
registerBeforeSceneLoad(() => (getRunMode() === 'playing' ? null : takeDownPreviewEnvelope()));

/** The mode owner exists only while the mode is 'scrub'/'preview' — enforced HERE, on every mode
 *  change, not by each caller that leaves the mode (#1546).
 *
 *  Several paths leave it without going through `exitPreviewMode`: a scene load
 *  (`serialize.loadScene` sets 'stopped'), `resetPlayMode`, Play itself. Each used to leave
 *  `_modeOwner` naming a panel whose envelope was gone, and nothing told that panel — so its ▶ loop
 *  kept posing, its ⏹ stayed up, and `get_editor_state.modeOwner` reported a preview that did not
 *  exist. A mode change that drops the owner WITHOUT the owner's own `exitPreviewMode` (which clears
 *  `_modeOwner` before it sets the mode, so it never reaches the notify here) is a displacement, and
 *  the owner hears it through the same callback a rival panel's scrub already uses.
 *
 *  **Leaving the envelope also cancels any `begin` still serializing (#1569)** — here, for the same
 *  reason the owner release is here: every way out passes through this listener, and no single exit
 *  path can be trusted to remember. A teardown ends only a HELD session (`hasTimelinePreviewSession()
 *  && end…`), so a scrub's begin still awaiting its snapshot used to survive a timeline switch, an
 *  unmount, a world swap or the Animation panel's ⏹, and seat a session after the mode was already
 *  `stopped`: a posed world, no owner, no ⏹ anywhere. The invariant this keeps is that a session is
 *  only ever seated under a live mode claim, so every begin must be made under one (the Timeline ▶
 *  claims a frozen `preview` before its begin for exactly this reason — `openPlaybackSession`).
 *  A move WITHIN the envelope (scrub ⇄ preview, a pause freezing it) cancels nothing. */
let _lastRunMode = getRunMode();
onRunModeChange(() => {
  const m = getRunMode();
  const wasEnvelope = _lastRunMode === 'scrub' || _lastRunMode === 'preview';
  _lastRunMode = m;
  if (m === 'scrub' || m === 'preview') return;
  if (wasEnvelope) cancelPendingPreviewBegins();
  const previousOwner = _modeOwner;
  if (previousOwner === null) return;
  setModeOwner(null);
  notifyDisplaced(previousOwner, m);
});

/** Close the Tier-2 @contact capture iff THIS play session auto-opened it (see _autoOpenedContact).
 *  Idempotent; leaves a manually/MCP-opened capture untouched. */
function closeAutoContactCapture(): void {
  if (_autoOpenedContact) { setVerboseCapture('@contact', false); _autoOpenedContact = false; }
}

/** Drop any retained snapshot and return to Stopped (e.g. on scene switch). */
export function resetPlayMode(): void {
  _snapshot = null;
  _undoBarrier = 0;
  setModeOwner(null);
  closeAutoContactCapture();
  setPlayState('stopped');
}
