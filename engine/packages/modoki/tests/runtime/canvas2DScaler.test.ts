/** canvas2DScaler unit tests — edge cases and negative inputs not covered by app-level tests. */

import { describe, it, expect } from 'vitest';

async function getModule() {
  return import('../../../src/runtime/rendering/canvas2DScaler');
}

describe('computeCanvasScale edge cases', () => {
  it('returns identity for negative refW', async () => {
    const { computeCanvasScale } = await getModule();
    const cs = computeCanvasScale(-100, 200, 400, 800, 'fitW');
    expect(cs.scale).toBe(1);
    expect(cs.offsetX).toBe(0);
    expect(cs.offsetY).toBe(0);
  });

  it('returns identity for negative refH', async () => {
    const { computeCanvasScale } = await getModule();
    const cs = computeCanvasScale(100, -200, 400, 800, 'fitW');
    expect(cs.scale).toBe(1);
  });

  it('returns identity for zero actualW', async () => {
    const { computeCanvasScale } = await getModule();
    const cs = computeCanvasScale(100, 200, 0, 800, 'fitH');
    expect(cs.scale).toBe(1);
  });

  it('returns identity for negative actualH', async () => {
    const { computeCanvasScale } = await getModule();
    const cs = computeCanvasScale(100, 200, 400, -1, 'fill');
    expect(cs.scale).toBe(1);
  });

  it('handles extreme aspect ratio (very wide)', async () => {
    const { computeCanvasScale } = await getModule();
    const cs = computeCanvasScale(100, 10000, 1000, 100, 'fitW');
    // scaleX = scaleY = 1000/100 = 10
    expect(cs.scaleX).toBeCloseTo(10);
    expect(cs.scaleY).toBeCloseTo(10);
    // offsetY = (100 - 10000*10) / 2 → large negative (crops heavily)
    expect(cs.offsetY).toBeLessThan(0);
  });

  it('handles 1:1 ref to 1:1 actual with fitW', async () => {
    const { computeCanvasScale } = await getModule();
    const cs = computeCanvasScale(100, 100, 200, 200, 'fitW');
    expect(cs.scaleX).toBeCloseTo(2);
    expect(cs.scaleY).toBeCloseTo(2);
    expect(cs.offsetX).toBeCloseTo(0);
    expect(cs.offsetY).toBeCloseTo(0);
  });

  it('unknown mode falls through to none (scale=1, but offset computed)', async () => {
    const { computeCanvasScale } = await getModule();
    const cs = computeCanvasScale(100, 200, 400, 800, 'bogus' as any);
    expect(cs.scaleX).toBe(1);
    expect(cs.scaleY).toBe(1);
    // Note: offsetX/Y are still computed via the formula for non-'none' modes
    // since 'bogus' hits default case which sets scale=1 but offset formula still runs
    // offsetX = (400 - 100*1) / 2 = 150, offsetY = (800 - 200*1) / 2 = 300
    expect(cs.offsetX).toBeCloseTo(150);
    expect(cs.offsetY).toBeCloseTo(300);
  });
});

// missing-test #5 — the existing cases cover scale/offset values, but never that the
// shape-compensation actually does its job. In 'fill' the CONTAINER is stretched
// non-uniformly (scaleX != scaleY); object shapes get compensateX/Y so their EFFECTIVE
// scale (container axis scale × compensation) collapses back to a single uniform value,
// i.e. a circle stays a circle. Assert that round-trip algebraically.
describe("computeCanvasScale 'fill' compensation round-trip (#5)", () => {
  it("makes an object's effective scale uniform — container stretch cancelled", async () => {
    const { computeCanvasScale } = await getModule();
    // Tall design ref into a wide canvas → 'fill' stretches non-uniformly.
    const cs = computeCanvasScale(1080, 1920, 800, 600, 'fill');

    // Precondition: the stretch is genuinely non-uniform (otherwise nothing to undo).
    expect(cs.scaleX).not.toBeCloseTo(cs.scaleY);

    // Effective object scale per axis = container axis scale × that axis' compensation.
    const effX = cs.scaleX * cs.compensateX;
    const effY = cs.scaleY * cs.compensateY;
    // Both collapse to the uniform `scale` (= min axis) → the shape is undistorted.
    expect(effX).toBeCloseTo(cs.scale);
    expect(effY).toBeCloseTo(cs.scale);
    expect(effX).toBeCloseTo(effY);
  });

  it('leaves the already-uniform (min) axis at compensation 1', async () => {
    const { computeCanvasScale } = await getModule();
    const cs = computeCanvasScale(1080, 1920, 800, 600, 'fill');
    // scaleX = 800/1080 ≈ 0.741, scaleY = 600/1920 ≈ 0.313 → min axis is Y.
    expect(cs.scaleY).toBeLessThan(cs.scaleX);
    expect(cs.compensateY).toBeCloseTo(1);       // min axis = uniform scale → no compensation
    expect(cs.compensateX).toBeLessThan(1);      // wider axis squeezed back toward uniform
  });

  it('round-trips across an extreme non-uniform stretch (wide ref → tall canvas)', async () => {
    const { computeCanvasScale } = await getModule();
    const cs = computeCanvasScale(2000, 100, 300, 900, 'fill');
    expect(cs.scaleX).not.toBeCloseTo(cs.scaleY);
    expect(cs.scaleX * cs.compensateX).toBeCloseTo(cs.scale);
    expect(cs.scaleY * cs.compensateY).toBeCloseTo(cs.scale);
  });

  it('uniform modes (fitH/fitW) need no shape compensation', async () => {
    const { computeCanvasScale } = await getModule();
    for (const mode of ['fitH', 'fitW'] as const) {
      const cs = computeCanvasScale(1080, 1920, 800, 600, mode);
      expect(cs.scaleX).toBeCloseTo(cs.scaleY);   // already uniform
      expect(cs.compensateX).toBeCloseTo(1);
      expect(cs.compensateY).toBeCloseTo(1);
      expect(cs.scaleX * cs.compensateX).toBeCloseTo(cs.scale);
    }
  });
});

