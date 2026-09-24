/** The editor's gameplay-recorder RENDER JOB (#1488): runs `engine/scripts/record-take.mjs` for a
 *  saved take, keeps its progress, and cancels it.
 *
 *  **A job the editor polls, not a request-scoped stream.** A render runs about 3-4x the take's
 *  length (184 s for a 47 s take on Court), and editing game code force-reloads the editor page
 *  (docs/editor-hmr.md). The build routes' shape (an SSE stream whose disconnect IS the cancel) would
 *  turn that reload into a silent cancel. Here the job outlives the page: the reloaded page asks
 *  `GET /api/record/render` and finds it still running.
 *
 *  **Cancel closes the CLI's stdin.** `--watch-stdin` makes the CLI treat EOF as a cancel, and its
 *  own teardown is the only one that reaches Chromium — Playwright launches it DETACHED, in a
 *  process group of its own, so a group kill aimed at the CLI misses it (measured on this Mac:
 *  5 headless-shell processes outside the CLI's group). It is also what happens by itself when this
 *  backend dies: the pipes close and the render cancels itself (the CLI treats a lost stdout/stderr
 *  reader as a cancel too — measured, docs/gameplay-recorder.md). And it is the only cancel Windows
 *  could send, having no signals — though that has not been run on Windows. So the job is deliberately NOT registered with
 *  `buildStepShell`'s shutdown reaper, whose `exit` hook SIGKILLs a group — that would kill the CLI
 *  before it could close the browser. Only a CLI that ignores the EOF for `CANCEL_GRACE_MS` is
 *  killed outright (`killBuildProcess`: its group, then SIGKILL).
 *
 *  One render at a time per backend: two would compete for the GPU and double the wait for both. */

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { killBuildProcess } from '../buildStepShell';
import { renderCliArgs, renderOptionProblems, type RenderOptions } from '../../packages/modoki/src/editor/recorder/renderOptions';

export type RenderStage = 'starting' | 'server' | 'boot' | 'frames' | 'encode' | 'done' | 'error' | 'cancelled';
export type RenderStatus = 'running' | 'done' | 'error' | 'cancelled';

/** What the CLI's `done` line carries — the progress card's finish state. The full lists stay in
 *  `render.json`. */
export interface RenderResult {
  video: string;
  reportFile: string;
  size: { width: number; height: number };
  frames: number;
  fps: number;
  renderSeconds: number;
  undispatchedEvents: number;
  unsettled: { videoFrame: number; duringBoot: boolean; pending: string[] }[];
  pageErrors: number;
  pageErrorSample: string[];
  replay: { status: string; [k: string]: unknown };
}

/** One render job as the editor sees it (`GET /api/record/render`). */
export interface RenderJobView {
  id: number;
  take: string;
  options: RenderOptions;
  status: RenderStatus;
  stage: RenderStage;
  /** Frames captured, or frames encoded while `stage` is `encode`. */
  frame: number;
  total: number | null;
  size: { width: number; height: number } | null;
  video: string | null;
  startedAt: number;
  /** When the current stage began — the progress card's ETA is per stage. */
  stageStartedAt: number;
  finishedAt: number | null;
  cancelRequested: boolean;
  result: RenderResult | null;
  error: string | null;
  /** The CLI's last human-readable lines (stderr), for an error that needs its context. */
  log: string[];
}

const LOG_LINES = 30;
/** How long a cancelled CLI gets to close its browser and dev server before it is killed outright.
 *  Its teardown measured under 140 ms at every stage; the margin is for a loaded machine. */
export const CANCEL_GRACE_MS = 10_000;

/** Fold one progress line from the CLI into the job. Pure: returns a new view. Unknown stages are
 *  ignored, so a newer CLI can add one without breaking an older editor. */
export function applyProgressLine(view: RenderJobView, line: Record<string, unknown>, now: number): RenderJobView {
  const v: RenderJobView = { ...view };
  const stage = line.stage;
  const enter = (s: RenderStage) => { if (v.stage !== s) { v.stage = s; v.stageStartedAt = now; } };
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  switch (stage) {
    case 'start':
      v.total = num(line.total) ?? v.total;
      v.size = (line.size as RenderJobView['size']) ?? v.size;
      v.video = typeof line.video === 'string' ? line.video : v.video;
      break;
    case 'server':
    case 'boot':
      enter(stage);
      break;
    case 'frames':
    case 'encode':
      enter(stage);
      v.frame = num(line.frame) ?? v.frame;
      v.total = num(line.total) ?? v.total;
      break;
    case 'done':
      enter('done');
      v.status = 'done';
      v.finishedAt = now;
      v.result = line as unknown as RenderResult;
      v.video = typeof line.video === 'string' ? line.video : v.video;
      break;
    case 'error':
      enter('error');
      v.status = 'error';
      v.finishedAt = now;
      v.error = typeof line.message === 'string' ? line.message : 'the render failed';
      break;
    case 'cancelled':
      enter('cancelled');
      v.status = 'cancelled';
      v.finishedAt = now;
      break;
  }
  return v;
}

/** The job's final state once the CLI has exited. A CLI that exits without a closing line (a crash,
 *  an outright kill) still ends the job, as `cancelled` when one was asked for and `error` otherwise. */
export function applyExit(view: RenderJobView, code: number | null, signal: string | null, now: number): RenderJobView {
  if (view.status !== 'running') return view;
  if (view.cancelRequested) return { ...view, status: 'cancelled', stage: 'cancelled', stageStartedAt: now, finishedAt: now };
  const how = signal ? `was killed (${signal})` : `exited with code ${code}`;
  return { ...view, status: 'error', stage: 'error', stageStartedAt: now, finishedAt: now, error: `the render ${how} before it finished` };
}

