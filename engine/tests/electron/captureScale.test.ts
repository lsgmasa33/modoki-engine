/** Unit: `fitToMaxSide` — the capture downscale ratio.
 *
 *  This number is the bridge between what an agent SEES (image px) and where it can
 *  CLICK (CSS px). `captureViewport` used to compute it, apply it, and throw it away, so
 *  an agent measuring a button in a 1568px-wide JPEG of a 1600px-wide window was off by
 *  ~2% with no way to know. Now it is returned — and pinned here. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import { fitToMaxSide, captureViewport, explainCaptureFailure, normalizeJpegQuality, jpegSize } from '../../electron/rendererOps';
import { normalizeJpegQuality as runtimeNormalizeJpegQuality } from '@modoki/engine/runtime';
import type { CaptureWindowFacts } from '../../electron/rendererOps';

vi.mock('../../plugins/backend/tempFiles', () => ({ pruneOldTempFiles: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  // node:fs's type declarations have no `default` export (it's CJS, not ESM) — but at
  // runtime the actual module object IS the synthetic default `import fs from 'node:fs'`
  // resolves to. Cast just to reach it; the shape being mocked is unchanged.
  const actualDefault = (actual as unknown as { default: typeof actual }).default;
  return { ...actual, default: { ...actualDefault, writeFileSync: vi.fn() } };
});

/** A window whose capturePage() yields an image of the given CSS size. `resize` records
 *  what it was asked for and reports that as the new size — i.e. it stands in for the
 *  ENCODER, which is what `captureViewport` deliberately trusts over its own arithmetic. */
function fakeWindow(cssWidth: number, cssHeight: number, zoomFactor = 1) {
  const resize = vi.fn();
  const makeImage = (w: number, h: number): Record<string, unknown> => ({
    getSize: () => ({ width: w, height: h }),
    toJPEG: () => Buffer.from(''),
    resize: (o: { width: number; height: number }) => { resize(o); return makeImage(o.width, o.height); },
  });
  const win = { webContents: { capturePage: vi.fn(async () => makeImage(cssWidth, cssHeight)), getZoomFactor: () => zoomFactor } };
  return { win: win as unknown as BrowserWindow, resize };
}

describe('fitToMaxSide', () => {
  it('passes a window smaller than the cap through untouched, at scale 1', () => {
    expect(fitToMaxSide(1200, 800, 1568)).toEqual({ width: 1200, height: 800, scale: 1 });
  });

  it('leaves a window exactly at the cap alone (boundary is inclusive)', () => {
    expect(fitToMaxSide(1568, 900, 1568)).toEqual({ width: 1568, height: 900, scale: 1 });
  });

  it('downscales by the LONGEST side, preserving aspect', () => {
    // The real case: a 1600×968 editor window under the default 1568 cap.
    const fit = fitToMaxSide(1600, 968, 1568);
    expect(fit.width).toBe(1568);
    expect(fit.height).toBe(949); // round(968 * 1568/1600) = round(948.6)
    expect(fit.scale).toBeCloseTo(0.98, 5);
    // Aspect preserved to within the rounding of one pixel.
    expect(fit.width / fit.height).toBeCloseTo(1600 / 968, 2);
  });

  it('uses HEIGHT as the longest side for a portrait window', () => {
    const fit = fitToMaxSide(500, 2000, 1000);
    expect(fit).toEqual({ width: 250, height: 1000, scale: 0.5 });
  });

  it('the scale is the number that converts an image pixel back to a CSS pixel', () => {
    // NOT `(cssX * scale) / scale === cssX` — that is an algebraic identity that holds for
    // any scale, including a buggy 1. Pin the scale to the value the geometry demands, then
    // show the naive "just use the image pixel" is off by enough to miss a 14px kebab.
    const cssX = 769;
    const { scale } = fitToMaxSide(1600, 968, 1568);
    expect(scale).toBeCloseTo(1568 / 1600, 6);
    expect(cssX * scale).toBeCloseTo(753.62, 2); // where that button appears in the image
    expect(Math.abs(cssX * scale - cssX)).toBeGreaterThan(14);
  });

  it('never returns a zero dimension for an extreme aspect ratio', () => {
    // A 2000×1 sliver: the height rounds to 0 px, and NativeImage.resize on a
    // zero dimension yields an empty image. Clamp to 1.
    expect(fitToMaxSide(2000, 1, 100)).toMatchObject({ width: 100, height: 1 });
    expect(fitToMaxSide(1, 2000, 100)).toMatchObject({ width: 1, height: 100 });
  });
});

