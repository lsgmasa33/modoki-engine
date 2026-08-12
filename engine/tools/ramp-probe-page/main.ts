/** Boot ramp probe — standalone measurement page (#188). See index.html for why this exists.
 *
 *  Runs the SHIPPING probe (`runBootRampProbe`), not a reimplementation of it. That is the whole
 *  point: a number measured by a copy of the probe would be a number about the copy. Everything
 *  here is presentation and collection.
 *
 *  THREE RUNS, and the SPREAD is reported. A single reading on a phone is not a measurement —
 *  thermal state, a background app, and (on the ramp specifically) one unlucky vsync quantum all
 *  move it. Three runs make an outlier visible instead of authoritative. */

import { runBootRampProbe } from '../../packages/modoki/src/runtime/rendering/rampProbeRunner';
import {
  classifyDevice, fillMegapixelsPerMs, shadeMegaFragmentsPerMs, type ProbeMeasurement,
} from '../../packages/modoki/src/runtime/rendering/rampProbe';
import { getRenderSettings, setRenderSettings } from '../../packages/modoki/src/runtime/rendering/renderSettings';

/** Injected by build.mjs. See its comment for why a visible build stamp is load-bearing here. */
declare const __BUILD_ID__: string;

const $ = (id: string) => document.getElementById(id)!;
const deviceSel = $('device') as HTMLSelectElement;
const runBtn = $('run') as HTMLButtonElement;
const statusEl = $('status');
const headlineEl = $('headline');
const outEl = $('out');

$('buildid').textContent = __BUILD_ID__;

// Safari on iOS caches aggressively and a pull-to-refresh does not always bypass it. A
// cache-busting query on the DOCUMENT is the reliable escape, so the fix is one tap rather than
// a settings dive.
($('reload') as HTMLButtonElement).onclick = () => {
  location.href = `${location.pathname}?cb=${Date.now()}`;
};

// `?backend=webgl` / `?backend=webgpu` forces three's backend selection, so a crash that happens
// on only one of them can be bisected from the phone rather than guessed at from here.
const forcedBackend = new URLSearchParams(location.search).get('backend');
if (forcedBackend === 'webgl' || forcedBackend === 'webgpu') {
  const before = getRenderSettings();
  setRenderSettings({ ...before, three: { ...before.three, backend: forcedBackend } });
  $('buildid').textContent += `  ·  backend=${forcedBackend}`;
}

deviceSel.onchange = () => { runBtn.disabled = !deviceSel.value; };

/** `?auto=<label>` preselects a device and starts immediately.
 *
 *  This is what lets an Android device attached over USB be driven end to end from the Mac
 *  (`adb reverse` + `am start`), with no one tapping anything. Verifying the agent-facing surface
 *  is the agent's job; borrowing the owner's hands for it is the fallback, not the plan. */
const autoLabel = new URLSearchParams(location.search).get('auto');

/** Passes per tap. `?runs=10` raises it — three samples cannot distinguish "the cold first pass
 *  is an outlier" from "the noise is inherent", and those two have completely different fixes
 *  (discard one pass, versus require a confidence margin). */
const RUNS = Math.min(20, Math.max(1, Number(new URLSearchParams(location.search).get('runs')) || 3));

