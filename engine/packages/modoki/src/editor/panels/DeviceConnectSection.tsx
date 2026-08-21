// Device-connect section of the AI panel: type the device IP (or check "Use adb"), click
// Connect. Modoki owns the lease; a game relaunch auto-reconnects (see the plan). Deliberately
// NO auto-connect — the connection is always an explicit click.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  type DeviceStatus,
  type DeviceListReply,
  type AndroidDeviceRow,
  fetchDeviceStatus,
  fetchDeviceList,
  deviceConnect,
  deviceDisconnect,
  deviceSummary,
  deviceButtonLabel,
  looksLikeIp,
  androidRowLabel,
  androidRowNote,
  androidRowSelectable,
} from './deviceConnectModel';

const LEVEL_COLOR: Record<string, string> = { ok: '#2ecc71', off: '#666', action: '#e0a030', error: '#e07a5a' };

function Dot({ level }: { level: string }): React.ReactElement {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: LEVEL_COLOR[level] ?? '#666' }} />;
}

/** The adb device picker (#149) — several Androids can be attached to one Mac, so "Use adb" alone
 *  doesn't say which. A PULL-DOWN: a closed button showing the current phone, opening a list.
 *
 *  Deliberately NOT a native `<select>`, which is what a pull-down would normally be. A native
 *  select's popup is drawn by the OS, outside the DOM — this repo's own agent-facing input surface
 *  (`modoki_tap` and friends) cannot open or click through one, and the same is true of the editor's
 *  e2e specs. This panel exists to be verified by that surface, so it is built from ordinary DOM:
 *  a `combobox` button plus a `listbox` of `option` rows, each with a stable `data-testid` to aim
 *  at, keyboard-operable, and closing on Escape or an outside click. Same affordance, drivable. */