describe('captureViewport', () => {
  // fitToMaxSide being right is worthless if captureViewport doesn't report it. These
  // drive the real function against a fake NativeImage — otherwise dropping cssWidth/
  // cssHeight/scale from the result ships green, which is the whole Phase 3 deliverable.
  beforeEach(() => { vi.clearAllMocks(); });

  it('reports the CSS size it captured and the scale it downscaled by', async () => {
    const { win, resize } = fakeWindow(1600, 968); // the real editor window
    const res = await captureViewport(win);
    expect(res).toMatchObject({ width: 1568, height: 949, cssWidth: 1600, cssHeight: 968 });
    expect(res.scale).toBeCloseTo(0.98, 4);
    expect(resize).toHaveBeenCalledWith(expect.objectContaining({ width: 1568, height: 949 }));
    expect(res.path).toMatch(/modoki-capture-.*\.jpg$/);
  });

  it('scale is derived from the ENCODER\'s final width, not from the raw fit ratio', async () => {
    // These two only diverge when the LONGEST side is the height: then the emitted width
    // is round(cssWidth * scale), and dividing THAT by cssWidth is not the raw fit.scale.
    // The quantized ratio is the correct one — it is what actually maps an image pixel
    // in the file on disk back to a CSS pixel you can tap.
    const { win } = fakeWindow(999, 2000);
    const fit = fitToMaxSide(999, 2000, 100);
    expect(fit).toMatchObject({ width: 50, height: 100 }); // round(999*0.05) = 50
    expect(fit.scale).toBe(0.05);

    const res = await captureViewport(win, { maxSide: 100 });
    expect(res.scale).toBe(50 / 999); // 0.050050…, the emitted-width ratio
    expect(res.scale).not.toBe(fit.scale); // …NOT the raw 0.05
    // The difference is real: at the far edge of the image it is a whole pixel.
    expect(Math.abs(50 / res.scale - 50 / fit.scale)).toBeGreaterThan(0.9);
  });

  it('does not resize at all when the window already fits, and reports scale 1', async () => {
    const { win, resize } = fakeWindow(1200, 800);
    const res = await captureViewport(win);
    expect(resize).not.toHaveBeenCalled();
    expect(res).toMatchObject({ width: 1200, height: 800, cssWidth: 1200, cssHeight: 800, scale: 1 });
  });

  it('survives a zero-width capture (window minimised) instead of dividing by zero', async () => {
    const { win } = fakeWindow(0, 0);
    const res = await captureViewport(win);
    expect(res.scale).toBe(1);
    expect(Number.isNaN(res.scale)).toBe(false);
  });

  it('honours an explicit maxSide, so an agent can capture at full CSS resolution', async () => {
    const { win, resize } = fakeWindow(1600, 968);
    const res = await captureViewport(win, { maxSide: 4000 });
    expect(resize).not.toHaveBeenCalled();
    expect(res).toMatchObject({ width: 1600, cssWidth: 1600, scale: 1 });
  });

  it('reports the live zoom factor, so cssWidth/cssHeight (DIP) self-describe how to reach zoomed-CSS', async () => {
    const { win } = fakeWindow(1600, 968, 1.2); // one zoom-in step (1.2^1)
    const res = await captureViewport(win);
    expect(res.zoomFactor).toBe(1.2);
  });
});

/** The DIAGNOSIS, not the picture.
 *
 *  Chromium hands back a bare `UnknownVizError` when its compositor cannot produce a frame.
 *  What the caller does next is decided entirely by the sentence we attach to it — so a wrong
 *  sentence is a real bug, and it was one: with NO window-level fault found, this used to say
 *  the renderer "is most likely wedged". A layout with no Scene/Game panel open has an `idle`
 *  frame loop BY DESIGN (a supported state), so the message sent the reader hunting a renderer
 *  fault that did not exist. See `docs/todo.md`.
 *
 *  The invariant these pin: **claim a wedge only when the frame loop says `stalled`.** */
