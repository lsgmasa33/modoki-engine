/** Input tab — measure and set the pointer LEAD (touch-to-photon latency compensation).
 *
 *  ## Why a tab rather than a constant
 *
 *  A touch takes a long time to become a lit pixel — the OS samples the digitizer, the WebView
 *  dispatches an event, the app renders a frame, the compositor presents it — and the total is a
 *  property of the DEVICE, not of the engine. Measured ~83 ms (five frames at 60 Hz) on an A23.
 *  It is NOT the frame budget: the decisive check is a control ring below, a bare DOM element
 *  moved directly in the pointer handler, which is the shortest path a browser offers. When that
 *  ring lags too, there is no frame left in engine code to reclaim and the only lever is to draw
 *  where the finger is about to be. See `POINTER_LEAD_MS_DEFAULT` in `traits/Input.ts`.
 *
 *  ⚠️ And the right lead is 0 on some hardware — an iPhone Air (120 Hz) JITTERS at any lead,
 *  because a two-point velocity over an 8.3 ms sample gap turns a pixel of pointer noise into
 *  ~10 px of extrapolation error. So the number cannot be derived from the hardware either; both
 *  of the numbers this project ships were nearly guessed wrong before being felt.
 *
 *  It has to be *felt*, per device, by the person whose finger it is. This tab exists so that
 *  takes a minute instead of an improvised debugging session:
 *
 *  1. **Show rings** — pink sits at the raw pointer, green at the extrapolated one.
 *  2. Drag, and pick the lead where **green sits on your fingertip**.
 *  3. Keep dragging and find where it **overshoots on reversals** — left-right is the worst case,
 *     since the extrapolation is still travelling left as you start moving right. The answer is
 *     usually a compromise between (2) and (3), which is exactly why it is a judgement call.
 *
 *  ⚠️ The rings show the PREDICTION, not the game's own drawing. A game that has not adopted
 *  `pointerPredictedPos` for its dragged object will not move any faster because this is set —
 *  the lead is engine-wide state, but each renderer opts in. And no hit-test may read it (a drop
 *  resolved at an extrapolated point lands where the finger was HEADING), so a game whose picture
 *  leads correctly can still be dropping at the true point, by design.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { scrollRootStyle } from '../tabLayout';
import {
  getPointerLeadMs, setPointerLeadMs, POINTER_LEAD_MS_ANDROID_60HZ,
  setPointerLeadGate, getPointerLeadGate, pointerLeadGateFactor,
} from '../../traits/Input';
// The sanctioned wall-clock wrapper — the same one `pointerPredictedPos` reads, so the tuner
// cannot silently measure against a different clock than the runtime it is tuning.
import { rawNow } from '../../core/clock';
import { setPointerFilterParams, getPointerFilterParams } from '../../input/pointerSource';
import { createOneEuroFilter } from '../../input/oneEuroFilter';

/** Ladder of leads to audition. 0 is the control — it must look identical to the pink ring, and
 *  if it does not, the rig is lying and nothing measured with it can be trusted. */
const PRESETS = [0, 33, 50, 66, 83, 100, 133];
const MAX_LEAD_MS = 200;
const RING_ID = '__modoki-lead-rings';

/** Mount two rings that follow the pointer: RAW (pink) and EXTRAPOLATED (green).
 *
 *  Deliberately plain DOM written straight from the event handler, NOT an ECS entity: the point
 *  of the pink ring is to be the lowest-latency thing the platform can draw, so it can act as the
 *  control that separates "the platform is late" from "our render path is late". Routing it
 *  through the world would measure the world.
 *
 *  The pipeline matches `pointerPredictedPos` exactly: a 1€-filtered VELOCITY, the RAW position
 *  as the base, advanced to NOW + lead. All three are traps that cost a round each — a window
 *  average is centred in the past and silently delivers a fraction of the requested lead
 *  ("prediction barely helps"); extrapolating BY the lead from a varying-staleness event writes
 *  input/display phase noise into the pixels ("prediction jitters"); and extrapolating FROM the
 *  filter's smoothed position subtracts its lag from the lead, drawing behind the finger.
 *
 *  ⚠️ Keep the two implementations in step if either changes — a tuner that models the runtime
 *  differently is measuring the wrong thing, and this file has already drifted from it once. */
