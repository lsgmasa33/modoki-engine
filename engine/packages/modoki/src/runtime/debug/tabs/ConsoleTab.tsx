/** Console tab — the captured console.* ring buffer (see consoleCapture.ts).
 *  On device there's no devtools; this surfaces logs/warnings/errors in the menu.
 *  Newest last, level-filterable, with a Clear button. */

import { useState, useSyncExternalStore, type CSSProperties } from 'react';
import { getConsoleEntries, getConsoleVersion, clearConsoleEntries, subscribeConsole, type ConsoleLevel } from '../consoleCapture';

const levelColor: Record<ConsoleLevel, string> = { log: '#c7c7d9', info: '#7dd3fc', warn: '#fbbf24', error: '#f87171' };

export function ConsoleTab() {
  useSyncExternalStore(subscribeConsole, getConsoleVersion);
  const [level, setLevel] = useState<ConsoleLevel | 'all'>('all');

  const entries = getConsoleEntries().filter((e) => level === 'all' || e.level === level);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {(['all', 'log', 'warn', 'error'] as const).map((l) => (
          <button key={l} style={{ ...pillStyle, ...(level === l ? pillActiveStyle : null) }} onClick={() => setLevel(l)}>
            {l}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button style={pillStyle} onClick={() => clearConsoleEntries()}>Clear</button>
      </div>
      <div style={listStyle}>
        {entries.length === 0 ? (
          <div style={mutedStyle}>No console output captured yet.</div>
        ) : (
          entries.slice(-200).map((e) => (
            <div key={e.seq} style={{ ...entryStyle, color: levelColor[e.level] }}>
              {e.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const pillStyle: CSSProperties = { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', color: '#8b8ba7', cursor: 'pointer', fontSize: 11, padding: '2px 8px', borderRadius: 10 };
const pillActiveStyle: CSSProperties = { background: 'rgba(99,102,241,0.3)', color: '#e6e6ff' };
const listStyle: CSSProperties = { maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, fontFamily: 'ui-monospace, monospace', fontSize: 11 };
const entryStyle: CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '2px 4px', borderRadius: 3, background: 'rgba(255,255,255,0.03)', lineHeight: 1.4 };
const mutedStyle: CSSProperties = { fontSize: 11, color: '#6b6b85', fontStyle: 'italic' };
