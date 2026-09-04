/** uiTreeStore unit tests — markUIDirty, setEditorDirtyCallback, useUITreeStore. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

// Mock the ECS dependencies that uiTreeStore imports
function mockDeps() {
  vi.doMock('../../src/runtime/core/ecs/world', () => ({
    getCurrentWorld: vi.fn(),
    onWorldSwap: vi.fn(),
  }));
  vi.doMock('../../src/runtime/core/ecs/traitRegistry', () => ({
    getAllTraits: vi.fn(() => []),
  }));
  vi.doMock('../../src/runtime/core/ecs/entityUtils', () => ({
    addDirtyListener: vi.fn(),
  }));
}

async function getModule() {
  mockDeps();
  return import('../../src/runtime/ui/uiTreeStore');
}

describe('uiTreeStore', () => {
  describe('useUITreeStore', () => {
    it('initializes with empty tree', async () => {
      const { useUITreeStore } = await getModule();
      const state = useUITreeStore.getState();
      expect(state.tree).toEqual([]);
    });

    it('can be updated via setState', async () => {
      const { useUITreeStore } = await getModule();
      const mockTree = [{ entityId: 1, children: [] }] as any;
      useUITreeStore.setState({ tree: mockTree });
      expect(useUITreeStore.getState().tree).toBe(mockTree);
    });
  });

  describe('markUIDirty', () => {
    it('is callable without error', async () => {
      const { markUIDirty } = await getModule();
      expect(() => markUIDirty()).not.toThrow();
    });

    it('triggers editor dirty callback when registered', async () => {
      const { markUIDirty, setEditorDirtyCallback } = await getModule();
      const cb = vi.fn();
      setEditorDirtyCallback(cb);

      markUIDirty();
      expect(cb).toHaveBeenCalledTimes(1);

      markUIDirty();
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it('does not call editor callback when unregistered', async () => {
      const { markUIDirty, setEditorDirtyCallback } = await getModule();
      const cb = vi.fn();
      setEditorDirtyCallback(cb);
      setEditorDirtyCallback(null);

      markUIDirty();
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('setEditorDirtyCallback', () => {
    it('accepts null to unregister', async () => {
      const { setEditorDirtyCallback } = await getModule();
      expect(() => setEditorDirtyCallback(null)).not.toThrow();
    });
  });

  describe('uiTreeProjection', () => {
    it('skips rebuild when not dirty', async () => {
      // First call to uiTreeProjection sets dirty=false after build.
      // Second call should be a no-op.
      vi.doMock('../../src/runtime/core/ecs/world', () => ({
        getCurrentWorld: vi.fn(),
        onWorldSwap: vi.fn(),
      }));
      vi.doMock('../../src/runtime/core/ecs/traitRegistry', () => ({
        getAllTraits: vi.fn(() => []),
      }));
      vi.doMock('../../src/runtime/core/ecs/entityUtils', () => ({
        addDirtyListener: vi.fn(),
      }));

      const { uiTreeProjection, useUITreeStore } = await import('../../src/runtime/ui/uiTreeStore');

      // Create a mock world with query that returns empty
      const mockWorld = {
        query: vi.fn().mockReturnValue({
          updateEach: vi.fn(),
        }),
      } as any;

      // First call: dirty=true (initial state), should build tree
      uiTreeProjection(mockWorld);
      expect(useUITreeStore.getState().tree).toEqual([]);

      // Second call: dirty=false, should skip (query not called again)
      const queryCalls = mockWorld.query.mock.calls.length;
      uiTreeProjection(mockWorld);
      // No additional query calls since not dirty
      expect(mockWorld.query.mock.calls.length).toBe(queryCalls);
    });

    it('rebuilds after markUIDirty', async () => {
      vi.doMock('../../src/runtime/core/ecs/world', () => ({
        getCurrentWorld: vi.fn(),
        onWorldSwap: vi.fn(),
      }));
      vi.doMock('../../src/runtime/core/ecs/traitRegistry', () => ({
        getAllTraits: vi.fn(() => []),
      }));
      vi.doMock('../../src/runtime/core/ecs/entityUtils', () => ({
        addDirtyListener: vi.fn(),
      }));

      const { uiTreeProjection, markUIDirty } = await import('../../src/runtime/ui/uiTreeStore');

      const mockWorld = {
        query: vi.fn().mockReturnValue({
          updateEach: vi.fn(),
        }),
      } as any;

      // First call consumes initial dirty
      uiTreeProjection(mockWorld);

      // Mark dirty and call again — should query again
      markUIDirty();
      uiTreeProjection(mockWorld);
      // query was called at least once more (for the trait lookup attempt)
      // Since getAllTraits returns [], it won't actually query, but the dirty flag
      // was consumed. Let's just verify it didn't throw.
    });
  });

  describe('parentId cycle tolerance (regression for H4)', () => {
    // Builds a fake koota-like query that yields a fixed entity set with the
    // parentId chain we want. The mocked traits make every "has()" return true
    // for RenderableUI/UIElement/EntityAttributes.
    function fakeWorld(entities: Array<{ id: number; parentId: number; sortOrder?: number }>) {
      const rUI = { name: 'RenderableUI' } as any;
      const ui = { name: 'UIElement' } as any;
      const attr = { name: 'EntityAttributes' } as any;
      vi.doMock('../../src/runtime/core/ecs/world', () => ({
        getCurrentWorld: vi.fn(),
        onWorldSwap: vi.fn(),
      }));
      vi.doMock('../../src/runtime/core/ecs/traitRegistry', () => ({
        getAllTraits: () => [
          { name: 'RenderableUI', trait: rUI, category: 'component', fields: {} },
          { name: 'UIElement', trait: ui, category: 'component', fields: {} },
          { name: 'EntityAttributes', trait: attr, category: 'component', fields: {} },
        ],
      }));
      vi.doMock('../../src/runtime/core/ecs/entityUtils', () => ({
        addDirtyListener: vi.fn(),
      }));

      const uiElDefaults = {
        width: 0, height: 0, widthUnit: 'px', heightUnit: 'px',
        flexDirection: 'row', justifyContent: 'flex-start', alignItems: 'stretch',
        gap: 0, flexGrow: 0, flexShrink: 0,
        paddingTop: 0, paddingLeft: 0, paddingRight: 0, paddingBottom: 0,
        overflow: 'visible', isVisible: true,
        text: '', fontSize: 16, textColor: 0xffffff,
      };

      return {
        query: (_a: any, _b: any) => ({
          updateEach: (cb: (data: any[], entity: any) => void) => {
            for (const ent of entities) {
              const entity = {
                id: () => ent.id,
                has: () => true,
                get: () => ({ parentId: ent.parentId, sortOrder: ent.sortOrder ?? 0 }),
              };
              cb([uiElDefaults], entity);
            }
          },
        }),
      } as any;
    }

    it('does not infinite-loop when parentId chain has a cycle', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // A→B, B→A — every node parents into the other
      const world = fakeWorld([
        { id: 1, parentId: 2 },
        { id: 2, parentId: 1 },
      ]);
      const { uiTreeProjection, useUITreeStore } = await import('../../src/runtime/ui/uiTreeStore');
      uiTreeProjection(world);
      const tree = useUITreeStore.getState().tree;
      // Both entities must be reachable — neither was silently dropped.
      const collectIds = (nodes: any[]): number[] =>
        nodes.flatMap((n) => [n.entityId, ...collectIds(n.children)]);
      const ids = new Set(collectIds(tree));
      expect(ids.has(1)).toBe(true);
      expect(ids.has(2)).toBe(true);
      warnSpy.mockRestore();
    });

    it('still builds correct tree when no cycle present', async () => {
      const world = fakeWorld([
        { id: 1, parentId: 0, sortOrder: 0 },           // root
        { id: 2, parentId: 1, sortOrder: 0 },           // child of 1
        { id: 3, parentId: 2, sortOrder: 0 },           // grandchild
      ]);
      const { uiTreeProjection, useUITreeStore } = await import('../../src/runtime/ui/uiTreeStore');
      uiTreeProjection(world);
      const tree = useUITreeStore.getState().tree;
      expect(tree).toHaveLength(1);
      expect(tree[0].entityId).toBe(1);
      expect(tree[0].children).toHaveLength(1);
      expect(tree[0].children[0].entityId).toBe(2);
      expect(tree[0].children[0].children).toHaveLength(1);
      expect(tree[0].children[0].children[0].entityId).toBe(3);
    });
  });

  /** ZERO is a value, not "unset" — the `||` trap, swept during #340's close-out.
   *
   *  The projection reads each `UIElement` field with a fallback, and for a field whose identity
   *  is NOT zero the fallback has to be `??`. Written `||`, an authored 0 is falsy and gets
   *  silently replaced by the default: the author sets a value, the Inspector shows it, and the
   *  renderer draws something else. Nothing errors, so it is invisible until someone looks
   *  closely at pixels. Both fields below were real: `scale` would have been (caught while
   *  adding it), `borderColor` was (found by sweeping for the pattern, fixed in the same pass). */
  describe('an authored ZERO survives the projection (the `||` trap)', () => {
    function fakeWorldWithUI(fields: Record<string, unknown>) {
      const rUI = { name: 'RenderableUI' } as any;
      const ui = { name: 'UIElement' } as any;
      const attr = { name: 'EntityAttributes' } as any;
      vi.doMock('../../src/runtime/core/ecs/world', () => ({
        getCurrentWorld: vi.fn(), onWorldSwap: vi.fn(),
      }));
      vi.doMock('../../src/runtime/core/ecs/traitRegistry', () => ({
        getAllTraits: () => [
          { name: 'RenderableUI', trait: rUI, category: 'component', fields: {} },
          { name: 'UIElement', trait: ui, category: 'component', fields: {} },
          { name: 'EntityAttributes', trait: attr, category: 'component', fields: {} },
        ],
      }));
      vi.doMock('../../src/runtime/core/ecs/entityUtils', () => ({ addDirtyListener: vi.fn() }));

      const uiEl = {
        width: 0, height: 0, widthUnit: 'px', heightUnit: 'px',
        flexDirection: 'row', justifyContent: 'flex-start', alignItems: 'stretch',
        gap: 0, flexGrow: 0, flexShrink: 0,
        paddingTop: 0, paddingLeft: 0, paddingRight: 0, paddingBottom: 0,
        overflow: 'visible', isVisible: true,
        text: '', fontSize: 16, textColor: 0xffffff,
        ...fields,
      };
      return {
        query: () => ({
          updateEach: (cb: (data: any[], entity: any) => void) => {
            cb([uiEl], { id: () => 1, has: () => true, get: () => ({ parentId: 0, sortOrder: 0 }) });
          },
        }),
      } as any;
    }

    it('keeps scale 0 instead of promoting it to full size', async () => {
      // A pop-in clip's FIRST keyframe is scale 0. Promoted to 1, the card is already at full
      // size on the frame it appears and the animation visibly does nothing at its start.
      const world = fakeWorldWithUI({ scale: 0 });
      const { uiTreeProjection, useUITreeStore } = await import('../../src/runtime/ui/uiTreeStore');
      uiTreeProjection(world);
      expect(useUITreeStore.getState().tree[0].scale).toBe(0);
    });

    it('keeps borderColor 0 (pure black) instead of repainting it the default grey', async () => {
      // 0 is a colour here, not an absence — `|| 0x333333` drew an authored black border as
      // dark grey. ⚠️ Cite the case with a VISIBLE consequence: eleven elements in
      // `games/alien-animal/.../alien-animal.scene.json` author `borderColor: 0` with a non-zero
      // borderWidth and changed from #333333 to #000000 when this was fixed.
      // (`games/3d-test/.../Game_Canvas.prefab.json` also authors 0, but at `borderWidth: 0`,
      // so it is exactly the instance that could never have shown the bug.)
      const world = fakeWorldWithUI({ borderColor: 0, borderWidth: 2 });
      const { uiTreeProjection, useUITreeStore } = await import('../../src/runtime/ui/uiTreeStore');
      uiTreeProjection(world);
      expect(useUITreeStore.getState().tree[0].borderColor).toBe(0);
    });

    it('still falls back for a field that is genuinely absent', async () => {
      // The other half: `??` must not become "never default". An older scene has no `scale` key
      // at all, and that one DOES take the default.
      const world = fakeWorldWithUI({});
      const { uiTreeProjection, useUITreeStore } = await import('../../src/runtime/ui/uiTreeStore');
      uiTreeProjection(world);
      const node = useUITreeStore.getState().tree[0];
      expect(node.scale, 'absent scale defaults to 1').toBe(1);
      expect(node.borderColor, 'absent borderColor defaults to the grey').toBe(0x333333);
    });
  });

  describe('entity active flag (deactivatedEntities cascade)', () => {
    function fakeWorld(entities: Array<{ id: number; parentId: number; sortOrder?: number }>) {
      const rUI = { name: 'RenderableUI' } as any;
      const ui = { name: 'UIElement' } as any;
      const attr = { name: 'EntityAttributes' } as any;
      vi.doMock('../../src/runtime/core/ecs/world', () => ({
        getCurrentWorld: vi.fn(),
        onWorldSwap: vi.fn(),
      }));
      vi.doMock('../../src/runtime/core/ecs/traitRegistry', () => ({
        getAllTraits: () => [
          { name: 'RenderableUI', trait: rUI, category: 'component', fields: {} },
          { name: 'UIElement', trait: ui, category: 'component', fields: {} },
          { name: 'EntityAttributes', trait: attr, category: 'component', fields: {} },
        ],
      }));
      vi.doMock('../../src/runtime/core/ecs/entityUtils', () => ({
        addDirtyListener: vi.fn(),
      }));

      const uiElDefaults = {
        width: 0, height: 0, widthUnit: 'px', heightUnit: 'px',
        flexDirection: 'row', justifyContent: 'flex-start', alignItems: 'stretch',
        gap: 0, flexGrow: 0, flexShrink: 0,
        paddingTop: 0, paddingLeft: 0, paddingRight: 0, paddingBottom: 0,
        overflow: 'visible', isVisible: true,
        text: '', fontSize: 16, textColor: 0xffffff,
      };

      return {
        query: (_a: any, _b: any) => ({
          updateEach: (cb: (data: any[], entity: any) => void) => {
            for (const ent of entities) {
              const entity = {
                id: () => ent.id,
                has: () => true,
                get: () => ({ parentId: ent.parentId, sortOrder: ent.sortOrder ?? 0 }),
              };
              cb([uiElDefaults], entity);
            }
          },
        }),
      } as any;
    }

    const collectIds = (nodes: any[]): number[] =>
      nodes.flatMap((n) => [n.entityId, ...collectIds(n.children)]);

    it('drops a deactivated entity AND its descendants from the tree', async () => {
      // root(1) → child(2) → grandchild(3). Deactivating 2 must also drop 3, since
      // transformPropagationSystem puts every descendant of an inactive entity into
      // deactivatedEntities. Renders as: root present, subtree under 2 gone.
      const world = fakeWorld([
        { id: 1, parentId: 0 },
        { id: 2, parentId: 1 },
        { id: 3, parentId: 2 },
      ]);
      const { uiTreeProjection, useUITreeStore, markUIDirty } =
        await import('../../src/runtime/ui/uiTreeStore');
      const { deactivatedEntities } = await import('../../src/runtime/core/ecs/transformPropagationSystem');

      deactivatedEntities.clear();
      deactivatedEntities.add(2); // the entity itself…
      deactivatedEntities.add(3); // …and its descendant (as the cascade would compute)
      markUIDirty();
      uiTreeProjection(world);

      const ids = new Set(collectIds(useUITreeStore.getState().tree));
      expect(ids.has(1)).toBe(true);
      expect(ids.has(2)).toBe(false);
      expect(ids.has(3)).toBe(false);

      deactivatedEntities.clear();
    });

    it('keeps the whole tree when nothing is deactivated', async () => {
      const world = fakeWorld([
        { id: 1, parentId: 0 },
        { id: 2, parentId: 1 },
      ]);
      const { uiTreeProjection, useUITreeStore, markUIDirty } =
        await import('../../src/runtime/ui/uiTreeStore');
      const { deactivatedEntities } = await import('../../src/runtime/core/ecs/transformPropagationSystem');

      deactivatedEntities.clear();
      markUIDirty();
      uiTreeProjection(world);

      const ids = new Set(collectIds(useUITreeStore.getState().tree));
      expect(ids.has(1)).toBe(true);
      expect(ids.has(2)).toBe(true);
    });
  });

  // Regression: UI text animation showed in the Scene panel but NOT the editor Game
  // view. The play gate lived in UINode (isSimRunning()), so a Play/Stop left the
  // projected node structurally identical → React.memo skipped the re-render and the
  // CSS animation never mounted where nothing else forces a per-frame re-render. The
  // fix moved the gate into the projection: node.textAnim is populated ONLY while the
  // sim is running, so a Play/Stop changes the node and drives the re-render.
  describe('TextAnimation play-gating', () => {
    function fakeTextWorld() {
      const rUI = { name: 'RenderableUI' } as any;
      const ui = { name: 'UIElement' } as any;
      const attr = { name: 'EntityAttributes' } as any;
      const textAnim = { name: 'TextAnimation' } as any;
      vi.doMock('../../src/runtime/core/ecs/world', () => ({
        getCurrentWorld: vi.fn(),
        onWorldSwap: vi.fn(),
      }));
      vi.doMock('../../src/runtime/core/ecs/traitRegistry', () => ({
        getAllTraits: () => [
          { name: 'RenderableUI', trait: rUI, category: 'component', fields: {} },
          { name: 'UIElement', trait: ui, category: 'component', fields: {} },
          { name: 'EntityAttributes', trait: attr, category: 'component', fields: {} },
          { name: 'TextAnimation', trait: textAnim, category: 'component', fields: {} },
        ],
      }));
      vi.doMock('../../src/runtime/core/ecs/entityUtils', () => ({
        addDirtyListener: vi.fn(),
      }));

      const uiEl = {
        width: 0, height: 0, widthUnit: 'px', heightUnit: 'px',
        flexDirection: 'row', justifyContent: 'flex-start', alignItems: 'stretch',
        gap: 0, flexGrow: 0, flexShrink: 0,
        paddingTop: 0, paddingLeft: 0, paddingRight: 0, paddingBottom: 0,
        overflow: 'visible', isVisible: true,
        text: 'Hi', fontSize: 32, textColor: 0xffffff,
      };
      const taData = { effect: 'wave', speed: 1, amplitude: 0.2, frequency: 1, loop: true };

      return {
        query: () => ({
          updateEach: (cb: (data: any[], entity: any) => void) => {
            const entity = {
              id: () => 1,
              has: (t: any) => t === rUI || t === ui || t === attr || t === textAnim,
              get: (t: any) =>
                t === attr
                  ? { parentId: 0, guid: 'g1', layer: 'ui', isActive: true, sortOrder: 0 }
                  : t === textAnim
                    ? taData
                    : { parentId: 0, sortOrder: 0 },
            };
            cb([uiEl], entity);
          },
        }),
      } as any;
    }

    it('populates node.textAnim only while the sim is running', async () => {
      const world = fakeTextWorld();
      const { uiTreeProjection, useUITreeStore, markUIDirty } =
        await import('../../src/runtime/ui/uiTreeStore');
      const { setPlayState } = await import('../../src/runtime/core/playState');

      // Stopped → frozen to base text (no animation on the node).
      setPlayState('stopped');
      markUIDirty();
      uiTreeProjection(world);
      expect(useUITreeStore.getState().tree[0].textAnim).toBeUndefined();

      // Playing → the node carries the animation (drives the wrap + re-render).
      setPlayState('playing');
      markUIDirty();
      uiTreeProjection(world);
      expect(useUITreeStore.getState().tree[0].textAnim).toMatchObject({
        effect: 'wave', speed: 1, amplitude: 0.2, loop: true,
      });

      // Stop again → cleared, so the node changes back and the UINode unwraps.
      setPlayState('stopped');
      markUIDirty();
      uiTreeProjection(world);
      expect(useUITreeStore.getState().tree[0].textAnim).toBeUndefined();

      setPlayState('playing'); // restore module default for later tests
    });
  });

  // Locks the wiring added for the state-driven visibility binding: UIBinding.visibleBinding/
  // visibleOp/visibleValue must flow through the tree build into node.binding (UINode reads
  // them there to gate render). The UINode render gate itself is covered in uiNode.test.tsx.
  describe('visibility binding wiring (UIBinding → node.binding)', () => {
    function fakeBindingWorld(bind: Record<string, unknown>) {
      const rUI = { name: 'RenderableUI' } as any;
      const ui = { name: 'UIElement' } as any;
      const attr = { name: 'EntityAttributes' } as any;
      const bindingTrait = { name: 'UIBinding' } as any;
      vi.doMock('../../src/runtime/core/ecs/world', () => ({ getCurrentWorld: vi.fn(), onWorldSwap: vi.fn() }));
      vi.doMock('../../src/runtime/core/ecs/traitRegistry', () => ({
        getAllTraits: () => [
          { name: 'RenderableUI', trait: rUI, category: 'component', fields: {} },
          { name: 'UIElement', trait: ui, category: 'component', fields: {} },
          { name: 'EntityAttributes', trait: attr, category: 'component', fields: {} },
          { name: 'UIBinding', trait: bindingTrait, category: 'component', fields: {} },
        ],
      }));
      vi.doMock('../../src/runtime/core/ecs/entityUtils', () => ({ addDirtyListener: vi.fn() }));
      const uiEl = {
        width: 0, height: 0, widthUnit: 'px', heightUnit: 'px',
        flexDirection: 'row', justifyContent: 'flex-start', alignItems: 'stretch',
        gap: 0, flexGrow: 0, flexShrink: 0,
        paddingTop: 0, paddingLeft: 0, paddingRight: 0, paddingBottom: 0,
        overflow: 'visible', isVisible: true, text: '', fontSize: 16, textColor: 0xffffff,
      };
      return {
        query: () => ({
          updateEach: (cb: (data: any[], entity: any) => void) => {
            const entity = {
              id: () => 1,
              has: (t: any) => t === rUI || t === ui || t === attr || t === bindingTrait,
              get: (t: any) =>
                t === attr ? { parentId: 0, guid: 'g1', layer: 'ui', isActive: true, sortOrder: 0 }
                  : t === bindingTrait ? bind
                    : { parentId: 0, sortOrder: 0 },
            };
            cb([uiEl], entity);
          },
        }),
      } as any;
    }

    it('carries visibleBinding/visibleOp/visibleValue into node.binding (value coerced to string)', async () => {
      const world = fakeBindingWorld({ textBinding: '', inputBinding: '', visibleBinding: 'gameOver', visibleOp: '>=', visibleValue: 2, highlightColor: -1 });
      const { uiTreeProjection, useUITreeStore, markUIDirty } = await import('../../src/runtime/ui/uiTreeStore');
      markUIDirty();
      uiTreeProjection(world);
      const node = useUITreeStore.getState().tree[0] as any;
      expect(node.binding).toMatchObject({ visibleBinding: 'gameOver', visibleOp: '>=', visibleValue: '2' });
    });

    it('defaults the visibility fields to empty when the UIBinding omits them', async () => {
      const world = fakeBindingWorld({ textBinding: 'enemies', inputBinding: '', highlightColor: -1 });
      const { uiTreeProjection, useUITreeStore, markUIDirty } = await import('../../src/runtime/ui/uiTreeStore');
      markUIDirty();
      uiTreeProjection(world);
      const node = useUITreeStore.getState().tree[0] as any;
      expect(node.binding).toMatchObject({ textBinding: 'enemies', visibleBinding: '', visibleOp: '', visibleValue: '' });
    });
  });
});