function DevicePicker({
  rows, selected, disabled, thisClone, onSelect,
}: {
  rows: AndroidDeviceRow[];
  selected: string | null;
  disabled: boolean;
  /** This backend's own clone path, from `/api/device/list`'s `self` — so a device THIS editor
   *  claims stays selectable and reads as "in use by this editor" rather than as a rival clone. */
  thisClone?: string;
  onSelect: (serial: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  // Close on an outside click — a popup that survives clicking elsewhere reads as stuck, and this
  // one sits directly over the Connect button beneath it.
  //
  // Escape is handled on the WRAPPER (see `onKeyDown` below), NOT with a `document` keydown
  // listener. A global one is what `keymapOwnership.test.ts` guards against, and correctly: a raw
  // window-level key handler fires no matter which panel the human is working in, which is the
  // "one key firing in three panels at once" bug the keymap registry was built to end. Scoping it
  // to this subtree is also the better behaviour — Escape closes the dropdown only while focus is
  // actually inside it, and an outside click already covers every other way of dismissing it.
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => { document.removeEventListener('mousedown', onDocDown); };
  }, [open]);

  // Anything not selectable is closed over here once, so the button and the list agree.
  const current = rows.find((r) => r.serial === selected) ?? null;
  const closedLabel = current ? androidRowLabel(current) : rows.length ? 'Select a device…' : 'No devices';

  return (
    <div
      ref={wrap}
      style={{ position: 'relative', marginBottom: 8 }}
      data-testid="device-picker"
      onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); } }}
    >
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Android device"
        data-testid="device-picker-button"
        disabled={disabled || rows.length === 0}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
          fontSize: 11, borderRadius: 3, border: '1px solid #555', textAlign: 'left',
          background: disabled ? '#20202a' : '#101018', color: disabled ? '#666' : '#ddd',
          cursor: disabled || rows.length === 0 ? 'default' : 'pointer',
        }}
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{closedLabel}</span>
        <span style={{ color: '#888', flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div role="listbox" aria-label="Android device" data-testid="device-picker-list"
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, marginTop: 2,
            display: 'flex', flexDirection: 'column', borderRadius: 3, overflow: 'hidden',
            border: '1px solid #555', background: '#14141c', boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          }}>
          {rows.map((row) => {
            const selectable = androidRowSelectable(row, thisClone);
            const note = androidRowNote(row, thisClone);
            const isSelected = row.serial === selected;
            return (
              <div
                key={row.serial}
                role="option"
                aria-selected={isSelected}
                aria-disabled={!selectable}
                tabIndex={selectable ? 0 : -1}
                data-testid={`device-row-${row.serial}`}
                onClick={() => { if (selectable) { onSelect(row.serial); setOpen(false); } }}
                onKeyDown={(e) => {
                  if (selectable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(row.serial); setOpen(false); }
                }}
                style={{
                  display: 'flex', alignItems: 'baseline', gap: 8, padding: '5px 8px',
                  background: isSelected ? '#1f2f1f' : 'transparent',
                  opacity: selectable ? 1 : 0.5,
                  cursor: selectable ? 'pointer' : 'default',
                }}
              >
                <span style={{ color: '#2ecc71', width: 8, flexShrink: 0 }}>{isSelected ? '✓' : ''}</span>
                {/* Note STACKED under the label, not beside it. Measured in the running editor: the
                    AI panel is ~250px, and side-by-side clipped the holder mid-pid ("pid 25…") —
                    which is exactly the digit you need to go find the session holding your phone. */}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ color: '#ddd', display: 'block' }}>{androidRowLabel(row)}</span>
                  {note && <span style={{ color: '#999', fontSize: 10, display: 'block', marginTop: 1 }}>{note}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function DeviceConnectSection(): React.ReactElement {
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [ip, setIp] = useState<string>('');
  const [useAdb, setUseAdb] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [deviceList, setDeviceList] = useState<DeviceListReply | null>(null);
  const [serial, setSerial] = useState<string | null>(null);
  const mounted = useRef(true);
  const reqSeq = useRef(0);
  // Pre-fill the IP/adb from the server's remembered target ONCE, so it survives editor restarts
  // (localStorage doesn't — the renderer origin can change between launches). Guarded so it never
  // stomps the user's in-progress typing.
  const hydrated = useRef(false);
  // Same one-shot guard for the serial pre-select (#149) — separate from `hydrated` because the
  // list (and so the attached-device set) can still be loading after the status reply lands.
  const serialHydrated = useRef(false);

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

  const refreshList = useCallback(async () => {
    const list = await fetchDeviceList();
    if (!mounted.current) return;
    setDeviceList(list);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    void refreshList();
    // Same interval as the status poll — a picker showing a phone that was just unplugged is the
    // same staleness class the status poll already guards against.
    const t = setInterval(() => { void refresh(); void refreshList(); }, 2500);
    return () => { mounted.current = false; clearInterval(t); };
  }, [refresh, refreshList]);

  // Pre-select ONCE the list has attached devices: the remembered serial if it's still plugged in,
  // else the single attached device (frictionless — one phone needs no click), else nothing (an
  // ambiguous "several phones, no preference" state requires an explicit choice).
  useEffect(() => {
    if (serialHydrated.current || !deviceList) return;
    const attached = deviceList.android.filter((d) => androidRowSelectable(d, deviceList.self?.clone));
    const remembered = status?.lastTarget?.serial;
    const stillAttached = remembered ? attached.find((d) => d.serial === remembered) : undefined;
    if (stillAttached) { serialHydrated.current = true; setSerial(stillAttached.serial); }
    else if (attached.length === 1) { serialHydrated.current = true; setSerial(attached[0].serial); }
  }, [deviceList, status]);

  const summary = deviceSummary(status);

  // A command's result is fresher than any poll — bump reqSeq so an in-flight refresh() (which
  // guards on `seq !== reqSeq.current`) discards its now-stale result instead of flipping the UI
  // back to the just-dismissed state for a poll interval (L15).
  const commitStatus = useCallback((s: DeviceStatus) => {
    reqSeq.current++;
    if (mounted.current) setStatus(s);
  }, []);

  const androidAttached = deviceList?.android.filter((d) => androidRowSelectable(d, deviceList.self?.clone)) ?? [];

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
        void refreshList();
      }
      return;
    }
    if (!useAdb && !looksLikeIp(ip)) { setNote('Enter the device IP shown in its debug menu (or check “Use adb”).'); return; }
    // Several attached with none picked is ambiguous — the same gate as an empty IP field, since
    // connecting without a serial would leave the backend to guess (#149).
    if (useAdb && androidAttached.length > 1 && !serial) { setNote('Pick which Android to connect to.'); return; }
    setBusy(true); setNote(null);
    try {
      commitStatus(await deviceConnect({ ip: useAdb ? undefined : ip.trim(), useAdb, serial: useAdb ? (serial ?? undefined) : undefined }));
    } catch (e) {
      if (mounted.current) setNote(`Connect failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (mounted.current) setBusy(false);
      void refreshList();
    }
  }, [summary.connected, useAdb, ip, serial, androidAttached.length, commitStatus, refreshList]);

  // User edits mark the form as touched so the one-time server hydration won't overwrite it.
  const onIpChange = (v: string) => { hydrated.current = true; setIp(v); };
  const onAdbChange = (v: boolean) => { hydrated.current = true; setUseAdb(v); };
  const onSerialChange = (v: string) => { serialHydrated.current = true; setSerial(v); };

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
        <input data-ui-id="ai.device.useAdb" data-ui-kind="toggle" data-ui-label="use adb (USB)" type="checkbox" checked={useAdb} disabled={busy || summary.connected} onChange={(e) => onAdbChange(e.target.checked)} />
        Use adb (USB)
      </label>

      {/* adb device picker (#149) — only meaningful in adb mode; the WiFi/IP path is untouched. */}
      {useAdb && (
        deviceList && !deviceList.adb.present
          ? <div style={{ color: '#c99', marginBottom: 8 }}>{deviceList.note ?? 'adb is not installed.'}</div>
          : deviceList && deviceList.android.length === 0
            ? <div style={{ color: '#888', marginBottom: 8 }}>No Android devices attached.</div>
            : deviceList && (
              <DevicePicker
                rows={deviceList.android}
                selected={serial}
                disabled={busy || summary.connected}
                thisClone={deviceList.self?.clone}
                onSelect={onSerialChange}
              />
            )
      )}

      {/* IP + Connect */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          data-ui-id="ai.device.ip" data-ui-kind="field" data-ui-label="device IP"
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
        <button data-ui-id="ai.device.connect" data-ui-kind="button" data-ui-label="connect device" data-ui-state={deviceButtonLabel(status, busy)} onClick={() => void onConnect()} disabled={busy} style={{
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
