/** Marker aggregation (profiler plan P3) — turn per-frame trees into a window you can act on.
 *
 *  A single frame is noise: GC lands somewhere, a texture decodes, one system happens to run
 *  long. The question worth answering is "what costs me time *consistently*", which needs the
 *  window, not the instant.
 *
 *  ── THE FLAT RANKING IS THE POINT ─────────────────────────────────────────────────────────
 *  The tree answers "how is the frame structured"; the **flat ranking by self time** answers
 *  "what do I fix?", which is the question anyone actually arrives with. Unity buries this under
 *  a hierarchy you have to expand; here it is the primary output and the first thing an agent
 *  gets back, because it is also the cheapest thing to put in a response budget.
 *
 *  ── SAME WINDOW SEMANTICS AS `frameProfiler` ──────────────────────────────────────────────
 *  A frame COUNT, not a duration, so a struggling device gets a longer wall-clock window and its
 *  percentiles stay meaningful exactly when the numbers matter most.
 *
 *  Aggregation happens on the READ path, not per frame: each frame appends one number per marker
 *  to a ring (cheap, no allocation once warm), and percentiles are computed only when someone
 *  asks. */

import { getMarkerTree, isProfilerEnabled, type MarkerSample } from './profilerMarkers';

/** Frames retained per marker. Matches `frameProfiler.PROFILE_WINDOW_FRAMES`. */
export const MARKER_WINDOW_FRAMES = 120;
/** Distinct marker paths tracked. Above `MAX_MARKER_NODES` so the cap that bites first is the
 *  one with the clearer error (the tree's), not this one. */
const MAX_TRACKED_PATHS = 640;

interface PathSeries {
  /** `frame/ecs/physicsSystem` — identity across frames, and it disambiguates same-named
   *  markers under different parents. */
  path: string;
  name: string;
  depth: number;
  self: Float64Array;
  total: Float64Array;
  callsSum: number;
  /** Frames in which this marker appeared. A marker present in 3 of 120 frames is a different
   *  claim from one present in all 120, and averaging over the wrong denominator hides that. */
  framesSeen: number;
  write: number;
  filled: number;
}

const series = new Map<string, PathSeries>();
let framesRecorded = 0;

export interface MarkerStat {
  path: string;
  name: string;
  depth: number;
  /** Median self ms across the frames this marker appeared in. */
  selfMs: number;
  selfP95: number;
  /** Worst single frame in the window.
   *
   *  Carried because the median and p95 BOTH hide a one-off hitch by design: a single spike in
   *  a 120-frame window is under 1% of samples, so p95 correctly excludes it — and "correctly
   *  excludes" is exactly wrong when the thing you are hunting IS the stutter. Median says what
   *  it costs normally, max says what it costs at its worst, and the pair is what separates
   *  "consistently slow" from "occasionally janky". */
  selfMax: number;
  totalMs: number;
  /** Mean calls per frame it appeared in. */
  callsPerFrame: number;
  /** Frames seen / frames recorded — 1 means every frame.
   *
   *  LIFETIME, not windowed, unlike the timings above. Deliberate: presence answers "does this
   *  run at all?", and a system gated off by `runPipeline` while the sim is stopped should read
   *  as rarely-running rather than resetting to 100% the moment the window rolls past its last
   *  appearance. Consumers must not present it as a property of the same window as `selfMs`. */
  presence: number;
}

export interface MarkerAggregate {
  framesRecorded: number;
  /** Flat, sorted by median self ms descending — "what do I fix?". */
  ranking: MarkerStat[];
  /** The most recent frame's tree, for structure. */
  tree: MarkerSample | null;
  /** Distinct marker paths tracked. */
  trackedPaths: number;
  /** True once `MAX_TRACKED_PATHS` was hit — the ranking is then incomplete, and saying so
   *  matters more than the missing rows. */
  truncated: boolean;
}

let truncated = false;

