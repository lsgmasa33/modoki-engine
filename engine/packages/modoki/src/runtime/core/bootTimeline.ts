/** Boot-phase timeline (profiler plan P2, issue #238) — WHAT the boot stall was doing.
 *
 *  ── WHY THIS IS NOT `profilerMarkers` ────────────────────────────────────────────────────
 *  The marker tree is a PER-FRAME accumulator: `beginProfilerFrame()` zeroes it, spans nest on
 *  a stack, and it is off by default. Every one of those is wrong for boot:
 *
 *    - Boot work spans MANY frames (a scene load is a chain of awaits), so a per-frame reset
 *      throws away exactly the thing being measured.
 *    - Boot work is CONCURRENT (`Promise.all` over resources), so a nesting stack cannot
 *      represent it — two overlapping spans are not parent and child.
 *    - The profiler is off by default, and a cold boot has no one there to switch it on. The
 *      faults worth measuring are the ones you cannot reproduce after enabling a flag.
 *
 *  So this is a flat, always-on list of absolutely-timestamped spans. Nesting is DERIVED from
 *  containment when the timeline is read, not imposed by a stack — which also means an overlap
 *  that is not containment shows up honestly as an overlap instead of being flattened into a
 *  lie about parentage.
 *
 *  ── WHAT IT IS FOR ───────────────────────────────────────────────────────────────────────
 *  `FrameProfile.worstStallMs` says 4 of 20 projects freeze over 1.2 s at boot and 16 do not,
 *  and nothing in draw calls, triangles, 2D-vs-3D or post-FX separates the two sets (#238).
 *  Three attributions have now been guessed from frame markers and all three were wrong. This
 *  is the instrument that answers it by MEASUREMENT: `frameProfiler` records WHEN the stall was
 *  (`worstStallAtMs`), this records what was open at the time, and the read intersects them.
 *
 *  ── COST ─────────────────────────────────────────────────────────────────────────────────
 *  Two `rawNow()` reads and one pre-allocated slot write per span, and recording STOPS at
 *  `MAX_BOOT_SPANS`. The cap keeps the EARLIEST spans, which is the desired boot-only behaviour
 *  without needing a clock to decide when boot ended: a long session simply stops recording and
 *  says so (`dropped`). Nothing here allocates per frame, because nothing here runs per frame. */

import { rawNow } from './clock';

/** Spans retained. Measured on a live editor boot of `games/skin-test`: 194, of which 180 are
 *  the frame spans — so the cap has to leave room for a project with hundreds of resources
 *  ON TOP of those, or the per-asset rows (the ones that actually name work) fall off the tail.
 *  The cap also exists so a span opened from a per-frame path degrades to a counter instead of
 *  unbounded memory. Two Float64Arrays and two string arrays of this length: a few tens of KB. */
export const MAX_BOOT_SPANS = 1024;

export interface BootSpan {
  name: string;
  /** Milliseconds since `getBootOrigin()`. */
  startMs: number;
  /** Milliseconds since `getBootOrigin()`. `-1` while the span is still open. */
  endMs: number;
  /** Optional short detail (an asset path, a count) — the thing that turns "acquire-texture"
   *  into an actionable row. Kept to one string so the read stays cheap to serialise. */
  detail?: string;
}

/** Parallel arrays rather than objects: this is written during the phase whose cost is under
 *  investigation, so it must not be the thing allocating. */
const names: string[] = new Array(MAX_BOOT_SPANS);
const details: (string | undefined)[] = new Array(MAX_BOOT_SPANS);
const starts = new Float64Array(MAX_BOOT_SPANS);
const ends = new Float64Array(MAX_BOOT_SPANS);
let count = 0;
let dropped = 0;
const origin = rawNow();

/** The `rawNow()` reading this module was first evaluated at. Every `startMs`/`endMs` is
 *  relative to it, so a timeline is readable without knowing when the page loaded. */
export function getBootOrigin(): number {
  return origin;
}

/** Open a span. Returns a handle for `endBootSpan`, or `-1` when the cap is full — pass the
 *  handle back regardless; `-1` is a no-op end, so callers need no branch of their own. */
export function beginBootSpan(name: string, detail?: string): number {
  if (count >= MAX_BOOT_SPANS) {
    dropped++;
    return -1;
  }
  const i = count++;
  names[i] = name;
  details[i] = detail;
  starts[i] = rawNow() - origin;
  ends[i] = -1;
  return i;
}

