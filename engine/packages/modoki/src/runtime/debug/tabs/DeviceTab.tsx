/** Device tab — platform / viewport / display info QA always needs on device.
 *  Dependency-free: reads window/navigator/screen (+ the Capacitor global if present)
 *  and probes the CSS safe-area insets. Runtime-safe (no @capacitor/core import). */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { scrollRootStyle } from '../tabLayout';
import { getRenderSettings, setRenderSettings } from '../../rendering/renderSettings';
import { forceResizeAllSurfaces } from '../../rendering/resizeBus';

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

interface BufferRow { w: number; h: number; cw: number; ch: number }

/** Split every `<canvas>` in the document into the 2D (PixiJS, mounted under
 *  `[data-canvas2d-mount]`) and 3D (everything else — Scene3D's WebGL/WebGPU canvas)
 *  groups and read each one's REAL drawing-buffer size (`.width`/`.height`) alongside
 *  its CSS box (`.clientWidth`/`.clientHeight`), so a pixelRatioCap flip is provable
 *  from the actual buffer, not just the config value. */
function readCanvasBuffers(): { twoD: BufferRow[]; threeD: BufferRow[] } {
  const all = Array.from(document.querySelectorAll('canvas'));
  const twoDSet = new Set(document.querySelectorAll('[data-canvas2d-mount] canvas'));
  const toRow = (c: Element): BufferRow => {
    const canvas = c as HTMLCanvasElement;
    return { w: canvas.width, h: canvas.height, cw: canvas.clientWidth, ch: canvas.clientHeight };
  };
  const twoD: BufferRow[] = [];
  const threeD: BufferRow[] = [];
  for (const c of all) {
    if (twoDSet.has(c)) twoD.push(toRow(c));
    else threeD.push(toRow(c));
  }
  return { twoD, threeD };
}

/** `1`/`2`/`3` pin the backing-resolution multiplier; `0` ('Off') is the engine's existing
 *  "uncapped" sentinel (see renderSettings.ts) — NOT Infinity. */
const CAP_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 0, label: 'Off' },
];

function CapButtonRow({ label, current, onPick }: { label: string; current: number; onPick: (v: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <span style={{ ...keyStyle, width: 18 }}>{label}</span>
      <div style={{ display: 'flex', gap: 4 }}>
        {CAP_OPTIONS.map(({ value, label: btnLabel }) => {
          const active = current === value;
          return (
            <button
              key={btnLabel}
              onClick={() => onPick(value)}
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 4,
                border: `1px solid ${active ? '#7ec8ff' : '#2d5a8a'}`,
                background: active ? '#16223a' : 'transparent',
                color: active ? '#7ec8ff' : '#8b8ba7',
                cursor: 'pointer',
              }}
            >
              {btnLabel}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DeviceTab() {
  const [insets, setInsets] = useState<Insets | null>(null);
  const [debugIp, setDebugIp] = useState<string | null>(null);
  const [buffers, setBuffers] = useState<{ twoD: BufferRow[]; threeD: BufferRow[] }>({ twoD: [], threeD: [] });
  // Bumping this forces a re-render so the Caps row (read live from getRenderSettings()
  // below, not component state) reflects a click immediately.
  const [, bumpCapsTick] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const p = readDebugIp();
    if (p) p.then(setDebugIp).catch(() => setDebugIp(''));
  }, []);

  useEffect(() => {
    // Re-probe insets AND re-render (window-derived rows) on resize/rotation — the
    // safe area is exactly the value most likely to change when the device rotates.
    const refresh = () => setInsets(readInsets());
    const refreshBuffers = () => setBuffers(readCanvasBuffers());
    refresh();
    refreshBuffers();
    window.addEventListener('resize', refresh);
    window.addEventListener('resize', refreshBuffers);
    window.addEventListener('orientationchange', refresh);
    window.addEventListener('orientationchange', refreshBuffers);
    return () => {
      window.removeEventListener('resize', refresh);
      window.removeEventListener('resize', refreshBuffers);
      window.removeEventListener('orientationchange', refresh);
      window.removeEventListener('orientationchange', refreshBuffers);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  function setCap(surface: 'pixi' | 'three', cap: number) {
    const rs = getRenderSettings();
    if (surface === 'pixi') setRenderSettings({ pixi: { ...rs.pixi, pixelRatioCap: cap } });
    else setRenderSettings({ three: { ...rs.three, pixelRatioCap: cap } });
    forceResizeAllSurfaces();
    bumpCapsTick((n) => n + 1);
    // The resize path itself runs synchronously, but a pooled PixiJS Application (and,
    // in principle, three) can land its actual buffer resize on a later frame — wait
    // two rAFs before re-reading the DOM so the readout below reflects the NEW buffer,
    // not a stale one from before the click.
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setBuffers(readCanvasBuffers());
      });
    });
  }

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

  const bufferRowFmt = (b: BufferRow) => `${b.w}×${b.h}  (css ${b.cw}×${b.ch})`;
  const bufferRows: Array<[string, string]> = [];
  if (buffers.twoD.length === 0) {
    bufferRows.push(['2D buffer', '—']);
  } else {
    buffers.twoD.forEach((b, i) => bufferRows.push([
      buffers.twoD.length > 1 ? `2D buffer ${i + 1}` : '2D buffer',
      bufferRowFmt(b),
    ]));
  }
  if (buffers.threeD.length === 0) {
    bufferRows.push(['3D buffer', '—']);
  } else {
    buffers.threeD.forEach((b, i) => bufferRows.push([
      buffers.threeD.length > 1 ? `3D buffer ${i + 1}` : '3D buffer',
      bufferRowFmt(b),
    ]));
  }

  const liveCaps = getRenderSettings();

  return (
    <div style={scrollRootStyle(3)}>
      {/* The IP the user types into Modoki's AI panel → Connect a Device. Full-width + wrapping
          (NOT the truncating row style) so it's never cut off on a narrow device, and selectable.
          Only present when the game-debug plugin is compiled in; '' means WiFi is down. */}
      {debugIp !== null && (
        <div style={ipCalloutStyle}>
          <span style={{ ...keyStyle, color: '#7a7a9a' }}>Debug connect IP — type this into Modoki</span>
          <div style={ipValueStyle}>{debugIp || '— (WiFi down)'}</div>
        </div>
      )}
      {/* Backing-resolution A/B — QA control, not gameplay. Flips pixi/three pixelRatioCap
          live via renderSettings + forceResizeAllSurfaces (resizeBus.ts), no rebuild needed. */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>Backing resolution</div>
        <CapButtonRow label="2D" current={liveCaps.pixi.pixelRatioCap} onPick={(v) => setCap('pixi', v)} />
        <CapButtonRow label="3D" current={liveCaps.three.pixelRatioCap} onPick={(v) => setCap('three', v)} />
        <div style={{ ...rowStyle, marginTop: 4 }}>
          <span style={keyStyle}>Caps (2D/3D)</span>
          <span style={valStyle}>{liveCaps.pixi.pixelRatioCap} / {liveCaps.three.pixelRatioCap}</span>
        </div>
        {bufferRows.map(([k, v]) => (
          <div key={k} style={rowStyle}>
            <span style={keyStyle}>{k}</span>
            <span style={valStyle}>{v}</span>
          </div>
        ))}
      </div>
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
const sectionStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 8, padding: '6px 8px', background: '#16223a', border: '1px solid #2d5a8a', borderRadius: 4 };
const sectionTitleStyle: CSSProperties = { color: '#7ec8ff', fontSize: 12, fontWeight: 600, marginBottom: 2 };
