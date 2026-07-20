/** "Add Property" popover — shows the Animator root's subtree as a collapsible
 *  entity tree (mirroring the scene graph). Click an entity to reveal its
 *  animatable fields; click a field to add a track. Already-tracked fields are
 *  hidden. Mirrors Unity's Add Property picker. */

import { useMemo, useState } from 'react';
import { getEntityTraits, readTraitData } from '../../../runtime/ecs/entityUtils';
import { relativeEntityPath, trackKey } from '../../animation/recording';
import { getAnimEntityIndex } from '../../animation/entityIndex';
import type { TrackValueType } from '../../../runtime/animation/types';
import type { FieldHint } from '../../../runtime/ecs/traitRegistry';

export interface PropertyCandidate {
  path: string;        // relative to root
  entityId: number;    // resolved target entity (for reading the current value)
  entityName: string;  // for display
  trait: string;
  field: string;
  type: TrackValueType;
  label: string;       // "Trait.field"
}

/** Traits that never make sense to keyframe. */
const EXCLUDED_TRAITS = new Set(['EntityAttributes', 'Animator', 'PrefabInstance', 'Persistent']);

/** Minimal shape of a MaterialInstance override for the picker (avoids a runtime import). */
type MaterialOverride = { target: string; kind?: string; source?: { type?: string } };

function fieldType(hint: FieldHint): TrackValueType | null {
  if (hint.type === 'number') return 'number';
  if (hint.type === 'color') return 'color';
  if (hint.type === 'boolean') return 'boolean';
  // Enum is animatable only with a STATIC option list — we store the option
  // index, which a dynamic optionsSource (e.g. uiActions) can't pin down.
  if (hint.type === 'enum' && hint.options && hint.options.length > 0) return 'enum';
  return null; // string / dynamic-enum not animatable
}

/** Compute every animatable property under `rootId`. */
export function collectCandidates(rootId: number): PropertyCandidate[] {
  const { byId } = getAnimEntityIndex();
  // Subtree = entities whose relative path from root resolves (root included).
  const out: PropertyCandidate[] = [];
  for (const e of byId.values()) {
    const path = relativeEntityPath(rootId, e.id, byId);
    if (path === null) continue; // not in subtree
    for (const meta of getEntityTraits(e.id)) {
      if (EXCLUDED_TRAITS.has(meta.name) || meta.category === 'tag') continue;
      for (const [field, hint] of Object.entries(meta.fields)) {
        if (hint.readOnly) continue;
        const type = fieldType(hint);
        if (!type) continue;
        out.push({ path, entityId: e.id, entityName: e.name || `Entity ${e.id}`, trait: meta.name, field, type, label: `${meta.name}.${field}` });
      }
      // MaterialInstance overrides aren't flat fields — expose each CONSTANT-source override's
      // value as a nested-path candidate (`overrides.i.source.value`). Only `constant` sources are
      // keyframeable: a time/store/curve source is procedurally driven and would fight the clip.
      if (meta.name === 'MaterialInstance') {
        const overrides = (readTraitData(e.id, meta)?.overrides ?? []) as MaterialOverride[];
        overrides.forEach((o, i) => {
          if (o?.source?.type !== 'constant') return;
          const type: TrackValueType = o.kind === 'prop' && (o.target === 'color' || o.target === 'emissive') ? 'color' : 'number';
          out.push({
            path, entityId: e.id, entityName: e.name || `Entity ${e.id}`, trait: 'MaterialInstance',
            field: `overrides.${i}.source.value`, type, label: `Material.${o.target || `override ${i}`}`,
          });
        });
      }
    }
  }
  return out;
}

/** An entity in the picker tree: its own animatable fields plus child entities.
 *  Branches with no fields anywhere in their subtree are pruned by the builder. */
export interface EntityNode {
  id: number;
  name: string;
  path: string;            // relative to root; '' for the root itself
  depth: number;           // 0 = root, for indentation
  fields: PropertyCandidate[];
  children: EntityNode[];
}

/** Build the entity subtree rooted at `rootId`, attaching each entity's
 *  still-addable fields (after `existing` + `filter`), and pruning any branch
 *  that has no matching field anywhere beneath it. */
