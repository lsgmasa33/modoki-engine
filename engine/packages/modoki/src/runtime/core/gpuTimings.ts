/** GPU timing via timestamp queries (profiler plan P7) — the instrument `restMs` cannot be.
 *
 *  ── WHY THIS PHASE EXISTS ─────────────────────────────────────────────────────────────────
 *  `frameProfiler.restMs` is `frameMs - cpuMs`: GPU + present + IDLE, all three at once, by
 *  construction. That was documented as a caveat until it became the blocker. `games/3d-test` on
 *  a Galaxy A23 hitches to ~113.5-113.9 ms frames containing only 14.9-47.4 ms of engine CPU;
 *  TWO rounds of CPU markers (including splitting `render3d-0` into `sync`/`submit`) failed to
 *  find the missing 66-99 ms, which rules out engine main-thread work and leaves no instrument
 *  that can see where the time went. A third round of markers would spend effort where the
 *  evidence says the time is not. This is the instrument that can answer it.
 *
 *  ── OFF BY DEFAULT COSTS NOTHING, AND ENABLING NEEDS NO RENDERER REBUILD ──────────────────
 *  The load-bearing fact, checked against three r0.184 rather than assumed:
 *  `WebGPUBackend.init()` requests EVERY adapter-supported feature at device creation
 *  (`requiredFeatures: supportedFeatures`) — not merely the ones `trackTimestamp` asks for. So
 *  `timestamp-query` is already enabled on the device whenever the adapter has it, and the query
 *  pool is created lazily by `initTimestampQuery` on the first pass after the flag flips.
 *
 *  That is what makes the plan's overhead rule satisfiable: `backend.trackTimestamp` can be
 *  toggled at RUNTIME. Disabled, this module costs one module-scope boolean test per frame and
 *  the renderer allocates no query set at all. If instead we had to construct the renderer with
 *  `trackTimestamp: true`, every shipped game would pay query-set allocation and per-pass
 *  timestamp writes forever, to serve a panel almost nobody opens.
 *
 *  ⚠️ Because the flag is flipped AFTER `init()`, three's own
 *  `trackTimestamp && hasFeature(TimestampQuery)` guard has already run and cannot protect us.
 *  Feature detection is therefore OURS to do — see `probeSupport`.
 *
 *  ── THE NUMBERS ARE ASYNCHRONOUS, SO THEY CANNOT JOIN THE MARKER TREE ─────────────────────
 *  Resolving a timestamp means mapping a GPU buffer: frame N's GPU ms lands 1-3 frames later.
 *  `profilerMarkers`' tree zeroes its accumulators every frame, so a late arrival would be
 *  attributed to whatever frame happened to be open — a plausible-looking number about the wrong
 *  frame, which is the exact failure class this plan keeps warning about. GPU samples therefore
 *  live in their OWN ring, keyed by the frame id three stamps into each query uid, and
 *  `lagFrames` reports how far behind the newest sample is rather than pretending it is current.
 *
 *  ── UNAVAILABLE MUST READ AS UNAVAILABLE, NEVER AS ZERO ──────────────────────────────────
 *  three's `WebGLTimestampQueryPool` turns itself off when `EXT_disjoint_timer_query_webgl2` is
 *  missing, which is most mobile — the WebGL fallback path this engine actually ships to low-end
 *  Android on. A missing measurement reports `status: 'unsupported'` and omits the numbers
 *  entirely. It must never quietly upgrade an inference into a claim; that is the whole reason
 *  `restMs` was left honest instead of being relabelled GPU time. */

import { getActiveRenderer } from './activeRenderer';
import { PROFILE_WINDOW_FRAMES, summarizeStat, type FrameStat } from './frameProfiler';
import { createTeardownToken } from './liveness';

/** Distinct pass labels retained. A label is authored by engine code (`gpuPassScope`), not
 *  derived from scene data, so this is a guard against a runaway caller rather than an expected
 *  limit — the same reasoning as `MAX_MARKER_NODES`. */
export const MAX_GPU_PASS_LABELS = 32;

/** Pass ranges held awaiting their frame's timestamps. Bounded generously — a resolve spans
 *  several frames and each contributes a range per scope, so this is sized for the readback
 *  latency, not for the number of distinct labels. */
export const MAX_PENDING_RANGES = 512;

/** A resolve that has not settled within this many frames is assumed lost (a device loss mid-map,
 *  a backend swap) and the in-flight latch is released, so one stuck readback cannot wedge the
 *  channel for the rest of the session. */
