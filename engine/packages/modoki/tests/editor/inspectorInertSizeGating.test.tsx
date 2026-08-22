// @vitest-environment jsdom
/** Inspector — UIElement width/height gating under a stretched UIAnchor (issue #16).
 *
 *  WHY THIS EXISTS AT ALL: the gating was already implemented and working, but had no
 *  automated cover, so nothing in the repo could answer "is it there?" — and #16 was
 *  filed asserting it was missing. A pure helper test (isSizeInert / inertSizeTooltip)
 *  would NOT have answered it either: the question is whether the decision reaches the
 *  rendered control. So this mounts the real Inspector and asserts the WIRING —
 *  readOnly, the dimming, the disabled unit dropdown, and the on-hover explanation —
 *  per axis, against a live sibling-trait read.
 *
 *  The cross-trait read is the fragile part: `width` lives on UIElement but must know
 *  the sibling UIAnchor's mode, which the per-trait field loop does not carry. Here
 *  that read is REAL (findEntity → entity.get(UIAnchor)); only the world/registry
 *  plumbing under it is mocked, following hierarchyGhostGating.test.tsx. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

/** The sibling UIAnchor's mode PER ENTITY ID, swapped per test before render. A null
 *  entry = that entity has no UIAnchor at all. Keyed by id (not a single mode) because
 *  the multi-select gate (#34) is precisely about the entries DIFFERING. */
const anchorState = vi.hoisted(() => ({ byId: new Map<number, string | null>() }));

const UI_ELEMENT_META = {
  name: 'UIElement',
  category: 'component' as const,
  fields: {
    // The tooltips mirror the real registration (engine/app/ecs/registerTraits.ts) so
    // the supersession test below is about real content, not an invented string.
    width: { type: 'number', step: 1, tooltip: 'Element width. 0 = auto (sized by content/flexbox)' },
    widthUnit: { type: 'string' },
    height: { type: 'number', step: 1, tooltip: 'Element height. 0 = auto (sized by content/flexbox)' },
    heightUnit: { type: 'string' },
    // The self-placement half of the same gate: killed by ANY anchor, whatever its
    // mode. In the real registration these sit in the Layout section, which is also
    // where the AnchorLayoutNote banner renders — so both are exercised here.
    flexGrow: { type: 'number', step: 1, section: 'Layout' },
    alignSelf: { type: 'enum', options: ['auto', 'center'], section: 'Layout' },
    // A container/child-layout prop: an anchor must NOT touch it (Unity LayoutGroup).
    gap: { type: 'number', step: 1, section: 'Layout' },
  },
  trait: {} as never,
};
const UI_ANCHOR_META = { name: 'UIAnchor', category: 'component' as const, fields: {}, trait: { __anchor: true } as never };

// The merged read the Inspector renders from: one UIElement section carrying an
// authored size on BOTH axes, so each test can assert the live axis is untouched.
const ELEMENT_DATA = { width: 90, widthUnit: '%', height: 40, heightUnit: '%', flexGrow: 0, alignSelf: 'auto', gap: 4 };

/** The multi-entity write the Inspector commits through. Spied (not stubbed away)
 *  so a test can assert WHO an editable field's write reaches — the gate must not
 *  silently narrow that. */
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

/** The row `<div>` wrapping a value+unit field, found by its label text. */
function sizeRow(container: HTMLElement, label: 'width' | 'height') {
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
  };
}

/** A plain NumberField row (label + input, no unit dropdown) — flexGrow/gap. The
 *  dimming lives on renderField's OUTER wrapper, one level above the row itself.
 *  Matched on DIRECT children rather than a `:scope > input` selector: jsdom does not
 *  constrain `:scope >` to direct children, so that selector also matches the outer
 *  wrapper and the lookup finds two rows for one field. */
