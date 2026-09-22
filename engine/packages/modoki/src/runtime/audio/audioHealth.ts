/** Audio-health trace — the evidence an "the music died" report needs, kept in memory.
 *
 *  ⚠️ **This exists because the audio path recorded NOTHING about its own recovery, and that is
 *  why #1455 arrived with no repro steps.** The owner reported Weaveling losing its music after a
 *  long background; nothing in the app knew what state the `AudioContext` had been in, whether a
 *  resume was even attempted, or how long the app had been away — so there was nothing to report
 *  and the only way to learn anything was to hold a device and wait for it to happen again.
 *  `docs/audio-plan.md` names the same gap for #1428 in as many words: *"no `ctx.state` was logged,
 *  so whether the context really read `'interrupted'` is still inferred."*
 *
 *  **In memory, deliberately — not persisted.** The failure this serves is "the app is alive and
 *  the music is silent", so the realm that has to answer for it is still running when someone comes
 *  to ask. If iOS killed the app instead, the next launch starts a fresh context and the music
 *  plays, which is not the bug. Persisting the trace would buy the case that cannot happen and cost
 *  a `PlayerPrefs` write on every foreground.
 *
 *  **Reading it on a device.** `getAudioHealthTrace()` is on the `@modoki/engine` barrel, but a
 *  barrel export is NOT by itself reachable from `device_eval`: the injected `modoki` object
 *  carries one method per registered agent op (`engine/app/debug/deviceEvalApi.ts`) and this
 *  registers none, so a bare `return getAudioHealthTrace()` is a `ReferenceError`. The route that
 *  works — used on an iPad mini 5 on 2026-09-22 to drive `getAudioContext()` and
 *  `rearmAudioAutoplay()` on the live app — is the shared-module registry:
 *
 *  ```js
 *  window.__MODOKI_SHARED__.modules['@modoki/engine/runtime'].getAudioHealthTrace()
 *  ```
 *
 *  ⚠️ Do NOT reach for a dynamic `import()` of the built chunk instead: that hands back a SECOND
 *  module instance with an empty `trace`, which reads exactly like "nothing was recorded".
 *  ⚠️ `device_eval` needs the debug bridge at all, which is gated on
 *  `__MODOKI_DEBUG_BUILD__ && isNativePlatform()` (`engine/app/main.tsx`) — true for Weaveling
 *  today, but not a property of every build.
 *
 *  Time comes from `rawNow()`, the sanctioned wall-clock wrapper (`core/clock.ts`), so this module
 *  stays inside the determinism guard's rules like everything else under `runtime/**`. `rawNow()`
 *  is monotonic and resets on navigation, which is exactly the right scope: every question this
 *  trace answers is "what happened in THIS realm", and a realm that died took the trace with it. */

import { rawNow } from '../core/clock';

/** One streamed source's liveness at the moment of a snapshot. Buffer sources are omitted — they
 *  expose no playhead to read back (see `LiveHandle.bufStartedAt`), and the failure being traced
 *  is a streamed music bed. */
export interface AudioStreamHealth {
  paused: boolean;
  currentTime: number;
  /** `null` until the element's metadata arrives (`duration` is NaN before that). */
  duration: number | null;
  readyState: number;
  /** `MediaError.code`, or `null` when the element is not in error. */
  error: number | null;
  /** Whether the GAME paused this source (`playing = false`), as opposed to the OS doing it.
   *  Without this, a deliberately-paused bed and a bed the OS silently killed read identically. */
  deliberatelyPaused: boolean;
}

export type AudioHealthKind =
  /** The app came back to the foreground — recorded BEFORE the resume attempt, so `state` is what
   *  the OS actually left behind rather than what the recovery turned it into. */
  | 'foreground'
  /** `audioService.resume()` ran. `outcome` says what it did, including deciding to do nothing. */
  | 'resume'
  /** The context changed state on its own — WebKit resuming an interrupted context by itself, or
   *  interrupting one (WebKit bug 263627). */
  | 'statechange'
  /** A streamed source was told to play and the element REFUSED. This is the other half of a
   *  recovery: a context can come back `running` while the bed stays silent, which is exactly the
   *  candidate #1455's body lists second and which a context-only trace cannot tell apart from a
   *  healthy resume. `reason` says which call was refused. */
  | 'play-refused';

/** Which call asked a streamed element to play. */
export type AudioKickReason =
  /** `resumeMedia()` — the gesture/foreground re-kick. The one that matters for a lost bed. */
  | 're-kick'
  /** `LiveHandle.resume()` — the game deliberately un-pausing a source it paused. */
  | 'unpause';

