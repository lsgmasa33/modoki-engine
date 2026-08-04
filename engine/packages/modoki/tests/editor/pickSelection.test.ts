/** The shared 2D + 3D viewport pick rule (#105 Phase 2).
 *
 *  Extracted from `SceneView.tsx`, where it was store-coupled and reachable only
 *  by picking in a live viewport. It deliberately mirrors the Hierarchy panel, so
 *  a drift here means clicking in the tree and picking in the viewport disagree. */

import { describe, it, expect } from 'vitest';
import { resolvePickSelection } from '../../src/editor/scene/pickSelection';

const PLAIN = { additive: false, toggle: false };
const SHIFT = { additive: true, toggle: false };
const CTRL = { additive: false, toggle: true };

describe('picking an entity', () => {
  it('plain click selects just it', () => {
    expect(resolvePickSelection(7, PLAIN, [1, 2])).toEqual({ kind: 'select', id: 7 });
  });

  it('Ctrl/Cmd toggles it in or out', () => {
    expect(resolvePickSelection(7, CTRL, [1, 2])).toEqual({ kind: 'toggle', id: 7 });
    // Toggling is symmetric — the store decides in vs out; the pick rule does not.
    expect(resolvePickSelection(7, CTRL, [7])).toEqual({ kind: 'toggle', id: 7 });
  });

  it('Shift adds it and makes it primary', () => {
    expect(resolvePickSelection(7, SHIFT, [1, 2])).toEqual({ kind: 'set', ids: [1, 2, 7], primary: 7 });
  });

  it('Shift on an ALREADY-selected entity is idempotent, and re-primaries it', () => {
    // The store dedupes (editorStore.setSelectedEntities -> Array.from(new Set)),
    // so the duplicate here is harmless; what matters is that 2 becomes primary.
    expect(resolvePickSelection(2, SHIFT, [1, 2])).toEqual({ kind: 'set', ids: [1, 2, 2], primary: 2 });
  });

  it('does not mutate the incoming selection', () => {
    const current = [1, 2];
    resolvePickSelection(7, SHIFT, current);
    expect(current).toEqual([1, 2]);
  });

  it('toggle wins over additive when both modifiers are held', () => {
    expect(resolvePickSelection(7, { additive: true, toggle: true }, [1])).toEqual({ kind: 'toggle', id: 7 });
  });
});

describe('picking empty space', () => {
  it('a PLAIN click clears the selection', () => {
    expect(resolvePickSelection(null, PLAIN, [1, 2])).toEqual({ kind: 'clear' });
  });

  // The rule this module exists for: a modified click that misses must NOT clear.
  // Otherwise a mis-aimed Shift-click — or the press that BEGINS a marquee drag,
  // which lands on empty space by definition — destroys the multi-selection the
  // user is building.
  it('a Shift click on nothing preserves the selection', () => {
    expect(resolvePickSelection(null, SHIFT, [1, 2])).toEqual({ kind: 'keep' });
  });

  it('a Ctrl/Cmd click on nothing preserves the selection', () => {
    expect(resolvePickSelection(null, CTRL, [1, 2])).toEqual({ kind: 'keep' });
  });

  it('clears even when the selection is already empty', () => {
    // Still a clear, not a keep — the store no-ops, and making this conditional
    // would be a special case with no behavioural difference.
    expect(resolvePickSelection(null, PLAIN, [])).toEqual({ kind: 'clear' });
  });
});

describe('entity 0 is a real entity, not a falsy miss', () => {
  // A null check written as `if (!entityId)` would treat id 0 as empty space and
  // silently clear the selection instead of selecting it.
  it('selects it rather than clearing', () => {
    expect(resolvePickSelection(0, PLAIN, [1])).toEqual({ kind: 'select', id: 0 });
  });

  it('toggles and adds it like any other id', () => {
    expect(resolvePickSelection(0, CTRL, [1])).toEqual({ kind: 'toggle', id: 0 });
    expect(resolvePickSelection(0, SHIFT, [1])).toEqual({ kind: 'set', ids: [1, 0], primary: 0 });
  });
});
