/** Shared Inspector field primitives used by BOTH the trait-section path
 *  (Inspector.tsx) and the UIAction binding-list editor (UIActionBindingsField.tsx).
 *  Extracted from Inspector.tsx (editor-inspector.md F2) so UIActionBindingsField
 *  could move to its own file without a circular import back into Inspector. */

import { useState, useEffect, useMemo } from 'react';
import { findEntity } from '../../runtime/ecs/entityUtils';
import { getCurrentWorld } from '../../runtime/ecs/world';
import { type FieldHint, getTraitByName } from '../../runtime/ecs/traitRegistry';
import { newGuid } from '../../runtime/loaders/assetManifest';
import { onEditorDirty } from '../../runtime/ui/uiTreeStore';
import { getUIActionNames } from '../../runtime/ui/actionRegistry';
import { getPhysicsLayerNames } from '../../runtime/systems/physicsLayers';
import { BufferedTextInput, BufferedNumberInput, inputStyle, MIXED_PLACEHOLDER } from './fields';
import { FieldLabel, DropdownField, ColorField, DEFAULT_COLOR } from './assetViews/widgets';
import { useEditorStore } from '../store/editorStore';

/** Re-render trigger that bumps on every ECS dirty tick. Lets a widget memoize a
 *  world-derived map and only rebuild it when the world actually changes (instead
 *  of on every Inspector re-render — F8). */
export function useWorldDirtyTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => onEditorDirty(() => setTick((t) => t + 1)), []);
  return tick;
}

/** A sensible empty value for a freshly-picked property, by its field type
 *  (F11 — color seeds DEFAULT_COLOR/white, not 0/black). */
export function defaultForHint(hint: FieldHint | undefined): unknown {
  if (!hint) return '';
  if (hint.type === 'boolean') return false;
  if (hint.type === 'number') return 0;
  if (hint.type === 'color') return DEFAULT_COLOR;
  return '';
}

/** Entity reference field — a drop target. Drag an entity from the Hierarchy onto
 *  it to store that entity's GUID (resolved from the dragged entity id). Shows the
 *  referenced entity's name with a clear button. Used for UIAction binding
 *  targets. */
