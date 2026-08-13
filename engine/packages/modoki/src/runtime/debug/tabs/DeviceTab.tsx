/** Device tab — platform / viewport / display info QA always needs on device.
 *  Dependency-free: reads window/navigator/screen (+ the Capacitor global if present)
 *  and probes the CSS safe-area insets. Runtime-safe (no @capacitor/core import). */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { scrollRootStyle } from '../tabLayout';
import {
  getRenderSettings, setRenderSettings, getActiveQualityTier,
  getEffectiveThreeSettings, getEffectivePixiSettings, getActiveTierOverrides,
} from '../../rendering/renderSettings';
import { applyQualityTier } from '../../rendering/tierCalibration';
import { runProbeForDiagnostics } from '../../rendering/tierResolve';
import { TIER_ORDER, type QualityTier } from '../../rendering/qualityTier';
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
/** ⚠️ `pixelRatioCap` is a FLOAT, not an enum — `basePixelRatio` is `Math.min(dpr, cap)`
 *  (`webCanvasSizing.ts`), so a fractional cap is ordinary, not a special case. Fractional is in
 *  fact the NORM on Android: a Galaxy A23 reports `devicePixelRatio: 1.875`, and `demos/video-demo`
 *  already authors `1.5`.
 *
 *  1.5 earns its place beside the integers because it is where the interesting answer lives: on an
 *  A23, DPR 1 is 0.31 Mpx and DPR 2 (i.e. its native 1.875) is 1.08 Mpx — a 3.5x jump that costs
 *  ~2.2 ms of GPU and drops the frame under 60. 1.5 sits between them, and without a button for it
 *  the only way to try the middle of that range was to edit a config and rebuild. */
const CAP_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: '1' },
  { value: 1.5, label: '1.5' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 0, label: 'Off' },
];

/** `Infinity` is the tier's own "unclamped" identity (`UNCLAMPED_OVERRIDES`); an authored `0`
 *  ("Off") means the same thing from the other side (`renderSettings.ts`'s sentinel). Both read
 *  as "no ceiling" here so a button's would-be-authored value compares against the tier's ceiling
 *  on equal terms. */
function asCeiling(v: number): number {
  return v > 0 ? v : Infinity;
}

/** Would picking `value` on this A/B button be immediately clamped back down by the ACTIVE tier?
 *  This is what makes the row honest — R6.2: on `low`/`mid` (`pixelRatioCap: 1`), tapping `2` or
 *  `3` used to store the authored value while the renderer kept running at 1, and the owner had
 *  no way to tell from this panel that the tap did nothing.
 *
 *  ⚠️ **IT LABELS THE BUTTON; IT DOES NOT DISABLE IT** (owner, 2026-08-12). Disabling was tried and
 *  is wrong: A/B-ing the backing resolution on a device is the whole reason this row exists, and a
 *  tier clamps it on every phone that is not `high` — i.e. on exactly the hardware worth testing.
 *  Removing the control to signal the clamp takes away the thing the panel is FOR. The tap still
 *  writes the authored value; the readout beside the row says what the tier is doing to it, and the
 *  tier buttons in this same tab are how you lift the clamp. Honest, not inert. */
function willBeClamped(value: number, tierCeiling: number): boolean {
  return asCeiling(value) > tierCeiling;
}

