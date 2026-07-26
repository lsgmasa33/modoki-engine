// @vitest-environment jsdom
/** Hierarchy ghost-entity gating (base-scene persistence, Phase 9/`1be04b44`) — the
 *  RENDERED behavior, not just the pure grouping logic hierarchyFolders.test.ts covers.
 *
 *  A base-origin entity (EntityAttributes.sourceScene non-empty) is "ghosted" in the
 *  Hierarchy: dimmed + italicized, to signal it's shared by every level using that
 *  base — but still selectable/inspectable, never invisible or inert. This is the one
 *  piece of that Phase's UI wiring that had no automated coverage (only manually
 *  live-verified via screenshot comparison at the time) — a later render refactor
 *  could silently drop the visual cue (or, worse, the selectability) without any test
 *  catching it. Uses the same render harness as hierarchyReveal.test.tsx. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

const ENTITIES = [
  { id: 1, name: 'PrimaryThing', traits: [], parentId: 0, sortOrder: 0, sourceScene: '' },
  { id: 2, name: 'BaseCamera', traits: [], parentId: 0, sortOrder: 1, sourceScene: 'base-guid-1' },
];

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

/** The row's name label — NOT the first <span> (that's the expand/collapse toggle
 *  placeholder, always rendered even for a leaf row); find it by its text content. */
function nameSpanFor(row: Element, name: string): HTMLElement {
  const span = Array.from(row.querySelectorAll('span')).find((s) => s.textContent === name);
  expect(span, `name span for "${name}"`).toBeTruthy();
  return span as HTMLElement;
}

/** A base-scene group is a collapsible header, collapsed by default (Phase 9) —
 *  expand it before asserting on rows inside it. Falls back to the raw sourceScene
 *  guid as the label when no sceneManager entry supplies a nicer display name
 *  (this harness doesn't mock sceneManager.getLoadedScenes()). */
function expandSceneGroup(c: HTMLElement, sourceScene: string) {
  const header = c.querySelector(`[data-ui-id="hierarchy.sceneGroup.${sourceScene}"]`) as HTMLElement | null;
  expect(header, `scene group header for "${sourceScene}"`).toBeTruthy();
  act(() => { header!.click(); });
}

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
  Element.prototype.scrollIntoView = vi.fn(); // not implemented in jsdom
  Hierarchy = (await import('../../src/editor/panels/Hierarchy')).default;
  useEditorStore = (await import('../../src/editor/store/editorStore')).useEditorStore;
});
afterEach(() => { cleanup(); vi.resetModules(); });

describe('Hierarchy — base-scene ghost rows', () => {
  it('a base-origin entity renders dimmed + italic; a primary entity does not', () => {
    const { container } = render(<Hierarchy />);
    expandSceneGroup(container, 'base-guid-1');

    const baseRow = rowFor(container, 2)!;
    const nameSpan = nameSpanFor(baseRow, 'BaseCamera');
    expect(nameSpan.style.fontStyle).toBe('italic');
    expect(nameSpan.style.color).toBe('rgb(102, 102, 102)'); // #666

    const primaryRow = rowFor(container, 1)!;
    const primaryNameSpan = nameSpanFor(primaryRow, 'PrimaryThing');
    expect(primaryNameSpan.style.fontStyle).toBe('normal');
    expect(primaryNameSpan.style.color).not.toBe('rgb(102, 102, 102)');
  });

  it('a ghosted row is still selectable — clicking it drives selection like any other row', () => {
    const { container } = render(<Hierarchy />);
    expandSceneGroup(container, 'base-guid-1');
    const baseRow = rowFor(container, 2)!;

    act(() => { (baseRow as HTMLElement).click(); });

    expect(useEditorStore.getState().selectedEntityId).toBe(2);
  });
});
