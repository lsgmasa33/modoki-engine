/** The gameplay recorder's render UI (#1488): the options dialog that opens when a take is saved,
 *  and the progress card that follows the render. Drawing only — the decisions are in
 *  `recorder/renderOptions.ts` and `recorder/renderJobModel.ts`, the wiring in `recorder/renderFlow.ts`.
 *
 *  The dialog is a MODAL (one-shot, nothing to do underneath while choosing); the card is NOT. A
 *  render takes several times the take's length, and the editor stays usable while it runs. */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { ModalShell } from '../components/ModalShell';
import { useHmrEpoch } from '../input/hmrEpoch';
import { backendFetch } from '../backend/editorBackend';
import {
  getRenderFlow, onRenderFlowChange, startRender, declineRender, cancelRender, dismissRenderJob, revealRenderedVideo, initRenderFlow,
} from '../recorder/renderFlow';
import { outputSize, renderOptionProblems, RENDER_FPS_MIN, RENDER_FPS_MAX, RENDER_SCALE_MAX, type RenderOptions } from '../recorder/renderOptions';
import { describeRenderJob } from '../recorder/renderJobModel';

const inputStyle: React.CSSProperties = {
  boxSizing: 'border-box', padding: '4px 8px', background: '#15151f', color: '#ddd',
  border: '1px solid #444', borderRadius: 3, fontFamily: 'monospace', fontSize: 12,
};
const labelStyle: React.CSSProperties = { color: '#aaa', fontSize: 11, marginBottom: 3 };
const btn = (primary = false, disabled = false): React.CSSProperties => ({
  padding: '5px 16px', border: `1px solid ${primary && !disabled ? '#3a7a3a' : '#555'}`, borderRadius: 3,
  background: primary && !disabled ? '#245c2a' : '#2a2a40', color: disabled ? '#666' : primary ? '#fff' : '#ccc',
  cursor: disabled ? 'default' : 'pointer', fontFamily: 'monospace', fontSize: 11,
});

/** Mount once, in the editor shell. */
export default function RenderTakeUI() {
  // Keyed on the HMR epoch, not `[]`: a hot update re-instantiates `renderFlow` and `takeRecorder`,
  // and Fast Refresh does not re-run a `[]` effect — so the NEW recorder's take-saved event had no
  // subscriber and Stop opened nothing (measured after an edit to take.ts). See input/hmrEpoch.ts.
  const hmrEpoch = useHmrEpoch();
  useEffect(() => initRenderFlow(), [hmrEpoch]);
  const flow = useSyncExternalStore(onRenderFlowChange, getRenderFlow);
  return (
    <>
      {flow.offer && flow.initial && <RenderOptionsDialog key={flow.offer.file} />}
      {flow.job && <RenderProgressCard />}
    </>
  );
}

