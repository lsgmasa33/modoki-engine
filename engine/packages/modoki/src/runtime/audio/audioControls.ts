/** Built-in audio control layer — engine-wide UI actions + a mixer store hook, so
 *  games control audio DECLARATIVELY (buttons/sliders bound to `audio.*` actions +
 *  AudioSource trait edits) instead of hand-driving the service in their setup.ts.
 *
 *  Registered once app-wide (`registerAudioControls`, wired from app/ecs/register.ts),
 *  alongside `registerEngineActions`. App-tier, event-driven — no per-frame tick, no
 *  wall-clock/random — so it never enters the deterministic headless pipeline.
 *
 *  Actions (target an AudioSource entity via the binding's `target` GUID):
 *   - `audio.play` / `audio.pause` / `audio.toggle` — flip AudioSource.playing.
 *   - `audio.stop`            — hard-stop (tears the handle down, resets to start).
 *   - `audio.setClip`         — swap the clip by bank `key` (or literal GUID);
 *                               crossfades if crossfadeSec > 0, then plays.
 *   - `audio.toggleCrossfade` — flip crossfadeSec between 0 and `seconds` (default 1.5).
 *   - `audio.setBusVolume`    — set a mixer bus from a slider (0..100 → 0..1).
 *   - `audio.playOneShot`     — fire a one-shot by bank `key` (or literal GUID) on a bus.
 *
 *  The mixer store hook exposes bus volumes as `storeState` fields so a slider's
 *  `inputBinding` (which reads storeState ONLY, not read-sources) resolves them
 *  with no per-game store: `audioMaster`/`audioMusic`/`audioSfx`/`audioUi` (0..100)
 *  and `…Pct` label strings ("100%"). */

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { Entity, ExtractSchema, TraitValue } from 'koota';
import { registerUIAction } from '../ui/actionRegistry';
import { addStoreHook } from '../ui/storeHooks';
import { markUIDirty } from '../ui/uiTreeStore';
import { AudioSource } from '../traits/AudioSource';
import { stopEntityAudio } from '../systems/audioSystem';
import { setBusVolume, type BusName } from './audioService';
import { cueClip } from './audioCues';
import { clipRefForKey } from './clipBank';

type MixBus = 'master' | 'music' | 'sfx' | 'ui';

interface AudioMixState {
  audioMaster: number; audioMusic: number; audioSfx: number; audioUi: number;
  audioMasterPct: string; audioMusicPct: string; audioSfxPct: string; audioUiPct: string;
  setBusPct: (bus: MixBus, pct: number) => void;
}

const pctStr = (v: number) => `${Math.round(v)}%`;
const capKey = (bus: MixBus) => `audio${bus[0].toUpperCase()}${bus.slice(1)}`; // master → audioMaster

export const useAudioMixStore = create<AudioMixState>((set) => ({
  audioMaster: 100, audioMusic: 100, audioSfx: 100, audioUi: 100,
  audioMasterPct: '100%', audioMusicPct: '100%', audioSfxPct: '100%', audioUiPct: '100%',
  setBusPct: (bus, v) => set({ [capKey(bus)]: v, [`${capKey(bus)}Pct`]: pctStr(v) } as Partial<AudioMixState>),
}));

// Stable Zustand selector — useShallow keeps the object referentially equal so the
// UI storeState only changes when a bus volume / label actually changes.
const useAudioMixSelector = () => useAudioMixStore(
  useShallow((s) => ({
    audioMaster: s.audioMaster, audioMusic: s.audioMusic, audioSfx: s.audioSfx, audioUi: s.audioUi,
    audioMasterPct: s.audioMasterPct, audioMusicPct: s.audioMusicPct, audioSfxPct: s.audioSfxPct, audioUiPct: s.audioUiPct,
  })),
);

/** Merge a partial AudioSource change onto the target entity (koota set takes the
 *  full trait object — spread the current data, mirror `engine.toggleAnimator`). */
type AudioSourceData = TraitValue<ExtractSchema<typeof AudioSource>>;

