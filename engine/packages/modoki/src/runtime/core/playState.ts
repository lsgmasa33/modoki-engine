/** Global RUN MODE — the single source of truth for "what run state is the editor/game in".
 *
 *  Four modes (Unity-style Stopped/Playing plus the two editor-preview states that used to
 *  masquerade as "stopped"):
 *    - `stopped`  — authoring: sim off, particles frozen, no timeline eval. Editing is safe.
 *    - `scrub`    — dragging a timeline/animation playhead: an idempotent POSE at time t; NO edge
 *                   events (silent). Each call is one pose, so it is inherently non-advancing.
 *    - `preview`  — the Timeline panel ▶ forward playthrough: edges fire (signals/audio/control/
 *                   OnSequence), particles play, but the SIM TIER stays gated off (not full Play).
 *    - `playing`  — full Play: the whole simulation runs.
 *  plus an `advancing` sub-flag: `false` = a frozen frame (Play "paused", or a paused preview).
 *
 *  The runtime defaults to `playing`/advancing so a SHIPPED game (which never imports the editor)
 *  runs with zero setup. The editor drives the mode explicitly: opens a scene `stopped`, snapshots
 *  on Play, reverts on Stop — so play/preview/scrub mutations never leak into saved scenes (see
 *  `editor/scene/playMode.ts`). `isSimRunning()` gates the sim tier (`pipeline.ts`, `getTime.ts`).
 *
 *  MIGRATION (preview-mode-refactor, Phase 0): `RunMode` is introduced additively — the legacy
 *  `PlayState` API (`getPlayState`/`setPlayState`/`isSimRunning`/`onPlayStateChange`) is DERIVED
 *  from `(mode, advancing)` as an exact compat shim (`scrub`/`preview` both read back as `stopped`,
 *  which is how they behave today). Nobody SETS `scrub`/`preview` until Phase 1, so behaviour is
 *  byte-identical. Later phases flip call sites to the mode helpers below and retire the shims. */

export type PlayState = 'stopped' | 'playing' | 'paused';
export type RunMode = 'stopped' | 'scrub' | 'preview' | 'playing';

let _mode: RunMode = 'playing';
let _advancing = true; // false = frozen frame (Play paused, or paused preview)

const _playListeners = new Set<() => void>(); // onPlayStateChange — fires only when the DERIVED PlayState changes (compat)
const _modeListeners = new Set<() => void>(); // onRunModeChange — fires on any (mode, advancing) change

/** Collapse `(mode, advancing)` to the legacy 3-value PlayState: `scrub`/`preview` → `stopped`
 *  (that is how they behave today — sim tier off, authoring surface); Play paused → `paused`. */
function derivePlayState(): PlayState {
  if (_mode === 'playing') return _advancing ? 'playing' : 'paused';
  return 'stopped';
}

// ── RunMode API (the new source of truth) ──

export function getRunMode(): RunMode {
  return _mode;
}

/** False while a frame is FROZEN — Play "paused" or a paused forward-preview. Always true for
 *  `stopped`/`scrub` (irrelevant there). */
export function isAdvancing(): boolean {
  return _advancing;
}

export function setRunMode(mode: RunMode, opts?: { advancing?: boolean }): void {
  const advancing = opts?.advancing ?? true; // entering a mode advances by default; pass false to freeze
  if (mode === _mode && advancing === _advancing) return;
  const prevPlay = derivePlayState();
  _mode = mode;
  _advancing = advancing;
  if (derivePlayState() !== prevPlay) for (const fn of _playListeners) fn();
  for (const fn of _modeListeners) fn();
}

/** Subscribe to RunMode transitions (any mode/advancing change). Returns an unsubscribe function. */
export function onRunModeChange(fn: () => void): () => void {
  _modeListeners.add(fn);
  return () => { _modeListeners.delete(fn); };
}

// ── Gate helpers — derive every decision from the mode so a new mode can't half-wire a site.
//    (Added in Phase 0; call sites migrate to these in Phase 4.) ──

/** Game actions / audio cues / OnSequence / control-track edges fire in Play AND forward-preview
 *  (not scrub — silent — nor a FROZEN frame). Replaces `isSimRunning() || isTimelinePreviewActive()`. */
export function shouldFireActions(): boolean {
  return (_mode === 'playing' || _mode === 'preview') && _advancing;
}

/** The simulation tier (TIME/GAME/ANIMATION systems + `getSimDelta`) runs only in full, advancing Play. */
export function shouldRunSimTier(): boolean {
  return _mode === 'playing' && _advancing;
}

/** Scrub is a single idempotent, silent pose (no edge events). */
export function isPoseOnly(): boolean {
  return _mode === 'scrub';
}

/** The viewport should render continuously (Play + forward-preview). FX-preview / skeletal-preview
 *  side-channels are ORed in at the call sites — they compose with any mode. */
export function isLiveRender(): boolean {
  return _mode === 'playing' || _mode === 'preview';
}

/** Authoring (save / undo / mutate / prefab-edit) is only safe when fully stopped — never while a
 *  scrub/preview/play mutation is live in the world. */
export function canEdit(): boolean {
  return _mode === 'stopped';
}

/** Inside the editor PREVIEW-SESSION envelope (scrub OR preview): the world is snapshotted and will
 *  revert on Exit, the timeline owns emission, and `+FX` blanket force-play is suppressed. Distinct
 *  from real Play (`playing`), which is not a preview session. (preview-mode-refactor §2.0.) */
export function inPreviewSession(): boolean {
  return _mode === 'scrub' || _mode === 'preview';
}

// ── Legacy PlayState API — derived compat shims (retired in the final phase) ──

export function getPlayState(): PlayState {
  return derivePlayState();
}

/** Legacy setter, mapped onto RunMode: `stopped`→stopped, `paused`→playing(frozen), `playing`→playing. */
export function setPlayState(next: PlayState): void {
  if (next === 'stopped') setRunMode('stopped');
  else if (next === 'paused') setRunMode('playing', { advancing: false });
  else setRunMode('playing', { advancing: true });
}

/** Subscribe to legacy play-state transitions (fires only when the derived PlayState changes). */
export function onPlayStateChange(fn: () => void): () => void {
  _playListeners.add(fn);
  return () => { _playListeners.delete(fn); };
}

/** True only while Playing AND advancing — the sim tier + UI actions run. (Exactly `getPlayState()==='playing'`.) */
export function isSimRunning(): boolean {
  return _mode === 'playing' && _advancing;
}
