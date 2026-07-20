/** FloatingWidget — a small, half-transparent, draggable window for a stat widget.
 *  Lives OUTSIDE the fullscreen debug modal so it stays visible while playing.
 *  Anchored to the viewport (shipped game) or the container (editor preview). */

import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { useDraggable } from './useDraggable';
import { setWidgetPos, closeWidget } from './widgetStore';
import type { Point } from './useDraggable';

export function FloatingWidget({
  id,
  title,
  initialPos,
  anchor,
  children,
}: {
  id: string;
  title: string;
  initialPos: Point;
  anchor: 'viewport' | 'container';
  children: ReactNode;
}) {
  const { pos, dragHandlers } = useDraggable(initialPos);

  // Persist the position back to the store so it survives a re-render of the layer.
  useEffect(() => {
    setWidgetPos(id, pos);
  }, [id, pos]);

  return (
    <div style={{ ...widgetStyle, position: anchor === 'container' ? 'absolute' : 'fixed', left: pos.x, top: pos.y }} data-debug-widget={id}>
      <div style={headerStyle} {...dragHandlers}>
        <span style={titleStyle}>{title}</span>
        <button data-no-drag style={closeStyle} onClick={() => closeWidget(id)} aria-label={`Close ${title}`}>
          ✕
        </button>
      </div>
      <div style={bodyStyle}>{children}</div>
    </div>
  );
}

const widgetStyle: CSSProperties = {
  width: 184,
  background: 'rgba(12,12,22,0.62)',
  color: '#e6e6ff',
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 8,
  boxShadow: '0 4px 18px rgba(0,0,0,0.45)',
  backdropFilter: 'blur(5px)',
  WebkitBackdropFilter: 'blur(5px)',
  fontFamily: 'system-ui, sans-serif',
  zIndex: 2147482000, // below the modal, above the game
  overflow: 'hidden',
  pointerEvents: 'auto',
};
const headerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '4px 8px',
  cursor: 'move',
  background: 'rgba(255,255,255,0.05)',
  touchAction: 'none',
  userSelect: 'none',
};
const titleStyle: CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: '#8b8ba7' };
const closeStyle: CSSProperties = { background: 'transparent', border: 'none', color: '#8b8ba7', cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: 2 };
const bodyStyle: CSSProperties = { padding: 8 };
