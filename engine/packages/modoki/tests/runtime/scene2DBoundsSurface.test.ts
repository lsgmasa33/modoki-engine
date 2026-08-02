/** Which BoundsSurface a `Scene2DRenderer` INSTANCE speaks for (#80).
 *
 *  The registry tests next door (`screenBounds.test.ts`) drive `registerBoundsProvider`
 *  with hand-written fake providers, so they pin the registry's behaviour but say nothing
 *  about the seam production actually uses: the renderer deciding its OWN label. That gap
 *  is exactly what #80 was — SceneView's non-primary instance registered no provider at
 *  all, and the naive fix (drop the `if (this.primary)` gate) would have made it publish
 *  rects labelled `'game-2d'`, colliding with the real GameView's. An unlabelled or
 *  mislabelled rect is indistinguishable from another provider's, which is the whole
 *  reason `BoundsSurface` exists — so the label is load-bearing, not cosmetic.
 *
 *  `boundsSurface` is the single source for BOTH the `registerBoundsProvider` argument and
 *  the per-rect `surface` stamp, precisely so those two cannot drift; this pins it for the
 *  two real instance shapes. Reached through an `as any` cast because it is `private` —
 *  TypeScript-only, erased at runtime — which is the right trade for pinning an invariant
 *  that is otherwise only observable from a live editor.
 */

import { describe, it, expect } from 'vitest';
import { Scene2DRenderer } from '../../src/runtime/rendering/Scene2D';
import { Canvas2DPool } from '../../src/runtime/rendering/canvas2DPool';

/** The private getter, read the way only a test may. */
const surfaceOf = (r: Scene2DRenderer): string => (r as unknown as { boundsSurface: string }).boundsSurface;

describe('Scene2DRenderer.boundsSurface (#80)', () => {
  it('the primary (runtime/GameView) renderer speaks for game-2d', () => {
    const r = new Scene2DRenderer({ pool: new Canvas2DPool(), primary: true });
    expect(surfaceOf(r)).toBe('game-2d');
  });

  it('a non-primary (editor SceneView) renderer speaks for scene-view, NOT game-2d', () => {
    const r = new Scene2DRenderer({ pool: new Canvas2DPool(), primary: false });
    // The specific regression: publishing 'game-2d' here collides with the real GameView's
    // rects, so an entity-aimed click resolved from the loser lands in the wrong panel
    // while reporting success.
    expect(surfaceOf(r)).toBe('scene-view');
  });

  it('defaults to the primary surface when `primary` is omitted', () => {
    // `this.primary = opts.primary ?? true`, so an un-flagged instance is the runtime one.
    const r = new Scene2DRenderer({ pool: new Canvas2DPool() });
    expect(surfaceOf(r)).toBe('game-2d');
  });

  it('the two shapes never claim the same surface', () => {
    const primary = new Scene2DRenderer({ pool: new Canvas2DPool(), primary: true });
    const editor = new Scene2DRenderer({ pool: new Canvas2DPool(), primary: false });
    expect(surfaceOf(primary)).not.toBe(surfaceOf(editor));
  });
});