const RESOLVE_STUCK_FRAMES = 240;

export type GpuTimingStatus =
  /** Never enabled. The renderer allocates no query set; this module is one branch per frame. */
  | 'off'
  /** Enabled, but no renderer has registered yet. Transient during bring-up. */
  | 'no-renderer'
  /** Enabled and the backend cannot do it — WebGL2 without `EXT_disjoint_timer_query_webgl2`, or
   *  a WebGPU adapter without `timestamp-query`. NOT a zero: the numbers are omitted. */
  | 'unsupported'
  /** Enabled and supported, but no sample has resolved yet. Expect a few frames. */
  | 'pending'
  /** Samples are flowing. */
  | 'active';

export interface GpuPassStat {
  /** The label a `gpuPassScope` gave this range, or `pass[n]` for a render call we did not name. */
  name: string;
  ms: FrameStat;
  /** Render calls attributed to this label in the most recent resolved frame. A post-FX chain is
   *  one scope but many internal three render contexts, so this is how a lump is seen as a lump. */
  calls: number;
}

export interface GpuProfile {
  status: GpuTimingStatus;
  /** Which backend answered — present once we have looked. */
  backend?: 'WebGPU' | 'WebGL';
  /** Why the numbers are missing, in words, when `status` is not `'active'`. Present so a reader
   *  never has to infer absence from a missing field. */
  detail?: string;
  /** Frames with a resolved GPU sample in the window. Below ~20 the percentiles are not worth
   *  quoting, exactly as with `frameProfile.samples`. */
  samples?: number;
  /** Total GPU-busy time per frame, summed across every render call in that frame. */
  gpuMs?: FrameStat;
  /** Per-pass breakdown, biggest median first. */
  passes?: GpuPassStat[];
  /** Frames between the newest resolved sample and the frame being rendered now. GPU numbers
   *  TRAIL — reported rather than hidden, so nobody reads a stale number as live. */
  lagFrames?: number;
  /** Resolves that failed (a mapped buffer, a device loss). Non-zero next to a healthy profile
   *  means the window is sparser than `samples` alone suggests. */
  errors?: number;
  /** The adapter's apparent timestamp quantum: the greatest common divisor of every duration
   *  observed this session. Reported rather than smoothed away.
   *
   *  It matters because browsers deliberately COARSEN GPU timestamps — a fine-grained one is a
   *  side channel — and the coarsening is big enough to change how a number should be read.
   *  Measured 0.065536 ms (2^16 ns) on an Apple-Silicon WebGPU adapter, where every observed
   *  duration was an exact integer multiple of it. A pass reported as 0.262144 ms is really
   *  "4 ticks", so digits past the quantum are an artefact of the division, not precision.
   *
   *  ⚠️ This is an UPPER BOUND on the true period, not the period itself: a GCD over the values
   *  we happened to see can only be a multiple of the real quantum, and it tightens as more
   *  distinct durations arrive. Stated that way on purpose — the smallest observed DURATION was
   *  the first thing tried here and read 4x coarser than the truth, which is precisely the kind
   *  of confidently-wrong number this module exists not to publish. */
  resolutionMs?: number;
}

// ── State ────────────────────────────────────────────────────────────────────────────────────
// Rings, pre-sized and reused — a profiler that allocates per frame is measuring itself.

let enabled = false;
let status: GpuTimingStatus = 'off';
let backendKind: 'WebGPU' | 'WebGL' | undefined;
let detail: string | undefined;
/** The renderer we last flipped the flag on, so a viewport remount re-arms rather than silently
 *  leaving the new renderer untracked. */
let armedRenderer: unknown = null;
let resolveInFlight = false;
let resolveStartedAtFrame = 0;
let errors = 0;
/** Teardown liveness for the measurement session. Invalidated by every event that stales results
 *  already in flight: enable, disable, reset, and a renderer swap.
 *
 *  ── WHY A TOKEN AND NOT A FLAG CHECK IN `drain` ────────────────────────────────────────────
 *  A resolve takes 1-5 frames to land, so ANY of those events can happen while one is in the air,
 *  and the promise closure keeps its own renderer. Without this, a `resetGpuTimings()` — whose
 *  entire documented purpose is "a clean measurement around a specific action" — is immediately
 *  polluted by the previous action's samples arriving late, and `status` flips back to `'active'`
 *  carrying them. Disable/re-enable has the same shape.
 *
 *  The token also protects the LATCH: a stale `.finally` clearing `resolveInFlight` would release
 *  a latch that now belongs to a newer resolve, letting two run concurrently against one pool and
 *  double-drain it.
 *
 *  The same TOKEN as `frameDriver`'s rAF chain — though note that one is a
 *  supersession token (a re-arm wins) and this is a teardown token (an invalidate wins); both now
 *  come from `runtime/core/liveness.ts`, and `loopGen` no longer exists: make the stale-result
 *  class unrepresentable rather than guarding each site that could publish one. */
