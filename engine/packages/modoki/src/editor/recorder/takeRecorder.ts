/** Record a TAKE from the editor's GameView (#1479) — the owner plays, this writes the script.
 *
 *  `startTakeRecording()` snapshots the starting state, then presses Play itself; every pointer
 *  transition over the game is stamped in sim seconds and kept in the game root's layout pixels.
 *  Stopping (the Record button again, or the owner pressing Stop) writes the take into the project
 *  as `recordings/<game>-<stamp>.take.json`. `npm run record -- <that file>` renders it.
 *
 *  The pure decisions — mapping a client point into layout pixels, coalescing moves, stamping —
 *  live in `TakeBuilder`, which touches no DOM and no world, so they carry unit tests. The wiring
 *  below it is the thin part. */

import {
  TAKE_FORMAT, TAKE_VERSION, isTakeGameEvent, type Take, type TakeAssets, type TakeGameEvent, type TakePointerEvent, type TakePointerKind,
} from './take';
import { getPlayState, onPlayStateChange } from '../../runtime/core/playState';
import { seedRng, pinFreshWorldSeed } from '../../runtime/core/rng';
import { setCaptureMode } from '../../runtime/core/captureMode';
import { takeClockDelta, isNextSceneLoading } from '../../runtime/core/takeClock';
import { TakeJournalTap } from '../../runtime/core/takeJournal';
import { getCurrentWorld } from '../../runtime/core/ecs/worldRegistry';
import { registerFrameCallback, unregisterFrameCallback } from '../../runtime/rendering/frameDriver';
import { PlayerPrefs } from '../../runtime/storage/playerPrefs';
import { prefsKeyPrefix } from '../../runtime/storage/prefsKey';
import { getActiveGameId } from '../../runtime/managers/managerRegistry';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { pressPlay, pressStop, playFeedback } from '../scene/playPressFeedback';
import { useEditorStore } from '../store/editorStore';
import { hasUnsavedChanges } from '../scene/serialize';
import { backendFetch, jsonFileBody, writeAssetFile } from '../backend/editorBackend';
import { notifyListeners } from '../../runtime/core/notifyListeners';

/** A rect as `getBoundingClientRect` reports it (the SCALED, on-screen box). */
export interface ClientRect { left: number; top: number; width: number; height: number }

/** Map a client point into the game root's layout pixels. The GameView scales its device-sized
 *  div with a CSS transform, so the on-screen rect is `layout × scale`: divide the scale back out.
 *  Rounded to 1/100 px — finer than any hit test, and it keeps the file readable. */
export function clientToLayout(
  clientX: number, clientY: number, rect: ClientRect, layoutWidth: number,
): { x: number; y: number } {
  const scale = layoutWidth > 0 && rect.width > 0 ? rect.width / layoutWidth : 1;
  const r = (v: number) => Math.round(v * 100) / 100;
  return { x: r((clientX - rect.left) / scale), y: r((clientY - rect.top) / scale) };
}

/** Accumulates a take's events. Pure: the caller supplies the sim time and the layout point. */
export class TakeBuilder {
  readonly events: TakePointerEvent[] = [];
  private pressed = false;

  /** Add one pointer transition. Returns whether it was kept.
   *
   *  - A `move` while nothing is pressed is hover, and a take is replayed for its gestures, not
   *    its cursor path — dropped, except that the replay moves to each `down` point first anyway.
   *  - Moves are COALESCED per sim instant: the live page can deliver several between two frames,
   *    and only the last one before the next frame is what the game ever sampled.
   *  - A `down` while already pressed, or an `up` with nothing pressed, is a second pointer or a
   *    lost release; the game's own pointer source ignores both, and so does the take. */
  add(kind: TakePointerKind, t: number, x: number, y: number): boolean {
    if (kind === 'move') {
      if (!this.pressed) return false;
      const last = this.events[this.events.length - 1];
      if (last && last.kind === 'move' && last.t === t) { last.x = x; last.y = y; return true; }
    } else if (kind === 'down') {
      if (this.pressed) return false;
      this.pressed = true;
    } else {
      if (!this.pressed) return false;
      this.pressed = false;
    }
    this.events.push({ t, kind, x, y });
    return true;
  }

  /** True while a gesture is open — a take stopped here would leave the replay holding the button. */
  get isPressed(): boolean { return this.pressed; }
}

