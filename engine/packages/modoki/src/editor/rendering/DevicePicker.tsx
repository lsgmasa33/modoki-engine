/** DevicePicker — searchable device dropdown for the GameView toolbar.
 *  One row per device (portrait/landscape is the separate orientation toggle, NOT
 *  duplicate entries), grouped by category, filtered live by a search box. */

import { useEffect, useRef, useState } from 'react';
import { useOverlayEscape } from '../input/useOverlayEscape';
import {
  DEVICE_PRESETS, DEVICE_CATEGORY_ORDER, filterDevices, presetLabel,
  type DevicePreset, type DeviceCategory, type Orientation,
} from '../scene/devicePresets';

interface DevicePickerProps {
  preset: DevicePreset;
  orientation: Orientation;
  onSelect: (p: DevicePreset) => void;
  onToggleOrientation: () => void;
}

export default function DevicePicker({ preset, orientation, onSelect, onToggleOrientation }: DevicePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('mousedown', onDown); };
  }, [open]);
  // Escape closes only the TOP overlay (see useOverlayEscape).
  useOverlayEscape(open, () => setOpen(false), 'device-picker');

  // Focus the search box when opening.
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const results = filterDevices(query, DEVICE_PRESETS);
  const isFree = preset.logicalW <= 0;

  // Group results by category for display.
  const groups = DEVICE_CATEGORY_ORDER
    .map((cat): [DeviceCategory, DevicePreset[]] => [cat, results.filter((d) => d.category === cat)])
    .filter(([, list]) => list.length > 0);

  return (
    <div ref={rootRef} style={{ position: 'relative', fontFamily: 'monospace', fontSize: '13px' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Select device"
        style={{
          display: 'flex', alignItems: 'center', gap: 6, height: 22, padding: '0 8px',
          background: open ? '#2a2a40' : '#333', color: '#ddd', border: '1px solid #555',
          borderRadius: 4, cursor: 'pointer', fontFamily: 'monospace', fontSize: '12px',
        }}
      >
        <span>{isFree ? '🖥️' : '📱'}</span>
        <span>{presetLabel(preset, orientation)}</span>
        <span style={{ color: '#888' }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', top: 26, left: 0, zIndex: 1000, width: 280,
            background: '#1b1b2c', border: '1px solid #555', borderRadius: 6,
            boxShadow: '0 6px 20px rgba(0,0,0,0.5)', overflow: 'hidden',
          }}
        >
          {/* Search + orientation toggle */}
          <div style={{ display: 'flex', gap: 6, padding: 6, borderBottom: '1px solid #333', alignItems: 'center' }}>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search devices…"
              style={{
                flex: 1, background: '#111', color: '#ddd', border: '1px solid #444',
                borderRadius: 4, padding: '4px 6px', fontSize: '12px', fontFamily: 'monospace', outline: 'none',
              }}
            />
            <button
              onClick={onToggleOrientation}
              disabled={isFree}
              title={orientation === 'portrait' ? 'Switch to Landscape' : 'Switch to Portrait'}
              style={{
                height: 26, padding: '0 8px', background: '#333', color: isFree ? '#666' : '#ccc',
                border: '1px solid #555', borderRadius: 4, cursor: isFree ? 'default' : 'pointer', fontSize: '11px',
              }}
            >
              {orientation === 'portrait' ? '⊟ Portrait' : '▭ Landscape'}
            </button>
          </div>

          {/* Device list (grouped, scrollable) */}
          <div style={{ maxHeight: 360, overflowY: 'auto', padding: 4 }}>
            {groups.length === 0 && (
              <div style={{ color: '#777', padding: '8px 6px', fontSize: '12px' }}>No devices match “{query}”.</div>
            )}
            {groups.map(([cat, list]) => (
              <div key={cat}>
                <div style={{ color: '#7a7a9a', fontSize: '10px', textTransform: 'uppercase', padding: '6px 6px 2px', letterSpacing: 0.5 }}>{cat}</div>
                {list.map((d) => {
                  const selected = d.name === preset.name;
                  return (
                    <button
                      key={d.name}
                      onClick={() => { onSelect(d); setOpen(false); setQuery(''); }}
                      style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', width: '100%',
                        background: selected ? '#2d4a6b' : 'transparent', color: selected ? '#fff' : '#cfcfdf',
                        border: 'none', borderRadius: 4, padding: '4px 8px', cursor: 'pointer',
                        fontFamily: 'monospace', fontSize: '12px', textAlign: 'left',
                      }}
                      onMouseEnter={(e) => { if (!selected) (e.currentTarget.style.background = '#26263a'); }}
                      onMouseLeave={(e) => { if (!selected) (e.currentTarget.style.background = 'transparent'); }}
                    >
                      <span>{d.name}</span>
                      {d.logicalW > 0 && <span style={{ color: '#888', fontSize: '11px' }}>{d.logicalW}×{d.logicalH}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
