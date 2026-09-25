/** The editor's render flow (#1488): a take is saved → the options dialog → the backend's render
 *  job → the progress card. The wiring between them; the decisions live in `renderOptions.ts` and
 *  `renderJobModel.ts`, and the backend half in `engine/plugins/backend/recordRenderJob.ts`.
 *
 *  A module-level store read with `useSyncExternalStore`, not an `editorStore` slice: nothing
 *  outside this flow reads it.
 *
 *  ⚠️ **The job lives in the BACKEND, and this page may be a reloaded one.** Editing game code
 *  force-reloads the editor, which is exactly why the render is a job and not a stream. So
 *  `initRenderFlow` asks the backend for its job at boot and resumes polling a running one — a
 *  render started before the reload keeps its card. */

import { onTakeSaved, type SavedTake } from './takeRecorder';
import { initialRenderOptions, type RenderOptions } from './renderOptions';
import type { RenderJobWire } from './renderJobModel';
import { backendFetch } from '../backend/editorBackend';
import { projectScopedKey } from '../projectScopedKey';
import { notifyListeners } from '../../runtime/core/notifyListeners';

export interface RenderFlowState {
  /** The take the options dialog is open for, or null when it is closed. */
  offer: SavedTake | null;
  /** The dialog's starting values for `offer`. */
  initial: RenderOptions | null;
  /** Whether this backend can render (`GET /api/record/render`); null until asked. */
  availability: { available: boolean; reason: string | null } | null;
  /** The backend's current or most recent job, while its card is showing. */
  job: RenderJobWire | null;
  /** `Date.now()` on the BACKEND minus here, so the card's clock reads the job's timestamps on
   *  their own clock. Zero on one machine, but the backend can be another process's view of it. */
  clockSkewMs: number;
  /** Why the last start or cancel was refused, shown in the dialog or card. */
  error: string | null;
  starting: boolean;
}

let state: RenderFlowState = { offer: null, initial: null, availability: null, job: null, clockSkewMs: 0, error: null, starting: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<RenderFlowState>) => { state = { ...state, ...patch }; notifyListeners(listeners, 'renderFlow', []); };

export function getRenderFlow(): RenderFlowState { return state; }
export function onRenderFlowChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const REMEMBER_KEY = 'modoki-render-options';

function rememberedOptions(): Partial<RenderOptions> | null {
  try {
    const raw = localStorage.getItem(projectScopedKey(REMEMBER_KEY));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Partial<RenderOptions>) : null;
  } catch { return null; }
}

function remember(options: RenderOptions): void {
  try { localStorage.setItem(projectScopedKey(REMEMBER_KEY), JSON.stringify(options)); } catch { /* quota/private mode */ }
}

async function projectOutputHeight(): Promise<number | undefined> {
  try {
    const r = await backendFetch('/api/project-settings');
    const cfg = r.ok ? (await r.json()) as { recording?: { outputHeight?: number } } : null;
    const h = cfg?.recording?.outputHeight;
    return typeof h === 'number' && h > 0 ? h : undefined;
  } catch { return undefined; }
}

interface StatusResponse { available: boolean; reason: string | null; job: RenderJobWire | null; now: number }

async function fetchStatus(): Promise<StatusResponse | null> {
  try {
    const r = await backendFetch('/api/record/render');
    return r.ok ? (await r.json()) as StatusResponse : null;
  } catch { return null; }
}

// ── Polling ─────────────────────────────────────────────────────────────────────────────────────
const POLL_MS = 500;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function applyStatus(s: StatusResponse): void {
  // Keep a finished job's card up until it is dismissed — but never resurrect one that was.
  const job = s.job && s.job.id !== dismissedJob ? s.job : null;
  set({ availability: { available: s.available, reason: s.reason }, job, clockSkewMs: s.now - Date.now() });
  if (job?.status === 'running') schedulePoll();
}

function schedulePoll(): void {
  if (pollTimer) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void fetchStatus().then((s) => {
      if (s) applyStatus(s);
      // A backend that did not answer is retried: it may be restarting, and the job is its to keep.
      else if (state.job?.status === 'running') schedulePoll();
    });
  }, POLL_MS);
}

// ── Actions ─────────────────────────────────────────────────────────────────────────────────────
let dismissedJob: number | null = null;

/** Open the dialog for a take that was just saved. */
async function offer(saved: SavedTake): Promise<void> {
  const [status, outputHeight] = await Promise.all([fetchStatus(), projectOutputHeight()]);
  if (status) applyStatus(status);
  set({ offer: saved, initial: initialRenderOptions(rememberedOptions(), outputHeight, saved.take.viewport), error: null });
}

/** Render the offered take. Closes the dialog once the backend has the job. */
export async function startRender(options: RenderOptions): Promise<void> {
  const saved = state.offer;
  if (!saved || state.starting) return;
  set({ starting: true, error: null });
  try {
    const r = await backendFetch('/api/record/render', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ take: saved.file, options }),
    });
    const body = await r.json().catch(() => ({})) as { job?: RenderJobWire; now?: number; error?: string };
    if (!r.ok || !body.job) { set({ starting: false, error: body.error ?? `the backend refused the render (${r.status})` }); return; }
    remember(options);
    set({ starting: false, offer: null, initial: null, job: body.job, clockSkewMs: (body.now ?? Date.now()) - Date.now() });
    schedulePoll();
  } catch (e) {
    set({ starting: false, error: `could not reach the backend: ${e instanceof Error ? e.message : String(e)}` });
  }
}

/** Close the dialog without rendering. The take stays on disk (`npm run record -- <take>`). */
export function declineRender(): void {
  set({ offer: null, initial: null, error: null });
}

export async function cancelRender(): Promise<void> {
  try {
    const r = await backendFetch('/api/record/render/cancel', { method: 'POST' });
    const body = await r.json().catch(() => ({})) as { job?: RenderJobWire; error?: string };
    if (body.job) set({ job: body.job });
    else if (!r.ok) set({ error: body.error ?? `cancel refused (${r.status})` });
  } catch (e) {
    set({ error: `could not reach the backend: ${e instanceof Error ? e.message : String(e)}` });
  }
  schedulePoll();
}

/** Hide a finished job's card. */
export function dismissRenderJob(): void {
  if (state.job && state.job.status !== 'running') {
    dismissedJob = state.job.id;
    set({ job: null, error: null });
  }
}

/** Show a finished job's video in Finder/Explorer. The backend looks the file up by the job, so it
 *  works for a folder outside the project too. Resolves with why it could not, or null. */
export async function revealRenderedVideo(jobId: number): Promise<string | null> {
  try {
    const r = await backendFetch('/api/record/render/reveal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: jobId }),
    });
    if (r.ok) return null;
    const body = await r.json().catch(() => ({})) as { error?: string };
    return body.error ?? `could not reveal it (${r.status})`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

let initialised = false;

/** Subscribe to saved takes, and pick up a job a previous page left running. Once per page. */
export function initRenderFlow(): () => void {
  if (initialised) return () => {};
  initialised = true;
  const off = onTakeSaved((saved) => { void offer(saved); });
  // A finished job from before this page loaded is not shown: its card was the previous page's.
  void fetchStatus().then((s) => { if (s?.job?.status === 'running') applyStatus(s); else if (s) set({ availability: { available: s.available, reason: s.reason } }); });
  return () => {
    off();
    initialised = false;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  };
}