/** `<game>-YYYYMMDD-HHMMSS`, local time — sorts by when it was played. */
export function takeFileStem(game: string, date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${game}-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Every stored PlayerPrefs entry under `namespace`, raw: logical key → stored string. */
export function snapshotPrefs(storage: Pick<Storage, 'length' | 'key' | 'getItem'>, namespace: string): Record<string, string> {
  const prefix = prefsKeyPrefix(namespace);
  const out: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (!k || !k.startsWith(prefix)) continue;
    const v = storage.getItem(k);
    if (v !== null) out[k.slice(prefix.length)] = v;
  }
  return out;
}

// ── Wiring ──────────────────────────────────────────────────────────────────────────────────────

interface Recording {
  builder: TakeBuilder;
  root: HTMLElement;
  base: Omit<Take, 'duration' | 'events'>;
  /** Play has started — pointer input from here on belongs to the take. */
  started: boolean;
  /** The take clock: `takeClockDelta(sample)` summed after every frame — the same function the replay
   *  driver sums, which is what makes the two clocks one axis (`runtime/core/takeClock.ts` says why
   *  it is summed rather than read from `Time.elapsed`, and why unscaled). */
  takeTime: number;
  /** The game's journal events while the take plays — the replay check's expectation (#1488). The
   *  replay driver drains with the same tap, so both halves collect by one rule. */
  journal: TakeJournalTap;
  expectedEvents: TakeGameEvent[];
  /** The project's asset fingerprint, requested at the Play press and awaited only when the take is
   *  written (#1509) — hashing runs while the owner plays. Null when the backend could not make one. */
  assets: Promise<TakeAssets | null>;
  detach: () => void;
}

/** Take the game events emitted since the last drain, stamped on the take clock. */
function drainTakeJournal(rec: Recording): void {
  for (const e of rec.journal.drain(getCurrentWorld())) {
    if (isTakeGameEvent(e.type)) {
      rec.expectedEvents.push({ t: rec.takeTime, type: e.type, payload: e.payload, ...(e.appLifetime ? { appLifetime: true as const } : {}) });
    }
  }
}

let recording: Recording | null = null;
const listeners = new Set<() => void>();

/** True while a take is being recorded. */
export function isRecordingTake(): boolean { return recording !== null; }

/** The recording take's clock, in seconds — null when nothing is recording. */
export function getRecordingTakeTime(): number | null { return recording ? recording.takeTime : null; }

/** Subscribe to recording start/stop (for the toolbar). */
export function onTakeRecordingChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => notifyListeners(listeners, 'takeRecorder', []);

/** A take that was just written: its absolute path, and the take itself. */
export interface SavedTake { file: string; take: Take }
const savedListeners = new Set<(saved: SavedTake) => void>();

/** Subscribe to takes being saved — by the Record button OR by Stop, which both end here. The
 *  render dialog opens from this (#1488), so neither Stop path can skip it. */
export function onTakeSaved(fn: (saved: SavedTake) => void): () => void {
  savedListeners.add(fn);
  return () => savedListeners.delete(fn);
}

/** The runtime UI root inside the GameView — the one element both the editor preview and the
 *  shipped page lay the game out in. SceneView's copy is marked `"editor"`, so it cannot match. */
function findGameRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-game-view-area] [data-modoki-ui-root="runtime"]');
}

/** Ask the backend to fingerprint the project's assets (#1509). A failure costs the render its
 *  changed-assets check, not the take, so it resolves null rather than refusing to record. */
function requestAssetFingerprint(): Promise<TakeAssets | null> {
  return backendFetch('/api/record/fingerprint', { method: 'POST' })
    .then(async (r) => {
      const body = r.ok ? await r.json() as Partial<TakeAssets> : null;
      if (body && typeof body.dir === 'string' && body.files && typeof body.files === 'object') return body as TakeAssets;
      console.warn('[takeRecorder] no asset fingerprint — the render will not report assets changed since the take', r.status);
      return null;
    })
    .catch((err) => {
      console.warn('[takeRecorder] no asset fingerprint — the render will not report assets changed since the take', err);
      return null;
    });
}

/** True from a ⏺ press until that take is armed or abandoned. `recording` is set only after the
 *  save flush, so without this a double-click in that window started a SECOND take, which was then
 *  refused against the first one's Play — orphaning the first take's listeners, unsaved. */
let starting = false;

/** Snapshot the starting state, press Play, and record until stopped. Resolves with an error
 *  message when it cannot start, or null when it did. */
export async function startTakeRecording(safeArea: Take['safeArea']): Promise<string | null> {
  if (recording || starting) return 'already recording';
  starting = true;
  try { return await armAndPlay(safeArea); } finally { starting = false; }
}

