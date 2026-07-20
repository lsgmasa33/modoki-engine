// @vitest-environment jsdom
/** Integration (jsdom + @testing-library/react): the Inspector `Section` header's `⋮`
 *  menu, which replaced the bare `✕` remove button.
 *
 *  The interesting part is the gesture, not the markup. ContextMenu closes itself from a
 *  DOCUMENT-level mousedown listener, and the `⋮` lives outside its ref — so a naive
 *  `onClick={openMenu}` makes the button unable to dismiss its own menu: mousedown closes,
 *  click reopens. And whatever the button does must not bubble to the header, which
 *  toggles the section collapsed. Both are invisible to a unit test of either component. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { Section } from '../../src/editor/panels/assetViews/widgets';
import type { ContextMenuItem } from '../../src/editor/components/ContextMenu';

afterEach(cleanup);

const BODY = 'section-body';
const body = () => screen.queryByTestId(BODY);
const kebab = () => screen.getByTitle('Health options');
const menu = () => document.querySelector('[data-menu-item]')?.parentElement ?? null;

function renderSection(opts: { menuItems?: ContextMenuItem[]; onRemove?: () => void } = {}) {
  return render(
    <Section title="Health" menuItems={opts.menuItems} onRemove={opts.onRemove}>
      <div data-testid={BODY}>fields</div>
    </Section>,
  );
}

/** A real press: mousedown (what ContextMenu listens for) then the click that follows. */
function press(el: Element) {
  fireEvent.mouseDown(el);
  fireEvent.click(el);
}

describe('Section ⋮ menu', () => {
  it('shows no ⋮ when there is nothing to put in it', () => {
    renderSection();
    expect(screen.queryByTitle('Health options')).toBeNull();
  });

  it('opens the menu with the supplied items', () => {
    renderSection({ menuItems: [{ label: 'Copy Component', onClick: vi.fn() }] });
    expect(menu()).toBeNull();
    press(kebab());
    expect(screen.getByText('Copy Component')).toBeTruthy();
  });

  it('REGRESSION: pressing ⋮ again CLOSES the menu (it must not reopen)', () => {
    // ContextMenu's document mousedown listener closes on the first press; a click-based
    // toggle would then reopen it on the very same gesture, so the button could never
    // dismiss its own menu.
    renderSection({ menuItems: [{ label: 'Copy Component', onClick: vi.fn() }] });
    press(kebab());
    expect(screen.queryByText('Copy Component')).toBeTruthy();
    press(kebab());
    expect(screen.queryByText('Copy Component')).toBeNull();
  });

  it('REGRESSION: the menu anchors under the BUTTON, not under the cursor', () => {
    // Anchored at the cursor, the menu's top-left corner lands ON the ⋮ and covers it, so
    // the next press hits the menu instead of the button and it can never be dismissed
    // from where it was opened. Only reproduces with real layout (every jsdom rect is
    // zero), so pin the input: the anchor must come from getBoundingClientRect, and the
    // press coordinates must be ignored.
    renderSection({ menuItems: [{ label: 'Copy Component', onClick: vi.fn() }] });
    const btn = kebab();
    btn.getBoundingClientRect = () => ({ left: 100, bottom: 40, right: 114, top: 26, width: 14, height: 14, x: 100, y: 26, toJSON: () => {} });

    fireEvent.mouseDown(btn, { clientX: 999, clientY: 999 }); // cursor far from the button
    const el = menu() as HTMLElement;
    expect(el.style.left).toBe('100px');    // button's left edge
    expect(el.style.top).toBe('42px');      // just below the button (bottom + 2)
    expect(el.style.left).not.toBe('999px');
  });

  it('pressing ⋮ does not collapse the section behind the menu', () => {
    // The header's onClick toggles `open`; the ⋮'s click must not bubble into it.
    renderSection({ menuItems: [{ label: 'Copy Component', onClick: vi.fn() }] });
    expect(body()).toBeTruthy();
    press(kebab());
    expect(body(), 'section stayed expanded').toBeTruthy();
  });

  it('clicking the header still toggles the section', () => {
    renderSection({ menuItems: [{ label: 'Copy Component', onClick: vi.fn() }] });
    fireEvent.click(screen.getByText('Health'));
    expect(body()).toBeNull();
  });

  it('right-clicking the header opens the same menu', () => {
    renderSection({ menuItems: [{ label: 'Copy Component', onClick: vi.fn() }] });
    fireEvent.contextMenu(screen.getByText('Health'));
    expect(screen.getByText('Copy Component')).toBeTruthy();
  });

  it('Remove lands last, behind a separator, and is danger-styled', () => {
    // The whole reason the ✕ moved into the kebab: a one-click destructive control sat
    // a few px from the collapse toggle.
    const onRemove = vi.fn();
    renderSection({ menuItems: [{ label: 'Copy Component', onClick: vi.fn() }], onRemove });
    press(kebab());
    const rows = [...document.querySelectorAll('[data-menu-item]')].map((r) => r.getAttribute('data-menu-item'));
    expect(rows).toEqual(['Copy Component', 'Remove Health']);
    expect(menu()!.querySelectorAll('div[style*="height: 1px"]').length).toBe(1);
    fireEvent.click(screen.getByText('Remove Health'));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('with only onRemove there is no leading separator', () => {
    renderSection({ onRemove: vi.fn() });
    press(kebab());
    expect(menu()!.querySelectorAll('div[style*="height: 1px"]').length).toBe(0);
  });

  it('a disabled item does not fire (Paste with a mismatched clipboard)', () => {
    const onPaste = vi.fn();
    renderSection({ menuItems: [{ label: 'Paste Component Values', disabled: true, onClick: onPaste }] });
    press(kebab());
    fireEvent.click(within(menu()!).getByText('Paste Component Values'));
    expect(onPaste).not.toHaveBeenCalled();
  });

  it('choosing an item runs it and closes the menu', () => {
    const onCopy = vi.fn();
    renderSection({ menuItems: [{ label: 'Copy Component', onClick: onCopy }] });
    press(kebab());
    fireEvent.click(screen.getByText('Copy Component'));
    expect(onCopy).toHaveBeenCalledOnce();
    expect(screen.queryByText('Copy Component')).toBeNull();
  });
});
