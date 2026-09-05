// @vitest-environment jsdom
/** Inspector — UIElement margin gating under ANY UIAnchor (issue #757).
 *
 *  WHY THIS EXISTS AT ALL: `isElementMarginInert`/`selectionAnchorGate` and the tooltip builders
 *  are pure and covered in uiAuthoring.test.ts, but a pure-helper test cannot answer whether the
 *  DECISION reaches the rendered control — which is precisely what #757 is about. `applyAnchorStyle`
 *  clears all four margins on an anchored element, and before this the Inspector rendered them as
 *  ordinary live number+unit rows: set one, watch nothing move, with no signal anywhere. So this
 *  mounts the real Inspector and asserts the WIRING, following inspectorInertSizeGating.test.tsx
 *  (the same `unit`-type field branch) and inspectorZIndexGating.test.tsx (the same #746 shape).
 *
 *  ⚠️ The discriminating case is a NON-STRETCHING anchor. Size dies only on a stretched axis;
 *  margin dies under every mode, so a suite that only ever mounts 'stretch' would stay green
 *  against a wrongly per-mode predicate. `'center'` and `'top-left'` are the tests that matter.
 *
 *  The cross-trait read is the fragile part: the margins live on UIElement but must know the
 *  sibling UIAnchor's mode, which the per-trait field loop does not carry. Here that read is REAL
 *  (findEntity → entity.get(UIAnchor)); only the world/registry plumbing under it is mocked. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

/** The sibling UIAnchor's mode PER ENTITY ID, swapped per test before render. `null` = that entity
 *  has no UIAnchor at all. Keyed by id because the multi-select gate (#34) is about them DIFFERING. */
const anchorState = vi.hoisted(() => ({ byId: new Map<number, string | null>() }));

const UI_ELEMENT_META = {
  name: 'UIElement',
  category: 'component' as const,
  fields: {
    // Tooltips mirror the real registration (`UIElement.marginTop` in
    // engine/app/ecs/registerTraits.ts — searched by name, not cited by line) so the supersession
    // test below is about real content rather than an invented string.
    marginTop: { type: 'number', step: 1, tooltip: 'Outer spacing top — flow layout only; an anchored element discards all four margins (use the UIAnchor offsets instead)' },
    marginTopUnit: { type: 'string' },
    marginLeft: { type: 'number', step: 1, tooltip: 'Outer spacing left — flow layout only; an anchored element discards all four margins (use the UIAnchor offsets instead)' },
    marginLeftUnit: { type: 'string' },
    // A padding field, which an anchor must NOT touch: padding is inside the box and survives
    // absolute positioning. If the gate ever widens from `MARGIN_KEYS` to "anything spacing-ish",
    // this is the row that catches it.
    paddingTop: { type: 'number', step: 1, tooltip: 'Inner spacing top' },
    paddingTopUnit: { type: 'string' },
  },
  trait: {} as never,
};
const UI_ANCHOR_META = { name: 'UIAnchor', category: 'component' as const, fields: {}, trait: { __anchor: true } as never };

const ELEMENT_DATA = { marginTop: 20, marginTopUnit: 'px', marginLeft: 8, marginLeftUnit: 'px', paddingTop: 4, paddingTopUnit: 'px' };

/** The multi-entity write the Inspector commits through. Spied, not stubbed away, so a test can
 *  assert the gate does not silently NARROW an editable field's write (the #34 rule). */
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
  getTraitByName: (n: string) => (n === 'UIAnchor' ? UI_ANCHOR_META : undefined),
  COMPONENT_CATEGORY_ORDER: ['component', 'resource', 'tag'],
}));

