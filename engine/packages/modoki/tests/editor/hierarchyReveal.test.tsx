// @vitest-environment jsdom
/** Hierarchy "reveal the selected entity" — the BEHAVIOR, not just the pure targets.
 *
 *  revealTargetsFor is unit-tested next door; what broke in practice was the WIRING:
 *
 *  1. Expanding ancestors without scrolling leaves the highlighted row below the fold,
 *     which is indistinguishable from "the click didn't select anything".
 *  2. Auto-collapse-all runs on the structure refresh, which fires AFTER a scene load has
 *     restored the selection by GUID — so it re-buried the row the reveal had just opened.
 *     Caught live: selecting right after a relaunch did nothing; a second attempt worked.
 *     The fix is a collapseEpoch the reveal effect depends on. Nothing pinned that ordering.
 *
 *  So this drives the real component and asserts on rendered rows + scrollIntoView. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

// Entities: a deep chain under a root that auto-collapse will close.
// (>5 entities, or the panel's initial collapse-all never runs.)
const ENTITIES = [
  { id: 1, name: 'Island', traits: [], parentId: 0, sortOrder: 0 },
  { id: 2, name: 'Boat', traits: [], parentId: 1, sortOrder: 0 },
  { id: 3, name: 'Oar', traits: [], parentId: 2, sortOrder: 0 },
  { id: 4, name: 'Cube', traits: [], parentId: 0, sortOrder: 1 },
  { id: 5, name: 'Light', traits: [], parentId: 0, sortOrder: 2 },
  { id: 6, name: 'Camera', traits: [], parentId: 0, sortOrder: 3 },
  { id: 7, name: 'Env', traits: [], parentId: 0, sortOrder: 4 },
];

/** Captured subscribers so a test can fire a structure refresh / world swap by hand. */
const hooks = vi.hoisted(() => ({
  structure: [] as Array<() => void>,
  worldSwap: [] as Array<() => void>,
  version: { v: 0 },
}));

vi.mock('../../src/runtime/core/ecs/world', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/runtime/core/ecs/world')>()),
  onWorldSwap: (fn: () => void) => { hooks.worldSwap.push(fn); return () => {}; },
}));
vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
  getAllTraits: () => [], getTraitByName: () => undefined, COMPONENT_CATEGORY_ORDER: [],
}));

vi.mock('../../src/runtime/core/ecs/entityUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/core/ecs/entityUtils')>();
  return {
    ...actual, // buildEntityTree / subtreeIds stay real
    getAllEntities: () => ENTITIES,
    getStructureVersion: () => hooks.version.v,
    onStructureDirty: (fn: () => void) => { hooks.structure.push(fn); return () => {}; },
    deleteEntity: vi.fn(), writeTraitField: vi.fn(), readTraitData: vi.fn(),
    addDirtyListener: () => () => {}, fireDirtyListeners: vi.fn(), findEntity: vi.fn(),
  };
});

const rowFor = (c: HTMLElement, id: number) => c.querySelector(`[data-entity-row="${id}"]`);

let scrollSpy: ReturnType<typeof vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>>;
let Hierarchy: typeof import('../../src/editor/panels/Hierarchy').default;
let useEditorStore: typeof import('../../src/editor/store/editorStore').useEditorStore;

/** Folder-collapse state is localStorage-backed; jsdom here doesn't supply it. */
function stubLocalStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
    },
  });
}

beforeEach(async () => {
  hooks.structure.length = 0; hooks.worldSwap.length = 0; hooks.version.v = 0;
  stubLocalStorage();
  scrollSpy = vi.fn();
  Element.prototype.scrollIntoView = scrollSpy; // not implemented in jsdom
  Hierarchy = (await import('../../src/editor/panels/Hierarchy')).default;
  useEditorStore = (await import('../../src/editor/store/editorStore')).useEditorStore;
});
afterEach(() => { cleanup(); vi.resetModules(); });

/** Select from OUTSIDE the panel — a viewport click, undo, an agent's set-selection. */
function selectExternally(id: number | null) {
  act(() => { useEditorStore.getState().selectEntity(id); });
}

