/** Shared menu bar component used by EditorApp and GameView. */

import { useState, useEffect } from 'react';

export interface BarMenuItem {
  label: string;
  shortcut?: string;
  action?: () => void;
  checked?: boolean;
  separator?: boolean;
  disabled?: boolean;
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
                item.separator ? (
                  <div key={i} style={{ height: 1, background: '#444', margin: '4px 8px' }} />
                ) : (
                  <button
                    key={item.label}
                    disabled={item.disabled}
                    onClick={() => { if (!item.disabled) { item.action?.(); setOpenMenu(null); } }}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      width: '100%', padding: '6px 16px', border: 'none', background: 'transparent',
                      color: item.disabled ? '#555' : '#ccc', cursor: item.disabled ? 'default' : 'pointer',
                      fontSize: '12px', fontFamily: 'monospace', textAlign: 'left',
                    }}
                    onMouseEnter={(e) => { if (!item.disabled) e.currentTarget.style.background = '#3a3a5c'; }}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <span>{item.checked !== undefined ? (item.checked ? '✓ ' : '   ') : ''}{item.label}</span>
                    {item.shortcut && <span style={{ color: '#666', marginLeft: 20 }}>{item.shortcut}</span>}
                  </button>
                )
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
