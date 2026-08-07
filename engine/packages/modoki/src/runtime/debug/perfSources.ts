/** Shared performance data sources for the Stats launcher + the floating FPS/
 *  Memory/GPU widgets. All read already-ticking runtime state (no new frame cost). */

import { getCurrentFPS } from '../rendering/frameDriver';
import { getActiveRenderer } from '../loaders/textureResolver';
import { readRendererBackend } from '../core/activeRenderer';
import { getAllEntities } from '../core/ecs/entityUtils';
import { getFrameProfile } from '../core/frameProfiler';
import { isProfilerEnabled, getMarkerFaults, type MarkerFaults } from '../core/profilerMarkers';
import { getMarkerAggregate, type MarkerStat } from '../core/profilerAggregate';
import { getCounters, type CounterStat } from '../core/profilerCounters';

export const MB = 1024 * 1024;

export function getFps(): number {
  return getCurrentFPS();
}

export interface MemInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}
/** Chromium-only (empty on iOS WKWebView). */
export function readMemory(): MemInfo | null {
  const m = (performance as Performance & { memory?: MemInfo }).memory;
  return m && typeof m.usedJSHeapSize === 'number' ? m : null;
}

export interface RendererStats {
  backend: string;
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number | null;
}
interface RendererInfoLike {
  isWebGPURenderer?: boolean;
  info?: {
    render?: { calls?: number; drawCalls?: number; triangles?: number };
    memory?: { geometries?: number; textures?: number };
    programs?: unknown[];
  };
}
export function readRenderer(): RendererStats | null {
  const r = getActiveRenderer() as unknown as RendererInfoLike | null;
  if (!r) return null;
  const render = r.info?.render ?? {};
  const memory = r.info?.memory ?? {};
  return {
    // The API in use, not the renderer CLASS (#147) — `isWebGPURenderer` is true even when three
    // is running its WebGL2 backend inside the same object, which is the case on every device
    // without an adapter. Shared with `deviceCaps.backend` so the two can't disagree.
    // `readRendererBackend` returns null ONLY for a null renderer, and `r` is non-null by here
    // (early-returned above) — so 'unknown' is unreachable rather than a default. Saying that
    // out loud beats `?? 'WebGL'`, which would silently answer WebGL if the invariant ever moved.
    backend: readRendererBackend(r) ?? 'unknown',
    // PER-FRAME draw calls. WebGPU's Info keeps `render.calls` as a LIFETIME
    // cumulative counter (climbs forever — looks like a leak) and exposes the
    // per-frame count as `render.drawCalls`; WebGL only has `render.calls` (which it
    // DOES reset per frame). So prefer drawCalls, fall back to calls.
    calls: render.drawCalls ?? render.calls ?? 0,
    triangles: render.triangles ?? 0,
    geometries: memory.geometries ?? 0,
    textures: memory.textures ?? 0,
    programs: Array.isArray(r.info?.programs) ? r.info!.programs!.length : null,
  };
}

export function getEntityCount(): number {
  return getAllEntities().length;
}

/** One read answering "is this device coping, and if not, with what?" (#121 P2).
 *
 *  Joins the three sources that have to be read TOGETHER to be interpretable — timings, draw
 *  load, and memory. Read apart they mislead: 83 ms frames say a device is struggling but not
 *  why; 237 draw calls is only alarming next to the CPU cost of submitting them; and a texture
 *  figure on its own already caused one fix to ship against the wrong bottleneck (see
 *  `core/frameProfiler`'s header).
 *
 *  Renderer/memory fields are null when unavailable — no renderer mounted yet, or a non-Chromium
 *  engine with no `performance.memory` (i.e. all of iOS). Absent, never faked. */
export function readPerfProfile(opts: { markers?: number } = {}): {
  frame: ReturnType<typeof getFrameProfile>;
  renderer: RendererStats | null;
  memoryMB: { used: number; limit: number } | null;
  entities: number;
  markers?: {
    framesRecorded: number;
    /** Worst `n` by median SELF time — "what do I fix?". */
    top: MarkerStat[];
    /** Present only when non-zero: an incomplete tree must announce itself, since a silently
     *  truncated profile reads exactly like a complete one. */
    faults?: MarkerFaults;
    truncated?: boolean;
  };
  /** Game-authored counters (P9). Omitted when none are registered — an empty array would
   *  imply a game that declared none, which is the same thing but reads as a finding. */
  counters?: CounterStat[];
} {
  const mem = readMemory();
  return {
    frame: getFrameProfile(),
    renderer: readRenderer(),
    memoryMB: mem
      ? { used: +(mem.usedJSHeapSize / MB).toFixed(1), limit: +(mem.jsHeapSizeLimit / MB).toFixed(1) }
      : null,
    entities: getEntityCount(),
    ...markerFields(opts.markers ?? DEFAULT_MARKER_ROWS),
    ...counterFields(),
  };
}

function counterFields(): { counters?: CounterStat[] } {
  if (!isProfilerEnabled()) return {};
  const { counters } = getCounters();
  return counters.length ? { counters } : {};
}

/** Rows returned before any filter is applied. **Summary-first**
 *  ([docs/debug-tools-mcp.md](../../../../../docs/debug-tools-mcp.md)): the full marker tree in
 *  every response would blow the budget on a payload nobody read, and the worst handful by self
 *  time is what answers the question anyway. Ask `getMarkerAggregate()` for the whole thing. */
export const DEFAULT_MARKER_ROWS = 8;

/** Omitted ENTIRELY when profiling is off, rather than reported as an empty ranking — "no
 *  markers recorded" and "markers not running" are different facts and must not look alike. */
function markerFields(n: number): { markers?: ReturnType<typeof readPerfProfile>['markers'] } {
  if (!isProfilerEnabled()) return {};
  const agg = getMarkerAggregate();
  const faults = getMarkerFaults();
  const anyFault = faults.unbalancedEnds > 0 || faults.depthTruncated > 0 || faults.nodeCapHit > 0;
  return {
    markers: {
      framesRecorded: agg.framesRecorded,
      top: agg.ranking.slice(0, n),
      ...(anyFault ? { faults } : {}),
      ...(agg.truncated ? { truncated: true } : {}),
    },
  };
}
