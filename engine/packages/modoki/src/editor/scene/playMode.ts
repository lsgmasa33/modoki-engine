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

import type { SceneData } from '../../runtime/loaders/loadSceneFile';
import { getPlayState, setPlayState, getRunMode, setRunMode } from '../../runtime/systems/playState';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { serializeScene, getCurrentScenePath, type SceneFile } from './serialize';
import { undoDepth, truncateUndoTo } from '../undo/undoManager';
import { editorEmit } from '../editorJournal';
import { hasTimelinePreviewSession, endTimelinePreviewSession } from './timelinePreview';
import { setVerboseCapture, isVerboseCaptureActive } from '../../runtime/systems/journal';
import { fetchAiSettings, getCachedAiSettings } from '../panels/aiSettingsModel';

/** In-memory authored snapshot captured at the moment Play was pressed, plus the
 *  scene path it belongs to (so a scene swap mid-play can't revert the wrong
 *  scene). */
let _snapshot: SceneFile | null = null;
let _snapshotPath: string | null = null;
/** Undo-stack depth captured at the Play press. On Stop we truncate back to this
 *  so during-Play editor edits (discarded by the revert) don't leave incoherent
 *  undo entries — while ALL pre-Play history is preserved (guid-resolved undo
 *  survives the world rebuild). */
let _undoBarrier = 0;
/** True when THIS Play press auto-opened the Tier-2 @contact capture (via the AI-panel flag),
 *  so Stop closes only what we opened — never a capture a human/MCP opened manually. Without
 *  this, the process-global capture would leak past Stop into edit mode + later worlds. */
let _autoOpenedContact = false;

/** Enter Play: snapshot the authored world, then start the simulation. */
export async function enterPlay(): Promise<void> {
  if (getPlayState() === 'playing') return;
  // Resume from Pause without re-snapshotting (the snapshot from the original
  // Play press still represents the authored state to revert to).
  if (getPlayState() === 'paused') { setPlayState('playing'); editorEmit('!play', { resume: true }); return; }
  // A Timeline-panel preview session may hold preview-mutated world state; revert it to the
  // authored snapshot FIRST so Play captures authored data (not the previewed camera/text).
  if (hasTimelinePreviewSession()) await endTimelinePreviewSession({ restore: true });
  // Snapshot only — NO `assignGuids`. Play must not write authored data (its whole
  // contract is that Stop discards every play-mode mutation); minted guids land in
  // the snapshot JSON, not the live world. Do not pass { assignGuids: true } here.
  _snapshot = await serializeScene();
  _snapshotPath = getCurrentScenePath();
  // Mark the undo barrier at the real Play press (not the paused→playing resume
  // above) so Stop can drop only during-Play edits.
  _undoBarrier = undoDepth();
  // AI-panel opt-in: open the Tier-2 @contact journal watch BEFORE the sim starts, so a
  // physics trace is captured from the first frame (no agent journal action:start needed).
  // Reads the cached flag synchronously (the panel primes it) to avoid a backend round-trip on
  // the Play path; only a cold first Play (panel never opened) pays a single fetch. Open it ONLY
  // when it isn't already active — so we don't take ownership of (and later close) a capture a
  // human/MCP opened manually. Stop closes only what WE opened (_autoOpenedContact).
  const aiSettings = getCachedAiSettings() ?? await fetchAiSettings();
  if (aiSettings.captureContactOnLaunch && !isVerboseCaptureActive('@contact')) {
    setVerboseCapture('@contact', true);
    _autoOpenedContact = true;
  }
  setPlayState('playing');
  editorEmit('!play', {});
}

/** Pause: freeze the simulation, keep the (mutated) play world. */
export function pausePlay(): void {
  if (getPlayState() === 'playing') { setPlayState('paused'); editorEmit('!pause', {}); }
}

/** Stop: revert to the authored snapshot and return to edit mode. Play-mode
 *  mutations are discarded. No-op if never entered Play. */
