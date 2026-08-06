/** Profiler counters (profiler plan P9) — named numeric series alongside the timings.
 *
 *  Unity's `ProfilerCounter`. Markers answer "how long did it take"; counters answer "how many
 *  were there" — enemies alive, pooled objects reused, pathfinding requests, bytes streamed. The
 *  pair is what turns "the frame got slow around here" into "the frame got slow *because* the
 *  spawner hit 400 enemies", and a game author is the only one who can name that quantity.
 *
 *  ── TWO SEMANTICS, BECAUSE CONFLATING THEM SILENTLY LIES ──────────────────────────────────
 *  - `setCounter(name, v)` — a LEVEL. Persists until changed; a frame that does not set it keeps
 *    the previous value, because "enemies alive" does not become 0 on a frame nobody counted.
 *  - `countEvent(name, n)` — a RATE. Accumulates within a frame and resets at the frame
 *    boundary, because "spawns this frame" genuinely is 0 on a frame with no spawns.
 *
 *  Getting this backwards is a quiet wrong answer either way: a level that resets reads as a
 *  system that keeps emptying, and a rate that persists reads as work still happening after it
 *  stopped. So the choice is in the API, not in a flag.
 *
 *  Same enable flag, window and allocation discipline as the markers — a counter costs a map
 *  lookup and a number write, and nothing at all when profiling is off. */

import { isProfilerEnabled } from './profilerMarkers';

/** Frames retained per counter. Matches the marker window so a counter and a timing read on the
 *  same screen describe the same span of time. */
export const COUNTER_WINDOW_FRAMES = 120;
/** Distinct counters tracked. Same guard as the marker node cap: a name built from per-entity
 *  data would otherwise grow without bound. */
export const MAX_COUNTERS = 128;

type CounterKind = 'level' | 'rate';

interface CounterSeries {
  name: string;
  kind: CounterKind;
  /** Live value: the current level, or this frame's accumulating total. */
  value: number;
  samples: Float64Array;
  write: number;
  filled: number;
}

const counters = new Map<string, CounterSeries>();
let capHit = false;

function series(name: string, kind: CounterKind): CounterSeries | null {
  let s = counters.get(name);
  if (s === undefined) {
    if (counters.size >= MAX_COUNTERS) { capHit = true; return null; }
    s = { name, kind, value: 0, samples: new Float64Array(COUNTER_WINDOW_FRAMES), write: 0, filled: 0 };
    counters.set(name, s);
  }
  return s;
}

/** Record a LEVEL — a quantity that exists between frames (entities alive, pool size, queue
 *  depth). Persists until set again. */
export function setCounter(name: string, value: number): void {
  if (!isProfilerEnabled()) return;
  const s = series(name, 'level');
  if (s) s.value = value;
}

/** Record an EVENT — a per-frame count that resets at the frame boundary (spawns this frame,
 *  cache misses this frame). */
export function countEvent(name: string, n = 1): void {
  if (!isProfilerEnabled()) return;
  const s = series(name, 'rate');
  if (s) s.value += n;
}

/** Close the frame: sample every counter, then zero the RATE counters only. Called by
 *  `frameDriver` alongside the marker frame boundary. */
export function recordCounterFrame(): void {
  if (!isProfilerEnabled()) return;
  for (const s of counters.values()) {
    s.samples[s.write] = s.value;
    s.write = (s.write + 1) % COUNTER_WINDOW_FRAMES;
    if (s.filled < COUNTER_WINDOW_FRAMES) s.filled++;
    // Levels persist across the boundary; rates do not. See the header.
    if (s.kind === 'rate') s.value = 0;
  }
}

export interface CounterStat {
  name: string;
  kind: CounterKind;
  /** Most recent sampled value. */
  current: number;
  median: number;
  max: number;
}

export interface CounterReport {
  counters: CounterStat[];
  /** True once MAX_COUNTERS was hit — the list is then incomplete and says so. */
  truncated: boolean;
}

function median(buf: Float64Array, filled: number): number {
  if (filled === 0) return 0;
  const a: number[] = [];
  for (let i = 0; i < filled; i++) a.push(buf[i]);
  a.sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(0.5 * a.length) - 1))];
}

/** Summarise every counter. Read path — allocates; the per-frame cost is the sample loop above. */
export function getCounters(): CounterReport {
  const out: CounterStat[] = [];
  for (const s of counters.values()) {
    if (s.filled === 0) continue;
    let max = 0;
    for (let i = 0; i < s.filled; i++) if (s.samples[i] > max) max = s.samples[i];
    const lastIdx = (s.write - 1 + COUNTER_WINDOW_FRAMES) % COUNTER_WINDOW_FRAMES;
    out.push({
      name: s.name,
      kind: s.kind,
      current: s.samples[lastIdx],
      median: median(s.samples, s.filled),
      max,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { counters: out, truncated: capHit };
}

/** Drop every counter. For tests, and for a clean measurement around one action. */
export function resetCounters(): void {
  counters.clear();
  capHit = false;
}