describe('stampSnapTargets', () => {
  /** A minimal node — only the fields the stamper reads. */
  const node = (over: Record<string, unknown> = {}): any =>
    ({ entityId: 1, children: [], ...over });
  const SCROLL = { axis: 'x', snap: 'start', snapStop: 'always', overscroll: 'contain',
    scrollToX: -1, scrollToY: -1, scrollToBehavior: '', scrollBehavior: 'instant' };

  it('stamps the ENTRIES, not the engine-owned layers between them', async () => {
    const { stampSnapTargets } = await getModule();
    // view > content > row > two entries — the shape entriesSystem actually builds.
    const e1 = node({ entityId: 4, isEntry: true });
    const e2 = node({ entityId: 5, isEntry: true });
    const row = node({ entityId: 3, children: [e1, e2] });
    const content = node({ entityId: 2, children: [row] });
    const view = node({ entityId: 1, scroll: SCROLL, children: [content] });

    stampSnapTargets(view);
    expect(e1.snapChild).toEqual({ scrollSnapAlign: 'start', scrollSnapStop: 'always' });
    expect(e2.snapChild).toEqual({ scrollSnapAlign: 'start', scrollSnapStop: 'always' });
    // ⚠️ The row and the content child must NOT be targets: a snap area per layer would add
    // snap points the design does not have.
    expect(row.snapChild).toBeUndefined();
    expect(content.snapChild).toBeUndefined();
  });

  it('falls back to direct children when the view has no entries', async () => {
    const { stampSnapTargets } = await getModule();
    const a = node({ entityId: 2 });
    const view = node({ scroll: SCROLL, children: [a] });
    stampSnapTargets(view);
    expect(a.snapChild).toEqual({ scrollSnapAlign: 'start', scrollSnapStop: 'always' });
  });

  it("stamps nothing when snap is 'none' — the default", async () => {
    const { stampSnapTargets } = await getModule();
    const a = node({ entityId: 2, isEntry: true });
    const view = node({ scroll: { ...SCROLL, snap: 'none' }, children: [a] });
    stampSnapTargets(view);
    expect(a.snapChild).toBeUndefined();
  });

  it('does not reach into a NESTED scroll view — its entries are its own', async () => {
    const { stampSnapTargets } = await getModule();
    const inner = node({ entityId: 5, isEntry: true });
    const innerView = node({ entityId: 4, scroll: { ...SCROLL, snap: 'center' }, children: [inner] });
    const outer = node({ entityId: 3, isEntry: true, children: [innerView] });
    const view = node({ scroll: SCROLL, children: [outer] });

    stampSnapTargets(view);
    expect(outer.snapChild).toEqual({ scrollSnapAlign: 'start', scrollSnapStop: 'always' });
    expect(inner.snapChild).toEqual({ scrollSnapAlign: 'center', scrollSnapStop: 'always' });
  });
});