export async function stopPlay(): Promise<void> {
  // Toolbar Stop also EXITS a Timeline ▶ preview (mode 'preview'/'scrub' while getPlayState()
  // reads 'stopped'): revert the held snapshot session — discarding preview mutations + control
  // spawns — then return to stopped so saves un-wedge (review M1). A plain drag-scrub holds NO
  // session yet (its authored pose is only revertible once Phase 3 gives scrub a mandatory
  // session), so we intentionally DON'T clear it here — leaving it wedged keeps saves refused
  // (leak-proof) rather than exposing the un-reverted pose to a save.
  const rm = getRunMode();
  if ((rm === 'scrub' || rm === 'preview') && hasTimelinePreviewSession()) {
    await endTimelinePreviewSession({ restore: true });
    _modeOwner = null;
    setRunMode('stopped');
    editorEmit('!stop', { fromPreview: rm });
    return;
  }
  if (getPlayState() === 'stopped') return;
  setPlayState('stopped');
  closeAutoContactCapture(); // if this Play auto-opened @contact, close it — don't leak into edit mode
  editorEmit('!stop', {});
  const snap = _snapshot;
  const snapPath = _snapshotPath;
  _snapshot = null;
  _snapshotPath = null;
  if (!snap) return;
  // Guard: if the active scene changed since Play, the snapshot is for a
  // different scene — reverting it would clobber the current one. Skip.
  const path = getCurrentScenePath();
  if (snapPath !== path) return;
  // Reload the captured authored scene in place. preloaded skips the fetch, so
  // disk is never touched; the swap reuses already-resident resources via the
  // scene refcount. The world is rebuilt (new ECS ids), but undo actions resolve
  // their targets by stable guid (see entityRef.ts), so PRE-Play history survives
  // — we only truncate the during-Play edits the revert just discarded.
  await sceneManager.loadScene(path ?? '', { preloaded: snap as unknown as SceneData });
  truncateUndoTo(_undoBarrier);
  _undoBarrier = 0;
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

/** Enter `scrub` (an idempotent pose at time t). No-op during Play. Sticks until an explicit exit
 *  (panel teardown / world-swap / asset-switch) or a transition to preview/play. */
export function enterScrubMode(owner: string): void {
  if (getRunMode() === 'playing') return; // never downgrade a live/paused Play
  _modeOwner = owner;
  setRunMode('scrub');
}

/** Enter forward `preview`; `advancing:false` = a frozen/paused preview frame. No-op during Play. */
export function enterPreviewMode(advancing: boolean, owner: string): void {
  if (getRunMode() === 'playing') return;
  _modeOwner = owner;
  setRunMode('preview', { advancing });
}

/** Return to `stopped` from a scrub/preview (panel teardown, world-swap, asset-switch). No-op
 *  during Play (Stop owns play→stopped) AND when a DIFFERENT panel owns the live mode — a second
 *  editor must never tear down another's active preview/scrub (review H1). */
export function exitPreviewMode(owner: string): void {
  const m = getRunMode();
  if (m !== 'scrub' && m !== 'preview') return;
  if (_modeOwner && _modeOwner !== owner) return; // another panel owns this mode — leave it alone
  _modeOwner = null;
  setRunMode('stopped');
}

/** Close the Tier-2 @contact capture iff THIS play session auto-opened it (see _autoOpenedContact).
 *  Idempotent; leaves a manually/MCP-opened capture untouched. */
function closeAutoContactCapture(): void {
  if (_autoOpenedContact) { setVerboseCapture('@contact', false); _autoOpenedContact = false; }
}

/** Drop any retained snapshot and return to Stopped (e.g. on scene switch). */
export function resetPlayMode(): void {
  _snapshot = null;
  _snapshotPath = null;
  _undoBarrier = 0;
  _modeOwner = null;
  closeAutoContactCapture();
  setPlayState('stopped');
}
