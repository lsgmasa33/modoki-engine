import { trait } from 'koota';

/** AudioSource — an entity that emits sound.
 *
 *  `clip` is a GUID resolved via the asset manifest (like every other asset ref).
 *  Non-spatial by default (`THREE`-free 2D UI/SFX/music); flip `spatial` for 3D
 *  positional audio, which attenuates by distance from the AudioListener entity —
 *  position comes from the entity's world Transform, so no extra fields.
 *
 *  Playback is driven by `audioSystem` (presentation tier): `autoplay` starts on
 *  play; `playOnCue` fires a one-shot when a matching cue is raised (`cueSound`) —
 *  the cue bus is a dedicated channel, NOT the verification journal. Buffer-vs-
 *  stream is an ASSET-level `.meta.json` setting (`getAudioLoadType`), not a field
 *  here — the same file shouldn't decode one way for one source and another for a
 *  second.
 *
 *  `clips` is a NAMED CLIP BANK: a **JSON-string** `[{ "key", "ref" }, …]` (Unity's
 *  "an AudioSource + an array of AudioClips indexed by name"). It lets a source own
 *  several playable sounds and lets UI/game actions reference them by a STABLE STRING
 *  KEY instead of a raw GUID — so `audio.setClip { key }` / `audio.playOneShot { key }`
 *  are decoupled from asset identity (re-import a file → its GUID changes in ONE place,
 *  the bank, not in every button). Each `ref` is a real audio GUID: the resource
 *  collector parses this string and collects the refs, so every banked clip ships +
 *  survives an editor save — which the old "GUID buried in UIAction params" approach
 *  did NOT. `clip` stays the currently-loaded/playing GUID the reconcile reads; the
 *  bank is just the key→ref table. A source that only plays one thing skips the bank.
 *
 *  Why a JSON STRING (not an inline `{key,ref}[]` array): a non-scalar trait field is
 *  a known bug source — opaque to serialize / prefab-override diffing / undo, and must
 *  be deep-cloned at every boundary (see `tests/runtime/traitScalarFields.test.ts`).
 *  A JSON-string SCALAR (exactly like `Collider2D.points`) sidesteps that class — it's
 *  copied verbatim everywhere — so this trait stays a plain SoA `trait({…})`. Parse
 *  via `parseClipBank` (guarded → [] on invalid); never `JSON.parse` inline. */
export const AudioSource = trait({
  clip: '',                 // GUID → AudioBuffer / stream URL via the manifest
  bus: 'sfx' as 'master' | 'music' | 'sfx' | 'ui',
  volume: 1 as number,      // 0..1, multiplied into the bus gain
  pitch: 1 as number,       // playbackRate (1 = normal)
  loop: false as boolean,
  autoplay: false as boolean, // play on spawn / scene load (when the game is playing)
  playOnCue: '' as string,  // named cue → fire a one-shot; '' = none
  spatial: false as boolean,  // false → non-positional; true → distance-attenuated panner
  refDistance: 1 as number,   // spatial: distance at which volume is 1
  maxDistance: 50 as number,  // spatial: distance beyond which volume no longer drops
  rolloff: 1 as number,       // spatial: how quickly volume falls with distance
  // Crossfade duration (seconds) when `clip` changes on a playing source: 0 = hard
  // cut (stop old, start new); >0 = fade the old out and the new in over N seconds.
  // Drives the declarative music-player pattern (swap clip → crossfade).
  crossfadeSec: 0 as number,
  // Named clip bank — a JSON-string `[{"key","ref"}]` (key → audio GUID). Referenced
  // by `audio.setClip { key }` / `audio.playOneShot { key }`; parse via parseClipBank.
  // The collector reads the refs out of this string so every banked clip ships.
  clips: '' as string,
  // Runtime playback state (not serialized) — reflects whether the source is
  // currently sounding, for the Inspector + debug tooling.
  playing: false as boolean,
});
