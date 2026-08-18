/** Profiler tab (profiler plan P5) — the human view of the marker data.
 *
 *  A VIEW, not a source: every number here comes from `core/profilerMarkers` +
 *  `core/profilerAggregate`, the same structures the MCP surface reads. That ordering is the
 *  point of the plan — a panel that computed its own statistics would drift from what an agent
 *  sees, and the two would disagree about the same frame.
 *
 *  Unity's Profiler leads with the hierarchy and buries the flat view. This leads with **Self**
 *  (the flat ranking) because that is the question people actually arrive with — "what do I
 *  fix?" — and a hierarchy answers a different one ("how is the frame structured?"). Both are
 *  here; the useful one is the default. */

import { useState, type CSSProperties } from 'react';
import { scrollRootStyle } from '../tabLayout';
import { useInterval } from '../useSampled';
import { getFrameProfile, BUDGET_30FPS_MS } from '../../core/frameProfiler';
import { getMarkerFaults, isProfilerEnabled, getMarkerTree, type MarkerSample } from '../../core/profilerMarkers';
import { getMarkerAggregate, MARKER_WINDOW_FRAMES } from '../../core/profilerAggregate';
import { startCapture, stopCapture, getCapture, clearCapture, exportCapture, getWorstCapturedFrame } from '../../core/profilerCapture';
import { getCounters } from '../../core/profilerCounters';
import { readRenderer, readMemory, MB } from '../perfSources';
import { getGpuProfile, getRestBreakdown, setGpuTimingEnabled, isGpuTimingEnabled } from '../../core/gpuTimings';

const ms = (v: number) => `${v.toFixed(2)}ms`;

/** Never round a non-zero presence down to "0%" — see the call site. */
function formatPresence(p: number): string {
  if (p >= 0.995) return '100%';
  if (p > 0 && p < 0.005) return '<1%';
  return `${(p * 100).toFixed(0)}%`;
}

export function ProfilerTab() {
  useInterval(500);
  const [view, setView] = useState<'self' | 'tree'>('self');
  const frame = getFrameProfile();
  const agg = getMarkerAggregate();
  const faults = getMarkerFaults();
  const rend = readRenderer();
  const mem = readMemory();
  const breakdown = getRestBreakdown(frame.restMs.median);
  const anyFault = faults.unbalancedEnds || faults.depthTruncated || faults.nodeCapHit;

  return (
    <div style={scrollRootStyle(16)}>
      <section>
        <div style={headingStyle}>Frame</div>
        <div style={hintStyle}>
          Milliseconds, not fps — fps saturates at the display refresh, so 3ms and 16ms frames
          both read as 60. Budget is {BUDGET_30FPS_MS.toFixed(1)}ms (30fps).
        </div>
        <div style={gridStyle}>
          <Stat k="Frame (median)" v={ms(frame.frameMs.median)} bad={frame.overBudget} />
          <Stat k="Frame (p95)" v={ms(frame.frameMs.p95)} />
          <Stat k="CPU (median)" v={ms(frame.cpuMs.median)} />
          <Stat k="FPS" v={frame.fps ? frame.fps.toFixed(1) : '—'} />
          <Stat k="Draw calls" v={rend?.calls ?? '—'} />
          <Stat k="Triangles" v={rend?.triangles?.toLocaleString() ?? '—'} />
          <Stat k="Backend" v={rend?.backend ?? '—'} />
          <Stat k="JS heap" v={mem ? `${(mem.usedJSHeapSize / MB).toFixed(0)}MB` : 'n/a'} />
        </div>
        {/* Prefer MEASURED evidence over the vsync inference when GPU timing is on. `vsyncBound`
            is a guess from the shape of the frame time; a resolved timestamp is the answer it was
            standing in for, and showing both would invite the reader to average an inference with
            a measurement. */}
        {breakdown ? (
          <div style={noteStyle}>
            <b>{breakdown.verdict === 'gpu' ? 'GPU-bound.' : breakdown.verdict === 'idle' ? 'Idle-bound.' : 'Mixed.'}</b>{' '}
            Of {ms(breakdown.restMs)} outside engine CPU, <b>{ms(breakdown.gpuMs)}</b> is measured
            GPU work and {ms(breakdown.presentIdleMs)} is present + idle.{' '}
            {breakdown.verdict === 'gpu'
              ? 'Optimising CPU will not move this frame — the GPU is the bottleneck.'
              : breakdown.verdict === 'idle'
                ? 'The frame is finishing early and waiting; there is headroom.'
                : 'Neither dominates.'}{' '}
            <i>Two medians over overlapping windows, not a per-frame subtraction — rAF frames and
            three render calls are not the same sequence.</i>
          </div>
        ) : frame.vsyncBound && (
          <div style={noteStyle}>
            <b>Vsync-bound.</b> The frame is finishing early, so the non-CPU remainder
            ({ms(frame.restMs.median)}) is mostly the browser <i>waiting</i> — not GPU cost. Judge
            headroom by CPU here. <i>Inferred from the frame time; turn on GPU timing below to
            measure it.</i>
          </div>
        )}
        {frame.discontinuities > 0 && (
          <div style={noteStyle}>
            {frame.discontinuities} discontinuit{frame.discontinuities === 1 ? 'y' : 'ies'} dropped
            (tab hidden, debugger pause, or a long stall). Percentiles exclude them.
          </div>
        )}
      </section>

      <section>
        <div style={headingStyle}>
          Markers
          <span style={{ float: 'right', display: 'flex', gap: 4 }}>
            <button data-ui-id="profiler.markers.self" style={tabBtn(view === 'self')} onClick={() => setView('self')}>Self</button>
            <button data-ui-id="profiler.markers.tree" style={tabBtn(view === 'tree')} onClick={() => setView('tree')}>Tree</button>
          </span>
        </div>

        {!isProfilerEnabled() ? (
          <div style={hintStyle}>Markers are not running.</div>
        ) : agg.framesRecorded === 0 ? (
          <div style={hintStyle}>No frames recorded yet.</div>
        ) : (
          <>
            <div style={hintStyle}>
              {/* The window, NOT `framesRecorded` — that is a CUMULATIVE count (it read "the last
                  9188 frames" while every statistic came from the last 120), which was simply a
                  false sentence. Caught by looking at the rendered panel, not the data. */}
              {view === 'self'
                ? `Worst self time over the last ${Math.min(agg.framesRecorded, MARKER_WINDOW_FRAMES)} frame(s)`
                  + ` of ${agg.framesRecorded} recorded — "what do I fix?". Self excludes children;`
                  + ' Frames is lifetime presence.'
                : 'Frame structure, this frame. Total includes children; self is the time spent here.'}
            </div>
            {anyFault ? (
              <div style={{ ...noteStyle, color: '#ffb4a2' }}>
                <b>Incomplete.</b>{' '}
                {faults.nodeCapHit > 0 && `${faults.nodeCapHit} marker(s) refused (node cap — a name built from per-entity data?). `}
                {faults.depthTruncated > 0 && `${faults.depthTruncated} span(s) too deep. `}
                {faults.unbalancedEnds > 0 && `${faults.unbalancedEnds} unbalanced end(s). `}
              </div>
            ) : null}
            {view === 'self' ? <SelfTable rows={agg.ranking} /> : <TreeTable tree={agg.tree} />}
          </>
        )}
      </section>

      <GpuSection />
      <CountersSection />
      <CaptureSection />
    </div>
  );
}

