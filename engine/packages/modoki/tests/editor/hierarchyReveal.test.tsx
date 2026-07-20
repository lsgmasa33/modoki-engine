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

vi.mock('../../src/runtime/ecs/world', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/runtime/ecs/world')>()),
  onWorldSwap: (fn: () => void) => { hooks.worldSwap.push(fn); return () => {}; },
}));
vi.mock('../../src/runtime/ecs/traitRegistry', () => ({
  getAllTraits: () => [], getTraitByName: () => undefined, COMPONENT_CATEGORY_ORDER: [],
}));

vi.mock('../../src/runtime/ecs/entityUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/ecs/entityUtils')>();
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

let scrollSpy: ReturnType<typeof vi.fn>;
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

  it('a world swap with NO selection leaves the tree collapsed', () => {
    // Guard the epoch bump against over-expanding: it must only reveal a real selection.
    const { container } = render(<Hierarchy />);
    selectExternally(null);
    act(() => { hooks.version.v++; hooks.worldSwap.forEach((fn) => fn()); });
    expect(rowFor(container, 3)).toBeNull();
    expect(rowFor(container, 1)).toBeTruthy();
  });
});
