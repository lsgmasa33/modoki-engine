/** "Bind Animator" picker — shown from the Animation panel's "No Animator bound"
 *  warning. Lists every entity in the scene as a collapsible tree (mirroring the
 *  Hierarchy); picking one binds the open clip to it, adding the `Animator`
 *  component when that entity doesn't have one yet.
 *
 *  Deliberately lists ALL entities, not just those that already carry an Animator:
 *  the whole point is that a fresh clip has no Animator anywhere to bind to.
 *  Entities that DO have one are badged so re-using an existing Animator (which
 *  just appends to its clip bank) is the obvious choice when it exists. */

import { useMemo, useState } from 'react';
import { getAllEntities, type EntityInfo } from '../../../runtime/ecs/entityUtils';

export interface BindEntityRow {
  id: number;
  name: string;
  /** Indent level; 0 while filtering (the filtered list is flat). */
  depth: number;
  hasAnimator: boolean;
  hasChildren: boolean;
}

const entityLabel = (e: EntityInfo) => e.name || `Entity ${e.id}`;

/** Flatten the entity hierarchy into pickable rows. With a `filter` the result is a
 *  flat, name-sorted list of matches (no tree, so a deep match is never hidden behind
 *  a collapsed parent); otherwise it's the tree, honoring `expanded`. Resource
 *  singletons are excluded — they're not scene objects and can't host an Animator. */
export function buildEntityRows(entities: EntityInfo[], filter: string, expanded: Set<number>): BindEntityRow[] {
  const f = filter.trim().toLowerCase();
  const usable = entities.filter((e) => !e.isResource);
  const row = (e: EntityInfo, depth: number, hasChildren: boolean): BindEntityRow => ({
    id: e.id, name: entityLabel(e), depth, hasAnimator: e.traits.includes('Animator'), hasChildren,
  });

  if (f) {
    return usable
      .filter((e) => entityLabel(e).toLowerCase().includes(f))
      .sort((a, b) => entityLabel(a).localeCompare(entityLabel(b)))
      .map((e) => row(e, 0, false));
  }

  const byId = new Map(usable.map((e) => [e.id, e]));
  const kids = new Map<number, EntityInfo[]>();
  for (const e of usable) {
    // An entity whose parent was filtered out (or never existed) is shown as a root
    // rather than dropped — nothing in the scene should be unreachable in this list.
    const p = byId.has(e.parentId) ? e.parentId : 0;
    const arr = kids.get(p) ?? [];
    arr.push(e);
    kids.set(p, arr);
  }
  for (const arr of kids.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder || entityLabel(a).localeCompare(entityLabel(b)));

  const out: BindEntityRow[] = [];
  const seen = new Set<number>(); // parent cycles can't hang the picker
  const walk = (parent: number, depth: number) => {
    for (const e of kids.get(parent) ?? []) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const children = kids.get(e.id) ?? [];
      out.push(row(e, depth, children.length > 0));
      if (children.length && expanded.has(e.id)) walk(e.id, depth + 1);
    }
  };
  walk(0, 0);
  return out;
}

export default function BindAnimatorPicker({ clipName, onBind, onClose }: {
  /** Shown in the header so it's clear WHICH clip is being bound. */
  clipName: string;
  onBind: (entityId: number) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Snapshot the scene once — the list is a modal picker, not a live view, and
  // getAllEntities() walks every trait of every entity.
  const entities = useMemo(() => getAllEntities(), []);
  // Start fully expanded: the entity you want may be nested, and a picker that
  // opens collapsed makes the fix look unavailable.
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(entities.map((e) => e.id)));

  const rows = useMemo(() => buildEntityRows(entities, filter, expanded), [entities, filter, expanded]);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  const toggle = (id: number) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div style={overlay} onClick={onClose}>
      <div style={popover} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ color: '#7aa2f7', fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Bind “{clipName}”</span>
          <span style={{ flex: 1 }} />
          <button style={btn} onClick={onClose}>×</button>
        </div>
        <div style={{ color: '#889', fontSize: 11, marginBottom: 6 }}>
          Pick the entity this clip animates. It becomes the clip’s binding root — tracks
          address it and its children. An <b style={{ color: '#aab' }}>Animator</b> component is added if it
          doesn’t have one, and the clip is added to its clip list.
        </div>
        <input autoFocus placeholder="Filter entities…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ ...input, marginBottom: 6 }} />
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', border: '1px solid #2a2a40', borderRadius: 4 }}>
          {rows.length === 0 && (
            <div style={{ color: '#667', fontSize: 11, padding: 8 }}>No entities{filter ? ' match' : ' in this scene'}.</div>
          )}
          {rows.map((r) => {
            const isSel = selectedId === r.id;
            const isOpen = expanded.has(r.id);
            return (
              <div
                key={r.id}
                data-bind-entity-id={r.id}
                onClick={() => setSelectedId(r.id)}
                onDoubleClick={() => onBind(r.id)}
                title={r.hasAnimator ? 'Has an Animator — the clip is added to its clip list' : 'No Animator — one is added when you bind'}
                style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '2px 6px', paddingLeft: 6 + r.depth * 12, cursor: 'pointer', background: isSel ? '#2a2a40' : 'transparent', color: isSel ? '#cdd' : '#aab', fontSize: 11, userSelect: 'none', whiteSpace: 'nowrap' }}
                onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = '#1d1d2c'; }}
                onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
              >
                <span
                  onClick={(e) => { e.stopPropagation(); if (r.hasChildren) toggle(r.id); }}
                  style={{ display: 'inline-block', width: 10, color: '#667', cursor: r.hasChildren ? 'pointer' : 'default' }}
                >{r.hasChildren ? (isOpen ? '▾' : '▸') : ''}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
                {r.hasAnimator && <span style={{ color: '#6a9a6a', fontSize: 9, marginLeft: 'auto', paddingLeft: 6 }}>Animator</span>}
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <span style={{ color: '#889', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selected ? (selected.hasAnimator ? `→ ${selected.name}` : `→ ${selected.name} (+ Animator)`) : 'No entity selected'}
          </span>
          <span style={{ flex: 1 }} />
          <button
            data-ui-id="animation.bindAnimator.confirm" data-ui-kind="button" data-ui-label="bind"
            style={{ ...btn, opacity: selected ? 1 : 0.4, cursor: selected ? 'pointer' : 'default' }}
            disabled={!selected}
            onClick={() => { if (selected) onBind(selected.id); }}
          >Bind</button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' };
const popover: React.CSSProperties = { width: 420, height: '60vh', display: 'flex', flexDirection: 'column', background: '#15151f', border: '1px solid #3a3a5a', borderRadius: 5, padding: 10, fontFamily: 'monospace', fontSize: 12, color: '#ccc', boxShadow: '0 6px 24px rgba(0,0,0,0.6)' };
const input: React.CSSProperties = { background: '#0e0e16', color: '#ddd', border: '1px solid #333', borderRadius: 3, padding: '3px 6px', fontFamily: 'monospace', fontSize: 12 };
const btn: React.CSSProperties = { background: '#2a2a40', color: '#ccc', border: '1px solid #444', borderRadius: 3, padding: '2px 10px', cursor: 'pointer' };
