/** Generic, prop-driven Inspector field inputs — extracted from Inspector.tsx so
 *  the input→onChange wiring and focus-buffering can be unit-tested in isolation
 *  (jsdom + @testing-library/react) without dragging in the Inspector's heavy
 *  transitive deps (model import, texture resolver, three.js preview, store). */

import { useState, useEffect, useCallback, useRef } from 'react';

/** Shared monospace input style for Inspector-style field inputs. */
export const inputStyle: React.CSSProperties = {
  background: '#1e1e30', color: '#ddd', border: '1px solid #444', borderRadius: 2,
  padding: '2px 4px', fontSize: '11px', fontFamily: 'monospace', outline: 'none',
};

/** Distinct look for READ-ONLY field inputs — runtimeOnly read-backs (Animator.activeClip
 *  /fadeFrom, SkeletalAnimator weight/normalizedTime) or fields disabled by context. A
 *  bordered rect reads as "editable input" no matter its colour, so read-only drops the
 *  OUTLINE and instead sits in a distinct lighter "chip": lighter flat background + no
 *  border (transparent keeps height/alignment with sibling fields) + muted text = clearly
 *  display-only, not an input box. Spread AFTER inputStyle. */
export const readOnlyFieldStyle: React.CSSProperties = {
  background: '#2e2e3c', color: '#9d9daf', borderColor: 'transparent', cursor: 'default',
};

/** Hover tooltip used by Inspector-style fields. Renders `text` (pre-wrapped) in a
 *  fixed-position popover after a short delay. */
export function Tooltip({ text, children, style }: { text: string; children: React.ReactNode; style?: React.CSSProperties }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleEnter = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPos({ x: rect.left, y: rect.bottom + 4 });
    timerRef.current = setTimeout(() => setShow(true), 300);
  };
  const handleLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setShow(false);
  };

  return (
    <span onMouseEnter={handleEnter} onMouseLeave={handleLeave} style={{ cursor: 'help', ...style }}>
      {children}
      {show && (
        <div style={{
          position: 'fixed', left: pos.x, top: pos.y, zIndex: 9999,
          background: '#1a1a2e', color: '#ddd', border: '1px solid #555',
          borderRadius: 4, padding: '6px 10px', fontSize: '11px', lineHeight: '1.4',
          maxWidth: 280, whiteSpace: 'pre-wrap', pointerEvents: 'none',
          boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
        }}>{text}</div>
      )}
    </span>
  );
}

/** Placeholder shown for fields whose value differs across a multi-selection. */
export const MIXED_PLACEHOLDER = '----';

/** Local-state input hook: buffers keystrokes while focused so ECS re-renders
 *  don't overwrite in-flight typing. Syncs the ECS value back when not focused.
 *  When `mixed` is true (multi-select with differing values), the input shows
 *  empty (so the MIXED_PLACEHOLDER placeholder is visible) until the user types;
 *  whatever they commit then broadcasts to every selected entity. */
export function useBufferedValue<T>(externalValue: T, onChange: (v: T) => void, parse: (raw: string) => T, mixed = false, validate?: (raw: string) => boolean) {
  const [localValue, setLocalValue] = useState<string>(mixed ? '' : String(externalValue));
  const focusedRef = useRef(false);
  // Sync from ECS when not focused
  useEffect(() => {
    if (!focusedRef.current) setLocalValue(mixed ? '' : String(externalValue));
  }, [externalValue, mixed]);
  const onFocus = useCallback(() => { focusedRef.current = true; }, []);
  const onBlur = useCallback(() => {
    focusedRef.current = false;
    setLocalValue(mixed ? '' : String(externalValue)); // reconcile with ECS — reverts an unaccepted edit
  }, [externalValue, mixed]);
  const handleChange = useCallback((raw: string) => {
    setLocalValue(raw);
    // Mixed-mode (multi-select with differing values): a transient empty string
    // mid-edit (type, then backspace to empty) must NOT broadcast the parse
    // fallback (0 / '') to every selected entity — that's an accidental mass
    // overwrite of a field the user was only starting to edit (F7). Update the
    // local display only; commit once a real value is typed.
    if (mixed && raw === '') return;
    // Optional commit guard (e.g. asset-ref fields): keep an unacceptable value in the
    // local display so the user can keep editing, but DON'T propagate it to the store —
    // onBlur then reverts the display to the last good value. Prevents a stray string
    // (like "1") being committed into a GUID-only reference.
    if (validate && !validate(raw)) return;
    onChange(parse(raw));
  }, [onChange, parse, mixed, validate]);
  // For styling: the currently-shown text is "valid" when there's no guard, or it passes.
  const valid = !validate || validate(localValue);
  return { localValue, onFocus, onBlur, handleChange, valid };
}

export const parseNumber = (s: string) => parseFloat(s) || 0;
export const parseString = (s: string) => s;

/** Clamp `v` to an optional [min, max] range (either bound may be undefined). */
export function clampRange(v: number, min?: number, max?: number): number {
  if (min !== undefined) v = Math.max(min, v);
  if (max !== undefined) v = Math.min(max, v);
  return v;
}

/** Increment `current` by `step` (×`multiplier`) in `direction`, rounded to the step's
 *  own precision (so 0.1 + 0.2 stays 0.3, not 0.30000000004) and clamped to min/max. */
