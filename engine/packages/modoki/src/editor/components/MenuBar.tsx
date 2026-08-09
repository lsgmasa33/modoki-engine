/** Shared menu bar component used by EditorApp and GameView. */

import { useState, useEffect } from 'react';
import type React from 'react';

export interface BarMenuItem {
  label: string;
  shortcut?: string;
  action?: () => void;
  checked?: boolean;
  separator?: boolean;
  disabled?: boolean;
  /** Nested items, ONE level deep (a submenu item's own `submenu` is ignored here and by the
   *  Electron mirror). One level is what the Build menu's device pickers need, and a deeper tree
   *  in a 12px monospace flyout is unusable long before it is useful. An item with a submenu may
   *  still carry its own `action` — the OS menu makes a parent unclickable, so anything that must
   *  stay reachable belongs INSIDE the submenu too. */
  submenu?: BarMenuItem[];
}

const rowStyle = (disabled?: boolean): React.CSSProperties => ({
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  width: '100%', padding: '6px 16px', border: 'none', background: 'transparent',
  color: disabled ? '#555' : '#ccc', cursor: disabled ? 'default' : 'pointer',
  fontSize: '12px', fontFamily: 'monospace', textAlign: 'left',
});

/** The check/blank gutter. A `checked` item reserves the column either way so a list of
 *  radio-ish rows (the Build menu's device pickers) doesn't shift horizontally as the
 *  selection moves. */
const gutter = (item: BarMenuItem) => (item.checked !== undefined ? (item.checked ? '✓ ' : '   ') : '');

/** One dropdown row. Own component because a row with a `submenu` carries hover state, and
 *  hooks can't live inside the items `.map`. */
function MenuRow({ item, onPick }: { item: BarMenuItem; onPick: () => void }) {
  const [openSub, setOpenSub] = useState(false);
  const sub = item.submenu;

  // The flyout is anchored to the ROW and hangs off the panel's right edge; the wrapper keeps
  // hover alive while the pointer crosses the gap between the two.
  return (
    <div
      style={{ position: 'relative' }}
      // `!item.disabled` mirrors the click guard below. Without it a DISABLED parent still opened
      // its flyout on hover, handing the user the actionable rows inside an item the host had
      // deliberately turned off. Unreachable today (the only disabled+submenu item is the iOS one,
      // and its `iosUnavailable` gate needs the Electron preload — which is exactly when this
      // component is NOT mounted), so this is a guard against the next registrant, not a fix for a
      // live bug.
      onMouseEnter={() => sub && !item.disabled && setOpenSub(true)}
      onMouseLeave={() => setOpenSub(false)}
    >
      <button
        disabled={item.disabled}
        onClick={() => {
          if (item.disabled) return;
          // A parent row opens its submenu rather than firing — matching the OS menu, where a
          // submenu parent is not clickable at all. Without a submenu it acts and closes.
          if (sub) { setOpenSub(true); return; }
          item.action?.();
          onPick();
        }}
        style={rowStyle(item.disabled)}
        onMouseEnter={(e) => { if (!item.disabled) e.currentTarget.style.background = '#3a3a5c'; }}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        <span>{gutter(item)}{item.label}</span>
        {sub ? <span style={{ color: '#666', marginLeft: 20 }}>▸</span>
          : item.shortcut && <span style={{ color: '#666', marginLeft: 20 }}>{item.shortcut}</span>}
      </button>

      {sub && openSub && (
        <div
          style={{
            position: 'absolute', top: 0, left: '100%', zIndex: 1001,
            background: '#2a2a40', border: '1px solid #444', borderRadius: 4,
            minWidth: 220, padding: '4px 0', boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          }}
        >
          {sub.map((s, i) => (
            s.separator
              ? <div key={i} style={{ height: 1, background: '#444', margin: '4px 8px' }} />
              : (
                <button
                  // Keyed by INDEX, not label: these rows are DEVICE NAMES now, which the user
                  // owns and which repeat — two iPhones both left as "iPhone" on the same iOS
                  // version render byte-identical labels, and a duplicate React key makes the
                  // second row share the first's identity (its hover state, and whatever a
                  // future row gains). The list is rebuilt wholesale on every change anyway, so
                  // index identity costs nothing here.
                  key={i}
                  disabled={s.disabled}
                  onClick={() => { if (!s.disabled) { s.action?.(); setOpenSub(false); onPick(); } }}
                  style={rowStyle(s.disabled)}
                  onMouseEnter={(e) => { if (!s.disabled) e.currentTarget.style.background = '#3a3a5c'; }}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span>{gutter(s)}{s.label}</span>
                  {s.shortcut && <span style={{ color: '#666', marginLeft: 20 }}>{s.shortcut}</span>}
                </button>
              )
          ))}
        </div>
      )}
    </div>
  );
}

export default function MenuBar({ menus, title }: { menus: Record<string, BarMenuItem[]>; title?: string }) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  // Close menu when clicking outside
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [openMenu]);

  return (
    <>
      {title && <span style={{ color: '#f1c40f', fontWeight: 'bold', marginRight: 12, padding: '0 8px' }}>{title}</span>}

      {Object.entries(menus).map(([name, items]) => (
        <div key={name} style={{ position: 'relative' }}>
          <button
            onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === name ? null : name); }}
            onMouseEnter={() => { if (openMenu && openMenu !== name) setOpenMenu(name); }}
            style={{
              padding: '4px 10px', border: 'none', borderRadius: 2, cursor: 'pointer',
              fontSize: '12px', fontFamily: 'monospace',
              background: openMenu === name ? '#3a3a5c' : 'transparent',
              color: openMenu === name ? '#fff' : '#aaa',
            }}
          >
            {name}
          </button>

          {openMenu === name && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute', top: '100%', left: 0, zIndex: 1000,
                background: '#2a2a40', border: '1px solid #444', borderRadius: 4,
                minWidth: 200, padding: '4px 0', boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
              }}
            >
              {items.map((item, i) => (
                item.separator
                  ? <div key={i} style={{ height: 1, background: '#444', margin: '4px 8px' }} />
                  // Index, not label — `MenuRow` holds submenu-open state, so two rows sharing a
                  // key would share that state (see the submenu rows below for the duplicate-label
                  // case this protects against).
                  : <MenuRow key={i} item={item} onPick={() => setOpenMenu(null)} />
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