export function EntityRefField({ label, value, onChange, hint, mixed = false }: {
  label: string; value: string; onChange: (v: string) => void; hint?: FieldHint; mixed?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const dirtyTick = useWorldDirtyTick();
  const selectEntity = useEditorStore((s) => s.selectEntity);
  // Map current world entities: guid→name (display), ecs id→guid (drop resolve),
  // and guid→id (the "locate in Hierarchy" ping). Rebuilt only when the world
  // changes (dirtyTick), not on every render (F8).
  const attrMeta = getTraitByName('EntityAttributes');
  const { guidToName, idToGuid, guidToId } = useMemo(() => {
    const guidToName = new Map<string, string>();
    const idToGuid = new Map<number, string>();
    const guidToId = new Map<string, number>();
    if (attrMeta) {
      try {
        getCurrentWorld().query(attrMeta.trait).updateEach(([a]: any[], ent: any) => {
          if (a?.guid) { guidToName.set(a.guid, a.name || a.guid); idToGuid.set(ent.id(), a.guid); guidToId.set(a.guid, ent.id()); }
        });
      } catch { /* no active world */ }
    }
    return { guidToName, idToGuid, guidToId };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attrMeta, dirtyTick]);
  const name = value ? (guidToName.get(value) ?? `${value.slice(0, 8)}… (missing)`) : '';

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setHover(false);
    const raw = e.dataTransfer.getData('application/editor-entity');
    if (!raw) return;
    try {
      const { id } = JSON.parse(raw) as { id: number };
      let guid = idToGuid.get(id);
      // The dropped entity may have no guid yet — e.g. a freshly-instantiated
      // prefab instance root, whose identity is otherwise only minted at save
      // time. Mint one on the entity now so the reference resolves immediately
      // (and survives the next save) instead of silently no-opping the drop.
      if (!guid && attrMeta) {
        const ent = findEntity(id);
        if (ent?.has(attrMeta.trait)) {
          const ea = ent.get(attrMeta.trait) as Record<string, unknown>;
          guid = newGuid();
          ent.set(attrMeta.trait, { ...ea, guid });
        }
      }
      if (guid) onChange(guid);
    } catch { /* malformed payload */ }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
      <FieldLabel label={label} hint={hint} style={{ flex: 1, color: '#888', fontSize: '11px' }} />
      <div
        tabIndex={0}
        onKeyDown={(e) => {
          // Backspace/Delete clears the reference when the field is focused.
          if ((e.key === 'Backspace' || e.key === 'Delete') && value && !mixed) {
            e.preventDefault(); onChange('');
          }
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('application/editor-entity')) return;
          e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={handleDrop}
        title={value || 'Drag an entity from the Hierarchy here (Backspace to clear)'}
        style={{
          ...inputStyle, flex: 1, display: 'flex', alignItems: 'center', gap: 4,
          border: hover ? '1px solid #4af' : (inputStyle as any).border,
          background: hover ? '#1d2a3a' : (inputStyle as any).background,
        }}
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: mixed ? '#888' : (name ? '#ddd' : '#666') }}>
          {mixed ? MIXED_PLACEHOLDER : (name || 'drag entity here')}
        </span>
        {value && !mixed && (
          <span onClick={() => onChange('')} title="Clear" style={{ cursor: 'pointer', color: '#888', padding: '0 2px' }}>×</span>
        )}
      </div>
      {/* Locate: select the referenced entity so the Hierarchy pings + scrolls to
          it (the entity-world twin of AssetRefField's "locate in Assets"). Shown
          only when the ref resolves to a live entity. */}
      {value && !mixed && guidToId.has(value) && (
        <button onClick={() => selectEntity(guidToId.get(value)!)} title="Select in Hierarchy" style={{
          background: 'none', border: 'none', cursor: 'pointer', color: '#888',
          padding: 0, fontSize: '12px', lineHeight: 1, flexShrink: 0,
        }}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5"/>
            <line x1="11" y1="11" x2="15" y2="15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      )}
    </div>
  );
}

/** Renders a single typed value editor driven by a field's FieldHint — the inner
 *  "value" cell of a binding row. Reuses the same leaf widgets the Inspector uses so
 *  isVisible→checkbox, a color field→color picker, a ref field→entity drag-drop. */
export function FieldValueWidget({ hint, value, onChange, mixed = false }: {
  hint: FieldHint | undefined; value: unknown; onChange: (v: unknown) => void; mixed?: boolean;
}) {
  if (hint?.type === 'boolean') {
    return <input type="checkbox" checked={mixed ? false : !!value}
      ref={(el) => { if (el) el.indeterminate = mixed; }}
      onChange={(e) => onChange(e.target.checked)} />;
  }
  if (hint?.type === 'number') {
    return <BufferedNumberInput value={typeof value === 'number' ? value : 0} step={hint.step ?? 1} mixed={mixed}
      onChange={(v) => onChange(v)} style={{ ...inputStyle, flex: 1 }} />;
  }
  if (hint?.type === 'color') {
    return <ColorField label="" value={typeof value === 'number' ? value : 0} onChange={(v) => onChange(v)} mixed={mixed} />;
  }
  if (hint?.type === 'entityRef') {
    return <EntityRefField label="" value={typeof value === 'string' ? value : ''} onChange={(v) => onChange(v)} mixed={mixed} />;
  }
  if (hint?.type === 'enum' && (hint.options || hint.optionsSource)) {
    const base = hint.optionsSource === 'uiActions' ? getUIActionNames()
      : hint.optionsSource === 'physicsLayers' ? getPhysicsLayerNames()
      : (hint.options ?? []);
    const cur = typeof value === 'string' ? value : '';
    const opts = Array.from(new Set(['', ...base, cur]));
    return <DropdownField label="" value={cur} options={opts} onChange={(v) => onChange(v)} mixed={mixed} />;
  }
  // string + unknown-type fallback
  return <BufferedTextInput value={value == null ? '' : String(value)} onChange={(v) => onChange(v)}
    mixed={mixed} placeholder="value" style={{ ...inputStyle, flex: 1 }} />;
}