const liveness = createTeardownToken();

const totalSamples = new Float64Array(PROFILE_WINDOW_FRAMES);
const sampleFrameIds = new Float64Array(PROFILE_WINDOW_FRAMES);
let writeIndex = 0;
let filled = 0;
let newestFrameId = -1;
/** Running GCD of observed durations, in whole NANOSECONDS — three divides a `BigUint64Array` of
 *  ns by 1e6 to hand us ms, so ns is where the values are actually integral and a GCD is exact.
 *  Doing it in ms would fold float error into the divisor and yield 1-ulp nonsense. 0 = nothing
 *  seen yet. See `resolutionMs`. */
let quantumNs = 0;

function gcd(a: number, b: number): number {
  while (b > 0) { const t = a % b; a = b; b = t; }
  return a;
}

/** label -> per-frame ms, written at the same `writeIndex` as `totalSamples` so a pass's window
 *  and the total's window describe the same frames. */
const passRings = new Map<string, Float64Array>();
const passCalls = new Map<string, number>();

/** Ranges of render-call ordinals claimed by a `gpuPassScope` in the frame being ENCODED now.
 *  Consumed when that frame's timestamps resolve, which is why they are keyed by frame id. */
interface PassRange { frameId: number; from: number; to: number; label: string }
let pendingRanges: PassRange[] = [];

// ── Enable / disable ─────────────────────────────────────────────────────────────────────────

/** Turn GPU timing on or off. Returns the resulting status so a caller that flipped it on gets an
 *  immediate, honest answer about whether this device can actually do it. */
export function setGpuTimingEnabled(on: boolean): GpuTimingStatus {
  if (enabled === on) return status;
  enabled = on;
  if (!on) {
    disarm();
    status = 'off';
    detail = undefined;
    return status;
  }
  arm();
  return status;
}

export function isGpuTimingEnabled(): boolean {
  return enabled;
}

/** Reach through three's backend and flip the flag, after doing the feature check three's own
 *  init-time guard can no longer do for us (see the header). Never throws into the caller: the
 *  WebGPU backend internals are not a stable public API and have moved before — a failure here
 *  means no GPU numbers, not a broken frame loop. */
function arm(): void {
  const renderer = getActiveRenderer();
  if (!renderer) {
    status = 'no-renderer';
    detail = 'GPU timing is enabled but no renderer has registered yet. It will arm itself on the ' +
      'first frame after one does.';
    return;
  }
  // The OUTGOING renderer is being displaced (a relaunch, a viewport remount) and never goes
  // through `disarm()` — nothing else clears its `trackTimestamp` flag, so left alone it would keep
  // writing GPU timestamp queries every frame for as long as the process lives (#810, reachable
  // only while the profiler is enabled). Clear it, and purge its pool for the same reason
  // `purgePool`'s own doc comment gives — a resolve landing for it after this point would otherwise
  // file a stale sample under the NEW renderer's frame counter.
  //
  // ⚠️ This runs BEFORE the support probe, not inside the success path below. The incoming renderer
  // may be the one that cannot time (the editor's two viewports need not share a backend), and on
  // that path we still displaced the old one — leaving the clear until after `probe.ok` would leak
  // exactly the flag this exists to clear, on the one path where nothing later cleans it up.
  const displaced = armedRenderer && armedRenderer !== renderer ? armedRenderer : null;
  if (displaced) {
    clearTrackTimestamp(displaced);
    purgePool(displaced);
    // The old renderer's in-flight work is now unattributable — its frame ids belong to a counter
    // we are leaving behind. Retire it here rather than only in the success path below.
    liveness.invalidateAll();
    resolveInFlight = false;
    pendingRanges = [];
  }
  const probe = probeSupport(renderer);
  backendKind = probe.backend;
  if (!probe.ok) {
    status = 'unsupported';
    detail = probe.reason;
    // Adopt it anyway. `pollGpuTimings`'s "once shown not to support timestamps, stop asking it"
    // guard is `status === 'unsupported' && renderer === armedRenderer` — leaving `armedRenderer`
    // pointing at the DISPLACED renderer makes that test never match, so `arm()` (and its probe)
    // would run again on every single frame. A remount with a different renderer still re-probes,
    // which is what that guard's own comment promises.
    armedRenderer = renderer;
    return;
  }
  try {
    (renderer as { backend?: { trackTimestamp?: boolean } }).backend!.trackTimestamp = true;
    armedRenderer = renderer;
    // A different renderer means a different frame counter and a different query pool. Retire
    // anything in flight for the old one: its `pendingRanges` carry the OLD renderer's frame ids,
    // which the new counter will eventually reach and mis-attribute, and its `resolveStartedAtFrame`
    // would be compared against the new renderer's much lower `info.frame` — leaving the
    // stuck-resolve escape permanently un-trippable.
    liveness.invalidateAll();
    resolveInFlight = false;
    pendingRanges = [];
    status = 'pending';
    detail = 'Enabled; waiting for the first timestamps to resolve (expect a few frames).';
  } catch {
    status = 'unsupported';
    detail = 'The renderer backend refused the trackTimestamp flag.';
  }
}

