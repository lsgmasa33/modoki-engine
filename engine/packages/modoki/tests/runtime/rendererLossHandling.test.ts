/** rendererLossHandling.ts — the shared GPU-context-loss DETECTION contract (#795).
 *
 *  Pure unit tests of the primitives in isolation. `canvas2DContextLoss.test.ts` already proves
 *  `canvas2DPool.ts`'s behaviour is unchanged by routing through these. There is NO per-surface
 *  wiring test that mounts ShaderPreview/ParticleEditor/ModelPreview and drives a real loss
 *  through them (per `CLAUDE.md` § Editor Panels, these panels are `.tsx` and don't mount in
 *  jsdom) — `previewSceneLoss.test.ts` covers the one surface that IS a plain factory
 *  (`previewScene.ts`), and `previewLossPolicy.test.ts` covers the shared policy those panels
 *  call into. The architecture guard `engine/tests/architecture/rendererLossHandling.test.ts`
 *  is what proves each construction site actually attaches — see its own header for what that
 *  guard does and does not prove.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  attachContextLossListeners,
  attachDeviceLostListener,
  attachRendererLossHandling,
} from '../../src/runtime/rendering/rendererLossHandling';

afterEach(() => { vi.restoreAllMocks(); });

const fireLost = (canvas: HTMLCanvasElement) => {
  const e = new Event('webglcontextlost', { cancelable: true });
  canvas.dispatchEvent(e);
  return e;
};
const fireRestored = (canvas: HTMLCanvasElement) => {
  canvas.dispatchEvent(new Event('webglcontextrestored'));
};

describe('attachContextLossListeners', () => {
  it('calls preventDefault on the loss event — without it the browser will never restore', () => {
    const canvas = document.createElement('canvas');
    attachContextLossListeners(canvas, { label: 't', onLost: () => {} });
    const e = fireLost(canvas);
    expect(e.defaultPrevented).toBe(true);
  });

  it('isStale suppresses the loss entirely — no log, no onLost', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const canvas = document.createElement('canvas');
    const onLost = vi.fn();
    attachContextLossListeners(canvas, { label: 't', isStale: () => true, onLost });
    fireLost(canvas);
    expect(onLost).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it('isStale suppresses restore too', () => {
    const canvas = document.createElement('canvas');
    const onRestored = vi.fn();
    attachContextLossListeners(canvas, { label: 't', isStale: () => true, onLost: () => {}, onRestored });
    fireRestored(canvas);
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('runs onLost and the default log line when live', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const canvas = document.createElement('canvas');
    const onLost = vi.fn();
    attachContextLossListeners(canvas, { label: 'MyLabel', onLost });
    fireLost(canvas);
    // `reason` is the fixed WebGL marker and `message` the event's `statusMessage` (absent on a
    // bare synthetic event). Both are carried through because `frameDriver` renders
    // `GPU fault: ${reason ?? 'unknown reason'}` — dropping them degraded that line on the
    // WebGL devices the fault channel exists for.
    expect(onLost).toHaveBeenCalledWith({ api: 'WebGL', reason: 'webglcontextlost', message: undefined });
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).toMatch(/MyLabel/);
  });

  it('describe returning null suppresses the log entirely, but still calls onLost', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const canvas = document.createElement('canvas');
    const onLost = vi.fn();
    attachContextLossListeners(canvas, { label: 't', describe: () => null, onLost });
    fireLost(canvas);
    expect(onLost).toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it('describe returning a string is logged verbatim', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const canvas = document.createElement('canvas');
    attachContextLossListeners(canvas, { label: 't', describe: () => 'EXACT MESSAGE', onLost: () => {} });
    fireLost(canvas);
    expect(err).toHaveBeenCalledWith('EXACT MESSAGE');
  });

  it('detach stops further delivery, and is idempotent', () => {
    const canvas = document.createElement('canvas');
    const onLost = vi.fn();
    const detach = attachContextLossListeners(canvas, { label: 't', onLost });
    detach();
    expect(() => detach()).not.toThrow();
    fireLost(canvas);
    expect(onLost).not.toHaveBeenCalled();
  });

  it('a null/undefined canvas is a silent no-op, and its detach never throws', () => {
    const detach = attachContextLossListeners(null, { label: 't', onLost: () => {} });
    expect(() => detach()).not.toThrow();
  });
});

describe('attachDeviceLostListener', () => {
  it('a device with no `lost` promise is a silent no-op', () => {
    const detach = attachDeviceLostListener(null, { label: 't', onLost: () => {} });
    expect(() => detach()).not.toThrow();
    const detach2 = attachDeviceLostListener({}, { label: 't', onLost: () => {} });
    expect(() => detach2()).not.toThrow();
  });

  it('resolves → logs and runs onLost with the reason/message', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onLost = vi.fn();
    attachDeviceLostListener({ lost: Promise.resolve({ reason: 'unknown', message: 'm' }) }, { label: 'Lbl', onLost });
    await Promise.resolve(); await Promise.resolve();
    expect(onLost).toHaveBeenCalledWith({ api: 'WebGPU', reason: 'unknown', message: 'm' });
    expect(err).toHaveBeenCalled();
  });

  it('isStale, checked once resolved, suppresses the loss', async () => {
    const onLost = vi.fn();
    attachDeviceLostListener({ lost: Promise.resolve({}) }, { label: 't', isStale: () => true, onLost });
    await Promise.resolve(); await Promise.resolve();
    expect(onLost).not.toHaveBeenCalled();
  });

  it('detach before resolution suppresses the loss', async () => {
    let resolve!: (v: { reason?: string }) => void;
    const p = new Promise<{ reason?: string }>((r) => { resolve = r; });
    const onLost = vi.fn();
    const detach = attachDeviceLostListener({ lost: p }, { label: 't', onLost });
    detach();
    expect(() => detach()).not.toThrow(); // idempotent
    resolve({});
    await Promise.resolve(); await Promise.resolve();
    expect(onLost).not.toHaveBeenCalled();
  });

  it('a THROW from the handler body (onLost) is caught and logged — the catch is the recovery-failed diagnostic, not a real rejection', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    attachDeviceLostListener({ lost: Promise.resolve({ reason: 'unknown' }) }, {
      label: 'FailLabel',
      onLost: () => { throw new Error('boom'); },
    });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // Two error calls: the loss log itself, then the catch reporting the handler's throw.
    const messages = err.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('FailLabel') && m.toLowerCase().includes('failed'))).toBe(true);
  });
});

describe('attachRendererLossHandling', () => {
  it('wires both halves and one detach covers both, idempotently', async () => {
    const canvas = document.createElement('canvas');
    const onLost = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const detach = attachRendererLossHandling(
      { canvas, device: { lost: Promise.resolve({ reason: 'unknown' }) } },
      { label: 't', onLost },
    );
    fireLost(canvas);
    // `reason` is the fixed WebGL marker and `message` the event's `statusMessage` (absent on a
    // bare synthetic event). Both are carried through because `frameDriver` renders
    // `GPU fault: ${reason ?? 'unknown reason'}` — dropping them degraded that line on the
    // WebGL devices the fault channel exists for.
    expect(onLost).toHaveBeenCalledWith({ api: 'WebGL', reason: 'webglcontextlost', message: undefined });
    onLost.mockClear();
    detach();
    expect(() => detach()).not.toThrow();
    fireLost(canvas);
    expect(onLost).not.toHaveBeenCalled();
    // The device half was already in flight before detach; it must not fire after either.
    await Promise.resolve(); await Promise.resolve();
    expect(onLost).not.toHaveBeenCalled();
  });

  it('a target with no canvas/device wires nothing and never throws', () => {
    const detach = attachRendererLossHandling({}, { label: 't', onLost: () => {} });
    expect(() => detach()).not.toThrow();
  });
});