function line(m: ProbeMeasurement): string {
  const r = (n: number) => Math.round(n);
  const f = (n: number) => n.toFixed(1);
  // ⚠️ THE CLOCK LEADS. A WebGPU queue-promise reading and a WebGL2 fence reading have different
  // delivery latencies and noise floors, and on the Android campaign the three phones split across
  // BOTH (Y6 on webgl2, both Samsungs on webgpu). A cross-device table that does not say which
  // instrument produced each row is not a comparison.
  return `clock=${m.clockKind} total=${r(m.totalMs)} renderer=${r(m.rendererMs)} `
    + `compile=${r(m.compileMs)}+${r(m.shadeCompileMs)} `
    + `interval=${f(m.intervalMs)} buf=${m.bufferPixels} region=${m.shadeRegionPixels} `
    // The DERIVED figures first — the raw per-ramp units are not comparable between devices
    // (see fillMegapixelsPerMs / shadeMegaFragmentsPerMs) and the raw ones are kept only so a
    // suspicious reading can be traced back to the ramp that produced it.
    + `fillMpx=${fillMegapixelsPerMs(m).toFixed(3)} `
    + `shadeMfrag=${shadeMegaFragmentsPerMs(m).toFixed(3)} `
    + `cpuK=${m.cpu ? (m.cpu.unitsPerMs / 1000).toFixed(2) : 'n/a'} `
    + `fill=${m.fill.status}/${m.fill.bound}:${f(m.fill.unitsPerMs)}@${m.fill.peakLoad} `
    + `draw=${m.draw.status}/${m.draw.bound}:${f(m.draw.unitsPerMs)}@${m.draw.peakLoad} `
    + `shade=${m.shade ? `${m.shade.status}/${m.shade.bound}:${f(m.shade.unitsPerMs)}@${m.shade.peakLoad}` : 'absent'} `
    + `cpu=${m.cpu ? `${m.cpu.status}/${m.cpu.bound}:${r(m.cpu.unitsPerMs)}@${m.cpu.peakLoad}` : 'absent'}`;
}

/** The run whose `totalMs` sits in the middle of the batch — a genuine median (#205 R5.4).
 *
 *  ⚠️ This used to be `measurements[Math.floor(measurements.length / 2)]` — the run in the
 *  MIDDLE POSITION BY ORDER, i.e. whichever run happened to finish second (of three), presented
 *  to a human as `med`. An unlucky cold first run (this file's own header explains why the first
 *  pass is not like the others — thermal state, a background app, one unlucky vsync quantum) could
 *  land in that position and be reported as the representative reading when it was the outlier.
 *  Sorting by `totalMs` before taking the middle element makes the label true. `totalMs` is the
 *  headline's own leading figure, so it is the natural key to sort by; `Array.prototype.sort` is
 *  stable, so equal-`totalMs` runs keep their original order rather than being reordered by noise. */
