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
});
