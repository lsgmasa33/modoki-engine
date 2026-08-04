/** Mouse-selection policy for the Assets panel (#105 Phase 3).
 *
 *  The anchor rule is the point: a Shift-click ranges from the anchor and leaves it
 *  alone, so consecutive Shift-clicks re-range from the SAME origin instead of
 *  walking. Reversing that looks, to a user, like the panel losing their selection. */

import { describe, it, expect } from 'vitest';
import { resolveClickSelection, dragPathsFor } from '../../src/editor/panels/assetSelection';

const ORDER = ['/a/one', '/a/two', '/a/three', '/a/four'];

const click = (over: Partial<Parameters<typeof resolveClickSelection>[0]> = {}) =>
  resolveClickSelection({
    path: '/a/two', current: new Set(), anchor: null, order: ORDER,
    toggle: false, range: false, ...over,
  });

describe('a plain click replaces the selection and moves the anchor', () => {
  it('selects only the clicked row', () => {
    const r = click({ current: new Set(['/a/one', '/a/four']) });
    expect([...r.paths]).toEqual(['/a/two']);
    expect(r.anchor).toBe('/a/two');
  });
});

describe('Cmd/Ctrl-click toggles and moves the anchor', () => {
  it('adds a row to the selection', () => {
    const r = click({ toggle: true, current: new Set(['/a/one']) });
    expect([...r.paths].sort()).toEqual(['/a/one', '/a/two']);
    expect(r.anchor).toBe('/a/two');
  });

  it('removes a row that was already selected', () => {
    const r = click({ toggle: true, current: new Set(['/a/one', '/a/two']) });
    expect([...r.paths]).toEqual(['/a/one']);
  });

  it('can empty the selection entirely', () => {
    expect([...click({ toggle: true, current: new Set(['/a/two']) }).paths]).toEqual([]);
  });

  it('does not mutate the incoming selection', () => {
    const current = new Set(['/a/one']);
    click({ toggle: true, current });
    expect([...current]).toEqual(['/a/one']);
  });
});

describe('Shift-click ranges from the anchor WITHOUT moving it', () => {
  it('selects the span in visible order', () => {
    const r = click({ path: '/a/four', range: true, anchor: '/a/two' });
    expect([...r.paths]).toEqual(['/a/two', '/a/three', '/a/four']);
  });

  it('leaves the anchor alone, so a second Shift-click re-ranges from the same origin', () => {
    const first = click({ path: '/a/four', range: true, anchor: '/a/two' });
    expect(first.anchor).toBeUndefined();
    // Anchor is still /a/two — shrinking the range must give two rows, not walk.
    const second = click({ path: '/a/three', range: true, anchor: '/a/two' });
    expect([...second.paths]).toEqual(['/a/two', '/a/three']);
  });

  it('ranges upward too', () => {
    expect([...click({ path: '/a/one', range: true, anchor: '/a/three' }).paths])
      .toEqual(['/a/one', '/a/two', '/a/three']);
  });

  it('with no anchor at all, behaves like a plain click', () => {
    const r = click({ path: '/a/three', range: true, anchor: null });
    expect([...r.paths]).toEqual(['/a/three']);
    expect(r.anchor).toBe('/a/three');
  });

  it('degrades to the clicked row when the anchor is no longer visible', () => {
    // Never an EMPTY selection — that would read as the click doing nothing.
    const r = click({ path: '/a/three', range: true, anchor: '/a/scrolled-away' });
    expect([...r.paths]).toEqual(['/a/three']);
  });

  it('degrades when the clicked row itself is not in the visible order', () => {
    expect([...click({ path: '/a/ghost', range: true, anchor: '/a/two' }).paths]).toEqual(['/a/ghost']);
  });

  it('takes precedence over toggle when both modifiers are held', () => {
    const r = click({ path: '/a/four', range: true, toggle: true, anchor: '/a/three', current: new Set(['/a/one']) });
    expect([...r.paths]).toEqual(['/a/three', '/a/four']);
  });
});

describe('dragPathsFor', () => {
  it('carries the whole selection when the dragged row is part of a multi-selection', () => {
    expect(dragPathsFor('/a/two', new Set(['/a/one', '/a/two'])).sort()).toEqual(['/a/one', '/a/two']);
  });

  it('carries ONLY the dragged row when it is outside the selection', () => {
    // The one that matters: dragging an unselected asset must not move the
    // selected ones instead.
    expect(dragPathsFor('/a/three', new Set(['/a/one', '/a/two']))).toEqual(['/a/three']);
  });

  it('carries just the row when it is the lone selection', () => {
    expect(dragPathsFor('/a/two', new Set(['/a/two']))).toEqual(['/a/two']);
  });

  it('carries just the row when nothing is selected', () => {
    expect(dragPathsFor('/a/two', new Set())).toEqual(['/a/two']);
  });
});