function patchSource(target: Entity | undefined, patch: Partial<AudioSourceData>): void {
  const a = target?.get(AudioSource);
  if (!a || !target) return;
  target.set(AudioSource, { ...a, ...patch });
  // The write bypasses the trait-mutation dirty path, so nudge the UI projection
  // to re-resolve highlight bindings watching AudioSource (e.g. the crossfade
  // toggle's on/off color) + the Inspector's live `playing` readout this frame.
  markUIDirty();
}

const numArg = (raw: unknown): number | null => {
  const v = typeof raw === 'number' ? raw : parseFloat(String(raw));
  return Number.isFinite(v) ? v : null;
};

/** The clip a `setClip`/`playOneShot` should act on: a `key` looked up in the
 *  target's bank (`AudioSource.clips`, a JSON-string) takes precedence; else a
 *  literal `clip` GUID (param or payload) for the bank-less shorthand. */
function resolveClip(target: Entity | undefined, params: Record<string, unknown> | undefined, payload: unknown): string {
  const key = params?.key != null ? String(params.key) : '';
  if (key) return clipRefForKey(target?.get(AudioSource)?.clips, key);
  return String(params?.clip ?? payload ?? '');
}

let registered = false;

/** Register the built-in audio actions + the mixer store hook. Idempotent. */
export function registerAudioControls(): void {
  if (registered) return;
  registered = true;

  addStoreHook(useAudioMixSelector);

  registerUIAction('audio.play', ({ target }) => patchSource(target, { playing: true }));
  registerUIAction('audio.pause', ({ target }) => patchSource(target, { playing: false }));
  registerUIAction('audio.toggle', ({ target }) => {
    const a = target?.get(AudioSource);
    if (a) patchSource(target, { playing: !a.playing });
  });
  registerUIAction('audio.stop', ({ target, world }) => {
    if (target) stopEntityAudio(world, target);
    patchSource(target, { playing: false });
  });
  registerUIAction('audio.setClip', {
    params: {
      key: { type: 'string', tooltip: "Bank key on the target AudioSource.clips (preferred). Falls back to `clip` if empty." },
      clip: { type: 'string', accept: ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac'], tooltip: 'Literal clip GUID (bank-less shorthand).' },
    },
    handler: ({ target, params, payload }) => {
      const clip = resolveClip(target, params, payload);
      if (clip) patchSource(target, { clip, playing: true });
    },
  });
  registerUIAction('audio.toggleCrossfade', {
    params: { seconds: { type: 'number', min: 0, step: 0.1, tooltip: 'Crossfade duration when ON (default 1.5s).' } },
    handler: ({ target, params }) => {
      const a = target?.get(AudioSource);
      if (!a) return;
      const sec = numArg(params?.seconds) ?? 1.5;
      patchSource(target, { crossfadeSec: a.crossfadeSec > 0 ? 0 : sec });
    },
  });
  registerUIAction('audio.setBusVolume', {
    params: {
      bus: { type: 'enum', options: ['master', 'music', 'sfx', 'ui'], tooltip: 'Mixer bus to set.' },
      value: { type: 'number', min: 0, max: 100, tooltip: '0..100 (from a slider). $value binds the slider value.' },
    },
    handler: ({ params, payload }) => {
      const bus = (params?.bus as MixBus) ?? 'master';
      const v = numArg(params?.value ?? payload);
      if (v == null) return;
      const clamped = Math.max(0, Math.min(100, v));
      useAudioMixStore.getState().setBusPct(bus, clamped);
      setBusVolume(bus as BusName, clamped / 100);
    },
  });
  registerUIAction('audio.playOneShot', {
    params: {
      key: { type: 'string', tooltip: "Bank key on the target AudioSource.clips (preferred). Falls back to `clip` if empty." },
      clip: { type: 'string', accept: ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac'], tooltip: 'Literal clip GUID (bank-less shorthand).' },
      bus: { type: 'enum', options: ['master', 'music', 'sfx', 'ui'], tooltip: "Bus to play on (default: the target's bus, else sfx)." },
    },
    handler: ({ target, params, payload }) => {
      const clip = resolveClip(target, params, payload);
      if (!clip) return;
      const bus = (params?.bus as BusName) ?? (target?.get(AudioSource)?.bus as BusName) ?? 'sfx';
      cueClip(clip, { bus });
    },
  });
}