/** Whether this backend can render at all, and why not. */
export function renderAvailability(repoRoot: string | undefined, env: NodeJS.ProcessEnv = process.env): { available: boolean; reason: string | null } {
  if (env.MODOKI_PACKAGED === '1') {
    return { available: false, reason: 'the packaged editor ships no Playwright Chromium — render from a repo checkout with `npm run record -- <take>`' };
  }
  if (!repoRoot || !fs.existsSync(renderScriptPath(repoRoot))) return { available: false, reason: 'engine/scripts/record-take.mjs is not in this editor\'s repo' };
  try {
    createRequire(path.join(repoRoot, 'package.json')).resolve('playwright-core');
  } catch {
    return { available: false, reason: 'playwright-core is not installed in this repo — run npm install' };
  }
  return { available: true, reason: null };
}

export function renderScriptPath(repoRoot: string): string {
  return path.join(repoRoot, 'engine', 'scripts', 'record-take.mjs');
}

/** How the job starts the CLI. Swapped in tests for a fake CLI. */
export type SpawnRender = (args: string[], cwd: string) => ChildProcess;

/** `process.execPath` with ELECTRON_RUN_AS_NODE: in the Electron editor this backend runs in the main
 *  process, whose execPath is the Electron binary — the same trick devServer.ts starts Vite with.
 *  Under a plain Node backend the variable is ignored. `detached` on posix gives the CLI its own
 *  process group, so the last-resort kill can reach its dev server too. */
export const defaultSpawnRender: SpawnRender = (args, cwd) => spawn(process.execPath, args, {
  cwd,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
  windowsHide: true,
});

export type StartResult = { ok: true; job: RenderJobView } | { ok: false; status: number; error: string };

export class RenderJobRunner {
  private view: RenderJobView | null = null;
  private proc: ChildProcess | null = null;
  private nextId = 1;

  private readonly spawnRender: SpawnRender;
  private readonly now: () => number;
  private readonly cancelGraceMs: number;

  constructor(spawnRender: SpawnRender = defaultSpawnRender, now: () => number = Date.now, cancelGraceMs = CANCEL_GRACE_MS) {
    this.spawnRender = spawnRender;
    this.now = now;
    this.cancelGraceMs = cancelGraceMs;
  }

  /** The current or most recent job, or null. */
  current(): RenderJobView | null { return this.view; }

  start(req: { repoRoot: string; scriptPath: string; take: string; options: RenderOptions }): StartResult {
    if (this.view?.status === 'running') return { ok: false, status: 409, error: 'a render is already running — cancel it or wait for it to finish' };
    const problems = renderOptionProblems(req.options);
    if (problems.length) return { ok: false, status: 400, error: problems.join('; ') };
    const now = this.now();
    let view: RenderJobView = {
      id: this.nextId++, take: req.take, options: req.options, status: 'running', stage: 'starting',
      frame: 0, total: null, size: null, video: null, startedAt: now, stageStartedAt: now, finishedAt: null,
      cancelRequested: false, result: null, error: null, log: [],
    };
    let proc: ChildProcess;
    try {
      proc = this.spawnRender([req.scriptPath, ...renderCliArgs(req.take, req.options)], req.repoRoot);
    } catch (e) {
      return { ok: false, status: 500, error: `could not start the render: ${e instanceof Error ? e.message : String(e)}` };
    }
    this.proc = proc;
    this.view = view;
    const id = view.id;
    // Every update goes through here, and only for THIS job: a stale process's late output must not
    // write into a newer job.
    const update = (fn: (v: RenderJobView) => RenderJobView) => {
      if (this.view?.id === id) { view = fn(this.view); this.view = view; }
    };
    lines(proc.stdout, (line) => {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { parsed = null; }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) update((v) => applyProgressLine(v, parsed as Record<string, unknown>, this.now()));
      else update((v) => ({ ...v, log: [...v.log, line].slice(-LOG_LINES) }));
    });
    lines(proc.stderr, (line) => update((v) => ({ ...v, log: [...v.log, line].slice(-LOG_LINES) })));
    // A write to a CLI that already exited raises EPIPE on stdin; the exit below is what counts.
    proc.stdin?.on('error', () => {});
    proc.once('error', (e) => update((v) => (v.status === 'running'
      ? { ...v, status: 'error', stage: 'error', finishedAt: this.now(), error: `could not start the render: ${e.message}` }
      : v)));
    proc.once('close', (code, signal) => {
      update((v) => applyExit(v, code, signal, this.now()));
      if (this.proc === proc) this.proc = null;
    });
    return { ok: true, job: view };
  }

  /** Ask the running render to stop. Returns the job, or null when nothing is running. */
  cancel(): RenderJobView | null {
    const v = this.view;
    const proc = this.proc;
    if (!v || v.status !== 'running' || !proc) return null;
    this.view = { ...v, cancelRequested: true };
    proc.stdin?.end();
    const escalate = setTimeout(() => killBuildProcess(proc), this.cancelGraceMs);
    escalate.unref?.();
    proc.once('close', () => clearTimeout(escalate));
    return this.view;
  }
}

/** Call `onLine` for each complete line of `stream`. */
function lines(stream: NodeJS.ReadableStream | null | undefined, onLine: (line: string) => void): void {
  if (!stream) return;
  let buf = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (d: string) => {
    buf += d;
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const p of parts) if (p.trim()) onLine(p.replace(/\r$/, ''));
  });
  stream.on('end', () => { if (buf.trim()) onLine(buf); buf = ''; });
}

/** The backend's one runner. */
export const renderJobs = new RenderJobRunner();