function mountRings(getLead: () => number): () => void {
  const mk = (color: string, size: number): HTMLDivElement => {
    const d = document.createElement('div');
    d.style.cssText = `position:fixed;left:0;top:0;width:${size}px;height:${size}px;`
      + `margin:${-size / 2}px 0 0 ${-size / 2}px;border-radius:50%;border:3px solid ${color};`
      + 'pointer-events:none;z-index:2147483646;display:none';
    return d;
  };
  const host = document.createElement('div');
  host.id = RING_ID;
  const raw = mk('#ff3399', 30), pred = mk('#00ff88', 22);
  host.append(raw, pred);
  document.body.appendChild(host);

  // The SAME pipeline the runtime uses — 1€ filter per axis, reading the live params — so the
  // ring cannot be quietly smoother or jitterier than the game it is being used to tune.
  const fX = createOneEuroFilter(getPointerFilterParams());
  const fY = createOneEuroFilter(getPointerFilterParams());
  let pt = 0, vx = 0, vy = 0;
  const move = (e: PointerEvent): void => {
    raw.style.display = pred.style.display = 'block';
    const t = e.timeStamp, x = e.clientX, y = e.clientY;
    const dt = t - pt;
    if (dt > 1 && dt < 64) {
      // Only the DERIVATIVE is used, exactly as `pointerSource` does — the filter's smoothed
      // position is discarded, because extrapolating from it draws behind the finger.
      const rx = fX.filter(x, dt / 1000), ry = fY.filter(y, dt / 1000);
      vx = rx.derivative / 1000; vy = ry.derivative / 1000;
    }
    pt = t;
    // Advance to NOW + lead, not by lead from the event — same as `pointerPredictedPos`. The
    // age term is what cancels input/display phase noise; without it the ring would jitter for
    // a reason that has nothing to do with the lead being auditioned, and the tab would be
    // measuring its own bug.
    // Gate exactly as the runtime does — including the ramp — or the ring shows a lead the
    // game will not apply at that speed.
    const gate = pointerLeadGateFactor(Math.hypot(vx, vy));
    const ahead = Math.max(0, Math.min(64, rawNow() - t)) + getLead() * gate;
    raw.style.transform = `translate(${x}px,${y}px)`;
    pred.style.transform = `translate(${x + vx * ahead}px,${y + vy * ahead}px)`;
  };
  const down = (e: PointerEvent): void => {
    fX.reset(); fY.reset(); fX.seed(e.clientX); fY.seed(e.clientY);
    vx = vy = 0; pt = e.timeStamp; move(e);
  };
  // Capture phase + passive: read the event as early as possible and never delay the gesture
  // the tab is trying to measure.
  const opts = { capture: true, passive: true } as const;
  window.addEventListener('pointermove', move, opts);
  window.addEventListener('pointerdown', down, opts);
  return () => {
    window.removeEventListener('pointermove', move, opts);
    window.removeEventListener('pointerdown', down, opts);
    host.remove();
  };
}

