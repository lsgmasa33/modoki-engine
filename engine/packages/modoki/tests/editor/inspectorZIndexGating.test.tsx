// @vitest-environment jsdom
/** Inspector — UIElement.zIndex gating under a shadowing UIAnchor.zIndex (issue #746).
 *
 *  WHY THIS EXISTS AT ALL: `isElementZIndexShadowed`/`selectionZIndexGate` (uiAuthoring.ts)
 *  and the tooltip builders (Inspector.tsx) are pure and already covered in
 *  uiAuthoring.test.ts — but a pure-helper test cannot answer whether the DECISION reaches
 *  the rendered control, which is exactly the gap #746 is about: two zIndex fields shown as
 *  if independent, with nothing telling the author which one wins. So this mounts the real
 *  Inspector and asserts the WIRING — readOnly, the dimming, and the tooltip supersession —
 *  against a live sibling-trait read, following inspectorInertSizeGating.test.tsx's approach.
 *
 *  The cross-trait read is the fragile part: `zIndex` lives on UIElement but must know the
 *  sibling UIAnchor's OWN zIndex, which the per-trait field loop does not carry. Here that
 *  read is REAL (findEntity → entity.get(UIAnchor)); only the world/registry plumbing under
 *  it is mocked. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

/** The sibling UIAnchor's `zIndex` PER ENTITY ID, swapped per test before render. A `null`
 *  entry = that entity has no UIAnchor at all. Keyed by id (not a single value) because the
 *  multi-select gate (#34) is precisely about the entries DIFFERING. */
const anchorZState = vi.hoisted(() => ({ byId: new Map<number, number | null>() }));

const UI_ELEMENT_META = {
  name: 'UIElement',
  category: 'component' as const,
  fields: {
    // The tooltip mirrors the real registration (`UIElement.zIndex` in
    // engine/app/ecs/registerTraits.ts — searched by name, not cited by line: a line number here
    // goes stale on the next insertion above it and nothing guards it, since docCitations.test.ts
    // scans docs/** only) so
    // the supersession test below is about real content, not an invented string.
    zIndex: {
      type: 'number', step: 1,
      tooltip: 'Stacking order among siblings.\nIgnored on an anchored element whose UIAnchor.zIndex is non-zero — that field is the stacking authority for an anchored box.',
    },
    // A plain number field that the zIndex gate must never touch.
    rotation: { type: 'number', step: 1, tooltip: 'Tilt in degrees, clockwise. 0 = square.' },
  },
  trait: {} as never,
};
const UI_ANCHOR_META = { name: 'UIAnchor', category: 'component' as const, fields: {}, trait: { __anchor: true } as never };

// The merged read the Inspector renders from: an authored zIndex + an untouched sibling field.
const ELEMENT_DATA = { zIndex: 5, rotation: 30 };

/** The multi-entity write the Inspector commits through. Spied (not stubbed away) so a test
 *  can assert WHO an editable field's write reaches — the gate must not silently narrow it
 *  (the #34 rule). */
const writeSpy = vi.hoisted(() => vi.fn());

vi.mock('../../src/editor/undo/entityActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/editor/undo/entityActions')>()),
  writeTraitFieldMultiWithUndo: writeSpy,
}));

vi.mock('../../src/editor/panels/inspectorMerge', () => ({
  readMergedTraits: () => ({ result: [{ meta: UI_ELEMENT_META, data: { ...ELEMENT_DATA } }], nonShared: [] }),
  sameTraitResult: () => false,
}));

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => ({
  getAllTraits: () => [UI_ELEMENT_META, UI_ANCHOR_META],
  // PrefabInstance lookup must miss so the override/prefab effect stays inert.
  getTraitByName: (n: string) => (n === 'UIAnchor' ? UI_ANCHOR_META : undefined),
  COMPONENT_CATEGORY_ORDER: ['component', 'resource', 'tag'],
}));

