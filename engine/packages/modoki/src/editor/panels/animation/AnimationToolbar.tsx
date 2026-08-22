/** Animation Editor top toolbar — Unity-style transport, record, frame field,
 *  clip name, and "Samples" (frame rate). Presentational; the panel wires callbacks. */

import { useEffect, useRef, useState } from 'react';
import { timeToFrame } from './timelineMath';
import { Tooltip } from '../fields';
import { saveStatusLabel } from '../useParkedAssetDoc';

/** A toolbar button with a custom hover tooltip. Native HTML `title` tooltips do
 *  NOT render in the Electron editor (confirmed: hovering >5s shows nothing), so —
 *  like the Inspector's `Tooltip` — we render our own fixed-position popover. */
export function TipButton({ tip, onClick, disabled, style, uiId, children }: {
  tip: string;
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
  /** Optional `data-ui-id` so Enact/MCP can aim at the button by selector. */
  uiId?: string;
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
      data-ui-id={uiId}
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
  /** True while this panel holds a scrub/preview envelope — shows ⏹ Exit Preview. */
  inPreview: boolean;
  /** Leave the envelope: revert the previewed pose and return to stopped (re-enables Cmd+S). */
  onExitPreview: () => void;
  /** Is this clip's document unsaved (parked, awaiting Cmd+S)? */
  dirty: boolean;
  /** Transient feedback ("Copied 3 keys", a warning). Shown BESIDE the save status, never
   *  instead of it — the two used to share one span, so any message hid whether the clip
   *  was on disk. */
  statusMsg: string;
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
      {p.inPreview && (
        <TipButton
          tip="Leave preview — reverts the previewed pose to the authored scene and re-enables saving (Cmd+S is disabled while previewing)"
          onClick={p.onExitPreview}
          uiId="animation.transport.exit"
          style={{ ...btn, borderColor: '#e0a05b', color: '#e0a05b' }}
        >⏹ Exit Preview</TipButton>
      )}
      <FrameField frame={frame} onSet={(f) => p.onScrub(p.frameRate > 0 ? f / p.frameRate : 0)} />
      <span style={{ color: '#888', width: 56, textAlign: 'right' }}>{p.playhead.toFixed(2)}s</span>

      <span style={sep} />
      <Tooltip text="Clip name" style={{ cursor: 'text' }}><input value={p.clipName} onChange={(e) => p.onRename(e.target.value)} style={{ ...input, width: 120, fontWeight: 'bold' }} /></Tooltip>
      {/* Both NumBoxes are keyed on the clip so switching clips REMOUNTS them. `editingRef` is set
          from onChange and cleared only by a commit, so a clip swap that never blurs the field — an
          agent changing selection over MCP, the premise of #233 — would keep clip A's typed text and
          then commit it against clip B. The trade is deliberate: renaming the clip also remounts
          these two, discarding an uncommitted number mid-rename. Losing a number you had not
          committed is strictly better than silently writing it to the wrong clip. */}
      <Tooltip text="Authoring sample rate (frames per second) — Unity's Samples"><label style={lbl}>Samples
        <NumBox key={`fps:${p.clipName}`} value={p.frameRate} min={1} step={1} width={42} onSet={(v) => p.onSetFrameRate(Math.max(1, Math.round(v)))} />
      </label></Tooltip>
      <Tooltip text="Clip length (seconds)"><label style={lbl}>Len
        <NumBox key={`len:${p.clipName}`} value={p.duration} min={0.1} step={0.1} width={46} onSet={(v) => p.onSetDuration(Math.max(0.1, v))} />
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
      {p.statusMsg && <span style={{ fontSize: 10, color: '#8a8a96' }}>{p.statusMsg}</span>}
      <span style={{ fontSize: 10, color: p.dirty ? '#f1c40f' : '#2ecc71' }}>{saveStatusLabel(p.dirty)}</span>
    </div>
  );
}

function FrameField({ frame, onSet }: { frame: number; onSet: (f: number) => void }) {
  return <NumBox value={frame} step={1} width={48} onSet={(v) => onSet(Math.max(0, Math.round(v)))} title="Current frame" />;
}

/** Small numeric box that commits on Enter/blur (buffers raw text while editing).
 *
 *  Enter commits DIRECTLY rather than routing through `.blur()` — Chromium only
 *  dispatches focus/blur while `document.hasFocus()`, so an agent-driven session (window
 *  never OS-focused) would otherwise see the commit silently never run (#233). The
 *  trailing `.blur()` below still fires `onBlur` when the window IS focused, re-running
 *  `commit()`; `lastCommittedRef` makes that harmless.
 *
 *  The in-progress-edit tracking is likewise NOT keyed off `onFocus` (same dead-in-an-
 *  unfocused-window problem — it used to gate the resync effect via a `focused` state
 *  that never became true, so an external `value` change could stomp a keystroke mid-
 *  edit without anyone noticing). `editingRef` is set from `onChange` instead, which
 *  fires regardless of OS window focus. */
export function NumBox({ value, onSet, min, step, width, title }: { value: number; onSet: (v: number) => void; min?: number; step?: number; width: number; title?: string }) {
  const [local, setLocal] = useState(String(value));
  const editingRef = useRef(false);
  const lastCommittedRef = useRef<number | null>(null);
  // Clear the latch whenever the value changes from OUTSIDE (undo, another panel, a
  // reselect). It exists only to swallow the trailing blur that Enter fires in the SAME
  // synchronous tick, and that window closes at the next render — held any longer it
  // becomes the very bug this fix removes: re-entering a previously-committed value
  // after an external change would compare equal to the latch and silently do nothing.
  useEffect(() => {
    lastCommittedRef.current = null;
    if (!editingRef.current) setLocal(String(value));
  }, [value]);
  const commit = () => {
    editingRef.current = false;
    const n = parseFloat(local);
    if (!Number.isFinite(n)) { setLocal(String(value)); return; }
    const clamped = min !== undefined ? Math.max(min, n) : n;
    if (clamped !== value && clamped !== lastCommittedRef.current) {
      lastCommittedRef.current = clamped;
      onSet(clamped);
    }
  };
  return (
    <input
      title={title} type="text" inputMode="decimal" value={local}
      onBlur={commit}
      onChange={(e) => { editingRef.current = true; setLocal(e.target.value); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); } }}
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
