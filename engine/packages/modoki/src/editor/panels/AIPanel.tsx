// AI panel — "Connect Claude Code". A dockable panel (session/connection surface, so
// dockable not modal) that wires the user's own Claude Code to the live editor in one
// click: it writes a machine-correct .mcp.json into the open project and shows the live
// Backend/Vite/CDP ports + connection status. See docs/connect-claude-code.md.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ConnectStatus,
  type ConnectResult,
  connectionSummary,
  portRows,
  runInstruction,
} from './aiPanelModel';
import DeviceConnectSection from './DeviceConnectSection';
import AiCaptureSection from './AiCaptureSection';

/** Access the whitelisted preload invoke bridge (null outside the Electron editor). */
function electronInvoke<T = unknown>(channel: string, payload?: unknown): Promise<T> | null {
  const inv = (window as unknown as { __modokiElectron?: { invoke?: (c: string, p?: unknown) => Promise<unknown> } })
    .__modokiElectron?.invoke;
  return inv ? (inv(channel, payload) as Promise<T>) : null;
}

const LEVEL_COLOR: Record<string, string> = { ok: '#2ecc71', down: '#e07a5a', off: '#666', action: '#e0a030', error: '#e07a5a' };

const btn = (extra: React.CSSProperties = {}): React.CSSProperties => ({
  padding: '4px 12px', border: '1px solid #555', borderRadius: 3,
  background: '#2a2a40', color: '#ccc', cursor: 'pointer', fontSize: 11, ...extra,
});

function Dot({ level }: { level: string }): React.ReactElement {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: LEVEL_COLOR[level] ?? '#666' }} />;
}

