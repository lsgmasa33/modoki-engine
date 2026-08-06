/** Frame capture (profiler plan P6) — record N frames of marker trees and step through them.
 *
 *  The aggregate answers "what costs me time consistently". A capture answers the other half:
 *  **"what happened in THAT frame?"** — the 200 ms hitch, the frame a scene loaded on, the one
 *  where a system ran 40x instead of once. A window of medians cannot show a single frame by
 *  construction, which is exactly why `selfMax` had to be added to the aggregate to hint that
 *  such frames exist at all. This is how you then go and look at one.
 *
 *  ── EXPLICITLY STARTED, UNLIKE THE AGGREGATE ──────────────────────────────────────────────
 *  Aggregation is always on because it is O(1) memory. A capture retains a whole tree per frame,
 *  so it is bounded (`MAX_CAPTURE_FRAMES`) and opt-in. It stops itself on reaching the cap rather
 *  than wrapping: you press record because something is about to happen, and the interesting part
 *  is the beginning, not a ring that has already discarded it.
 *
 *  ── JSON, NOT AN OPAQUE BLOB ──────────────────────────────────────────────────────────────
 *  `exportCapture()` produces plain JSON. Unity's captures are a binary format only its own
 *  window reads; ours is diffable, attachable to an issue, and — the point — readable by an
 *  agent. A capture taken on a phone can be reasoned about without anyone holding the phone. */

import { getMarkerTree, isProfilerEnabled, type MarkerSample } from './profilerMarkers';

/** Hard ceiling on retained frames. At ~60fps this is ~5s, which is far longer than any hitch
 *  worth inspecting, and bounds the memory a capture can hold on a 2 GB phone. */
export const MAX_CAPTURE_FRAMES = 300;

export interface CapturedFrame {
  /** Frame number within the capture, from 0. */
  index: number;
  /** Wall time since the capture started, ms. Lets a reader find "the hitch at ~1.2s". */
  atMs: number;
  /** Total frame ms, as measured by the caller (frameDriver). */
  frameMs: number;
  /** Engine main-thread ms for this frame. */
  cpuMs: number;
  tree: MarkerSample;
}

export interface CaptureState {
  capturing: boolean;
  frames: CapturedFrame[];
  /** Set when capture stopped because it filled, rather than by request. */
  stoppedByCap: boolean;
}

let capturing = false;
let frames: CapturedFrame[] = [];
let startedAt = 0;
let elapsed = 0;
let stoppedByCap = false;

/** Begin capturing. Discards any previous capture — a capture is a deliberate act with a
 *  question behind it, and silently appending to an older one would answer a different one. */
export function startCapture(): void {
  frames = [];
  elapsed = 0;
  startedAt = 0;
  stoppedByCap = false;
  capturing = true;
}

export function stopCapture(): void {
  capturing = false;
}

export function isCapturing(): boolean {
  return capturing;
}

/** Record the frame that just ended. Called by `frameDriver` after `endProfilerFrame()`.
 *
 *  Deep-copies the tree: the live tree's nodes are REUSED across frames (that is what makes the
 *  steady state allocation-free), so retaining a reference would give every captured frame the
 *  same object, all showing the latest numbers. The copy is the whole cost of capturing and is
 *  the reason this is opt-in. */
export function captureFrame(frameMs: number, cpuMs: number): void {
  if (!capturing || !isProfilerEnabled()) return;
  const tree = getMarkerTree();
  if (!tree) return;
  if (startedAt === 0) startedAt = 1; // mark started; elapsed accumulates from frame deltas
  else elapsed += frameMs;
  frames.push({ index: frames.length, atMs: elapsed, frameMs, cpuMs, tree: cloneTree(tree) });
  if (frames.length >= MAX_CAPTURE_FRAMES) {
    capturing = false;
    stoppedByCap = true;
  }
}

function cloneTree(n: MarkerSample): MarkerSample {
  const children: MarkerSample[] = new Array(n.children.length);
  for (let i = 0; i < n.children.length; i++) children[i] = cloneTree(n.children[i]);
  return { name: n.name, totalMs: n.totalMs, selfMs: n.selfMs, calls: n.calls, children };
}

export function getCapture(): CaptureState {
  return { capturing, frames, stoppedByCap };
}

/** The captured frame with the highest total frame time — "jump to the hitch", which is the
 *  first thing anyone wants after recording one. Null when nothing is captured. */
export function getWorstCapturedFrame(): CapturedFrame | null {
  let worst: CapturedFrame | null = null;
  for (const f of frames) if (worst === null || f.frameMs > worst.frameMs) worst = f;
  return worst;
}

export function clearCapture(): void {
  frames = [];
  capturing = false;
  elapsed = 0;
  startedAt = 0;
  stoppedByCap = false;
}

/** Serialise the capture. Plain JSON on purpose — see the module header. */
export function exportCapture(): {
  version: 1;
  frameCount: number;
  stoppedByCap: boolean;
  frames: CapturedFrame[];
} {
  return { version: 1, frameCount: frames.length, stoppedByCap, frames };
}
