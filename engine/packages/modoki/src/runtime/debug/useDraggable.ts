/** useDraggable — pointer-delta drag for the debug overlay windows. No timestamps
 *  (runtime/** determinism guard); presses on `[data-no-drag]` (close buttons) are
 *  ignored so a click there doesn't start a drag. */

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export interface Point { x: number; y: number }

export function useDraggable(initial: Point) {
  const [pos, setPos] = useState<Point>(initial);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    },
    [pos],
  );
  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    if (!drag.current) return;
    setPos({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy });
  }, []);
  const endDrag = useCallback((e: ReactPointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  // onPointerCancel mirrors onPointerUp — without it a cancelled drag (OS gesture,
  // the 3-finger debug toggle mid-drag, touch interruption) leaves drag.current set,
  // so the widget would then follow the cursor on a bare move.
  return { pos, setPos, dragHandlers: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag } };
}
