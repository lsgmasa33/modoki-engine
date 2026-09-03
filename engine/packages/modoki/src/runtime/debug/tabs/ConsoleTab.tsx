/** Console tab — the captured console.* ring buffer (see consoleCapture.ts).
 *  On device there's no devtools; this surfaces logs/warnings/errors in the menu.
 *  Newest last, level-filterable, with a Clear button. */

import { Fragment, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { fillRootStyle, fillRegionStyle } from '../tabLayout';
import {
  getConsoleEntries, getConsoleVersion, clearConsoleEntries, subscribeConsole,
  getConsoleDropped, getConsoleBootPrefixCount, type ConsoleLevel,
} from '../consoleCapture';

const levelColor: Record<ConsoleLevel, string> = { log: '#c7c7d9', info: '#7dd3fc', warn: '#fbbf24', error: '#f87171' };

export function ConsoleTab() {
  useSyncExternalStore(subscribeConsole, getConsoleVersion);
  const [level, setLevel] = useState<ConsoleLevel | 'all'>('all');

  const entries = getConsoleEntries().filter((e) => level === 'all' || e.level === level);
  // The disclosure `consoleRing.ts`'s `getConsoleRingDropped()` exists for: once the ring wraps,
  // `[pinned] ++ [tail]` is DISCONTIGUOUS, and rendering it as one unbroken list would silently
  // imply the app logged nothing across the gap. `bootPrefixCount` is the seq boundary between the
  // two halves — a separator is drawn exactly where a rendered entry crosses it, only when
  // `dropped > 0` (nothing was ever evicted otherwise) and only when the transition is actually
  // VISIBLE in this filtered/sliced list (a level filter or a Clear can hide the pinned half
  // entirely, in which case there is no "last pinned entry" to anchor the marker to).
  const dropped = getConsoleDropped();
  const bootPrefixCount = getConsoleBootPrefixCount();

  return (
    <div style={fillRootStyle(6)}>
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
          entries.slice(-200).map((e, i, visible) => (
            <Fragment key={e.seq}>
              {dropped > 0 && i > 0 && visible[i - 1].seq <= bootPrefixCount && e.seq > bootPrefixCount && (
                <div style={gapStyle}>— {dropped} earlier {dropped === 1 ? 'entry' : 'entries'} dropped —</div>
              )}
              <div style={{ ...entryStyle, color: levelColor[e.level] }}>
                {e.text}
              </div>
            </Fragment>
          ))
        )}
      </div>
    </div>
  );
}

const pillStyle: CSSProperties = { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', color: '#8b8ba7', cursor: 'pointer', fontSize: 11, padding: '2px 8px', borderRadius: 10 };
const pillActiveStyle: CSSProperties = { background: 'rgba(99,102,241,0.3)', color: '#e6e6ff' };
const listStyle: CSSProperties = { ...fillRegionStyle, display: 'flex', flexDirection: 'column', gap: 2, fontFamily: 'ui-monospace, monospace', fontSize: 11 };
const entryStyle: CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '2px 4px', borderRadius: 3, background: 'rgba(255,255,255,0.03)', lineHeight: 1.4 };
const mutedStyle: CSSProperties = { fontSize: 11, color: '#6b6b85', fontStyle: 'italic' };
const gapStyle: CSSProperties = { fontSize: 10, color: '#6b6b85', fontStyle: 'italic', textAlign: 'center', padding: '3px 0' };