vi.mock('../../src/runtime/core/ecs/entityUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/core/ecs/entityUtils')>();
  return {
    ...actual,
    findEntity: (id: number) => {
      const z = anchorZState.byId.get(id) ?? null;
      return z === null
        ? { has: () => false, get: () => undefined }
        : { has: () => true, get: () => ({ zIndex: z }) };
    },
    readTraitData: () => null,
    readTraitDataFull: () => ({ ...ELEMENT_DATA }),
    addDirtyListener: () => () => {},
    getStructureVersion: () => 0,
    onStructureDirty: () => () => {},
  };
});

const { useEditorStore } = await import('../../src/editor/store/editorStore');
const Inspector = (await import('../../src/editor/panels/Inspector')).default;
const {
  shadowedZIndexTooltip,
  shadowedZIndexTooltipMulti,
  partiallyShadowedZIndexTooltip,
} = await import('../../src/editor/panels/Inspector');

/** The zIndex row: found by its stable data-ui-id, walked up to the outer wrapper that
 *  carries the dimming opacity (renderField wraps `<NumberField>` one level up, see
 *  Inspector.tsx's `hint.type === 'number'` branch). Also exposes the FieldLabel span so a
 *  test can hover it and read the rendered Tooltip content. */
function zIndexRow(container: HTMLElement) {
  const input = container.querySelector('[data-ui-id="inspector.field.UIElement.zIndex"]') as HTMLInputElement;
  if (!input) throw new Error('zIndex input not found');
  const innerRow = input.closest('div')!; // NumberField's own flex-row div
  const outer = innerRow.parentElement as HTMLElement; // renderField's dim wrapper
  const label = innerRow.firstElementChild as HTMLElement; // FieldLabel (span or Tooltip wrapper)
  return {
    input,
    outer,
    label,
    dimmed: outer.style.opacity !== '' && Number(outer.style.opacity) < 1,
    opacity: outer.style.opacity,
  };
}

/** Hover the label and run out the Tooltip's delay, mirroring
 *  inspectorInertSizeGating.test.tsx's `hover` helper. */
function hover(el: HTMLElement) {
  fireEvent.mouseEnter(el);
  act(() => { vi.advanceTimersByTime(400); });
}

/** The unaffected sibling number field, by data-ui-id. */
function rotationRow(container: HTMLElement) {
  const input = container.querySelector('[data-ui-id="inspector.field.UIElement.rotation"]') as HTMLInputElement;
  if (!input) throw new Error('rotation input not found');
  const outer = input.closest('div')!.parentElement as HTMLElement;
  return {
    input,
    dimmed: outer.style.opacity !== '' && Number(outer.style.opacity) < 1,
  };
}

function mount(anchorZ: number | null) {
  return mountMulti([anchorZ]);
}

/** Mount with one selected entity per entry — `null` = that entity has no UIAnchor at all.
 *  Entity ids are 1..n; the FIRST entry is the primary. */
