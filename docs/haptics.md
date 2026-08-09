# Haptics

Device haptic feedback — a game plays a **named pattern** and the engine turns it into vibration on
iOS and Android. `runtime/haptics/` in `@modoki/engine`, plus the `HapticSettings` resource trait.

Silent everywhere that is not a device: the editor, the browser and every headless test get a noop
backend, so haptics never affects a test run or a desktop session.

## Using it

```ts
import { playHaptic, registerHapticPatterns } from '@modoki/engine/runtime';

// In the game's setup.ts, beside registerSystems/registerTrait — game vocabulary lives with the game.
registerHapticPatterns({
  'mygame.bigHit': [
    { preset: 'impact.heavy', delayMs: 0 },
    { preset: 'warning', delayMs: 120 },
  ],
});

// From a state TRANSITION — never from a per-frame path (see "Fire from the event" below).
playHaptic('mygame.bigHit');
playHaptic('celebrate');   // an engine default; nothing to author
```

Declaratively, with no TS at all — bind a scene `UIAction` to:

| Action | Payload | What it does |
|---|---|---|
| `haptics.play` | `{ pattern }` (default `'select'`) | Play a named pattern — how a button gets a tap feel |
| `haptics.toggle` | — | Flip `HapticSettings.enabled` |
| `haptics.set` | `{ enabled }` | Set it explicitly, for a settings control that knows its value |

## The vocabulary — engine defaults, plus whatever the game adds

A pattern is a short list of **preset** steps with authored gaps. That is the entire expressive
range, and the reason is measured, not assumed — see "Why presets" below.

**Seven presets**, named by feeling rather than by platform: `impact.light`, `impact.medium`,
`impact.heavy`, `select`, `success`, `warning`, `error`.

**Nine default patterns.** The seven presets by name, plus two composed feelings that generalise:

| Name | Shape | Why it is composed |
|---|---|---|
| `refuse` | heavy, heavy (+90ms) | A single heavy impact reads as a heavier *landing*. The gap is what makes it a refusal — and on a phone with no amplitude control the gap is the only thing that still carries it. |
| `celebrate` | light, medium (+80ms), success (+110ms) | Presets can only step, never ramp; three beats is as close to a rise as this vocabulary gets. |

**A game layers its own over the top** with `registerHapticPatterns`. Registering an existing name
*replaces* it, so a game can retune a stock feeling without inventing a name; prefer a game-scoped
prefix (`court.heartLost`) for genuinely new moments so a later engine default cannot shadow one.

The split follows the single-source-of-truth rule: engine defaults are **code constants** because
they are vocabulary rather than game data, and a game's patterns live in its `setup.ts` beside
everything else game-specific it registers.

⚠️ **A pattern is not an asset and must not become one.** It has no file, no GUID and nothing for
the build to resolve, so #53's "a GUID in code is a ref the build cannot see" does not apply. An
asset kind here would be ceremony around three numbers.

**Worked example — [Court](../games/court/CLAUDE.md).** Nine moments; seven map straight onto engine
defaults (including `refuse` for a refused placement and `celebrate` for a win). It registers
exactly **one** custom pattern, `court.heartLost`, because "a kill is a refusal with *more* weight"
is not a distinction every game wants. `games/court/tests/haptics.test.ts` asserts that count, so a
refactor cannot quietly rebuild a private table.

## Settings

`HapticSettings` is a resource trait — author one entity per scene:

- **`enabled`** — the master switch. A **player** preference: a game exposing an on/off control
  should persist it through [PlayerPrefs](./player-prefs.md) and write it back here. Authored in the
  scene so a game can ship with haptics off by default with no code change.
- **`masterIntensity`** — ⚠️ currently a **gate, not a scale**: below 0.05 nothing plays, above it
  everything plays at its authored strength. Presets carry fixed strengths and no platform in range
  lets us scale one, so anything in between would be a lie. The field exists so a strength slider
  does not need a trait migration the day a backend can honour it.

