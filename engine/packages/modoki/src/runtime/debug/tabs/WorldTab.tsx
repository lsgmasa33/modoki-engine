/** World tab — a lightweight runtime ECS inspector (hierarchy + trait editor).
 *
 *  Deliberately does NOT reuse the editor's Hierarchy/Inspector panels — those pull
 *  the whole editor tree (undo, FlexLayout, backend) and are tree-shaken out of game
 *  builds. Instead it reads/writes the live world through the SAME runtime primitives
 *  the editor panels use (`buildEntityTree`, `readTraitData`, `writeTraitField`,
 *  `onStructureDirty`), so it ships in a game bundle at a fraction of the cost.
 *
 *  Tree reacts to structural changes via `getStructureVersion`; trait VALUES refresh
 *  on a slow interval so live gameplay changes show without a per-frame cost. */

import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { getAllEntities, buildEntityTree, onStructureDirty, getStructureVersion, readTraitData, writeTraitField, type EntityInfo } from '../../ecs/entityUtils';
import { getTraitByName, type TraitMeta, type FieldHint } from '../../ecs/traitRegistry';

const VALUE_REFRESH_MS = 250;
const layerColor: Record<string, string> = { '3d': '#7dd3fc', '2d': '#fca5a5', ui: '#c4b5fd' };

export function WorldTab() {
  const structureVersion = useSyncExternalStore(onStructureDirty, getStructureVersion, getStructureVersion);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const [, setValueTick] = useState(0);

  // Rebuild the tree only when the world's structure changes.
  const tree = useMemo(() => buildEntityTree(getAllEntities()), [structureVersion]);
  // Flat id set to detect a stale selection after a hot-reload / despawn.
  const liveIds = useMemo(() => new Set(collectIds(tree)), [tree]);

  useEffect(() => {
    if (selectedId != null && !liveIds.has(selectedId)) setSelectedId(null);
  }, [liveIds, selectedId]);

  // Refresh live trait values while a selection is open (cheap, off the frame loop).
  useEffect(() => {
    if (selectedId == null) return;
    const id = window.setInterval(() => setValueTick((t) => t + 1), VALUE_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [selectedId]);

  const toggle = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={treeBoxStyle}>
        {tree.length === 0 ? (
          <div style={mutedStyle}>No entities in the world.</div>
        ) : (
          tree.map((n) => (
            <TreeNode
              key={n.id}
              node={n}
              depth={0}
              selectedId={selectedId}
              collapsed={collapsed}
              onSelect={setSelectedId}
              onToggle={toggle}
            />
          ))
        )}
      </div>
      {selectedId != null && <InspectorPane entityId={selectedId} />}
    </div>
  );
}

function collectIds(nodes: EntityInfo[]): number[] {
  const out: number[] = [];
  const walk = (n: EntityInfo) => {
    out.push(n.id);
    n.children?.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

function TreeNode({
  node,
  depth,
  selectedId,
  collapsed,
  onSelect,
  onToggle,
}: {
  node: EntityInfo;
  depth: number;
  selectedId: number | null;
  collapsed: Set<number>;
  onSelect: (id: number) => void;
  onToggle: (id: number) => void;
}) {
  const hasChildren = !!node.children?.length;
  const isCollapsed = collapsed.has(node.id);
  const selected = node.id === selectedId;
  return (
    <div>
      <div
        style={{ ...rowStyle, paddingLeft: 4 + depth * 12, ...(selected ? rowSelectedStyle : null) }}
        onClick={() => onSelect(node.id)}
      >
        <span
          style={caretStyle}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(node.id);
          }}
        >
          {hasChildren ? (isCollapsed ? '▸' : '▾') : ''}
        </span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name || `#${node.id}`}</span>
        {node.layer && <span style={{ ...layerBadge, color: layerColor[node.layer] ?? '#8b8ba7' }}>{node.layer}</span>}
      </div>
      {hasChildren && !isCollapsed && node.children!.map((c) => (
        <TreeNode key={c.id} node={c} depth={depth + 1} selectedId={selectedId} collapsed={collapsed} onSelect={onSelect} onToggle={onToggle} />
      ))}
    </div>
  );
}

function InspectorPane({ entityId }: { entityId: number }) {
  const info = getAllEntities().find((e) => e.id === entityId);
  if (!info) return <div style={mutedStyle}>Entity #{entityId} is gone.</div>;
  const metas = info.traits
    .map((name) => getTraitByName(name))
    .filter((m): m is TraitMeta => !!m)
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  return (
    <div style={inspectorBoxStyle}>
      <div style={inspectorHeaderStyle}>
        {info.name || `#${info.id}`} <span style={{ color: '#6b6b85' }}>#{info.id}</span>
      </div>
      {metas.map((meta) => (
        <TraitEditor key={meta.name} entityId={entityId} meta={meta} />
      ))}
    </div>
  );
}

