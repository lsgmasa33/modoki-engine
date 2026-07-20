import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface ContextMenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  children?: ContextMenuItem[];  // submenu items
  /** Render a horizontal divider instead of a clickable row (label ignored). */
  separator?: boolean;
  /** Right-aligned shortcut hint (e.g. "⌘D"). Purely visual — the actual
   *  keybinding lives in the panel's keydown handler. */
  shortcut?: string;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}

/** Clamp a menu of measured size `w`×`h` to a `vw`×`vh` viewport, preferring to
 *  open at (`x`,`y`). Shifts left/up so the menu stays fully on-screen, never
 *  pushing the origin below the top-left margin. Pure so the overflow math (the
 *  F11 fix) is unit-testable without a DOM. (editor-panels F11.) */
export function clampMenuPosition(
  x: number, y: number, w: number, h: number, vw: number, vh: number, margin = 8,
): { left: number; top: number } {
  return {
    left: Math.max(margin, Math.min(x, vw - w - margin)),
    top: Math.max(margin, Math.min(y, vh - h - margin)),
  };
}

/** Position a submenu relative to its parent row. Opens to the right of the row
 *  by default, but flips to the left when it would overflow the right edge, and
 *  shifts up when it would overflow the bottom. (editor-panels F11.) */
export function clampSubmenuPosition(
  rowRect: { left: number; right: number; top: number },
  w: number, h: number, vw: number, vh: number, margin = 8,
): { left: number; top: number } {
  // Prefer right of the row; flip left if it would overflow the right edge.
  let left = rowRect.right - 4;
  if (left + w > vw - margin) left = rowRect.left + 4 - w;
  left = Math.max(margin, left);
  const top = Math.max(margin, Math.min(rowRect.top, vh - h - margin));
  return { left, top };
}

export default function ContextMenu({ items, x, y, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Start at the requested point; re-clamp once the real menu height is known.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Clamp using the REAL measured menu size (not an items.length * 28 estimate),
  // so tall menus near the bottom edge don't clip. Measured post-layout. (F11.)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(clampMenuPosition(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight));
  }, [x, y, items]);

  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: pos.left,
    top: pos.top,
    zIndex: 10000,
    background: '#2a2a40',
    border: '1px solid #444',
    borderRadius: 4,
    padding: '4px 0',
    minWidth: 160,
    boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
  };

  return (
    // `className` purely so `describeElement` can NAME this when it covers something: an
    // occluded handle reporting `covered by div.context-menu` is actionable, `covered by
    // div` is not. (The styling is all inline; this class selects nothing.)
    <div ref={ref} className="context-menu" style={menuStyle}>
      {items.map((item, i) => (
        <MenuItemRow key={i} item={item} onClose={onClose} />
      ))}
    </div>
  );
}

function MenuItemRow({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  const [subOpen, setSubOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  // Submenu position — seeded right of the row, re-clamped post-layout once the
  // real submenu size is known so it can flip left / shift up near an edge. (F11.)
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null);
  const hasChildren = item.children && item.children.length > 0;

  useLayoutEffect(() => {
    if (!subOpen) { setSubPos(null); return; }
    const row = rowRef.current;
    const sub = subRef.current;
    if (!row || !sub) return;
    const rowRect = row.getBoundingClientRect();
    const subRect = sub.getBoundingClientRect();
    setSubPos(clampSubmenuPosition(rowRect, subRect.width, subRect.height, window.innerWidth, window.innerHeight));
  }, [subOpen, item.children]);

  // Close the submenu on a short delay rather than instantly on mouseleave, so
  // the cursor has time to travel from the parent row across to the (fixed-
  // positioned, to-the-right) submenu without it vanishing mid-transit. Entering
  // either the row or the submenu cancels the pending close.
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => { if (closeTimer.current != null) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  const scheduleClose = () => { cancelClose(); closeTimer.current = window.setTimeout(() => setSubOpen(false), 180); };
  useEffect(() => cancelClose, []);

  if (item.separator) {
    return <div style={{ height: 1, margin: '4px 8px', background: '#444' }} />;
  }

  return (
    <div
      ref={rowRef}
      data-menu-item={item.label}
      // Agent addressing (Enact): `data-menu-item` predates the chrome-handle provider,
      // which walks `[data-ui-id]` only — so a row carrying just the former is invisible to
      // `modoki_handles`/`tap_handle`. Both are kept: existing tests/queries use the old
      // attribute. `item.label` is unique within one open menu, and `data-ui-disabled`
      // surfaces a greyed row as data (this <div> is not a <button>, so `disabled` has no
      // meaning here) — that is how "Paste Component Values" reports itself inert.
      data-ui-id={`contextmenu.item.${item.label}`}
      data-ui-kind="menu-item"
      data-ui-disabled={item.disabled ? 'true' : undefined}
      onClick={(e) => {
        e.stopPropagation();
        if (hasChildren || item.disabled) return;
        item.onClick?.();
        onClose();
      }}
      onMouseEnter={(e) => {
        if (!item.disabled) (e.currentTarget as HTMLDivElement).style.background = '#3a3a5c';
        if (hasChildren) { cancelClose(); setSubOpen(true); }
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = 'transparent';
        if (hasChildren) scheduleClose();
      }}
      style={{
        padding: '5px 14px',
        cursor: item.disabled ? 'default' : 'pointer',
        color: item.disabled ? '#555' : item.danger ? '#e74c3c' : '#ccc',
        background: 'transparent',
        fontSize: 13,
        position: 'relative',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      {item.label}
      {hasChildren && <span style={{ color: '#666', fontSize: 10, marginLeft: 8 }}>▶</span>}
      {!hasChildren && item.shortcut && (
        <span style={{ color: '#777', fontSize: 11, marginLeft: 16, letterSpacing: 0.5 }}>{item.shortcut}</span>
      )}
      {hasChildren && subOpen && (
        <div
          ref={subRef}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          style={{
          position: 'fixed',
          left: subPos?.left ?? 0,
          top: subPos?.top ?? 0,
          // Hidden for the first paint (before the clamp layout-effect runs) so a
          // submenu opening near an edge never flashes off-screen. (F11.)
          visibility: subPos ? 'visible' : 'hidden',
          zIndex: 10001,
          background: '#2a2a40',
          border: '1px solid #444',
          borderRadius: 4,
          padding: '4px 0',
          minWidth: 140,
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        }}>
          {item.children!.map((child, j) => (
            <MenuItemRow key={j} item={child} onClose={onClose} />
          ))}
        </div>
      )}
    </div>
  );
}