function CapButtonRow({
  label, effective, authored, tierCeiling, onPick,
}: {
  label: string; effective: number; authored: number; tierCeiling: number; onPick: (v: number) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
      <span style={{ ...keyStyle, width: 18 }}>{label}</span>
      <div style={{ display: 'flex', gap: 4 }}>
        {CAP_OPTIONS.map(({ value, label: btnLabel }) => {
          // ⚠️ HIGHLIGHT WHAT THE TAP WROTE — the AUTHORED value — not the effective one.
          // R6.2 highlighted `effective`, which sounds right ("show what is really running") and
          // is wrong for a SELECTOR: the tap writes the authored value, so on any clamped tier the
          // highlight never moved and the button read as broken. Reported from the device, 2026-08-12.
          // The effective value is not lost — it is marked below and spelled out in the readout
          // beside the row.
          const active = authored === value;
          // What the renderer is ACTUALLY running, when the tier clamped the pick somewhere else.
          const isEffective = effective === value && effective !== authored;
          const clamped = willBeClamped(value, tierCeiling);
          return (
            <button
              key={btnLabel}
              onClick={() => onPick(value)}
              title={
                isEffective
                  ? `Running at this — the tier clamped your pick of ${authored > 0 ? authored : 'Off'} down to it`
                  : clamped
                    ? `The active tier clamps this to ${tierCeiling === Infinity ? 'uncapped' : tierCeiling} — it will be stored, but pick a higher tier to see it on screen`
                    : undefined
              }
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 4,
                // SELECTED = solid border (what you picked). RUNNING-but-not-picked = dashed
                // (what the tier gave you instead). Two different facts, two different marks, so
                // neither has to be inferred from the other.
                border: active ? '1px solid #7ec8ff' : isEffective ? '1px dashed #7ec8ff' : '1px solid #2d5a8a',
                background: active ? '#16223a' : 'transparent',
                // Dimmed as a HINT that the tier will clamp it — still tappable, see `willBeClamped`.
                color: clamped ? '#5c5c70' : active || isEffective ? '#7ec8ff' : '#8b8ba7',
                cursor: 'pointer',
                opacity: clamped ? 0.7 : 1,
              }}
            >
              {btnLabel}
            </button>
          );
        })}
      </div>
      {/* The AUTHORED value beside the effective one, only when a tier is clamping them apart —
          the readout must not silently hide what was actually stored. */}
      {authored !== effective && (
        <span style={{ fontSize: 10, color: '#8b8ba7' }}>
          (authored {authored > 0 ? authored : 'Off'}, tier clamps to {effective > 0 ? effective : 'Off'})
        </span>
      )}
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
  const [probeRunning, setProbeRunning] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);
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

  /** Preview a tier LIVE (#121 P3d) — the point of the control.
   *
   *  A project can already pin `rendering.three.qualityTier`, but that resolves at renderer
   *  BRING-UP, so changing it shows nothing until a relaunch — useless for authoring a low-end
   *  look. This applies it now, through the same `applyQualityTier` the calibration loop uses, so
   *  what you see is what a device on that tier renders. Two honest limits, both inherited:
   *  ANTIALIAS will not change until the next renderer creation (constructor option), and this is
   *  a live override, not a saved setting — it does not write project.config.json. */
  function previewTier(tier: QualityTier) {
    applyQualityTier(tier, 'project', 'previewed from the debug menu');
    bumpCapsTick((n) => n + 1);
  }

  /** Re-run the ramp probe NOW, with the game idle — the boot-vs-quiet A/B the cpu ramp asks for.
   *
   *  `runCpuRamp` measures *available* CPU, not peak, and its own doc asks for one validation:
   *  a boot reading against a quiet reading on the same device. This is the quiet half. It writes
   *  no verdict and publishes no tier (see `runProbeForDiagnostics`) — the numbers land here and in
   *  the console, in the same format as the boot line, and nothing on screen changes.
   *
   *  The probe blocks the main thread in bursts, so the button is disabled while one is running
   *  rather than allowing a second tap to measure the first probe's contention. */
  function rerunProbe() {
    if (probeRunning) return;
    setProbeRunning(true);
    setProbeResult(null);
    // Two rAFs before starting: the tap's own click handling, style recalc and the disabled-state
    // repaint are main-thread work, and a probe started synchronously in the handler would time
    // them. The whole point of this button is a reading taken while the thread is quiet.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // `only2D` from what is actually mounted, not from config: a project with no 3D canvas runs
      // the `fill` shape at boot, and a diagnostic on the other axis would not be comparable to it.
      void runProbeForDiagnostics(buffers.threeD.length === 0)
        .then((summary) => { setProbeResult(summary); })
        .finally(() => { setProbeRunning(false); });
    }));
  }

  const activeTier = getActiveQualityTier();
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

  // AUTHORED (what's stored in project settings — what a tap here writes) vs. EFFECTIVE (what
  // the active tier actually lets the renderer run at). `getRenderSettings()` alone used to feed
  // this whole panel, which made the readout and the A/B buttons lie on any tiered device: `low`
  // and `mid` both seed `pixelRatioCap: 1`, so on e.g. a Galaxy A23 the authored `2` showed
  // highlighted while the renderer ran at 1, and tapping `3` stored it with no visible change
  // (R6.2 — see docs/rendering.md § "Quality tiers", "Read the tier through
  // `getEffectiveThreeSettings()`").
  const liveCaps = getRenderSettings();
  const effectiveThree = getEffectiveThreeSettings();
  const effectivePixi = getEffectivePixiSettings();
  const tierOverrides = getActiveTierOverrides();
  const tierCeilingThree = asCeiling(tierOverrides.pixelRatioCap);
  const tierCeilingPixi = asCeiling(tierOverrides.pixiPixelRatioCap);

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
        <CapButtonRow
          label="2D"
          effective={effectivePixi.pixelRatioCap}
          authored={liveCaps.pixi.pixelRatioCap}
          tierCeiling={tierCeilingPixi}
          onPick={(v) => setCap('pixi', v)}
        />
        <CapButtonRow
          label="3D"
          effective={effectiveThree.pixelRatioCap}
          authored={liveCaps.three.pixelRatioCap}
          tierCeiling={tierCeilingThree}
          onPick={(v) => setCap('three', v)}
        />
        <div style={{ ...rowStyle, marginTop: 6 }}>
          <span style={keyStyle}>Quality tier</span>
          <span style={valStyle}>{activeTier ? `${activeTier.tier} (${activeTier.source})` : '—'}</span>
        </div>
        {activeTier && (
          <div style={{ ...uaStyle, marginBottom: 4 }}>{activeTier.reason}</div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          {/* 42, not the 18 the `2D`/`3D` rows above use: `keyStyle` sets `flexShrink: 0` but not
              `overflow`, so a label wider than its box paints OVER the control beside it rather
              than truncating. Measured on a Galaxy A23 — `Probe` sat on top of its own button. */}
          <span style={{ ...keyStyle, width: 42 }}>Tier</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {TIER_ORDER.map((t) => {
              const active = activeTier?.tier === t;
              return (
                <button
                  key={t}
                  onClick={() => previewTier(t)}
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
                  {t}
                </button>
              );
            })}
          </div>
        </div>
        {/* The boot-vs-idle probe A/B (#205). Deliberately NOT a tier control — it measures and
            reports, writes no verdict, publishes no tier. See `runProbeForDiagnostics`. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ ...keyStyle, width: 42 }}>Probe</span>
          <button
            onClick={rerunProbe}
            disabled={probeRunning}
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 4,
              border: '1px solid #2d5a8a',
              background: 'transparent',
              color: probeRunning ? '#5a5a70' : '#8b8ba7',
              cursor: probeRunning ? 'default' : 'pointer',
            }}
          >
            {probeRunning ? 'measuring…' : 'Re-run probe (idle)'}
          </button>
        </div>
        {probeResult && <div style={{ ...uaStyle, marginBottom: 4 }}>{probeResult}</div>}
        <div style={{ ...rowStyle, marginTop: 4 }}>
          <span style={keyStyle}>Effective caps (2D/3D)</span>
          <span style={valStyle}>{effectivePixi.pixelRatioCap} / {effectiveThree.pixelRatioCap}</span>
        </div>
        {(liveCaps.pixi.pixelRatioCap !== effectivePixi.pixelRatioCap
          || liveCaps.three.pixelRatioCap !== effectiveThree.pixelRatioCap) && (
          <div style={rowStyle}>
            <span style={keyStyle}>Authored caps (2D/3D)</span>
            <span style={valStyle}>{liveCaps.pixi.pixelRatioCap} / {liveCaps.three.pixelRatioCap}</span>
          </div>
        )}
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
