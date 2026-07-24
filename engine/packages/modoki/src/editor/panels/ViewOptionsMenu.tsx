/** A "View ▾" dropdown of independent checkbox toggles, extracted from SceneView.tsx so it's
 *  unit-testable without the giant panel around it (mirrors why `treeChrome.tsx`'s
 *  `TypeFilterMenu` lives in its own file). Used by SceneView's toolbar to consolidate the
 *  FX/Grid/Colliders (3D) and FX/Focus/Colliders (2D) view-options that used to be separate
 *  always-visible buttons — same dropdown chrome as `TypeFilterMenu`, but each row here is an
 *  independent on/off switch rather than an AND-combined filter set. */

import { useEffect, useRef, useState } from 'react';
import { useOverlayEscape } from '../input/useOverlayEscape';

export interface ViewOption {
  key: string;
  label: string;
  checked: boolean;
  onToggle: () => void;
  title?: string;
  uiId: string;
}

/** One checkable row inside {@link ViewOptionsMenu}. */
function ViewOptionItem({ label, checked, onToggle, title, uiId }: ViewOption) {
  return (
    <label title={title} data-ui-id={uiId} data-ui-kind="toggle" data-ui-label={label}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', cursor: 'pointer', fontSize: 11, color: '#ddd', borderRadius: 3, userSelect: 'none' }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a2a40'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} style={{ margin: 0, cursor: 'pointer' }} />
      <span style={{ flex: 1 }}>{label}</span>
    </label>
  );
}

/** Self-contained: closes on outside-click or Escape (`useOverlayEscape`), and renders its own
 *  leading divider so callers just drop it into a toolbar. The trigger shows a `(N)` badge for
 *  how many items are currently checked. */
export function ViewOptionsMenu({ items, uiId }: { items: ViewOption[]; uiId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => { document.removeEventListener('mousedown', onDoc); };
  }, [open]);
  useOverlayEscape(open, () => setOpen(false), 'sceneview-view-options');

  const activeCount = items.filter((i) => i.checked).length;
  return (
    <>
      <div style={{ width: 1, height: 18, background: '#444', margin: '0 6px' }} />
      <div ref={ref} style={{ position: 'relative' }}>
        <button onClick={() => setOpen((o) => !o)} title="View options" data-ui-id={uiId} data-ui-kind="menu" data-ui-label="View options"
          style={{
            height: 24, padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4,
            background: activeCount ? '#1e2630' : 'none',
            border: `1px solid ${activeCount ? '#5a9fd4' : '#444'}`,
            borderRadius: 3, color: activeCount ? '#5a9fd4' : '#666', fontSize: '10px',
            cursor: 'pointer', fontWeight: 'bold', fontFamily: 'monospace', lineHeight: 1,
          }}>View{activeCount ? ` (${activeCount})` : ''} <span style={{ fontSize: 8, opacity: 0.7 }}>▾</span></button>
        {open && (
          <div style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 3, zIndex: 1000,
            background: '#1e1e30', border: '1px solid #555', borderRadius: 4, padding: 4,
            minWidth: 170, boxShadow: '0 4px 12px rgba(0,0,0,0.45)',
          }}>
            {items.map(({ key, ...it }) => (
              <ViewOptionItem key={key} {...it} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