/** Drop timestamps three has already resolved into its pool but we have not consumed.
 *
 *  The generation token stops a stale resolve WRITING, and that is not sufficient on its own: the
 *  pool's `timestamps` map survives, so the very next drain — after a re-enable, or in a window
 *  the caller reset to be clean — picks up the pre-boundary entries and files them under their
 *  original frame ids. Measured: disable, re-enable, take one 4ms sample, and the window reported
 *  TWO samples with a max of 99ms from before the disable.
 *
 *  We are already the only consumer of that map (three never reads or clears it — see `drain`),
 *  so clearing it here is the same ownership, applied at the other boundary.
 *
 *  Takes the renderer explicitly (rather than reading `armedRenderer`) so `arm()` can purge the
 *  OUTGOING renderer's pool at the moment it is being displaced by a new one (#810) — by then
 *  `armedRenderer` may already point at the replacement, or the caller may want to target a
 *  renderer that was never the current one at all. */
function purgePool(renderer: unknown): void {
  try {
    (renderer as {
      backend?: { timestampQueryPool?: Record<string, { timestamps?: Map<string, number> }> };
    } | null)?.backend?.timestampQueryPool?.render?.timestamps?.clear();
  } catch { /* teardown must never throw */ }
}

/** Clear `trackTimestamp` on `renderer`. Split out of `disarm()` so `arm()` can apply it to the
 *  OUTGOING renderer too (#810) — never throws. */
function clearTrackTimestamp(renderer: unknown): void {
  const r = renderer as { backend?: { trackTimestamp?: boolean } } | null;
  try { if (r?.backend) r.backend.trackTimestamp = false; } catch { /* teardown must not throw */ }
}

function disarm(): void {
  clearTrackTimestamp(armedRenderer);
  // Retire anything in flight: a resolve landing after the caller turned timing OFF would write
  // into the rings, so a later re-enable would open with samples from before the disable.
  liveness.invalidateAll();
  purgePool(armedRenderer);
  armedRenderer = null;
  resolveInFlight = false;
  pendingRanges = [];
}

/** Can this renderer time the GPU at all?
 *
 *  WebGPU: ask the device directly. three already requested every supported feature, so
 *  `device.features` is the ground truth and does not depend on how the renderer was constructed.
 *
 *  WebGL2: `EXT_disjoint_timer_query_webgl2` is frequently absent on mobile — and three's own
 *  `WebGLTimestampQueryPool` responds by setting `trackTimestamp = false` on itself rather than
 *  raising. We cannot see that until a pool exists, so this reports optimistically and
 *  `confirmPool` demotes to `'unsupported'` on the first drain if the pool disowned itself. An
 *  optimistic `'pending'` that self-corrects is safe; the thing that must never happen is a
 *  fabricated NUMBER, and no number is published until a real timestamp resolves. */