/** Fold one frame's tree into the window. Called once per frame after `endProfilerFrame()`.
 *  Walks the tree (tens to low hundreds of nodes) and writes one slot per marker — no
 *  allocation once each marker's series exists. */
export function recordMarkerFrame(): void {
  if (!isProfilerEnabled()) return;
  const tree = getMarkerTree();
  if (!tree) return;
  framesRecorded++;
  walk(tree, '');
}

function walk(node: MarkerSample, parentPath: string): void {
  const path = parentPath === '' ? node.name : `${parentPath}/${node.name}`;
  let s = series.get(path);
  if (s === undefined) {
    if (series.size >= MAX_TRACKED_PATHS) { truncated = true; return; }
    s = {
      path, name: node.name, depth: parentPath === '' ? 0 : parentPath.split('/').length,
      self: new Float64Array(MARKER_WINDOW_FRAMES),
      total: new Float64Array(MARKER_WINDOW_FRAMES),
      callsSum: 0, framesSeen: 0, write: 0, filled: 0,
    };
    series.set(path, s);
  }
  s.self[s.write] = node.selfMs;
  s.total[s.write] = node.totalMs;
  s.write = (s.write + 1) % MARKER_WINDOW_FRAMES;
  if (s.filled < MARKER_WINDOW_FRAMES) s.filled++;
  s.callsSum += node.calls;
  s.framesSeen++;
  for (let i = 0; i < node.children.length; i++) walk(node.children[i], path);
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

function median(buf: Float64Array, filled: number): number {
  if (filled === 0) return 0;
  const a: number[] = [];
  for (let i = 0; i < filled; i++) a.push(buf[i]);
  a.sort((x, y) => x - y);
  return pct(a, 0.5);
}

function p95(buf: Float64Array, filled: number): number {
  if (filled === 0) return 0;
  const a: number[] = [];
  for (let i = 0; i < filled; i++) a.push(buf[i]);
  a.sort((x, y) => x - y);
  return pct(a, 0.95);
}

function maxOf(buf: Float64Array, filled: number): number {
  let m = 0;
  for (let i = 0; i < filled; i++) if (buf[i] > m) m = buf[i];
  return m;
}

/** Summarise the window. Allocates — this is the read path (a panel repaint, an MCP call), and
 *  the per-frame cost lives entirely in `recordMarkerFrame`. */
export function getMarkerAggregate(): MarkerAggregate {
  const ranking: MarkerStat[] = [];
  for (const s of series.values()) {
    if (s.filled === 0) continue;
    // Drop the synthetic root. `frame` is the tree's container, not a measured span — nothing
    // ever samples it, so it contributes a permanent all-zero row. Harmless in the tree view
    // (where it IS the structure) and pure noise in a ranking, where it costs a slot in the
    // top-N an agent pays response budget for. Found by reading a live editor, not a test.
    if (s.depth === 0) continue;
    ranking.push({
      path: s.path,
      name: s.name,
      depth: s.depth,
      selfMs: median(s.self, s.filled),
      selfP95: p95(s.self, s.filled),
      selfMax: maxOf(s.self, s.filled),
      totalMs: median(s.total, s.filled),
      callsPerFrame: s.framesSeen > 0 ? s.callsSum / s.framesSeen : 0,
      presence: framesRecorded > 0 ? Math.min(1, s.framesSeen / framesRecorded) : 0,
    });
  }
  ranking.sort((a, b) => b.selfMs - a.selfMs);
  return {
    framesRecorded,
    ranking,
    tree: getMarkerTree(),
    trackedPaths: series.size,
    truncated,
  };
}

/** Top `n` markers by median self time — the response-budget-friendly form, and what a
 *  summary-first agent call returns before any filter is applied. */
export function getMarkerRanking(n: number): MarkerStat[] {
  return getMarkerAggregate().ranking.slice(0, n);
}

/** Drop the window. For tests, and for measuring one specific action cleanly. */
export function resetMarkerAggregate(): void {
  series.clear();
  framesRecorded = 0;
  truncated = false;
}