export function medianMeasurement(measurements: ProbeMeasurement[]): ProbeMeasurement {
  const sorted = [...measurements].sort((a, b) => a.totalMs - b.totalMs);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Ship one line home immediately.
 *
 *  ⚠️ SENT PER RUN, not once at the end. An iPhone 13 mini crashed its own tab mid-probe, and
 *  because results were posted only after all three runs, EVERY completed run was lost with it —
 *  the single most expensive way to fail, since someone has to be physically holding the phone.
 *  Partial data from a device that then died is exactly the data worth having: it says where the
 *  limit is. */
async function send(text: string): Promise<boolean> {
  try {
    const r = await fetch('/result', { method: 'POST', body: text });
    return r.ok;
  } catch { return false; }
}

/** Fire-and-forget breadcrumb, used for the probe's internal stages.
 *
 *  ⚠️ `sendBeacon`, NOT `fetch`. The whole point of these is to survive the tab being KILLED —
 *  a 13 mini died before finishing a single run and left no trace of where. A pending `fetch` is
 *  torn down with the process; a beacon is handed to the browser to deliver independently, which
 *  is exactly the guarantee needed when the thing you are instrumenting is a crash. */
function beacon(text: string): void {
  try { navigator.sendBeacon?.('/result', text); } catch { /* diagnostics must never throw */ }
}

async function runProbeSession(): Promise<void> {
  runBtn.disabled = true;
  deviceSel.disabled = true;
  headlineEl.textContent = '';
  outEl.style.display = 'none';

  const ua = navigator.userAgent;
  // forcedBackend is recorded because it was NOT, once, and that made a decisive-looking result
  // ("dies on WebGL too") impossible to distinguish from an override that never applied.
  const header = `DEVICE=${deviceSel.value} build=${__BUILD_ID__} dpr=${window.devicePixelRatio} `
    + `viewport=${window.innerWidth}x${window.innerHeight} forced=${forcedBackend ?? 'none'}`;

  // Announce BEFORE measuring. If the tab dies mid-probe, this is the only trace that the device
  // ever started — and "it crashed" is itself a finding about that hardware.
  await send(`#188 ramp probe START\n${header}\nua=${ua}`);

  const results: string[] = [];
  const measurements: ProbeMeasurement[] = [];
  try {
    for (let i = 0; i < RUNS; i++) {
      statusEl.textContent = `running ${i + 1} of ${RUNS}…`;
      // Yield to the browser so the status paints before the probe hogs the frame loop.
      await new Promise((r) => setTimeout(r, 60));
      const m = await runBootRampProbe((stage) => {
        statusEl.textContent = `run ${i + 1}: ${stage}`;
        beacon(`  [run ${i + 1}] ${stage}`);
      });
      if (!m) { results.push('run failed (probe returned null)'); await send(`${header}\nrun ${i + 1}: null`); continue; }
      measurements.push(m);
      results.push(line(m));
      await send(`${header}\nrun ${i + 1}: ${line(m)}`);
    }
  } catch (e) {
    results.push(`threw: ${String(e)}`);
    await send(`${header}\nthrew: ${String(e)}`);
  }
  const verdicts = measurements.map((m) => classifyDevice(m).deviceClass);
  const payload = ['#188 ramp probe', header, ...results, `verdicts=${verdicts.join(',')}`, `ua=${ua}`]
    .join('\n');

  // The consolidated block, on top of the per-run sends above — those are the crash insurance,
  // this is the readable summary. The clipboard path below stays as the fallback for when the
  // send fails (a captive network, a server already stopped), because a silent failure here
  // would look exactly like success.
  const sent = await send(payload);

  statusEl.textContent = sent
    ? 'done — results sent, nothing else needed'
    : 'done — could NOT send; tap the box to copy and paste it back';
  if (measurements.length) {
    const med = medianMeasurement(measurements);
    // Mpx/ms, not the raw quads/ms the ramp works in: the raw figure is not comparable between
    // devices (see fillMegapixelsPerMs), and a headline is exactly where someone reads a number
    // off a screen and compares it to another device's.
    headlineEl.textContent = `${Math.round(med.totalMs)} ms · cpu `
      + `${med.cpu ? (med.cpu.unitsPerMs / 1000).toFixed(1) : '-'}k xform/ms `
      + `· shade ${shadeMegaFragmentsPerMs(med).toFixed(2)} Mfrag/ms `
      + `· fill ${fillMegapixelsPerMs(med).toFixed(2)} Mpx/ms · ${med.clockKind}`;
  } else {
    headlineEl.textContent = 'no result';
    headlineEl.className = 'big warn';
  }
  outEl.textContent = payload;
  outEl.style.display = 'block';

  // Select-all on tap, so copying on a phone is one gesture rather than a drag-handle fight.
  outEl.onclick = () => {
    const range = document.createRange();
    range.selectNodeContents(outEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    void navigator.clipboard?.writeText(payload).then(
      () => { statusEl.textContent = 'copied to clipboard'; },
      () => { statusEl.textContent = 'selected — long-press to copy'; },
    );
  };

  deviceSel.disabled = false;
  runBtn.disabled = false;
  runBtn.textContent = 'Run again';
}

runBtn.onclick = runProbeSession;

if (autoLabel) {
  // The label may not be one of the listed options (Android models are driven in by URL), so add
  // it rather than silently failing to select it — an unselected device would post DEVICE= empty
  // and the result would be unattributable.
  if (!Array.from(deviceSel.options).some((o) => o.value === autoLabel)) {
    const opt = document.createElement('option');
    opt.value = autoLabel;
    opt.textContent = autoLabel;
    deviceSel.appendChild(opt);
  }
  deviceSel.value = autoLabel;
  runBtn.disabled = false;
  // A beat for the page to paint, so a screenshot of a failed run still shows what it was doing.
  setTimeout(() => { void runProbeSession(); }, 300);
}