function RenderOptionsDialog() {
  const flow = useSyncExternalStore(onRenderFlowChange, getRenderFlow);
  const saved = flow.offer!;
  const [opts, setOpts] = useState<RenderOptions>(flow.initial!);
  // The number fields hold what was TYPED, so a half-typed "1." is not snapped back to "1".
  const [fpsText, setFpsText] = useState(String(opts.fps));
  const [scaleText, setScaleText] = useState(String(opts.scale));
  const candidate: RenderOptions = { ...opts, fps: Number(fpsText), scale: Number(scaleText) };
  const problems = renderOptionProblems(candidate);
  const size = problems.some((p) => p.startsWith('Scale')) ? null : outputSize(saved.take.viewport, candidate.scale, candidate.format);
  const available = flow.availability?.available !== false;
  const busy = flow.starting || flow.job?.status === 'running';
  const canRender = available && problems.length === 0 && !busy;
  const takeName = saved.file.split(/[\\/]/).pop();
  const pickFolder = async () => {
    const r = await backendFetch('/api/pick-path', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'folder', prompt: 'Render the video into' }),
    }).then((x) => x.json()).catch(() => null) as { abs?: string } | null;
    if (r?.abs) setOpts((o) => ({ ...o, outDir: r.abs! }));
  };

  return (
    <ModalShell kind="render-take">
      <div data-ui-id="renderTake.dialog" onClick={(e) => e.stopPropagation()} style={{
        background: '#1e1e30', border: '1px solid #555', borderRadius: 6, padding: '16px 20px',
        width: 480, maxWidth: '92vw', fontFamily: 'monospace',
      }}>
        <div style={{ color: '#fff', fontSize: 13, marginBottom: 4 }}>Render the take to video</div>
        <div style={{ color: '#888', fontSize: 11, marginBottom: 12 }}>
          Saved <span style={{ color: '#aaa' }}>{takeName}</span> — {saved.take.duration.toFixed(1)} s,
          played at {saved.take.viewport.width}×{saved.take.viewport.height}. The render replays it offline, so it takes a few
          times the take's length; the editor stays usable meanwhile.
        </div>

        {!available ? (
          <div data-ui-id="renderTake.unavailable" style={{ color: '#e0a030', fontSize: 11, marginBottom: 12 }}>
            This editor can't render: {flow.availability?.reason}. The take is saved; render it from a terminal with
            <div style={{ color: '#ccc', marginTop: 4, userSelect: 'text', wordBreak: 'break-all' }}>npm run record -- {saved.file}</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <div style={labelStyle}>FPS</div>
              <input data-ui-id="renderTake.fps" data-ui-kind="field" data-ui-label="FPS" type="number" min={RENDER_FPS_MIN} max={RENDER_FPS_MAX} step={1}
                style={{ ...inputStyle, width: '100%' }} value={fpsText} onChange={(e) => setFpsText(e.target.value)} />
            </div>
            <div>
              <div style={labelStyle}>Format</div>
              <select data-ui-id="renderTake.format" data-ui-kind="select" data-ui-label="Format" data-ui-state={opts.format}
                style={{ ...inputStyle, width: '100%' }} value={opts.format} onChange={(e) => setOpts((o) => ({ ...o, format: e.target.value as RenderOptions['format'] }))}>
                <option value="mp4">H.264 .mp4</option>
                <option value="mov">ProRes 422 HQ .mov</option>
              </select>
            </div>
            <div>
              <div style={labelStyle}>Scale</div>
              <input data-ui-id="renderTake.scale" data-ui-kind="field" data-ui-label="Scale" type="number" min={0.25} max={RENDER_SCALE_MAX} step={0.25}
                style={{ ...inputStyle, width: '100%' }} value={scaleText} onChange={(e) => setScaleText(e.target.value)} />
            </div>
            <div>
              <div style={labelStyle}>Output size</div>
              <div data-ui-id="renderTake.size" style={{ color: size ? '#2ecc71' : '#666', fontSize: 13, paddingTop: 4 }}>
                {size ? `${size.width}×${size.height}` : '—'}
              </div>
            </div>
            <div style={{ gridColumn: '1 / span 2' }}>
              <div style={labelStyle}>Output folder <span style={{ color: '#666' }}>— the video goes in a folder named after the take, inside it</span></div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input data-ui-id="renderTake.outDir" data-ui-kind="field" data-ui-label="Output folder" type="text"
                  style={{ ...inputStyle, flex: 1, minWidth: 0 }} value={opts.outDir ?? ''} placeholder="the take's own folder"
                  onChange={(e) => setOpts((o) => ({ ...o, outDir: e.target.value.trim() ? e.target.value : null }))} />
                <button data-ui-id="renderTake.chooseFolder" style={btn()} onClick={() => { void pickFolder(); }}>Choose…</button>
              </div>
            </div>
            <label style={{ gridColumn: '1 / span 2', color: '#aaa', fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input data-ui-id="renderTake.keepFrames" data-ui-kind="checkbox" data-ui-label="Keep frames" type="checkbox" checked={opts.keepFrames}
                onChange={(e) => setOpts((o) => ({ ...o, keepFrames: e.target.checked }))} />
              Keep the PNG frames too
            </label>
          </div>
        )}

        {available && problems.length > 0 && (
          <div data-ui-id="renderTake.problems" style={{ color: '#e0a030', fontSize: 11, marginBottom: 8 }}>{problems.join(' · ')}</div>
        )}
        {busy && !flow.starting && <div style={{ color: '#e0a030', fontSize: 11, marginBottom: 8 }}>Another render is still running — cancel it or wait for it to finish.</div>}
        {flow.error && <div data-ui-id="renderTake.error" style={{ color: '#e74c3c', fontSize: 11, marginBottom: 8, whiteSpace: 'pre-wrap' }}>{flow.error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
          <button data-ui-id="renderTake.notNow" data-ui-kind="button" data-ui-label={available ? 'Not now' : 'OK'} style={btn()} onClick={declineRender}
            title="Keep the take on disk without rendering — npm run record renders it later">
            {available ? 'Not now' : 'OK'}
          </button>
          {available && (
            <button data-ui-id="renderTake.render" data-ui-kind="button" data-ui-label="Render" style={btn(true, !canRender)} disabled={!canRender}
              onClick={() => { void startRender(candidate); }}>
              {flow.starting ? 'Starting…' : 'Render'}
            </button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function RenderProgressCard() {
  const flow = useSyncExternalStore(onRenderFlowChange, getRenderFlow);
  const job = flow.job!;
  // Re-render every second while running, so elapsed and the ETA tick between polls.
  const [, tick] = useState(0);
  useEffect(() => {
    if (job.status !== 'running') return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [job.status]);
  const [revealError, setRevealError] = useState<string | null>(null);
  const model = describeRenderJob(job, Date.now() + flow.clockSkewMs);
  const color = job.status === 'done' ? '#2ecc71' : job.status === 'error' ? '#e74c3c' : job.status === 'cancelled' ? '#aaa' : '#ddd';
  const video = job.result?.video ?? null;

  return (
    <div data-ui-id="renderTake.card" data-ui-state={job.status} style={{
      position: 'fixed', right: 12, bottom: 12, width: 360, zIndex: 1000,
      background: '#1e1e30', border: '1px solid #555', borderRadius: 6, padding: '10px 12px',
      fontFamily: 'monospace', boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span data-ui-id="renderTake.card.title" style={{ color, fontSize: 12, flex: 1 }}>{model.title}</span>
        {model.canCancel && (
          <button data-ui-id="renderTake.cancel" data-ui-kind="button" data-ui-label="Cancel" style={btn()} onClick={() => { void cancelRender(); }}>Cancel</button>
        )}
        {job.status !== 'running' && (
          <button data-ui-id="renderTake.dismiss" data-ui-kind="button" data-ui-label="Close" style={btn()} onClick={dismissRenderJob}>Close</button>
        )}
      </div>
      {job.status === 'running' && (
        <div style={{ height: 6, background: '#101018', borderRadius: 3, marginTop: 8, overflow: 'hidden' }}>
          <div data-ui-id="renderTake.progress" style={{
            height: '100%', background: '#3a7a3a', borderRadius: 3,
            width: model.progress === null ? '30%' : `${Math.round(model.progress * 100)}%`,
            opacity: model.progress === null ? 0.4 : 1,
          }} />
        </div>
      )}
      <div data-ui-id="renderTake.detail" style={{ color: '#999', fontSize: 11, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{model.detail}</div>
      {video && (
        <div style={{ marginTop: 6, fontSize: 11 }}>
          <a data-ui-id="renderTake.reveal" href="#" style={{ color: '#7ab0ff' }}
            onClick={(e) => { e.preventDefault(); void revealRenderedVideo(job.id).then(setRevealError); }}>Reveal in Finder</a>
          <div style={{ color: '#666', marginTop: 2, userSelect: 'text', wordBreak: 'break-all' }}>{video}</div>
          {revealError && <div style={{ color: '#e0a030' }}>{revealError}</div>}
        </div>
      )}
      {model.warnings.length > 0 && (
        <div data-ui-id="renderTake.warnings" style={{ marginTop: 6, maxHeight: 140, overflowY: 'auto' }}>
          {model.warnings.map((w, i) => (
            <div key={i} style={{ color: w.level === 'warn' ? '#e0a030' : '#888', fontSize: 11, marginTop: 2 }}>⚠ {w.text}</div>
          ))}
        </div>
      )}
      {job.status === 'error' && job.log.length > 0 && (
        <div style={{ marginTop: 6, background: '#101018', border: '1px solid #333', borderRadius: 4, padding: 6, maxHeight: 120, overflowY: 'auto', fontSize: 10, color: '#999', whiteSpace: 'pre-wrap', userSelect: 'text' }}>
          {job.log.slice(-8).join('\n')}
        </div>
      )}
      {flow.error && <div style={{ color: '#e74c3c', fontSize: 11, marginTop: 6 }}>{flow.error}</div>}
    </div>
  );
}
