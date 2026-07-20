/** Selected-item inspector for the Timeline panel — the vertical form (right-side dock) that edits
 *  the VALUES of the clip / marker / cue / span selected in the track view (what Phase 2 delegated
 *  to the MCP ops). Emits field-level patches through `onEdit`; the panel wraps each in its
 *  coalesced-undo commit so a drag-through-a-number-field is one undo step. Value pickers avoid the
 *  raw-GUID/typo trap: audio cues pick a clip from the project's audio assets, signal markers
 *  autocomplete registered action names, buses are an enum. */

import { useState } from 'react';
import type { TrackDef } from '../../../runtime/timeline/types';
import type { TrackItemPatch } from './itemEdit';
import { getItem } from './itemEdit';
import { getUIActionParams } from '../../../runtime/ui/actionRegistry';
import type { FieldHint } from '../../../runtime/ecs/traitRegistry';

const inp: React.CSSProperties = { background: '#191919', border: '1px solid #333', color: '#cfcfd6', fontSize: 11, padding: '2px 4px', borderRadius: 2 };
const inpFull: React.CSSProperties = { ...inp, flex: 1, minWidth: 0 };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 };
const lblW: React.CSSProperties = { color: '#8a8a96', width: 44, flexShrink: 0 };
const del: React.CSSProperties = { fontSize: 11, background: '#3a2a2a', border: '1px solid #5a3a3a', color: '#e0b0b0', borderRadius: 3, padding: '4px 8px', cursor: 'pointer', marginTop: 4 };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={row}><span style={lblW}>{label}</span>{children}</label>;
}

function NumField({ label, value, onChange, min, step, placeholder, optional }: {
  label: string; value: number | undefined; onChange: (v: number | undefined) => void; min?: number; step?: number; placeholder?: string;
  /** When true, clearing the field emits `undefined` (the value is UNSET) instead of 0 — so an optional
   *  field (duration/volume/pitch/transform) round-trips to its default instead of a semantically
   *  different 0. Required fields (start/t/end) leave this false and clear to 0 (review C5). */
  optional?: boolean;
}) {
  return (
    <Field label={label}>
      <input style={inpFull} type="number" min={min} step={step ?? 0.1} value={value ?? ''} placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value;
          if (optional && raw === '') { onChange(undefined); return; } // cleared → unset (not 0)
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n : 0); // non-optional empty ('' → NaN? no, Number('')===0) or junk → 0
        }} />
    </Field>
  );
}

/** One auto-generated field for a signal marker's `params`, driven by the target action's declared
 *  `params` FieldHint schema (so a typed form replaces raw JSON when the action declares its shape). */
function ParamField({ name, hint, value, onChange, actionNames }: {
  name: string; hint: FieldHint; value: unknown; onChange: (v: unknown) => void; actionNames: string[];
}) {
  const label = <span style={lblW} title={hint.tooltip}>{name}</span>;
  if (hint.type === 'boolean') {
    return <label style={row}>{label}<input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /></label>;
  }
  if (hint.type === 'number' || hint.type === 'color') {
    return <label style={row}>{label}<input style={inpFull} type="number" min={hint.min} max={hint.max} step={hint.step ?? (hint.type === 'color' ? 1 : 0.1)}
      value={typeof value === 'number' ? value : ''} onChange={(e) => onChange(Number(e.target.value) || 0)} /></label>;
  }
  const opts = hint.type === 'enum' ? (hint.optionsSource === 'uiActions' ? actionNames : (hint.options ?? [])) : null;
  if (opts) {
    return <label style={row}>{label}<select style={inpFull} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
      <option value="" />{opts.map((o) => <option key={o} value={o}>{o}</option>)}
    </select></label>;
  }
  return <label style={row}>{label}<input style={inpFull} value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value)} /></label>;
}

