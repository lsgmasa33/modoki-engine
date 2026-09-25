// @vitest-environment jsdom
/** `releaseGeometry` against the INSTALLED pixi.js, not a mock (#1540).
 *
 *  The WebGL VAO is freed only through a Geometry's `"unload"` event: `GlGeometrySystem` hears it
 *  via `GCManagedHash`'s `item.once("unload", …)` and that is the only route to
 *  `gl.deleteVertexArray`. Before pixi.js 8.21.0, `Geometry.destroy()` removed every listener
 *  BEFORE unloading (pixijs#12212), so `releaseGeometry` had to call `unload()` itself first.
 *  8.21.0 fixed the order (#12190) and that call was dropped — so this file is what proves the
 *  event still arrives. A mocked Geometry cannot: it would pass whatever order the mock encodes.
 *  The listener here stands in for GlGeometrySystem's, which needs a live GL context to register.
 *
 *  It also pins the two reasons `releaseGeometry` still exists — the buffers are destroyed with
 *  the geometry, and a second release is a no-op rather than a throw. */
import { describe, it, expect, vi } from 'vitest';
import { MeshGeometry } from 'pixi.js';
import { releaseGeometry } from '../../src/runtime/rendering/Scene2D';

function quad(): MeshGeometry {
  return new MeshGeometry({
    positions: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
}

describe('releaseGeometry against the installed pixi.js', () => {
  it('fires the "unload" listener that frees the WebGL VAO', () => {
    const geo = quad();
    const onUnload = vi.fn();
    geo.once('unload', onUnload);

    releaseGeometry(geo);

    expect(onUnload).toHaveBeenCalledTimes(1);
    expect(onUnload).toHaveBeenCalledWith(geo);
  });

  it("destroys the geometry's buffers with it", () => {
    const geo = quad();
    const buffers = [...geo.buffers];
    expect(buffers.length).toBeGreaterThan(0);
    const destroyed = buffers.map((b) => vi.spyOn(b, 'destroy'));

    releaseGeometry(geo);

    for (const spy of destroyed) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a second release is a no-op, not a throw', () => {
    const geo = quad();
    const onUnload = vi.fn();
    geo.on('unload', onUnload);
    releaseGeometry(geo);

    expect(() => releaseGeometry(geo)).not.toThrow();
    expect(onUnload).toHaveBeenCalledTimes(1);
  });

  it('accepts a missing geometry', () => {
    expect(() => releaseGeometry(undefined)).not.toThrow();
    expect(() => releaseGeometry(null)).not.toThrow();
  });
});
