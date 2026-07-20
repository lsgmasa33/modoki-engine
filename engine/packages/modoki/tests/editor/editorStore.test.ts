/** editorStore unit tests — Zustand editor state: selection, gizmo, game rect, etc. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track pushed selection changes
let pushedSelections: { label: string; undo: () => void; redo: () => void }[] = [];
let executingUndoRedo = false;

vi.mock('../../src/editor/undo/undoManager', () => ({
  pushSelectionChange: (label: string, undo: () => void, redo: () => void) => {
    pushedSelections.push({ label, undo, redo });
  },
  isExecutingUndoRedo: () => executingUndoRedo,
}));

// Must import after mocks are set up
const { useEditorStore } = await import('../../src/editor/store/editorStore');
const { get2DDirtyVersion } = await import('../../src/editor/store/canvas2DDirty');

beforeEach(() => {
  pushedSelections = [];
  executingUndoRedo = false;
  // Reset store to defaults
  useEditorStore.setState({
    selectedEntityId: null,
    selectedEntityIds: [],
    selectedAsset: null,
    selectedAssets: [],
    gizmoMode: 'translate',
    gizmoSpace: 'world',
    gameViewSize: { width: 800, height: 450 },
    gameRect: { left: 0, top: 0, width: 800, height: 450 },
    assetsVersion: 0,
    importStatus: { active: false, message: '' },
    buildStatus: { active: false, message: '', step: 0, totalSteps: 5, failed: false },
  });
});

describe('editorStore', () => {
  describe('selectEntity', () => {
    it('sets selectedEntityId and clears selectedAsset', () => {
      const { selectEntity } = useEditorStore.getState();
      selectEntity(42);

      const state = useEditorStore.getState();
      expect(state.selectedEntityId).toBe(42);
      expect(state.selectedAsset).toBeNull();
    });

    it('pushes a selection change for undo', () => {
      const { selectEntity } = useEditorStore.getState();
      selectEntity(10);

      expect(pushedSelections).toHaveLength(1);
      expect(pushedSelections[0].label).toContain('Select');
    });

    it('does not push when value is unchanged', () => {
      useEditorStore.setState({ selectedEntityId: 5 });
      const { selectEntity } = useEditorStore.getState();
      selectEntity(5);

      expect(pushedSelections).toHaveLength(0);
    });

    it('does not push during undo/redo execution', () => {
      executingUndoRedo = true;
      const { selectEntity } = useEditorStore.getState();
      selectEntity(99);

      expect(useEditorStore.getState().selectedEntityId).toBe(99);
      expect(pushedSelections).toHaveLength(0);
    });

    it('undo restores previous entity selection', () => {
      const { selectEntity } = useEditorStore.getState();
      selectEntity(1);
      selectEntity(2);

      // Undo the second selection — should restore entity 1
      pushedSelections[1].undo();
      expect(useEditorStore.getState().selectedEntityId).toBe(1);
    });

    it('undo restores previous asset selection', () => {
      const asset = { path: '/test.mat.json', type: 'material', name: 'test' };
      useEditorStore.setState({ selectedAsset: asset, selectedEntityId: null });

      const { selectEntity } = useEditorStore.getState();
      selectEntity(5);

      // Undo — should restore the asset
      pushedSelections[0].undo();
      expect(useEditorStore.getState().selectedAsset).toEqual(asset);
      expect(useEditorStore.getState().selectedEntityId).toBeNull();
    });

    it('redo re-applies entity selection', () => {
      const { selectEntity } = useEditorStore.getState();
      selectEntity(7);

      // Undo then redo
      pushedSelections[0].undo();
      expect(useEditorStore.getState().selectedEntityId).toBeNull();

      pushedSelections[0].redo();
      expect(useEditorStore.getState().selectedEntityId).toBe(7);
    });

    it('deselect pushes label "Deselect"', () => {
      useEditorStore.setState({ selectedEntityId: 3 });
      const { selectEntity } = useEditorStore.getState();
      selectEntity(null);

      expect(pushedSelections).toHaveLength(1);
      expect(pushedSelections[0].label).toBe('Deselect');
    });
  });

  describe('selectEntity multi-selection mirror', () => {
    it('selectEntity sets selectedEntityIds to the single id', () => {
      useEditorStore.getState().selectEntity(42);
      expect(useEditorStore.getState().selectedEntityIds).toEqual([42]);
    });

    it('selectEntity(null) clears the set', () => {
      useEditorStore.setState({ selectedEntityId: 3, selectedEntityIds: [3, 4] });
      useEditorStore.getState().selectEntity(null);
      expect(useEditorStore.getState().selectedEntityIds).toEqual([]);
    });

    it('collapses a multi-selection back to a single id', () => {
      useEditorStore.setState({ selectedEntityId: 3, selectedEntityIds: [3, 4] });
      useEditorStore.getState().selectEntity(3); // same primary, but set must shrink
      expect(useEditorStore.getState().selectedEntityIds).toEqual([3]);
    });
  });

  describe('setSelectedEntities', () => {
    it('replaces the set and uses the last id as primary by default', () => {
      useEditorStore.getState().setSelectedEntities([1, 2, 3]);
      const s = useEditorStore.getState();
      expect(s.selectedEntityIds).toEqual([1, 2, 3]);
      expect(s.selectedEntityId).toBe(3);
      expect(s.selectedAsset).toBeNull();
    });

    it('honors an explicit primary that is in the set', () => {
      useEditorStore.getState().setSelectedEntities([1, 2, 3], 2);
      expect(useEditorStore.getState().selectedEntityId).toBe(2);
    });

    it('dedups repeated ids', () => {
      useEditorStore.getState().setSelectedEntities([1, 1, 2]);
      expect(useEditorStore.getState().selectedEntityIds).toEqual([1, 2]);
    });

    it('pushes one undo entry restoring the prior selection', () => {
      useEditorStore.getState().selectEntity(9);
      pushedSelections.length = 0;
      useEditorStore.getState().setSelectedEntities([1, 2]);
      expect(pushedSelections).toHaveLength(1);
      pushedSelections[0].undo();
      expect(useEditorStore.getState().selectedEntityIds).toEqual([9]);
    });

    it('does not push when the set and primary are unchanged (order-independent)', () => {
      useEditorStore.setState({ selectedEntityId: 2, selectedEntityIds: [1, 2] });
      useEditorStore.getState().setSelectedEntities([2, 1], 2);
      expect(pushedSelections).toHaveLength(0);
    });
  });

  describe('toggleEntitySelection', () => {
    it('adds an entity and makes it primary', () => {
      useEditorStore.getState().selectEntity(1);
      useEditorStore.getState().toggleEntitySelection(2);
      const s = useEditorStore.getState();
      expect(s.selectedEntityIds).toEqual([1, 2]);
      expect(s.selectedEntityId).toBe(2);
    });

    it('removes an entity already in the set', () => {
      useEditorStore.setState({ selectedEntityId: 2, selectedEntityIds: [1, 2] });
      useEditorStore.getState().toggleEntitySelection(2);
      const s = useEditorStore.getState();
      expect(s.selectedEntityIds).toEqual([1]);
      // primary fell back to the remaining member
      expect(s.selectedEntityId).toBe(1);
    });

    it('toggling off a non-primary leaves the primary intact', () => {
      useEditorStore.setState({ selectedEntityId: 2, selectedEntityIds: [1, 2] });
      useEditorStore.getState().toggleEntitySelection(1);
      const s = useEditorStore.getState();
      expect(s.selectedEntityIds).toEqual([2]);
      expect(s.selectedEntityId).toBe(2);
    });

    it('toggling off the last entity clears the primary', () => {
      useEditorStore.setState({ selectedEntityId: 5, selectedEntityIds: [5] });
      useEditorStore.getState().toggleEntitySelection(5);
      const s = useEditorStore.getState();
      expect(s.selectedEntityIds).toEqual([]);
      expect(s.selectedEntityId).toBeNull();
    });
  });

  describe('selectAsset', () => {
    const asset = { path: '/textures/grass.png', type: 'texture', name: 'grass' };

    it('sets selectedAsset and clears selectedEntityId', () => {
      useEditorStore.setState({ selectedEntityId: 10 });
      const { selectAsset } = useEditorStore.getState();
      selectAsset(asset);

      const state = useEditorStore.getState();
      expect(state.selectedAsset).toEqual(asset);
      expect(state.selectedEntityId).toBeNull();
    });

    it('pushes a selection change for undo', () => {
      const { selectAsset } = useEditorStore.getState();
      selectAsset(asset);

      expect(pushedSelections).toHaveLength(1);
      expect(pushedSelections[0].label).toContain('grass');
    });

    it('does not push when same asset path is selected', () => {
      useEditorStore.setState({ selectedAsset: asset });
      const { selectAsset } = useEditorStore.getState();
      selectAsset({ ...asset });

      expect(pushedSelections).toHaveLength(0);
    });

    it('does not push during undo/redo execution', () => {
      executingUndoRedo = true;
      const { selectAsset } = useEditorStore.getState();
      selectAsset(asset);

      expect(useEditorStore.getState().selectedAsset).toEqual(asset);
      expect(pushedSelections).toHaveLength(0);
    });

    it('undo restores previous entity selection', () => {
      useEditorStore.setState({ selectedEntityId: 42, selectedAsset: null });
      const { selectAsset } = useEditorStore.getState();
      selectAsset(asset);

      pushedSelections[0].undo();
      expect(useEditorStore.getState().selectedEntityId).toBe(42);
      expect(useEditorStore.getState().selectedAsset).toBeNull();
    });

    it('redo re-applies asset selection', () => {
      const { selectAsset } = useEditorStore.getState();
      selectAsset(asset);

      pushedSelections[0].undo();
      pushedSelections[0].redo();
      expect(useEditorStore.getState().selectedAsset).toEqual(asset);
    });

    it('deselect asset pushes "Deselect" label', () => {
      useEditorStore.setState({ selectedAsset: asset });
      const { selectAsset } = useEditorStore.getState();
      selectAsset(null);

      expect(pushedSelections).toHaveLength(1);
      expect(pushedSelections[0].label).toBe('Deselect');
    });
  });

  describe('selectAsset multi-asset mirror', () => {
    const asset = { path: '/textures/grass.png', type: 'texture', name: 'grass' };

    it('selectAsset sets selectedAssets to the single asset', () => {
      useEditorStore.getState().selectAsset(asset);
      expect(useEditorStore.getState().selectedAssets).toEqual([asset]);
    });

    it('selectAsset(null) clears the set', () => {
      useEditorStore.setState({ selectedAsset: asset, selectedAssets: [asset] });
      useEditorStore.getState().selectAsset(null);
      expect(useEditorStore.getState().selectedAssets).toEqual([]);
    });

    it('collapses a multi-asset selection back to a single asset', () => {
      const b = { path: '/textures/rock.png', type: 'texture', name: 'rock' };
      useEditorStore.setState({ selectedAsset: asset, selectedAssets: [asset, b] });
      useEditorStore.getState().selectAsset(asset); // same lead, but set must shrink
      expect(useEditorStore.getState().selectedAssets).toEqual([asset]);
    });

    it('selectEntity clears selectedAssets', () => {
      useEditorStore.setState({ selectedAsset: asset, selectedAssets: [asset] });
      useEditorStore.getState().selectEntity(5);
      expect(useEditorStore.getState().selectedAssets).toEqual([]);
    });
  });

  describe('setSelectedAssets', () => {
    const a = { path: '/t/a.png', type: 'texture', name: 'a' };
    const b = { path: '/t/b.png', type: 'texture', name: 'b' };
    const c = { path: '/t/c.png', type: 'texture', name: 'c' };

    it('replaces the set, uses the last as lead, and clears entities', () => {
      useEditorStore.setState({ selectedEntityId: 9, selectedEntityIds: [9] });
      useEditorStore.getState().setSelectedAssets([a, b, c]);
      const s = useEditorStore.getState();
      expect(s.selectedAssets).toEqual([a, b, c]);
      expect(s.selectedAsset).toEqual(c);
      expect(s.selectedEntityId).toBeNull();
      expect(s.selectedEntityIds).toEqual([]);
    });

    it('honors an explicit primary that is in the set', () => {
      useEditorStore.getState().setSelectedAssets([a, b, c], b);
      expect(useEditorStore.getState().selectedAsset).toEqual(b);
    });

    it('dedups repeated paths', () => {
      useEditorStore.getState().setSelectedAssets([a, { ...a }, b]);
      expect(useEditorStore.getState().selectedAssets.map((x) => x.path)).toEqual(['/t/a.png', '/t/b.png']);
    });

    it('pushes one undo entry restoring the prior selection', () => {
      useEditorStore.getState().selectAsset(a);
      pushedSelections.length = 0;
      useEditorStore.getState().setSelectedAssets([b, c]);
      expect(pushedSelections).toHaveLength(1);
      pushedSelections[0].undo();
      expect(useEditorStore.getState().selectedAssets).toEqual([a]);
    });

    it('does not push when the set and lead are unchanged (order-independent)', () => {
      useEditorStore.setState({ selectedAsset: b, selectedAssets: [a, b] });
      useEditorStore.getState().setSelectedAssets([b, a], b);
      expect(pushedSelections).toHaveLength(0);
    });
  });

  describe('gizmo mode and space', () => {
    it('setGizmoMode changes mode', () => {
      const { setGizmoMode } = useEditorStore.getState();
      setGizmoMode('rotate');
      expect(useEditorStore.getState().gizmoMode).toBe('rotate');

      setGizmoMode('scale');
      expect(useEditorStore.getState().gizmoMode).toBe('scale');
    });

    it('setGizmoSpace changes space', () => {
      const { setGizmoSpace } = useEditorStore.getState();
      setGizmoSpace('local');
      expect(useEditorStore.getState().gizmoSpace).toBe('local');

      setGizmoSpace('world');
      expect(useEditorStore.getState().gizmoSpace).toBe('world');
    });

    // REGRESSION: the 2D SceneView overlay is version-gated — it only repaints when the
    // 2D dirty version bumps. gizmoMode/gizmoSpace are editor-only state (not ECS writes),
    // so nothing else marks the overlay dirty on a mode toggle. Without the mark2DDirty()
    // in these setters the gizmo visual stayed stale (translate arrows still showing after
    // switching to rotate/scale) until an unrelated redraw. Pin that the setters bump it.
    it('setGizmoMode bumps the 2D dirty version so the overlay repaints', () => {
      const before = get2DDirtyVersion();
      useEditorStore.getState().setGizmoMode('rotate');
      expect(get2DDirtyVersion()).toBeGreaterThan(before);
    });

    it('setGizmoSpace bumps the 2D dirty version so the overlay repaints', () => {
      const before = get2DDirtyVersion();
      useEditorStore.getState().setGizmoSpace('local');
      expect(get2DDirtyVersion()).toBeGreaterThan(before);
    });
  });

  describe('gameViewSize and gameRect', () => {
    it('setGameViewSize updates dimensions', () => {
      const { setGameViewSize } = useEditorStore.getState();
      setGameViewSize(1920, 1080);

      const { gameViewSize } = useEditorStore.getState();
      expect(gameViewSize).toEqual({ width: 1920, height: 1080 });
    });

    it('setGameRect updates the game rect', () => {
      const { setGameRect } = useEditorStore.getState();
      const rect = { left: 10, top: 20, width: 640, height: 480 };
      setGameRect(rect);

      expect(useEditorStore.getState().gameRect).toEqual(rect);
    });
  });

  describe('refreshAssets', () => {
    it('increments assetsVersion', () => {
      const v0 = useEditorStore.getState().assetsVersion;
      useEditorStore.getState().refreshAssets();
      expect(useEditorStore.getState().assetsVersion).toBe(v0 + 1);

      useEditorStore.getState().refreshAssets();
      expect(useEditorStore.getState().assetsVersion).toBe(v0 + 2);
    });
  });

  describe('importStatus', () => {
    it('setImportStatus activates with message', () => {
      const { setImportStatus } = useEditorStore.getState();
      setImportStatus(true, 'Loading model...');

      const { importStatus } = useEditorStore.getState();
      expect(importStatus.active).toBe(true);
      expect(importStatus.message).toBe('Loading model...');
    });

    it('setImportStatus deactivates with default empty message', () => {
      const { setImportStatus } = useEditorStore.getState();
      setImportStatus(true, 'Working...');
      setImportStatus(false);

      const { importStatus } = useEditorStore.getState();
      expect(importStatus.active).toBe(false);
      expect(importStatus.message).toBe('');
    });
  });

  describe('buildStatus', () => {
    it('setBuildStatus merges partial updates', () => {
      const { setBuildStatus } = useEditorStore.getState();
      setBuildStatus({ active: true, message: 'Step 1', step: 1 });

      let { buildStatus } = useEditorStore.getState();
      expect(buildStatus.active).toBe(true);
      expect(buildStatus.message).toBe('Step 1');
      expect(buildStatus.step).toBe(1);
      expect(buildStatus.totalSteps).toBe(5); // default preserved

      setBuildStatus({ step: 2, message: 'Step 2' });
      buildStatus = useEditorStore.getState().buildStatus;
      expect(buildStatus.step).toBe(2);
      expect(buildStatus.active).toBe(true); // still active
    });

    it('setBuildStatus can mark failure', () => {
      const { setBuildStatus } = useEditorStore.getState();
      setBuildStatus({ active: true, failed: true, message: 'Build failed' });

      const { buildStatus } = useEditorStore.getState();
      expect(buildStatus.failed).toBe(true);
      expect(buildStatus.message).toBe('Build failed');
    });
  });

  describe('SpriteAnim editor slice', () => {
    const asset = { path: '/assets/anims/hero.spriteanim.json', type: 'spriteanim', name: 'hero' };

    it('openSpriteAnimEditor sets the asset, clears the def, and bumps the nonce', () => {
      const n0 = useEditorStore.getState().spriteAnimEditNonce;
      useEditorStore.getState().openSpriteAnimEditor(asset);
      const s = useEditorStore.getState();
      expect(s.editingSpriteAnimAsset).toEqual(asset);
      expect(s.editingSpriteAnimDef).toBeNull();          // forces the panel to re-fetch
      expect(s.spriteAnimEditNonce).toBe(n0 + 1);
    });

    it('reopening the SAME asset still bumps the nonce (so the tab re-focuses)', () => {
      useEditorStore.getState().openSpriteAnimEditor(asset);
      const n1 = useEditorStore.getState().spriteAnimEditNonce;
      useEditorStore.getState().openSpriteAnimEditor(asset);
      expect(useEditorStore.getState().spriteAnimEditNonce).toBe(n1 + 1);
    });

    it('applySpriteAnimDef updates the live def only when the path is the open one', () => {
      useEditorStore.getState().openSpriteAnimEditor(asset);
      const def = { id: 'g', clips: { idle: { frames: ['a'], fps: 12, mode: 'loop' as const, cycles: 0 } } };
      useEditorStore.getState().applySpriteAnimDef(asset.path, def);
      expect(useEditorStore.getState().editingSpriteAnimDef).toEqual(def);

      // An edit to a DIFFERENT (since-closed) asset seeds the cache but must not force
      // this panel's def to change.
      const other = { id: 'h', clips: {} };
      useEditorStore.getState().applySpriteAnimDef('/assets/anims/other.spriteanim.json', other);
      expect(useEditorStore.getState().editingSpriteAnimDef).toEqual(def); // unchanged
    });

    it('applySpriteAnimDef re-seeds the runtime spriteAnimCache (live SpriteAnimators reflect the edit)', async () => {
      const { getSpriteAnim, clearSpriteAnimCache } = await import('../../src/runtime/loaders/spriteAnimCache');
      clearSpriteAnimCache();
      const def = { id: 'g', clips: { walk: { frames: ['w0', 'w1'], fps: 10, mode: 'loop' as const, cycles: 0 } } };
      // Seeds even for a path that isn't the open asset (so a live edit propagates
      // regardless of what the panel currently shows).
      useEditorStore.getState().applySpriteAnimDef(asset.path, def);
      expect(getSpriteAnim(asset.path)?.clips.walk.frames).toEqual(['w0', 'w1']);
      clearSpriteAnimCache();
    });

    it('closeSpriteAnimEditor clears the asset + def', () => {
      useEditorStore.getState().openSpriteAnimEditor(asset);
      useEditorStore.getState().closeSpriteAnimEditor();
      const s = useEditorStore.getState();
      expect(s.editingSpriteAnimAsset).toBeNull();
      expect(s.editingSpriteAnimDef).toBeNull();
    });
  });
});

describe('editorStore.showToast (F5 — timer + id hygiene)', () => {
  beforeEach(() => { useEditorStore.setState({ toast: null }); });

  it('uses a monotonic id that keeps increasing even after the toast clears', () => {
    vi.useFakeTimers();
    const { showToast } = useEditorStore.getState();

    showToast('first');
    const id1 = useEditorStore.getState().toast!.id;
    vi.advanceTimersByTime(3500);                       // first toast auto-dismisses
    expect(useEditorStore.getState().toast).toBeNull();

    showToast('second');                                // toast was null when this ran
    const id2 = useEditorStore.getState().toast!.id;
    expect(id2).toBeGreaterThan(id1);                   // NOT reset to 1 → no id collision

    vi.useRealTimers();
  });

  it('clears the prior toast timer so a newer toast is not dismissed early', () => {
    vi.useFakeTimers();
    const { showToast } = useEditorStore.getState();

    showToast('first');
    vi.advanceTimersByTime(2000);                       // partway through first toast's window
    showToast('second');                                // replaces it + clears the old timer
    vi.advanceTimersByTime(2000);                       // 4s since first, but only 2s since second
    // The first toast's 3.5s timer must NOT fire and null out the second toast.
    expect(useEditorStore.getState().toast?.message).toBe('second');

    vi.advanceTimersByTime(1500);                       // now 3.5s since the second toast
    expect(useEditorStore.getState().toast).toBeNull();

    vi.useRealTimers();
  });
});
