/** Left column of the Timeline panel — one row per track (aligned to the track body's ROW_H rows,
 *  with a RULER_H spacer up top so the lanes line up with the ruler). Each row shows the track's
 *  type badge, editable target name-path, mute toggle, and delete. A footer adds a new track. */

import { memo } from 'react';
import type { TimelineDef, TrackDef, TrackKind } from '../../../runtime/timeline/types';
import { ROW_H, RULER_H } from '../animation/timelineMath';

const KIND_BADGE: Record<TrackDef['type'], { label: string; color: string }> = {
  animation: { label: 'ANIM', color: '#3f6fb0' },
  activation: { label: 'ACTV', color: '#4d8a5b' },
  signal: { label: 'SIG', color: '#b08b3f' },
  audio: { label: 'AUD', color: '#8a4d8a' },
  control: { label: 'CTRL', color: '#b0553f' },
};

const ADD_KINDS: TrackKind[] = ['animation', 'signal', 'audio', 'activation', 'control'];

function TrackLaneList({
  doc, width, selectedTrack, onSelectTrack, onSetTarget, onToggleMute, onRemoveTrack, onAddTrack,
}: {
  doc: TimelineDef;
  width: number;
  selectedTrack: number | null;
  onSelectTrack: (i: number) => void;
  onSetTarget: (i: number, target: string) => void;
  onToggleMute: (i: number) => void;
  onRemoveTrack: (i: number) => void;
  onAddTrack: (kind: TrackKind) => void;
}) {
  return (
    <div style={{ width, flex: `0 0 ${width}px`, background: '#212127', borderRight: '1px solid #2f2f37', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ height: RULER_H, borderBottom: '1px solid #2f2f37', display: 'flex', alignItems: 'center', padding: '0 6px', fontSize: 10, color: '#8a8a96' }}>Tracks</div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {doc.tracks.map((track, i) => {
          const badge = KIND_BADGE[track.type];
          const selected = selectedTrack === i;
          return (
            <div key={track.id || i} onPointerDown={() => onSelectTrack(i)}
              style={{ height: ROW_H, display: 'flex', alignItems: 'center', gap: 4, padding: '0 4px', cursor: 'pointer',
                background: selected ? '#2b3350' : 'transparent', borderBottom: '1px solid #26262c' }}>
              <span style={{ fontSize: 8, fontWeight: 700, color: '#fff', background: badge.color, borderRadius: 2, padding: '1px 3px' }}>{badge.label}</span>
              <input value={track.target} placeholder="(root)" title="Target — relative name-path from the Director root"
                onChange={(e) => onSetTarget(i, e.target.value)} onPointerDown={(e) => e.stopPropagation()}
                style={{ flex: 1, minWidth: 0, background: '#191919', border: '1px solid #333', color: '#cfcfd6', fontSize: 10, padding: '1px 3px', borderRadius: 2 }} />
              <button title={track.muted ? 'Unmute' : 'Mute'} onClick={(e) => { e.stopPropagation(); onToggleMute(i); }}
                style={{ fontSize: 9, background: 'none', border: 'none', color: track.muted ? '#b05b5b' : '#6a6a76', cursor: 'pointer' }}>{track.muted ? '🔇' : '🔊'}</button>
              <button title="Delete track" onClick={(e) => { e.stopPropagation(); onRemoveTrack(i); }}
                style={{ fontSize: 10, background: 'none', border: 'none', color: '#6a6a76', cursor: 'pointer' }}>✕</button>
            </div>
          );
        })}
      </div>
      <div style={{ borderTop: '1px solid #2f2f37', padding: 4, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
        {ADD_KINDS.map((k) => (
          <button key={k} onClick={() => onAddTrack(k)} title={`Add ${k} track`}
            style={{ fontSize: 9, background: '#2a2a31', border: '1px solid #3a3a42', color: '#bfbfc8', borderRadius: 3, padding: '2px 5px', cursor: 'pointer' }}>+{k}</button>
        ))}
      </div>
    </div>
  );
}

export default memo(TrackLaneList);