/** Close a span. Idempotent and bounds-checked: closing twice, or closing a refused span, is a
 *  no-op rather than a corrupted timeline. */
export function endBootSpan(handle: number, detail?: string): void {
  if (handle < 0 || handle >= count) return;
  if (ends[handle] >= 0) return;
  ends[handle] = rawNow() - origin;
  if (detail !== undefined) details[handle] = detail;
}

/** Time a synchronous span. Exception-safe — a throwing boot step still closes its span, so one
 *  failed asset does not leave every later span reading as a child of it. */
export function bootSpan<T>(name: string, fn: () => T, detail?: string): T {
  const h = beginBootSpan(name, detail);
  try {
    return fn();
  } finally {
    endBootSpan(h);
  }
}

/** Time an asynchronous span. The boot path is almost entirely awaits, so this is the form that
 *  actually gets used. Closes on rejection too. */
export async function bootSpanAsync<T>(name: string, fn: () => Promise<T>, detail?: string): Promise<T> {
  const h = beginBootSpan(name, detail);
  try {
    return await fn();
  } finally {
    endBootSpan(h);
  }
}

/** Record a span whose extent is already known, from RAW clock timestamps (`rawNow()` values,
 *  not origin-relative). For work that can only be recognised AFTER it happened — the frame loop
 *  cannot know a frame was a 1.8 s stall until it ends, and by then a begin/end pair is no longer
 *  available to it. Same cap and the same `dropped` accounting as `beginBootSpan`. */
export function recordBootSpan(name: string, rawStartMs: number, rawEndMs: number, detail?: string): void {
  if (count >= MAX_BOOT_SPANS) {
    dropped++;
    return;
  }
  const i = count++;
  names[i] = name;
  details[i] = detail;
  starts[i] = rawStartMs - origin;
  ends[i] = rawEndMs - origin;
}

export interface BootTimeline {
  /** `rawNow()` at module init — the zero of every timestamp below. */
  originMs: number;
  spans: BootSpan[];
  /** Spans refused because the cap was full. Non-zero means this timeline is INCOMPLETE at the
   *  tail; the retained spans are the earliest ones. */
  dropped: number;
  /** True once `MAX_BOOT_SPANS` is reached — recording has stopped. */
  full: boolean;
}

/** The recorded spans. Allocates: this is the read path (an MCP call, a panel repaint). */
export function getBootTimeline(): BootTimeline {
  const spans: BootSpan[] = new Array(count);
  for (let i = 0; i < count; i++) {
    spans[i] = { name: names[i], startMs: starts[i], endMs: ends[i], ...(details[i] !== undefined ? { detail: details[i] } : {}) };
  }
  return { originMs: origin, spans, dropped, full: count >= MAX_BOOT_SPANS };
}

/** Spans overlapping the window `[fromMs, toMs)` (both relative to the boot origin), longest
 *  first. THE attribution query: given `frameProfiler`'s worst-stall window, what was open?
 *
 *  A span still open (`endMs < 0`) is treated as running to `toMs` — it overlaps by definition
 *  if it started before the window ended, and reporting it as zero-length would hide the one
 *  case that matters most (a span that never closed BECAUSE it was the stall). */
export function bootSpansOverlapping(fromMs: number, toMs: number): Array<BootSpan & { overlapMs: number }> {
  const out: Array<BootSpan & { overlapMs: number }> = [];
  for (let i = 0; i < count; i++) {
    const s = starts[i];
    const e = ends[i] < 0 ? Math.max(toMs, s) : ends[i];
    if (e <= fromMs || s >= toMs) continue;
    const overlapMs = Math.min(e, toMs) - Math.max(s, fromMs);
    // A span that merely TOUCHES the window contributes nothing to it. Dropping it matters
    // because `startMs`/`endMs` carry float drift from the origin subtraction, so a boundary
    // span can land a fraction of a nanosecond inside and would otherwise be reported as
    // "during the stall" with an overlap of zero — a row that reads as evidence and is not.
    if (overlapMs <= 0) continue;
    out.push({
      name: names[i],
      startMs: s,
      endMs: ends[i],
      ...(details[i] !== undefined ? { detail: details[i] } : {}),
      overlapMs,
    });
  }
  out.sort((a, b) => b.overlapMs - a.overlapMs);
  return out;
}

/** Clear everything. For tests, and for re-arming the timeline around a deliberate scene swap
 *  once boot itself has been read. */
export function resetBootTimeline(): void {
  count = 0;
  dropped = 0;
}