describe('Hierarchy reveals the selected entity', () => {
  it('auto-collapse hides a deep row until something selects it', () => {
    const { container } = render(<Hierarchy />);
    expect(rowFor(container, 1), 'root is always rendered').toBeTruthy();
    expect(rowFor(container, 3), 'deep child starts collapsed away').toBeNull();
  });

  it('selecting a buried entity expands its ancestors AND scrolls the row into view', () => {
    const { container } = render(<Hierarchy />);
    selectExternally(3);
    expect(rowFor(container, 2), 'intermediate ancestor expanded').toBeTruthy();
    expect(rowFor(container, 3), 'selected row now exists').toBeTruthy();
    // The half that was missing: expanding without scrolling leaves it below the fold.
    expect(scrollSpy).toHaveBeenCalled();
  });

  it('scrolls with block:"nearest" so clicking a visible row never yanks the list', () => {
    const { container } = render(<Hierarchy />);
    selectExternally(3);
    expect(rowFor(container, 3)).toBeTruthy();
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('REGRESSION: a world swap re-collapses everything, and the reveal must re-run', () => {
    // The live-caught ordering bug. Selection is restored by GUID on scene load, THEN the
    // new world's structure refresh fires auto-collapse-all — which would re-bury the row.
    // collapseEpoch makes the reveal effect run again after that collapse.
    const { container } = render(<Hierarchy />);
    selectExternally(3);
    expect(rowFor(container, 3)).toBeTruthy();

    act(() => {
      hooks.version.v++;                       // structure changed
      hooks.worldSwap.forEach((fn) => fn());   // scene load → re-arms + runs auto-collapse-all
    });

    expect(rowFor(container, 3), 'selection survived the re-collapse').toBeTruthy();
    expect(rowFor(container, 2)).toBeTruthy();
  });

  // #1156 — the agent op writes the store directly (agentEditorOps `setSelectionRaw`), so a
  // repeat request for the already-selected entity keeps `selectedEntityId` the same number;
  // it then calls `requestEntityReveal`. `reselectRaw` drives exactly that pair, and
  // `restoreRaw` the same write WITHOUT the request, which is what undo/redo publishes.
  const toggleOf = (c: HTMLElement, id: number) =>
    rowFor(c, id)!.querySelector('span[title^="Click to expand"]') as HTMLElement;
  const restoreRaw = (lead: number, ids: number[]) =>
    act(() => { useEditorStore.setState({ selectedEntityId: lead, selectedEntityIds: ids, selectedAsset: null }); });
  const reselectRaw = (id: number) => {
    restoreRaw(id, [id]);
    act(() => { useEditorStore.getState().requestEntityReveal(); });
  };

  it('#1156: re-selecting the ALREADY-selected entity re-reveals it after its ancestor was collapsed', () => {
    const { container } = render(<Hierarchy />);
    selectExternally(3);
    expect(rowFor(container, 3)).toBeTruthy();

    act(() => { toggleOf(container, 1).click(); });   // a human collapses the root ancestor
    expect(rowFor(container, 3), 'precondition: the collapse hid the selected row').toBeNull();

    reselectRaw(3);                                     // same id, fresh array
    expect(rowFor(container, 2), 'intermediate ancestor re-expanded').toBeTruthy();
    expect(rowFor(container, 3), 'the same-id re-select revealed the row').toBeTruthy();
  });

  it('#1156: a same-id re-select SCROLLS to a row that is rendered but scrolled away (nothing to un-collapse)', () => {
    // No collapse state changes here, so only the reveal tick can re-run the scroll.
    const { container } = render(<Hierarchy />);
    selectExternally(3);
    expect(rowFor(container, 3)).toBeTruthy();
    scrollSpy.mockClear();
    reselectRaw(3);
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('#1156 accept side: a Cmd/Ctrl-click that TRIMS the set and keeps the lead does not re-open a manual collapse or scroll', () => {
    // Found by the #1156 close-out review: keying on array identity alone re-revealed here,
    // because toggleEntitySelection publishes a fresh array even when the lead stays put.
    const { container } = render(<Hierarchy />);
    act(() => { useEditorStore.getState().setSelectedEntities([4, 3], 3); });
    expect(rowFor(container, 3)).toBeTruthy();
    act(() => { toggleOf(container, 1).click(); });   // hand-collapse the lead's ancestor
    expect(rowFor(container, 3), 'precondition: the collapse hid the lead row').toBeNull();
    scrollSpy.mockClear();

    act(() => { useEditorStore.getState().toggleEntitySelection(4); });   // trim Cube, lead stays 3
    expect(useEditorStore.getState().selectedEntityId, 'precondition: the lead did not change').toBe(3);
    expect(rowFor(container, 3), 'the manual collapse was not undone').toBeNull();
    expect(scrollSpy, 'the list was not yanked back to the lead').not.toHaveBeenCalled();
  });

  it('#1156 accept side: UNDOING a trim republishes the superset but does not re-open a manual collapse', () => {
    // Found by the second close-out review: a rule inferred from the array (a superset is a
    // request) re-opened the collapse here, because undo restores [4,3] with the lead unchanged.
    const { container } = render(<Hierarchy />);
    act(() => { useEditorStore.getState().setSelectedEntities([4, 3], 3); });
    act(() => { toggleOf(container, 1).click(); });
    act(() => { useEditorStore.getState().toggleEntitySelection(4); });
    scrollSpy.mockClear();
    restoreRaw(3, [4, 3]);                              // what undo's resolveSnap publishes
    expect(rowFor(container, 3), 'the manual collapse was not undone').toBeNull();
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('#1156: a plain viewport pick on the LEAD of a multi-selection reveals it (collapse to the lead + request)', () => {
    // Same state change as a trim ([4,3] -> [3], lead 3), which is why only the writer's request
    // can tell them apart. applyPickSelection's 'select' path makes exactly these two calls.
    const { container } = render(<Hierarchy />);
    act(() => { useEditorStore.getState().setSelectedEntities([4, 3], 3); });
    act(() => { toggleOf(container, 1).click(); });
    expect(rowFor(container, 3)).toBeNull();
    act(() => { useEditorStore.getState().selectEntity(3); useEditorStore.getState().requestEntityReveal(); });
    expect(rowFor(container, 3), 'the picked lead row was revealed').toBeTruthy();
  });

  it('#1156 accept side: a trim does not scroll to a lead row that IS rendered (scrolled away, not collapsed)', () => {
    const { container } = render(<Hierarchy />);
    act(() => { useEditorStore.getState().setSelectedEntities([4, 3], 3); });
    expect(rowFor(container, 3), 'precondition: the lead row is mounted, so a scroll could fire').toBeTruthy();
    scrollSpy.mockClear();
    act(() => { useEditorStore.getState().toggleEntitySelection(4); });
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('a world swap with NO selection leaves the tree collapsed', () => {
    // Guard the epoch bump against over-expanding: it must only reveal a real selection.
    const { container } = render(<Hierarchy />);
    selectExternally(null);
    act(() => { hooks.version.v++; hooks.worldSwap.forEach((fn) => fn()); });
    expect(rowFor(container, 3)).toBeNull();
    expect(rowFor(container, 1)).toBeTruthy();
  });
});
