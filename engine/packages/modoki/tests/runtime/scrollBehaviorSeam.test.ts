/** The scroll-request seam: trait write -> UI tree projection -> `pendingScrollTo`.
 *
 *  ⚠️ This file exists because the #409 review MUTATED the projection line
 *  (`uiTreeStore.ts`: `scrollToBehavior: sv.scrollToBehavior ?? ''` replaced by a constant `''`)
 *  and every one of the 5655 tests in `tests/runtime/` stayed green. That mutation makes the whole
 *  per-request override unreachable — every request silently falls back to the authored default —
 *  which is the exact symptom Court's arrows had in #316. The unit tests could not see it because
 *  they sit on either SIDE of the seam: `pendingScrollTo` is handed a literal, and
 *  `clearScrollRequest` a hand-spawned trait. Nothing carried a value ACROSS the projection.
 *
 *  So the assertions here always set the authored value to the OPPOSITE of the request. A test
 *  where both agree cannot tell "the override was carried" from "the override was dropped and the
 *  author's value happened to match".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorld } from 'koota';
import { UIScrollView } from '../../src/runtime/traits/UIScrollView';
import { UIEntries } from '../../src/runtime/traits/UIEntries';
import { UIElement } from '../../src/runtime/traits/UIElement';
import { RenderableUI } from '../../src/runtime/traits/RenderableUI';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';

let testWorld: ReturnType<typeof createWorld>;

vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  onWorldSwap: () => {},
  registerEntity: () => {},
  setStructureCallback: () => {},
  findEntityById: () => undefined,
  findEntityByGuid: (guid: string) => {
    let found: any;
    testWorld.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { if (!found && ea.guid === guid) found = e; });
    return found;
  },
  indexEntityGuid: () => {},
}));

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'UIScrollView', trait: UIScrollView }, { name: 'UIEntries', trait: UIEntries },
    { name: 'UIElement', trait: UIElement }, { name: 'RenderableUI', trait: RenderableUI },
    { name: 'EntityAttributes', trait: EntityAttributes },
  ];
  return { getAllTraits: () => traits, getTraitByName: (n: string) => traits.find((t) => t.name === n) };
});

const GUID = 'view-guid';

/** Spawn a scroll view the projection will pick up, authored with `authored` motion. */
function spawnView(authored: 'instant' | 'smooth') {
  return testWorld.spawn(
    RenderableUI(), UIElement({ overflow: 'scroll' }),
    EntityAttributes({ name: 'Scroll', parentId: 0, guid: GUID }),
    UIScrollView({ axis: 'y', scrollBehavior: authored, viewportHeight: 600 }),
    UIEntries({ prefabs: '[]', entryHeight: 120, visibleY: 6 }),
  );
}

/** Run the real projection and hand back the scroll node's data, exactly as `UINode` receives it. */
async function projectedScroll() {
  const { uiTreeProjection, useUITreeStore } = await import('../../src/runtime/ui/uiTreeStore');
  const { markUIDirty } = await import('../../src/runtime/core/uiDirty');
  markUIDirty();
  uiTreeProjection(testWorld as any);
  const walk = (nodes: any[]): any => {
    for (const n of nodes) {
      if (n.scroll) return n.scroll;
      const hit = walk(n.children ?? []);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(useUITreeStore.getState().tree as any[]);
}

/** Arm the px request the way `entriesSystem` does once it has resolved entry size. */
function armPxRequest(view: any, top: number) {
  const sv = view.get(UIScrollView) as any;
  view.set(UIScrollView, { ...sv, scrollToY: top });
}

describe('per-request scroll behaviour survives the projection (#409)', () => {
  beforeEach(() => { vi.resetModules(); testWorld = createWorld(); });

  it('carries a SMOOTH request across a view authored INSTANT', async () => {
    const { scrollToEntry } = await import('../../src/runtime/ui/scrollApi');
    const { pendingScrollTo } = await import('../../src/runtime/ui/scrollViewDom');
    const view = spawnView('instant');

    expect(scrollToEntry(GUID, { y: 2 }, { behavior: 'smooth' })).toBe(true);
    armPxRequest(view, 240);

    const scroll = await projectedScroll();
    expect(scroll, 'the projection emitted no scroll node').toBeTruthy();
    expect(pendingScrollTo(scroll)!.behavior).toBe('smooth');
    // The author's field is untouched by the request — the whole point of the split.
    expect((view.get(UIScrollView) as any).scrollBehavior).toBe('instant');
  });

  it('carries an INSTANT request across a view authored SMOOTH', async () => {
    const { scrollToEntry } = await import('../../src/runtime/ui/scrollApi');
    const { pendingScrollTo } = await import('../../src/runtime/ui/scrollViewDom');
    const view = spawnView('smooth');

    scrollToEntry(GUID, { y: 2 }, { behavior: 'instant' });
    armPxRequest(view, 240);

    expect(pendingScrollTo(await projectedScroll())!.behavior).toBe('instant');
    expect((view.get(UIScrollView) as any).scrollBehavior).toBe('smooth');
  });

  it('falls back to the AUTHORED motion when the request names none', async () => {
    const { scrollToEntry } = await import('../../src/runtime/ui/scrollApi');
    const { pendingScrollTo } = await import('../../src/runtime/ui/scrollViewDom');
    const view = spawnView('smooth');

    scrollToEntry(GUID, { y: 2 });                 // no `behavior` — the case that used to clobber
    armPxRequest(view, 240);

    expect(pendingScrollTo(await projectedScroll())!.behavior).toBe('smooth');
    expect((view.get(UIScrollView) as any).scrollBehavior).toBe('smooth');
  });

  it('does not let a consumed request steer the NEXT one', async () => {
    const { scrollToEntry } = await import('../../src/runtime/ui/scrollApi');
    const { pendingScrollTo, clearScrollRequest } = await import('../../src/runtime/ui/scrollViewDom');
    const view = spawnView('instant');

    scrollToEntry(GUID, { y: 2 }, { behavior: 'smooth' });
    armPxRequest(view, 240);
    const first = await projectedScroll();
    expect(pendingScrollTo(first)!.behavior).toBe('smooth');
    clearScrollRequest(GUID, first.scrollToBehavior);   // the renderer consumes it

    scrollToEntry(GUID, { y: 4 });                      // a later request, naming nothing
    armPxRequest(view, 480);
    expect(pendingScrollTo(await projectedScroll())!.behavior).toBe('instant');
  });

  it('does NOT clear an override armed after the snapshot the renderer is holding', async () => {
    // The renderer decides to clear from the projection SNAPSHOT but clears the LIVE trait. A
    // request arming 'smooth' in that window would have had its behaviour wiped and fallen back to
    // the authored default — intermittently, with the trait reading clean afterwards.
    const { scrollToEntry } = await import('../../src/runtime/ui/scrollApi');
    const { clearScrollRequest } = await import('../../src/runtime/ui/scrollViewDom');
    const view = spawnView('instant');

    scrollToEntry(GUID, { y: 2 }, { behavior: 'instant' });
    armPxRequest(view, 240);
    const consumed = (await projectedScroll()).scrollToBehavior;   // 'instant'

    scrollToEntry(GUID, { y: 4 }, { behavior: 'smooth' });         // lands before the effect flushes
    clearScrollRequest(GUID, consumed);

    expect((view.get(UIScrollView) as any).scrollToBehavior).toBe('smooth');
  });
});
