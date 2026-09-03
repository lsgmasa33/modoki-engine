/** Console — live ECS stats and intercepted console.log output.
 *  Uses virtualized scrolling to handle large log volumes efficiently. */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Actions, type TabNode } from 'flexlayout-react';
import { computeVisibleRange, clampScrollTop, findGapMarkerIndex } from './consoleVirtualization';
import { getAllEntities } from '../../runtime/core/ecs/entityUtils';
import { onStructureDirtyCoalesced } from '../../runtime/core/ecs/entityUtils';
import { getCurrentFPS } from '../../runtime/rendering/frameDriver';
import {
  getEditorLogs, clearEditorLogs, setOnNewLog, getEditorLogsVersion,
  getEditorLogsDropped, getEditorLogsBootPrefixCount,
  type LogEntry,
} from '../consoleCapture';

// Total row height used for virtualization math. Rows are single-line (the full
// message + stack live in the detail pane), so every row is the same height:
// ROW_LINE text line + 2px vertical padding + 1px bottom border.
const ROW_LINE = 18;
const ROW_HEIGHT = ROW_LINE + 3;
const levelColor = { log: '#888', warn: '#f39c12', error: '#e74c3c' };

// F2 (#626/#633 adversarial review): a virtualized ROW, either a real log entry or the synthetic
// gap-disclosure marker inserted at the pinned/tail seam — see `displayRows` below. Modeling the
// marker as a real row (not an overlay drawn on top) is what lets it participate correctly in the
// existing uniform-row-height virtualization math instead of needing a second, parallel one.
type DisplayRow =
  | { kind: 'entry'; entry: LogEntry }
  | { kind: 'gap'; dropped: number };