function numberRow(container: HTMLElement, label: string) {
  const rows = [...container.querySelectorAll('div')].filter((d) => {
    const kids = [...d.children];
    return kids[0]?.textContent?.trim() === label && kids.some((c) => c.tagName === 'INPUT');
  });
  if (rows.length !== 1) throw new Error(`expected exactly 1 '${label}' row, found ${rows.length}`);
  const row = rows[0];
  const outer = row.parentElement as HTMLElement;
  return {
    input: row.querySelector('input') as HTMLInputElement,
    dimmed: outer.style.opacity !== '' && Number(outer.style.opacity) < 1,
  };
}

/** The alignSelf dropdown — an enum field, disabled rather than read-only. */
function enumRow(container: HTMLElement, label: string) {
  const selects = [...container.querySelectorAll('select')].filter(
    (s) => s.parentElement?.firstElementChild?.textContent?.trim() === label,
  );
  if (selects.length !== 1) throw new Error(`expected exactly 1 '${label}' dropdown, found ${selects.length}`);
  return selects[0];
}

function mount(mode: string, hasAnchor = true) {
  return mountMulti([hasAnchor ? mode : null]);
}

/** Mount with one selected entity per entry — `null` = that entity has no UIAnchor.
 *  Entity ids are 1..n; the FIRST entry is the primary, which is what the pre-#34 code
 *  resolved the whole gate from. */
function mountMulti(modes: (string | null)[]) {
  anchorState.byId = new Map(modes.map((m, i) => [i + 1, m]));
  const ids = modes.map((_, i) => i + 1);
  useEditorStore.setState({ selectedEntityId: ids[0], selectedEntityIds: ids, selectedAsset: null, selectedAssets: [] });
  return render(<Inspector />);
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); writeSpy.mockClear(); });
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe('Inspector — an inert UIElement size is gated per axis (#16)', () => {
  it('a bottom-stretch anchor gates width and leaves height fully live', () => {
    // The games/court NarrationBand case the issue was filed about.
    const { container } = mount('bottom-stretch');
    const w = sizeRow(container, 'width');
    expect(w.input.readOnly).toBe(true);
    expect(w.unit.disabled).toBe(true);
    expect(w.dimmed).toBe(true);

    const h = sizeRow(container, 'height');
    expect(h.input.readOnly).toBe(false);
    expect(h.unit.disabled).toBe(false);
    expect(h.dimmed).toBe(false);
  });

  it('mirrors that for a left-stretch anchor — height gated, width live', () => {
    const { container } = mount('left-stretch');
    expect(sizeRow(container, 'height').input.readOnly).toBe(true);
    expect(sizeRow(container, 'width').input.readOnly).toBe(false);
  });

  it('gates BOTH axes under a full stretch', () => {
    const { container } = mount('stretch');
    expect(sizeRow(container, 'width').input.readOnly).toBe(true);
    expect(sizeRow(container, 'height').input.readOnly).toBe(true);
  });

  it('leaves both editable on a non-stretched anchor', () => {
    const { container } = mount('bottom');
    expect(sizeRow(container, 'width').input.readOnly).toBe(false);
    expect(sizeRow(container, 'height').input.readOnly).toBe(false);
  });

  it('leaves both editable when the entity has NO UIAnchor at all', () => {
    // A free-flow UIElement is sized by width/height — gating there would be a
    // regression that the anchor-mode tests above could never catch.
    const { container } = mount('bottom-stretch', false);
    expect(sizeRow(container, 'width').input.readOnly).toBe(false);
    expect(sizeRow(container, 'height').input.readOnly).toBe(false);
  });

  it('still SHOWS the authored value rather than blanking or zeroing it', () => {
    // Inert ≠ absent: the stored value must stay visible, or the scene looks edited.
    const { container } = mount('bottom-stretch');
    expect(sizeRow(container, 'width').input.value).toBe('90');
  });
});