`hapticsSystem` copies the trait into the service each frame, which is why the trait is the single
home for "are haptics on". **Never call `configureHaptics` from game code** — a second writer races
the system and the setting flickers back a frame later. A scene with no `HapticSettings` entity just
leaves the service at its defaults.

The engine deliberately does **not** persist `enabled` itself: the PlayerPrefs key namespace and the
flush point are game decisions, and baking one in would put engine-chosen storage under a
game-chosen setting.

## The two rules that keep it correct

**Fire from the EVENT, never from a per-frame path.** A haptic is edge-triggered by definition. Call
`playHaptic` from a state transition — a commit, a win latch, a gesture edge — never from anything
that runs every frame, or it buzzes continuously. This is not hypothetical: Court's chrome syncs
every frame unconditionally and has no dirty flag *by design*, so a haptic hung there would never
stop.

**When two moments can co-occur, exactly one must win.** The platform plays one vibration at a time,
so two patterns fired together mutually truncate into mush. This has bitten twice, both times found
on a phone rather than by a test:

- a kill fired *both* the refusal and the heart-loss — five beats stacked on one drop;
- a winning placement fired *both* the landing and the win — `dumpsys` reported two beats
  `cancelled_superseded`, i.e. four beats of mush instead of a landing plus a flourish.

Court's fix for the second is worth copying: the landing haptic is **deferred one frame** and
dropped if the move won, which reuses the existing win latch rather than introducing a second
"did we win" predicate. `games/court/tests/hapticCallSites.test.ts` pins both, driving real gestures
and asserting on what reached the **backend** — the only layer that can see two moments fire at
once.

## Verifying it

**Headless:** every accepted play emits a tick-stamped `haptic` journal event (and `haptic.unknown`,
at `warn`, for a name that resolves to nothing). That is the only non-manual route, and it fires
even on the noop backend, so a test can assert "the win screen fired `celebrate`" with no hardware.

**On Android, objectively:** `adb shell dumpsys vibrator_manager` records every vibration with a
start time, package and requested waveform, so inter-beat gaps are readable to the millisecond with
no build instrumentation. This is how every number below was measured. ⚠️ It reports what was
**requested**, not what the hardware rendered — see the tier table.

**On iOS:** there is no equivalent. Nothing can be measured; only a human can judge it.

## What the tiers can render

**It is hardware-tiered, not OS-tiered.** `minSdkVersion 31` across every native project puts the
whole modern Android API unconditionally in range, so there is no `Build.VERSION` branching
anywhere. What differs is the vibrator:

| | Galaxy S22 | Galaxy A23 |
|---|---|---|
| `mCapabilities` | `COMPOSE_EFFECTS`, `AMPLITUDE_CONTROL`, +2 | **`[]`** |
| `mSupportedEffects` | `CLICK`, `DOUBLE_CLICK`, `TICK`, `HEAVY_CLICK` | **`[]`** |
| `mSupportedPrimitives` | 8, incl. `THUD` / `QUICK_RISE` | **`PRIMITIVE_NOOP` only** |

The A23 — the realistic low-end target — flattens **every** amplitude to on/off. `impact.light` and
`impact.heavy` are physically the same buzz there. **Timing is the only expressive axis it has**,
which is why the composed defaults are sequences: on that tier the gap is the entire message.

⚠️ **90ms is near the FLOOR for a two-beat gap — do not tighten it.** A vibration's actual playout
outlasts its request: `dumpsys` reports 78ms for a `LIGHT` requesting 50ms, so a `HEAVY`'s 60ms runs
~75–90ms. Measured across three `court.heartLost` fires the 1→2 gaps were 76, 81 and 73ms, and only
the 73ms one came back `cancelled_superseded`. That truncation is **benign and must not be fixed** —
a clipped first beat is what makes two beats read as two; let it run in full and it merges with beat
two into one long buzz. Widen if anything.

## Why presets, and not a custom-waveform plugin

The obvious design is a `.haptic.json` asset compiled to `CHHapticEngine` (iOS) and
`VibrationEffect` (Android) by our own Capacitor plugin. **That was planned, and then measured out
of existence.** The plan turned on "fixed presets are not enough", which had never been tested, so a
throwaway spike wired presets into Court and put numbers on it (2026-08-09):