describe('explainCaptureFailure', () => {
  const healthyWindow: CaptureWindowFacts = {
    destroyed: false, wcDestroyed: false, crashed: false,
    visible: true, minimized: false, focused: true,
    width: 1600, height: 968, url: 'http://127.0.0.1:5173/#/editor',
  };

  it('names the unmounted viewport, and says outright it is NOT a wedge', () => {
    const why = explainCaptureFailure(healthyWindow, { frameLoop: { status: 'idle', refCount: 0 } });
    expect(why).toMatch(/NOTHING IS RENDERING/);
    expect(why).toMatch(/no Scene or Game panel/);
    expect(why).toMatch(/NOT a wedged renderer/);
    // The actionable alternative, since render_scene needs no mounted viewport at all.
    expect(why).toMatch(/modoki_render_scene/);
    expect(why).not.toMatch(/most likely wedged/);
  });

  it('claims a wedge ONLY for a stalled loop — and then carries the loop\'s own detail', () => {
    const why = explainCaptureFailure(healthyWindow, {
      frameLoop: { status: 'stalled', detail: 'no frame for 9001ms.' },
    });
    expect(why).toMatch(/STALLED/);
    expect(why).toMatch(/wedged/);
    expect(why).toMatch(/9001ms/);
  });

  it('treats a RUNNING loop as evidence against a wedge, not as silence', () => {
    // The case that used to be misdiagnosed: everything healthy, frame still refused.
    const why = explainCaptureFailure(healthyWindow, { frameLoop: { status: 'running', fps: 61 } });
    expect(why).toMatch(/is NOT wedged/);
    expect(why).toMatch(/61fps/);
    expect(why).toMatch(/outside the page/);
  });

  it('explains a hidden document as throttling, not a fault', () => {
    const why = explainCaptureFailure(healthyWindow, { frameLoop: { status: 'hidden' } });
    expect(why).toMatch(/HIDDEN/);
    expect(why).toMatch(/Not a fault/);
  });

  it('reports a non-ready renderer gate when the loop itself has nothing to say', () => {
    const why = explainCaptureFailure(healthyWindow, { rendererGate: { status: 'failed', detail: 'WebGPU init threw.' } });
    expect(why).toMatch(/gate is 'failed'/);
    expect(why).toMatch(/never/);
    expect(why).toMatch(/WebGPU init threw/);
  });

  it('prefers a WINDOW-level fault over any renderer story — it is the nearer cause', () => {
    // A minimized window explains the refusal on its own; reporting the idle loop instead
    // would send the reader to open a panel that would not help.
    const why = explainCaptureFailure({ ...healthyWindow, minimized: true }, { frameLoop: { status: 'idle' } });
    expect(why).toMatch(/Likely cause: the window is minimized/);
    expect(why).not.toMatch(/NOTHING IS RENDERING/);
    // …but the facts are still in the bracket, so nothing is hidden.
    expect(why).toMatch(/frameLoop=idle/);
  });

  it('describes the GAP when the renderer could not be asked, instead of inventing a cause', () => {
    const why = explainCaptureFailure(healthyWindow, null);
    expect(why).toMatch(/could not be asked why/);
    expect(why).toMatch(/frameLoop\.status/);
    expect(why).not.toMatch(/most likely wedged/);
  });

  it('still answers with no facts at all (the window died mid-inspection)', () => {
    expect(explainCaptureFailure(null, null)).toMatch(/could not be asked why/);
  });

  it('a destroyed window is reported as such and short-circuits the rest', () => {
    const why = explainCaptureFailure({ destroyed: true }, { frameLoop: { status: 'idle' } });
    expect(why).toMatch(/window has been destroyed/);
  });

  it('reports a lost GPU device, naming the reason', () => {
    const why = explainCaptureFailure(healthyWindow, { gpu: { deviceLost: true, reason: 'unknown', message: 'driver reset' } });
    expect(why).toMatch(/GPU DEVICE WAS LOST/);
    expect(why).toMatch(/reason=unknown/);
    expect(why).toMatch(/driver reset/);
    expect(why).toMatch(/relaunched/);
  });

  it('prefers the GPU-lost cause over a stalled frame loop — the stall is only the SYMPTOM', () => {
    // The regression this pins: a lost device causes the frame loop to stall, so if `stalled`
    // were checked first the reader would be told "relaunch, it's wedged" instead of the real,
    // more specific "the GPU device was lost" — a different (and correct) reason to relaunch.
    const why = explainCaptureFailure(healthyWindow, {
      gpu: { deviceLost: true, reason: 'unknown' },
      frameLoop: { status: 'stalled', detail: 'no frame for 9001ms.' },
    });
    expect(why).toMatch(/GPU DEVICE WAS LOST/);
    expect(why).not.toMatch(/STALLED/);
  });
});

