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
  TAKE_FORMAT, TAKE_VERSION, type Take, type TakePointerEvent, type TakePointerKind,
} from './take';
import { getPlayState, onPlayStateChange } from '../../runtime/core/playState';
import { seedRng, pinFreshWorldSeed } from '../../runtime/core/rng';
import { setCaptureMode } from '../../runtime/core/captureMode';
import { takeClockDelta } from '../../runtime/core/takeClock';
import { registerFrameCallback, unregisterFrameCallback } from '../../runtime/rendering/frameDriver';
import { PlayerPrefs } from '../../runtime/storage/playerPrefs';
import { prefsKeyPrefix } from '../../runtime/storage/prefsKey';
import { getActiveGameId } from '../../runtime/managers/managerRegistry';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { enterPlay, stopPlay } from '../scene/playMode';
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
  /** The take clock: `takeClockDelta()` summed after every frame — the same function the replay
   *  driver sums, which is what makes the two clocks one axis (`runtime/core/takeClock.ts` says why
   *  it is summed rather than read from `Time.elapsed`, and why unscaled). */
  takeTime: number;
  detach: () => void;
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

/** The runtime UI root inside the GameView — the one element both the editor preview and the
 *  shipped page lay the game out in. SceneView's copy is marked `"editor"`, so it cannot match. */
function findGameRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-game-view-area] [data-modoki-ui-root="runtime"]');
}

/** Snapshot the starting state, press Play, and record until stopped. Resolves with an error
 *  message when it cannot start, or null when it did. */
export async function startTakeRecording(safeArea: Take['safeArea']): Promise<string | null> {
  if (recording) return 'already recording';
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
  // paused, so a pause costs the take nothing.
  registerFrameCallback('takeRecorder', () => {
    if (rec.started) rec.takeTime += takeClockDelta();
  }, 5);

  const offPlay = onPlayStateChange(() => {
    const state = getPlayState();
    if (state === 'playing' && !rec.started) {
      // Synchronous inside setPlayState, before the first play frame: the seed is in place before
      // any system can draw — the same instant the replay seeds at (its first frame with time).
      seedRng(seed);
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
  // save, clock and scene. So a Play that did not start disarms everything.
  const abandon = (why: string): string => {
    if (recording === rec) { recording = null; rec.detach(); notify(); }
    return why;
  };
  try {
    await enterPlay();
  } catch (err) {
    return abandon(`Play failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!rec.started) return abandon('Play did not start — nothing was recorded');
  return null;
}

/** Stop recording, stop play, and write the take. Resolves with the written path, or null when
 *  there was nothing to write. */
export async function finishTakeRecording(): Promise<string | null> {
  const rec = recording;
  if (!rec) return null;
  recording = null;
  rec.detach();
  notify();
  if (getPlayState() !== 'stopped') await stopPlay();
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
  const take: Take = { ...rec.base, duration: rec.takeTime, events: rec.builder.events };
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
  return file;
}
