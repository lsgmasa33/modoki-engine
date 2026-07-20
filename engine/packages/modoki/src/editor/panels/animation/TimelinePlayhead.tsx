/** The moving playhead line for the Dopesheet/Curves timelines.
 *
 *  It subscribes to `playheadTime` ITSELF, so during preview playback (setPlayhead
 *  ~60fps) only this tiny leaf re-renders — the heavy timeline body (ruler, every
 *  diamond / curve / dot / handle) stays put because its parent view is React.memo'd
 *  and receives no playhead prop. Placed last in the SVG so it draws on top. (B2) */

import { useEditorStore } from '../../store/editorStore';
import { timeToX, type TimelineView } from './timelineMath';

export default function TimelinePlayhead({ view, diamond = false }: { view: TimelineView; diamond?: boolean }) {
  const playhead = useEditorStore((s) => s.playheadTime);
  const x = timeToX(playhead, view);
  return (
    <>
      <line x1={x} y1={0} x2={x} y2="100%" stroke="#e8e8ff" strokeWidth={1} pointerEvents="none" />
      {diamond && <path d={`M ${x} 1 L ${x + 5} 6 L ${x} 11 L ${x - 5} 6 Z`} fill="#e8e8ff" pointerEvents="none" />}
    </>
  );
}
