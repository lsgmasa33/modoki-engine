/** loaders/gpuMemoryReport.ts — Phase 3 of #590 (docs/ios-gpu-memory.md).
 *
 *  Three things this file pins:
 *   1. `estimatePixiTextureBytes` — the byte-math the redirected brief actually asked for landed
 *      on (2D/PixiJS, not 3D — three's own `renderer.info.memory.total` is read verbatim for the
 *      3D side, see the module header). Uncompressed, ASTC/BC/ETC2 block sizes, mipmaps, layers.
 *   2. `computeGpuMemoryReport` — per-slot attribution, cross-slot texture dedup, the 3D read.
 *   3. The emission policy — heartbeat vs threshold, and that a STABLE scene cannot flood the
 *      console ring.
 *
 *  `../rendering/canvas2DPool` and `../core/activeRenderer` are mocked so this file never loads
 *  real Pixi/Three; `../core/clock`'s manual clock drives `rawNow()` deterministically alongside
 *  fake timers, so the emission-policy tests don't race real wall-clock time. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const slotsMock = vi.fn<() => Array<{ entityId: number | null; container: unknown }>>(() => []);
const rendererMock = vi.fn<() => unknown>(() => null);

vi.mock('../../src/runtime/rendering/canvas2DPool', () => ({
  getSlotsForMemoryReport: () => slotsMock(),
}));
vi.mock('../../src/runtime/core/activeRenderer', () => ({
  getActiveRenderer: () => rendererMock(),
}));

import {
  estimatePixiTextureBytes, computeGpuMemoryReport,
  startGpuMemorySampling, stopGpuMemorySampling, getGpuMemoryReport,
  __resetGpuMemoryReportForTest,
  SAMPLE_INTERVAL_MS, HEARTBEAT_MS, CHURN_EVENTS_THRESHOLD, MIN_LOG_INTERVAL_MS,
  type PixiTextureSourceLike,
} from '../../src/runtime/loaders/gpuMemoryReport';
import {
  noteGpuContextCreated, noteGpuContextDestroyed, __resetGpuContextTrackingForTest,
} from '../../src/runtime/core/gpuContextTracking';
import { setManualNow, advanceManual, restoreRealClock } from '../../src/runtime/core/clock';
import { setProfilerEnabled } from '../../src/runtime/core/profilerMarkers';

function src(opts: Partial<PixiTextureSourceLike> & { uid: number }): PixiTextureSourceLike & { uid: number } {
  return { pixelWidth: 64, pixelHeight: 64, format: 'rgba8unorm', ...opts };
}

beforeEach(() => {
  slotsMock.mockReturnValue([]);
  rendererMock.mockReturnValue(null);
  __resetGpuContextTrackingForTest();
  __resetGpuMemoryReportForTest();
  setManualNow(0);
});

afterEach(() => {
  __resetGpuMemoryReportForTest();
  __resetGpuContextTrackingForTest();
  restoreRealClock();
  setProfilerEnabled(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('estimatePixiTextureBytes', () => {
  it('uncompressed rgba8unorm: width * height * 4', () => {
    expect(estimatePixiTextureBytes(src({ uid: 1, pixelWidth: 256, pixelHeight: 256, format: 'rgba8unorm' })))
      .toBe(256 * 256 * 4);
  });

  it('uncompressed r8unorm (single channel, e.g. an SDF alpha atlas): 1 byte/pixel', () => {
    expect(estimatePixiTextureBytes(src({ uid: 1, pixelWidth: 128, pixelHeight: 64, format: 'r8unorm' })))
      .toBe(128 * 64 * 1);
  });

  it('uncompressed rgba16float (HDR): 4 channels * 2 bytes', () => {
    expect(estimatePixiTextureBytes(src({ uid: 1, pixelWidth: 32, pixelHeight: 32, format: 'rgba16float' })))
      .toBe(32 * 32 * 8);
  });

  it('ASTC 4x4: 16 bytes per 4x4 block, exact multiple of the block grid', () => {
    // 64x64 at 4x4 blocks = 16x16 = 256 blocks * 16 bytes = 4096.
    expect(estimatePixiTextureBytes(src({ uid: 1, pixelWidth: 64, pixelHeight: 64, format: 'astc-4x4-unorm' })))
      .toBe(4096);
  });

  it('ASTC 8x8: same 16 bytes/block, but a MUCH coarser grid — the block footprint, not just "ASTC", must be read', () => {
    // 64x64 at 8x8 blocks = 8x8 = 64 blocks * 16 bytes = 1024 — 4x smaller than the 4x4 case above
    // for the SAME pixel dimensions, which is exactly the point of block-size-awareness.
    expect(estimatePixiTextureBytes(src({ uid: 1, pixelWidth: 64, pixelHeight: 64, format: 'astc-8x8-unorm' })))
      .toBe(1024);
  });

  it('ASTC dimensions not a multiple of the block size round UP (partial blocks still cost a full block)', () => {
    // 65x65 at 4x4 blocks = ceil(65/4)=17 each way = 289 blocks * 16 = 4624.
    expect(estimatePixiTextureBytes(src({ uid: 1, pixelWidth: 65, pixelHeight: 65, format: 'astc-4x4-unorm' })))
      .toBe(4624);
  });

  it('BC1 (S3TC DXT1, opaque): 8 bytes per 4x4 block — 0.5 bytes/pixel', () => {
    // 256x256 -> 64x64 blocks = 4096 blocks * 8 = 32768.
    expect(estimatePixiTextureBytes(src({ uid: 1, pixelWidth: 256, pixelHeight: 256, format: 'bc1-rgba-unorm' })))
      .toBe(32768);
  });

  it('BC3 (S3TC DXT5, alpha): 16 bytes per 4x4 block — 1 byte/pixel, TWICE bc1 for the same size', () => {
    const bc1 = estimatePixiTextureBytes(src({ uid: 1, pixelWidth: 256, pixelHeight: 256, format: 'bc1-rgba-unorm' }));
    const bc3 = estimatePixiTextureBytes(src({ uid: 1, pixelWidth: 256, pixelHeight: 256, format: 'bc3-rgba-unorm' }));
    expect(bc3).toBe(bc1 * 2);
    expect(bc3).toBe(256 * 256 * 1);
  });

  it('ETC2 RGB8 (no alpha): 8 bytes per 4x4 block, same as BC1', () => {
    expect(estimatePixiTextureBytes(src({ uid: 1, pixelWidth: 256, pixelHeight: 256, format: 'etc2-rgb8unorm' })))
      .toBe(256 * 256 * 0.5);
  });

  it('ETC2 RGBA8 (EAC alpha): 16 bytes per 4x4 block, TWICE the RGB8 variant', () => {
    expect(estimatePixiTextureBytes(src({ uid: 1, pixelWidth: 256, pixelHeight: 256, format: 'etc2-rgba8unorm' })))
      .toBe(256 * 256 * 1);
  });

  it('mipmaps multiply by ~4/3 (the 1 + 1/4 + 1/16 + … series)', () => {
    const base = estimatePixiTextureBytes(src({ uid: 1, pixelWidth: 256, pixelHeight: 256, format: 'rgba8unorm' }));
    const mipped = estimatePixiTextureBytes(src({
      uid: 1, pixelWidth: 256, pixelHeight: 256, format: 'rgba8unorm', mipLevelCount: 9,
    }));
    expect(mipped).toBe(Math.ceil(base * 4 / 3));
  });

  it('a single mip level (mipLevelCount 1, or absent) applies NO multiplier', () => {
    const base = estimatePixiTextureBytes(src({ uid: 1, pixelWidth: 256, pixelHeight: 256, format: 'rgba8unorm' }));
    expect(estimatePixiTextureBytes(src({
      uid: 1, pixelWidth: 256, pixelHeight: 256, format: 'rgba8unorm', mipLevelCount: 1,
    }))).toBe(base);
  });

  it('array layers multiply linearly (e.g. a texture atlas array)', () => {
    const one = estimatePixiTextureBytes(src({ uid: 1, pixelWidth: 64, pixelHeight: 64, format: 'rgba8unorm' }));
    const four = estimatePixiTextureBytes(src({
      uid: 1, pixelWidth: 64, pixelHeight: 64, format: 'rgba8unorm', arrayLayerCount: 4,
    }));
    expect(four).toBe(one * 4);
  });

  it('a zero/absent dimension is 0 bytes, not NaN or a throw', () => {
    expect(estimatePixiTextureBytes(src({ uid: 1, pixelWidth: 0, pixelHeight: 64 }))).toBe(0);
    expect(estimatePixiTextureBytes(src({ uid: 1, pixelWidth: 64, pixelHeight: 0 }))).toBe(0);
  });

  it('an unrecognised format falls back to 4 bytes/pixel (conservative, not silently 0)', () => {
    expect(estimatePixiTextureBytes(src({ uid: 1, pixelWidth: 10, pixelHeight: 10, format: 'totally-unknown' })))
      .toBe(10 * 10 * 4);
  });
});

describe('computeGpuMemoryReport', () => {
  it('sums geometry-free 2D bytes across every live slot, attributed PER SLOT', () => {
    slotsMock.mockReturnValue([
      { entityId: 1, container: { texture: { source: src({ uid: 100, pixelWidth: 64, pixelHeight: 64 }) } } },
      { entityId: 2, container: { texture: { source: src({ uid: 200, pixelWidth: 32, pixelHeight: 32 }) } } },
    ]);
    const report = computeGpuMemoryReport();
    expect(report.perSlotBytes2D).toEqual(expect.arrayContaining([
      { entityId: 1, bytes: 64 * 64 * 4, textureCount: 1 },
      { entityId: 2, bytes: 32 * 32 * 4, textureCount: 1 },
    ]));
    expect(report.gpu2dBytes).toBe(64 * 64 * 4 + 32 * 32 * 4);
    expect(report.textureCount2D).toBe(2);
  });

  it('a texture shared by two slots counts in EACH slot but only ONCE in the global total', () => {
    const shared = src({ uid: 900, pixelWidth: 64, pixelHeight: 64 }); // 16384 bytes
    slotsMock.mockReturnValue([
      { entityId: 1, container: { texture: { source: shared } } },
      { entityId: 2, container: { texture: { source: shared } } },
    ]);
    const report = computeGpuMemoryReport();
    expect(report.perSlotBytes2D.find((s) => s.entityId === 1)!.bytes).toBe(64 * 64 * 4);
    expect(report.perSlotBytes2D.find((s) => s.entityId === 2)!.bytes).toBe(64 * 64 * 4);
    // NOT double-counted globally — this is the whole reason attribution is per-slot rather than
    // just summing every slot's own total into the global figure.
    expect(report.gpu2dBytes).toBe(64 * 64 * 4);
    expect(report.textureCount2D).toBe(1);
  });

  it('walks NESTED children, and dedupes a texture used twice within the SAME slot', () => {
    const tex = src({ uid: 5, pixelWidth: 16, pixelHeight: 16 });
    slotsMock.mockReturnValue([{
      entityId: 7,
      container: {
        children: [
          { texture: { source: tex } },
          { children: [{ texture: { source: tex } }, { texture: { source: null } }] },
        ],
      },
    }]);
    const report = computeGpuMemoryReport();
    expect(report.perSlotBytes2D).toEqual([{ entityId: 7, bytes: 16 * 16 * 4, textureCount: 1 }]);
  });

  it('perSlotBytes2D is sorted DESCENDING by bytes — the biggest slot first', () => {
    slotsMock.mockReturnValue([
      { entityId: 1, container: { texture: { source: src({ uid: 1, pixelWidth: 8, pixelHeight: 8 }) } } },
      { entityId: 2, container: { texture: { source: src({ uid: 2, pixelWidth: 256, pixelHeight: 256 }) } } },
      { entityId: 3, container: { texture: { source: src({ uid: 3, pixelWidth: 64, pixelHeight: 64 }) } } },
    ]);
    const report = computeGpuMemoryReport();
    expect(report.perSlotBytes2D.map((s) => s.entityId)).toEqual([2, 3, 1]);
  });

  it('reads gpu3dBytes VERBATIM from renderer.info.memory.total — no recomputation', () => {
    rendererMock.mockReturnValue({ info: { memory: { total: 12013673, geometries: 2, textures: 2 } } });
    const report = computeGpuMemoryReport();
    expect(report.gpu3dBytes).toBe(12013673);
    expect(report.rendererGeometries).toBe(2);
    expect(report.rendererTextures).toBe(2);
  });

  it('gpu3dBytes is 0 (not null) with no renderer registered — participates cleanly in the sum', () => {
    rendererMock.mockReturnValue(null);
    const report = computeGpuMemoryReport();
    expect(report.gpu3dBytes).toBe(0);
    expect(report.rendererGeometries).toBeNull();
    expect(report.rendererTextures).toBeNull();
  });

  it('totalBytes is the sum of both sides', () => {
    rendererMock.mockReturnValue({ info: { memory: { total: 1000 } } });
    slotsMock.mockReturnValue([{ entityId: 1, container: { texture: { source: src({ uid: 1, pixelWidth: 8, pixelHeight: 8 }) } } }]);
    const report = computeGpuMemoryReport();
    expect(report.totalBytes).toBe(report.gpu3dBytes + report.gpu2dBytes);
    expect(report.totalBytes).toBe(1000 + 8 * 8 * 4);
  });

  it('reports the live GL-context count from the shared tracker', () => {
    noteGpuContextCreated();
    noteGpuContextCreated();
    expect(computeGpuMemoryReport().liveGpuContexts).toBe(2);
  });

  it('reports cumulative context created/destroyed totals from the shared tracker', () => {
    noteGpuContextCreated();
    noteGpuContextCreated();
    noteGpuContextDestroyed();
    const report = computeGpuMemoryReport();
    expect(report.liveGpuContexts).toBe(1);
    expect(report.totalGpuContextsCreated).toBe(2);
    expect(report.totalGpuContextsDestroyed).toBe(1);
  });
});

describe('computeGpuMemoryReport — 2D geometry bytes (#832)', () => {
  interface FakeBuffer { uid: number; data?: { byteLength: number } | null; descriptor?: { size: number } | null }
  function buf(uid: number, byteLength: number): FakeBuffer {
    return { uid, data: { byteLength } };
  }
  function geo(uid: number, buffers: FakeBuffer[]) {
    return { uid, buffers };
  }

  it('sums a live slot mesh geometry\'s buffer bytes', () => {
    slotsMock.mockReturnValue([{
      entityId: 1,
      container: { geometry: geo(0, [buf(0, 100), buf(1, 24)]) },
    }]);
    const report = computeGpuMemoryReport();
    expect(report.geometryBytes2D).toBe(124);
    expect(report.geometryCount2D).toBe(1);
  });

  it('a BUFFER shared between two geometries is counted ONCE — dedup is by buffer uid, not geometry uid', () => {
    const sharedBuffer = buf(0, 1000); // e.g. a batcher-shared vertex buffer
    slotsMock.mockReturnValue([{
      entityId: 1,
      container: {
        children: [
          { geometry: geo(0, [sharedBuffer, buf(1, 10)]) },
          { geometry: geo(1, [sharedBuffer, buf(2, 20)]) },
        ],
      },
    }]);
    const report = computeGpuMemoryReport();
    // If deduped by GEOMETRY uid instead, the shared buffer's 1000 bytes would be added twice
    // (2010 total) instead of once (1030).
    expect(report.geometryBytes2D).toBe(1030);
    expect(report.geometryCount2D).toBe(2);
  });

  it('falls back to descriptor.size when a buffer\'s live data has already been dropped', () => {
    slotsMock.mockReturnValue([{
      entityId: 1,
      container: { geometry: geo(0, [{ uid: 0, data: null, descriptor: { size: 512 } }]) },
    }]);
    expect(computeGpuMemoryReport().geometryBytes2D).toBe(512);
  });

  it('geometryCount2D counts distinct geometries, independent of texture tracking', () => {
    slotsMock.mockReturnValue([{
      entityId: 1,
      container: {
        children: [
          { geometry: geo(0, [buf(0, 10)]) },
          { geometry: geo(1, [buf(1, 10)]) },
          { texture: { source: src({ uid: 900, pixelWidth: 4, pixelHeight: 4 }) } },
        ],
      },
    }]);
    const report = computeGpuMemoryReport();
    expect(report.geometryCount2D).toBe(2);
    expect(report.textureCount2D).toBe(1);
  });
});

// Mirrors the 2D-texture churn suite above, but geometry uses a BOUNDED high-water mark instead
// of a never-forgetting Set — #590 measured ~2,700 text-mesh rebuilds/min, which would make the
// texture pattern (`seenTextureUidsEver`) itself an unbounded leak if reused here verbatim.
describe('computeGpuMemoryReport — cumulative 2D-geometry churn (#832)', () => {
  function geoSlot(uid: number) {
    slotsMock.mockReturnValue([{ entityId: 1, container: { geometry: { uid, buffers: [] } } }]);
  }

  it('creates rise as higher-uid geometries appear', () => {
    geoSlot(0);
    const first = computeGpuMemoryReport();
    expect(first.cumulativeGeometryCreates2D).toBe(1); // uid 0 -> high-water 0 -> 0+1
    geoSlot(1);
    const second = computeGpuMemoryReport();
    expect(second.cumulativeGeometryCreates2D).toBe(2);
  });

  it('releases rise when a previously-live geometry uid is gone next sample', () => {
    geoSlot(0);
    computeGpuMemoryReport();
    slotsMock.mockReturnValue([]); // gone
    const report = computeGpuMemoryReport();
    expect(report.cumulativeGeometryReleases2D).toBe(1);
    expect(report.geometryCount2D).toBe(0);
  });

  it('THE BOUNDED-MECHANISM CASE: thousands of ever-increasing uids track the high-water mark without unbounded retention', () => {
    // A Set-based "ever seen" tally (the texture pattern) would grow one entry per sample here —
    // 3000 of them. The high-water mechanism instead only ever holds a single number, so this
    // loop is the assertion: the counter keeps tracking correctly however long it runs.
    const SAMPLES = 3000;
    for (let uid = 0; uid < SAMPLES; uid++) {
      geoSlot(uid);
      const report = computeGpuMemoryReport();
      expect(report.cumulativeGeometryCreates2D).toBe(uid + 1); // tracks the high-water, uid-dense
      expect(report.geometryCount2D).toBe(1); // the live view stays flat throughout
    }
    const final = computeGpuMemoryReport(); // uid SAMPLES-1 still live, no new uid this call
    expect(final.cumulativeGeometryCreates2D).toBe(SAMPLES);
    expect(final.cumulativeGeometryReleases2D).toBe(SAMPLES - 1); // every prior uid dropped out once
  });

  it('a uid-counter reset does not produce a decreasing or negative cumulative-creates value', () => {
    geoSlot(500);
    const before = computeGpuMemoryReport();
    expect(before.cumulativeGeometryCreates2D).toBe(501);
    geoSlot(3); // simulates pixi.js's uid('geometry') counter having been reset (resetUids())
    const after = computeGpuMemoryReport();
    expect(after.cumulativeGeometryCreates2D).toBe(501); // held, not dropped to 4
    expect(after.cumulativeGeometryCreates2D).toBeGreaterThanOrEqual(before.cumulativeGeometryCreates2D);
    geoSlot(4); // counting resumes past the reset point, but still below the old high-water
    const stillHeld = computeGpuMemoryReport();
    expect(stillHeld.cumulativeGeometryCreates2D).toBe(501);
  });

  it('__resetGpuMemoryReportForTest clears the geometry churn tally too', () => {
    geoSlot(100);
    computeGpuMemoryReport();
    __resetGpuMemoryReportForTest();
    geoSlot(1); // a low uid, post-reset
    const report = computeGpuMemoryReport();
    expect(report.cumulativeGeometryCreates2D).toBe(2); // counted fresh, not held at the old 101
  });
});

// Second device measurement (docs/ios-gpu-memory.md): fps and every live count
// (including `renderer.info.memory`'s and the canvas2DPool slot count) read PERFECTLY FLAT for 16
// minutes up to a confirmed ~296 MB jetsam. These tests pin the cumulative 2D-texture churn tally
// that exists specifically to make that invisible-to-a-snapshot pattern visible.
describe('computeGpuMemoryReport — cumulative 2D-texture churn', () => {
  function slotWith(uid: number) {
    slotsMock.mockReturnValue([{ entityId: 1, container: { texture: { source: src({ uid }) } } }]);
  }

  it('the FIRST sample counts every live texture as a create (nothing to compare against yet)', () => {
    slotWith(100);
    const report = computeGpuMemoryReport();
    expect(report.cumulativeTextureCreates2D).toBe(1);
    expect(report.cumulativeTextureReleases2D).toBe(0);
  });

  it('the SAME texture across samples adds NO further creates', () => {
    slotWith(100);
    computeGpuMemoryReport();
    computeGpuMemoryReport();
    const report = computeGpuMemoryReport();
    expect(report.cumulativeTextureCreates2D).toBe(1); // still 1, not 3
  });

  it('a texture that drops out of the live set between samples counts as a release', () => {
    slotWith(100);
    computeGpuMemoryReport(); // uid 100 live
    slotsMock.mockReturnValue([]); // gone
    const report = computeGpuMemoryReport();
    expect(report.cumulativeTextureReleases2D).toBe(1);
    expect(report.textureCount2D).toBe(0); // the LIVE view already shows it gone
  });

  it('a NEW texture (different uid) after a release is a SECOND create, not a re-use of the first', () => {
    slotWith(100);
    computeGpuMemoryReport();
    slotWith(200); // uid 100 released, uid 200 created
    const report = computeGpuMemoryReport();
    expect(report.cumulativeTextureCreates2D).toBe(2);
    expect(report.cumulativeTextureReleases2D).toBe(1);
  });

  it('THE FLAGSHIP CASE: churn is visible even while the live view stays perfectly flat', () => {
    // Mirrors the device measurement exactly: `textureCount2D` (this instrument's twin of the
    // device's `tex=2`) pinned at 1 on every sample, while the texture churns underneath it — a
    // fresh uid each cycle, exactly what a repeated create/destroy (e.g. canvas2DPool's rebuild-
    // on-context-loss path) would look like from JS's side.
    for (let uid = 0; uid < 20; uid++) {
      slotWith(uid);
      const report = computeGpuMemoryReport();
      expect(report.textureCount2D).toBe(1); // the live view: "nothing is happening"
    }
    slotWith(20);
    const final = computeGpuMemoryReport();
    // The cumulative tally tells the story the live view could not: 21 distinct textures existed
    // (20 in the loop + this call's, uid 20, still live) and 20 were released along the way.
    expect(final.cumulativeTextureCreates2D).toBe(21);
    expect(final.cumulativeTextureReleases2D).toBe(20);
  });

  it('__resetGpuMemoryReportForTest clears the churn tally', () => {
    slotWith(100);
    computeGpuMemoryReport();
    __resetGpuMemoryReportForTest();
    slotWith(100); // the SAME uid, post-reset
    const report = computeGpuMemoryReport();
    expect(report.cumulativeTextureCreates2D).toBe(1); // counted as new again, not carried over
  });
});

describe('GPU-memory sampling + emission policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {}); // startGpuMemorySampling no-ops with no `window`
  });

  /** Advance BOTH the fake interval clock and the manual `rawNow()` clock together by one sample
   *  interval, so `report.sampleTimeMs` and the timer that triggers the sample agree — a report
   *  reads `rawNow()` at the moment its own `setInterval` callback fires. */
  function tick(ms = SAMPLE_INTERVAL_MS) {
    advanceManual(ms);
    vi.advanceTimersByTime(ms);
  }

  it('seeds an immediate first sample on start — a reader is never left with null', () => {
    expect(getGpuMemoryReport()).toBeNull();
    startGpuMemorySampling();
    expect(getGpuMemoryReport()).not.toBeNull();
  });

  it('is idempotent — a second start() creates no second interval for stop() to miss', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    startGpuMemorySampling();
    startGpuMemorySampling(); // must be a no-op (`if (intervalId !== undefined) return;`)
    stopGpuMemorySampling(); // ONE stop call
    const before = getGpuMemoryReport();
    tick(HEARTBEAT_MS * 2);
    // If the redundant start() had wrongly created a SECOND interval, this one stop() would only
    // clear the most recent `intervalId` and the first would keep firing — the report would keep
    // changing (sampleTimeMs at least) after this point.
    expect(getGpuMemoryReport()).toBe(before);
  });

  it('stop() halts sampling — no further console lines, report stops updating', () => {
    startGpuMemorySampling();
    stopGpuMemorySampling();
    const before = getGpuMemoryReport();
    tick(HEARTBEAT_MS * 2);
    expect(getGpuMemoryReport()).toBe(before); // same object — no further sample ran
  });

  it('a STABLE scene logs at most the heartbeat rate — never once per sample', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    startGpuMemorySampling(); // 1 line (the seeded first sample)
    logSpy.mockClear();

    // Advance 5 minutes of a perfectly stable scene, one sample every SAMPLE_INTERVAL_MS.
    const totalMs = 5 * 60_000;
    for (let elapsed = 0; elapsed < totalMs; elapsed += SAMPLE_INTERVAL_MS) tick();

    const sampleCount = totalMs / SAMPLE_INTERVAL_MS;
    const maxHeartbeatLines = Math.ceil(totalMs / HEARTBEAT_MS) + 1; // +1 slack for boundary rounding
    expect(sampleCount).toBeGreaterThan(maxHeartbeatLines * 5); // sanity: many samples, few logs
    expect(logSpy.mock.calls.length).toBeLessThanOrEqual(maxHeartbeatLines);
    expect(logSpy.mock.calls.length).toBeGreaterThan(0); // the heartbeat DOES still fire eventually
  });

  it('a >10% total-bytes swing is detected promptly but held by MIN_LOG_INTERVAL_MS, then logs with the suppressed count', () => {
    slotsMock.mockReturnValue([]);
    rendererMock.mockReturnValue({ info: { memory: { total: 1_000_000 } } });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    startGpuMemorySampling(); // seeds + logs at t=0
    logSpy.mockClear();

    tick(); // stable — well under heartbeat, should NOT log
    expect(logSpy).not.toHaveBeenCalled();

    // +20% qualifies for a line on EVERY sample from here (shouldLog() keeps comparing against the
    // last LOGGED report, which stays the t=0 seed while suppressed) — but each of the next three
    // samples lands inside MIN_LOG_INTERVAL_MS (5000ms) of that last logged line, so the FLOOR, not
    // the swing detector, is what holds them back.
    rendererMock.mockReturnValue({ info: { memory: { total: 1_200_000 } } });
    tick(); // t=3000 — swing detected, suppressed (floor)
    expect(logSpy).not.toHaveBeenCalled();
    tick(); // t=4500 — still suppressed
    expect(logSpy).not.toHaveBeenCalled();
    tick(); // t=6000 — floor has cleared since the last LOGGED line (t=0)
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('[gpuMemory]');
    // The two swallowed-but-real swing samples above ride along on this line, not lost.
    expect(logSpy.mock.calls[0][0]).toContain('(+2 suppressed)');
  });

  it('a live-context change is never delayed by the floor — logs even mid-suppression', () => {
    // Context churn is rare and is the orphan-hypothesis signature (module header) — the ONE
    // signal exempted from MIN_LOG_INTERVAL_MS.
    slotsMock.mockReturnValue([]);
    rendererMock.mockReturnValue({ info: { memory: { total: 1_000_000 } } });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    startGpuMemorySampling(); // seeds + logs at t=0
    logSpy.mockClear();

    rendererMock.mockReturnValue({ info: { memory: { total: 1_200_000 } } }); // +20%, suppressed
    tick(); // t=1500 — inside the floor, suppressed
    expect(logSpy).not.toHaveBeenCalled();

    noteGpuContextCreated();
    tick(); // t=3000 — still inside the floor, but a live-context change bypasses it
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('(+1 suppressed)'); // the swing sample above
  });

  it('a live-context-count change logs promptly, however small the byte swing', () => {
    rendererMock.mockReturnValue({ info: { memory: { total: 1000 } } });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    startGpuMemorySampling();
    logSpy.mockClear();

    tick();
    expect(logSpy).not.toHaveBeenCalled();

    noteGpuContextCreated();
    tick();
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('CHURN past the threshold is detected promptly but held by the floor, then logs with the suppressed count', () => {
    // Total bytes and context count never move; only the 2D-texture create/destroy CHURN does —
    // this is the orphan-hypothesis signature from the module header, and it must not hide behind
    // the heartbeat. It IS still subject to MIN_LOG_INTERVAL_MS, same as a byte swing — only a
    // live-context change is exempt (see the floor tests above).
    rendererMock.mockReturnValue({ info: { memory: { total: 1000 } } });
    let uid = 0;
    slotsMock.mockReturnValue([{ entityId: 1, container: { texture: { source: src({ uid: uid++ }) } } }]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    startGpuMemorySampling(); // seeds + logs at t=0 (uid 0 counted as the first create)
    logSpy.mockClear();

    // Each tick swaps in a texture with a FRESH uid — one create + one release per tick. The
    // second tick (t=3000) is where cumulative churn since the last LOG first crosses
    // CHURN_EVENTS_THRESHOLD — from there every sample qualifies for shouldLog(), so it is the
    // floor, not the churn detector, holding the next two lines back. Looping CHURN_EVENTS_THRESHOLD
    // times lands the last iteration at 4 * SAMPLE_INTERVAL_MS = 6000ms, past MIN_LOG_INTERVAL_MS.
    for (let i = 0; i < CHURN_EVENTS_THRESHOLD; i++) {
      slotsMock.mockReturnValue([{ entityId: 1, container: { texture: { source: src({ uid: uid++ }) } } }]);
      tick();
      if (i < 3) expect(logSpy).not.toHaveBeenCalled();
    }
    // t = 4 * SAMPLE_INTERVAL_MS = 6000ms — the floor (5000ms) has cleared since the last log.
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('tex2dChurn');
    expect(logSpy.mock.calls[0][0]).toContain('(+2 suppressed)'); // the two churn samples the floor held back
  });

  it('feeds setCounter only when the profiler is enabled — same gate as every other counter', async () => {
    // `getCounters()` only reports a counter once `recordCounterFrame()` has sampled it at least
    // once (profilerCounters.ts's own `filled === 0` skip) — that boundary is frameDriver's job in
    // production, so call it directly here to observe whatever `setCounter` actually wrote.
    const { getCounters, resetCounters, recordCounterFrame } = await import('../../src/runtime/core/profilerCounters');
    resetCounters();
    setProfilerEnabled(false);
    startGpuMemorySampling();
    recordCounterFrame();
    expect(getCounters().counters.find((c) => c.name === 'gpu.totalBytes')).toBeUndefined();

    stopGpuMemorySampling();
    __resetGpuMemoryReportForTest();
    setProfilerEnabled(true);
    startGpuMemorySampling();
    recordCounterFrame();
    expect(getCounters().counters.find((c) => c.name === 'gpu.totalBytes')).toBeDefined();
    resetCounters();
  });
  // ── #832 review follow-up: the churn pair must reach a CONSUMER, not just the console line ──
  // Local duck-typed fixtures — the `geo`/`buf` helpers above belong to another describe block.
  const g = (uid: number, bytes: number) =>
    ({ uid, buffers: [{ uid: 1000 + uid, data: { byteLength: bytes } }] });

  it('all FOUR geometry series reach the counter ring — the churn pair, not just the two gauges', async () => {
    const { getCounters, resetCounters, recordCounterFrame } = await import('../../src/runtime/core/profilerCounters');
    resetCounters();
    setProfilerEnabled(true);
    slotsMock.mockReturnValue([{ entityId: 1, container: { geometry: g(0, 128) } }]);
    startGpuMemorySampling();
    recordCounterFrame();
    const names = getCounters().counters.map((c) => c.name);
    // The gauges alone reproduce the exact failure the module header warns about: a live snapshot
    // reads flat while the leak grows. The cumulative pair is the half that carries the signal.
    expect(names).toContain('gpu.geometryBytes2D');
    expect(names).toContain('gpu.geometryCount2D');
    expect(names).toContain('gpu.cumulativeGeometryCreates2D');
    expect(names).toContain('gpu.cumulativeGeometryReleases2D');
    resetCounters();
  });

  it('GEOMETRY churn alone trips the log gate — the #590 driver moves no context and no texture', () => {
    // The case the gate was blindest to: a text-rebuild scene shares one stable MTSDF atlas (no
    // texture churn), never opens a context, and `totalBytes` excludes geometryBytes2D by design.
    // Before geometry entered shouldLog()'s churn sum, this reached the ring only on the heartbeat.
    rendererMock.mockReturnValue({ info: { memory: { total: 1_000_000 } } });
    let uid = 0;
    // Same byte total every sample — only the geometry IDENTITY changes, exactly like a rebuild.
    const churnOnce = () => slotsMock.mockReturnValue([
      { entityId: 1, container: { geometry: g(++uid, 4096) } },
    ]);
    churnOnce();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    startGpuMemorySampling(); // seeds + logs at t=0
    logSpy.mockClear();

    // Churn past the floor, staying well inside one HEARTBEAT_MS so the heartbeat cannot be what
    // fires. Every sample keeps totalBytes, the live context count and the texture set identical.
    for (let i = 0; i < 6; i++) { churnOnce(); tick(); }

    expect(HEARTBEAT_MS).toBeGreaterThan(6 * SAMPLE_INTERVAL_MS); // the premise above, asserted
    expect(logSpy.mock.calls.length).toBeGreaterThan(0);
    expect(String(logSpy.mock.calls[0][0])).toContain('geom2dChurn');
    logSpy.mockRestore();
  });
});