function TraitEditor({ entityId, meta }: { entityId: number; meta: TraitMeta }) {
  const data = readTraitData(entityId, meta);
  const fieldKeys = Object.keys(meta.fields);
  return (
    <div style={traitStyle}>
      <div style={traitNameStyle}>{meta.name}</div>
      {meta.category === 'tag' ? (
        <div style={mutedStyle}>(tag)</div>
      ) : (
        fieldKeys.map((key) => (
          <FieldEditor key={key} entityId={entityId} meta={meta} field={key} hint={meta.fields[key]} value={data?.[key]} />
        ))
      )}
    </div>
  );
}

function FieldEditor({ entityId, meta, field, hint, value }: { entityId: number; meta: TraitMeta; field: string; hint: FieldHint; value: unknown }) {
  const readOnly = hint.readOnly || hint.runtimeOnly;
  const commit = (v: unknown) => writeTraitField(entityId, meta, field, v);

  let control: ReactNode;
  if (readOnly) {
    control = <span style={roValueStyle}>{formatValue(value)}</span>;
  } else if (hint.type === 'boolean') {
    control = <input type="checkbox" checked={!!value} onChange={(e) => commit(e.target.checked)} />;
  } else if (hint.type === 'number') {
    control = (
      <input
        type="number"
        style={inputStyle}
        step={hint.step ?? 'any'}
        min={hint.min}
        max={hint.max}
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => e.target.value !== '' && commit(parseFloat(e.target.value))}
      />
    );
  } else if (hint.type === 'enum' && hint.options?.length) {
    control = (
      <select style={inputStyle} value={String(value ?? '')} onChange={(e) => commit(e.target.value)}>
        {hint.options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  } else if (hint.type === 'color') {
    // Colors in this engine are stored as NUMBERS (0xrrggbb), occasionally as hex
    // strings. Convert to '#rrggbb' for the <input type=color>, and write back in the
    // field's existing representation so we never stamp a string into a numeric SoA
    // field (which downstream numeric ops would turn into NaN/garbage).
    const asString = typeof value === 'string';
    control = (
      <input
        type="color"
        style={{ ...inputStyle, padding: 0, height: 22 }}
        value={colorToHex(value)}
        onChange={(e) => commit(asString ? e.target.value : hexToColorNumber(e.target.value))}
      />
    );
  } else if (hint.type === 'string') {
    control = <input type="text" style={inputStyle} value={typeof value === 'string' ? value : ''} onChange={(e) => commit(e.target.value)} />;
  } else {
    // entityRef / bindings / dynamic enum — show read-only for now.
    control = <span style={roValueStyle}>{formatValue(value)}</span>;
  }

  return (
    <div style={fieldRowStyle}>
      <span style={fieldLabelStyle} title={hint.tooltip}>{field}</span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'flex-end' }}>{control}</span>
    </div>
  );
}

/** Numeric-or-string color → `#rrggbb` for `<input type=color>`. */
export function colorToHex(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return '#' + (value >>> 0 & 0xffffff).toString(16).padStart(6, '0');
  }
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return value;
  return '#ffffff';
}

/** `#rrggbb` → 0xrrggbb number (for writing back a numeric color field). */
export function hexToColorNumber(hex: string): number {
  return parseInt(hex.replace('#', ''), 16) || 0;
}

export function formatValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === 'object') return Array.isArray(v) ? `[${v.length}]` : '{…}';
  return String(v);
}

// --- styles ----------------------------------------------------------------

const treeBoxStyle: CSSProperties = {
  maxHeight: 200,
  overflowY: 'auto',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 6,
  padding: 4,
  fontSize: 12,
};
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 4px', borderRadius: 4, cursor: 'pointer' };
const rowSelectedStyle: CSSProperties = { background: 'rgba(99,102,241,0.35)' };
const caretStyle: CSSProperties = { width: 12, color: '#8b8ba7', flexShrink: 0, textAlign: 'center' };
const layerBadge: CSSProperties = { fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.4, flexShrink: 0 };
const inspectorBoxStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 };
const inspectorHeaderStyle: CSSProperties = { fontSize: 13, fontWeight: 600, color: '#e6e6ff', paddingBottom: 2, borderBottom: '1px solid rgba(255,255,255,0.08)' };
const traitStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3 };
const traitNameStyle: CSSProperties = { fontSize: 11, fontWeight: 700, color: '#a5b4fc', textTransform: 'uppercase', letterSpacing: 0.4 };
const fieldRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 };
const fieldLabelStyle: CSSProperties = { color: '#8b8ba7', flexShrink: 0, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const inputStyle: CSSProperties = { width: 96, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, color: '#e6e6ff', fontSize: 12, padding: '2px 4px' };
const roValueStyle: CSSProperties = { color: '#c4b5fd', fontSize: 12, fontVariantNumeric: 'tabular-nums' };
const mutedStyle: CSSProperties = { color: '#6b6b85', fontStyle: 'italic', fontSize: 12 };
