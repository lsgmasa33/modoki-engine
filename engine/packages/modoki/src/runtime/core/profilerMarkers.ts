/** Profiler markers (profiler plan P1) — the data model everything else is a view of.
 *
 *  `core/frameProfiler` can say a frame took 83 ms and that ~48 ms of it was CPU. It cannot say
 *  WHAT spent the 48 ms. This is that: named, nested spans of work, accumulated per frame into a
 *  tree, read by the Profiler panel and by Claude over MCP from the same structure.
 *
 *  ── THE TREE IS PERSISTENT; ONLY THE NUMBERS RESET ────────────────────────────────────────
 *  Nodes are created the first time a marker name appears under a given parent and then REUSED
 *  for the life of the process — `beginProfilerFrame()` zeroes the accumulators rather than
 *  rebuilding anything. That is what makes the steady state allocation-free, which the overhead
 *  rule requires: a profiler that distorts what it measures is the same failure class as
 *  "optimising" the wrong bottleneck, just arriving through the instrument instead of the fix.
 *
 *  ── SELF TIME IS DERIVED, NOT ACCUMULATED ─────────────────────────────────────────────────
 *  Each node accumulates only its own total. `self = total - Σ(children totals)`, computed when
 *  the tree is read. Accumulating self time at `endProfilerSample` would mean touching the parent on
 *  every pop and getting it wrong the moment a span is re-entered recursively.
 *
 *  ── COST WHEN DISABLED ────────────────────────────────────────────────────────────────────
 *  One module-scope boolean test and an immediate return — no clock read, no map lookup, no
 *  allocation. `profileScope` still calls through, so a disabled build pays one predictable
 *  branch per scope. Guarded by a test that asserts the disabled path allocates no nodes. */

import { rawNow } from './clock';

/** Deepest nesting recorded. Beyond this, spans are counted as truncated and ignored — a
 *  runaway recursive scope degrades to a counter instead of unbounded memory. */
export const MAX_MARKER_DEPTH = 32;
/** Ceiling on distinct nodes in the tree. A marker name built from per-entity data (the classic
 *  mistake — `beginProfilerSample('enemy-' + id)`) would otherwise grow without bound. */
export const MAX_MARKER_NODES = 512;

export interface MarkerNode {
  name: string;
  /** Wall time inside this span this frame, including children. */
  totalMs: number;
  /** Times this span was entered this frame. */
  calls: number;
  children: MarkerNode[];
  /** O(1) child lookup by name. Same objects as `children`. */
  childIndex: Map<string, MarkerNode>;
  depth: number;
}

/** A read-only view of one node, with self time resolved. What consumers actually get. */
export interface MarkerSample {
  name: string;
  totalMs: number;
  /** `totalMs` minus the sum of children's totals — the time actually spent HERE. */
  selfMs: number;
  calls: number;
  children: MarkerSample[];
}

export interface MarkerFaults {
  /** `endProfilerSample()` with nothing open. Indicates a missing/extra call somewhere. */
  unbalancedEnds: number;
  /** Spans dropped for exceeding `MAX_MARKER_DEPTH`. */
  depthTruncated: number;
  /** Distinct nodes refused for exceeding `MAX_MARKER_NODES`. */
  nodeCapHit: number;
}

function makeNode(name: string, depth: number): MarkerNode {
  return { name, totalMs: 0, calls: 0, children: [], childIndex: new Map(), depth };
}

const root = makeNode('frame', 0);
/** Open spans, innermost last. Pre-sized; `stackDepth` is the live length so pushing and
 *  popping never touches array length (no allocation, no shrink churn). */
const stack: MarkerNode[] = new Array(MAX_MARKER_DEPTH);
const startTimes = new Float64Array(MAX_MARKER_DEPTH);
let stackDepth = 0;
/** Spans discarded for depth — tracked so their `endProfilerSample()` pops nothing. */
let pendingTruncated = 0;
let nodeCount = 1;
let enabled = false;
const faults: MarkerFaults = { unbalancedEnds: 0, depthTruncated: 0, nodeCapHit: 0 };

/** Markers off by default. A shipped game pays one branch per scope; the editor turns them on.
 *  (Whether a shallow always-on mode is right is an open question in the plan — the faults worth
 *  profiling are the ones you cannot reproduce after enabling a flag.) */
export function setProfilerEnabled(on: boolean): void {
  if (enabled === on) return;
  enabled = on;
  // Abandon any half-open spans, or the first frame after a toggle reports garbage.
  stackDepth = 0;
  pendingTruncated = 0;
}

export function isProfilerEnabled(): boolean {
  return enabled;
}

/** Open a span. MUST be matched by exactly one `endProfilerSample()` — prefer `profileScope`, which
 *  cannot leak one. */
