/** ErrorToaster — slides in a toast when a `console.error` happens, auto-dismisses
 *  after 3s. Fed by the debug console-capture ring buffer (consoleCapture.ts), so it
 *  catches every console.error. Mounted in the debug overlay next to the floating
 *  widgets, so errors surface WHILE PLAYING (not just in the Console tab).
 *
 *  Runtime/** — no wall-clock (setTimeout is allowed; the determinism guard only
 *  forbids Date.now/performance.now/Math.random). */

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { getConsoleEntries, getConsoleVersion, subscribeConsole } from './consoleCapture';

const TOAST_MS = 3000;
const MAX_VISIBLE = 4;

interface Toast {
  id: number;
  text: string;
}

export function ErrorToaster({ anchor }: { anchor: 'viewport' | 'container' }) {
  const version = useSyncExternalStore(subscribeConsole, getConsoleVersion, getConsoleVersion);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const lastSeen = useRef<number | null>(null);
  const timers = useRef<Map<number, number>>(new Map());

  // Watch the console stream for NEW error entries (skip pre-existing ones on mount).
  useEffect(() => {
    const entries = getConsoleEntries();
    const latestSeq = entries.length ? entries[entries.length - 1].seq : 0;
    if (lastSeen.current === null) {
      lastSeen.current = latestSeq; // don't toast errors that predate mount
      return;
    }
    const fresh = entries.filter((e) => e.level === 'error' && e.seq > (lastSeen.current ?? 0));
    lastSeen.current = latestSeq;
    if (fresh.length === 0) return;

    setToasts((prev) => [...prev, ...fresh.map((e) => ({ id: e.seq, text: e.text }))].slice(-MAX_VISIBLE));
    for (const e of fresh) {
      const t = window.setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== e.seq));
        timers.current.delete(e.seq);
      }, TOAST_MS);
      timers.current.set(e.seq, t);
    }
  }, [version]);

  // Clear pending timers on unmount.
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) window.clearTimeout(t);
      map.clear();
    };
  }, []);

  const dismiss = (id: number) => {
    const t = timers.current.get(id);
    if (t) {
      window.clearTimeout(t);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((x) => x.id !== id));
  };

  if (toasts.length === 0) return null;

  return (
    <div style={{ ...containerStyle, position: anchor === 'container' ? 'absolute' : 'fixed' }} data-debug-toaster>
      {toasts.map((t) => (
        <div key={t.id} style={toastStyle} onClick={() => dismiss(t.id)} role="alert" title="click to dismiss">
          <span style={iconStyle}>⚠</span>
          <span style={textStyle}>{t.text}</span>
        </div>
      ))}
      <style>{`@keyframes debug-toast-in { from { transform: translateX(24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`}</style>
    </div>
  );
}

const containerStyle: CSSProperties = {
  right: 12,
  bottom: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  maxWidth: 340,
  zIndex: 2147482500, // above the floating widgets, below the modal
  pointerEvents: 'none',
  fontFamily: 'system-ui, sans-serif',
};
const toastStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  background: 'rgba(120,20,28,0.92)',
  border: '1px solid rgba(248,113,113,0.6)',
  color: '#fee2e2',
  borderRadius: 8,
  padding: '10px 12px',
  boxShadow: '0 6px 22px rgba(0,0,0,0.45)',
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
  fontSize: 12,
  lineHeight: 1.4,
  cursor: 'pointer',
  pointerEvents: 'auto',
  animation: 'debug-toast-in 200ms ease-out',
};
const iconStyle: CSSProperties = { flexShrink: 0, fontSize: 14, lineHeight: 1.2 };
const textStyle: CSSProperties = {
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  wordBreak: 'break-word',
};
