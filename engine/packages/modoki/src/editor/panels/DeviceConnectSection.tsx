// Device-connect section of the AI panel: type the device IP (or check "Use adb"), click
// Connect. Modoki owns the lease; a game relaunch auto-reconnects (see the plan). Deliberately
// NO auto-connect — the connection is always an explicit click.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  type DeviceStatus,
  fetchDeviceStatus,
  deviceConnect,
  deviceDisconnect,
  deviceSummary,
  deviceButtonLabel,
  looksLikeIp,
} from './deviceConnectModel';

const LEVEL_COLOR: Record<string, string> = { ok: '#2ecc71', off: '#666', action: '#e0a030', error: '#e07a5a' };

function Dot({ level }: { level: string }): React.ReactElement {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: LEVEL_COLOR[level] ?? '#666' }} />;
}

export default function DeviceConnectSection(): React.ReactElement {
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [ip, setIp] = useState<string>('');
  const [useAdb, setUseAdb] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);
  const reqSeq = useRef(0);
  // Pre-fill the IP/adb from the server's remembered target ONCE, so it survives editor restarts
  // (localStorage doesn't — the renderer origin can change between launches). Guarded so it never
  // stomps the user's in-progress typing.
  const hydrated = useRef(false);

  const refresh = useCallback(async () => {
    const seq = ++reqSeq.current;
    const s = await fetchDeviceStatus();
    if (!mounted.current || seq !== reqSeq.current) return;
    setStatus(s);
    if (!hydrated.current && s?.lastTarget) {
      hydrated.current = true;
      if (s.lastTarget.ip) setIp(s.lastTarget.ip);
      setUseAdb(s.lastTarget.useAdb);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const t = setInterval(() => void refresh(), 2500);
    return () => { mounted.current = false; clearInterval(t); };
  }, [refresh]);

  const summary = deviceSummary(status);

  // A command's result is fresher than any poll — bump reqSeq so an in-flight refresh() (which
  // guards on `seq !== reqSeq.current`) discards its now-stale result instead of flipping the UI
  // back to the just-dismissed state for a poll interval (L15).
  const commitStatus = useCallback((s: DeviceStatus) => {
    reqSeq.current++;
    if (mounted.current) setStatus(s);
  }, []);

  const onConnect = useCallback(async () => {
    if (summary.connected) {
      setBusy(true); setNote(null);
      // Symmetric error handling with the connect branch — a disconnect failure was previously an
      // unhandled promise rejection with no user feedback (L14).
      try {
        commitStatus(await deviceDisconnect());
      } catch (e) {
        if (mounted.current) setNote(`Disconnect failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (mounted.current) setBusy(false);
      }
      return;
    }
    if (!useAdb && !looksLikeIp(ip)) { setNote('Enter the device IP shown in its debug menu (or check “Use adb”).'); return; }
    setBusy(true); setNote(null);
    try {
      commitStatus(await deviceConnect({ ip: useAdb ? undefined : ip.trim(), useAdb }));
    } catch (e) {
      if (mounted.current) setNote(`Connect failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [summary.connected, useAdb, ip, commitStatus]);

  // User edits mark the form as touched so the one-time server hydration won't overwrite it.
  const onIpChange = (v: string) => { hydrated.current = true; setIp(v); };
  const onAdbChange = (v: boolean) => { hydrated.current = true; setUseAdb(v); };

  return (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #22222e' }}>
      <div style={{ color: '#fff', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Connect a Device</div>
      <div style={{ color: '#888', marginBottom: 10, lineHeight: 1.5 }}>
        Debug the game on a phone. Enter the IP from the device’s debug menu, or connect over USB with adb.
      </div>

      {/* Headline status */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', marginBottom: 10,
        borderRadius: 4, background: '#181828', border: `1px solid ${LEVEL_COLOR[summary.level] ?? '#333'}`,
      }}>
        <Dot level={summary.level} />
        <span style={{ color: '#ddd', lineHeight: 1.4 }}>{summary.message}</span>
      </div>

      {/* adb toggle */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#9a9ac0', marginBottom: 8, cursor: 'pointer' }}
        title="Tunnel over USB via `adb forward` (Android). The IP field is not needed.">
        <input type="checkbox" checked={useAdb} disabled={busy || summary.connected} onChange={(e) => onAdbChange(e.target.checked)} />
        Use adb (USB)
      </label>

      {/* IP + Connect */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={ip}
          placeholder="192.168.1.42"
          disabled={useAdb || busy || summary.connected}
          onChange={(e) => onIpChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !summary.connected) void onConnect(); }}
          style={{
            flex: 1, minWidth: 120, padding: '4px 8px', fontSize: 11, borderRadius: 3,
            border: '1px solid #555', background: useAdb ? '#20202a' : '#101018',
            color: useAdb ? '#666' : '#ddd', fontVariantNumeric: 'tabular-nums',
          }}
        />
        <button onClick={() => void onConnect()} disabled={busy} style={{
          padding: '4px 14px', border: '1px solid', borderRadius: 3, fontSize: 11, minWidth: 90,
          borderColor: summary.connected ? '#6a3a3a' : '#3a6a3a',
          background: busy ? '#2a2a3a' : summary.connected ? '#4a2a2a' : '#2a4a2a',
          color: busy ? '#888' : '#fff', cursor: busy ? 'default' : 'pointer',
        }}>{deviceButtonLabel(status, busy)}</button>
      </div>

      {note && <div style={{ color: '#c99', marginTop: 8, whiteSpace: 'pre-wrap' }}>{note}</div>}
    </div>
  );
}
