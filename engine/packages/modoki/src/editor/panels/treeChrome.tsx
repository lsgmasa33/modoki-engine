import React, { useState, useEffect, useRef } from 'react';

/** Shared chrome for the Assets-panel trees so the three top-level sections
 *  (Assets, Scripts, Engine) read as one consistent tree — an identical header
 *  bar whether a section comes from the asset manifest (FolderView) or the
 *  source-file walk (ScriptTree). Row indentation matches too: every tree pads a
 *  row at `depth` by `treeRowPadLeft(depth)`. */

/** Left padding (px) for a tree row at `depth`. The one place this constant
 *  lives — FolderView, ScriptTree, and the read-only Engine tree all use it, so
 *  their rows indent identically. Depth 0 = directly under a SectionHeader. */
export const treeRowPadLeft = (depth: number): number => 8 + depth * 14;

/** A collapsible FOLDER row (caret · 📁 · name · optional count) shared by the
 *  read-only trees (ScriptTree, Engine section). FolderView is the interactive
 *  superset (drag/drop, rename, per-folder context menu) and stays separate, but
 *  it renders the same caret/📁/name/count so all three read alike. `onToggle`
 *  gets the event so callers can special-case Option/Alt-click (expand all). */
export function TreeFolderRow({ name, depth, open, count, onToggle }: {
  name: string;
  depth: number;
  open: boolean;
  count?: number;
  onToggle: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onClick={onToggle}
      style={{
        padding: '3px 8px', paddingLeft: treeRowPadLeft(depth), cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 4, background: '#2a2a40',
        userSelect: 'none', whiteSpace: 'nowrap',
      }}
    >
      <span style={{ color: '#888', fontSize: 10, width: 10, textAlign: 'center' }}>{open ? '▼' : '▶'}</span>
      <span style={{ color: '#f0c040', fontSize: 11 }}>📁</span>
      <span style={{ color: '#ddd' }}>{name}</span>
      {count != null && <span style={{ color: '#555', fontSize: 10, marginLeft: 2 }}>({count})</span>}
    </div>
  );
}

/** Bare-metal toolbar button style — matches the Assets panel's toolbarBtnStyle
 *  so a TypeFilterMenu reads identically in every panel that hosts it. */
const treeToolbarBtnStyle: React.CSSProperties = {
  background: 'none', border: '1px solid #555', borderRadius: 3,
  cursor: 'pointer', color: '#ccc', padding: '1px 5px', fontSize: '12px', lineHeight: 1,
};

/** One row inside the TypeFilterMenu dropdown. */
const typeMenuRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px',
  cursor: 'pointer', fontSize: 11, color: '#ddd', borderRadius: 3, userSelect: 'none',
};

/** The shared "Search…" text input used by the Assets AND Hierarchy panel headers.
 *  A thin styled `<input>` — callers own the filter state. */
export function TreeSearchInput({ value, onChange, placeholder = 'Search...', title, uiId }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  title?: string;
  /** Agent addressing (Enact). Shared by two panels, so the CALLER owns the id
   *  (`hierarchy.toolbar.search` / `assets.toolbar.search`) — a hardcoded one here would
   *  collide the moment both panels are mounted, which is always. */
  uiId?: string;
}) {
  return (
    <input
      type="text" placeholder={placeholder} value={value} title={title}
      data-ui-id={uiId} data-ui-kind={uiId ? 'field' : undefined} data-ui-label={uiId ? placeholder : undefined}
      onChange={(e) => onChange(e.target.value)}
      style={{ flex: '1 1 110px', minWidth: 90, background: '#1e1e30', color: '#ddd', border: '1px solid #444', borderRadius: 2, padding: '2px 6px', fontSize: '10px', fontFamily: 'monospace', outline: 'none' }}
    />
  );
}

/** One checkable type row in the dropdown. Extracted so the flat and grouped
 *  layouts render identical rows (only the left indent differs). */
