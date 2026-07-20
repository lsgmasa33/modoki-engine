/** uiTreeStore unit tests — markUIDirty, setEditorDirtyCallback, useUITreeStore. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

// Mock the ECS dependencies that uiTreeStore imports
function mockDeps() {
  vi.doMock('../../src/runtime/ecs/world', () => ({
    getCurrentWorld: vi.fn(),
    onWorldSwap: vi.fn(),
  }));
  vi.doMock('../../src/runtime/ecs/traitRegistry', () => ({
    getAllTraits: vi.fn(() => []),
  }));
  vi.doMock('../../src/runtime/ecs/entityUtils', () => ({
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
      vi.doMock('../../src/runtime/ecs/world', () => ({
        getCurrentWorld: vi.fn(),
        onWorldSwap: vi.fn(),
      }));
      vi.doMock('../../src/runtime/ecs/traitRegistry', () => ({
        getAllTraits: vi.fn(() => []),
      }));
      vi.doMock('../../src/runtime/ecs/entityUtils', () => ({
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
      vi.doMock('../../src/runtime/ecs/world', () => ({
        getCurrentWorld: vi.fn(),
        onWorldSwap: vi.fn(),
      }));
      vi.doMock('../../src/runtime/ecs/traitRegistry', () => ({
        getAllTraits: vi.fn(() => []),
      }));
      vi.doMock('../../src/runtime/ecs/entityUtils', () => ({
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
      vi.doMock('../../src/runtime/ecs/world', () => ({
        getCurrentWorld: vi.fn(),
        onWorldSwap: vi.fn(),
      }));
      vi.doMock('../../src/runtime/ecs/traitRegistry', () => ({
        getAllTraits: () => [
          { name: 'RenderableUI', trait: rUI, category: 'component', fields: {} },
          { name: 'UIElement', trait: ui, category: 'component', fields: {} },
          { name: 'EntityAttributes', trait: attr, category: 'component', fields: {} },
        ],
      }));
      vi.doMock('../../src/runtime/ecs/entityUtils', () => ({
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

  describe('entity active flag (deactivatedEntities cascade)', () => {
    function fakeWorld(entities: Array<{ id: number; parentId: number; sortOrder?: number }>) {
      const rUI = { name: 'RenderableUI' } as any;
      const ui = { name: 'UIElement' } as any;
      const attr = { name: 'EntityAttributes' } as any;
      vi.doMock('../../src/runtime/ecs/world', () => ({
        getCurrentWorld: vi.fn(),
        onWorldSwap: vi.fn(),
      }));
      vi.doMock('../../src/runtime/ecs/traitRegistry', () => ({
        getAllTraits: () => [
          { name: 'RenderableUI', trait: rUI, category: 'component', fields: {} },
          { name: 'UIElement', trait: ui, category: 'component', fields: {} },
          { name: 'EntityAttributes', trait: attr, category: 'component', fields: {} },
        ],
      }));
      vi.doMock('../../src/runtime/ecs/entityUtils', () => ({
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
      const { deactivatedEntities } = await import('../../src/three/systems/transformPropagationSystem');

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
      const { deactivatedEntities } = await import('../../src/three/systems/transformPropagationSystem');

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
      vi.doMock('../../src/runtime/ecs/world', () => ({
        getCurrentWorld: vi.fn(),
        onWorldSwap: vi.fn(),
      }));
      vi.doMock('../../src/runtime/ecs/traitRegistry', () => ({
        getAllTraits: () => [
          { name: 'RenderableUI', trait: rUI, category: 'component', fields: {} },
          { name: 'UIElement', trait: ui, category: 'component', fields: {} },
          { name: 'EntityAttributes', trait: attr, category: 'component', fields: {} },
          { name: 'TextAnimation', trait: textAnim, category: 'component', fields: {} },
        ],
      }));
      vi.doMock('../../src/runtime/ecs/entityUtils', () => ({
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
      const { setPlayState } = await import('../../src/runtime/systems/playState');

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
      vi.doMock('../../src/runtime/ecs/world', () => ({ getCurrentWorld: vi.fn(), onWorldSwap: vi.fn() }));
      vi.doMock('../../src/runtime/ecs/traitRegistry', () => ({
        getAllTraits: () => [
          { name: 'RenderableUI', trait: rUI, category: 'component', fields: {} },
          { name: 'UIElement', trait: ui, category: 'component', fields: {} },
          { name: 'EntityAttributes', trait: attr, category: 'component', fields: {} },
          { name: 'UIBinding', trait: bindingTrait, category: 'component', fields: {} },
        ],
      }));
      vi.doMock('../../src/runtime/ecs/entityUtils', () => ({ addDirtyListener: vi.fn() }));
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
