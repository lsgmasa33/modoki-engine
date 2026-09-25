/** What the render progress card shows for a job (#1488) — pure, so the card's decisions carry
 *  unit tests and the `.tsx` only draws them (docs/editor.md § Panels).
 *
 *  `RenderJobWire` is the JSON `GET /api/record/render` answers with. Its source of truth is
 *  `RenderJobView` in `engine/plugins/backend/recordRenderJob.ts`, which the editor package cannot
 *  import, so only the fields the card reads are restated here. */

import { etaSeconds, formatDuration } from './renderOptions';

export interface RenderJobWire {
  id: number;
  take: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  stage: 'starting' | 'server' | 'boot' | 'frames' | 'encode' | 'done' | 'error' | 'cancelled';
  frame: number;
  total: number | null;
  size: { width: number; height: number } | null;
  video: string | null;
  startedAt: number;
  stageStartedAt: number;
  finishedAt: number | null;
  cancelRequested: boolean;
  result: {
    video: string;
    reportFile: string;
    size: { width: number; height: number };
    frames: number;
    renderSeconds: number;
    undispatchedEvents: number;
    unsettled: { videoFrame: number; duringBoot: boolean; pending: string[] }[];
    pageErrors: number;
    pageErrorSample: string[];
    replay: {
      status: string;
      reason?: string;
      counts?: { type: string; played: number; replayed: number }[];
      details?: { type: string; occurrence: number; fields: { path: string; played: unknown; replayed: unknown }[] }[];
    };
    /** `TakeAssetsCheck` in `engine/plugins/takeAssets.ts` (#1509). Optional: an older CLI sends none. */
    assets?: { status: string; reason?: string; checked?: number; changed?: string[]; added?: string[] };
  } | null;
  error: string | null;
  log: string[];
}

export interface RenderCardWarning { level: 'warn' | 'info'; text: string }

export interface RenderCardModel {
  title: string;
  /** 0..1, or null for a stage with no measurable progress (starting the server, booting). */
  progress: number | null;
  /** `frame 120 / 1414 · 0:42 elapsed · ~2:31 left`. */
  detail: string;
  warnings: RenderCardWarning[];
  canCancel: boolean;
}

const STAGE_TITLE: Record<RenderJobWire['stage'], string> = {
  starting: 'Starting the render…',
  server: 'Starting the dev server…',
  boot: 'Booting the game…',
  frames: 'Rendering frames',
  encode: 'Encoding the video',
  done: 'Video rendered',
  error: 'Render failed',
  cancelled: 'Render cancelled',
};

export function describeRenderJob(job: RenderJobWire, now: number): RenderCardModel {
  const running = job.status === 'running';
  const title = running && job.cancelRequested ? 'Cancelling…' : STAGE_TITLE[job.stage];
  const end = job.finishedAt ?? now;
  const elapsed = `${formatDuration((end - job.startedAt) / 1000)} elapsed`;

  let progress: number | null = null;
  let detail = elapsed;
  if (running && (job.stage === 'frames' || job.stage === 'encode') && job.total) {
    progress = Math.min(1, job.frame / job.total);
    const unit = job.stage === 'frames' ? 'frame' : 'encoded';
    // Per stage: the frame rate measured in THIS stage predicts only this stage's remainder.
    const eta = etaSeconds(job.frame, job.total, (now - job.stageStartedAt) / 1000);
    detail = `${unit} ${job.frame} / ${job.total} · ${elapsed}${eta !== null ? ` · ~${formatDuration(eta)} left` : ''}`;
  } else if (job.status === 'done' && job.result) {
    progress = 1;
    const r = job.result;
    detail = `${r.size.width}×${r.size.height} · ${r.frames} frames in ${formatDuration(r.renderSeconds)}`;
  } else if (job.status === 'error') {
    detail = job.error ?? 'the render failed';
  }

  return { title, progress, detail, warnings: job.result ? resultWarnings(job.result) : [], canCancel: running && !job.cancelRequested };
}

/** A payload value in a few characters. */
function short(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  return s.length > 24 ? `${s.slice(0, 23)}…` : s;
}

/** What in `render.json` needs the owner's attention, most serious first. */
export function resultWarnings(r: NonNullable<RenderJobWire['result']>): RenderCardWarning[] {
  const out: RenderCardWarning[] = [];
  if (r.replay.status === 'diverged') {
    const c = (r.replay.counts ?? []).slice(0, 3).map((x) => `"${x.type}" ${x.played}× played, ${x.replayed}× replayed`).join('; ');
    out.push({ level: 'warn', text: `The replay did not do what you played: ${c}. The video may not show your take (render.json: replay)` });
  }
  if (r.replay.status === 'diverged' || r.replay.status === 'differs') {
    const d = (r.replay.details ?? []).slice(0, 3).map((x) => `"${x.type}" ${x.fields.map((f) => `${f.path} ${short(f.played)}→${short(f.replayed)}`).join(', ')}`).join('; ');
    if (d) {
      out.push({
        level: r.replay.status === 'differs' ? 'info' : 'warn',
        text: `Event details differ: ${d}. Gesture travel and hold times are quantised to the frame rate; a different outcome (a cell, a score) means the replay went elsewhere`,
      });
    }
  }
  for (const u of r.unsettled) {
    out.push(u.duringBoot
      ? { level: 'warn', text: `Gave up waiting for ${u.pending.join(', ')} while booting — the whole video may be missing it` }
      : { level: 'warn', text: `Gave up waiting for ${u.pending.join(', ')} at frame ${u.videoFrame} — frames from there may be missing it` });
  }
  if (r.undispatchedEvents) out.push({ level: 'warn', text: `${r.undispatchedEvents} input event(s) fell after the last frame` });
  if (r.pageErrors) {
    out.push({ level: 'warn', text: `${r.pageErrors} page error(s)${r.pageErrorSample.length ? `, e.g. ${r.pageErrorSample[0].slice(0, 160)}` : ''} (render.json: pageErrors)` });
  }
  if (r.assets?.status === 'changed') {
    const names = [...(r.assets.changed ?? []), ...(r.assets.added ?? []).map((a) => `${a} (new)`)];
    out.push({
      level: 'warn',
      text: `${names.length} asset(s) this take uses changed since you recorded it, and the video shows them as they are now: `
        + `${names.slice(0, 4).join(', ')}${names.length > 4 ? `, +${names.length - 4} more` : ''} (render.json: assets)`,
    });
  }
  if (r.replay.status === 'unchecked') out.push({ level: 'info', text: 'Replay not checked: this take was recorded before takes stored their game events' });
  return out;
}
