/** UIActionBindingsField — unified UIAction binding-list editor (UIAction.bindings).
 *  Extracted from Inspector.tsx (editor-inspector.md F2). One "+ Add" button; each
 *  row picks an event (Click/Change/Submit) and a kind (Set value / Call method),
 *  then shows the relevant params:
 *   - Set:  target (drag-drop), component (traits on target), property (its
 *           fields), value (typed by the field's hint). For change/submit events
 *           a "use event value" toggle writes the live value via the $value token.
 *   - Call: action (registered names), target (→ctx.target), and either typed
 *           param widgets from the action's declared schema or one freeform payload. */

import { useState, useMemo } from 'react';
import { readTraitData } from '../../runtime/ecs/entityUtils';
import { getCurrentWorld } from '../../runtime/ecs/world';
import { type TraitMeta, getTraitByName, getAllTraits } from '../../runtime/ecs/traitRegistry';
import { writeTraitFieldPerEntityWithUndo as writeFieldPerEntity } from '../undo/entityActions';
import { getUIActionNames, getUIActionParams } from '../../runtime/ui/actionRegistry';
import type { UIActionBinding, UIActionEvent, UIActionKind } from '../../runtime/ui/bindings';
import { VALUE_TOKEN } from '../../runtime/ui/bindings';
import { BufferedTextInput, inputStyle, MIXED_PLACEHOLDER } from './fields';
import { FieldLabel, DropdownField } from './assetViews/widgets';
import { EntityRefField, FieldValueWidget, defaultForHint, useWorldDirtyTick } from './inspectorFields';

const EVENT_OPTS: UIActionEvent[] = ['click', 'change', 'submit'];
const EVENT_LABEL: Record<UIActionEvent, string> = { click: 'Click', change: 'Change', submit: 'Submit' };
const KIND_OPTS: UIActionKind[] = ['set', 'call'];
const KIND_LABEL: Record<UIActionKind, string> = { set: 'Set value', call: 'Call method' };

/** Compact labelled <select> for the event/kind pickers (smaller than DropdownField). */
function MiniSelect({ label, value, options, labels, onChange, mixed = false }: {
  label: string; value: string; options: string[]; labels: Record<string, string>; onChange: (v: string) => void; mixed?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
      <span style={{ flex: 1, color: '#888', fontSize: '11px' }}>{label}</span>
      <select value={mixed ? '' : value} onChange={(e) => { if (e.target.value !== '') onChange(e.target.value); }}
        style={{ flex: 1, background: '#111', color: '#ddd', border: '1px solid #444', borderRadius: 3, padding: '2px 4px', fontSize: '12px', cursor: 'pointer' }}>
        {mixed && <option value="">{MIXED_PLACEHOLDER}</option>}
        {options.map((o) => <option key={o} value={o}>{labels[o] ?? o}</option>)}
      </select>
    </div>
  );
}