describe('Inspector — the gate is unanimous-or-nothing across a multi-selection (#34)', () => {
  it('does NOT gate a live sibling just because the PRIMARY is stretched', () => {
    // The reported bug: the gate resolved from entityIds[0] alone, so selecting a
    // stretched element first made width read-only for the un-stretched one too —
    // removing the only way to author a value that genuinely takes effect there.
    const { container } = mountMulti(['bottom-stretch', 'bottom']);
    const w = sizeRow(container, 'width');
    expect(w.input.readOnly).toBe(false);
    expect(w.unit.disabled).toBe(false);
  });

  it('does NOT leave the field wide open just because the PRIMARY is un-stretched', () => {
    // The other direction: the same primary-only read let a write land on the
    // stretched sibling, which silently discards it — the #16 trap, via the selection.
    // Editable is still the right call (the un-stretched one needs it), so the signal
    // is the visible half-dim + the explanation, not a block.
    const { container } = mountMulti(['bottom', 'bottom-stretch']);
    const w = sizeRow(container, 'width');
    expect(w.input.readOnly).toBe(false);
    expect(w.dimmed).toBe(true);
  });

  it('gates only when EVERY selected entity has that axis inert', () => {
    const { container } = mountMulti(['bottom-stretch', 'stretch', 'h-stretch']);
    expect(sizeRow(container, 'width').input.readOnly).toBe(true);
    // height is inert on 'stretch' only — not unanimous, so it stays editable.
    expect(sizeRow(container, 'height').input.readOnly).toBe(false);
  });

  it('treats an un-anchored entity as live, so it un-gates the selection', () => {
    const { container } = mountMulti(['stretch', null]);
    expect(sizeRow(container, 'width').input.readOnly).toBe(false);
    expect(sizeRow(container, 'height').input.readOnly).toBe(false);
  });

  it('keeps a unanimously-anchored selection gated on both axes', () => {
    const { container } = mountMulti(['stretch', 'stretch']);
    expect(sizeRow(container, 'width').input.readOnly).toBe(true);
    expect(sizeRow(container, 'height').input.readOnly).toBe(true);
  });
});

describe('Inspector — self-placement props follow the SAME unanimity rule (#34)', () => {
  // These are gated by the mere PRESENCE of an anchor, whatever its mode — the other
  // half of the primary-only read, and the half that had no mount cover at all.
  it('disables grow/align-self when every selected entity is anchored', () => {
    const { container } = mountMulti(['center', 'bottom-stretch']);
    expect(numberRow(container, 'flexGrow').input.readOnly).toBe(true);
    expect(enumRow(container, 'alignSelf').disabled).toBe(true);
  });

  it('leaves them editable when only PART of the selection is anchored', () => {
    // Disabling here would strand the un-anchored entity, where flex placement is the
    // only positioning it has.
    const { container } = mountMulti(['center', null]);
    expect(numberRow(container, 'flexGrow').input.readOnly).toBe(false);
    expect(enumRow(container, 'alignSelf').disabled).toBe(false);
  });

  it('counts an anchor with an unreadable mode as anchored, not as un-anchored', () => {
    // `''` is a missing MODE, not a missing anchor. Collapsing the two would quietly
    // re-enable flex placement on an element whose anchor overrides it.
    const { container } = mountMulti(['', 'center']);
    expect(numberRow(container, 'flexGrow').input.readOnly).toBe(true);
    // ...while stretching nothing, so the size stays live.
    expect(sizeRow(container, 'width').input.readOnly).toBe(false);
  });

  it('never touches a child-layout prop, anchored or not (Unity LayoutGroup)', () => {
    const { container } = mountMulti(['stretch', 'stretch']);
    expect(numberRow(container, 'gap').input.readOnly).toBe(false);
    expect(numberRow(container, 'gap').dimmed).toBe(false);
  });
});

