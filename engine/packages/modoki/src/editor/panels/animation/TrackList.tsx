/** Left property column for the Animation Editor — one row per track
 *  (`path : Trait.field`), a remove button, and the "Add Property" button.
 *  Row heights match the Dopesheet/Curves rows (ROW_H) so they stay aligned. */

import { memo, useRef, useState } from 'react';
import type { AnimationTrack, TrackValueType } from '../../../runtime/animation/types';
import { ROW_H, RULER_H } from './timelineMath';
import { NumBox, TipButton } from './AnimationToolbar';
import { formatTrackField } from '../../animation/recording';

/** Live value/frame of the currently selected keyframe (null when none). */
export interface SelectedKeyInfo {
  type: TrackValueType;
  value: number;
  frame: number;
  label: string;
  /** Static option list for `enum` keys — the value is an index into this. */
  options?: string[];
}

/** Value of the selected PROPERTY (track) at the playhead, shown when no keyframe
 *  is selected. Editing it keys the property at the playhead — updating the key
 *  there or adding one if none exists. */
export interface SelectedPropInfo {
  type: TrackValueType;
  value: number;
  /** Playhead frame — where a value edit will land its key. */
  frame: number;
  label: string;
  options?: string[];
}

function TrackList({
  tracks, width, selected, selectedTracks, onSelect, onRemove, onReorder, onAddProperty, viewMode, onSetViewMode,
  selKey, selCount = 0, onSetKeyValue, onSetKeyFrame, propVal, onSetPropValue,
}: {
  tracks: AnimationTrack[];
  /** Width of the property column in px (user-resizable via the divider). */
  width: number;
  selected: number | null;
  /** All selected track indices (multi-select). Primary is `selected`. */
  selectedTracks: Set<number>;
  /** Select a row — `additive` (shift/cmd) toggles it in the multi-selection. */
  onSelect: (i: number, additive: boolean) => void;
  onRemove: (i: number) => void;
  /** Drag-and-drop reorder: move track `from` to index `to`. */
  onReorder: (from: number, to: number) => void;
  onAddProperty: () => void;
  viewMode: 'dopesheet' | 'curves';
  onSetViewMode: (m: 'dopesheet' | 'curves') => void;
  selKey: SelectedKeyInfo | null;
  /** Number of selected keys — drives the single-key fields vs the multi hint. */
  selCount?: number;
  onSetKeyValue: (v: number) => void;
  onSetKeyFrame: (frame: number) => void;
  /** Value of the selected property at the playhead (shown when NO key is selected). */
  propVal: SelectedPropInfo | null;
  /** Edit the selected property's value at the playhead — keys it there (upsert). */
  onSetPropValue: (v: number) => void;
}) {
  // Drag-reorder state: index being dragged + the row it's hovering over.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  // Single shared hover tooltip (native `title` doesn't render in Electron) — shows
  // the hovered property's entity path.
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showTip = (e: React.MouseEvent, text: string) => {
    const x = e.clientX + 12, y = e.clientY + 16;
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => setTip({ x, y, text }), 350);
  };
  const hideTip = () => { if (tipTimer.current) clearTimeout(tipTimer.current); setTip(null); };
  return (
    <div style={{ width, flexShrink: 0, borderRight: '1px solid #333', display: 'flex', flexDirection: 'column', background: '#16161f' }}>
      {/* Header spacer aligns row 0 with the timeline ruler */}
      <div style={{ height: RULER_H, borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', padding: '0 6px', fontSize: 10, color: '#667' }}>Properties</div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {tracks.length === 0 && (
          <div style={{ color: '#556', fontSize: 11, padding: 8 }}>No properties yet.</div>
        )}
        {tracks.map((t, i) => {
          const isSel = selected === i || selectedTracks.has(i);
          const isOver = overIdx === i && dragIdx !== null && dragIdx !== i;
          return (
            <div
              key={`${t.path}|${t.trait}|${t.field}`}
              draggable
              onDragStart={(e) => { hideTip(); setDragIdx(i); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => { if (dragIdx !== null) { e.preventDefault(); setOverIdx(i); } }}
              onDrop={(e) => { e.preventDefault(); if (dragIdx !== null && dragIdx !== i) onReorder(dragIdx, i); setDragIdx(null); setOverIdx(null); }}
              onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
              onClick={(e) => onSelect(i, e.shiftKey || e.metaKey || e.ctrlKey)}
              style={{ height: ROW_H, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px', cursor: 'grab', background: isSel ? '#2a2a40' : 'transparent', borderBottom: '1px solid #20202c', borderTop: isOver ? '2px solid #7aa2f7' : '2px solid transparent', opacity: dragIdx === i ? 0.5 : 1 }}
            >
              {/* Hover tip lives on the name span only, so hovering the ✕ button shows
                  its own tooltip instead of stacking the entity-path tip on top. */}
              <span
                onMouseEnter={(e) => showTip(e, `Entity: ${t.path || '(Animator root)'}\nProperty: ${t.trait}.${t.field}\n(selecting also selects the entity · drag to reorder · shift-click to multi-select)`)}
                onMouseLeave={hideTip}
                onMouseDown={hideTip}
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#cdd', fontSize: 11 }}
              >
                <span style={{ color: '#556', marginRight: 3 }}>⋮⋮</span>
                <span style={{ color: '#7aa2f7' }}>{t.trait}</span>.{formatTrackField(t.trait, t.field)}
                {t.type !== 'number' && <span style={{ color: '#667', fontSize: 9 }}> [{t.type}]</span>}
                {t.path && <span style={{ color: '#566' }}> · {t.path}</span>}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                <TipButton
                  tip="Remove this property"
                  onClick={(e) => { e.stopPropagation(); onRemove(i); }}
                  style={{ background: 'none', border: 'none', color: '#e06060', cursor: 'pointer', fontSize: 12, fontWeight: 'bold', lineHeight: 1, padding: '0 2px' }}
                >✕</TipButton>
              </span>
            </div>
          );
        })}
      </div>
      {/* Multi-select hint — value/frame fields edit a single key, so when several
          are selected we show a count + how to move them instead. */}
      {!selKey && selCount > 1 && (
        <div style={keyBar} title="Drag any selected key to move them together; Delete removes them">
          <span style={{ color: '#7aa2f7', fontSize: 10, fontWeight: 'bold' }}>KEYS</span>
          <span style={{ color: '#889', fontSize: 10 }}>{selCount} selected · drag to retime · Del to remove</span>
        </div>
      )}
      {/* Selected-key inspector — type the exact frame/value of the clicked key. */}
      {selKey && (
        <div style={keyBar} title={`Selected key — ${selKey.label}`}>
          <span style={{ color: '#7aa2f7', fontSize: 10, fontWeight: 'bold' }}>KEY</span>
          <label style={keyLbl} title="Selected key frame (snaps to a whole frame)">f
            <NumBox value={selKey.frame} min={0} step={1} width={44} onSet={onSetKeyFrame} title="Selected key frame" />
          </label>
          <label style={keyLbl} title={KEY_VAL_HINT[selKey.type]}>val
            <KeyValueField val={selKey} onSet={onSetKeyValue} />
          </label>
        </div>
      )}
      {/* No key selected, one property selected — show its value at the playhead. Editing
          it keys the property at the playhead (updates the key there, or adds one). */}
      {!selKey && selCount === 0 && propVal && (
        <div style={keyBar} title={`${propVal.label} — value at the playhead. Editing adds or updates a key at frame ${propVal.frame}.`}>
          <span style={{ color: '#7aa2f7', fontSize: 10, fontWeight: 'bold' }}>VAL</span>
          <label style={keyLbl} title={KEY_VAL_HINT[propVal.type]}>val
            <KeyValueField val={propVal} onSet={onSetPropValue} />
          </label>
          <span style={{ color: '#667', fontSize: 10 }} title="A value edit keys this property at the current playhead frame">keys @ f{propVal.frame}</span>
        </div>
      )}
      <TipButton tip="Add one or more animated properties (Trait.field) under the Animator root" onClick={onAddProperty} style={addBtn}>+ Add Property</TipButton>
      {/* Dopesheet | Curves tabs (Unity places these at the bottom of the property list) */}
      <div style={{ display: 'flex', borderTop: '1px solid #333' }}>
        {(['dopesheet', 'curves'] as const).map((m) => (
          <TipButton
            key={m}
            tip={m === 'dopesheet' ? 'Dopesheet — keyframe timing (diamonds)' : 'Curves — keyframe values + easing (graph)'}
            onClick={() => onSetViewMode(m)}
            style={{ flex: 1, padding: '4px 0', background: viewMode === m ? '#2a2a40' : '#16161f', color: viewMode === m ? '#cdd' : '#778', border: 'none', borderRight: m === 'dopesheet' ? '1px solid #333' : 'none', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11, textTransform: 'capitalize' }}
          >{m}</TipButton>
        ))}
      </div>
      {tip && (
        <div style={{ position: 'fixed', left: tip.x, top: tip.y, zIndex: 10000, background: '#1a1a2e', color: '#ddd', border: '1px solid #555', borderRadius: 4, padding: '5px 9px', fontSize: 11, lineHeight: 1.4, maxWidth: 320, whiteSpace: 'pre-wrap', pointerEvents: 'none', boxShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>{tip.text}</div>
      )}
    </div>
  );
}

export default memo(TrackList);

/** Per-type tooltip for the value field. */
const KEY_VAL_HINT: Record<TrackValueType, string> = {
  number: 'Selected key value',
  boolean: 'Selected key value (off = false, on = true)',
  color: 'Selected key value (color swatch)',
  enum: 'Selected key value (option)',
};

/** Type-aware editor for the selected key's value: a checkbox for boolean, a
 *  color swatch for color, a dropdown for enum, and the numeric box otherwise.
 *  Each widget reads/writes the track's numeric storage (0/1, packed 0xRRGGBB,
 *  option index, or the raw number). */
function KeyValueField({ val, onSet }: { val: { type: TrackValueType; value: number; options?: string[] }; onSet: (v: number) => void }) {
  if (val.type === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={val.value !== 0}
        onChange={(e) => onSet(e.target.checked ? 1 : 0)}
        title="Selected key value"
        style={{ accentColor: '#7aa2f7', cursor: 'pointer' }}
      />
    );
  }
  if (val.type === 'color') {
    return (
      <input
        type="color"
        value={`#${(val.value & 0xffffff).toString(16).padStart(6, '0')}`}
        onChange={(e) => onSet(parseInt(e.target.value.slice(1), 16) | 0)}
        title="Selected key value"
        style={{ width: 40, height: 18, padding: 0, border: '1px solid #444', background: 'none', cursor: 'pointer' }}
      />
    );
  }
  if (val.type === 'enum' && val.options?.length) {
    const opts = val.options;
    const idx = Math.max(0, Math.min(opts.length - 1, Math.round(val.value)));
    return (
      <select
        value={idx}
        onChange={(e) => onSet(Number(e.target.value))}
        title="Selected key value"
        style={{ background: '#0e0e16', color: '#ddd', border: '1px solid #333', borderRadius: 3, fontFamily: 'monospace', fontSize: 11, padding: '1px 2px', maxWidth: 90 }}
      >
        {opts.map((o, i) => <option key={o} value={i}>{o}</option>)}
      </select>
    );
  }
  return <NumBox value={val.value} step={1} width={64} onSet={onSet} title="Selected key value" />;
}

const keyBar: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderTop: '1px solid #333', background: '#1b1b27' };
const keyLbl: React.CSSProperties = { color: '#889', fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 2 };

const addBtn: React.CSSProperties = { margin: 6, background: '#2a2a40', color: '#cdd', border: '1px solid #444', borderRadius: 3, padding: '5px 8px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12 };