function probeSupport(renderer: unknown): { ok: boolean; backend?: 'WebGPU' | 'WebGL'; reason?: string } {
  const backend = (renderer as { backend?: Record<string, unknown> }).backend;
  if (!backend) {
    return { ok: false, reason: 'This renderer exposes no three backend (a test double, or a classic WebGLRenderer).' };
  }
  if (backend.isWebGLBackend === true) {
    const gl = backend.gl as { getExtension?(n: string): unknown } | undefined;
    const ext = gl?.getExtension?.('EXT_disjoint_timer_query_webgl2');
    if (!ext) {
      return {
        ok: false,
        backend: 'WebGL',
        reason: 'This device is running three\'s WebGL2 backend and does not expose ' +
          'EXT_disjoint_timer_query_webgl2, so GPU time cannot be measured here. restMs remains ' +
          'the honest reading: GPU + present + idle, undifferentiated.',
      };
    }
    return { ok: true, backend: 'WebGL' };
  }
  const device = backend.device as { features?: { has(n: string): boolean } } | undefined;
  if (!device?.features) {
    return { ok: false, backend: 'WebGPU', reason: 'The WebGPU backend has no device yet — the renderer has not finished init().' };
  }
  if (!device.features.has('timestamp-query')) {
    return {
      ok: false,
      backend: 'WebGPU',
      reason: 'This WebGPU adapter does not support the timestamp-query feature, so GPU time ' +
        'cannot be measured here. restMs remains the honest reading: GPU + present + idle.',
    };
  }
  return { ok: true, backend: 'WebGPU' };
}

// ── Pass labelling ───────────────────────────────────────────────────────────────────────────

/** Attribute every render call issued by `fn` to `label`.
 *
 *  Three keys each timestamp by a uid of the form `r:<frameCalls>:<contextId>:f<frame>`, where
 *  `frameCalls` is the render-call ordinal within the frame. We do not get a handle on the render
 *  context, so naming works the other way round: read the ordinal counter either side of our own
 *  submit and claim the range between. That is exact, and it survives three renumbering its
 *  internals — which guessing "ordinal 0 is the shadow pass" would not.
 *
 *  ⚠️ THE UID's ORDINAL IS 1-BASED. `Renderer._renderScene` does `info.render.frameCalls++` and
 *  only THEN calls `updateTimeStampUID` (three r0.185.1, Renderer.js:1599 and :1605), so a call
 *  observed with the counter at `from` beforehand is stamped `from + 1`. The claimed range is
 *  therefore the HALF-OPEN-ON-THE-LEFT interval `(from, to]`, not `[from, to)`. Getting this
 *  backwards does not fail loudly — it silently shifts every label by one and drops the last
 *  call to an anonymous `pass[n]`, which is exactly how it was first shipped and caught: the
 *  editor reported `scene#1` and `pass[2]` for a two-call frame that should have read
 *  `scene#0`, `scene#1`.
 *
 *  A post-FX chain is ONE scope containing many internal three passes. Those stay unnamed on
 *  purpose: their ordinals are three's, not ours, and inventing names for them would be the
 *  authoritative-looking guess this plan exists to avoid. They surface as `<label>#<i>` so the
 *  chain can still be seen as several distinct costs rather than one lump. */
export function gpuPassScope<T>(label: string, fn: () => T): T {
  if (!enabled || status === 'unsupported' || status === 'off') return fn();
  const info = readRenderInfo();
  if (!info) return fn();
  const from = info.frameCalls;
  const frameId = info.frame;
  try {
    return fn();
  } finally {
    const after = readRenderInfo();
    if (after && after.frameCalls > from) {
      // Ranges accumulate across every frame rendered since the last resolve, NOT within one
      // frame — a readback takes a few frames and a busy scene renders many in between. Sizing
      // this by the label cap (which is per-frame) silently dropped the newest ranges and left
      // real passes reading `pass[n]`. Drop the OLDEST when full: those frames' timestamps are
      // the ones already past being useful.
      if (pendingRanges.length >= MAX_PENDING_RANGES) pendingRanges.shift();
      pendingRanges.push({ frameId, from, to: after.frameCalls, label });
    }
  }
}

function readRenderInfo(): { frame: number; frameCalls: number } | null {
  const info = (getActiveRenderer() as { info?: { frame?: number; render?: { frameCalls?: number } } } | null)?.info;
  if (!info || typeof info.frame !== 'number' || typeof info.render?.frameCalls !== 'number') return null;
  return { frame: info.frame, frameCalls: info.render.frameCalls };
}

// ── Per-frame poll ───────────────────────────────────────────────────────────────────────────