describe('Inspector — every data-ui-id in one render is UNIQUE', () => {
  // Not a style rule: chromeHandles.ts walks [data-ui-id] and `tap_handle` resolves the
  // FIRST match, so a duplicate id silently drives the wrong element (docs/debug-tools-mcp.md).
  // The property holds today because TraitSection renders ONCE PER TRAIT for the whole
  // selection (key={meta.name}, entityIds={selectedIds}) rather than once per selected
  // entity, and because a field lands in exactly one render branch. Both are structural
  // decisions elsewhere in Inspector.tsx that nothing else pins — a refactor that moved
  // TraitSection inside a per-entity loop would still LOOK right and would start emitting
  // one duplicate id per extra selected entity.
  const ids = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[data-ui-id]')).map((el) => el.getAttribute('data-ui-id')!);

  it('single selection', () => {
    const got = ids(mount('center').container);
    expect(got.length).toBeGreaterThan(0); // worthless if the render emitted none
    expect(new Set(got).size).toBe(got.length);
  });

  it('multi-select does NOT duplicate a trait section per selected entity', () => {
    const { container } = mountMulti(['center', 'center', 'center']);
    const got = ids(container);
    expect(got.length).toBeGreaterThan(0);
    const dupes = got.filter((id, i) => got.indexOf(id) !== i);
    expect(dupes, `duplicate data-ui-id across a 3-entity selection: ${[...new Set(dupes)].join(', ')}`).toEqual([]);
  });
});

describe('Inspector — number field data-ui-id (bug y9WMNPkT0DivkxZKJDWU)', () => {
  // A QA case previously aimed a CSS selector at the input's stale `value` attribute,
  // which stops matching the moment the value changes. Confirms the stable id actually
  // reaches the DOM for both widgets: the generic `hint.type:'number'` NumberField
  // ('gap') and the bounded UI-anchor BufferedNumberInput (the sizeRow 'width' input).
  it('tags a generic NumberField as inspector.field.<Trait>.<field>', () => {
    const { container } = mountMulti(['stretch', 'stretch']);
    expect(numberRow(container, 'gap').input.getAttribute('data-ui-id')).toBe('inspector.field.UIElement.gap');
  });

  it('tags the bounded size BufferedNumberInput the same way', () => {
    const { container } = mount('bottom-stretch');
    expect(sizeRow(container, 'height').input.getAttribute('data-ui-id')).toBe('inspector.field.UIElement.height');
  });
});

describe('Inspector — the anchor banner tells the truth about a mixed selection (#34)', () => {
  it('claims the fields are disabled only when they actually are', () => {
    const { container } = mountMulti(['center', 'center']);
    expect(container.textContent).toContain('Anchored');
    expect(container.textContent).toContain('are disabled');
  });

  it('says "partly anchored" instead when only some of the selection is', () => {
    const { container } = mountMulti(['center', null]);
    const text = container.textContent ?? '';
    expect(text).toContain('Partly anchored');
    // The old wording would be an outright lie here — the fields stay editable.
    expect(text).not.toContain('are disabled');
  });

  it('shows no banner at all when nothing is anchored', () => {
    const { container } = mountMulti([null, null]);
    expect(container.textContent).not.toContain('Anchored');
    expect(container.textContent).not.toContain('Partly anchored');
  });
});

describe('Inspector — an editable mixed field still writes to the WHOLE selection (#34)', () => {
  it('broadcasts a size edit to every selected entity, inert ones included', () => {
    // The gate decides whether the control is usable; it must not quietly change WHO
    // the write reaches. Writing only to the live entities would leave the field
    // permanently "mixed" and the scene half-edited.
    const { container } = mountMulti(['bottom', 'bottom-stretch']);
    const input = sizeRow(container, 'width').input;
    fireEvent.change(input, { target: { value: '55' } });
    fireEvent.blur(input);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [ids, , field, value] = writeSpy.mock.calls[0];
    expect(ids).toEqual([1, 2]);
    expect(field).toBe('width');
    expect(value).toBe(55);
  });

  // NOTE: there is deliberately no "a read-only field writes nothing" case here.
  // `fireEvent.change` sets the value programmatically, which bypasses `readOnly` in
  // jsdom exactly as it would in a real browser — such a test would pass or fail on
  // jsdom's behaviour, not the Inspector's. What actually blocks the user is the
  // `readonly` attribute, asserted directly in the gating suites above.
});