export function beginProfilerSample(name: string): void {
  if (!enabled) return;
  if (stackDepth >= MAX_MARKER_DEPTH) {
    pendingTruncated++;
    faults.depthTruncated++;
    return;
  }
  const parent = stackDepth === 0 ? root : stack[stackDepth - 1];
  let node = parent.childIndex.get(name);
  if (node === undefined) {
    if (nodeCount >= MAX_MARKER_NODES) {
      pendingTruncated++;
      faults.nodeCapHit++;
      return;
    }
    node = makeNode(name, parent.depth + 1);
    parent.childIndex.set(name, node);
    parent.children.push(node);
    nodeCount++;
  }
  startTimes[stackDepth] = rawNow();
  stack[stackDepth] = node;
  stackDepth++;
}

/** Close the innermost span. */
export function endProfilerSample(): void {
  if (!enabled) return;
  // A span that was refused (depth/node cap) still calls end — unwind those first so the pairing
  // stays correct instead of closing somebody else's span.
  if (pendingTruncated > 0) {
    pendingTruncated--;
    return;
  }
  if (stackDepth === 0) {
    faults.unbalancedEnds++;
    return;
  }
  stackDepth--;
  const node = stack[stackDepth];
  node.totalMs += rawNow() - startTimes[stackDepth];
  node.calls++;
}

/** Time `fn` as a named span. Exception-safe: a throwing scope still closes, so one bad frame
 *  callback cannot corrupt the stack for the rest of the process. The frame loop already catches
 *  callback throws, so this case is reachable in normal operation, not just in theory. */
export function profileScope<T>(name: string, fn: () => T): T {
  if (!enabled) return fn();
  beginProfilerSample(name);
  try {
    return fn();
  } finally {
    endProfilerSample();
  }
}

/** Start a frame: zero the accumulators, keeping the tree. Called by `frameDriver`. */
export function beginProfilerFrame(): void {
  if (!enabled) return;
  // A frame that ended mid-span (an uncaught throw above the profiler) must not leak into this
  // one — the stack is authoritative per frame.
  stackDepth = 0;
  pendingTruncated = 0;
  resetCounters(root);
}

function resetCounters(node: MarkerNode): void {
  node.totalMs = 0;
  node.calls = 0;
  const kids = node.children;
  for (let i = 0; i < kids.length; i++) resetCounters(kids[i]);
}

/** Close the frame. Any span still open is a bug in the caller, recorded rather than silently
 *  closed — a leaked span would otherwise show as a plausible-looking measurement. */
export function endProfilerFrame(): void {
  if (!enabled) return;
  if (stackDepth > 0) {
    faults.unbalancedEnds += stackDepth;
    stackDepth = 0;
  }
  pendingTruncated = 0;
}

function toSample(node: MarkerNode): MarkerSample {
  const children: MarkerSample[] = [];
  let childTotal = 0;
  for (let i = 0; i < node.children.length; i++) {
    const c = node.children[i];
    // Skip nodes untouched this frame — a marker that ran once at boot should not linger in
    // every later frame's tree as a row of zeroes.
    if (c.calls === 0) continue;
    childTotal += c.totalMs;
    children.push(toSample(c));
  }
  return {
    name: node.name,
    totalMs: node.totalMs,
    selfMs: Math.max(0, node.totalMs - childTotal),
    calls: node.calls,
    children,
  };
}

/** The current frame's tree with self times resolved, or null when profiling is off.
 *
 *  Allocates — deliberately, since this is the READ path (a panel repaint, an MCP call), not the
 *  hot path. The frame-time cost lives entirely in begin/end, which allocate nothing. */
export function getMarkerTree(): MarkerSample | null {
  if (!enabled) return null;
  return toSample(root);
}

/** Counts of things that went wrong. Non-zero means the tree is incomplete — surfaced rather
 *  than swallowed, because a silently truncated profile reads as a complete one. */
export function getMarkerFaults(): MarkerFaults {
  return { ...faults };
}

/** Distinct nodes currently held (against `MAX_MARKER_NODES`). */
export function getMarkerNodeCount(): number {
  return nodeCount;
}

/** Drop the whole tree, the faults and the stack. For tests, and for starting a clean
 *  measurement around a specific action rather than reading a tree blurred by what preceded it. */
export function resetProfilerMarkers(): void {
  root.children.length = 0;
  root.childIndex.clear();
  root.totalMs = 0;
  root.calls = 0;
  stackDepth = 0;
  pendingTruncated = 0;
  nodeCount = 1;
  faults.unbalancedEnds = 0;
  faults.depthTruncated = 0;
  faults.nodeCapHit = 0;
}