/** Called once per frame by `frameDriver`. Kicks a resolve and never awaits one — awaiting a
 *  buffer map on the frame loop is precisely the stall this module exists to find.
 *
 *  Exactly one resolve is in flight at a time. three's pool serialises internally anyway
 *  (`pendingResolve`), but a second call would return that same promise and drain a batch we have
 *  already consumed. */
export function pollGpuTimings(): void {
  if (!enabled) return;
  const renderer = getActiveRenderer();
  if (!renderer) return;
  // Once this renderer has been shown not to support timestamps, stop asking it — otherwise a
  // demotion (three's WebGL pool disowning itself mid-run) would leave us resolving every frame
  // forever on the exact devices least able to afford it. A viewport remount re-probes below.
  if (status === 'unsupported' && renderer === armedRenderer) return;
  // A viewport remount hands us a different renderer; re-arm rather than timing a corpse.
  if (renderer !== armedRenderer) { arm(); if (status === 'unsupported' || status === 'no-renderer') return; }
  if (resolveInFlight) {
    const now = readRenderInfo()?.frame ?? 0;
    if (now - resolveStartedAtFrame > RESOLVE_STUCK_FRAMES) resolveInFlight = false;
    return;
  }
  const resolve = (renderer as { resolveTimestampsAsync?(t: string): Promise<unknown> }).resolveTimestampsAsync;
  if (typeof resolve !== 'function') return;
  resolveInFlight = true;
  resolveStartedAtFrame = readRenderInfo()?.frame ?? 0;
  // Capture liveness. A disable / reset / renderer swap between here and the landing makes this
  // result describe a session the caller has already ended — see `liveness`.
  const stillLive = liveness.capture();
  Promise.resolve(resolve.call(renderer, 'render'))
    .then(() => { if (stillLive()) drain(renderer); })
    .catch(() => { if (stillLive()) errors++; })
    .finally(() => { if (stillLive()) resolveInFlight = false; });
}

/** Read the pool's resolved uid -> ms map, group it by frame, and record the completed frames.
 *
 *  ⚠️ The pool's `timestamps` Map is NEVER cleared by three and its keys embed the frame number,
 *  so it grows without bound for as long as tracking is on — an unbounded leak introduced BY the
 *  instrument, which is the overhead rule's own failure mode. Nothing inside three reads it
 *  (`Backend.getTimestamp` exists and has no callers), so we drain it and clear it here. */
function drain(renderer: unknown): void {
  const pool = (renderer as {
    backend?: { timestampQueryPool?: Record<string, { timestamps?: Map<string, number>; trackTimestamp?: boolean }> };
  }).backend?.timestampQueryPool?.render;
  if (!pool) return;
  // The WebGL pool disowns itself when the extension is missing (see `probeSupport`). This is the
  // first moment that is observable, and it must demote rather than publish a zero.
  if (pool.trackTimestamp === false) {
    status = 'unsupported';
    detail = 'three\'s timestamp query pool disabled itself — this backend cannot time the GPU ' +
      '(EXT_disjoint_timer_query_webgl2 is missing). restMs remains the honest reading.';
    return;
  }
  const stamps = pool.timestamps;
  if (!stamps || stamps.size === 0) return;

  // frameId -> { total, per-ordinal ms }
  const byFrame = new Map<number, { total: number; ordinals: Map<number, number> }>();
  for (const [uid, ms] of stamps) {
    const parsed = parseUid(uid);
    if (!parsed) continue;
    let bucket = byFrame.get(parsed.frameId);
    if (!bucket) { bucket = { total: 0, ordinals: new Map() }; byFrame.set(parsed.frameId, bucket); }
    bucket.total += ms;
    bucket.ordinals.set(parsed.ordinal, (bucket.ordinals.get(parsed.ordinal) ?? 0) + ms);
    const ns = Math.round(ms * 1e6);
    if (ns > 0) quantumNs = quantumNs === 0 ? ns : gcd(quantumNs, ns);
  }
  stamps.clear();

  for (const frameId of [...byFrame.keys()].sort((a, b) => a - b)) {
    recordFrameSample(frameId, byFrame.get(frameId)!);
  }
}

/** `r:<frameCalls>:<contextId>:f<frame>` — three's uid scheme (`Backend.updateTimeStampUID`).
 *  A compute uid starts `c:` and is a different pool, so it never reaches here; anything that
 *  does not match is skipped rather than guessed at. */