async function armAndPlay(safeArea: Take['safeArea']): Promise<string | null> {
  if (getPlayState() !== 'stopped') return 'stop play first — a take records from the Play press';
  // The replay loads the scene from DISK; Play runs the in-memory one. An unsaved edit would be in
  // the take the owner played and missing from the video.
  if (hasUnsavedChanges()) return 'save the scene first — the replay loads it from disk, so an unsaved edit would not be in the video';
  const game = getActiveGameId();
  if (!game) return 'no game is active';
  const root = findGameRoot();
  if (!root) return 'no game UI root in the Game view';
  const scenePath = sceneManager.getCurrent()?.path;
  if (!scenePath) return 'no scene is open';

  // The save the game will read at Play, exactly as stored — flushed first, so a write still
  // queued in memory is in the snapshot too.
  await PlayerPrefs.flush();
  const prefs = snapshotPrefs(localStorage, PlayerPrefs.namespace());

  const seed = (Math.random() * 0x100000000) >>> 0;
  const builder = new TakeBuilder();
  const rec: Recording = {
    builder, root, started: false, takeTime: 0, detach: () => {},
    journal: new TakeJournalTap(), expectedEvents: [],
    assets: requestAssetFingerprint(),
    base: {
      format: TAKE_FORMAT, version: TAKE_VERSION, game,
      scene: scenePath.split('/').pop()!,
      viewport: { width: root.offsetWidth, height: root.offsetHeight },
      seed, epochMs: Date.now(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: navigator.language,
      safeArea, prefs,
    },
  };

  const onPointer = (e: PointerEvent) => {
    if (!e.isPrimary || !rec.started || getPlayState() === 'stopped') return;
    const kind: TakePointerKind = e.type === 'pointerdown' ? 'down' : e.type === 'pointermove' ? 'move' : 'up';
    const rect = root.getBoundingClientRect();
    const inside = e.clientX >= rect.left && e.clientX <= rect.left + rect.width
      && e.clientY >= rect.top && e.clientY <= rect.top + rect.height;
    // A gesture that starts outside the game is not the game's; one that leaves it keeps going.
    if (kind === 'down' && !inside) return;
    const p = clientToLayout(e.clientX, e.clientY, rect, root.offsetWidth);
    builder.add(kind, rec.takeTime, p.x, p.y);
  };
  window.addEventListener('pointerdown', onPointer, { capture: true });
  window.addEventListener('pointermove', onPointer, { capture: true });
  window.addEventListener('pointerup', onPointer, { capture: true });
  window.addEventListener('pointercancel', onPointer, { capture: true });

  // After the ECS tier, so the delta summed is the one this frame's sim just ran with. 0 while
  // paused, so a pause costs the take nothing. The load sample is taken FIRST, before any callback
  // can start a load — the replay samples at the same point (`core/takeClock.ts` says why).
  let loadInFlightAtStart = false;
  registerFrameCallback('takeRecorderFrameStart', () => { loadInFlightAtStart = isNextSceneLoading(); }, Number.MIN_SAFE_INTEGER);
  registerFrameCallback('takeRecorder', () => {
    if (!rec.started) return;
    rec.takeTime += takeClockDelta(loadInFlightAtStart);
    drainTakeJournal(rec);
  }, 5);

  const offPlay = onPlayStateChange(() => {
    const state = getPlayState();
    if (state === 'playing' && !rec.started) {
      // Synchronous inside setPlayState, before the first play frame: the seed is in place before
      // any system can draw — the same instant the replay seeds at (its first frame with time).
      seedRng(seed);
      // What the scene emitted while it was being edited is not part of the take.
      rec.journal.skipExisting(getCurrentWorld());
      rec.started = true;
    } else if (state === 'stopped' && rec.started) {
      void finishTakeRecording();
    }
  });

  rec.detach = () => {
    window.removeEventListener('pointerdown', onPointer, { capture: true });
    window.removeEventListener('pointermove', onPointer, { capture: true });
    window.removeEventListener('pointerup', onPointer, { capture: true });
    window.removeEventListener('pointercancel', onPointer, { capture: true });
    unregisterFrameCallback('takeRecorderFrameStart');
    unregisterFrameCallback('takeRecorder');
    offPlay();
    pinFreshWorldSeed(null);
    setCaptureMode('off');
  };
  pinFreshWorldSeed(seed);
  // Capture mode while PLAYING the take, not only while rendering it: a game hides its capture
  // chrome in it (Court's banner strip), which changes the layout — so the owner has to play the
  // same layout the renderer will draw, or every recorded position is off by the strip.
  setCaptureMode('recording');
  recording = rec;
  notify();

  // `enterPlay` can decline without throwing (a scene swap in flight, a cancelled Play) — and a
  // recorder left armed after that turns the NEXT ordinary Play into the take, with this press's
  // save, clock and scene. So a Play that did not start disarms everything. ⏺ is a Play press to the
  // human, so it goes through `pressPlay`: a refusal (or a Stop queued behind this Play) reaches
  // the editor toast, not only this return value (#1577). `null` = Play threw, already toasted.
  const abandon = (why: string): string => {
    if (recording === rec) { recording = null; rec.detach(); notify(); }
    return why;
  };
  const outcome = await pressPlay();
  if (outcome === null) return abandon('Play failed to start — nothing was recorded');
  if (!rec.started) {
    // A second ⏺ during startup queued the Stop — the take ended as asked, nothing to say.
    if (outcome.kind === 'stopped-during-startup') return abandon('Stopped before the take began — nothing was recorded');
    // A Play is running (or about to) that this press did not start: ▶'s, which reached 'playing'
    // while this press awaited the save flush — so "did not start" would be false on screen.
    const otherPlay = (outcome.kind === 'refused' && outcome.reason === 'already-starting')
      || outcome.kind === 'already-playing' || outcome.kind === 'resumed';
    const why = otherPlay
      ? 'Not recording — another Play was already starting or running. Stop it, then press ⏺ to record from the start.'
      : 'Play did not start — nothing was recorded';
    // pressPlay already said why when the outcome speaks; a ▶ double-press is silent there, but ⏺
    // ABANDONS the take on it, so the human is owed the reason here (#1577).
    if (playFeedback(outcome) === null) useEditorStore.getState().showToast(why, 'warn');
    return abandon(why);
  }
  return null;
}

/** Stop recording, stop play, and write the take. Resolves with the written path, or null when
 *  there was nothing to write. */
export async function finishTakeRecording(): Promise<string | null> {
  const rec = recording;
  if (!rec) return null;
  recording = null;
  // Before Stop: whatever the game emitted since the last frame belongs to the take, and Stop
  // reverts the world.
  if (rec.started) drainTakeJournal(rec);
  rec.detach();
  notify();
  // `pressStop`, not `stopPlay`: a Stop that skipped its revert, or whose restore threw, reaches the
  // human as a toast instead of an unhandled rejection from GameView's `void` (#1577). A take whose
  // Play has not reached 'playing' yet may still be STARTING (the state reads 'stopped' throughout),
  // so it is stopped too: stopPlay queues behind the startup (#470), or answers 'already-stopped'.
  if (getPlayState() !== 'stopped' || !rec.started) await pressStop();
  if (!rec.started) return null;
  if (rec.builder.events.length === 0 && rec.takeTime === 0) {
    console.info('[takeRecorder] stopped before the first frame — nothing to save');
    return null;
  }
  // Close an open gesture where it is, so the replay does not end holding the button down.
  if (rec.builder.isPressed) {
    const last = rec.builder.events[rec.builder.events.length - 1];
    rec.builder.add('up', Math.max(last.t, rec.takeTime), last.x, last.y);
  }
  const assets = await rec.assets;
  const take: Take = {
    ...rec.base, duration: rec.takeTime, events: rec.builder.events, expectedEvents: rec.expectedEvents, appLifetimeMarks: true,
    ...(assets ? { assets } : {}),
  };
  const identity = await backendFetch('/api/identity').then((r) => r.ok ? r.json() : null).catch(() => null) as { projectRoot?: string } | null;
  if (!identity?.projectRoot) {
    console.error('[takeRecorder] no project root from /api/identity — the take was NOT saved:', take);
    return null;
  }
  const file = `${identity.projectRoot}/recordings/${takeFileStem(take.game, new Date(take.epochMs))}.take.json`;
  const ok = await writeAssetFile(`/@fs${file.startsWith('/') ? '' : '/'}${file}`, jsonFileBody(take));
  if (!ok) {
    console.error(`[takeRecorder] writing ${file} failed — the take was NOT saved:`, take);
    return null;
  }
  console.info(`[takeRecorder] saved ${take.events.length} events, ${take.duration.toFixed(2)}s → ${file}`
    + `\n  render it: npm run record -- ${file}`);
  notifyListeners(savedListeners, 'takeRecorder.saved', [{ file, take }]);
  return file;
}
