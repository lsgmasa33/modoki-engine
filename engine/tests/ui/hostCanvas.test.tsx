/** hostCanvasUnder — resolves the host <canvas> under a pointer, disambiguating the editor's
 *  dual rendering (GameView + SceneView UI-preview both tag the same data-entity-id). Locks the
 *  behavior a game relies on to map window pointer events to the RIGHT canvas. */

import { describe, it, expect, afterEach } from 'vitest';
import { hostCanvases, hostCanvasUnder } from '@modoki/engine/runtime';

type R = { x: number; y: number; w: number; h: number };
function makeHost(id: number, rect: R): HTMLCanvasElement {
  const div = document.createElement('div');
  div.setAttribute('data-entity-id', String(id));
  const c = document.createElement('canvas');
  c.getBoundingClientRect = () => ({
    left: rect.x, top: rect.y, right: rect.x + rect.w, bottom: rect.y + rect.h,
    width: rect.w, height: rect.h, x: rect.x, y: rect.y, toJSON() {},
  }) as DOMRect;
  div.appendChild(c);
  document.body.appendChild(div);
  return c;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('hostCanvasUnder', () => {
  it('picks the canvas whose rect contains the point (two canvases, same host id)', () => {
    const gameView = makeHost(5, { x: 0, y: 0, w: 100, h: 100 });
    const scenePreview = makeHost(5, { x: 200, y: 0, w: 100, h: 100 }); // separate panel, same host
    expect(hostCanvases(5)).toHaveLength(2);
    expect(hostCanvasUnder(5, 50, 50)).toBe(gameView);
    expect(hostCanvasUnder(5, 250, 50)).toBe(scenePreview);
    expect(hostCanvasUnder(5, 150, 50)).toBeNull(); // in the gap between panels → drives nothing
  });

  it('returns null for an empty/unknown host id', () => {
    makeHost(5, { x: 0, y: 0, w: 100, h: 100 });
    expect(hostCanvasUnder(0, 10, 10)).toBeNull();   // no hostId (headless-ish)
    expect(hostCanvasUnder(999, 10, 10)).toBeNull(); // no such host
  });
});
