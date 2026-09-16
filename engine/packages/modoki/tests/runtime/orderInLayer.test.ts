/** collectOrderInLayer — the single 2D "Order in Layer" collection shared by Scene2D and the
 *  editor SceneView (#1228).
 *
 *  These pin the properties the two CALLERS depend on and that a refactor of the trait list could
 *  quietly change: which traits are read, which one wins when an entity carries both, and the
 *  empty-map path that keeps an override-free scene on the pure-hierarchy route. The behavioural
 *  proof that the editor now honours Text2D lives in tests/editor/sceneView2DGraph.test.ts, which
 *  drives the real editor entry point rather than this helper. */

import { describe, it, expect } from 'vitest';
import { createWorld } from 'koota';
import { Renderable2D } from '../../src/runtime/traits/Renderable2D';
import { Text2D } from '../../src/runtime/traits/Text2D';
import { collectOrderInLayer } from '../../src/runtime/rendering/orderInLayer';

describe('collectOrderInLayer', () => {
  it('reads orderInLayer from Renderable2D', () => {
    const w = createWorld();
    const e = w.spawn(Renderable2D({ orderInLayer: 3 }));
    expect(collectOrderInLayer(w).get(e.id())).toBe(3);
  });

  it('reads orderInLayer from Text2D — the trait the editor copy used to miss', () => {
    const w = createWorld();
    const e = w.spawn(Text2D({ orderInLayer: 7 }));
    expect(collectOrderInLayer(w).get(e.id())).toBe(7);
  });

  it('Text2D WINS on an entity carrying both, preserving the pre-#1228 runtime order', () => {
    // Scene2D ran its Renderable2D pass and then its Text2D pass into one map, so Text2D
    // overwrote. The extraction has to keep that, or an entity with both silently flips rank.
    const w = createWorld();
    const e = w.spawn(Renderable2D({ orderInLayer: 2 }), Text2D({ orderInLayer: 9 }));
    expect(collectOrderInLayer(w).get(e.id())).toBe(9);
  });

  it('omits entities whose orderInLayer is 0, so an override-free scene yields an EMPTY map', () => {
    // Load-bearing, not cosmetic: both callers pass `undefined` to computePaintOrder when the map
    // is empty, which skips the re-rank entirely. Populating it with zeroes would put every scene
    // through the re-rank path instead of the pure-hierarchy one.
    const w = createWorld();
    w.spawn(Renderable2D({ orderInLayer: 0 }));
    w.spawn(Text2D({ orderInLayer: 0 }));
    expect(collectOrderInLayer(w).size).toBe(0);
  });

  it('a negative orderInLayer is kept — only 0 means "unset"', () => {
    const w = createWorld();
    const e = w.spawn(Text2D({ orderInLayer: -4 }));
    expect(collectOrderInLayer(w).get(e.id())).toBe(-4);
  });
});
