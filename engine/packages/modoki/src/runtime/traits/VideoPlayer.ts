import { trait } from 'koota';

/** VideoPlayer — an entity that plays a video clip.
 *
 *  `clip` is a GUID resolved via the asset manifest, like every other asset ref.
 *  Where the picture GOES is decided by the entity's other traits, not by a field
 *  here: a `Renderable3D` gets the frames as a material texture (a screen in the
 *  world), a 2D sprite gets them as its texture, and a fullscreen cutscene is driven
 *  by the UI layer. One trait, several surfaces — mirroring how AudioSource doesn't
 *  care whether it's 2D or 3D.
 *
 *  Playback is driven by `videoSystem` (presentation tier). The clip's SOUND routes
 *  onto the normal audio bus, so a player who muted SFX in settings doesn't still
 *  hear the video.
 *
 *  `timeMode` is the one genuinely opinionated field — see `VideoTimeMode`:
 *  `diegetic` (default) means the video lives IN the world, so slow-mo slows it;
 *  `presentation` means it IS the presentation layer (a cutscene), which a time-stop
 *  still pauses but slow-mo does not drag. Both freeze at `timeScale` 0.
 *
 *  NOTE on determinism: video runs on the browser's media clock and CANNOT be
 *  stepped by a fixed dt (assigning currentTime is a keyframe-decoding seek). It is
 *  quarantined from the verification harness exactly as audio is. Anything a game's
 *  LOGIC depends on must not be derived from video playback position. */
export const VideoPlayer = trait({
  clip: '',                   // GUID → resolved variant URL via the manifest
  loop: false as boolean,
  autoplay: false as boolean, // play on spawn / scene load (when the game is playing)
  muted: false as boolean,    // a muted clip is exempt from the autoplay gesture rule
  volume: 1 as number,        // 0..1, multiplied into the bus gain
  // Seconds of audio fade at the END of a non-looping clip. 0 (default) = a hard cut.
  // A ramp on the ELEMENT's own clock, not a tween on `volume`: the authored value is
  // the target the fade descends FROM, so it stays readable in the Inspector and a
  // seek backwards restores it instead of leaving the clip permanently silenced.
  fadeOutSec: 0 as number,
  bus: 'sfx' as 'master' | 'music' | 'sfx' | 'ui',
  // How playback rate follows the engine timeScale. See the trait doc above.
  timeMode: 'diegetic' as 'diegetic' | 'presentation',
  // Base playback rate BEFORE timeScale is folded in (1 = normal).
  rate: 1 as number,
  // Runtime playback state (not authored) — reflects whether the clip is currently
  // running, for the Inspector + debug tooling. Mirrors AudioSource.playing.
  playing: false as boolean,
  // Download progress 0..1 for a `policy: 'download'` clip — 1 once playable (and for
  // bundled/streamed clips, which never download). Bind a progress bar to this.
  loadProgress: 0 as number,
});