function TypeFilterRow({ type, count, checked, onToggle, indent = false }: {
  type: string; count: number; checked: boolean; onToggle: () => void; indent?: boolean;
}) {
  return (
    <label
      style={{ ...typeMenuRowStyle, ...(indent ? { paddingLeft: 20 } : null) }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a2a40'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} style={{ margin: 0, cursor: 'pointer' }} />
      <span style={{ flex: 1, textTransform: 'capitalize' }}>{type}</span>
      <span style={{ opacity: 0.5 }}>{count}</span>
    </label>
  );
}

/** A "Type ▾" dropdown filter shared by the Assets and Hierarchy panels: a
 *  checklist of the types present (each with a count), AND-combined by the caller.
 *  `types` is `[type, count][]` (already sorted); `selected` is the active set
 *  (empty = "All types"). Self-contained — closes on outside-click / Escape.
 *
 *  Optional GROUPING: pass `groupBy` (type → category label) to render the rows
 *  under collapsible category headers, ordered by `groupOrder` then alphabetically.
 *  Category collapse state persists under `groupCollapseKey` (localStorage). Omit
 *  `groupBy` for the flat list (Assets — asset types have no such taxonomy). */
export function TypeFilterMenu({ types, selected, onToggle, onClear, label = 'Type', title = 'Filter by type', groupBy, groupOrder = [], groupCollapseKey, uiId }: {
  types: [string, number][];
  selected: Set<string>;
  onToggle: (type: string) => void;
  onClear: () => void;
  label?: string;
  title?: string;
  groupBy?: (type: string) => string;
  groupOrder?: string[];
  groupCollapseKey?: string;
  /** Agent addressing (Enact) for the dropdown TRIGGER — caller-owned, see TreeSearchInput. */
  uiId?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Collapsed category set (membership = collapsed → default all expanded), persisted.
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(() => {
    if (!groupCollapseKey) return new Set();
    try { const r = localStorage.getItem(groupCollapseKey); const a = r ? JSON.parse(r) : []; return new Set(Array.isArray(a) ? a : []); } catch { return new Set(); }
  });
  useEffect(() => {
    if (!groupCollapseKey) return;
    try { localStorage.setItem(groupCollapseKey, JSON.stringify([...collapsedCats])); } catch { /* ignore */ }
  }, [groupCollapseKey, collapsedCats]);
  const toggleCat = (cat: string) => setCollapsedCats((prev) => {
    const next = new Set(prev); if (next.has(cat)) next.delete(cat); else next.add(cat); return next;
  });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // Bucket types by category (preserving each bucket's incoming order), then order
  // the buckets by groupOrder, appending any unknown categories alphabetically.
  const groups = groupBy
    ? (() => {
        const m = new Map<string, [string, number][]>();
        for (const t of types) { const c = groupBy(t[0]); (m.get(c) ?? m.set(c, []).get(c)!).push(t); }
        const known = groupOrder.filter((c) => m.has(c));
        const extra = [...m.keys()].filter((c) => !groupOrder.includes(c)).sort();
        return [...known, ...extra].map((c) => [c, m.get(c)!] as [string, [string, number][]]);
      })()
    : null;

  const active = selected.size > 0;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={title}
        data-ui-id={uiId} data-ui-kind={uiId ? 'menu' : undefined} data-ui-label={uiId ? title : undefined}
        style={{
          ...treeToolbarBtnStyle, width: 'auto', padding: '0 6px', fontSize: 10,
          display: 'flex', alignItems: 'center', gap: 4,
          // Override the full `border` shorthand (NOT just borderColor) — mixing
          // the shorthand from treeToolbarBtnStyle with a borderColor longhand trips
          // React's "shorthand/non-shorthand conflict" warning when `active` flips.
          ...(active ? { border: '1px solid #5a8ec5', color: '#fff' } : null),
        }}
      >
        <span>{label}{active ? ` (${selected.size})` : ''}</span>
        <span style={{ fontSize: 8, opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            // Right-anchored: these panels are narrow and the Type button sits near
            // the right edge, so opening leftward keeps the menu inside the panel
            // instead of clipping past its right border.
            position: 'absolute', top: '100%', right: 0, marginTop: 3, zIndex: 1000,
            background: '#1e1e30', border: '1px solid #555', borderRadius: 4, padding: 4,
            minWidth: 150, maxHeight: 340, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.45)',
          }}
        >
          <label
            style={{ ...typeMenuRowStyle, borderBottom: '1px solid #333', paddingBottom: 5, marginBottom: 3 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a2a40'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            <input type="checkbox" checked={!active} onChange={onClear} style={{ margin: 0, cursor: 'pointer' }} />
            <span style={{ flex: 1, color: '#bbb' }}>All types</span>
          </label>
          {groups
            ? groups.map(([cat, entries]) => {
                const catOpen = !collapsedCats.has(cat);
                return (
                  <div key={cat}>
                    <div
                      onClick={() => toggleCat(cat)}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px', cursor: 'pointer', userSelect: 'none' }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a2a40'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                    >
                      <span style={{ color: '#888', fontSize: 9, width: 9, textAlign: 'center' }}>{catOpen ? '▼' : '▶'}</span>
                      <span style={{ flex: 1, color: '#9ab', fontSize: 10, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 0.3 }}>{cat}</span>
                      <span style={{ opacity: 0.4, fontSize: 10 }}>{entries.length}</span>
                    </div>
                    {catOpen && entries.map(([type, count]) => (
                      <TypeFilterRow key={type} type={type} count={count} checked={selected.has(type)} onToggle={() => onToggle(type)} indent />
                    ))}
                  </div>
                );
              })
            : types.map(([type, count]) => (
                <TypeFilterRow key={type} type={type} count={count} checked={selected.has(type)} onToggle={() => onToggle(type)} />
              ))}
        </div>
      )}
    </div>
  );
}

/** A collapsible top-level section header (Assets / Scripts / Engine) — the
 *  consistent bar that distinguishes a section from the folder rows beneath it. */
export function SectionHeader({ label, count, open, onToggle, tag, onContextMenu }: {
  label: string;
  count?: number;
  open: boolean;
  /** Receives the click so callers can special-case Option/Alt-click (expand all). */
  onToggle: (e: React.MouseEvent) => void;
  /** Optional trailing note, e.g. "read-only". */
  tag?: string;
  /** Optional right-click handler (e.g. the Assets header's create-at-root menu). */
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onClick={onToggle}
      onContextMenu={onContextMenu}
      style={{
        padding: '4px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
        background: '#2a2a40', borderBottom: '1px solid #333', userSelect: 'none',
      }}
    >
      <span style={{ color: '#888', fontSize: 10, width: 10, textAlign: 'center' }}>{open ? '▼' : '▶'}</span>
      <span style={{ fontWeight: 'bold', color: '#ddd' }}>{label}</span>
      {count != null && <span style={{ color: '#555', marginLeft: 4 }}>({count})</span>}
      {tag && <span style={{ color: '#666', fontSize: 10, marginLeft: 4 }}>{tag}</span>}
    </div>
  );
}