export default function Console({ node }: { node?: TabNode } = {}) {
  const [version, setVersion] = useState(0); // bump to trigger re-render
  const [stats, setStats] = useState({ entityCount: 0, fps: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(300);
  const [autoScroll, setAutoScroll] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Transient "copied ✓" ack on the detail pane's copy button; cleared whenever the
  // selection moves so it never labels a different entry as copied.
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState('');
  // Level filter + detail-pane height are persisted in the FlexLayout node config
  // so they survive reloads.
  const [showLevels, setShowLevels] = useState<Set<LogEntry['level']>>(() => {
    const saved = node?.getConfig()?.levels as LogEntry['level'][] | undefined;
    return new Set(saved ?? ['log', 'warn', 'error']);
  });
  const [detailHeight, setDetailHeight] = useState<number>(() => {
    const saved = node?.getConfig()?.detailHeight as number | undefined;
    return typeof saved === 'number' ? saved : 160;
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);
  const detailHeightRef = useRef(detailHeight);

  // Log updates — callback fires on each new console.log/warn/error
  useEffect(() => {
    setOnNewLog(() => setVersion(getEditorLogsVersion()));
    return () => { setOnNewLog(null); };
  }, []);

  // Entity count — event-driven via structure-dirty subscriber. Coalesced to one
  // update per frame so a bulk load (many prefab instances) doesn't fire a setState
  // per entity and blow React's update-depth limit.
  useEffect(() => {
    const unsub = onStructureDirtyCoalesced(() => {
      setStats(s => ({ ...s, entityCount: getAllEntities().length }));
    });
    // Initial count
    setStats(s => ({ ...s, entityCount: getAllEntities().length }));
    return unsub;
  }, []);

  // FPS — lightweight 1-second timer (single function call, not full ECS query)
  useEffect(() => {
    const interval = setInterval(() => {
      setStats(s => ({ ...s, fps: getCurrentFPS() }));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [version, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    // Disable auto-scroll if user scrolled up, re-enable if at bottom
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_HEIGHT * 2;
    setAutoScroll(atBottom);
  }, []);

  // Track container height
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Detail-pane resize: drag the handle to set the bottom pane's height.
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizingRef.current || !rootRef.current) return;
      const rect = rootRef.current.getBoundingClientRect();
      const max = Math.max(60, rect.height - 100); // leave room for stats bar + list
      const h = Math.max(60, Math.min(rect.bottom - e.clientY, max));
      detailHeightRef.current = h;
      setDetailHeight(h);
    };
    const onUp = () => {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Persist final height into the layout (once per drag, not per move).
      if (node) {
        node.getModel().doAction(Actions.updateNodeAttributes(node.getId(), {
          config: { ...node.getConfig(), detailHeight: detailHeightRef.current },
        }));
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [node]);

  const clearLogs = () => {
    clearEditorLogs();
    setSelectedId(null); setCopied(false);
    setVersion(getEditorLogsVersion());
    setAutoScroll(true);
    // Reset scroll to the top — the list is now empty, so a leftover large
    // scrollTop would window past the (now zero) content and render blank. (F3)
    setScrollTop(0);
    if (containerRef.current) containerRef.current.scrollTop = 0;
  };

  // The shared ring, projected once per render — reused below instead of calling
  // getEditorLogs() again at each of the three sites that used to read `logBuffer`.
  const logs = getEditorLogs();

  // Filter logs by level and text. Memoized so it recomputes only when the log set
  // (version), the text filter, or the level set actually changes — NOT on every
  // scroll/resize/selection re-render. `version` (bumped per new log / on clear) is
  // the correct invalidation key — `logs` is deliberately NOT a dependency: it is a
  // fresh array on every render, but its CONTENT is fully determined by `version`
  // (the only two things that change the ring's content — a new log, or a clear —
  // are exactly the two things that bump it), so listing it would defeat the memo
  // and re-filter on every scroll/resize/selection re-render instead. (panels F4)
  const filterLower = filter.toLowerCase();
  const filteredLogs = useMemo(
    () => logs.filter(e =>
      showLevels.has(e.level) && (!filterLower || e.message.toLowerCase().includes(filterLower))
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `logs` deliberately omitted, see comment above
    [version, filterLower, showLevels],
  );

  const selectedEntry = selectedId == null ? null : (logs.find(e => e.id === selectedId) ?? null);

  // F2 (#626/#633 adversarial review): the ring's own doc comment (`getConsoleRingDropped`) calls
  // this "THE DISCLOSURE THAT MATTERS" — once the ring wraps, `[pinned] ++ [tail]` is DISCONTIGUOUS,
  // and rendering it as one unbroken list silently implies the app logged nothing across the gap
  // (measured: the toolbar's own `n/total` counter can read a healthy `1000/1000` while the ring is
  // discontiguous underneath it). `ConsoleTab.tsx` (the in-game debug menu's twin of this panel)
  // draws a separator at the seam; this inserts the SAME disclosure as a synthetic ROW at the seam
  // instead of an overlay, so it participates correctly in the virtualization below rather than
  // needing a second, parallel layout pass. The seam-finding itself is `findGapMarkerIndex`
  // (`consoleVirtualization.ts`, unit-tested there) — a panel's DECISIONS belong in a plain `.ts`
  // module, not this `.tsx`, per `docs/editor.md` § Panels.
  //
  // ⚠️ COVERS the pinned/tail seam only — NOT closed by a Clear. `clearEditorLogs()` advances a
  // per-consumer watermark past whatever was visible at Clear time, which can be past the ENTIRE
  // pinned prefix; once every surviving row's `id` is already `> bootPrefixCount`, there is no
  // pinned-side survivor for the seam check to pair with, so `findGapMarkerIndex` correctly (not a
  // bug in itself) returns "no marker" — even though the ring can go on silently evicting the NEW
  // tail forever afterward. Concrete: capacity 1000 / bootPrefix 128, log 2000, Clear, log 2000
  // more — the panel shows seq 3129-4000; the 1128 lines logged AFTER the user's own Clear (seq
  // 2001-3128) were evicted with no marker and no clue, and the toolbar reads a healthy `872/872`.
  // `ConsoleTab.tsx` has the identical limitation — a deliberate PARITY choice between the two
  // projections, not a gap either owes a fix for today. See `consoleVirtualization.test.ts`'s
  // "post-Clear" case, which pins this exact scenario rather than leaving it implied.
  const displayRows = useMemo<DisplayRow[]>(() => {
    const rows: DisplayRow[] = filteredLogs.map((entry) => ({ kind: 'entry', entry }));
    const dropped = getEditorLogsDropped();
    const gapIdx = findGapMarkerIndex(filteredLogs, getEditorLogsBootPrefixCount(), dropped);
    if (gapIdx !== -1) rows.splice(gapIdx, 0, { kind: 'gap', dropped });
    return rows;
  }, [filteredLogs]);

  // Virtualization: rows are uniform-height (ROW_HEIGHT), so offsets are O(1). `displayRows`, not
  // `filteredLogs` — the gap marker (when present) is one MORE row to lay out.
  const totalRows = displayRows.length;

  // When the filtered set shrinks (Clear, or a text/level filter that drops the
  // match count below the current scroll offset), a stale large scrollTop would
  // put the whole window past the end of the content and render blank until a new
  // log lands. Re-clamp scrollTop to the new content height whenever the row count
  // or viewport changes. (panels F3)
  useEffect(() => {
    const clamped = clampScrollTop(scrollTop, viewHeight, totalRows, ROW_HEIGHT);
    if (clamped !== scrollTop) {
      setScrollTop(clamped);
      if (containerRef.current) containerRef.current.scrollTop = clamped;
    }
  }, [totalRows, viewHeight, scrollTop]);

  const { startIdx, endIdx, topSpacer, bottomSpacer } = computeVisibleRange(scrollTop, viewHeight, totalRows, ROW_HEIGHT);
  const visibleRows = displayRows.slice(startIdx, endIdx);

  const toggleLevel = useCallback((level: LogEntry['level']) => {
    const next = new Set(showLevels);
    if (next.has(level)) next.delete(level); else next.add(level);
    setShowLevels(next);
    // Persist into the layout — updating the node config triggers the editor's
    // debounced layout save.
    if (node) {
      node.getModel().doAction(Actions.updateNodeAttributes(node.getId(), {
        config: { ...node.getConfig(), levels: [...next] },
      }));
    }
  }, [showLevels, node]);

  return (
    <div ref={rootRef} style={{ width: '100%', height: '100%', background: '#1a1a2e', color: '#ccc', fontFamily: 'monospace', fontSize: '11px', display: 'flex', flexDirection: 'column' }}>
      {/* Stats bar */}
      <div style={{ height: 32, padding: '0 8px', borderBottom: '1px solid #333', display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, flexWrap: 'nowrap' }}>
        <span style={{ color: '#f1c40f', fontWeight: 'bold', fontSize: '13px' }}>Console</span>
        <span style={{ color: stats.fps >= 55 ? '#2ecc71' : stats.fps >= 30 ? '#f39c12' : '#e74c3c', fontSize: '13px' }}>
          {stats.fps} FPS
        </span>
        <span style={{ color: '#888', fontSize: '13px' }}>
          {stats.entityCount} entities
        </span>
        {/* Level toggle buttons */}
        <button onClick={() => toggleLevel('log')}
          data-ui-id="console.toolbar.level.log" data-ui-kind="toggle" data-ui-label="log"
          style={{ ...toggleBtnStyle, color: showLevels.has('log') ? '#888' : '#444', borderColor: showLevels.has('log') ? '#666' : '#333' }}>
          Log
        </button>
        <button onClick={() => toggleLevel('warn')}
          data-ui-id="console.toolbar.level.warn" data-ui-kind="toggle" data-ui-label="warn"
          style={{ ...toggleBtnStyle, color: showLevels.has('warn') ? '#f39c12' : '#444', borderColor: showLevels.has('warn') ? '#f39c12' : '#333' }}>
          Warn
        </button>
        <button onClick={() => toggleLevel('error')}
          data-ui-id="console.toolbar.level.error" data-ui-kind="toggle" data-ui-label="error"
          style={{ ...toggleBtnStyle, color: showLevels.has('error') ? '#e74c3c' : '#444', borderColor: showLevels.has('error') ? '#e74c3c' : '#333' }}>
          Err
        </button>
        {/* Text filter */}
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter..."
          data-ui-id="console.toolbar.filter" data-ui-kind="field" data-ui-label="filter logs"
          style={{
            flex: 1, minWidth: 60, padding: '2px 6px', fontSize: '11px',
            background: '#1e1e30', border: '1px solid #444', borderRadius: 3,
            color: '#ccc', fontFamily: 'monospace', outline: 'none',
          }}
        />
        <span style={{ color: '#555', fontSize: '11px' }}>
          {/* Entry counts, not row counts — `totalRows` (below) also counts the F2 gap marker
              row, which is not a log line. */}
          {filteredLogs.length}/{logs.length}
        </span>
        {!autoScroll && (
          <button onClick={() => { setAutoScroll(true); }} style={btnStyle}>
            ↓ Follow
          </button>
        )}
        <button onClick={clearLogs} style={btnStyle}
          data-ui-id="console.toolbar.clear" data-ui-kind="button" data-ui-label="clear">
          Clear
        </button>
      </div>

      {/* Virtualized log entries — top/bottom spacers + rendered visible rows */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflow: 'auto', userSelect: 'text', cursor: 'text' }}
      >
        {/* Top spacer for rows above viewport */}
        <div style={{ height: topSpacer }} />
        {visibleRows.map((row) => {
          // F2: the gap-disclosure marker — see `displayRows` above. Same ROW_HEIGHT as a log
          // row (uniform-height virtualization requires it), styled after ConsoleTab.tsx's own
          // gap separator rather than inventing a new presentation.
          if (row.kind === 'gap') {
            return (
              <div key="gap-marker" style={gapRowStyle}>
                — {row.dropped} earlier {row.dropped === 1 ? 'entry' : 'entries'} dropped —
              </div>
            );
          }
          const entry = row.entry;
          const isSelected = entry.id === selectedId;
          return (
            <div
              key={entry.id}
              onClick={() => { setSelectedId(entry.id); setCopied(false); }}
              style={{
                height: ROW_HEIGHT, boxSizing: 'border-box',
                color: levelColor[entry.level],
                background: isSelected ? '#2d2d4a' : undefined,
                borderBottom: '1px solid #1e1e30',
                padding: '1px 8px',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                lineHeight: `${ROW_LINE}px`, cursor: 'pointer',
              }}
            >
              <span style={{ color: '#555', marginRight: 6 }}>{entry.time}</span>
              {entry.message.split('\n', 1)[0]}
            </div>
          );
        })}
        {/* Bottom spacer for rows below viewport */}
        <div style={{ height: bottomSpacer }} />
      </div>

      {/* Resize handle for the detail pane */}
      <div
        onMouseDown={onResizeStart}
        style={{ height: 5, flexShrink: 0, cursor: 'ns-resize', background: '#333', borderTop: '1px solid #222' }}
      />

      {/* Detail pane — shows the full message + stack of the selected log */}
      <div style={{ height: detailHeight, flexShrink: 0, overflow: 'auto', background: '#151525', userSelect: 'text' }}>
        {selectedEntry ? (
          <div style={{ padding: '6px 8px' }}>
            <div style={{ marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ color: '#555' }}>{selectedEntry.time}</span>
              <span style={{ color: levelColor[selectedEntry.level], fontWeight: 'bold', textTransform: 'uppercase' }}>
                {selectedEntry.level}
              </span>
              {/* Copy the WHOLE entry — message first, then stack. A stack pasted without its
                  message line is undiagnosable (the message names the offending value), and a
                  reload wipes the buffer, so grabbing it in one click matters. */}
              <button
                onClick={() => {
                  const { time, level, message, stack } = selectedEntry;
                  const text = `[${time}] ${level.toUpperCase()}: ${message}${stack ? `\n${stack}` : ''}`;
                  void navigator.clipboard.writeText(text).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                }}
                title="Copy message + stack"
                data-ui-id="console.detail.copy" data-ui-kind="button" data-ui-label="copy entry"
                style={{
                  marginLeft: 'auto', background: '#252540', color: '#bbb',
                  border: '1px solid #383858', borderRadius: 3, cursor: 'pointer',
                  fontSize: '10px', fontFamily: 'monospace', padding: '1px 7px',
                }}
              >
                {copied ? 'copied ✓' : 'copy'}
              </button>
            </div>
            <pre style={{
              margin: 0, fontSize: '11px', color: '#ddd',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace',
            }}>
              {selectedEntry.message}
            </pre>
            {selectedEntry.stack && (
              <pre style={{
                margin: '8px 0 0', padding: '6px 8px', borderRadius: 3,
                background: '#101020', fontSize: '10px', color: '#777',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'monospace',
              }}>
                {selectedEntry.stack}
              </pre>
            )}
          </div>
        ) : (
          <div style={{ padding: '10px 8px', color: '#555' }}>
            Select a log line to view its details.
          </div>
        )}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: 'none', border: '1px solid #444', color: '#888',
  cursor: 'pointer', padding: '2px 8px', borderRadius: 3, fontSize: '11px',
};

const toggleBtnStyle: React.CSSProperties = {
  width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'none', border: '1px solid #444',
  cursor: 'pointer', padding: 0, borderRadius: 3, fontSize: '9px',
  fontFamily: 'monospace', fontWeight: 'bold', lineHeight: 1,
};

// F2: the gap-disclosure row — same shape as ConsoleTab.tsx's `gapStyle`, adapted to this panel's
// palette. Fixed at ROW_HEIGHT so it lays out like any other virtualized row — same overflow
// containment as an entry row (`:320`, `whiteSpace`/`overflow`/`textOverflow`), which this row
// needs just as much: dock the panel narrow enough and the "— N earlier entries dropped —" text
// wraps to a second line inside this fixed-height box and overflows into the row below.
const gapRowStyle: React.CSSProperties = {
  height: ROW_HEIGHT, boxSizing: 'border-box',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: '#555', fontStyle: 'italic', fontSize: '10px',
  borderBottom: '1px solid #1e1e30',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};