describe('captureViewport failure path', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  /** A window whose capturePage() rejects the way Viz does. */
  function failingWindow(err = new Error('UnknownVizError')) {
    return {
      webContents: {
        capturePage: vi.fn(async () => { throw err; }),
        getZoomFactor: () => 1,
        isDestroyed: () => false,
        isCrashed: () => false,
        getURL: () => 'http://127.0.0.1:5173/#/editor',
      },
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      isFocused: () => true,
      getBounds: () => ({ x: 0, y: 0, width: 1600, height: 968 }),
    } as unknown as BrowserWindow;
  }

  it('consults the probe and folds its verdict into the thrown message', async () => {
    const probe = vi.fn(async () => ({ frameLoop: { status: 'idle', refCount: 0 } }));
    await expect(captureViewport(failingWindow(), { probe })).rejects.toThrow(/NOTHING IS RENDERING/);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('does NOT probe on the happy path — a diagnostic must cost nothing when nothing is wrong', async () => {
    const probe = vi.fn(async () => ({ frameLoop: { status: 'running' } }));
    const { win } = fakeWindow(1200, 800);
    await captureViewport(win, { probe });
    expect(probe).not.toHaveBeenCalled();
  });

  it('survives a probe that throws — the capture error must never be replaced by the probe\'s', async () => {
    const probe = vi.fn(async () => { throw new Error('bridge is down'); });
    const err = await captureViewport(failingWindow(), { probe }).catch((e: Error) => e);
    if (!(err instanceof Error)) throw new Error('expected captureViewport to reject');
    expect(err.message).toMatch(/UnknownVizError/);
    expect(err.message).not.toMatch(/bridge is down/);
    expect(err.message).toMatch(/could not be asked why/);
  });

  it('preserves the raw compositor error as `cause`, so nothing is lost in translation', async () => {
    const raw = new Error('UnknownVizError');
    const err = await captureViewport(failingWindow(raw)).catch((e: Error) => e);
    expect((err as Error & { cause?: unknown }).cause).toBe(raw);
  });
});

/** S3.13 — `quality` means ONE thing (1–100) across capture_viewport / render_scene /
 *  render_sequence. The rule is implemented twice on purpose (the Electron main process cannot
 *  import the runtime package), so this pins the two copies together: conventions §9 says a rule
 *  implemented twice diverges, and the only defence is a test that fails when it does. */
describe('normalizeJpegQuality', () => {
  const CASES = [undefined, 0, 0.01, 0.5, 0.85, 1, 1.5, 2, 70, 85, 100, 101, 1000, -5, NaN, Infinity];

  it('the Electron copy and the runtime copy agree on every sampled input', () => {
    for (const q of CASES) {
      expect(normalizeJpegQuality(q), `input ${String(q)}`).toEqual(runtimeNormalizeJpegQuality(q));
    }
  });

  it('a sibling-habituated 1–100 value is used as PERCENT, not silently ignored', () => {
    // The defect: render_scene passed `quality:70` straight to canvas.toDataURL, which per the
    // HTML spec ignores an out-of-range number and uses the browser default.
    expect(normalizeJpegQuality(70)).toEqual({ pct: 70, fraction: 0.7 });
  });

  it('a legacy 0..1 fraction still means what it used to (not 1%)', () => {
    expect(normalizeJpegQuality(0.85)).toEqual({ pct: 85, fraction: 0.85 });
    expect(normalizeJpegQuality(1)).toEqual({ pct: 100, fraction: 1 });
  });

  it('clamps out-of-range and non-finite input instead of handing it to the encoder', () => {
    expect(normalizeJpegQuality(1000).pct).toBe(100);
    expect(normalizeJpegQuality(-5).pct).toBe(1);
    expect(normalizeJpegQuality(NaN).pct).toBe(85);       // the fallback
    expect(normalizeJpegQuality(undefined, 70).pct).toBe(70);
  });
});

/** S3.5 — the reported `width`/`height`/`scale` describe the FILE, read from the file's own bytes.
 *
 *  They used to come from `NativeImage.getSize()`, which is DIP. With `maxSide` ≥ the window size
 *  no resize happens, so on a HiDPI display the encoded bitmap can be larger than the DIP size and
 *  the documented conversion "image px ÷ scale = DIP px" would mis-place an eyeballed coordinate by
 *  the device pixel ratio. Reading the SOF marker is correct on every display, which is why it is
 *  preferred over reasoning about which representation Electron encodes. */
describe('jpegSize', () => {
  /** A minimal, structurally valid JPEG: SOI, an APP0 segment to be skipped, SOF0, EOI. */
  function fakeJpeg(w: number, h: number, { withApp0 = true } = {}): Uint8Array {
    const bytes: number[] = [0xff, 0xd8];
    if (withApp0) bytes.push(0xff, 0xe0, 0x00, 0x04, 0x00, 0x00);              // APP0, len 4
    bytes.push(0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff);
    bytes.push(0xff, 0xd9);
    return new Uint8Array(bytes);
  }

  it('reads the dimensions out of the SOF marker, skipping earlier segments', () => {
    expect(jpegSize(fakeJpeg(3200, 1936))).toEqual({ width: 3200, height: 1936 });
    expect(jpegSize(fakeJpeg(1600, 968, { withApp0: false }))).toEqual({ width: 1600, height: 968 });
  });

  it('returns null rather than a guess for a non-JPEG or a truncated buffer', () => {
    expect(jpegSize(new Uint8Array([]))).toBeNull();
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();      // PNG
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xc0]))).toBeNull();      // SOF cut short
  });

  it('does NOT mistake a DHT/DAC segment for a frame header', () => {
    // 0xc4 sits inside the 0xc0–0xcf range but is a Huffman table, not a SOF. Reading its payload
    // as dimensions would report plausible nonsense — the worst failure mode for this function.
    const bytes = [0xff, 0xd8, 0xff, 0xc4, 0x00, 0x06, 0x01, 0x02, 0x03, 0x04,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0xc8, 0x07, 0x80, 0xff, 0xd9];
    expect(jpegSize(new Uint8Array(bytes))).toEqual({ width: 1920, height: 968 });
  });

  it('captureViewport reports the ENCODED size, not the DIP size, when they disagree', async () => {
    // The HiDPI no-resize case, reproduced without a HiDPI display: a 2× bitmap behind a
    // 1600×968 DIP image. Pre-fix this reported width 1600 / scale 1 for a 3200px-wide file.
    const encoded = fakeJpeg(3200, 1936);
    const makeImage = (w: number, h: number): Record<string, unknown> => ({
      getSize: () => ({ width: w, height: h }),
      toJPEG: () => Buffer.from(encoded),
      resize: (o: { width: number; height: number }) => makeImage(o.width, o.height),
    });
    const win = {
      webContents: { capturePage: vi.fn(async () => makeImage(1600, 968)), getZoomFactor: () => 1 },
    } as unknown as BrowserWindow;
    const res = await captureViewport(win, { maxSide: 4000 });   // no downscale
    expect(res).toMatchObject({ width: 3200, height: 1936, cssWidth: 1600, cssHeight: 968 });
    expect(res.scale).toBe(2);                                   // image px ÷ 2 = DIP px, as documented
  });
});
