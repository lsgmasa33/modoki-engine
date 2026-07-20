/** Shared performance data sources for the Stats launcher + the floating FPS/
 *  Memory/GPU widgets. All read already-ticking runtime state (no new frame cost). */

import { getCurrentFPS } from '../rendering/frameDriver';
import { getActiveRenderer } from '../loaders/textureResolver';
import { getAllEntities } from '../ecs/entityUtils';

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
    backend: r.isWebGPURenderer ? 'WebGPU' : 'WebGL',
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
