/** PlayerPrefs tab — read-only view of the current game's persisted key/value store.
 *
 *  Shows every logical key in this game's namespace and its JSON value, refreshed on
 *  an interval so a `set()` elsewhere shows up live. Read-only: editing persisted game
 *  state from the debug menu is deliberately out of scope. Mirrors StoreTab. */

import { useEffect, useState, type CSSProperties } from 'react';
import { PlayerPrefs } from '../../storage';

const REFRESH_MS = 250;

export function PlayerPrefsTab() {
  const [, setTick] = useState(0);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  const f = filter.trim().toLowerCase();
  const keys = PlayerPrefs.keys()
    .filter((k) => !f || k.toLowerCase().includes(f))
    .sort((a, b) => a.localeCompare(b));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <input type="text" placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} style={inputStyle} />
      <div style={listStyle}>
        {keys.length === 0 ? (
          <div style={mutedStyle}>No saved values in this game.</div>
        ) : (
          keys.map((key) => (
            <div key={key} style={rowStyle}>
              <span style={nameStyle}>{key}</span>
              <span style={valueStyle}>{formatPrefValue(PlayerPrefs.get(key))}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatPrefValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      return s.length > 60 ? s.slice(0, 59) + '…' : s;
    } catch {
      return '{…}';
    }
  }
  return String(v);
}

const inputStyle: CSSProperties = { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, color: '#e6e6ff', fontSize: 12, padding: '3px 6px' };
const listStyle: CSSProperties = { maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 };
const rowStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 4px', borderRadius: 3, background: 'rgba(255,255,255,0.03)' };
const nameStyle: CSSProperties = { color: '#8b8ba7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const valueStyle: CSSProperties = { color: '#e6e6ff', fontVariantNumeric: 'tabular-nums', textAlign: 'right', flexShrink: 0, maxWidth: '55%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const mutedStyle: CSSProperties = { fontSize: 11, color: '#6b6b85', fontStyle: 'italic' };