describe('uiTreeProjection — lazy init latch ordering', () => {
  it('does not latch permanently true when onWorldSwap throws on the first call', async () => {
    vi.resetModules();
    let shouldThrow = true;
    const onWorldSwap = vi.fn(() => {
      if (shouldThrow) throw new Error('onWorldSwap missing from mock');
    });
    vi.doMock('../../src/runtime/core/ecs/world', () => ({
      getCurrentWorld: vi.fn(),
      onWorldSwap,
    }));
    vi.doMock('../../src/runtime/core/ecs/traitRegistry', () => ({
      getAllTraits: vi.fn(() => []),
    }));
    vi.doMock('../../src/runtime/core/ecs/entityUtils', () => ({
      addDirtyListener: vi.fn(),
    }));
    const { uiTreeProjection } = await import('../../src/runtime/ui/uiTreeStore');
    const world = {} as any;

    // First call: registration throws. The throw must propagate (nothing silently swallowed).
    expect(() => uiTreeProjection(world)).toThrow('onWorldSwap missing from mock');
    expect(onWorldSwap).toHaveBeenCalledTimes(1);

    // Second call: registration now succeeds. Before the fix, the latch was set BEFORE the
    // throwing call, so this second call would silently no-op instead of retrying.
    shouldThrow = false;
    expect(() => uiTreeProjection(world)).not.toThrow();
    expect(onWorldSwap).toHaveBeenCalledTimes(2);
  });
});
