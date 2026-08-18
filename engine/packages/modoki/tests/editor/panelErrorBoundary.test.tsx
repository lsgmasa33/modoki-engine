/** QA-EDITOR-0008 — "Reload Panel" genuinely remounts, but a panel whose PERSISTED layout
 *  config is what throws is bound to the same in-memory FlexLayout node, so it re-crashes
 *  identically and the UI offered no other way out. Even repairing the file on disk changed
 *  nothing: only re-reading the layout does, i.e. an editor reload.
 *
 *  These pin the escalation, and — as importantly — that it stays OUT of the way for the
 *  crash a remount does fix. The reload is a real `window.location.reload()` in the app, so
 *  it comes through a prop seam here rather than being asserted against jsdom's navigation. */
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import PanelErrorBoundary from '../../src/editor/panels/PanelErrorBoundary';

afterEach(cleanup);

/** A child that throws while `bad.on` — the flag models the offending state itself (a bad
 *  persisted config), not a render count. React re-invokes a throwing component in dev to
 *  rebuild the stack, so counting renders would make the test's own arithmetic the variable. */
const bad = { on: true };
function Child({ tick }: { tick?: number }) {
  if (bad.on) throw new Error('config.levels is not iterable');
  return <div data-testid="ok">Console {tick ?? 0}</div>;
}

const mount = (onReloadEditor = vi.fn()) => {
  bad.on = true;
  // React logs the caught error; silence it so the suite output stays readable.
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const tree = (tick: number) => (
    <PanelErrorBoundary label="Console" onReloadEditor={onReloadEditor}><Child tick={tick} /></PanelErrorBoundary>
  );
  const { rerender } = render(tree(0));
  return { onReloadEditor, restore: () => err.mockRestore(), rerender: (tick: number) => rerender(tree(tick)) };
};

describe('PanelErrorBoundary', () => {
  it('a recoverable crash clears on Reload Panel, and never shows the escalation', () => {
    const { restore } = mount();
    expect(screen.getByText('Console crashed')).toBeTruthy();
    expect(screen.queryByText(/Reload Editor/)).toBeNull();

    bad.on = false; // whatever caused it is gone — the remount is enough
    fireEvent.click(screen.getByText('Reload Panel'));
    expect(screen.getByTestId('ok')).toBeTruthy();
    restore();
  });

  it('offers the editor reload only after the remount has demonstrably failed', () => {
    const { restore } = mount();
    // First crash: the in-place retry is the only thing offered.
    expect(screen.queryByText('Reload Editor')).toBeNull();

    fireEvent.click(screen.getByText('Reload Panel'));
    // It crashed straight back — now the escalation appears, with the retry still available.
    expect(screen.getByText('Reload Editor')).toBeTruthy();
    expect(screen.getByText('Reload Panel')).toBeTruthy();
    expect(screen.getByText(/saved layout settings are the likely cause/)).toBeTruthy();
    restore();
  });

  it('a survived remount clears the retry count — a later, unrelated crash gets its own retry', () => {
    // The counter used to be monotonic for the boundary's lifetime, so a panel that crashed,
    // recovered, and hit something else an hour later skipped straight to "reload the editor"
    // — telling the user to take the heavy action before its own in-place retry was tried.
    const { restore, rerender } = mount();
    bad.on = false;
    fireEvent.click(screen.getByText('Reload Panel'));
    expect(screen.getByTestId('ok')).toBeTruthy();

    bad.on = true;      // something unrelated breaks, later
    rerender(1);        // the parent re-renders the subtree; the child throws again
    expect(screen.getByText('Console crashed')).toBeTruthy();
    // The in-place retry is offered again — NOT the editor reload.
    expect(screen.getByText('Reload Panel')).toBeTruthy();
    expect(screen.queryByText('Reload Editor')).toBeNull();
    restore();
  });

  it('confirms in place before reloading, and Cancel backs out without reloading', () => {
    const { onReloadEditor, restore } = mount();
    fireEvent.click(screen.getByText('Reload Panel'));

    fireEvent.click(screen.getByText('Reload Editor'));
    expect(screen.getByText(/Unsaved scene edits are discarded/)).toBeTruthy();
    expect(onReloadEditor).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Cancel'));
    expect(onReloadEditor).not.toHaveBeenCalled();
    expect(screen.queryByText(/Unsaved scene edits are discarded/)).toBeNull();

    fireEvent.click(screen.getByText('Reload Editor'));
    fireEvent.click(screen.getByRole('button', { name: 'Reload Editor' }));
    expect(onReloadEditor).toHaveBeenCalledTimes(1);
    restore();
  });
});
