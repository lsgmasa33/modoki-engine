/** Journal tab — the tick-stamped semantic event trace (`emit`/journalEvents).
 *
 *  Shows the recent event stream newest-first with an optional type filter and a
 *  clear button. The journal is OFF in a normal shipped game build (gated on
 *  `__MODOKI_EDITOR__ || build.enableJournal`) to keep `emit()` allocation-free on
 *  hot paths — so when it's disabled we say so rather than showing an empty list. */

import { useEffect, useState, type CSSProperties } from 'react';
import { journalEvents, clearJournal, isJournalEnabled, type GameEvent } from '../../systems/journal';

const REFRESH_MS = 300;
const MAX_ROWS = 100;

export function JournalTab() {
  const [, setTick] = useState(0);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  if (!isJournalEnabled()) {
    return <div style={mutedStyle}>Journal is disabled in this build. Enable via the editor or project.config.json <code>build.enableJournal</code>.</div>;
  }

  const all = journalEvents();
  const f = filter.trim().toLowerCase();
  const rows = (f ? all.filter((e) => e.type.toLowerCase().includes(f)) : all).slice(-MAX_ROWS).reverse();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          placeholder="filter by type…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={inputStyle}
        />
        <button style={btnStyle} onClick={() => { clearJournal(); setTick((t) => t + 1); }}>Clear</button>
      </div>
      <div style={listStyle}>
        {rows.length === 0 ? (
          <div style={mutedStyle}>{all.length === 0 ? 'No events yet.' : 'No events match the filter.'}</div>
        ) : (
          rows.map((e, i) => <EventRow key={`${e.cap}-${i}`} event={e} />)
        )}
      </div>
    </div>
  );
}

function EventRow({ event }: { event: GameEvent }) {
  return (
    <div style={eventRowStyle}>
      <span style={tickStyle}>{event.tick}</span>
      <span style={typeStyle}>{event.type}</span>
      {event.payload != null && <span style={payloadStyle}>{summarize(event.payload)}</span>}
    </div>
  );
}

function summarize(payload: unknown): string {
  if (typeof payload === 'object') {
    try {
      const s = JSON.stringify(payload);
      return s.length > 80 ? s.slice(0, 79) + '…' : s;
    } catch {
      return '{…}';
    }
  }
  return String(payload);
}

const inputStyle: CSSProperties = { flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, color: '#e6e6ff', fontSize: 12, padding: '3px 6px' };
const btnStyle: CSSProperties = { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', color: '#c4b5fd', cursor: 'pointer', fontSize: 12, padding: '3px 8px', borderRadius: 4 };
const listStyle: CSSProperties = { maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 };
const eventRowStyle: CSSProperties = { display: 'flex', gap: 6, alignItems: 'baseline', padding: '2px 4px', borderRadius: 3, background: 'rgba(255,255,255,0.03)' };
const tickStyle: CSSProperties = { color: '#6b6b85', fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right', flexShrink: 0 };
const typeStyle: CSSProperties = { color: '#a5b4fc', fontWeight: 600, flexShrink: 0 };
const payloadStyle: CSSProperties = { color: '#8b8ba7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const mutedStyle: CSSProperties = { fontSize: 11, color: '#6b6b85', fontStyle: 'italic', lineHeight: 1.5 };
