/** Animation Editor top toolbar — Unity-style transport, record, frame field,
 *  clip name, and "Samples" (frame rate). Presentational; the panel wires callbacks. */

import { useEffect, useRef, useState } from 'react';
import { timeToFrame } from './timelineMath';
import { Tooltip } from '../fields';

/** A toolbar button with a custom hover tooltip. Native HTML `title` tooltips do
 *  NOT render in the Electron editor (confirmed: hovering >5s shows nothing), so —
 *  like the Inspector's `Tooltip` — we render our own fixed-position popover. */
export function TipButton({ tip, onClick, disabled, style, children }: {
  tip: string;
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => clear, []);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPos({ x: r.left, y: r.bottom + 4 }); clear(); timer.current = setTimeout(() => setShow(true), 450); }}
      onMouseLeave={() => { clear(); setShow(false); }}
      onMouseDown={() => { clear(); setShow(false); }}
      style={style}
    >
      {children}
      {show && (
        <span style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 10000, background: '#1a1a2e', color: '#ddd', border: '1px solid #555', borderRadius: 4, padding: '5px 9px', fontSize: 11, lineHeight: 1.4, maxWidth: 280, whiteSpace: 'pre-wrap', pointerEvents: 'none', boxShadow: '0 2px 8px rgba(0,0,0,0.5)', fontWeight: 'normal', textTransform: 'none' }}>{tip}</span>
      )}
    </button>
  );
}

export interface ToolbarProps {
  clipName: string;
  onRename: (name: string) => void;
  frameRate: number;
  onSetFrameRate: (fps: number) => void;
  duration: number;
  onSetDuration: (d: number) => void;
  loop: boolean;
  onToggleLoop: () => void;
  playing: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  recording: boolean;
  onToggleRecord: () => void;
  playhead: number; // seconds
  onScrub: (t: number) => void;
  onPrevFrame: () => void;
  onNextFrame: () => void;
  onAddKey: () => void;
  /** Break/unify the tangents of the selected keys (disabled when none selected). */
  onBreakTangents: () => void;
  canBreakTangents: boolean;
  /** Copy the selected keys / paste them (duplicated after the original). */
  onCopyKeys: () => void;
  canCopyKeys: boolean;
  onPasteKeys: () => void;
  canPasteKeys: boolean;
  /** Duplicate the selected keys in one step (Cmd/Ctrl+D). */
  onDuplicateKeys: () => void;
  canDuplicateKeys: boolean;
  onUndo: () => void;
  onRedo: () => void;
  saveMsg: string;
}

