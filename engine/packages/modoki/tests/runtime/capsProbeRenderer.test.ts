// @vitest-environment jsdom
/** `createCapsProbeRenderer` (`runtime/rendering/capsProbeRenderer.ts`) — the throwaway
 *  renderer `ensureKtx2Caps` stands up when no real viewport ever registers one. Mocks
 *  `scene3DSync.ts`'s `makeWebGPURenderer` (real heavy deps — three, koota — never load) to
 *  isolate the container-lifecycle contract this file actually owns: a detached div gets
 *  briefly attached to `document.body` (so `clientWidth`/`clientHeight` are real, not the `0`
 *  every detached element reports), passed to `makeWebGPURenderer`, then removed again. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const makeWebGPURenderer = vi.fn();
vi.mock('../../src/runtime/rendering/scene3DSync', () => ({ makeWebGPURenderer }));

beforeEach(() => {
  makeWebGPURenderer.mockReset();
  document.body.innerHTML = '';
});

describe('createCapsProbeRenderer', () => {
  it('attaches a container to document.body BEFORE calling makeWebGPURenderer, so clientWidth is real', async () => {
    let containerWasConnected = false;
    makeWebGPURenderer.mockImplementation(async (container: HTMLDivElement) => {
      containerWasConnected = container.isConnected;
      return { dispose: vi.fn() };
    });

    const { createCapsProbeRenderer } = await import('../../src/runtime/rendering/capsProbeRenderer');
    await createCapsProbeRenderer();

    expect(containerWasConnected).toBe(true);
  });

  it('detaches the container again once makeWebGPURenderer resolves', async () => {
    let containerRef: HTMLDivElement | undefined;
    makeWebGPURenderer.mockImplementation(async (container: HTMLDivElement) => {
      containerRef = container;
      return { dispose: vi.fn() };
    });

    const { createCapsProbeRenderer } = await import('../../src/runtime/rendering/capsProbeRenderer');
    await createCapsProbeRenderer();

    expect(containerRef?.isConnected).toBe(false);
    expect(document.body.contains(containerRef!)).toBe(false);
  });

  it('detaches the container even when makeWebGPURenderer THROWS — no leaked DOM node', async () => {
    makeWebGPURenderer.mockImplementation(async () => { throw new Error('adapter request failed'); });

    const { createCapsProbeRenderer } = await import('../../src/runtime/rendering/capsProbeRenderer');
    await expect(createCapsProbeRenderer()).rejects.toThrow('adapter request failed');

    expect(document.body.childElementCount).toBe(0);
  });

  it('returns whatever makeWebGPURenderer resolved with', async () => {
    const fakeRenderer = { dispose: vi.fn(), marker: 'the-renderer' };
    makeWebGPURenderer.mockResolvedValue(fakeRenderer);

    const { createCapsProbeRenderer } = await import('../../src/runtime/rendering/capsProbeRenderer');
    const result = await createCapsProbeRenderer();

    expect(result).toBe(fakeRenderer);
  });
});