export default function ItemInspector({
  track, itemIdx, audioAssets, prefabAssets, actionNames, onEdit, onDelete,
}: {
  track: TrackDef;
  itemIdx: number;
  /** Project audio assets for the cue clip dropdown: {guid, label}. */
  audioAssets: { guid: string; label: string }[];
  /** Project prefab assets for the control clip dropdown: {guid, label}. */
  prefabAssets: { guid: string; label: string }[];
  /** Registered UIAction names for the signal action combo. */
  actionNames: string[];
  onEdit: (patch: TrackItemPatch, field: string) => void;
  onDelete: () => void;
}) {
  const item = getItem(track, itemIdx);

  // Signal params are edited as JSON text with parse-on-change; keep a local buffer so an
  // in-progress (temporarily invalid) edit isn't reformatted/cursor-jumped by the committed doc
  // round-trip. The parent keys this component by selection, so the lazy initializer re-runs on a
  // new item — no effect-resync needed (which would fight typing, since `track` is a fresh ref
  // every commit).
  const [paramsText, setParamsText] = useState(() => {
    if (track.type === 'signal') { const m = track.markers[itemIdx]; return m?.params ? JSON.stringify(m.params) : ''; }
    return '';
  });
  const [paramsBad, setParamsBad] = useState(false);

  if (!item) return null;

  const commitParams = (text: string) => {
    setParamsText(text);
    if (text.trim() === '') { setParamsBad(false); onEdit({ params: undefined }, 'params'); return; }
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { setParamsBad(false); onEdit({ params: parsed as Record<string, unknown> }, 'params'); }
      else setParamsBad(true);
    } catch { setParamsBad(true); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, fontSize: 11 }}>
      <div style={{ color: '#cfcfd6', fontWeight: 600 }}>{track.type} item #{itemIdx}</div>

      {track.type === 'animation' && (() => {
        const c = track.clips[itemIdx];
        return (<>
          <Field label="clip"><input style={inpFull} value={c.clip} placeholder="clip name" onChange={(e) => onEdit({ clip: e.target.value }, 'clip')} /></Field>
          <NumField label="start" value={c.start} onChange={(v) => onEdit({ start: v }, 'start')} min={0} />
          <NumField label="dur" value={c.duration} onChange={(v) => onEdit({ duration: v }, 'dur')} min={0} placeholder="auto" optional />
          <Field label="scrub"><input type="checkbox" checked={c.scrub !== false} onChange={(e) => onEdit({ scrub: e.target.checked }, 'scrub')} /></Field>
        </>);
      })()}

      {track.type === 'signal' && (() => {
        const m = track.markers[itemIdx];
        // If the selected action DECLARES its params (a FieldHint schema), render a typed form per
        // param — no more raw JSON. Actions with no declared params fall back to the JSON textarea.
        const schema = m.action ? getUIActionParams(m.action) : undefined;
        const params = (m.params ?? {}) as Record<string, unknown>;
        const setParam = (key: string, v: unknown) => onEdit({ params: { ...params, [key]: v } }, `params:${key}`);
        return (<>
          <NumField label="t" value={m.t} onChange={(v) => onEdit({ t: v }, 't')} min={0} />
          <Field label="action">
            <input style={inpFull} list="tl-action-names" value={m.action} placeholder="action name" onChange={(e) => onEdit({ action: e.target.value }, 'action')} />
            <datalist id="tl-action-names">{actionNames.map((n) => <option key={n} value={n} />)}</datalist>
          </Field>
          {schema && Object.keys(schema).length > 0 ? (
            <>
              <div style={{ fontSize: 10, color: '#8a8a96', marginTop: 2 }}>params — from <code>{m.action}</code></div>
              {Object.entries(schema).map(([k, hint]) => (
                <ParamField key={k} name={k} hint={hint} value={params[k]} onChange={(v) => setParam(k, v)} actionNames={actionNames} />
              ))}
            </>
          ) : (
            <Field label="params">
              <input style={{ ...inpFull, borderColor: paramsBad ? '#8a4d4d' : '#333' }} value={paramsText} placeholder={'{"text":"Hi"}'} spellCheck={false} onChange={(e) => commitParams(e.target.value)} />
            </Field>
          )}
        </>);
      })()}

      {track.type === 'audio' && (() => {
        const c = track.cues[itemIdx];
        const known = audioAssets.some((a) => a.guid === c.clip);
        return (<>
          <NumField label="t" value={c.t} onChange={(v) => onEdit({ t: v }, 't')} min={0} />
          <Field label="clip">
            <select style={inpFull} value={c.clip} onChange={(e) => onEdit({ clip: e.target.value }, 'clip')}>
              {!known && <option value={c.clip}>{c.clip || '(none)'}</option>}
              {audioAssets.map((a) => <option key={a.guid} value={a.guid}>{a.label}</option>)}
            </select>
          </Field>
          <Field label="bus">
            <select style={inpFull} value={c.bus ?? 'sfx'} onChange={(e) => onEdit({ bus: e.target.value as 'master' | 'music' | 'sfx' | 'ui' }, 'bus')}>
              {['master', 'music', 'sfx', 'ui'].map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </Field>
          <NumField label="vol" value={c.volume} onChange={(v) => onEdit({ volume: v }, 'vol')} min={0} step={0.05} optional />
          <NumField label="pitch" value={c.pitch} onChange={(v) => onEdit({ pitch: v }, 'pitch')} min={0} step={0.05} optional />
        </>);
      })()}

      {track.type === 'activation' && (() => {
        const s = track.spans[itemIdx];
        return (<>
          <NumField label="start" value={s.start} onChange={(v) => onEdit({ start: v }, 'start')} min={0} />
          <NumField label="end" value={s.end} onChange={(v) => onEdit({ end: v }, 'end')} min={0} />
        </>);
      })()}

      {track.type === 'control' && (() => {
        const c = track.clips[itemIdx];
        const kind = c.subdirector ? 'subdirector' : c.particle ? 'particle' : 'prefab';
        const known = prefabAssets.some((a) => a.guid === c.prefab);
        return (<>
          <Field label="kind">
            <select
              style={inpFull}
              value={kind}
              onChange={(e) => onEdit(
                e.target.value === 'particle' ? { particle: true, subdirector: undefined, prefab: undefined }
                  : e.target.value === 'subdirector' ? { subdirector: true, particle: undefined, prefab: undefined }
                    : { prefab: c.prefab ?? '', particle: undefined, subdirector: undefined },
                'kind',
              )}
            >
              <option value="prefab">prefab (spawn)</option>
              <option value="particle">particle (restart)</option>
              <option value="subdirector">sub-director (nested timeline)</option>
            </select>
          </Field>
          {kind === 'particle' ? (
            <div style={{ fontSize: 11, color: '#8a8a96', padding: '2px 0' }}>
              Restarts the track target&apos;s ParticleEmitter at start{c.duration !== undefined ? ' (pauses at end)' : ''}.
            </div>
          ) : kind === 'subdirector' ? (
            <div style={{ fontSize: 11, color: '#8a8a96', padding: '2px 0' }}>
              Plays the track target&apos;s Director (a nested timeline) synced to this clip, in Play and ▶ Preview.
            </div>
          ) : (
            <Field label="prefab">
              <select style={inpFull} value={c.prefab ?? ''} onChange={(e) => onEdit({ prefab: e.target.value }, 'prefab')}>
                {!known && <option value={c.prefab ?? ''}>{c.prefab || '(none)'}</option>}
                {prefabAssets.map((a) => <option key={a.guid} value={a.guid}>{a.label}</option>)}
              </select>
            </Field>
          )}
          <NumField label="start" value={c.start} onChange={(v) => onEdit({ start: v }, 'start')} min={0} />
          <NumField label="dur" value={c.duration} onChange={(v) => onEdit({ duration: v }, 'dur')} min={0} placeholder="stay" optional />
          {kind === 'prefab' && (() => {
            const tf = c.transform ?? {};
            const setTf = (k: string, v: number | undefined) => onEdit({ transform: { ...tf, [k]: v } }, `tf:${k}`);
            const row = (keys: readonly string[], ph: string) => (
              <div style={{ display: 'flex', gap: 4 }}>
                {keys.map((k) => <NumField key={k} label={k} value={(tf as Record<string, number>)[k]} onChange={(v) => setTf(k, v)} placeholder={ph} optional />)}
              </div>
            );
            return (
              <div style={{ borderTop: '1px solid #26262c', marginTop: 4, paddingTop: 4 }}>
                <div style={{ fontSize: 10, color: '#8a8a96', marginBottom: 2 }}>spawn transform (blank = prefab default)</div>
                {row(['x', 'y', 'z'], '0')}
                {row(['rx', 'ry', 'rz'], '0')}
                {row(['sx', 'sy', 'sz'], '1')}
              </div>
            );
          })()}
        </>);
      })()}

      <button style={del} onClick={onDelete}>🗑 Delete item</button>
    </div>
  );
}