/** GPU timing (P7). Always visible, unlike Counters — the whole point is that a reader arriving
 *  with "where did my 100ms go?" can find the switch. Off by default: enabling makes three
 *  allocate a query set and write two timestamps per pass, and the plan's overhead rule says the
 *  profiler must not change the thing it measures. */
function GpuSection() {
  useInterval(500);
  const gpu = getGpuProfile();
  const on = isGpuTimingEnabled();
  return (
    <section>
      <div style={headingStyle}>
        GPU
        <span style={{ float: 'right', display: 'flex', gap: 4 }}>
          <button data-ui-id="profiler.gpu.toggle" style={tabBtn(on)} onClick={() => setGpuTimingEnabled(!on)}>
            {on ? '■ Stop' : '● Measure'}
          </button>
        </span>
      </div>
      {!on ? (
        <div style={hintStyle}>
          Off. Frame time minus engine CPU is GPU + present + <i>idle</i>, all three at once —
          this separates them with real timestamp queries. Costs a query set and two timestamps
          per pass while running, so it is not left on.
        </div>
      ) : gpu.status === 'unsupported' || gpu.status === 'no-renderer' ? (
        // Never a zero, and never a blank table: the reason IS the answer on these devices.
        <div style={{ ...noteStyle, color: '#ffb4a2' }}>
          <b>Unavailable{gpu.backend ? ` (${gpu.backend})` : ''}.</b> {gpu.detail}
        </div>
      ) : gpu.status === 'pending' || !gpu.passes?.length ? (
        <div style={hintStyle}>Waiting for the first timestamps to resolve…</div>
      ) : (
        <>
          <div style={hintStyle}>
            Measured GPU time per pass over the last {gpu.samples} frame(s) via{' '}
            {gpu.backend} timestamp queries. Results arrive {gpu.lagFrames} frame(s) behind — GPU
            timings are resolved asynchronously and always trail.
            {gpu.errors ? ` ${gpu.errors} resolve(s) failed.` : ''}
            {gpu.resolutionMs ? (
              <> Adapter resolution ≈ <b>{gpu.resolutionMs.toFixed(3)}ms</b> — browsers coarsen GPU
              timestamps deliberately, so a pass near that value is one significant figure, not
              three.</>
            ) : null}
          </div>
          <div style={gridStyle}>
            <Stat k="GPU (median)" v={ms(gpu.gpuMs!.median)} />
            <Stat k="GPU (p95)" v={ms(gpu.gpuMs!.p95)} />
            <Stat k="GPU (max)" v={ms(gpu.gpuMs!.max)} />
            <Stat k="Passes" v={gpu.passes.length} />
          </div>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Pass</th>
                <th style={thNumStyle}>Median</th>
                <th style={thNumStyle}>p95</th>
                <th style={thNumStyle}>Max</th>
              </tr>
            </thead>
            <tbody>
              {gpu.passes.map((p) => (
                <tr key={p.name}>
                  <td style={tdStyle}>{p.name}</td>
                  <td style={tdNumStyle}>{ms(p.ms.median)}</td>
                  <td style={tdNumStyle}>{ms(p.ms.p95)}</td>
                  <td style={tdNumStyle}>{ms(p.ms.max)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

/** Game-authored counters (P9). Hidden entirely when a game declares none — an empty table
 *  would read as a finding ("no counters?") rather than as the absence of an opt-in feature. */
function CountersSection() {
  const { counters, truncated } = getCounters();
  if (!isProfilerEnabled() || counters.length === 0) return null;
  return (
    <section>
      <div style={headingStyle}>Counters</div>
      <div style={hintStyle}>
        Game-authored quantities. <b>level</b> persists between frames (entities alive);
        <b> rate</b> resets each frame (spawns this frame).
      </div>
      {truncated && <div style={{ ...noteStyle, color: '#ffb4a2' }}>Counter cap hit — list incomplete.</div>}
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Counter</th>
            <th style={thStyle}>Kind</th>
            <th style={thNumStyle}>Now</th>
            <th style={thNumStyle}>Median</th>
            <th style={thNumStyle}>Max</th>
          </tr>
        </thead>
        <tbody>
          {counters.map((c) => (
            <tr key={c.name}>
              <td style={tdStyle}>{c.name}</td>
              <td style={{ ...tdStyle, opacity: 0.55 }}>{c.kind}</td>
              <td style={tdNumStyle}>{c.current.toLocaleString()}</td>
              <td style={tdNumStyle}>{c.median.toLocaleString()}</td>
              <td style={tdNumStyle}>{c.max.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Record + scrub (P6). The aggregate answers "what is consistently slow"; this answers "what
 *  happened in THAT frame" — the 200ms hitch a window of medians cannot show by construction. */
function CaptureSection() {
  const [frameIdx, setFrameIdx] = useState(0);
  const cap = getCapture();
  const worst = getWorstCapturedFrame();
  const has = cap.frames.length > 0;
  const current = has ? cap.frames[Math.min(frameIdx, cap.frames.length - 1)] : null;

  return (
    <section>
      <div style={headingStyle}>Capture</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {cap.capturing ? (
          <button data-ui-id="profiler.capture.stop" style={tabBtn(true)} onClick={() => stopCapture()}>■ Stop ({cap.frames.length})</button>
        ) : (
          <button data-ui-id="profiler.capture.record" style={tabBtn(false)} onClick={() => { startCapture(); setFrameIdx(0); }}>● Record</button>
        )}
        {has && !cap.capturing && (
          <>
            <button data-ui-id="profiler.capture.clear" style={tabBtn(false)} onClick={() => { clearCapture(); setFrameIdx(0); }}>Clear</button>
            {worst && (
              <button data-ui-id="profiler.capture.jumpWorst" style={tabBtn(false)} onClick={() => setFrameIdx(worst.index)}>
                Jump to worst ({ms(worst.frameMs)})
              </button>
            )}
            <button
              data-ui-id="profiler.capture.export"
              style={tabBtn(false)}
              onClick={() => {
                // Plain JSON — diffable, attachable to an issue, and readable by an agent.
                const blob = new Blob([JSON.stringify(exportCapture(), null, 2)], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `modoki-profile-${cap.frames.length}f.json`;
                a.click();
                URL.revokeObjectURL(a.href);
              }}
            >Export JSON</button>
          </>
        )}
      </div>

      {cap.stoppedByCap && (
        <div style={noteStyle}>
          Stopped at the {cap.frames.length}-frame cap. It stops rather than wrapping — you press
          record because something is about to happen, so the beginning is the part worth keeping.
        </div>
      )}

      {has && current && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
            <input
              type="range" min={0} max={cap.frames.length - 1} value={Math.min(frameIdx, cap.frames.length - 1)}
              onChange={(e) => setFrameIdx(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ fontSize: 11, opacity: 0.7, minWidth: 150, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              #{current.index} · {current.atMs.toFixed(0)}ms in · {ms(current.frameMs)}
            </span>
          </div>
          <TreeTable tree={current.tree} />
        </>
      )}
    </section>
  );
}

function SelfTable({ rows }: { rows: ReturnType<typeof getMarkerAggregate>['ranking'] }) {
  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={thStyle}>Marker</th>
          <th style={thNumStyle}>Self</th>
          <th style={thNumStyle}>Max</th>
          <th style={thNumStyle}>Total</th>
          <th style={thNumStyle}>Calls</th>
          <th style={thNumStyle}>Frames</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.path}>
            <td style={tdStyle} title={r.path}>{r.name}</td>
            <td style={tdNumStyle}>{ms(r.selfMs)}</td>
            {/* Max earns its column: median and p95 both hide a one-off hitch by design, and a
                hitch is exactly what a stutter report is about. */}
            <td style={{ ...tdNumStyle, opacity: r.selfMax > r.selfMs * 3 ? 1 : 0.5 }}>{ms(r.selfMax)}</td>
            <td style={tdNumStyle}>{ms(r.totalMs)}</td>
            <td style={tdNumStyle}>{r.callsPerFrame.toFixed(1)}</td>
            {/* Presence: a marker in 3 of 120 frames is a different claim from one in all 120,
                so it is shown rather than folded into the averages. */}
            <td style={{ ...tdNumStyle, opacity: r.presence < 0.99 ? 1 : 0.4 }}>
              {/* "<1%" rather than a rounded "0%": a marker only reaches this table by having
                  been sampled, so 0% would state something false about a row that is visibly
                  present. Spotted in a live editor — the stopped-sim systems run once and then
                  get skipped by runPipeline, which rounds to zero within a few seconds. */}
              {formatPresence(r.presence)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TreeTable({ tree }: { tree: MarkerSample | null }) {
  const live = tree ?? getMarkerTree();
  if (!live) return <div style={hintStyle}>No tree.</div>;
  const rows: Array<{ node: MarkerSample; depth: number; key: string }> = [];
  const walk = (n: MarkerSample, depth: number, path: string) => {
    const key = `${path}/${n.name}`;
    rows.push({ node: n, depth, key });
    // Heaviest child first — the path to the cost reads top-down without expanding anything.
    [...n.children].sort((a, b) => b.totalMs - a.totalMs).forEach((c) => walk(c, depth + 1, key));
  };
  walk(live, 0, '');
  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={thStyle}>Marker</th>
          <th style={thNumStyle}>Total</th>
          <th style={thNumStyle}>Self</th>
          <th style={thNumStyle}>Calls</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ node, depth, key }) => (
          <tr key={key}>
            <td style={{ ...tdStyle, paddingLeft: 6 + depth * 14, opacity: depth === 0 ? 1 : 0.9 }}>
              {depth > 0 && <span style={{ opacity: 0.35 }}>└ </span>}{node.name}
            </td>
            <td style={tdNumStyle}>{ms(node.totalMs)}</td>
            <td style={tdNumStyle}>{ms(node.selfMs)}</td>
            <td style={tdNumStyle}>{node.calls}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Stat({ k, v, bad }: { k: string; v: string | number; bad?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, opacity: 0.6 }}>{k}</div>
      <div style={{ fontSize: 15, fontVariantNumeric: 'tabular-nums', color: bad ? '#ff8a7a' : undefined }}>{v}</div>
    </div>
  );
}

const headingStyle: CSSProperties = { fontSize: 12, opacity: 0.75, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 };
const hintStyle: CSSProperties = { fontSize: 11, opacity: 0.55, lineHeight: 1.45, marginBottom: 6 };
const noteStyle: CSSProperties = { fontSize: 11, opacity: 0.8, lineHeight: 1.45, marginTop: 8, padding: '6px 8px', background: 'rgba(255,255,255,0.06)', borderRadius: 4 };
const gridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 10, marginTop: 6 };
const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 11, fontVariantNumeric: 'tabular-nums', marginTop: 6 };
const thStyle: CSSProperties = { textAlign: 'left', padding: '3px 6px', opacity: 0.5, fontWeight: 500, borderBottom: '1px solid rgba(255,255,255,0.12)' };
const thNumStyle: CSSProperties = { ...thStyle, textAlign: 'right' };
const tdStyle: CSSProperties = { padding: '3px 6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 };
const tdNumStyle: CSSProperties = { ...tdStyle, textAlign: 'right' };
const tabBtn = (on: boolean): CSSProperties => ({
  fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer',
  border: '1px solid rgba(255,255,255,0.15)',
  background: on ? 'rgba(255,255,255,0.16)' : 'transparent',
  color: 'inherit', opacity: on ? 1 : 0.6,
});