- **Sequencing holds.** The one thing presets structurally could not be assumed to do — hold a tight
  sequence from JS timers — they do. Measured across a dozen sequences of real play on both Android
  tiers, inter-beat gaps landed **−37..+25ms** of authored, most within ±20ms. The error is not
  drift (`setTimeout` cannot fire early); it is beat 1's own bridge latency being recorded into the
  gap, plus timer noise on the slower phone.

  **The tolerance is wider than those numbers**, and that is a measurement rather than a guess: the
  worst outliers were on the A23, and the owner — playing the same levels before and after — could
  not tell the two builds apart. So **~37ms of gap error is below the threshold of noticing** for
  patterns of this shape. Useful when retuning: chase a gap that *feels* wrong, not one that merely
  reads badly in `dumpsys`.
- **The low-end tier cannot tell the difference anyway.** With `mCapabilities=[]` the A23 renders a
  custom pattern and a preset identically, so the whole apparatus would buy nothing on the phone
  most players hold.
- **iOS does not need it either — and this is the one that settles the cost.**
  `@capacitor/haptics` uses `UIImpactFeedbackGenerator` / `UINotificationFeedbackGenerator` on iOS
  and **never touches Core Haptics**. So the preset path has no `CHHapticEngine` lifecycle to manage
  (lazy start, `resetHandler`/`stoppedHandler`, stop-on-background), no Low Power Mode start
  failure, and no `AVAudioSession` interaction — the exact cluster of field failures that would have
  been the plugin's hardest part. It also honours the user's system haptic setting by itself.
  Adopting the plugin would *introduce* all of that to a platform that currently has none of it.
- **It felt good** on the S22, the A23 and an iPhone 8, judged by hand across several levels — both
  as the original spike and, re-checked on all three afterwards, as the engine subsystem.

What would reopen it: a game that genuinely needs `intensity` × `sharpness` as independent axes, or
a continuous ramp. Court needed neither, and neither does anything shipped.

## Traps

- ⚠️ **`selectionStart()` → `selectionEnd()` vibrates NOTHING** on either platform.
  `selectionChanged()` is the only call that reaches the hardware; the other two arm and disarm the
  generator. This shipped silent once and no unit test caught it, because the test counted
  `selectionStart` — asserting on the call that *cannot* buzz. `backends.ts` makes all three calls.
- ⚠️ **A backend must never throw or reject into game code.** Every failure at that layer is
  environmental and un-actionable — unsupported hardware, Low Power Mode, OS haptics disabled — so
  they are swallowed. Note this includes *rejections*: a bare `.then()` leaves an unhandled
  rejection, which breaks the contract just as surely as a synchronous throw, only later.
- **There is no web backend, on purpose.** `navigator.vibrate` is Android-Chrome-only,
  duration-only and gesture-gated, and iOS Safari has nothing — it could deliver a flat buzz to some
  browsers while reporting success everywhere. A partial channel that silently differs by browser is
  worse than an honest noop. Revisit only with a real web consumer asking.
- **`@capacitor/haptics` is in `ENGINE_REQUIRED_CAP_PLUGINS`**, so every native project carries it
  whether it plays a moment or not. Forced, not chosen: the engine imports it statically, so "this
  game does not use haptics" is not a state the bundle can be in.
- **Not a per-frame cue queue like [audio](./audio-plan.md).** Audio queues named cues and drains
  once per frame; a frame of latency is inaudible there and fatal here, because the whole point is
  landing inside the visual effect it accompanies (Court's drop effect is 160ms) and the Capacitor
  bridge already spends part of that budget.

## Not covered

- **Gamepad rumble** — a different device and a different API (`GamepadHapticActuator.playEffect`)
  with no phone involvement. Still open on the roadmap.
- **Audio-coupled haptics** (deriving a pattern from an audio waveform).
- **Editor preview.** Desktop haptics are not a thing worth building; a pattern is judged on a
  connected phone.