export function applyWheelStep(
  current: number, direction: 1 | -1, step: number, multiplier: number, min?: number, max?: number,
): number {
  const decimals = (String(step).split('.')[1] ?? '').length;
  let v = Number((current + direction * step * multiplier).toFixed(decimals));
  if (min !== undefined) v = Math.max(min, v);
  if (max !== undefined) v = Math.min(max, v);
  return v;
}

/**
 * Adjust a numeric input with the mouse wheel while it is focused. React registers
 * `onWheel` as a *passive* listener (so `preventDefault` is ignored there); we attach our
 * own non-passive listener instead, so the wheel changes the value rather than scrolling
 * the surrounding panel. Fires only while the element is the active (focused) element, so
 * merely hovering and scrolling the panel is unaffected. Hold Shift for ×10 steps.
 * `direction` is +1 (wheel up) / -1 (wheel down).
 */
export function useWheelStep<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  onStep: (direction: 1 | -1, multiplier: number) => void,
  enabled = true,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const handler = (e: WheelEvent) => {
      if (document.activeElement !== el) return; // only when focused
      e.preventDefault();
      onStep(e.deltaY < 0 ? 1 : -1, e.shiftKey ? 10 : 1);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [ref, onStep, enabled]);
}

export function BufferedTextInput({ value, onChange, style, placeholder, mixed, validate, multiline, readOnly }: { value: string; onChange: (v: string) => void; style?: React.CSSProperties; placeholder?: string; mixed?: boolean; validate?: (v: string) => boolean; multiline?: boolean; readOnly?: boolean }) {
  const { localValue, onFocus, onBlur, handleChange, valid } = useBufferedValue(value, onChange, parseString, mixed, validate);
  const invalidStyle = valid ? null : { outline: '1px solid #e06c6c', outlineOffset: -1 };
  // Read-only fields (e.g. runtimeOnly read-backs like Animator.activeClip/fadeFrom) show
  // the live value but reject edits: a native `readOnly` <input> never fires onChange from
  // typing, plus the borderless readOnlyFieldStyle so it reads as plain text, not an input.
  const roStyle = readOnly ? readOnlyFieldStyle : null;
  // Multiline: a <textarea> so Enter inserts a newline (a single-line <input> commits
  // instead) — needed for multi-line Text3D/Text2D. Vertically resizable, min 2 rows.
  if (multiline) {
    return <textarea value={localValue} placeholder={mixed ? MIXED_PLACEHOLDER : placeholder} readOnly={readOnly}
      rows={2} onFocus={onFocus} onBlur={onBlur} onChange={(e) => handleChange(e.target.value)}
      style={{ ...style, resize: 'vertical', minHeight: '2.4em', fontFamily: 'inherit', ...invalidStyle, ...roStyle }} />;
  }
  return <input type="text" value={localValue} placeholder={mixed ? MIXED_PLACEHOLDER : placeholder} readOnly={readOnly}
    onFocus={onFocus} onBlur={onBlur} onChange={(e) => handleChange(e.target.value)}
    title={valid ? undefined : 'Not a valid asset reference — drop an asset or paste its GUID'}
    style={{ ...style, ...invalidStyle, ...roStyle }} />;
}

export function BufferedNumberInput({ value, onChange, step, style, readOnly, mixed, min, max }: { value: number; onChange: (v: number) => void; step?: number; style?: React.CSSProperties; readOnly?: boolean; mixed?: boolean; min?: number; max?: number }) {
  // Enforce the declared range on COMMIT (the field hint's min/max were previously
  // display-only — only the wheel respected them, so a typed value could exceed the
  // cap, e.g. glowSize past its 0.5 seam budget). Clamp inside `parse` so an
  // out-of-range keystroke commits the clamped value; onBlur reconciles the display.
  // Safe against multi-digit entry because every clamped field has min ≤ 0 (you never
  // type up THROUGH the min); a hypothetical large-min field would want a different UI.
  const parse = useCallback((s: string) => clampRange(parseNumber(s), min, max), [min, max]);
  const { localValue, onFocus, onBlur, handleChange } = useBufferedValue(value, onChange, parse, mixed);
  const ref = useRef<HTMLInputElement>(null);
  // Mouse-wheel adjust (focused only). Replaces the spinner arrows we lost moving off
  // `type="number"`; Shift = ×10. Bases the step on the input's current shown value.
  const onStep = useCallback((dir: 1 | -1, mult: number) => {
    handleChange(String(applyWheelStep(parseNumber(ref.current?.value ?? '0'), dir, step ?? 1, mult, min, max)));
  }, [handleChange, step, min, max]);
  useWheelStep(ref, onStep, !readOnly);
  // `type="text"` (not `type="number"`): a number input reports `value === ''` for an
  // incomplete entry like a lone `-`, wiping the minus sign before a digit can follow
  // (negatives were only typeable digit-first then prepending `-`). With a text input the
  // buffered local string preserves the in-progress `-`/`.`; parseNumber still coerces
  // garbage to 0. `inputMode="decimal"` keeps a numeric soft-keyboard on touch devices.
  return <input ref={ref} type="text" inputMode="decimal" value={localValue} placeholder={mixed ? MIXED_PLACEHOLDER : undefined} onFocus={onFocus} onBlur={onBlur} onChange={(e) => handleChange(e.target.value)} style={style} readOnly={readOnly} />;
}
