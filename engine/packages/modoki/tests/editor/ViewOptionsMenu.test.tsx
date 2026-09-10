// @vitest-environment jsdom
/** ViewOptionsMenu — the "View ▾" dropdown consolidating SceneView's FX/Grid/Colliders (3D)
 *  and FX/Focus/Colliders (2D) toggles (see docs/editor.md). Covers the chrome logic
 *  that isn't provable by the e2e collider-mode spec: badge count, closed-by-default, opening
 *  on trigger click, closing on outside click, and that each row's `onToggle` fires without
 *  the menu itself owning any checked state (the caller does — this is dumb chrome). Escape-
 *  to-close (`useOverlayEscape`) is real-keyboard behavior verified in Playwright instead,
 *  matching every other overlay-escape consumer in this codebase (none is unit-tested for it). */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ViewOptionsMenu, viewBadgeLabel, type ViewOption } from '../../src/editor/panels/ViewOptionsMenu';

afterEach(() => { cleanup(); });

const items = (overrides: Partial<Record<'fx' | 'grid' | 'colliders', boolean>> = {}): ViewOption[] => [
  { key: 'fx', label: 'FX', checked: overrides.fx ?? false, onToggle: vi.fn(), uiId: 'test.fx' },
  { key: 'grid', label: 'Grid', checked: overrides.grid ?? true, onToggle: vi.fn(), uiId: 'test.grid' },
  { key: 'colliders', label: 'Colliders', checked: overrides.colliders ?? false, onToggle: vi.fn(), uiId: 'test.colliders' },
];

