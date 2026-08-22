/**
 * `render_scene` must NAME the surface that served the frame.
 *
 * Its tool description has always promised "The reply echoes `surface`", and for months the
 * route returned only path/width/height (bug `XBayncnNfJj3RtjVZiBX`, QA-TOOL-0009). A caller
 * that branched on the field silently took the `undefined` branch — the exact failure shape as
 * `capture_viewport` claiming it forces a render when it does not.
 *
 * The label is attached by the REGISTRY, not by the renderer function, so it always describes
 * whoever is actually mounted.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  registerSceneRenderer,
  unregisterSceneRenderer,
  renderSceneOffscreen,
  hasSceneRenderer,
  type SceneRenderer,
} from '../../src/runtime/rendering/offscreenCapture';

const stub = (): SceneRenderer => async () => ({ width: 4, height: 2, quality: 85, dataUrl: 'data:image/jpeg;base64,AA' });

describe('offscreen render surface echo', () => {
  let active: SceneRenderer | null = null;
  afterEach(() => { if (active) unregisterSceneRenderer(active); active = null; });

  it('echoes the label the registrant gave', async () => {
    active = stub();
    registerSceneRenderer(active, 'game-3d');
    const res = await renderSceneOffscreen();
    expect(res.surface).toBe('game-3d');
    // The renderer's own fields survive the wrapping.
    expect(res).toMatchObject({ width: 4, height: 2, quality: 85 });
  });

  it('defaults to game-3d when a registrant does not name itself', async () => {
    active = stub();
    registerSceneRenderer(active);
    expect((await renderSceneOffscreen()).surface).toBe('game-3d');
  });

  it('reports the registrant that served THIS call, not one that replaced it mid-flight', async () => {
    // The label is read at call time. A remount between the call and its resolution must not
    // relabel a frame the previous registrant already rendered.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: SceneRenderer = async () => { await gate; return { width: 1, height: 1, dataUrl: 'data:,' }; };
    registerSceneRenderer(slow, 'scene-view');
    const inFlight = renderSceneOffscreen();
    active = stub();
    registerSceneRenderer(active, 'game-3d');   // remount swaps the slot while we wait
    release();
    expect((await inFlight).surface).toBe('scene-view');
  });

  it('drops the label with the renderer on unregister', async () => {
    const fn = stub();
    registerSceneRenderer(fn, 'game-3d');
    unregisterSceneRenderer(fn);
    expect(hasSceneRenderer()).toBe(false);
    await expect(renderSceneOffscreen()).rejects.toThrow(/no scene renderer registered/);
  });
});