function parseUid(uid: string): { ordinal: number; frameId: number } | null {
  const m = /^r:(\d+):\d+:f(\d+)$/.exec(uid);
  if (!m) return null;
  return { ordinal: Number(m[1]), frameId: Number(m[2]) };
}

function recordFrameSample(frameId: number, bucket: { total: number; ordinals: Map<number, number> }): void {
  // Attribute each render-call ordinal to whichever scope claimed it in that frame.
  const ranges = pendingRanges.filter((r) => r.frameId === frameId);
  pendingRanges = pendingRanges.filter((r) => r.frameId > frameId);

  const perLabel = new Map<string, number>();
  const perLabelCalls = new Map<string, number>();
  for (const [ordinal, ms] of bucket.ordinals) {
    // `(from, to]` — the uid ordinal is 1-based against the counter we read beforehand. See the
    // warning in `gpuPassScope`.
    const range = ranges.find((r) => ordinal > r.from && ordinal <= r.to);
    // Several render calls inside one scope stay individually visible (`postfx#0`, `postfx#1`)
    // rather than being summed into a lump — a chain whose cost sits in ONE of its passes is the
    // interesting case, and summing would hide it. An unclaimed ordinal is named for what it is.
    const name = range
      ? (range.to - range.from > 1 ? `${range.label}#${ordinal - range.from - 1}` : range.label)
      : `pass[${ordinal}]`;
    perLabel.set(name, (perLabel.get(name) ?? 0) + ms);
    perLabelCalls.set(name, (perLabelCalls.get(name) ?? 0) + 1);
  }

  totalSamples[writeIndex] = bucket.total;
  sampleFrameIds[writeIndex] = frameId;
  for (const [name, ms] of perLabel) {
    let ring = passRings.get(name);
    if (!ring) {
      if (passRings.size >= MAX_GPU_PASS_LABELS) continue;
      ring = new Float64Array(PROFILE_WINDOW_FRAMES);
      passRings.set(name, ring);
    }
    ring[writeIndex] = ms;
  }
  // Labels absent this frame must not carry their previous value forward at this slot.
  for (const [name, ring] of passRings) if (!perLabel.has(name)) ring[writeIndex] = 0;
  passCalls.clear();
  for (const [name, calls] of perLabelCalls) passCalls.set(name, calls);

  writeIndex = (writeIndex + 1) % PROFILE_WINDOW_FRAMES;
  if (filled < PROFILE_WINDOW_FRAMES) filled++;
  if (frameId > newestFrameId) newestFrameId = frameId;
  if (status === 'pending') { status = 'active'; detail = undefined; }
}

// ── Read ─────────────────────────────────────────────────────────────────────────────────────

/** Summarise the window. Pure — safe to call at any cadence from a panel or an MCP payload.
 *
 *  When the numbers are unavailable the numeric fields are ABSENT, not zero. A consumer that
 *  forgets to check `status` gets `undefined` and a visible break, rather than a plausible 0.0 ms
 *  that reads as "the GPU did nothing". */
export function getGpuProfile(): GpuProfile {
  if (status !== 'active') return { status, backend: backendKind, detail, errors: errors || undefined };

  const totals: number[] = [];
  for (let i = 0; i < filled; i++) totals.push(totalSamples[i]);

  const passes: GpuPassStat[] = [];
  // A pass that recorded NOTHING across the whole window is dropped, and its ring released.
  //
  // Not cosmetic: a label lingers after the render order changes (a post-FX stage removed, a
  // transient pass at boot), and a permanent all-zero row then costs a slot in the ranking an
  // agent pays response budget for — the same defect the plan already records for the synthetic
  // `frame` marker root. FOUND ON THE A23, not by a test: the live read carried `pass[1]` and
  // `pass[2]` at a flat zero alongside the two real passes. Releasing the ring also frees the
  // label against MAX_GPU_PASS_LABELS; it is recreated the moment that pass runs again.
  const dead: string[] = [];
  for (const [name, ring] of passRings) {
    const values: number[] = [];
    let any = false;
    for (let i = 0; i < filled; i++) { values.push(ring[i]); if (ring[i] > 0) any = true; }
    if (!any) { dead.push(name); continue; }
    passes.push({ name, ms: summarizeStat(values), calls: passCalls.get(name) ?? 0 });
  }
  for (const name of dead) { passRings.delete(name); passCalls.delete(name); }
  passes.sort((a, b) => b.ms.median - a.ms.median);

  const currentFrame = readRenderInfo()?.frame ?? newestFrameId;
  return {
    status,
    backend: backendKind,
    samples: filled,
    gpuMs: summarizeStat(totals),
    passes,
    lagFrames: Math.max(0, currentFrame - newestFrameId),
    errors: errors || undefined,
    ...(quantumNs > 0 ? { resolutionMs: quantumNs / 1e6 } : {}),
  };
}

