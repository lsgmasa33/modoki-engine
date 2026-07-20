/** Device tab — platform / viewport / display info QA always needs on device.
 *  Dependency-free: reads window/navigator/screen (+ the Capacitor global if present)
 *  and probes the CSS safe-area insets. Runtime-safe (no @capacitor/core import). */

import { useEffect, useState, type CSSProperties } from 'react';

interface Insets { top: string; right: string; bottom: string; left: string }

function readInsets(): Insets {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;' +
    'padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);' +
    'padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const insets = { top: cs.paddingTop, right: cs.paddingRight, bottom: cs.paddingBottom, left: cs.paddingLeft };
  probe.remove();
  return insets;
}

function platform(): string {
  const cap = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  if (cap?.getPlatform) return cap.getPlatform();
  return 'web';
}

/** The device's WiFi IP from the game-debug plugin (native), for typing into Modoki's
 *  device Connect field. null = plugin absent (web/release); '' = WiFi down. */
function readDebugIp(): Promise<string> | null {
  const gd = (window as unknown as {
    Capacitor?: { Plugins?: { GameDebug?: { getDeviceIp?: () => Promise<{ ip: string }> } } };
  }).Capacitor?.Plugins?.GameDebug;
  if (!gd?.getDeviceIp) return null;
  return gd.getDeviceIp().then((r) => r?.ip ?? '');
}

export function DeviceTab() {
  const [insets, setInsets] = useState<Insets | null>(null);
  const [debugIp, setDebugIp] = useState<string | null>(null);

  useEffect(() => {
    const p = readDebugIp();
    if (p) p.then(setDebugIp).catch(() => setDebugIp(''));
  }, []);

  useEffect(() => {
    // Re-probe insets AND re-render (window-derived rows) on resize/rotation — the
    // safe area is exactly the value most likely to change when the device rotates.
    const refresh = () => setInsets(readInsets());
    refresh();
    window.addEventListener('resize', refresh);
    window.addEventListener('orientationchange', refresh);
    return () => {
      window.removeEventListener('resize', refresh);
      window.removeEventListener('orientationchange', refresh);
    };
  }, []);

  const nav = navigator as Navigator & { deviceMemory?: number };
  const rows: Array<[string, string]> = [
    ['Platform', platform()],
    ['Viewport', `${window.innerWidth} × ${window.innerHeight}`],
    ['Screen', `${window.screen.width} × ${window.screen.height}`],
    ['DPR', String(window.devicePixelRatio)],
    ['Orientation', window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait'],
    ['CPU cores', String(nav.hardwareConcurrency ?? '—')],
    ['Device memory', nav.deviceMemory ? `${nav.deviceMemory} GB` : '—'],
    ['Language', nav.language],
    ['Online', nav.onLine ? 'yes' : 'no'],
    ['Safe area', insets ? `${insets.top} ${insets.right} ${insets.bottom} ${insets.left}` : '—'],
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {/* The IP the user types into Modoki's AI panel → Connect a Device. Full-width + wrapping
          (NOT the truncating row style) so it's never cut off on a narrow device, and selectable.
          Only present when the game-debug plugin is compiled in; '' means WiFi is down. */}
      {debugIp !== null && (
        <div style={ipCalloutStyle}>
          <span style={{ ...keyStyle, color: '#7a7a9a' }}>Debug connect IP — type this into Modoki</span>
          <div style={ipValueStyle}>{debugIp || '— (WiFi down)'}</div>
        </div>
      )}
      {rows.map(([k, v]) => (
        <div key={k} style={rowStyle}>
          <span style={keyStyle}>{k}</span>
          <span style={valStyle}>{v}</span>
        </div>
      ))}
      <div style={{ ...rowStyle, marginTop: 4 }}>
        <span style={keyStyle}>User agent</span>
      </div>
      <div style={uaStyle}>{navigator.userAgent}</div>
    </div>
  );
}

const rowStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 };
const keyStyle: CSSProperties = { color: '#8b8ba7', flexShrink: 0 };
const valStyle: CSSProperties = { color: '#e6e6ff', fontVariantNumeric: 'tabular-nums', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const uaStyle: CSSProperties = { color: '#8b8ba7', fontSize: 10, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all', lineHeight: 1.4 };
const ipCalloutStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 6, padding: '6px 8px', background: '#16223a', border: '1px solid #2d5a8a', borderRadius: 4 };
const ipValueStyle: CSSProperties = { color: '#7ec8ff', fontSize: 18, fontFamily: 'ui-monospace, monospace', fontWeight: 600, wordBreak: 'break-all', userSelect: 'text', WebkitUserSelect: 'text' };