describe('Inspector — the gated field explains itself on hover (#16)', () => {
  /** Hover the label and run out the Tooltip's 300ms delay. */
  function hover(el: HTMLElement) {
    fireEvent.mouseEnter(el);
    act(() => { vi.advanceTimersByTime(400); });
  }

  it('names the anchor and the offsets that size the axis instead', () => {
    const { container } = mount('bottom-stretch');
    hover(sizeRow(container, 'width').label);
    const text = document.body.textContent ?? '';
    expect(text).toContain("'bottom-stretch'");
    expect(text).toContain('left/right');
  });

  it('says top/bottom for a gated height, not left/right', () => {
    const { container } = mount('left-stretch');
    hover(sizeRow(container, 'height').label);
    expect(document.body.textContent ?? '').toContain('top/bottom');
  });

  it('does NOT explain a field that is still live', () => {
    // The live axis must not inherit the sibling's excuse — that would be a lie
    // shown on an editable control.
    const { container } = mount('bottom-stretch');
    hover(sizeRow(container, 'height').label);
    expect(document.body.textContent ?? '').not.toContain('has no effect');
  });

  it('SUPERSEDES the field\'s own hint rather than showing it alongside', () => {
    // UIElement.width's registered tooltip is "0 = auto (sized by content/flexbox)",
    // which is actively WRONG once the axis is stretched — it is not sized by content,
    // it is sized by the offsets. Replacing it is the point; showing both would leave
    // the misleading half on screen.
    const { container } = mount('bottom-stretch');
    hover(sizeRow(container, 'width').label);
    const text = document.body.textContent ?? '';
    expect(text).toContain('has no effect');
    expect(text).not.toContain('sized by content/flexbox');
  });

  it('restores the field\'s own hint on an axis that is NOT stretched', () => {
    const { container } = mount('bottom');
    hover(sizeRow(container, 'width').label);
    expect(document.body.textContent ?? '').toContain('sized by content/flexbox');
  });

  it('says the write is PARTIALLY discarded on a mixed selection (#34)', () => {
    const { container } = mountMulti(['bottom', 'bottom-stretch']);
    hover(sizeRow(container, 'width').label);
    const text = document.body.textContent ?? '';
    expect(text).toContain('live on 1 of the 2 selected elements');
    expect(text).toContain('will discard it');
    // It must NOT claim the field has no effect — it has one, on half the selection.
    expect(text).not.toContain('has no effect');
  });

  it('names no anchor when the inert selection carries SEVERAL (#34)', () => {
    // Naming one would name the wrong anchor for the rest of the selection.
    const { container } = mountMulti(['bottom-stretch', 'stretch']);
    hover(sizeRow(container, 'width').label);
    const text = document.body.textContent ?? '';
    expect(text).toContain('has no effect on ANY of the selected elements');
    expect(text).not.toContain("'stretch'");
    expect(text).toContain('left/right');
  });

  it('still names the single shared anchor when the whole selection agrees', () => {
    const { container } = mountMulti(['bottom-stretch', 'bottom-stretch']);
    hover(sizeRow(container, 'width').label);
    expect(document.body.textContent ?? '').toContain("'bottom-stretch'");
  });

  it('uses the custom Tooltip, never a native title= (which never renders here)', () => {
    // Regression guard for the actual defect: `title` is invisible in the Electron
    // editor, so an explanation parked there is one nobody can read.
    const { container } = mount('bottom-stretch');
    const w = sizeRow(container, 'width');
    expect(w.row.getAttribute('title')).toBeNull();
    expect(w.input.getAttribute('title')).toBeNull();
    hover(w.label);
    expect(document.body.textContent ?? '').toContain('has no effect');
  });
});