/** The most recent frame id with a resolved sample, or -1. */
export function getNewestGpuFrameId(): number {
  return newestFrameId;
}

export interface RestBreakdown {
  /** Median `restMs` — GPU + present + idle, from `frameProfiler`. */
  restMs: number;
  /** Median GPU-busy ms, measured. */
  gpuMs: number;
  /** `restMs - gpuMs`, clamped at 0: present + idle. THE number this phase exists to produce. */
  presentIdleMs: number;
  /** Which one dominates, stated so nobody has to eyeball two numbers:
   *  `'gpu'` — the frame is GPU-bound and optimising CPU will not help.
   *  `'idle'` — the frame is finishing early and waiting; there is headroom.
   *  `'mixed'` — neither dominates. */
  verdict: 'gpu' | 'idle' | 'mixed';
  /** ⚠️ Always true, and stated in the payload on purpose. See the doc below. */
  medianComparison: true;
}

/** Split `restMs` into measured GPU-busy versus present+idle — the question `vsyncBound` could
 *  only ever guess at. Returns null unless real GPU samples exist, never a zero.
 *
 *  ── WHY THIS IS A COMPARISON OF MEDIANS AND NOT A PER-FRAME SUBTRACTION ──────────────────
 *  `frameProfiler` counts rAF frames; three's `info.frame` counts `renderer.render()` calls. Under
 *  render-on-demand — which the editor's SceneView uses — an rAF frame may render NOTHING, so the
 *  two sequences are not the same sequence and cannot be zipped. Subtracting them per frame would
 *  require an alignment that does not exist, and would produce a confident number about a pairing
 *  we invented. `frameProfiler.restMs` itself carries a comment warning against exactly this class
 *  of error (`median(frame) - median(cpu)` is a difference of order statistics from different
 *  frames), so doing it here silently would be worse than not doing it.
 *
 *  So: two medians over two overlapping windows, `medianComparison: true` in the payload, and a
 *  verdict rather than a precise attribution. That is enough to answer the question that
 *  motivated the phase — is the A23's missing 66-99 ms GPU-busy or idle? — and it does not claim
 *  the frame-exact accounting we cannot honestly deliver. */
export function getRestBreakdown(restMedianMs: number): RestBreakdown | null {
  if (status !== 'active' || filled === 0) return null;
  const totals: number[] = [];
  for (let i = 0; i < filled; i++) totals.push(totalSamples[i]);
  const gpuMs = summarizeStat(totals).median;
  const presentIdleMs = Math.max(0, restMedianMs - gpuMs);
  const verdict: RestBreakdown['verdict'] =
    restMedianMs <= 0 ? 'mixed'
    : gpuMs >= restMedianMs * 0.7 ? 'gpu'
    : presentIdleMs >= restMedianMs * 0.7 ? 'idle'
    : 'mixed';
  return { restMs: restMedianMs, gpuMs, presentIdleMs, verdict, medianComparison: true };
}

/** Drop the window, the labels and the in-flight latch. For tests, and for starting a clean
 *  measurement around a specific action rather than reading a window blurred by what preceded it. */
export function resetGpuTimings(): void {
  totalSamples.fill(0);
  sampleFrameIds.fill(0);
  passRings.clear();
  passCalls.clear();
  pendingRanges = [];
  writeIndex = 0;
  filled = 0;
  newestFrameId = -1;
  quantumNs = 0;
  errors = 0;
  // The whole point of a reset is a window that describes what happens NEXT. A resolve already in
  // flight describes what came before, so retire it rather than letting it land in the fresh
  // window and flip `status` back to 'active' carrying the previous action's samples — and purge
  // what three has already resolved but we have not consumed, or the next drain files it anyway.
  liveness.invalidateAll();
  purgePool(armedRenderer);
  resolveInFlight = false;
  if (enabled && status === 'active') status = 'pending';
}

/** Test-only: force the module back to its cold state, including the enable flag. */
export function __resetGpuTimingsForTests(): void {
  enabled = false;
  status = 'off';
  backendKind = undefined;
  detail = undefined;
  armedRenderer = null;
  resetGpuTimings();
}
