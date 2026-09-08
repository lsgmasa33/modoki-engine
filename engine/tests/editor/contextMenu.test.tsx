/** Unit (jsdom + @testing-library/react) — the shared ContextMenu component's
 *  separator + shortcut-hint additions, used by the reorganized Hierarchy menu.
 *  Asserts: shortcut hints render, separators render as inert dividers, normal
 *  items route onClick + onClose, and disabled items do neither. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ContextMenu, { type ContextMenuItem } from '../../packages/modoki/src/editor/components/ContextMenu';

const dividerOf = (container: HTMLElement) =>
  [...container.querySelectorAll('div')].find((d) => d.style.height === '1px');

describe('ContextMenu', () => {
  it('renders a right-aligned shortcut hint next to an item', () => {
    const items: ContextMenuItem[] = [{ label: 'Duplicate', shortcut: '⌘D', onClick: vi.fn() }];
    render(<ContextMenu items={items} x={0} y={0} onClose={vi.fn()} />);
    expect(screen.getByText('Duplicate')).toBeTruthy();
    expect(screen.getByText('⌘D')).toBeTruthy();
  });

  it('renders a separator as a non-interactive divider', () => {
    const onClose = vi.fn();
    const onClick = vi.fn();
    const items: ContextMenuItem[] = [
      { label: 'Copy', onClick },
      { label: '', separator: true },
      { label: 'Delete', danger: true, onClick },
    ];
    const { container } = render(<ContextMenu items={items} x={0} y={0} onClose={onClose} />);

    const divider = dividerOf(container);
    expect(divider).toBeTruthy();
    // Clicking the divider must not select anything or close the menu.
    fireEvent.click(divider!);
    expect(onClick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('fires onClick + onClose when a normal item is clicked', () => {
    const onClose = vi.fn();
    const onClick = vi.fn();
    render(<ContextMenu items={[{ label: 'Focus', shortcut: 'F', onClick }]} x={0} y={0} onClose={onClose} />);
    fireEvent.click(screen.getByText('Focus'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores clicks on a disabled item (e.g. Paste with an empty clipboard)', () => {
    const onClose = vi.fn();
    const onClick = vi.fn();
    render(<ContextMenu items={[{ label: 'Paste', shortcut: '⌘V', disabled: true, onClick }]} x={0} y={0} onClose={onClose} />);
    fireEvent.click(screen.getByText('Paste'));
    expect(onClick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not render a shortcut on a submenu parent (shows the ▶ arrow instead)', () => {
    const items: ContextMenuItem[] = [{ label: 'Create', shortcut: 'should-not-show', children: [{ label: 'Empty', onClick: vi.fn() }] }];
    render(<ContextMenu items={items} x={0} y={0} onClose={vi.fn()} />);
    expect(screen.getByText('Create')).toBeTruthy();
    expect(screen.queryByText('should-not-show')).toBeNull();
  });

  // #651 — the menu is `position: fixed; width: auto`, so measuring it while it sits at the
  // requested click point makes it shrink-to-fit the viewport remainder to the right of that
  // point, reading the AVAILABLE width as if it were the menu's natural width (jsdom can't see
  // this itself — every rect is 0x0 there — so this asserts the seed the real bug depends on:
  // the element must be measured at the origin, not at (x, y)).
  it('measures the menu at the origin, not at the requested (x, y)', () => {
    const items: ContextMenuItem[] = [{ label: 'Copy Component Values' }, { label: 'Paste Component Values' }];
    let leftAtMeasureTime: string | undefined;
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (leftAtMeasureTime === undefined && this.classList.contains('context-menu')) {
        leftAtMeasureTime = this.style.left;
      }
      return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    // A spy on HTMLElement.prototype outlives this test if left unrestored on a failed
    // assertion — every later element in the file would then measure 0x0, turning one real
    // failure into a whole file of bogus ones. Restore is unconditional.
    try {
      render(<ContextMenu items={items} x={1380} y={100} onClose={vi.fn()} />);
      expect(leftAtMeasureTime).toBe('0px');
    } finally { rectSpy.mockRestore(); }
  });

  it('is visible once the post-measurement clamp has run (the hidden seed itself is not observable here — see comment below)', () => {
    const items: ContextMenuItem[] = [{ label: 'Copy Component Values' }];
    const { container } = render(<ContextMenu items={items} x={1380} y={100} onClose={vi.fn()} />);
    // ⚠️ This proves NOTHING about the hidden seed, in either direction. `useLayoutEffect`
    // flushes synchronously inside RTL's act()-wrapped render(), so by the time anything here
    // can read `visibility` the clamp has already run — "seeded hidden, then shown" and "seeded
    // visible, never touched" are indistinguishable from this assertion. What it DOES pin is the
    // end state: the menu is not left stranded hidden if the clamp throws or bails. The seed
    // itself is only observable from the spy test above, which reads it mid-measurement.
    const menu = container.querySelector('.context-menu') as HTMLElement;
    expect(menu.style.visibility).toBe('visible');
  });
});