// screenToReference2D is the coordinate inverse behind 2D picking (`toGame`). SceneView-Pixi
// migration Phase 2 extracts it so the DOM SceneView layer and the Pixi pick overlay pick
// identically — the ONLY difference between them is the (rect, backing, cs) inputs it's fed.
// A reference point pushed through the forward mapping (offset + scale, then client via a rect)
// must invert back to the same reference point, for every scale mode and any device-pixel ratio /
// viewZoom baked into the on-screen rect.
describe('screenToReference2D — the pick coordinate inverse (Phase 2)', () => {
  // Forward map a reference point → client CSS coords, mirroring how the renderer draws
  // (ctx.translate(offset) + ctx.scale) then the browser fits backing px into the rect.
  function forward(
    rx: number, ry: number,
    cs: { scaleX: number; scaleY: number; offsetX: number; offsetY: number },
    rect: { left: number; top: number; width: number; height: number },
    backingW: number, backingH: number,
  ) {
    const pxX = rx * cs.scaleX + cs.offsetX;   // reference → backing px
    const pxY = ry * cs.scaleY + cs.offsetY;
    return {
      clientX: rect.left + (pxX / backingW) * rect.width,   // backing px → client CSS
      clientY: rect.top + (pxY / backingH) * rect.height,
    };
  }

  it('round-trips reference→client→reference for every scale mode', async () => {
    const { computeCanvasScale, screenToReference2D } = await getModule();
    const refW = 1080, refH = 1920, backingW = 800, backingH = 600;
    // A rect that is NOT 1:1 with backing (dpr 2 + a viewZoom 1.5 → 3× shrink) and offset on screen.
    const rect = { left: 40, top: 17, width: backingW / 3, height: backingH / 3 };
    for (const mode of ['fitW', 'fitH', 'contain', 'cover', 'fill', 'none'] as const) {
      const cs = computeCanvasScale(refW, refH, backingW, backingH, mode);
      for (const [rx, ry] of [[0, 0], [540, 960], [1080, 1920], [-200, 300]]) {
        const { clientX, clientY } = forward(rx, ry, cs, rect, backingW, backingH);
        const back = screenToReference2D(clientX, clientY, rect, backingW, backingH, cs);
        expect(back.x).toBeCloseTo(rx, 4);
        expect(back.y).toBeCloseTo(ry, 4);
      }
    }
  });

  it('returns origin for a degenerate rect or zero scale (never NaN)', async () => {
    const { computeCanvasScale, screenToReference2D } = await getModule();
    const cs = computeCanvasScale(1080, 1920, 800, 600, 'fitH');
    expect(screenToReference2D(100, 100, { left: 0, top: 0, width: 0, height: 100 }, 800, 600, cs)).toEqual({ x: 0, y: 0 });
    const zero = { scale: 1, scaleX: 0, scaleY: 0, offsetX: 0, offsetY: 0, compensateX: 1, compensateY: 1 };
    expect(screenToReference2D(100, 100, { left: 0, top: 0, width: 50, height: 50 }, 800, 600, zero)).toEqual({ x: 0, y: 0 });
  });

  it('maps the rect center to the reference center under fitH letterboxing', async () => {
    const { computeCanvasScale, screenToReference2D } = await getModule();
    // fitH centers horizontally; the rect center must map to (refW/2, refH/2).
    const refW = 1080, refH = 1920, backingW = 1000, backingH = 2000;
    const cs = computeCanvasScale(refW, refH, backingW, backingH, 'fitH');
    const rect = { left: 0, top: 0, width: 500, height: 1000 };
    const center = screenToReference2D(rect.width / 2, rect.height / 2, rect, backingW, backingH, cs);
    expect(center.x).toBeCloseTo(refW / 2, 3);
    expect(center.y).toBeCloseTo(refH / 2, 3);
  });
});
