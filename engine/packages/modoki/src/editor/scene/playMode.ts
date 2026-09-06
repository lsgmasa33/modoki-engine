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
import { getPlayState, setPlayState, getRunMode, setRunMode } from '../../runtime/core/playState';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { PREFAB_EDIT_SCENE_PREFIX } from './prefabEditWorld';
import { serializeScene, getCurrentScenePath, sceneLoadGeneration, isSceneLoadInFlight, type SceneFile, type SerializedEntity } from './serialize';
import { undoDepth, truncateUndoTo } from '../undo/undoManager';
import { editorEmit } from '../editorJournal';
import { hasTimelinePreviewSession, endTimelinePreviewSession } from './timelinePreview';
import { setVerboseCapture, isVerboseCaptureActive } from '../../runtime/core/journal';
import { fetchAiSettings, getCachedAiSettings } from '../panels/aiSettingsModel';
import { findEntityByGuid } from '../../runtime/core/ecs/world';
import { writeTraitField } from '../../runtime/core/ecs/entityUtils';
import { getAllTraits } from '../../runtime/core/ecs/traitRegistry';

/** In-memory authored snapshot captured at the moment Play was pressed, plus the
 *  scene path it belongs to (so a scene swap mid-play can't revert the wrong
 *  scene). */
let _snapshot: SceneFile | null = null;
let _snapshotPath: string | null = null;
/** A5 (scene-loading.md, Phase 12): authored snapshots of every
 *  BASE scene in the chain at the moment Play was pressed, keyed by scene guid. The
 *  primary's own snapshot excludes base-origin entities entirely (Phase 6), and
 *  SceneManager CARRIES a kept base across the Stop-revert reload rather than
 *  re-loading its file — so without this, a base entity mutated during Play (a fish
 *  that swam, a camera the game moved) silently keeps its play-mode value after Stop.
 *  Harmless while base entities could never reach disk; now that Phase 12 makes them
 *  writable, that drift is a real data-corruption path. Each snapshot's trait data is
 *  ALREADY authored-only (`serializeScene` skips `runtimeOnly` fields when building
 *  it), so Time.elapsed/frame are simply absent — replaying it back can never regress
 *  Phase 7's verified "Time keeps climbing across Stop" gate. */
let _baseSnapshots: Map<string, SceneFile> | null = null;
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

/**
 * Which SCENE the Play snapshot belongs to, and the path the Stop-revert reloads it under.
 *
 * ⚠️ **Not `getCurrentScenePath()`, and the difference is the whole bug.** That is the editor's
 * *file* path, and prefab-edit deliberately sets it to **null** so a normal save cannot target a
 * real file. The Stop-revert therefore reloaded the world under `path ?? ''` — an empty path — so
 * after Play→Stop the live scene silently stopped being the prefab-edit world. Reported as: *"when
 * I press play, and stop, the prefab edit mode loses the prefab name, and cmd+s ends up the new
 * file dialog."* Both symptoms are that one empty string:
 *
 *  - the SceneView breadcrumb ground-truths on `sceneManager.getCurrent()?.path` starting with the
 *    prefab-edit prefix, so it stops showing the prefab;
 *  - `isEditingPrefab()` fails the same check and runs its self-heal, CLEARING `editingPrefab` —
 *    after which Cmd+S no longer routes to `savePrefabEdit()` and falls through to a scene save with
 *    a null path, i.e. the native "Save Scene As" panel.
 *
 * So the SYNTHETIC path has to round-trip, and only the live identity carries it. See the body for
 * why that preference is narrowed to the synthetic case rather than applied blanket. Both the
 * capture and the compare go through here, so they cannot disagree.
 */
function currentSceneKey(): string | null {
  // ⚠️ Prefer the live path ONLY when it is the synthetic one. A blanket
  // `sceneManager.getCurrent()?.path ?? getCurrentScenePath()` looks equivalent and is not:
  // `newScene()` wipes the ECS world and sets `_currentScenePath` WITHOUT touching sceneManager,
  // so after an untitled new scene the live path is still the PREVIOUS scene's. Preferring it
  // there made Stop reload the blank world under the old scene's identity — impersonating a real
  // file. Narrowing to the synthetic prefix fixes the prefab-edit case (the bug this exists for)
  // and leaves every other case exactly as it was before.
  const live = sceneManager.getCurrent()?.path ?? null;
  return live?.startsWith(PREFAB_EDIT_SCENE_PREFIX) ? live : getCurrentScenePath();
}

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
function aSceneSwapIsHappening(): boolean {
  return isSceneLoadInFlight() || sceneManager.getNext() !== null;
}

