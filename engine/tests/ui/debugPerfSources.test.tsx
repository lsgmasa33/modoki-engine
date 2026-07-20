/** perfSources.readRenderer — draw-call field selection (regression).
 *
 *  WebGPU's Info keeps `render.calls` as a LIFETIME cumulative counter (climbs
 *  forever — looks like a leak) and exposes the per-frame count as `render.drawCalls`;
 *  WebGL only has `render.calls` (reset per frame). readRenderer must report the
 *  PER-FRAME value on both backends. */

import { describe, it, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({ renderer: null as unknown }));
vi.mock('../../packages/modoki/src/runtime/loaders/textureResolver', () => ({
  getActiveRenderer: () => state.renderer,
}));

import { readRenderer } from '../../packages/modoki/src/runtime/debug/perfSources';

describe('readRenderer draw-call selection', () => {
  it('prefers per-frame drawCalls over the cumulative calls (WebGPU)', () => {
    state.renderer = {
      isWebGPURenderer: true,
      info: { render: { calls: 999999, drawCalls: 150, triangles: 1200 }, memory: { geometries: 44, textures: 19 } },
    };
    const r = readRenderer()!;
    expect(r.backend).toBe('WebGPU');
    expect(r.calls).toBe(150); // NOT the climbing 999999
    expect(r.geometries).toBe(44);
  });

  it('falls back to calls when drawCalls is absent (WebGL, per-frame)', () => {
    state.renderer = { isWebGPURenderer: false, info: { render: { calls: 120, triangles: 3000 }, memory: {} } };
    const r = readRenderer()!;
    expect(r.backend).toBe('WebGL');
    expect(r.calls).toBe(120);
  });

  it('returns null when no renderer is active', () => {
    state.renderer = null;
    expect(readRenderer()).toBeNull();
  });
});