export function buildPropertyTree(
  candidates: PropertyCandidate[],
  rootId: number,
  existing: Set<string>,
  filter: string,
): EntityNode[] {
  const f = filter.trim().toLowerCase();
  const { byId } = getAnimEntityIndex();

  // Fields per entity, filtered down to what's still addable + matches the query.
  const fieldsByEntity = new Map<number, PropertyCandidate[]>();
  for (const c of candidates) {
    if (existing.has(trackKey(c))) continue;
    if (f && !(`${c.entityName} ${c.path} ${c.label}`.toLowerCase().includes(f))) continue;
    const arr = fieldsByEntity.get(c.entityId) ?? [];
    arr.push(c);
    fieldsByEntity.set(c.entityId, arr);
  }

  // Child entity ids per parent, restricted to the root's subtree.
  const childIds = new Map<number, number[]>();
  for (const e of byId.values()) {
    if (e.id === rootId) continue;
    if (relativeEntityPath(rootId, e.id, byId) === null) continue; // outside subtree
    const arr = childIds.get(e.parentId) ?? [];
    arr.push(e.id);
    childIds.set(e.parentId, arr);
  }

  const build = (id: number, depth: number): EntityNode | null => {
    const info = byId.get(id);
    if (!info) return null;
    const children = (childIds.get(id) ?? [])
      .map((cid) => build(cid, depth + 1))
      .filter((n): n is EntityNode => n !== null);
    const fields = fieldsByEntity.get(id) ?? [];
    if (fields.length === 0 && children.length === 0) return null; // prune empty branch
    return {
      id,
      name: id === rootId ? (info.name || '(root)') : info.name || `Entity ${id}`,
      path: relativeEntityPath(rootId, id, byId) ?? '',
      depth,
      fields,
      children,
    };
  };

  const root = build(rootId, 0);
  return root ? [root] : [];
}

/** Flatten the (pruned) tree into the rows the left pane shows, honoring each
 *  node's open state. While filtering, every branch counts as open. */
