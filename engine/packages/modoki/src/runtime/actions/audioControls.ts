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
import { registerUIAction } from '../core/actionRegistry';
import { addStoreHook } from '../ui/storeHooks';
import { markUIDirty } from '../ui/uiTreeStore';
import { AudioSource } from '../traits/AudioSource';
import { stopEntityAudio } from '../audio/audioSystem';
import { setBusVolume, BUS_NAMES, type BusName } from '../audio/audioService';
import { cueClip, cueSound } from '../audio/audioCues';
import { setUIClickCue } from '../ui/bindings';
import { clipRefForKey } from '../audio/clipBank';

interface AudioMixState {
  audioMaster: number; audioMusic: number; audioSfx: number; audioUi: number;
  audioMasterPct: string; audioMusicPct: string; audioSfxPct: string; audioUiPct: string;
  setBusPct: (bus: BusName, pct: number) => void;
}

const pctStr = (v: number) => `${Math.round(v)}%`;

/** Each bus's two store fields. A TABLE, not `audio${Cap(bus)}` string surgery (#1074): that
 *  derived a key from whatever string arrived, so a typo'd bus wrote fields nothing reads and `''`
 *  threw on `''[0].toUpperCase()`. Keyed by `BusName`, so a bus added to `BUS_NAMES` fails to
 *  compile here until it has fields — and a write can only ever name one of the eight
 *  `useAudioMixSelector` publishes. */
const MIX_FIELDS: Record<BusName, readonly [
  value: 'audioMaster' | 'audioMusic' | 'audioSfx' | 'audioUi',
  pct: 'audioMasterPct' | 'audioMusicPct' | 'audioSfxPct' | 'audioUiPct',
]> = {
  master: ['audioMaster', 'audioMasterPct'],
  music: ['audioMusic', 'audioMusicPct'],
  sfx: ['audioSfx', 'audioSfxPct'],
  ui: ['audioUi', 'audioUiPct'],
};

export const useAudioMixStore = create<AudioMixState>((set) => ({
  audioMaster: 100, audioMusic: 100, audioSfx: 100, audioUi: 100,
  audioMasterPct: '100%', audioMusicPct: '100%', audioSfxPct: '100%', audioUiPct: '100%',
  setBusPct: (bus, v) => {
    const [value, pct] = MIX_FIELDS[bus];
    set({ [value]: v, [pct]: pctStr(v) } as Partial<AudioMixState>);
  },
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
  // Strip undefined-valued keys: koota's setter tests `'key' in value`, not whether it's
  // defined, so an explicit undefined here would overwrite the real value.
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  target.set(AudioSource, { ...a, ...defined });
  // The write bypasses the trait-mutation dirty path, so nudge the UI projection
  // to re-resolve highlight bindings watching AudioSource (e.g. the crossfade
  // toggle's on/off color) + the Inspector's live `playing` readout this frame.
  markUIDirty();
}

const numArg = (raw: unknown): number | null => {
  const v = typeof raw === 'number' ? raw : parseFloat(String(raw));
  return Number.isFinite(v) ? v : null;
};

/** A string param where `''` means UNSET — the reading `resolveClip` already gives `key`. A bare
 *  `params.x ?? fallback` cannot express it: `''` is not nullish, so the fallback never runs
 *  (#1074; the empty-string form of `docs/format-versioning.md` § 4b-ter's `??` row). */
const unsetIfEmpty = (raw: unknown): string | undefined =>
  raw == null || raw === '' ? undefined : String(raw);

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

  // The built-in button click. Registered from THIS side because `runtime/ui/` may not import
  // `runtime/audio/` — see `setUIClickCue`. A game opts in by authoring one `AudioSource` with
  // `playOnCue: 'ui.click'`; a game that authors none hears nothing, so the cost to a silent game
  // is one queue push per click and no more.
  setUIClickCue(() => cueSound('ui.click'));

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
      bus: { type: 'enum', options: [...BUS_NAMES], tooltip: 'Mixer bus to set.' },
      value: { type: 'number', min: 0, max: 100, tooltip: '0..100 (from a slider). $value binds the slider value.' },
    },
    handler: ({ params, payload }) => {
      const bus = unsetIfEmpty(params?.bus) ?? 'master';
      const v = numArg(params?.value ?? payload);
      if (v == null) return;
      const clamped = Math.max(0, Math.min(100, v));
      // ⚠️ The SERVICE decides, and the store follows (#1074). This used to write the store first,
      // so a bus `setBusVolume` refused still left fields in the store — and `''` threw inside the
      // store's key builder before the service was ever asked. The cast is safe only because the
      // refusal comes next; `bus` is a document string here, not the enum the picker suggests.
      if (!setBusVolume(bus as BusName, clamped / 100)) return;
      useAudioMixStore.getState().setBusPct(bus as BusName, clamped);
    },
  });
  registerUIAction('audio.playOneShot', {
    params: {
      key: { type: 'string', tooltip: "Bank key on the target AudioSource.clips (preferred). Falls back to `clip` if empty." },
      clip: { type: 'string', accept: ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac'], tooltip: 'Literal clip GUID (bank-less shorthand).' },
      bus: { type: 'enum', options: [...BUS_NAMES], tooltip: "Bus to play on (default: the target's bus, else sfx)." },
    },
    handler: ({ target, params, payload }) => {
      const clip = resolveClip(target, params, payload);
      if (!clip) return;
      // `unsetIfEmpty`, not a bare `??` (#1074): `''` is not nullish, so it skipped the target's bus
      // and reached `resolveBus('')`, which warned and played it on sfx. An unknown NON-empty bus
      // still goes to `resolveBus`, which falls back with a warning — deliberately, see its comment.
      const bus = (unsetIfEmpty(params?.bus) ?? target?.get(AudioSource)?.bus ?? 'sfx') as BusName;
      cueClip(clip, { bus });
    },
  });
}