export async function enterPlay(): Promise<void> {
  if (getPlayState() === 'playing') { _stopRequested = false; return; }
  // Resume from Pause without re-snapshotting (the snapshot from the original
  // Play press still represents the authored state to revert to).
  if (getPlayState() === 'paused') {
    _stopRequested = false;
    setPlayState('playing');
    editorEmit('!play', { resume: true });
    return;
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
  // was written to stop swallowing.
  if (_entering) return;
  // ⚠️ The generation ALONE is one-sided, and the missing half is the nastier case. A load already
  // in flight when Play is pressed has ALREADY bumped the epoch, so the capture above reads equal
  // on both sides and the check below passes — Play then arms with a snapshot of the pre-swap
  // world. When that load is a reload of the SAME path, `stopPlay`'s `snapPath !== path` guard does
  // not fire either, so Stop restores the stale world over the reloaded one: the exact outcome this
  // guard exists to prevent, entered from the other side. So refuse up front too — this is
  // docs/async-lifetime.md's "Both? Use both."
  if (aSceneSwapIsHappening()) {
    console.warn('[Editor] Play refused — a scene load is still in flight. Try again once it lands.');
    return;
  }

  // Set synchronously, before the first await, so a Stop that arrives while we're
  // mid-startup (getPlayState() still reads 'stopped' below) can tell "Play is
  // starting" apart from "genuinely stopped" — see `_entering`'s doc comment (#470).
  _entering = true;
  // Which scene we are snapshotting. `_entering` refuses a concurrent PLAY, but nothing refuses a
  // concurrent scene LOAD — the menu and the agent `load-scene` op both reach one while the awaits
  // below are in flight. A load landing there leaves `_snapshot`/`_snapshotPath`/`_baseSnapshots`
  // describing a scene that is no longer loaded, and Stop would then restore it OVER the scene the
  // human is now looking at. Counting loads rather than comparing the path is deliberate: a reload
  // of the SAME path is just as fatal here and a path comparison cannot see it.
  const enteredLoadGeneration = sceneLoadGeneration();
  try {
    // A Timeline-panel preview session may hold preview-mutated world state; revert it to the
    // authored snapshot FIRST so Play captures authored data (not the previewed camera/text).
    if (hasTimelinePreviewSession()) await endTimelinePreviewSession({ restore: true });
    // Snapshot only — NO `assignGuids`. Play must not write authored data (its whole
    // contract is that Stop discards every play-mode mutation); minted guids land in
    // the snapshot JSON, not the live world. Do not pass { assignGuids: true } here.
    _snapshot = await serializeScene();
    _snapshotPath = currentSceneKey();
    // A5: snapshot every base in the chain too, so Stop can restore authored base
    // state (see `_baseSnapshots`'s own doc comment). No-op cost when there is no
    // base (the common case, and every project before this plan) — empty map.
    _baseSnapshots = new Map();
    for (const entry of sceneManager.getLoadedScenes().values()) {
      if (entry.role !== 'base') continue;
      // Defensive per-base catch: if a base fails to serialize, skip ITS A5 restore
      // rather than block Play entirely (its authored state then just isn't restored
      // on Stop). This used to fire routinely for a base containing a prefab instance
      // — Phase 12's A8/A9 safety guard — which is now gone, both bugs being fixed;
      // sling's Base.json snapshots normally. Kept for resilience, not for that guard.
      try {
        _baseSnapshots.set(entry.guid, await serializeScene({ scene: { path: entry.path, guid: entry.guid } }));
      } catch (e) {
        console.warn(`[Editor] A5 base snapshot skipped for "${entry.path}": ${(e as Error).message}`);
      }
    }
    // A scene load landed while we were snapshotting: everything captured above describes a world
    // that is gone. Refuse to enter Play rather than arm a Stop that would restore the wrong scene.
    // Bail BEFORE `setPlayState('playing')` — past that point Play is externally visible and the
    // snapshot is already load-bearing. The `finally` clears `_entering` and any queued Stop.
    if (sceneLoadGeneration() !== enteredLoadGeneration || aSceneSwapIsHappening()) {
      console.warn('[Editor] Play cancelled — a scene load landed while the snapshot was being taken.');
      _snapshot = null;
      _snapshotPath = null;
      _baseSnapshots = new Map();
      return;
    }
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
    // A Stop pressed during the startup window above (getPlayState() still read 'stopped',
    // so stopPlay() couldn't act on it directly) is queued in `_stopRequested`. Honor it now
    // by running the real revert path — same snapshot reload, base restore, and undo
    // truncation a Stop pressed after Play would have gotten (#470).
    if (_stopRequested) {
      _stopRequested = false;
      await stopPlay();
    }
  } finally {
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
  if (getPlayState() === 'stopped') {
    // A genuine no-op UNLESS an enterPlay() is currently mid-startup — getPlayState() still
    // reads 'stopped' for most of that window (issue #470). In that case queue the Stop so
    // enterPlay's tail can honor it once it reaches 'playing', instead of silently discarding
    // a Stop the user believes took effect.
    if (_entering) _stopRequested = true;
    return;
  }
  setPlayState('stopped');
  closeAutoContactCapture(); // if this Play auto-opened @contact, close it — don't leak into edit mode
  editorEmit('!stop', {});
  const snap = _snapshot;
  const snapPath = _snapshotPath;
  const baseSnaps = _baseSnapshots;
  _snapshot = null;
  _snapshotPath = null;
  _baseSnapshots = null;
  if (!snap) return;
  // Guard: if the active scene changed since Play, the snapshot is for a
  // different scene — reverting it would clobber the current one. Skip.
  const path = currentSceneKey();
  if (snapPath !== path) return;
  // Reload the captured authored scene in place. preloaded skips the fetch, so
  // disk is never touched; the swap reuses already-resident resources via the
  // scene refcount. The world is rebuilt (new ECS ids), but undo actions resolve
  // their targets by stable guid (see entityRef.ts), so PRE-Play history survives
  // — we only truncate the during-Play edits the revert just discarded.
  await sceneManager.loadScene(path ?? '', { preloaded: snap as unknown as SceneData });
  // A5: the reload above CARRIES a kept base rather than re-loading its file, so a
  // base entity's play-mode drift (Transform, or any other authored field a game
  // system wrote at runtime) is still sitting on the just-carried live entities.
  // Replay each base's authored snapshot back onto them, by guid.
  if (baseSnaps) for (const snapshot of baseSnaps.values()) restoreAuthoredEntities(snapshot.entities);
  truncateUndoTo(_undoBarrier);
  _undoBarrier = 0;
}

/** Write each snapshot entry's AUTHORED fields back onto the matching LIVE entity
 *  (resolved by guid), skipping entities no longer present (a base's file/subtree
 *  changed shape between Play and Stop — rare, and a missing entity is simply not
 *  restored rather than an error). `entry.traits` already excludes `runtimeOnly`
 *  fields (serializeScene's own filter) and EntityAttributes/PrefabInstance are
 *  skipped here too — identity/hierarchy fields don't drift at runtime the way
 *  gameplay-mutated fields (Transform, a binding-driven trait) do, and blindly
 *  replaying a snapshot's `parentId`/`sortOrder` could undo a LEGITIMATE structural
 *  edit made to the base while Play was running via the editor's own tools (not the
 *  game) — out of scope for what A5 exists to fix.
 *
 *  A prefab-instance ROOT writes only `PrefabInstance` in `entry.traits` (Phase 6's
 *  serialize convention) — its actual authored field values (Transform, a custom
 *  trait like `Fish`) live in `entry.overrides[localId]`, keyed by the root's OWN
 *  localId. Resolved from the LIVE entity's current PrefabInstance.localId (stable
 *  across Play — reparenting/duplication during Play would be reverted structurally
 *  by the primary's own snapshot revert, not by this pass). */
function restoreAuthoredEntities(entries: SerializedEntity[]): void {
  const allTraits = getAllTraits();
  const piMeta = allTraits.find((m) => m.name === 'PrefabInstance');
  for (const entry of entries) {
    const guid = entry.guid || (entry.traits.EntityAttributes && entry.traits.EntityAttributes !== true
      ? (entry.traits.EntityAttributes as Record<string, unknown>).guid as string | undefined
      : undefined);
    if (!guid) continue;
    const liveEntity = findEntityByGuid(guid);
    if (!liveEntity) continue;
    const liveId = liveEntity.id();

    let fieldsByTrait: Record<string, Record<string, unknown> | boolean> = entry.traits;
    if (entry.prefab && entry.overrides && piMeta && liveEntity.has(piMeta.trait)) {
      const localId = (liveEntity.get(piMeta.trait) as { localId?: number }).localId;
      fieldsByTrait = (localId != null ? entry.overrides[localId] : undefined) ?? {};
    }

    for (const [traitName, fields] of Object.entries(fieldsByTrait)) {
      if (traitName === 'EntityAttributes' || traitName === 'PrefabInstance') continue;
      if (fields === true) continue; // a tag trait's presence doesn't drift at runtime
      const meta = allTraits.find((m) => m.name === traitName);
      if (!meta) continue;
      for (const [field, value] of Object.entries(fields)) writeTraitField(liveId, meta, field, value);
    }
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
  _modeOwner = owner;
  setRunMode('scrub');
  notifyDisplaced(previousOwner, owner);
}

/** Enter forward `preview`; `advancing:false` = a frozen/paused preview frame. No-op during Play. */
export function enterPreviewMode(advancing: boolean, owner: string): void {
  if (getRunMode() === 'playing') return;
  const previousOwner = _modeOwner;
  _modeOwner = owner;
  setRunMode('preview', { advancing });
  notifyDisplaced(previousOwner, owner);
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
  _baseSnapshots = null;
  _undoBarrier = 0;
  _modeOwner = null;
  closeAutoContactCapture();
  setPlayState('stopped');
}