vi.mock('../../src/runtime/core/ecs/entityUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/core/ecs/entityUtils')>();
  return {
    ...actual,
    findEntity: (id: number) => {
      const mode = anchorState.byId.get(id) ?? null;
      return mode === null
        ? { has: () => false, get: () => undefined }
        : { has: () => true, get: () => ({ anchor: mode }) };
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
  inertMarginTooltip,
  inertMarginTooltipMultiAnchor,
  partiallyInertMarginTooltip,
} = await import('../../src/editor/panels/Inspector');

/** The row `<div>` wrapping a value+unit field, found by its label text. Same shape as
 *  inspectorInertSizeGating's `sizeRow` — margin uses the identical `unit` branch, where the
 *  dimming opacity lives on the row div itself rather than on an outer wrapper. */
function unitRow(container: HTMLElement, label: string) {
  const rows = [...container.querySelectorAll('div')].filter((d) => {
    const first = d.firstElementChild;
    return first?.textContent?.trim() === label && d.querySelector(':scope > input');
  });
  if (rows.length !== 1) throw new Error(`expected exactly 1 '${label}' row, found ${rows.length}`);
  const row = rows[0];
  return {
    row,
    label: row.firstElementChild as HTMLElement,
    input: row.querySelector(':scope > input') as HTMLInputElement,
    unit: row.querySelector(':scope > select') as HTMLSelectElement,
    dimmed: row.style.opacity !== '' && Number(row.style.opacity) < 1,
    opacity: row.style.opacity,
  };
}

function hover(el: HTMLElement) {
  fireEvent.mouseEnter(el);
  act(() => { vi.advanceTimersByTime(400); });
}

function mount(mode: string | null) { return mountMulti([mode]); }

/** Mount with one selected entity per entry — `null` = no UIAnchor. Ids are 1..n, first is primary. */
function mountMulti(modes: (string | null)[]) {
  anchorState.byId = new Map(modes.map((m, i) => [i + 1, m]));
  const ids = modes.map((_, i) => i + 1);
  useEditorStore.setState({ selectedEntityId: ids[0], selectedEntityIds: ids, selectedAsset: null, selectedAssets: [] });
  return render(<Inspector />);
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); writeSpy.mockClear(); });
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe('Inspector — UIElement margin is gated by any UIAnchor (#757)', () => {
  it('⭐ a NON-stretching anchor still greys all four margins — the per-mode trap', () => {
    // The test that discriminates against a predicate copied from isSizeInert. 'center' stretches
    // nothing, yet applyAnchorStyle clears the margins just the same.
    const { container } = mount('center');
    for (const key of ['marginTop', 'marginLeft']) {
      const m = unitRow(container, key);
      expect(m.input.readOnly, `${key} input`).toBe(true);
      expect(m.unit.disabled, `${key} unit dropdown`).toBe(true);
      expect(m.dimmed, `${key} dimming`).toBe(true);
      expect(m.opacity).toBe('0.35');
    }
  });

  it('a stretching anchor greys them too, and the tooltip names the responsible anchor', () => {
    const { container } = mount('stretch');
    const m = unitRow(container, 'marginTop');
    expect(m.input.readOnly).toBe(true);
    hover(m.label);
    const text = document.body.textContent ?? '';
    expect(text).toContain(inertMarginTooltip('marginTop', 'stretch'));
    // The gate tooltip SUPERSEDES the field's registered hint, which would otherwise claim the
    // field does something here.
    expect(text).not.toContain('Outer spacing top — flow layout only');
  });

  it('NO anchor leaves the margins fully live, with the registered tooltip', () => {
    const { container } = mount(null);
    const m = unitRow(container, 'marginTop');
    expect(m.input.readOnly).toBe(false);
    expect(m.unit.disabled).toBe(false);
    expect(m.dimmed).toBe(false);
    hover(m.label);
    expect(document.body.textContent ?? '').toContain('Outer spacing top — flow layout only');
  });

  it('padding is NEVER touched — it is inside the box and survives absolute positioning', () => {
    const { container } = mount('stretch');
    const p = unitRow(container, 'paddingTop');
    expect(p.input.readOnly).toBe(false);
    expect(p.unit.disabled).toBe(false);
    expect(p.dimmed).toBe(false);
  });

  it('an unreadable anchor mode still counts as anchored', () => {
    // '' is a missing MODE, not a missing anchor — and the margins are cleared regardless.
    const { container } = mount('');
    expect(unitRow(container, 'marginTop').input.readOnly).toBe(true);
  });

  it("...and its tooltip does NOT render \"a '' anchor\" at the author", () => {
    // An unnamed mode falls to the multi-anchor wording rather than quoting an empty string, which
    // would point at a mode the author cannot see in the dropdown.
    const { container } = mount('');
    hover(unitRow(container, 'marginTop').label);
    const text = document.body.textContent ?? '';
    expect(text).not.toContain("'' anchor");
    expect(text).toContain(inertMarginTooltipMultiAnchor('marginTop'));
  });

  describe('across a multi-selection the gate is unanimous-or-nothing (#34)', () => {
    it('every entity anchored → read-only, with a tooltip naming no single anchor when modes differ', () => {
      const { container } = mountMulti(['center', 'stretch']);
      const m = unitRow(container, 'marginTop');
      expect(m.input.readOnly).toBe(true);
      hover(m.label);
      expect(document.body.textContent ?? '').toContain(inertMarginTooltipMultiAnchor('marginTop'));
    });

    it('every entity anchored with the SAME mode → the tooltip may name it', () => {
      const { container } = mountMulti(['center', 'center']);
      hover(unitRow(container, 'marginTop').label);
      expect(document.body.textContent ?? '').toContain(inertMarginTooltip('marginTop', 'center'));
    });

    it('⭐ MIXED stays EDITABLE at half opacity, and the write is not narrowed', () => {
      // Disabling here would strand the flow-layout entity, where the margin genuinely applies —
      // the #34 rule. The write must still reach BOTH selected entities.
      const { container } = mountMulti(['center', null]);
      const m = unitRow(container, 'marginTop');
      expect(m.input.readOnly).toBe(false);
      expect(m.unit.disabled).toBe(false);
      expect(m.opacity).toBe('0.65');
      hover(m.label);
      expect(document.body.textContent ?? '').toContain(partiallyInertMarginTooltip('marginTop', 1, 2));

      fireEvent.change(m.input, { target: { value: '33' } });
      fireEvent.blur(m.input);
      expect(writeSpy).toHaveBeenCalled();
      const ids = writeSpy.mock.calls.at(-1)?.[0];
      expect(ids).toEqual([1, 2]);
    });

    it('no entity anchored → fully live', () => {
      const { container } = mountMulti([null, null]);
      const m = unitRow(container, 'marginTop');
      expect(m.input.readOnly).toBe(false);
      expect(m.dimmed).toBe(false);
    });
  });
});
