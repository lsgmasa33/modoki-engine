// @vitest-environment jsdom
/** badgeLabel — the one rule both dropdown triggers use to NAME what is on (#1003 View ▾, #1021
 *  Type ▾), plus the Type filter's own ordering. The rule is pure and tested directly; one mount
 *  test proves `TypeFilterMenu`'s trigger actually renders it (the #1021 wiring), since the e2e
 *  spec that does the same in a real editor is not part of the local gate. */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { namedBadgeLabel, typeFilterBadgeLabel } from '../../src/editor/panels/badgeLabel';
import { TypeFilterMenu } from '../../src/editor/panels/treeChrome';

afterEach(() => { cleanup(); });

describe('namedBadgeLabel', () => {
  it('is the bare label when nothing is on', () => {
    expect(namedBadgeLabel('Type', [])).toBe('Type');
  });

  it('names one or two, then collapses the rest into +N', () => {
    expect(namedBadgeLabel('Type', ['A'])).toBe('Type: A');
    expect(namedBadgeLabel('Type', ['A', 'B'])).toBe('Type: A, B');
    expect(namedBadgeLabel('Type', ['A', 'B', 'C'])).toBe('Type: A, B +1');
    expect(namedBadgeLabel('Type', ['A', 'B', 'C', 'D', 'E'])).toBe('Type: A, B +3');
  });
});

describe('typeFilterBadgeLabel (#1021)', () => {
  const types: [string, number][] = [['material', 16], ['mesh', 114], ['texture', 40]];

  it('says just Type when no filter is active', () => {
    expect(typeFilterBadgeLabel('Type', types, new Set())).toBe('Type');
  });

  // The defect: `Type (1)` read identically for every single-type filter, so the badge could not say
  // WHICH rows were hidden. Deliberately the EQUAL-COUNT pair — a count-based badge passes any pair
  // with different counts, and this one it cannot.
  it('two different one-type filters never render the SAME badge', () => {
    const a = typeFilterBadgeLabel('Type', types, new Set(['material']));
    const b = typeFilterBadgeLabel('Type', types, new Set(['texture']));
    expect(a).not.toBe(b);
    expect(a).toBe('Type: Material');
    expect(b).toBe('Type: Texture');
  });

  it('names types in MENU order, not the order they were ticked, capitalised like the rows', () => {
    expect(typeFilterBadgeLabel('Type', types, new Set(['texture', 'material']))).toBe('Type: Material, Texture');
  });

  // #1021 close-out review, measured by rendering the rows' CSS `text-transform: capitalize` in
  // headless Chromium: a hyphen starts a word, an underscore and a digit do not. `court-level` is a
  // real asset type, and the badge used to read `Court-level` beside a checked `Court-Level` row.
  it.each([
    ['court-level', 'Court-Level'],
    ['sprite_anim', 'Sprite_anim'],
    ['rig2d', 'Rig2d'],
    ['my level', 'My Level'],
    // Second review, also rendered: a word starts after ANY non-letter/digit/_/' character.
    ['a.b', 'A.B'],
    ['a/b', 'A/B'],
    ["it's", "It's"],
  ])('capitalises %s as the menu row renders it (%s)', (type, shown) => {
    expect(typeFilterBadgeLabel('Type', [[type, 1]], new Set([type]))).toBe(`Type: ${shown}`);
  });

  // A persisted filter (Assets keeps it across projects) can hold a type this tree does not have. It
  // still hides rows and has no checkbox to untick, so it must be the name the two-name cap keeps.
  it('a selected type the menu has no row for is named FIRST and survives the cap', () => {
    const label = typeFilterBadgeLabel('Type', types, new Set(['material', 'mesh', 'texture', 'script']));
    expect(label).toBe('Type: Script, Material +2');
  });

  it('counts an orphaned type in +N like any other', () => {
    expect(typeFilterBadgeLabel('Type', types, new Set(['script', 'prefab', 'mesh']))).toBe('Type: Script, Prefab +1');
  });
});

describe('TypeFilterMenu trigger', () => {
  it('renders the NAMED label, not a count (#1021)', () => {
    const { getByTitle, rerender } = render(
      <TypeFilterMenu types={[['material', 16], ['texture', 40]]} selected={new Set()} onToggle={() => {}} onClear={() => {}} />);
    expect(getByTitle('Filter by type').textContent).toMatch(/^Type(?!:)/);

    rerender(<TypeFilterMenu types={[['material', 16], ['texture', 40]]} selected={new Set(['texture'])} onToggle={() => {}} onClear={() => {}} />);
    const text = getByTitle('Filter by type').textContent;
    expect(text).toContain('Type: Texture');
    expect(text).not.toContain('(1)');
  });

  // Found live: Hierarchy's `types` arrive alphabetically but the menu LISTS them grouped by
  // category (Transform first), so with Light + Camera + Transform ticked the badge read
  // `Camera, Light +1` — eliding the first ticked row on screen. The names follow the listed order.
  it('names types in the order the GROUPED menu lists them, not the incoming flat sort', () => {
    const groupOf: Record<string, string> = { Camera: 'Rendering', Light: 'Rendering', Transform: 'Core' };
    const { getByTitle } = render(
      <TypeFilterMenu
        types={[['Camera', 1], ['Light', 3], ['Transform', 9]]}
        selected={new Set(['Camera', 'Light', 'Transform'])}
        groupBy={(t) => groupOf[t]} groupOrder={['Core', 'Rendering']}
        onToggle={() => {}} onClear={() => {}} />);
    expect(getByTitle('Filter by type').textContent).toContain('Type: Transform, Camera +1');
  });
});