export function UIActionBindingsField({ entityIds, meta, field }: { entityIds: number[]; meta: TraitMeta; field: string }) {
  // Local re-render trigger: in a multi-selection the Inspector doesn't live-refresh
  // (see liveRefresh = !multi), so we re-read per-entity bindings on each edit.
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);

  // Read every selected entity's own bindings array. The primary (entityIds[0])
  // drives the rendered structure + representative values; the rest are used to
  // detect mixed sub-fields and to apply per-entity patches (so editing ONE
  // sub-field across a multi-selection preserves each entity's other sub-fields).
  const allRows: UIActionBinding[][] = entityIds.map((id) => {
    const d = readTraitData(id, meta);
    const a = d?.[field];
    return Array.isArray(a) ? (a as UIActionBinding[]) : [];
  });
  const rows = allRows[0] ?? [];
  const multi = entityIds.length > 1;
  const rowsDiffer = multi && allRows.some((arr) => arr.length !== rows.length);

  /** A sub-field differs across the selection (→ render its widget as ----). */
  const subMixed = (i: number, key: keyof UIActionBinding): boolean =>
    multi && allRows.some((arr) => i < arr.length && !Object.is((arr[i] as any)?.[key], (rows[i] as any)?.[key]));
  /** A nested params[key] differs across the selection. */
  const paramMixed = (i: number, key: string): boolean =>
    multi && allRows.some((arr) => i < arr.length && !Object.is((arr[i]?.params as any)?.[key], (rows[i]?.params as any)?.[key]));

  // guid → entity, so a 'set' row's target resolves to the component list it can set.
  // Rebuilt only when the world changes (dirtyTick), not on every render (F8).
  const dirtyTick = useWorldDirtyTick();
  const attrMeta = getTraitByName('EntityAttributes');
  const guidToEntity = useMemo(() => {
    const map = new Map<string, any>();
    if (attrMeta) {
      try {
        getCurrentWorld().query(attrMeta.trait).updateEach(([a]: any[], ent: any) => {
          if (a?.guid) map.set(a.guid, ent);
        });
      } catch { /* no active world */ }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attrMeta, dirtyTick]);
  // The trait registry is static for the panel's lifetime — compute the component
  // list once instead of a linear scan per render.
  const allComponents = useMemo(() => getAllTraits().filter((t) => t.category === 'component'), []);
  const actionNames = getUIActionNames();

  // Patch row i across ALL selected entities, deriving the patch from EACH entity's
  // own row so other sub-fields stay per-entity. Entities lacking row i are skipped.
  const update = (i: number, makePatch: Partial<UIActionBinding> | ((row: UIActionBinding) => Partial<UIActionBinding>)) => {
    writeFieldPerEntity(entityIds, meta, field, (old) => {
      const arr = Array.isArray(old) ? (old as UIActionBinding[]) : [];
      if (i >= arr.length) return old;
      return arr.map((b, idx) => idx === i ? { ...b, ...(typeof makePatch === 'function' ? makePatch(b) : makePatch) } : b);
    }, `Edit binding ${field}`);
    bump();
  };
  const remove = (i: number) => {
    writeFieldPerEntity(entityIds, meta, field, (old) => {
      const arr = Array.isArray(old) ? (old as UIActionBinding[]) : [];
      return arr.filter((_, idx) => idx !== i);
    }, `Remove binding`);
    bump();
  };
  const add = () => {
    const fresh = { event: 'click', kind: 'set', target: '', component: 'UIElement', property: 'isVisible', value: true } as UIActionBinding;
    writeFieldPerEntity(entityIds, meta, field, (old) => {
      const arr = Array.isArray(old) ? (old as UIActionBinding[]) : [];
      return [...arr, fresh];
    }, `Add binding`);
    bump();
  };

  return (
    <div style={{ marginBottom: 4 }}>
      <FieldLabel label="bindings" style={{ color: '#888', fontSize: '11px' }} />
      {rowsDiffer && (
        <div style={{ color: '#aa8', fontSize: '10px', marginBottom: 4 }}>
          Selected entities have different numbers of bindings — editing applies row-by-row; extra rows are left untouched.
        </div>
      )}
      {rows.map((b, i) => {
        const event = (b.event || 'click') as UIActionEvent;
        const kind = (b.kind || 'set') as UIActionKind;
        const canUseEventValue = event !== 'click';
        return (
          <div key={i} style={{ border: '1px solid #333', borderRadius: 3, padding: 4, marginBottom: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
              <span style={{ color: '#666', fontSize: '10px' }}>binding {i + 1}</span>
              <span onClick={() => remove(i)} title="Remove" style={{ cursor: 'pointer', color: '#888', padding: '0 2px' }}>×</span>
            </div>
            <MiniSelect label="event" value={event} options={EVENT_OPTS} labels={EVENT_LABEL} mixed={subMixed(i, 'event')}
              onChange={(v) => update(i, { event: v as UIActionEvent })} />
            <MiniSelect label="kind" value={kind} options={KIND_OPTS} labels={KIND_LABEL} mixed={subMixed(i, 'kind')}
              onChange={(v) => update(i, (row) => v === 'set'
                ? { kind: 'set', component: row.component || 'UIElement', property: row.property || '', value: row.value ?? '' }
                : { kind: 'call', action: row.action || '' })} />

            {kind === 'set' ? (() => {
              const ent = b.target ? guidToEntity.get(b.target) : undefined;
              const componentNames = ent
                ? allComponents.filter((t) => { try { return ent.has(t.trait); } catch { return false; } }).map((t) => t.name)
                : allComponents.map((t) => t.name);
              const compOpts = Array.from(new Set([b.component || '', ...componentNames]));
              const fields = getTraitByName(b.component || '')?.fields ?? {};
              const propOpts = Array.from(new Set([b.property || '', ...Object.keys(fields)]));
              const valueHint = fields[b.property || ''];
              const usingEventValue = b.value === VALUE_TOKEN;
              return (
                <>
                  <EntityRefField label="target" value={b.target || ''} onChange={(v) => update(i, { target: v })} mixed={subMixed(i, 'target')} />
                  <DropdownField label="component" value={b.component || ''} options={compOpts} mixed={subMixed(i, 'component')}
                    onChange={(v) => update(i, { component: v, property: '', value: '' })} />
                  <DropdownField label="property" value={b.property || ''} options={propOpts} mixed={subMixed(i, 'property')}
                    onChange={(v) => update(i, { property: v, value: defaultForHint(fields[v]) })} />
                  {canUseEventValue && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '11px', marginBottom: 2, color: '#bbb' }}>
                      <input type="checkbox" checked={usingEventValue}
                        onChange={(e) => update(i, { value: e.target.checked ? VALUE_TOKEN : defaultForHint(valueHint) })} />
                      use event value ($value)
                    </label>
                  )}
                  {!usingEventValue && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                      <span style={{ flex: 1, color: '#888', fontSize: '11px' }}>value</span>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                        <FieldValueWidget hint={valueHint} value={b.value} mixed={subMixed(i, 'value')} onChange={(v) => update(i, { value: v })} />
                      </div>
                    </div>
                  )}
                </>
              );
            })() : (() => {
              const actOpts = Array.from(new Set(['', ...actionNames, b.action || '']));
              const schema = b.action ? getUIActionParams(b.action) : undefined;
              const params = b.params ?? {};
              const setParam = (k: string, v: unknown) =>
                update(i, (row) => ({ params: { ...((row.params as Record<string, unknown>) ?? {}), [k]: v } }));
              return (
                <>
                  <DropdownField label="action" value={b.action || ''} options={actOpts} mixed={subMixed(i, 'action')}
                    onChange={(v) => update(i, { action: v, params: {} })} />
                  <EntityRefField label="target" value={b.target || ''} onChange={(v) => update(i, { target: v })} mixed={subMixed(i, 'target')} />
                  {schema ? Object.entries(schema).map(([k, hint]) => {
                    const usingEventValue = params[k] === VALUE_TOKEN;
                    return (
                      <div key={k} style={{ marginBottom: 2 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ flex: 1, color: '#888', fontSize: '11px' }}>{k}</span>
                          <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                            {usingEventValue
                              ? <span style={{ color: '#5dade2', fontSize: '11px' }}>$value</span>
                              : <FieldValueWidget hint={hint} value={params[k]} mixed={paramMixed(i, k)} onChange={(v) => setParam(k, v)} />}
                          </div>
                        </div>
                        {canUseEventValue && (
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: '10px', color: '#888' }}>
                            <input type="checkbox" checked={usingEventValue}
                              onChange={(e) => setParam(k, e.target.checked ? VALUE_TOKEN : defaultForHint(hint))} />
                            use event value
                          </label>
                        )}
                      </div>
                    );
                  }) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                      <span style={{ flex: 1, color: '#888', fontSize: '11px' }}>payload</span>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                        <BufferedTextInput value={params.payload == null ? '' : String(params.payload)}
                          onChange={(v) => setParam('payload', v)} style={{ ...inputStyle, flex: 1 }} placeholder="payload" />
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        );
      })}
      <button onClick={add} style={{ fontSize: '11px', background: '#2a2a40', color: '#ccc', border: '1px solid #444', borderRadius: 3, padding: '2px 8px', cursor: 'pointer' }}>+ Add binding</button>
    </div>
  );
}
