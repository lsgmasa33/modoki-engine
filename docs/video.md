# Video playback

Play an H.264/mp4 clip on a 3D surface, a 2D sprite, inside a UI element, or as a fullscreen
cutscene — shipped inside the game or streamed/downloaded from the web with the downloaded
footprint actively managed.

## What it is

A video is a first-class **asset kind**, not a URL a game passes at play time. It gets a GUID and a
`.meta.json` sidecar exactly like a texture, so it is manifest-visible, tree-shakeable,
editor-previewable, and reportable ("this game will download 84 MB"). The alternative — game code
handing a URL to a player at runtime — was rejected because then the editor could never tell you
what a game downloads.

One trait drives it. A `VideoPlayer` entity owns a clip; **where the picture goes is decided by the
entity's other traits**, not by a field on `VideoPlayer`:

| The entity also has… | …and the clip renders as |
|---|---|
| `Renderable3D` / `Renderable3DPrimitive` | a `THREE.VideoTexture` on the material's `map` — a screen in the world |
| `Renderable2D` with `sprite` = the video GUID | the texture of a PixiJS sprite |
| `RenderableUI` / `UIElement` | the element mounted **inside that UI node's box** (`UIVideoMount`), cropped by `imageMode` |
| `timeMode: 'presentation'` **and no surface trait of its own** | a fullscreen DOM overlay above the game (`VideoOverlay`) |

The UI row is what makes video usable as **scenery** — a full-bleed animated backdrop *behind*
the game, laid out and stacked by the UI tree like any other node — as opposed to the cutscene
overlay, which covers everything and swallows input. A UI entity is therefore skipped by
`VideoOverlay` even at `timeMode: 'presentation'`: it already has a surface, and claiming it
twice would adopt the one shared element away from its own box.

An `imageSrc` authored on the same UI element acts as the **poster**: video only runs while the
game is Playing, so the still is what shows in a stopped editor, before the first frame decodes,
and if the clip fails to load. Author a frame *from the clip* and the transition is invisible.

⚠️ **The UI node must be a plain `div`.** `UIElement.elementType` of `input` or `range` renders a
VOID element, which cannot carry the video layer — so the clip decodes, its audio plays on the bus,
and no picture ever appears. `UINode` dev-warns on that combination (the same class as the
`Canvas2D`-plus-`elementType` warning beside it); put the `VideoPlayer` on its own child entity.

All of them wrap the **same `HTMLVideoElement`** — one decoder, one audio path, one set of playback
state. Two viewports showing the same clip get two GPU textures over that one decoder, which is
what the per-surface binding tables exist to make possible.

⚠️ **On the TEXTURE surfaces the live `<video>` element is never attached to the DOM.**
`videoService.ts`'s `playVideo` does `document.createElement('video')`, and for a 3D screen or a
2D sprite nothing ever `appendChild`s it — those surfaces only COPY frames off a detached element.
So `document.querySelector('video')` finds nothing for them however healthy playback is, and the one
reach-in is `videoElementFor(entityId)` (`runtime/video/videoSystem.ts`).

**The two DOM surfaces are the exception, and they adopt that same element rather than making
their own**: `UIVideoMount.tsx`'s `UIVideoMount` and `VideoOverlay.tsx`'s `VideoOverlay` both
`host.appendChild(el)`. So while a UI-mounted or fullscreen-overlay player is active,
`querySelector('video')` DOES find it. Decide
which surface you are debugging before concluding the element is missing.

⚠️ **The DOM surfaces are the exception: they cannot be duplicated.** A texture surface COPIES
frames off the element, so any number of viewports can show the clip; a DOM `<video>` IS the
element, and a DOM node exists in exactly one place. So with the editor's Game and Scene panels
both open, only ONE of them shows a UI-mounted clip. `UIVideoMount` decides which by an explicit
`priority` — the running game wins, the editor's authoring viewport gets the poster still —
because before that rule the last host to tick won by accident, which surfaced as "the video
plays only on Scene view, not on the game view". A shipped game has one UI host, so this is an
editor-only compromise; showing it in both would mean either a second decoder (rejected — see
above) or mirroring frames into a per-host `<canvas>`, which nothing has asked for yet.

**Codec is deliberately limited to H.264/mp4.** It is the only format the iOS WKWebView plays;
VP9/WebM does not. Shipping one format is a constraint accepted on purpose, not a gap — which is
why `VideoImportSettings` has no format knob.

## Key files

