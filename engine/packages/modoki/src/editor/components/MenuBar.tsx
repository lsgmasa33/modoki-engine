/** The in-window menu bar. Rendered ONLY by `EditorApp` (`EditorApp.tsx:765`), and only in the
 *  WEB editor — under Electron the OS-level menu replaces it, so nothing here is reachable there. */

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

  // Close menu when pressing outside.
  //
  // ⚠️ CAPTURE-phase `pointerdown` on `document` with a containment guard — not `click` on
  // `window`, and not bubble-phase `mousedown` either (#999/#1001).
  //
  // Two separate things defeat the simpler spellings, and `SceneView`'s 2D pick handler does BOTH
  // on the same event (`installScene2DInteraction`'s `onPointerDown`, on a successful pick):
  //   - `stopPropagation()` — so any DOCUMENT-level listener in the bubble phase never runs. That
  //     rules out bubble `mousedown`/`pointerdown`, which is what the editor's six other
  //     outside-dismisses use (`ContextMenu`, `ViewOptionsMenu`, `AddComponentPicker`,
  //     `DeviceConnectSection`, `treeChrome`, `rendering/DevicePicker` — all `document` + bubble
  //     `mousedown`, so ALL of them are starved the same way and none dismisses on a 2D pick.
  //     Pre-existing and deliberately not fixed here; raised in the close-out report instead.
  //   - `preventDefault()` — which SUPPRESSES the compatibility `mousedown` altogether, so there
  //     is no `mousedown` to hear even setting propagation aside.
  // And the UI-preview arbiter separately swallows the trailing `click` in the capture phase to
  // stop it re-selecting the UI root, which is what ruled out the original `click` on `window`.
  //
  // Capture-phase `pointerdown` on `document` runs BEFORE the canvas handler can stop anything,
  // and `pointerdown` is the raw event rather than a compatibility one, so `preventDefault` on it
  // cannot suppress what we are already listening to. It also covers touch and pen, which
  // `mousedown` only approximates.
  // ⚠️ Measured, not reasoned: an e2e that opens a menu and then clicks a 2D entity FAILED with
  // bubble `mousedown` and passes with this. The first version of this fix was `mousedown`.
  //
  // The guard is what makes the switch safe: without it, pressing the open menu's own button
  // would close on `pointerdown` and the button's `onClick` toggle would immediately REOPEN it,
  // breaking click-to-close. `stopPropagation` on the button/dropdown cannot help — those are
  // `onClick` handlers and never see this `pointerdown`. It keys off `[data-menubar-menu]` on the
  // existing per-menu wrapper rather than a ref on a new container element, because this
  // component returns a FRAGMENT into a flex row — wrapping it to hang a ref off would change
  // the toolbar's layout.
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: Event) => {
      if ((e.target as Element | null)?.closest?.('[data-menubar-menu]')) return;
      setOpenMenu(null);
    };
    document.addEventListener('pointerdown', onDown, { capture: true });
    return () => document.removeEventListener('pointerdown', onDown, { capture: true });
  }, [openMenu]);

  return (
    <>
      {title && <span style={{ color: '#f1c40f', fontWeight: 'bold', marginRight: 12, padding: '0 8px' }}>{title}</span>}

      {Object.entries(menus).map(([name, items]) => (
        <div key={name} data-menubar-menu style={{ position: 'relative' }}>
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