export default function AnimationToolbar(p: ToolbarProps) {
  const frame = timeToFrame(p.playhead, p.frameRate);
  return (
    <div style={bar}>
      <TipButton tip="Record — editing a trait field keys the clip at the playhead" onClick={p.onToggleRecord} style={{ ...btn, color: p.recording ? '#fff' : '#e74c3c', background: p.recording ? '#c0392b' : '#2a2a40' }}>●</TipButton>
      <TipButton tip="Jump to start" onClick={() => p.onScrub(0)} style={btn}>⏮</TipButton>
      <TipButton tip="Previous frame ( , )" onClick={p.onPrevFrame} style={btn}>◀</TipButton>
      <TipButton tip={p.playing ? 'Pause (Space)' : 'Play (Space)'} onClick={p.onTogglePlay} style={btn}>{p.playing ? '⏸' : '▶'}</TipButton>
      <TipButton tip="Next frame ( . )" onClick={p.onNextFrame} style={btn}>▶|</TipButton>
      <TipButton tip="Stop (return to start)" onClick={p.onStop} style={btn}>⟲</TipButton>
      <FrameField frame={frame} onSet={(f) => p.onScrub(p.frameRate > 0 ? f / p.frameRate : 0)} />
      <span style={{ color: '#888', width: 56, textAlign: 'right' }}>{p.playhead.toFixed(2)}s</span>

      <span style={sep} />
      <Tooltip text="Clip name" style={{ cursor: 'text' }}><input value={p.clipName} onChange={(e) => p.onRename(e.target.value)} style={{ ...input, width: 120, fontWeight: 'bold' }} /></Tooltip>
      <Tooltip text="Authoring sample rate (frames per second) — Unity's Samples"><label style={lbl}>Samples
        <NumBox value={p.frameRate} min={1} step={1} width={42} onSet={(v) => p.onSetFrameRate(Math.max(1, Math.round(v)))} />
      </label></Tooltip>
      <Tooltip text="Clip length (seconds)"><label style={lbl}>Len
        <NumBox value={p.duration} min={0.1} step={0.1} width={46} onSet={(v) => p.onSetDuration(Math.max(0.1, v))} />
      </label></Tooltip>
      <TipButton tip="Loop playback" onClick={p.onToggleLoop} style={{ ...btn, background: p.loop ? '#2d6cdf' : '#2a2a40' }}>⟳ Loop</TipButton>
      <TipButton tip="Add a keyframe at the playhead on every track (K)" onClick={p.onAddKey} style={btn}>◆<sub style={{ fontSize: 9 }}>+</sub> Key</TipButton>
      <TipButton
        tip={p.canBreakTangents ? 'Break / unify tangents on the selected keys (B) — broken keys get independent in/out handles' : 'Select a keyframe first, then break its tangents (B)'}
        onClick={p.onBreakTangents}
        disabled={!p.canBreakTangents}
        style={{ ...btn, opacity: p.canBreakTangents ? 1 : 0.4, cursor: p.canBreakTangents ? 'pointer' : 'default' }}
      >⋀ Break</TipButton>
      <TipButton
        tip={p.canCopyKeys ? 'Copy the selected keyframes (⌘/Ctrl+C may be intercepted by the OS menu — use this button)' : 'Select keyframes first, then copy'}
        onClick={p.onCopyKeys}
        disabled={!p.canCopyKeys}
        style={{ ...btn, opacity: p.canCopyKeys ? 1 : 0.4, cursor: p.canCopyKeys ? 'pointer' : 'default' }}
      >⧉ Copy</TipButton>
      <TipButton
        tip={p.canPasteKeys ? 'Paste — duplicates the copied keys right after the original, skipping occupied frames' : 'Copy some keyframes first'}
        onClick={p.onPasteKeys}
        disabled={!p.canPasteKeys}
        style={{ ...btn, opacity: p.canPasteKeys ? 1 : 0.4, cursor: p.canPasteKeys ? 'pointer' : 'default' }}
      >⧉ Paste</TipButton>
      <TipButton
        tip={p.canDuplicateKeys ? 'Duplicate the selected keys after the original in one step — ⌘/Ctrl+D (does not touch the copy buffer)' : 'Select keyframes first, then duplicate (⌘/Ctrl+D)'}
        onClick={p.onDuplicateKeys}
        disabled={!p.canDuplicateKeys}
        style={{ ...btn, opacity: p.canDuplicateKeys ? 1 : 0.4, cursor: p.canDuplicateKeys ? 'pointer' : 'default' }}
      >⧉ Dup</TipButton>

      <span style={sep} />
      <TipButton tip="Undo (shared global)" onClick={p.onUndo} style={btn}>↶</TipButton>
      <TipButton tip="Redo (shared global)" onClick={p.onRedo} style={btn}>↷</TipButton>
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 10, color: p.saveMsg.includes('fail') ? '#e74c3c' : '#2ecc71' }}>{p.saveMsg || 'Auto-save'}</span>
    </div>
  );
}

function FrameField({ frame, onSet }: { frame: number; onSet: (f: number) => void }) {
  return <NumBox value={frame} step={1} width={48} onSet={(v) => onSet(Math.max(0, Math.round(v)))} title="Current frame" />;
}

/** Small numeric box that commits on Enter/blur (buffers raw text while focused). */
export function NumBox({ value, onSet, min, step, width, title }: { value: number; onSet: (v: number) => void; min?: number; step?: number; width: number; title?: string }) {
  const [local, setLocal] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setLocal(String(value)); }, [value, focused]);
  const commit = () => { const n = parseFloat(local); if (Number.isFinite(n)) onSet(min !== undefined ? Math.max(min, n) : n); else setLocal(String(value)); };
  return (
    <input
      title={title} type="text" inputMode="decimal" value={local}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onChange={(e) => setLocal(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      step={step}
      style={{ ...input, width, marginLeft: 4 }}
    />
  );
}

const bar: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px', background: '#1d1d2b', borderBottom: '1px solid #333', flexWrap: 'wrap' };
const btn: React.CSSProperties = { background: '#2a2a40', color: '#ccc', border: '1px solid #444', borderRadius: 3, padding: '2px 7px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.2 };
const input: React.CSSProperties = { background: '#0e0e16', color: '#ddd', border: '1px solid #333', borderRadius: 3, padding: '2px 4px', fontFamily: 'monospace', fontSize: 11 };
const lbl: React.CSSProperties = { color: '#999', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 2 };
const sep: React.CSSProperties = { width: 1, alignSelf: 'stretch', background: '#333', margin: '0 4px' };