| File | Role |
|---|---|
| `runtime/traits/VideoPlayer.ts` | The trait: clip, loop, autoplay, muted, volume, `fadeOutSec`, bus, `timeMode`, rate, playing, loadProgress |
| `runtime/video/videoService.ts` | Element lifetime, bus routing, autoplay retry, `timeScale` coupling |
| `runtime/video/videoSystem.ts` | Declarative reconcile — trait state → live elements; download orchestration |
| `runtime/video/videoCache{,Policy}.ts` | LRU cache against a budget; `videoCachePolicy` is the pure admission/eviction planner |
| `runtime/video/VideoOverlay.tsx` | Fullscreen cutscene layer — **adopts** the element, never creates one |
| `runtime/video/UIVideoMount.tsx` | UI binding — the element mounted into a UI node's box, with the host-priority rule |
| `runtime/video/VideoEvents.ts` | `@video.start` / `@video.end` / `@video.skip` on the journal + an event bus, plus `@video.blocked` (journal-only, #447) |
| `runtime/rendering/videoTextureSync.ts` | 3D binding — `THREE.VideoTexture` onto a material, per `RenderState` |
| `runtime/rendering/videoTextureSync2D.ts` | 2D binding — a Pixi `VideoSource` texture onto a Sprite, per renderer |
| `runtime/actions/videoControls.ts` | Declarative `video.play/pause/toggle/stop/skip/seek/setClip` |
| `runtime/loaders/videoSettings.ts` | Import settings + delivery-policy resolution — the single source of truth |
| `plugins/video-convert.ts` · `video-cache.ts` · `reimport-video.ts` | ffmpeg transcode, content cache, re-import |
| `editor/panels/assetViews/VideoAssetView.tsx` · `videoAssetLogic.ts` | The Inspector for a video asset — settings form, preview, Re-import |

## Authoring

Drop an `.mp4` (or `.mov`/`.m4v`/`.webm`/`.mkv` — all transcode to H.264/mp4) into a project's
assets. Import mints a GUID and writes a `.meta.json` sidecar.

**Select the clip in the Assets panel to edit all of this in the Inspector** — delivery,
policy, remote URL, CRF, preset, max dimensions, frame-rate cap, keyframe interval and audio,
with a preview of the *converted* clip, a plain-English line saying what will happen at play
time (`auto` already resolved against the measured size), and a **Re-import** button that runs
the ffmpeg convert. Every control writes the sidecar immediately; only the encode waits for
Re-import. The sidecar is documented below because it is what the settings *are* — not
because hand-editing is the expected route:

```jsonc
{
  "id": "7265857a-…",
  "video": {
    "delivery": "bundled",      // or "remote" — ships on a CDN instead of in the build
    "policy": "auto",           // "stream" | "download" | "auto" (remote only)
    "quality": 23,              // CRF
    "preset": "veryfast",
    "resizeMode": "bounds",     // or "percent" — see below
    "maxWidth": 1920, "maxHeight": 1080,   // resizeMode: "bounds"
    "scalePercent": 100,        // resizeMode: "percent" — 10..100, no upscale
    "maxFps": 0,
    "keyframeIntervalSec": 2,
    "audio": "keep",            // or "strip"
    "audioBitrate": 128,
    "remoteUrl": "https://…"    // delivery: "remote" only
  }
}
```

### Output size is a MODE, not two knobs

`resizeMode` picks which sizing control is in force, and the other is ignored entirely:

- **`bounds`** (default) — *"no bigger than W×H"*. `maxWidth`/`maxHeight` bound the output;
  aspect is preserved and a smaller source is **never upscaled**. Reach for it when a
  hardware or texture budget is the real constraint.
- **`percent`** — *"half the source"*. `scalePercent` scales both axes together, so aspect is
  preserved by construction. Reach for it when the source resolution is the thing you are
  reasoning about. There is no percentage above 100: enlarging spends bytes on detail that is
  not in the source.

  `scalePercent` is **clamped to 10–100** by `resolveScalePercent`, which both the ffmpeg
  filter and the cache key read so they cannot disagree. The clamp earns its place on the low
  end specifically: `0` means *"keep the source"* for `maxWidth`, `maxHeight` and `maxFps`, so
  it is an inviting thing to hand-author here — where it would instead mean a zero-pixel
  encode and fail with an ffmpeg error that never mentions percentages.

They are a mode rather than composable because a percentage *and* a pixel bound applied
together give a size that is neither the one you asked for nor obviously wrong — and the
result does not tell you which of the two won.

**Both paths round down to even dimensions**, because H.264 with `yuv420p` rejects an odd
width or height and the encode aborts outright. In percent mode this is folded into the same
expression (`trunc(iw*p/200)*2`), so even `100%` emits a scale filter — that is deliberate,
and it is what lets an odd-dimensioned source import at all.

**A `bounds` clip's cache key is byte-identical to its pre-`resizeMode` form**, so adding
percentage scaling did not re-encode a single existing clip. Anything touching
`stableSettings` in `video-cache.ts` must preserve that.

Then put a `VideoPlayer` on an entity and set `clip` to the GUID.

**A 2D sprite showing video** sets `Renderable2D.sprite` to the *video* GUID. That is a legal value
there alongside texture GUIDs and primitive keywords; the sprite slot is built as an empty shell and
`videoTextureSync2D` supplies the texture.

## Time and determinism

`play()`, `pause()`, `currentTime` and `playbackRate` are all available, so a game has plenty of
control — *"the player pressed Play Level, now play the cutscene"* is fully supported. What is **not**
possible is advancing a video by an exact `dt` per frame: assigning `currentTime` is a **seek**, which
on H.264 decodes from the nearest keyframe and resolves asynchronously.

So **video cannot participate in `stepSimulation`** and is quarantined from the verification harness
exactly as audio is, for exactly the same reason — it runs on the browser's media clock, not ours.
Anything a game's *logic* depends on must not be derived from video playback position. This is
identical for 3D, 2D and UI, because all three wrap the same element: the surface differs, the clock
does not.

### `timeMode` — the one opinionated field

| Mode | `timeScale` 0 | `timeScale` 0.3 |
|---|---|---|
| `diegetic` (default) — a screen inside the world | paused | `playbackRate` 0.3 |
| `presentation` — a cutscene | paused | `playbackRate` 1 (exempt) |

Both freeze at a time-stop, because a time-stop should stop everything. Only slow-mo distinguishes
them: dragging a screen in the world to 0.3× is right, and dragging cutscene dialogue to 0.3× is
almost certainly not. `timeMode` is itself live (below) — flipping it on a running clip reapplies
the effective rate immediately, it does not wait for the clip's next play.

### Which `VideoPlayer` fields are live

Most fields are live-applied every reconcile pass, the moment the trait changes: `playing`,
`muted`, `volume`, `rate`, `fadeOutSec`, `loop` and `timeMode` all reach the element (or its
computed rate) on the same frame the Inspector or a game writes them (#433 fixed `loop` and
`timeMode`, which were create-time-only until then).

`bus` is the one exception, and stays create-time only: the audio route is wired once, when the
handle is created (`attachMediaElementToBus` in `videoService.ts`), so changing `bus` on an
already-playing clip does nothing until this entity's handle is next RECREATED — a `clip` change,
the entity despawning, leaving Play, or a scene swap. `video.stop` does **not** recreate the
handle (it is a seek-to-0 + pause, `actions/videoControls.ts`), so stopping and replaying the same
clip keeps the old `bus`. `clip` itself always takes effect, because changing it recreates the
handle outright.

### Ending a clip: the last frame, and `fadeOutSec`

A non-looping clip **holds its last frame**. Nothing extra is needed for that — the element ends,
`onEnded` pauses the handle, and `playing` flips false in the trait; the picture simply stays.
Only a teardown (Stop, scene swap, clearing `clip`) removes it. So "play it once, then leave the
final frame up" is the default behaviour, not a feature to switch on.

`fadeOutSec` ramps the audio to silence over the last N seconds so the clip does not stop with a
click. It is a **multiplier** computed from the element's own clock, never a tween written back
into `volume`: the authored value stays readable in the Inspector as the level the ramp descends
from, and a replay or a backwards seek gets its volume back instead of staying silent forever.
The curve is linear in amplitude (`videoFadeGain`, pure and unit-tested) — an equal-power curve
holds near full volume for most of the ramp, which is the opposite of what a fade is asked for.

⚠️ **Audible autoplay is blocked until the player interacts.** An `autoplay` clip with sound does
not start on its own in a browser; `videoService` records the rejection and retries on the first
gesture (sharing the audio subsystem's unlock signal), so the clip shows its first frame until
then. A clip that must move immediately has to be `muted: true` — which also makes `fadeOutSec`
moot. This is browser policy, not an engine choice. **Exception: a gesture that arrives during a
time-stop is refused too** (#545) — starting a blocked clip's audio under a pause menu would be
wrong regardless of the gesture — so the retry is deferred to the next `timeScale` transition
instead. **`@video.start` announces nothing while blocked** — see "`@video.start` means observed
playback, not a request" below for what the event does and when it fires once the gesture arrives.

## Remote delivery

A `delivery: "remote"` clip lives on a CDN and never enters the build. `policy` decides what happens
at play time:

- **`stream`** — point the element at the URL. Nothing is stored.
- **`download`** — fetch into the cache, then play from a local `blob:` URL. Survives offline.
- **`auto`** — download below `AUTO_DOWNLOAD_MAX_BYTES` (8 MB), stream above it.

`VideoPlayer.loadProgress` (0..1) is bindable to a progress bar.

The cache is LRU against a byte budget, with pinning. Admission **refuses** rather than evicting
everything to fit one oversized clip, and it refuses *before* downloading where `content-length`
allows — then re-plans against the real size, because a server that under-declares its length would
otherwise make the budget advisory. Backends are swappable behind a `CacheBackend` interface; the
web backend is the Cache API (already excluded from iCloud backup on iOS, which is an App Store
review requirement).

**The index and the backend must never disagree, so every removal deletes from the backend FIRST
and drops the index entry only once that succeeds** (#429). `delete(key)` always had that ordering;
`clear()` did not — it deleted in an unguarded loop and only then called `index.clear()`, so one
rejected delete (an I/O error, or the Cache API evicting an entry mid-iteration) abandoned the
bookkeeping entirely: the keys already deleted stayed in the index, and `saveIndex()` never ran, so
the persisted index kept them too. `clear()` now drops each entry as its delete succeeds, keeps
going past a failure (one unevictable key must not strand the whole cache), persists the index in a
`finally`, and rethrows at the end naming the keys that survived — an incomplete clear the caller
never hears about is how the index starts lying. The rethrown error also carries the first
underlying failure as `cause`, and caps the inlined key list at 5 (`(+N more)`) so a large cache
with a broken storage layer doesn't produce a message as long as the cache itself.

**The same defect existed in two more places — `get()` and `doFetch`'s eviction loop — found on
adversarial re-review of the #429 fix.** `get()` drops a ghost index entry (`urlFor` returning
undefined for a key the index still lists) without persisting the drop, so the ghost survives in
storage and reappears on the next `loadIndex()`. And `doFetch`'s eviction loop — the method
`setVideoDownloader` actually wires — deletes each eviction victim from the backend and the
in-memory index per-key-safely, but a rejection partway through the loop used to propagate before
`saveIndex()` ever ran: the victims already deleted were gone from the backend AND the in-memory
index, while the *persisted* index still claimed them. Reloading resurrects those ghosts,
`usedBytes()` over-reports what's actually on disk, and `planAdmission` refuses a download that
would genuinely fit. Both are now the same shape as `clear()`'s fix: persist whatever was actually
freed before the failure propagates. `doFetch` still aborts the fetch on an eviction failure — it
genuinely cannot proceed if it couldn't free the space — only the bookkeeping changed.
`pipeline.ts`'s `void videoCache.reconcile()` runs fire-and-forget on boot, so this self-heals,
but there's a real window where an admission decision can see the inflated index before the
repair lands.

⚠️ **Nothing calls `clear()` today** — no caller in `engine/`, `games/` or `demos/`, and
`ActiveVideoCache` (`videoCacheSlot.ts`) does not expose it, so `modoki_diagnose` cannot reach it
either. The cache is managed entirely by LRU eviction against the budget. So `clear()` itself is
public API hardened ahead of a caller; if a "clear downloaded videos" affordance is ever wanted (a
settings screen, an agent op), the ordering it needs is already right.

**The lesson worth keeping is the ranking, not the fix.** #429 was filed against `clear()`, so the
first pass fixed `clear()` — the one method in the file with *zero* callers — and walked straight
past the identical defect in `doFetch`, the one method production actually drives. Only the
adversarial re-review caught that. When a bug report names a method, the pattern is the finding and
the named method is just where someone happened to notice it: sweep the file before believing the
report scoped the work.

**CORS is load-bearing, not a nicety.** A clip that becomes a GPU texture needs
`crossOrigin='anonymous'`, so the host must send `Access-Control-Allow-Origin` **on the final
response**. Measured, because this is easy to get wrong:

| Host | Ranges | CORS | Usable |
|---|---|---|---|
| GitHub Releases | yes | **no** | no |
| archive.org | yes | on the **302** only, not the storage node | no |
| jsDelivr | yes (206) | `*` | **yes** |

The archive.org row is the trap: a casual `curl -I` follows the redirect and shows a header that
the response actually serving the bytes does not have. Re-measured 2026-08-11 and it still holds —
`/download/…` answers `302` with `access-control-allow-origin: *`, and the
`dnNNNNNN.us.archive.org` node it redirects to answers `200` with no CORS header at all. A code
comment claiming archive.org sends `ACAO: *` was corrected against this measurement, not the other
way round.

⚠️ **The Inspector warns on any `*.archive.org` host, and the subdomains are the point.** Warning
only on the bare domain leaves it silent on the URL a user is most likely to paste: they use the
`/download/` link, preview it in a browser, and the address bar then shows the
`ia<n>`/`dn<n>.us.archive.org` node it redirected to — so the copied URL is the storage node, which
is exactly the broken case. (`ia801409…` further `301`s to `dn801201…`; both are archive.org
subdomains, so one subdomain-permitting rule covers the family, while `archive.org.evil.com` and
`notarchive.org` still correctly do not match.) `web.archive.org` matches the same rule and is
**not** separately measured — being warned is the safe direction. Pinned by
`engine/tests/editor/videoAssetLogic.test.ts`.

## Sequencing a cutscene

A Timeline `video` track lets a `Director` sequence video alongside animation, audio and activation:

```jsonc
{ "id": "vid", "name": "Screen", "target": "", "type": "video",
  "clips": [
    { "start": 1, "duration": 3, "clip": "b03ba4b4-…" },
    { "start": 5, "clip": "7265857a-…" }          // no duration → runs on
  ] }
```

The clip is rewound and started at `start`, and paused at `start + duration`. **Omitting `duration`
means "let the clip's own length decide"** — the track will not invent an end for it.

Video clips are **start-and-run, never scrubbed** (there is deliberately no `scrub` field, unlike an
animation clip) — see Time and determinism above. The span boundaries are authoritative for
start/stop; between them the element runs on its own clock.

## Excluding video from a build

`build.modules.video` (Project Settings → Engine Modules) is `'auto' | true | false`. `'auto'` detects
a `VideoPlayer` trait in the included scenes — **except on a `--target playable` build, where 'auto'
resolves OFF**: a ≤5 MB MRAID bundle and a video file are close to mutually exclusive. An explicit
`true` still wins there, because a 400 KB stinger is a legitimate thing to want; the capability is
defaulted off, not removed.

**What the toggle actually buys is the clips, not the code.** Unlike Rapier or PixiJS, video has no
vendor SDK behind it — it is ~25 KB of engine source reached through the runtime barrel, and a
flag-gated dynamic import (the shape `materialInstanceSystem` uses for its 2D broker) was measured
at 3 KB saved of that 25 KB, because the barrel's static graph keeps it alive regardless. So the flag
does two useful things and one it does not: it stops video *running*, and it tells the asset shaker
to drop the `.mp4`s — which is what actually fits a playable under its cap. It does not strip the JS.

Dropped clips are always logged by name. A build that quietly ships a game minus its cutscenes is
indistinguishable from one that shipped fine until someone plays it.

## Gotchas

**A recycled entity index must not inherit the previous entity's decoder (#336).** `videoSystem`'s
`live`/`pending`/`progress`/`readyUrls`/`failed` all persist across frames keyed by `entity.id()`,
which strips koota's generation — and the `seen`-set sweep that releases a dead entity's state runs
at the END of a pass, so a despawn+respawn landing between two passes never gets one. The
`existing.clip !== vp.clip` hard-swap self-heals a *different* clip; a **same-clip** respawn (a
prefab re-instantiated, two players streaming one intro) does not, and the newcomer silently
adopted the dead entity's decoder, download progress and sticky failure. Fixed with an `owner` map
(id → packed entity) checked at the top of the reconcile — the maps stay id-keyed because
`videoElementFor`/`seekEntityVideo` are a public addressing contract the texture surfaces,
`UIVideoMount` and the `video.*` actions all call with a masked id. `owner` is dropped on a world
swap but NOT on `stopWorldVideo`, so a sticky download failure still survives Stop→Play as
intended. Background and the general rule:
[engine-concepts.md](engine-concepts.md) § Entity. Regression test:
`tests/video/videoSystemIdReuse.test.ts`.

**`playsInline` and `crossOrigin` are both mandatory, and both fail silently.** Without
`playsInline`, iOS hijacks playback into a native fullscreen player. Without
`crossOrigin='anonymous'`, a remote clip taints the canvas and cannot become a texture at all.

**PixiJS `Assets.load` will happily accept an `.mp4`** — by minting its own second
`HTMLVideoElement`. That means two decoders, two autoplay negotiations, two audio paths, and
playback the engine's `timeScale` cannot reach. A video ref therefore bypasses the still-image path
entirely (`isVideoRef` in `runtime/core/textureRefs.ts`), leaving an empty Sprite for
`videoTextureSync2D` to fill from the element the engine owns.

**`VideoSource.destroy()` ends with `pause(); src = ''; load()` on its resource.** Called on the
shared element it blacks out the 3D texture and the fullscreen overlay along with the sprite.
`release()` detaches the resource first, and that ordering is asserted directly.

**The 3D binding takes a CLONE of the material, and taking the material itself is a crash (#192).**
The obvious implementation — write the video onto the mesh's `map`, put the old `map` back when the
clip stops — is wrong twice:

1. Engine materials are **shared and refcounted by GUID** ([scene-loading.md](scene-loading.md)), so
   writing `map` onto one shows the video on every other mesh using it.
2. three's `NodeMaterialObserver` is **asymmetric about null**, and the second half is what kills the
   renderer:

   ```js
   getMaterialData:  if ( value === null || value === undefined ) continue;   // recording SKIPS null
   equals:           } else if ( mtlValue.isTexture === true ) {              // comparing does NOT guard it
   ```

   The snapshot lives in a module-level `_materialCache` **keyed by the material object and written
   once** — nothing re-records it, and `material.needsUpdate = true` does *not* reset it. So a slot
   recorded holding a texture that later returns to `null` makes `equals()` dereference null on every
   subsequent frame: `Cannot read properties of null (reading 'isTexture')`, thrown out of the render
   loop in **every** viewport, and permanently — that material can never be rendered again. Restoring
   `map` to its previous value walked into this whenever that value was null, i.e. any screen with no
   authored map. `demos/video-demo` has no `.mat.json` at all, so *every* surface there was affected
   and the first clip stop killed the scene.

`videoTextureSync` therefore binds a private clone: the shared original is never mutated, and the
clone is swapped out whole and disposed rather than having its map cleared. The cost is one extra
pipeline per video surface — the same trade `Tint` and `MaterialInstance` already make for their own
per-entity clones. Consequences worth knowing:

- It runs **last** in the frame, so it re-asserts its clone against `syncMaterial`'s per-frame
  re-bind of a resolved `.mat.json`; if the material *ref* genuinely changed, it rebuilds the clone
  from the new base instead of pinning the old look — **carrying the existing `VideoTexture` onto
  it** rather than minting a new one (next bullet).
- If the slot **shape** changes under a live binding (single ⇄ material array) the binding is dropped
  and re-derived, never re-asserted — writing into a slot that no longer exists would clobber a
  freshly-assigned array, or strand a binding nothing could restore.
- **A texture's lifetime follows the ELEMENT, never the material (#352).** A material swapping
  identity under a live binding re-derives the *clone* and keeps the *texture*
  (`rebindMaterial`). The two used to be freed together, from inside a branch that had already
  established the element was unchanged — so the module threw away a texture it had just proved
  was still valid. Harmless for a one-shot change and ruinous for a repeating one: `maskForObject`
  picks the nearest lights with no hysteresis, so an object crossing an equidistance boundary
  alternates between two **cached** variants indefinitely, and an identity test against one
  remembered material cannot tell "one I have already seen" from "a brand new one". That measured
  **10 GPU texture create+destroy pairs over 10 alternating frames** — ~60/sec at 60 fps, on the
  mid/low tier where the automatic light cap engages. Pinned by
  `tests/video/videoTextureSync.test.ts` § "the texture follows the ELEMENT".
  The flap itself is a separate defect in the light selection (#353); this fix makes a selection
  change cost a clone instead of a texture whether or not it repeats.
  ⚠️ **Two** same-element paths still dispose, both deliberately. A slot **shape** change
  (previous bullet) — carrying there would mean re-plumbing the rVFC pump, which closes over the
  binding record a shape change replaces, and a mesh does not oscillate between single and array,
  so it costs one texture, once. And a replacement material with **no `map` slot**: a file-shader
  `.mat.json` resolves to a bare `NodeMaterial` (`loaders/fileShaderBuilder.ts`) whose textures
  ride TSL nodes rather than PBR slots, so there is nothing to carry the texture *onto* — that
  path is a refusal to bind, not a rebuild.
- The clone is stamped `markDerived` (#318). Only `.map` is replaced, so every other slot the base
  carries — normal, roughness, emissive — is still a **shared** texture reference; without the stamp
  a `.mat.json` re-import lets `sweepRetiredMaterials` free the base (no *mesh* binds it any more —
  the clone does) and release textures this clone is drawing with. Mechanism:
  `docs/textures.md` § "The CLONES are the other half".
- **A light-masked video screen needs more than the stamp (#325).** Once masking is active, the
  material this module finds on the mesh is a light-mask VARIANT, so it clones through
  `cloneDerived` and calls `inheritMaskBase`. A bare `.clone()` — which is what shipped for months —
  dropped the variant's `lightsNode` and `customProgramCacheKey`, so the screen rendered lit by
  every light, **silently ignoring the mask it was authored with**, and collided with the base's
  pipeline key (the #136 failure). It also JSON-round-tripped the base Material parked in
  `userData`, serialising a whole material graph — `THREE.Texture: Unable to serialize Texture.` for
  a compressed one.
  ⚠️ Nothing authored reaches this today: video-demo's screens are default-material primitives, and
  `scene3DSync`'s primitive branch only masks a primitive with an explicit `.mat.json`. It becomes
  reachable the moment a video screen is a GLB `Renderable3D`, or a primitive with a material and a
  `renderingLayerMask`. Reasoning about who owns the slot: `docs/rendering.md`
  § "Rendering-layer light masks".

The 2D twin is unaffected: PixiJS has no such observer, and it swaps `sprite.texture` rather than a
material property.

**Neither renderer's default upload cadence is right.** Three's `VideoTexture` marks itself dirty
every frame — 60 GPU uploads for a 24 fps clip. Pixi's `VideoSource` only self-drives via a `load()`
path that both awaits an alpha probe (whose continuation dereferences a resource we may have
detached) and can call `load()` on an element that is already playing. Both surfaces therefore pump
uploads from `requestVideoFrameCallback` themselves: once per *presented* frame, and naturally idle
while a `timeScale 0` freeze holds the element paused.

**A playing clip must hold its own canvas dirty.** Video changes every frame with no ECS write to
notice, so on the editor's render-on-demand 2D surface the loop settles and the picture freezes on
frame one — which looks exactly like a decode failure.

**Autoplay is narrower than it looks.** Only the first *audible* playback needs a prior user gesture;
muted video autoplays everywhere. A tap on "Play Level" **is** that gesture. Only cold-boot
autoplay-with-sound is genuinely constrained, and that is a constraint on cutscene placement rather
than a bug to fix.

**A skip must also fire the end event — but only ONCE.** `emitVideoSkip` emits `@video.skip` and,
by default, `@video.end`, so a game waiting on "the cutscene is over" fires exactly once whether the
player watched it or dismissed it. Without that, a skip hangs the listener — the classic way a
skippable cutscene softlocks a game. But a skip pressed AFTER the clip already ended must not
double-fire `@video.end` — `video.skip`'s handler calls `claimVideoEndEmit(entityId)` first, which
consults and latches the SAME `Live.endEmitted` guard the reconcile uses, and passes the result as
`emitVideoSkip`'s `announceEnd` argument. An entity with no live handle always claims successfully
(a skip must always announce; there is no guard to double-fire against).

**`@video.start` / `@video.end` are per PLAYBACK, not per clip (#426).** Their once-guards live on
the entity's `Live` entry, which is only recreated when the clip GUID *changes* — so guards that
were never re-armed made a replay of the SAME clip silent, and the softlock above came back through
the front door. The live path is a looping Director video track: on lap 2 the timeline dispatches
`video.stop` + `video.setClip` with an unchanged guid, `video.stop` only seeks to 0 and pauses, and
a same-guid `setClip` is a no-op in the reconcile. The two guards re-arm at *different* moments,
and the asymmetry is deliberate:

| Guard | Re-armed by | Why there |
|---|---|---|
| `endEmitted` | the reconcile, whenever `handle.ended` is observed false | it guards ONE observed end; a rising edge is the only reading that survives a seek off the end |
| `startEmitted` | `seekEntityVideo` on a rewind to `<= 0`, **and** at the moment `@video.end` is emitted | a rewind restarts playback mid-clip; the end-emit covers the other half — a finished clip can only resume via a seek, wherever that seek lands |

Both halves are load-bearing. Without the end-emit half, a `video.seek` to *mid-clip* out of a
finished clip re-arms `endEmitted` and emits a second `@video.end` with no `@video.start` to pair
it. The start-emit is also gated on `!handle.ended` **and** on `handle.playing` being OBSERVED
true (see the next paragraph) — `play()` refuses a finished clip, but the end-emit half re-arms
`startEmitted` right after `@video.end` fires, so `playing = true` on a still-ended clip with no
intervening seek would otherwise announce a start for a playback that can never happen, whose
paired end can't fire again.

⚠️ **Do not count start/end as matched PAIRS — they are not, by design.** Each event is
individually correct ("this playback was asked to begin", "this clip was observed to finish"), and
the two counts legitimately diverge: a `video.stop` mid-clip re-arms the start but emits no end,
because an *abandoned* playback never finished. Gate on the events; don't keep a balance.

**`@video.start` means observed playback, not a request (#431, fixed).** The reconcile checks
`handle.playing` (`!paused && !blocked && !ended`) *before* that same pass's own `handle.play()`
call, and only latches `startEmitted`/emits the start once that check reads true. A real
`element.play()` flips `paused` synchronously and rejects its promise (if the autoplay policy
blocks it) only later — so checking after `play()` would still read "playing" for one frame on a
clip that is about to be blocked. Checking before means: a genuine play request is observed
started on the FOLLOWING reconcile pass, one frame later than the request — the accepted cost of
correctness — and a blocked request announces nothing until the clip genuinely starts, however
that happens (including via `retryBlockedPlay()`'s gesture-unlock retry, which runs outside this
system entirely).

**A blocked play request is reported once, via `@video.blocked` (#431 gap closed by #447).**
Post-#431 a blocked clip correctly emits no `@video.start` — but that also means a play request the
browser refuses is otherwise COMPLETELY silent: no `@video.start`, and if a Director pauses the
clip at a span's end before it ever plays, no `@video.end` either, so a cutscene that never played
leaves no trace at all. `videoSystem` reads `handle.autoplayBlocked` (mirrors the `@video.start`
check: read BEFORE this pass's own `handle.play()` call, since the flag is only set once the play
promise rejects, a microtask later) and, the first time it reads true for a given `Live` entry,
`console.warn`s once naming the clip and journals `@video.blocked`. It is **journal-only —
deliberately no event-bus subscription**, because this is a diagnostic for finding a silent
cutscene, not a control channel a game reacts to; whether a game should be able to respond to a
blocked clip (skip it, show a tap-to-play prompt) is a real design question #447 does not decide.
The report is guarded by its own once-flag (`blockedReported`), separate from `startEmitted` —
cleared on EITHER edge out of the refused state: the handle unblocking, or `playing` going false at
the end of a span. Both are needed. `handle.pause()` does not clear `blocked` (only a successful
`attemptPlay` does), so on a device that never receives a gesture the unblock edge never fires, and
without the span-end reset the first refused cutscene would latch the flag and every later one on
that entity would be silent — the exact failure this exists to surface.

⚠️ **A refusal is reported one pass after the request, so a span shorter than two reconcile passes
is still silent.** The flag is only set once the `play()` promise rejects — a microtask later — and
is read BEFORE the next pass's own `play()` (mirroring the `@video.start` ordering above), so a
clip whose trait says `playing` for a single frame is refused and paused without ever being read as
blocked. That is the same one-pass latency `@video.start` accepts, not a separate defect, but it
means the diagnostic covers a Director-length span rather than every conceivable request. This is reported from `videoSystem`/`videoService`, not from
`timelineSystem`'s video track, on purpose: the timeline dispatches video actions through the
action registry specifically to stay decoupled from (and DCE-able without) the video subsystem, and
reporting from the video side covers every caller — autoplay, game code, `video.play` — not just a
Director-driven clip.

### A handler may write `VideoPlayer` now (#432, fixed)

koota's `world.query(T).updateEach(cb)` snapshots each entity's trait into a local before `cb`
runs and writes that snapshot back UNCONDITIONALLY once `cb` returns — so a handler invoked
*synchronously* from inside the callback (an `onStart`/`onEnd` listener fired by `emitVideoStart`/
`emitVideoEnd`) could call `entity.set(VideoPlayer, ...)` and have the write silently clobbered by
koota's own post-callback write-back of the stale pre-callback snapshot. The obvious "chain the
next clip when this one ends" handler did nothing at all.

The fix is a collect-then-flush split, not a guard: `videoSystem` pushes each `@video.start`/
`@video.end` into a local array *during* the `world.query(VideoPlayer).updateEach(...)` pass and
only calls `emitVideoStart`/`emitVideoEnd` on them once that call returns — past koota's
write-back for every entity in the query, not just the one that fired. **A handler MAY write
`VideoPlayer` now**, on the entity that fired the event or any other.

This is the same invariant `timelineSystem.ts` states explicitly in its own pass split ("PASS 1 —
collect... never emit/dispatch/set-on-other-entities inside the query") and that
`zone2DSystem.ts`/`zone3DSystem.ts` already follow (occupant/zone samples are collected during
their queries; `runZoneTriggers` emits after both queries close) — video is the third system to
need it, not the first. **Issue #445** tracks the two known sites that do NOT yet follow it (both
in physics); it is not a video-specific pattern.

**The overlay binds no keyboard handler, on purpose.** Which key skips a cutscene (or whether any
key does) is a game's call, not the engine's; a game binds its key to the `video.skip` action. Raw
DOM input reads also belong in `runtime/input/` sources rather than scattered through components —
the input-source guard enforces this.

**The dev server needs a `~video.mp4` variant route.** Without it the demuxer parses a 404 body and
reports `DEMUXER_ERROR_COULD_NOT_OPEN`, which reads as a codec problem rather than a missing file.

**A video clip has no other owner than the thing referencing it,** so ref collection has to be
right in two independent places: `collectTimelineVideoRefs` (SceneManager's transitive walk, giving
the clip an owner in the scene manifest) and the tree-shaker's `processTimeline` (which is what
actually keeps the file). A cutscene reachable only through a Director → timeline → clip GUID chain
otherwise ships as a 404 that appears only in a real production build.

**A `remote` clip has no local file at all**, so the build's manifest-vs-disk check must skip it
rather than report it missing.

## Android: what is actually known

Everything above is verified on desktop and on iOS. **Android is the platform where video-to-texture
historically breaks**, and this section exists so that silence is not mistaken for a clean bill of
health.

The weak path is specifically the one this feature depends on: getting decoded frames *into a GPU
texture*, not playback itself. `<video>` playing into a page is well-trodden; uploading it every
frame as a WebGL/WebGPU texture is where vendors diverge, and reports of black or stalled video
textures on Android recur across engines and years (there is a live 2024 three.js report of exactly
this). Treat a working Android device as evidence about *that device*.

**Concurrent decoders are a hard, device-specific limit.** MediaCodec caps how many video decoders
exist at once, and on some devices that cap is **1**. Several `VideoPlayer` entities alive
simultaneously is therefore not a free composition the way several textures would be — it is the
first thing to suspect when one surface plays and another stays black. The demo tours its surfaces
one at a time, which sidesteps this; a game that shows two at once should verify it on hardware.

**One measured data point.** On a Huawei Y6 (MRD-LX3, 2018, PowerVR GE8320, Android 9, Chrome 138
WebView, WebGPU) the bundled clip decoded and played correctly. The app ran at ~10 fps, and that was
**not** video's cost — single-variable measurement from a fresh reload attributed 31 ms of an 86 ms
frame to shadow *receiving* (per-fragment PCF), which scales with neither shadow-map size (2048² and
512² measure identically) nor backing resolution (dpr 2 → 1 changed nothing). ~52 ms remained
unexplained with shadows off; the hypothesis is WebGPU driver overhead on that GPU, and it is
**untested**. The engine-wide lesson is separate from video: `shadows: true` with a 2048² map is a
poor default for low-end mobile.

**`maxFps` is an unused lever.** Every clip in the demo is `maxFps: 0`. Capping the encode frame rate
is the cheapest thing to try first on a device that decodes too slowly, before touching resolution.

## ffmpeg is provisioned, never bundled

Transcoding uses the toolchain's `ffmpeg`/`ffprobe`, auto-provisioned on demand from npm
(`ffmpeg-static`). **The binary is never shipped inside the editor**, and that is a licence
requirement rather than a size decision: every `ffmpeg-static` build is `--enable-gpl`, and the
darwin-arm64 build is additionally `--enable-nonfree`, which is not redistributable under any
licence. Compliance depends on the binary being provisioned onto the user's own machine.

## Agent surface (cache introspection)

The downloaded-video cache is readable through `modoki_diagnose` with `video:true` (opt-in) —
usedBytes/budgetBytes/count plus per-clip entries. Opt-in because `diagnose` is a swept read tool
whose response budget is summary-first; a per-clip index would grow every caller's payload to
answer a question almost none of them asked. Before this the `VideoCache` singleton was a local
`const` inside the `__MODOKI_MODULE_VIDEO__`-gated block in `engine/app/ecs/pipeline.ts` and was
never exported, so cache state couldn't be observed at all — a QA case had to patch `window.fetch`
to infer a refetch, which measures the network rather than the cache and can't distinguish a cache
MISS from a cache never wired up. An accessor alone wasn't enough either: `modoki_eval` runs in the
renderer and could import the pipeline through `/@fs`, but that yields a second module instance
whose slot is null — a confident "no cache" for a live one. It's reached instead through a one-slot
registry, `engine/packages/modoki/src/runtime/video/videoCacheSlot.ts`, typed structurally so no
video code is pulled into builds that compile video out. `available:false` carries a REASON, since
the two causes want opposite next moves — the video module compiled out (a playable-ad build) versus
no Cache API (clips stream instead of caching) — and neither means "the cache is empty".

## Related

- [textures.md](./textures.md) — the import-settings/variant/content-cache pattern video mirrors
- [audio-plan.md](./audio-plan.md) — the bus routing and gesture-unlock machinery video reuses
- [timeline.md](./timeline.md) — the track model the video track joins
- [rendering.md](./rendering.md) — the three rendering layers video binds into
- [playable-export.md](./playable-export.md) — the size cap that makes `build.modules.video` matter
- [verification-harness.md](./verification-harness.md) — what "quarantined from determinism" means