function flattenVisible(tree: EntityNode[], expanded: Set<number>, filtering: boolean): EntityNode[] {
  const out: EntityNode[] = [];
  const walk = (nodes: EntityNode[]) => {
    for (const n of nodes) {
      out.push(n);
      if (filtering || expanded.has(n.id)) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/** Index every node by id so the right pane can read the selected entity's fields. */
function indexById(tree: EntityNode[]): Map<number, EntityNode> {
  const m = new Map<number, EntityNode>();
  const walk = (nodes: EntityNode[]) => nodes.forEach((n) => { m.set(n.id, n); walk(n.children); });
  walk(tree);
  return m;
}

/** Stable id for a candidate across the checkbox selection (path is unique per entity). */
const candKey = (c: PropertyCandidate) => trackKey(c);

export default function AddPropertyPicker({
  rootId, existing, onAdd, onClose,
}: {
  rootId: number;
  /** Set of `${path}|${trait}|${field}` keys already tracked (hidden from the list). */
  existing: Set<string>;
  /** Add one or more properties at once (checkbox multi-select → "Add"). */
  onAdd: (cs: PropertyCandidate[]) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState('');
  // Left-pane tree: which entities are expanded (root open, descendants closed).
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([rootId]));
  // Right pane shows this entity's fields. Defaults to the Animator root.
  const [selectedId, setSelectedId] = useState<number>(rootId);
  // Checkbox multi-selection (keys persist as the user browses across entities).
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const candidates = useMemo(() => collectCandidates(rootId), [rootId]);
  const byKey = useMemo(() => { const m = new Map<string, PropertyCandidate>(); for (const c of candidates) m.set(candKey(c), c); return m; }, [candidates]);
  const toggleChecked = (c: PropertyCandidate) => setChecked((prev) => { const n = new Set(prev); const k = candKey(c); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const commitChecked = () => { const cs = [...checked].map((k) => byKey.get(k)).filter((c): c is PropertyCandidate => !!c); if (cs.length) onAdd(cs); };

  const tree = useMemo(
    () => buildPropertyTree(candidates, rootId, existing, filter),
    [candidates, rootId, existing, filter],
  );
  // While filtering, every surviving branch auto-expands so matches are visible.
  const filtering = filter.trim().length > 0;
  const rows = useMemo(() => flattenVisible(tree, expanded, filtering), [tree, expanded, filtering]);
  const byId = useMemo(() => indexById(tree), [tree]);

  // Resolve which entity's fields the right pane shows. Keep the user's pick when
  // it's still in the tree; but while filtering, if that entity has no matching
  // field, jump to the first entity that does so the matches are never hidden.
  let selNode = byId.get(selectedId) ?? null;
  if (!selNode || (filtering && selNode.fields.length === 0)) {
    selNode = rows.find((r) => r.fields.length > 0) ?? rows[0] ?? null;
  }

  const toggle = (id: number) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div style={overlay} onClick={onClose}>
      <div style={popover} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <input autoFocus placeholder="Filter properties…" value={filter} onChange={(e) => setFilter(e.target.value)} style={input} />
          <button style={btn} onClick={onClose}>×</button>
        </div>
        {tree.length === 0 ? (
          <div style={{ color: '#666', padding: 8 }}>No animatable properties{filter ? ' match' : ''}.</div>
        ) : (
          <div style={{ display: 'flex', flex: 1, minHeight: 0, border: '1px solid #2a2a40', borderRadius: 4 }}>
            {/* Left: entity hierarchy — click a name to select, caret to expand. */}
            <div style={{ width: 168, flexShrink: 0, overflowY: 'auto', borderRight: '1px solid #2a2a40' }}>
              {rows.map((node) => {
                const isOpen = filtering || expanded.has(node.id);
                const hasKids = node.children.length > 0;
                const isSel = selNode?.id === node.id;
                return (
                  <div
                    key={node.id}
                    onClick={() => setSelectedId(node.id)}
                    title={node.path || '(root)'}
                    style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '2px 4px', paddingLeft: 4 + node.depth * 12, cursor: 'pointer', background: isSel ? '#2a2a40' : 'transparent', color: isSel ? '#cdd' : '#aab', fontSize: 11, userSelect: 'none', whiteSpace: 'nowrap' }}
                    onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = '#1d1d2c'; }}
                    onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span
                      onClick={(e) => { e.stopPropagation(); if (hasKids) toggle(node.id); }}
                      style={{ display: 'inline-block', width: 10, color: '#667', cursor: hasKids ? 'pointer' : 'default' }}
                    >{hasKids ? (isOpen ? '▾' : '▸') : ''}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
                    <span style={{ color: '#556', fontSize: 9, marginLeft: 'auto', paddingLeft: 4 }}>{node.fields.length || ''}</span>
                  </div>
                );
              })}
            </div>
            {/* Right: animatable fields of the selected entity. */}
            <div style={{ flex: 1, overflowY: 'auto', minWidth: 0 }}>
              <div style={{ padding: '3px 8px', color: '#7aa2f7', fontSize: 10, fontWeight: 'bold', borderBottom: '1px solid #2a2a40', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {selNode ? (selNode.path || '(root)') : ''}
              </div>
              {selNode && selNode.fields.length === 0 && (
                <div style={{ color: '#667', fontSize: 11, padding: 8 }}>No animatable properties on this entity{filter ? ' match' : ''}.</div>
              )}
              {selNode?.fields.map((c) => {
                const on = checked.has(candKey(c));
                return (
                  <div
                    key={`${c.trait}.${c.field}`}
                    onClick={() => toggleChecked(c)}
                    onDoubleClick={() => onAdd([c])}
                    title="Click to select · double-click to add just this one"
                    style={{ ...rowStyle, background: on ? '#243049' : 'transparent' }}
                    onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = '#2a2a40'; }}
                    onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                      <input type="checkbox" checked={on} readOnly tabIndex={-1} style={{ accentColor: '#7aa2f7', pointerEvents: 'none' }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
                    </span>
                    <span style={{ color: '#556', fontSize: 9, flexShrink: 0, paddingLeft: 6 }}>{c.type}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {/* Footer: add all checked properties at once. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <span style={{ color: '#889', fontSize: 11 }}>{checked.size} selected</span>
          <span style={{ flex: 1 }} />
          <button style={{ ...btn, opacity: checked.size ? 1 : 0.4, cursor: checked.size ? 'pointer' : 'default' }} disabled={checked.size === 0} onClick={commitChecked}>
            + Add {checked.size || ''} {checked.size === 1 ? 'Property' : 'Properties'}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' };
const popover: React.CSSProperties = { width: 480, height: '60vh', display: 'flex', flexDirection: 'column', background: '#15151f', border: '1px solid #3a3a5a', borderRadius: 5, padding: 10, fontFamily: 'monospace', fontSize: 12, color: '#ccc', boxShadow: '0 6px 24px rgba(0,0,0,0.6)' };
const input: React.CSSProperties = { flex: 1, background: '#0e0e16', color: '#ddd', border: '1px solid #333', borderRadius: 3, padding: '3px 6px', fontFamily: 'monospace', fontSize: 12 };
const btn: React.CSSProperties = { background: '#2a2a40', color: '#ccc', border: '1px solid #444', borderRadius: 3, padding: '2px 8px', cursor: 'pointer' };
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 6px', cursor: 'pointer', borderRadius: 3 };
