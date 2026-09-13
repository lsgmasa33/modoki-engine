/** resolveCanvas2DHost (#1135) — the one engine seam that finds a 2D game's `Canvas2D` host and reports
 *  a LOADED scene that has none. The discriminator is the world's scene-loaded mark
 *  (`core/ecs/sceneLoaded.ts`): silent before it, one report per world per name after. Each case holds
 *  every other condition fixed, so deleting one mechanism turns its own case red. */

import { afterEach, describe, expect, it } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { resolveCanvas2DHost } from '../../src/runtime/scene/canvas2DHost';
import { Canvas2D } from '../../src/runtime/traits/Canvas2D';

const REPORT = 'test-game/no-canvas-host';
let worlds: TestWorld[] = [];
const make = (scenePath?: string): TestWorld => {
  const tw = createTestWorld(scenePath === undefined ? {} : { scenePath });
  worlds.push(tw);
  return tw;
};
afterEach(() => {
  // Newest first: each dispose restores the world that was current when it was created.
  for (const tw of worlds.reverse()) tw.dispose();
  worlds = [];
});

describe('resolveCanvas2DHost', () => {
  it('the pre-scene window is SILENT — no host and no loaded scene is the routine boot state', () => {
    const tw = make();
    for (let i = 0; i < 120; i++) expect(resolveCanvas2DHost(tw.world, { report: REPORT })).toBeUndefined();
    expect(tw.events({ type: REPORT })).toHaveLength(0);
  });

  it('a LOADED scene with no host reports once, with its path — not once per frame', () => {
    const tw = make('scenes/main.scene.json');
    for (let i = 0; i < 120; i++) expect(resolveCanvas2DHost(tw.world, { report: REPORT })).toBeUndefined();
    const reported = tw.events({ type: REPORT });
    expect(reported).toHaveLength(1);
    expect(reported[0].payload).toMatchObject({ scenePath: 'scenes/main.scene.json' });
  });

  it('a loaded scene WITH a host returns it and reports nothing', () => {
    const tw = make('scenes/main.scene.json');
    const host = tw.spawn(Canvas2D());
    expect(resolveCanvas2DHost(tw.world, { report: REPORT })?.id()).toBe(host.id());
    expect(tw.events({ type: REPORT })).toHaveLength(0);
  });

  it('prefer picks the accepted canvas whatever the spawn order, and falls back to the first canvas', () => {
    const tw = make('scenes/main.scene.json');
    const overlay = tw.spawn(Canvas2D({ referenceWidth: 1 }));
    const board = tw.spawn(Canvas2D({ referenceWidth: 2 }));
    const isBoard = (e: typeof board) => e.get(Canvas2D)?.referenceWidth === 2;
    expect(resolveCanvas2DHost(tw.world, { report: REPORT, prefer: isBoard })?.id()).toBe(board.id());
    expect(resolveCanvas2DHost(tw.world, { report: REPORT, prefer: () => false })?.id()).toBe(overlay.id());
  });

  it('a second misauthored scene is a new world and reports on its own', () => {
    const first = make('scenes/a.scene.json');
    resolveCanvas2DHost(first.world, { report: REPORT });
    const second = make('scenes/b.scene.json');
    resolveCanvas2DHost(second.world, { report: REPORT });
    expect(first.events({ type: REPORT })).toHaveLength(1);
    expect(second.events({ type: REPORT })).toHaveLength(1);
  });

  it('two games asking about one world each get their own report', () => {
    const tw = make('scenes/main.scene.json');
    resolveCanvas2DHost(tw.world, { report: REPORT });
    resolveCanvas2DHost(tw.world, { report: 'other-game/no-canvas-host' });
    resolveCanvas2DHost(tw.world, { report: REPORT });
    expect(tw.events({ type: REPORT })).toHaveLength(1);
    expect(tw.events({ type: 'other-game/no-canvas-host' })).toHaveLength(1);
  });
});