export default function AIPanel(): React.ReactElement {
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const mounted = useRef(true);
  // Monotonic request id: the status handler awaits an 800ms probe and handlers run
  // concurrently, so an earlier poll can resolve AFTER a later refresh (e.g. after a
  // Connect) and clobber it with a stale snapshot. Apply a result only if it's current.
  const reqSeq = useRef(0);

  const refresh = useCallback(async () => {
    const p = electronInvoke<ConnectStatus | null>('modoki:connect-claude-status');
    if (!p) { setLoaded(true); return; } // not in Electron
    const seq = ++reqSeq.current;
    try {
      const s = await p;
      if (mounted.current && seq === reqSeq.current) { setStatus(s); setLoaded(true); }
    } catch { /* transient — keep the last status */ }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const t = setInterval(() => void refresh(), 2500);
    return () => { mounted.current = false; clearInterval(t); };
  }, [refresh]);

  const connect = useCallback(async () => {
    const p = electronInvoke<ConnectResult>('modoki:connect-claude');
    if (!p) return;
    setBusy(true); setNote(null);
    try {
      const r = await p;
      setNote(r.ok
        ? `Wrote ${r.mcpPath}${r.gitignored ? ' (added to .gitignore)' : ''}.${r.claudeMdWritten ? '\nAdded a CLAUDE.md primer so Claude knows this engine.' : ''}${r.cdpSkipped ? `\n⚠ ${r.cdpSkipped}` : ''}${r.mcpTrackedWarning ? `\n⚠ ${r.mcpTrackedWarning}` : ''}`
        : `Connect failed: ${r.error ?? 'unknown error'}`);
      await refresh();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [refresh]);

  const toggleCdp = useCallback(async (on: boolean) => {
    const p = electronInvoke<{ ok: boolean; error?: string }>('modoki:set-cdp-enabled', on);
    if (!p) return;
    setBusy(true); setNote(on ? 'Enabling renderer debugging — the editor will relaunch…' : 'Disabling renderer debugging — the editor will relaunch…');
    try {
      const r = await p; // packaged: app relaunches (may not resolve); dev: returns an error
      if (r && !r.ok && r.error) setNote(r.error);
    } catch (err) {
      if (mounted.current) setNote(`Renderer debugging toggle failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  const copy = useCallback(async (text: string, key: string) => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (!mounted.current) return;
      setCopied(key);
      setTimeout(() => { if (mounted.current) setCopied((c) => (c === key ? null : c)); }, 1200);
    } catch {
      if (mounted.current) setNote('Copy failed — clipboard unavailable.');
    }
  }, []);

  if (!loaded) {
    return <div style={{ padding: 16, color: '#888', fontSize: 12 }}>Checking connection…</div>;
  }

  if (status == null) {
    return (
      <div style={{ padding: 16, color: '#9a9ac0', fontSize: 12, lineHeight: 1.6 }}>
        The AI connection is only available in the Modoki desktop editor.
      </div>
    );
  }

  const summary = connectionSummary(status);
  const rows = portRows(status);
  // Run `claude` where the CONFIG is, not where the project is — for an in-repo game
  // they differ (C9, §13). Falls back to the project root for an older main process.
  const instruction = runInstruction(status.mcpDir ?? status.projectRoot);

  return (
    <div style={{ padding: '12px 14px', fontSize: 11, color: '#ccc', overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>Connect Claude Code</span>
      </div>
      <div style={{ color: '#888', marginBottom: 12, lineHeight: 1.5 }}>
        Wire your own Claude Code to this live editor — one click writes <code>.mcp.json</code> into the open project.
      </div>

      {/* Headline status */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', marginBottom: 12,
        borderRadius: 4, background: '#181828', border: `1px solid ${LEVEL_COLOR[summary.level] ?? '#333'}`,
      }}>
        <Dot level={summary.level} />
        <span style={{ color: '#ddd', lineHeight: 1.4 }}>{summary.message}</span>
      </div>

      {/* Ports */}
      <div style={{ marginBottom: 12 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px', borderBottom: '1px solid #22222e' }}>
            <Dot level={r.level} />
            <span style={{ flex: 1, color: '#aaa' }}>{r.label}</span>
            <span style={{ color: r.level === 'off' ? '#666' : r.level === 'down' ? '#e07a5a' : '#ddd', fontVariantNumeric: 'tabular-nums' }}>{r.value}</span>
          </div>
        ))}
        {/* WHOSE editor answered on the CDP port — the diagnostic for "in use by another
            editor" (its renderer is served from a different Vite origin than ours). */}
        {status.cdpReachable && status.cdpOurs === false && status.cdpForeignPageUrl && (
          <div style={{ color: '#8a8a9a', fontSize: 10, padding: '2px 2px 0 16px' }}>
            answered by: {status.cdpForeignPageUrl}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px' }}>
          <Dot level={status.claude.found ? 'ok' : 'action'} />
          <span style={{ flex: 1, color: '#aaa' }}>claude CLI</span>
          <span style={{ color: status.claude.found ? '#2ecc71' : '#e0a030' }}>{status.claude.found ? 'found' : 'not found'}</span>
        </div>
        {/* WHICH file we actually read/write. For an in-repo game this is the REPO ROOT's
            .mcp.json, not the game folder's — claude only searches upward from its cwd, so
            a config in the game folder would be invisible to the `claude` the developer
            runs. The user can't infer this, so the panel states it (C9, §13). */}
        {status.mcpPath && (
          <div style={{ padding: '6px 2px 0 2px', borderTop: '1px solid #22222e', marginTop: 2 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: '#aaa', flexShrink: 0 }}>Config</span>
              <code style={{ flex: 1, color: '#cdd', fontSize: 10, wordBreak: 'break-all', textAlign: 'right' }}>{status.mcpPath}</code>
            </div>
            {status.mcpLocation === 'ancestor' && (
              <div style={{ color: '#8a8a9a', fontSize: 10, marginTop: 3 }}>
                a parent of this project — `claude` reads this one, not the game folder
              </div>
            )}
            {/* Tracked ⇒ the background heal deliberately leaves it alone, so the user must
                know why their port stops auto-following the editor. */}
            {status.mcpTracked && (
              <div style={{ color: '#8a8a9a', fontSize: 10, marginTop: 3 }}>
                tracked by git — not rewritten automatically; Reconnect edits it explicitly
              </div>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {summary.action && (
          <button onClick={connect} disabled={busy} style={btn({
            background: busy ? '#2a2a3a' : '#2a4a2a', borderColor: '#3a6a3a',
            color: busy ? '#888' : '#fff', cursor: busy ? 'default' : 'pointer', minWidth: 90,
          })}>{busy ? 'Working…' : summary.action}</button>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#9a9ac0', cursor: status.isPackaged ? 'pointer' : 'not-allowed' }}
          title={status.isPackaged ? 'Chrome DevTools Protocol lets Claude inspect the live renderer. On by default; uncheck to close the 127.0.0.1 debug port (relaunches the editor).' : 'In dev, CDP is set via MODOKI_CDP_PORT in launch-editor.sh.'}>
          <input type="checkbox" checked={status.cdpEnabled} disabled={busy || !status.isPackaged}
            onChange={(e) => void toggleCdp(e.target.checked)} />
          Renderer debugging (CDP)
        </label>
      </div>

      {/* Run instruction */}
      {status.mcpWritten && (
        <div style={{ background: '#181828', border: '1px solid #2a2a3a', borderRadius: 4, padding: '8px 10px', marginBottom: 10 }}>
          <div style={{ color: '#888', marginBottom: 6 }}>Then, in a terminal:</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={{ flex: 1, color: '#cdd', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{instruction}</code>
            <button onClick={() => void copy(instruction, 'cmd')} style={btn({ padding: '2px 8px' })}>{copied === 'cmd' ? 'Copied' : 'Copy'}</button>
          </div>
          <div style={{ color: '#666', marginTop: 6 }}>Approve the “modoki”{status.cdpEnabled ? ' and “chrome-devtools”' : ''} MCP server when prompted.</div>
        </div>
      )}

      {!status.claude.found && (
        <a href="https://claude.com/claude-code" target="_blank" rel="noreferrer" style={{ color: '#5aa0e0', display: 'inline-block', marginBottom: 8 }}>
          Install Claude Code ↗
        </a>
      )}

      {note && <div style={{ color: '#9a9', marginTop: 6, whiteSpace: 'pre-wrap' }}>{note}</div>}

      <DeviceConnectSection />
      <AiCaptureSection />
    </div>
  );
}
