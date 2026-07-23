/** Add Component picker — a searchable popup (modelled on the Assets/Hierarchy
 *  TreeSearchInput) that replaces the old native <select>. The native select's
 *  option popup is a separate OS layer `sendInputEvent` can't drive; this DOM
 *  popup is fully agent-driveable (search field + one addressable row per trait).
 *
 *  The filter/group logic is the pure exported `filterAndGroupAddable` (unit-tested
 *  in tests/editor/addComponentPicker.test.ts) — the component only renders it. */

import { useState, useEffect, useMemo, useRef } from 'react';
import { type TraitMeta, COMPONENT_CATEGORY_ORDER } from '../../runtime/ecs/traitRegistry';
import { addTraitToEntitiesWithUndo, pasteTraitAsNewWithUndo } from '../undo/entityActions';
import { type TraitClipboardEntry } from './traitClipboard';
import { inputStyle } from './fields';
import { useOverlayEscape } from '../input/useOverlayEscape';

/** Filter `addable` by a case-insensitive name substring, then bucket by
 *  `componentCategory` (default 'Misc'). Categories are ordered by the fixed
 *  COMPONENT_CATEGORY_ORDER, with any extras appended alphabetically; traits are
 *  sorted by name within each bucket. Empty/whitespace query = no filter. Returns
 *  `[category, traits][]` in render order (buckets with no matches are dropped). */
export function filterAndGroupAddable(addable: TraitMeta[], query: string): [string, TraitMeta[]][] {
  const q = query.trim().toLowerCase();
  const matched = q ? addable.filter(t => t.name.toLowerCase().includes(q)) : addable;
  const groups = new Map<string, TraitMeta[]>();
  for (const t of matched) {
    const cat = t.componentCategory ?? 'Misc';
    (groups.get(cat) ?? groups.set(cat, []).get(cat)!).push(t);
  }
  const cats = [
    ...COMPONENT_CATEGORY_ORDER.filter(c => groups.has(c)),
    ...Array.from(groups.keys()).filter(c => !COMPONENT_CATEGORY_ORDER.includes(c)).sort(),
  ];
  return cats.map(c => [c, groups.get(c)!.slice().sort((a, b) => a.name.localeCompare(b.name))]);
}

export function AddComponentPicker({ addable, selectedIds, clipboard }: {
  addable: TraitMeta[];
  selectedIds: number[];
  clipboard: TraitClipboardEntry | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // "Paste As New" lives here rather than in a section's ⋮ menu: the trait it adds
  // doesn't exist on the entity yet, so it has no header to hang off — and it IS an
  // add-component action, just prefilled.
  const pasteNewMeta = clipboard ? addable.find(t => t.name === clipboard.traitName) : undefined;

  const orderedGroups = useMemo(() => filterAndGroupAddable(addable, query), [addable, query]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => { document.removeEventListener('mousedown', onDoc); };
  }, [open]);
  useOverlayEscape(open, () => setOpen(false), 'add-component');

  const add = (meta: TraitMeta) => {
    // Adds to every selected entity that doesn't already have it (single-select is
    // just the one), as a single undo entry.
    addTraitToEntitiesWithUndo(selectedIds, meta);
    setOpen(false);
    setQuery('');
  };

  if (addable.length === 0) return null;
  return (
    <div ref={ref} style={{ position: 'relative', padding: '6px 8px', borderBottom: '1px solid #333' }}>
      <button
        onClick={() => setOpen(o => !o)}
        data-ui-id="inspector.addComponent.trigger"
        data-ui-kind="menu"
        data-ui-label="add component"
        style={{ ...inputStyle, width: '100%', color: '#888', cursor: 'pointer', textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span>Add Component...</span>
        <span style={{ fontSize: 8, opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 8, right: 8, marginTop: 3, zIndex: 1000,
            background: '#1e1e30', border: '1px solid #555', borderRadius: 4, padding: 4,
            maxHeight: 340, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.45)',
          }}
        >
          <input
            ref={inputRef}
            type="text" placeholder="Search..." value={query}
            data-ui-id="inspector.addComponent.search" data-ui-kind="field" data-ui-label="search components"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter adds the single match — fast keyboard flow.
              if (e.key === 'Enter') {
                const only = orderedGroups.flatMap(([, list]) => list);
                if (only.length === 1) add(only[0]);
              }
            }}
            style={{ width: '100%', boxSizing: 'border-box', marginBottom: 4, background: '#12121e', color: '#ddd', border: '1px solid #444', borderRadius: 2, padding: '3px 6px', fontSize: '11px', fontFamily: 'monospace', outline: 'none' }}
          />
          {orderedGroups.length === 0 && (
            <div style={{ padding: '6px 8px', fontSize: '11px', color: '#777' }}>No matching components</div>
          )}
          {orderedGroups.map(([cat, list]) => (
            <div key={cat}>
              <div style={{ padding: '4px 6px 2px', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6a8ec5' }}>{cat}</div>
              {list.map(t => (
                <div
                  key={t.name}
                  onClick={() => add(t)}
                  data-ui-id={`inspector.addComponent.item.${t.name}`}
                  data-ui-kind="menuitem"
                  data-ui-label={t.name}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a2a40'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                  style={{ padding: '3px 6px 3px 12px', fontSize: '11px', color: '#ddd', cursor: 'pointer', borderRadius: 2 }}
                >
                  {t.name}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {pasteNewMeta && (
        <button
          onClick={() => pasteTraitAsNewWithUndo(selectedIds, pasteNewMeta, clipboard!.values)}
          title={`Add ${pasteNewMeta.name} with the copied values`}
          data-ui-id="inspector.addComponent.pasteAsNew"
          data-ui-kind="button"
          data-ui-label={`paste ${pasteNewMeta.name} as new`}
          style={{ ...inputStyle, width: '100%', marginTop: 4, color: '#ccc', cursor: 'pointer', textAlign: 'center' }}
        >
          Paste {pasteNewMeta.name} as New
        </button>
      )}
    </div>
  );
}
