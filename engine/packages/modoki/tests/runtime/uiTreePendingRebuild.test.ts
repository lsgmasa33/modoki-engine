/** A rebuild request must SURVIVE a build that could not run yet (#213).
 *
 *  `uiTreeProjection` used to `clearUIDirty()` BEFORE building, and `buildTree` returns
 *  "not yet" while the trait registry is still empty. So the one `markUIDirty()` that
 *  `loadSceneFile` fires for a whole scene could be consumed by a build that produced
 *  nothing — after which the UI tree stayed EMPTY until some unrelated code happened to
 *  dirty it again. The old comment claimed it "self-corrects on the next markUIDirty
 *  rebuild"; nothing guarantees a next one.
 *
 *  Why it matters beyond blank chrome: no tree means no `Canvas2D` node, so
 *  `Canvas2DMount` never mounts, so a 2D game renders NOTHING — no error, no warning, a
 *  correct-looking ECS. That is the failure mode this whole issue was chasing on device.
 *
 *  These drive the REAL projection with a trait registry that starts empty and fills in
 *  later, which is the ordering the race actually produces.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => { vi.resetModules(); });

const RUI = { id: 'RenderableUI' };
const UIEL = { id: 'UIElement' };
const ATTR = { id: 'EntityAttributes' };

const UI_DEFAULTS = {
  width: 100, height: 40, widthUnit: 'px', heightUnit: 'px',
  flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'flex-start', alignItems: 'stretch',
  gap: 0, flexGrow: 0, flexShrink: 1,
  paddingTop: 0, paddingLeft: 0, paddingRight: 0, paddingBottom: 0,
  marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
  minWidth: 0, maxWidth: 0, minHeight: 0, maxHeight: 0,
  alignSelf: 'auto', zIndex: 0, overflow: 'visible', isVisible: true,
  backgroundColor: 0, backgroundOpacity: 0, borderRadius: 0, borderWidth: 0,
  borderColor: 0x333333, borderOpacity: 1, opacity: 1,
  text: 'hi', fontFamily: '', fontSize: 16, fontWeight: 'normal', fontStyle: 'normal',
  textColor: 0xffffff, textOpacity: 1, textAlign: 'left', lineHeight: 0, letterSpacing: 0,
  textShadowColor: 0, textShadowOpacity: 1, textShadowOffsetX: 0, textShadowOffsetY: 0, textShadowBlur: 0,
  textStrokeColor: 0, textStrokeOpacity: 1, textStrokeWidth: 0, textOverflow: 'clip', maxLines: 0,
  imageSrc: '', imageMode: 'cover', elementType: 'div', placeholder: '',
  rangeMin: 0, rangeMax: 100, rangeStep: 1,
};

function makeWorld() {
  return {
    query: () => ({
      updateEach: (cb: (data: unknown[], entity: unknown) => void) => {
        const data = new Map<unknown, unknown>();
        data.set(UIEL, { ...UI_DEFAULTS });
        data.set(ATTR, { parentId: 0, sortOrder: 0, guid: 'g1' });
        const entity = { id: () => 1, has: (t: unknown) => data.has(t), get: (t: unknown) => data.get(t), generation: () => 0 };
        cb([data.get(UIEL)], entity);
      },
    }),
    // No `UISettings` singleton in this fixture (#803) — the projection reads it every
    // rebuild via `world.queryFirst`, unconditionally.
    queryFirst: () => undefined,
  } as never;
}

/** Trait registry that starts EMPTY and is filled by `registerLate()` — the real ordering:
 *  the scene's markUIDirty can land before game/editor setup has registered UI traits. */
function mockDeps(registered: { current: unknown[] }) {
  vi.doMock('../../src/runtime/core/ecs/world', () => ({ getCurrentWorld: vi.fn(), onWorldSwap: vi.fn() }));
  vi.doMock('../../src/runtime/core/ecs/entityUtils', () => ({ addDirtyListener: vi.fn() }));
  vi.doMock('../../src/runtime/core/ecs/traitRegistry', () => ({ getAllTraits: () => registered.current }));
}

const TRAITS = [
  { name: 'RenderableUI', trait: RUI, category: 'component', fields: {} },
  { name: 'UIElement', trait: UIEL, category: 'component', fields: {} },
  { name: 'EntityAttributes', trait: ATTR, category: 'component', fields: {} },
];

describe('uiTreeProjection — a pending rebuild is never swallowed', () => {
  it('keeps the request pending when traits are not registered yet, and builds on a LATER frame with no second markUIDirty', async () => {
    const registered = { current: [] as unknown[] };
    mockDeps(registered);
    const { uiTreeProjection, useUITreeStore, markUIDirty } = await import('../../src/runtime/ui/uiTreeStore');
    const world = makeWorld();

    // The ONE signal a scene load fires, arriving before traits exist.
    markUIDirty();
    uiTreeProjection(world);
    expect(useUITreeStore.getState().tree).toEqual([]);   // nothing to build yet — fine

    // Traits register (game/editor setup). ⚠️ NOTHING dirties the UI again — that is the
    // whole point. The old code cleared the flag above, so this frame was a no-op and the
    // tree stayed empty forever.
    registered.current = TRAITS;
    uiTreeProjection(world);

    const tree = useUITreeStore.getState().tree;
    expect(tree.length, 'the pending rebuild was swallowed — UI never renders').toBe(1);
    expect(tree[0].entityId).toBe(1);
  });

  it('clears the flag once the build succeeds, so it does not rebuild every frame forever', async () => {
    const registered = { current: TRAITS as unknown[] };
    mockDeps(registered);
    const { uiTreeProjection, useUITreeStore, markUIDirty } = await import('../../src/runtime/ui/uiTreeStore');
    const world = makeWorld();

    markUIDirty();
    uiTreeProjection(world);
    const first = useUITreeStore.getState().tree;
    expect(first.length).toBe(1);

    // A second pass with no new dirty must not rebuild — node identity proves it was skipped
    // (a rebuild reconciles and would still be free to hand back the same ref, so this asserts
    // the STORE object is untouched rather than merely equal).
    uiTreeProjection(world);
    expect(useUITreeStore.getState().tree).toBe(first);
  });
});