describe('ViewOptionsMenu', () => {
  it('renders closed by default — no item rows in the DOM until opened', () => {
    const { queryByText } = render(<ViewOptionsMenu uiId="test.menu" items={items()} />);
    expect(queryByText('FX')).toBeNull();
    expect(queryByText('Grid')).toBeNull();
  });

  // #1003 — the trigger NAMES what is on rather than counting it. The old `(N)` badge could not
  // answer "which one?", and in 3D it read `(1)` at rest because Grid is checked by default, so it
  // was identical whether the content-hiding Colliders mode was on or off.
  it('the trigger label NAMES the checked options, and says just View when none are', () => {
    const { getByTitle, rerender } = render(<ViewOptionsMenu uiId="test.menu" items={items()} />);
    expect(getByTitle('View options').textContent).toContain('View: Grid'); // only Grid checked

    rerender(<ViewOptionsMenu uiId="test.menu" items={items({ colliders: true })} />);
    expect(getByTitle('View options').textContent).toContain('View: Grid, Colliders');

    rerender(<ViewOptionsMenu uiId="test.menu" items={items({ grid: false })} />);
    expect(getByTitle('View options').textContent).toContain('View');
    expect(getByTitle('View options').textContent).not.toContain(':');
  });

  // The regression this replaces a count with: Colliders on must never render the same string as
  // Colliders off. Asserted directly rather than inferred from the two cases above, because that
  // equality is the actual defect — a count satisfies "shows something" and still says nothing.
  it('Colliders on and Colliders off never produce the SAME badge (#1003)', () => {
    // ⚠️ Deliberately the EQUAL-COUNT pair, which is the real-world confusion: Grid-only and
    // Colliders-only are both "one option active", so the old `(N)` badge rendered the identical
    // string for a viewport showing everything and one showing nothing. A pair with different counts
    // would let a count-based badge pass this and prove nothing.
    const { getByTitle, rerender } = render(
      <ViewOptionsMenu uiId="test.menu" items={items({ grid: true, colliders: false })} />);
    const gridOnly = getByTitle('View options').textContent;
    rerender(<ViewOptionsMenu uiId="test.menu" items={items({ grid: false, colliders: true })} />);
    const collidersOnly = getByTitle('View options').textContent;

    expect(collidersOnly).not.toBe(gridOnly);
    expect(collidersOnly).toContain('Colliders');
    expect(gridOnly).not.toContain('Colliders');
  });

  it('a notable option survives the two-name cap — the cap must not drop what it exists to surface', () => {
    // Regression: the cap worked in items order and `colliders` is LAST in both real menus, so
    // FX + Focus + Colliders rendered "View: FX, Focus +1" — eliding the one content-removing option.
    const mk = (label: string, checked: boolean, notable = false) =>
      ({ key: label, label, checked, notable, onToggle: () => {}, uiId: label });
    const label = viewBadgeLabel([mk('FX', true), mk('Focus', true), mk('Colliders', true, true)]);
    expect(label).toContain('Colliders');
    expect(label).toBe('View: Colliders, FX +1');
  });

  it('viewBadgeLabel caps the names at two and counts the rest', () => {
    const mk = (label: string, checked: boolean) => ({ key: label, label, checked, onToggle: () => {}, uiId: label });
    expect(viewBadgeLabel([mk('A', false)])).toBe('View');
    expect(viewBadgeLabel([mk('A', true)])).toBe('View: A');
    expect(viewBadgeLabel([mk('A', true), mk('B', true)])).toBe('View: A, B');
    expect(viewBadgeLabel([mk('A', true), mk('B', true), mk('C', true), mk('D', true)])).toBe('View: A, B +2');
  });

  it('clicking the trigger opens the menu, revealing every item with its checked state', () => {
    const { getByTitle, getByText, getByLabelText } = render(<ViewOptionsMenu uiId="test.menu" items={items({ grid: true })} />);
    fireEvent.click(getByTitle('View options'));

    expect(getByText('FX')).toBeTruthy();
    expect(getByText('Grid')).toBeTruthy();
    expect(getByText('Colliders')).toBeTruthy();
    expect((getByLabelText('Grid') as HTMLInputElement).checked).toBe(true);
    expect((getByLabelText('FX') as HTMLInputElement).checked).toBe(false);
  });

  it('checking a row calls that item\'s onToggle (and no other item\'s)', () => {
    const rows = items();
    const { getByTitle, getByLabelText } = render(<ViewOptionsMenu uiId="test.menu" items={rows} />);
    fireEvent.click(getByTitle('View options'));

    fireEvent.click(getByLabelText('FX'));

    expect(rows[0].onToggle).toHaveBeenCalledTimes(1);
    expect(rows[1].onToggle).not.toHaveBeenCalled();
    expect(rows[2].onToggle).not.toHaveBeenCalled();
  });

  it('does not itself flip `checked` — it is dumb chrome, the caller owns state', () => {
    // Since onToggle is a plain mock (not wired to a state setter), re-clicking should call
    // onToggle again with the SAME checked prop unchanged — proving the menu has no internal
    // checked state of its own to get out of sync with the caller's.
    const rows = items({ grid: true });
    const { getByTitle, getByLabelText } = render(<ViewOptionsMenu uiId="test.menu" items={rows} />);
    fireEvent.click(getByTitle('View options'));
    const checkbox = getByLabelText('Grid') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true); // unchanged — no local state, purely prop-driven
    expect(rows[1].onToggle).toHaveBeenCalledTimes(1);
  });

  it('clicking outside the menu closes it', () => {
    const { getByTitle, queryByText, container } = render(
      <div>
        <div data-testid="outside" />
        <ViewOptionsMenu uiId="test.menu" items={items()} />
      </div>,
    );
    fireEvent.click(getByTitle('View options'));
    expect(queryByText('FX')).toBeTruthy();

    fireEvent.mouseDown(container.querySelector('[data-testid="outside"]')!);
    expect(queryByText('FX')).toBeNull();
  });

  it('clicking the trigger again toggles the menu closed', () => {
    const { getByTitle, queryByText } = render(<ViewOptionsMenu uiId="test.menu" items={items()} />);
    const trigger = getByTitle('View options');
    fireEvent.click(trigger);
    expect(queryByText('FX')).toBeTruthy();
    fireEvent.click(trigger);
    expect(queryByText('FX')).toBeNull();
  });

  it('tags the trigger with the caller-owned uiId, and each row with its own', () => {
    const { getByTitle } = render(<ViewOptionsMenu uiId="test.menu" items={items()} />);
    const trigger = getByTitle('View options');
    expect(trigger.getAttribute('data-ui-id')).toBe('test.menu');
    fireEvent.click(trigger);
    expect(document.querySelector('[data-ui-id="test.fx"]')).toBeTruthy();
    expect(document.querySelector('[data-ui-id="test.grid"]')).toBeTruthy();
    expect(document.querySelector('[data-ui-id="test.colliders"]')).toBeTruthy();
  });
});