export function InputTab() {
  const [lead, setLead] = useState(() => getPointerLeadMs());
  const [rings, setRings] = useState(false);
  const [minCutoff, setMinCutoff] = useState(() => getPointerFilterParams().minCutoff);
  const [beta, setBeta] = useState(() => getPointerFilterParams().beta);
  const [gateMin, setGateMin] = useState(() => getPointerLeadGate().minSpeed);
  const [gateFull, setGateFull] = useState(() => getPointerLeadGate().fullSpeed);
  const teardown = useRef<(() => void) | null>(null);
  // Read through a ref so the listeners never need re-binding when the lead changes —
  // rebinding mid-drag would drop the velocity history and make the ring stutter.
  const leadRef = useRef(lead);
  leadRef.current = lead;

  useEffect(() => {
    if (!rings) return undefined;
    teardown.current = mountRings(() => leadRef.current);
    return () => { teardown.current?.(); teardown.current = null; };
  }, [rings]);

  const apply = (v: number) => {
    const clamped = Math.max(0, Math.min(MAX_LEAD_MS, Math.round(v)));
    setPointerLeadMs(clamped);
    setLead(clamped);
  };

  const applyGate = (next: { minSpeed?: number; fullSpeed?: number }) => {
    setPointerLeadGate(next);
    const g = getPointerLeadGate();
    setGateMin(g.minSpeed); setGateFull(g.fullSpeed);
  };

  const applyFilter = (next: { minCutoff?: number; beta?: number }) => {
    setPointerFilterParams(next);
    const p = getPointerFilterParams();
    setMinCutoff(p.minCutoff); setBeta(p.beta);
  };

  return (
    <div style={scrollRootStyle(12)}>
      <section>
        <div style={rowStyle}>
          <span style={labelStyle}>Pointer lead</span>
          <span style={{ ...valueStyle, color: lead === 0 ? '#f87171' : '#fbbf24' }}>{lead} ms</span>
        </div>
        <input
          type="range" min={0} max={MAX_LEAD_MS} step={1} value={lead}
          onChange={(e) => apply(parseFloat(e.target.value))}
          style={{ width: '100%' }}
        />
        <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
          {PRESETS.map((p) => (
            <button key={p} style={{ ...btnStyle, ...(lead === p ? btnActiveStyle : null) }} onClick={() => apply(p)}>
              {p === 0 ? 'off' : p}
            </button>
          ))}
          <button style={btnStyle} onClick={() => apply(POINTER_LEAD_MS_ANDROID_60HZ)}>
            A23 ({POINTER_LEAD_MS_ANDROID_60HZ})
          </button>
        </div>
      </section>

      <section>
        <div style={rowStyle}>
          <span style={labelStyle}>Gate: no lead below</span>
          <span style={valueStyle}>{gateMin.toFixed(3)} px/ms</span>
        </div>
        <input
          type="range" min={0} max={0.5} step={0.005} value={gateMin}
          onChange={(e) => applyGate({ minSpeed: parseFloat(e.target.value) })}
          style={{ width: '100%' }}
        />
        <div style={rowStyle}>
          <span style={labelStyle}>Gate: full lead at</span>
          <span style={valueStyle}>{gateFull.toFixed(2)} px/ms</span>
        </div>
        <input
          type="range" min={0} max={3} step={0.02} value={gateFull}
          onChange={(e) => applyGate({ fullSpeed: parseFloat(e.target.value) })}
          style={{ width: '100%' }}
        />
        <p style={helpStyle}>
          The lead fades in between these two speeds, so a near-stationary finger gets no
          extrapolation (where its error is the visible tremor) and a moving one gets the full
          lead (where the latency is). A hard threshold would POP by <b>speed x lead</b> at the
          crossing — hence a ramp.
        </p>
      </section>

      <section>
        <div style={rowStyle}>
          <span style={labelStyle}>Min cutoff</span>
          <span style={valueStyle}>{minCutoff.toFixed(2)} Hz</span>
        </div>
        <input
          type="range" min={0.1} max={10} step={0.05} value={minCutoff}
          onChange={(e) => applyFilter({ minCutoff: parseFloat(e.target.value) })}
          style={{ width: '100%' }}
        />
        <p style={helpStyle}>LOWER until a <b>stationary</b> finger stops trembling.</p>

        <div style={rowStyle}>
          <span style={labelStyle}>Beta</span>
          <span style={valueStyle}>{beta.toFixed(3)}</span>
        </div>
        <input
          type="range" min={0} max={0.2} step={0.001} value={beta}
          onChange={(e) => applyFilter({ beta: parseFloat(e.target.value) })}
          style={{ width: '100%' }}
        />
        <p style={helpStyle}>
          RAISE until a <b>fast</b> drag stops lagging. Tune in this order — the two are close to
          independent, which is the only reason they are tunable by hand.
        </p>
      </section>

      <section>
        <button
          style={{ ...btnStyle, ...(rings ? btnActiveStyle : null), padding: '6px 10px' }}
          onClick={() => setRings((r) => !r)}
        >
          {rings ? '● Hide rings' : '○ Show rings'}
        </button>
        <p style={helpStyle}>
          <b style={{ color: '#ff3399' }}>Pink</b> = raw pointer. <b style={{ color: '#00ff88' }}>Green</b> = extrapolated
          by the lead above. Drag and pick the value where green sits on your fingertip, then keep
          dragging left-and-right and back off until reversals stop overshooting.
        </p>
        <p style={helpStyle}>
          At <b>0</b> the two must coincide — if they do not, distrust the rest. If pink itself
          trails your finger, that lag is the platform&rsquo;s and no engine change can remove it.
        </p>
      </section>

      <section>
        <p style={mutedStyle}>
          Session-only: the lead is not persisted, and the game re-applies its own on the next
          boot. Measured so far: <b>83</b> on a 60&nbsp;Hz A23, <b>0</b> on a 120&nbsp;Hz iPhone
          Air — where any lead jitters, because a shorter sample gap turns pointer noise into
          extrapolation error. There is no one number; record what this device wants.
        </p>
      </section>
    </div>
  );
}

const rowStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 };
const labelStyle: CSSProperties = { fontSize: 12, color: '#8b8ba7', textTransform: 'uppercase', letterSpacing: 0.5 };
const valueStyle: CSSProperties = { fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' };
const btnStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', color: '#c4b5fd',
  cursor: 'pointer', fontSize: 12, padding: '4px 8px', borderRadius: 4,
};
const btnActiveStyle: CSSProperties = { background: 'rgba(99,102,241,0.3)', color: '#e6e6ff' };
const helpStyle: CSSProperties = { fontSize: 11, color: '#8b8ba7', lineHeight: 1.5, margin: '8px 0 0' };
const mutedStyle: CSSProperties = { fontSize: 11, color: '#6b6b85', fontStyle: 'italic', margin: 0 };