export type AudioResumeOutcome =
  /** Already `running` — correctly nothing to do. */
  | 'skipped-running'
  /** ⚠️ `closed`. A closed context CANNOT be resumed, and nothing in the engine replaces one, so
   *  this outcome means the audio is gone for the life of the realm. Never observed on a device as
   *  of 2026-09-22 (measured to a 30-minute background); it is traced because if it ever does
   *  happen, this is the only line that would say so. */
  | 'skipped-closed'
  | 'no-graph'
  | 'resolved'
  | 'rejected';

export interface AudioHealthEntry {
  /** `rawNow()` milliseconds — monotonic within this realm, not an epoch. */
  t: number;
  kind: AudioHealthKind;
  /** `ctx.state` when the entry was recorded. A plain string because `'interrupted'` — the state
   *  current WebKit uses for a backgrounded/locked/called context — is not in lib.dom's
   *  `AudioContextState`. */
  state: string;
  /** For `resume`: the state once the attempt settled. */
  stateAfter?: string;
  outcome?: AudioResumeOutcome;
  /** For `foreground`: how long the app was away. The axis nothing had ever recorded, and the one
   *  the owner's report turns on.
   *
   *  ⚠️ **`null` means "no preceding hide was seen", NOT zero.** A boot-time or gesture-driven
   *  foreground has no duration to report, and writing `0` for it conflated that with a genuine
   *  instant return — and, before the dedupe in `useAudioResumeRearm`, with a duplicate event for
   *  a transition already noted. A reader takes the most recent `foreground` entry, so a `0` that
   *  meant "unknown" read as "the app was not away", which is the inverse of what #1455 is about. */
  backgroundedMs?: number | null;
  /** `ctx.currentTime`. It FREEZES while the context is interrupted (measured: ~27 s advanced
   *  across a 1798 s background), so two entries' difference tells "the clock ran" apart from "the
   *  context merely claims to be running" — which is the only way to catch a resumed-but-silent
   *  context. */
  ctxTime?: number;
  /** For `play-refused`: which call the element refused. */
  reason?: AudioKickReason;
  streams?: AudioStreamHealth[];
}

/** Enough to cover a handful of background/foreground cycles, small enough to be free. A trace
 *  that has wrapped still answers the question, because the entry that matters is the most recent
 *  foreground — the one the person is complaining about. */
export const MAX_ENTRIES = 32;
/** Per entry. A game has one music bed and a few streams at most; a runaway count is itself a bug
 *  and should not be able to grow this trace without bound. */
export const MAX_STREAMS = 4;

const trace: AudioHealthEntry[] = [];

/** Append an entry. Callers pass everything but the timestamp. Returns whether one was written.
 *
 *  `collapseRepeat` drops an entry that would repeat the previous one's kind/outcome/reason. It
 *  exists for the callers that run on a HOT path — `resume()` fires on every `pointerdown` — where
 *  recording each call would evict the rare, interesting entries from a 32-slot ring with a run of
 *  identical ones. What survives is the TRANSITIONS, which is what a trace is for. Callers that
 *  fire on a real edge (a foreground, a statechange) do not pass it: two foregrounds in a row are
 *  two different facts. */
export function recordAudioHealth(
  entry: Omit<AudioHealthEntry, 't'>, opts?: { collapseRepeat?: boolean },
): boolean {
  const prev = trace[trace.length - 1];
  if (opts?.collapseRepeat && prev
      && prev.kind === entry.kind && prev.outcome === entry.outcome && prev.reason === entry.reason) {
    return false;
  }
  const e: AudioHealthEntry = { t: Math.round(rawNow()), ...entry };
  // ⚠️ `slice(0, …)` — the OLDEST streams, not the newest. `active` is insertion-ordered and a
  // looping music bed starts at scene load and never leaves, so it is always first. Keeping the
  // newest four would discard precisely the bed whose `paused`/`error` this trace exists to
  // record, on the one occasion the cap actually fires.
  if (e.streams && e.streams.length > MAX_STREAMS) e.streams = e.streams.slice(0, MAX_STREAMS);
  trace.push(e);
  if (trace.length > MAX_ENTRIES) trace.shift();
  return true;
}

/** The trace, oldest first. A copy — a caller must not be able to mutate the record it is reading. */
export function getAudioHealthTrace(): AudioHealthEntry[] {
  return trace.map((e) => ({ ...e, streams: e.streams?.map((s) => ({ ...s })) }));
}

/** Drop every entry. For tests, and for a caller that wants a clean window around a deliberate
 *  reproduction attempt. */
export function clearAudioHealthTrace(): void {
  trace.length = 0;
}