function mountMulti(zs: (number | null)[]) {
  anchorZState.byId = new Map(zs.map((z, i) => [i + 1, z]));
  const ids = zs.map((_, i) => i + 1);
  useEditorStore.setState({ selectedEntityId: ids[0], selectedEntityIds: ids, selectedAsset: null, selectedAssets: [] });
  return render(<Inspector />);
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); writeSpy.mockClear(); });
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe('Inspector — UIElement.zIndex is gated by a shadowing UIAnchor.zIndex (#746)', () => {
  it('a truthy anchor zIndex makes it readOnly, dimmed, and names the winning value', () => {
    const { container } = mount(1000);
    const z = zIndexRow(container);
    expect(z.input.readOnly).toBe(true);
    expect(z.dimmed).toBe(true);
    expect(z.opacity).toBe('0.35');
    hover(z.label);
    const text = document.body.textContent ?? '';
    expect(text).toContain(shadowedZIndexTooltip(1000));
    expect(text).not.toContain('Ignored on an anchored element');
  });

  // The regression that matters most: `if (a.zIndex)` means a 0 does NOT shadow.
  it('an anchor zIndex of 0 leaves the field fully live, with the registered tooltip', () => {
    const { container } = mount(0);
    const z = zIndexRow(container);
    expect(z.input.readOnly).toBe(false);
    expect(z.dimmed).toBe(false);
    hover(z.label);
    expect(document.body.textContent ?? '').toContain('Ignored on an anchored element');
  });

  it('no UIAnchor at all leaves the field fully live, with the registered tooltip', () => {
    const { container } = mount(null);
    const z = zIndexRow(container);
    expect(z.input.readOnly).toBe(false);
    expect(z.dimmed).toBe(false);
    hover(z.label);
    expect(document.body.textContent ?? '').toContain('Ignored on an anchored element');
  });

  it('a multi-select unanimously shadowed at the SAME value is readOnly + dimmed and names it', () => {
    const { container } = mountMulti([7, 7]);
    const z = zIndexRow(container);
    expect(z.input.readOnly).toBe(true);
    expect(z.dimmed).toBe(true);
    hover(z.label);
    expect(document.body.textContent ?? '').toContain(shadowedZIndexTooltip(7));
  });

  it('a multi-select shadowed at DIFFERENT values is still readOnly + dimmed but names NEITHER', () => {
    const { container } = mountMulti([7, 9]);
    const z = zIndexRow(container);
    expect(z.input.readOnly).toBe(true);
    expect(z.dimmed).toBe(true);
    hover(z.label);
    const text = document.body.textContent ?? '';
    expect(text).toContain(shadowedZIndexTooltipMulti());
    expect(text).not.toContain('7');
    expect(text).not.toContain('9');
  });

  it('a mixed selection (shadowed + live) stays EDITABLE, half-dimmed, with the count tooltip', () => {
    const { container } = mountMulti([7, 0]);
    const z = zIndexRow(container);
    expect(z.input.readOnly).toBe(false);
    expect(z.opacity).toBe('0.65');
    hover(z.label);
    expect(document.body.textContent ?? '').toContain(partiallyShadowedZIndexTooltip(1, 2));
  });

  it('a mixed-selection edit still commits through the write spy to BOTH entities (#34)', () => {
    // The gate decides whether the control is usable; it must never narrow WHO the write
    // reaches — a mixed gate that dropped the anchored sibling would leave it un-editable
    // forever via this field.
    const { container } = mountMulti([7, 0]);
    const input = zIndexRow(container).input;
    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.blur(input);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [ids, , field, value] = writeSpy.mock.calls[0];
    expect(ids).toEqual([1, 2]);
    expect(field).toBe('zIndex');
    expect(value).toBe(42);
  });

  it('never touches the sibling rotation field, in any of the above cases', () => {
    for (const zs of [[1000], [0], [null], [7, 7], [7, 9], [7, 0]] as (number | null)[][]) {
      const { container } = mountMulti(zs);
      const r = rotationRow(container);
      expect(r.input.readOnly).toBe(false);
      expect(r.dimmed).toBe(false);
      cleanup();
    }
  });
});

describe('Inspector — the zIndex tooltip builders (pure, cross-checked against rendered content)', () => {
  it('the multi tooltip names no value', () => {
    const text = shadowedZIndexTooltipMulti();
    expect(text).not.toContain('7');
    expect(text).not.toContain('9');
  });

  it('the partially-shadowed tooltip names the counts, not a value', () => {
    expect(partiallyShadowedZIndexTooltip(1, 2)).toBe(
      'zIndex is live on 1 of the 2 selected elements and inert on the '
      + 'other 1, whose UIAnchor.zIndex overwrites it. Editing here writes to all of them; '
      + 'the anchored ones will discard it.',
    );
  });
});
