/** The render dialog's decisions (#1488): what the options are, which values are legal, what a
 *  given scale produces, where the defaults come from, and the CLI arguments they turn into.
 *
 *  Pure and dependency-free, so the dialog, the backend's render job, the CLI
 *  (`engine/scripts/record-take.mjs` loads this file for its flag bounds and output size) and the
 *  unit tests all read one definition. */

/** `timeSystem` clamps every frame's delta to 1/30 s, so below 30 fps each step advances the sim by
 *  less than a video frame and the video plays slow (docs/gameplay-recorder.md § Gotchas). A floor,
 *  not a preference. */
export const RENDER_FPS_MIN = 30;
export const RENDER_FPS_MAX = 120;
/** The CLI's `--scale` range is (0, 4]. */
export const RENDER_SCALE_MAX = 4;

export type RenderFormat = 'mp4' | 'mov';

export interface RenderOptions {
  fps: number;
  /** Device scale factor over the take's layout size — the output resolution. */
  scale: number;
  /** H.264 `.mp4`, or ProRes 422 HQ `.mov` (`--prores`). */
  format: RenderFormat;
  /** Absolute folder the take's OWN output folder (named after the take) goes in, or null for the
   *  folder the take is in. Never the video's folder itself: one chosen folder, reused, must not
   *  have every render overwrite the last. */
  outDir: string | null;
  keepFrames: boolean;
}

/** Used only where nothing better is known: no remembered choice for this project, and no
 *  `recording.outputHeight` in its settings. */
export const FALLBACK_RENDER_OPTIONS: Readonly<RenderOptions> = { fps: 30, scale: 2, format: 'mp4', outDir: null, keepFrames: false };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Every problem with `raw` as render options, or none. The dialog disables Render while there are
 *  any; the backend refuses the request with them. */
export function renderOptionProblems(raw: unknown): string[] {
  const o = (raw ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  if (!isNum(o.fps) || o.fps < RENDER_FPS_MIN || o.fps > RENDER_FPS_MAX) {
    problems.push(`FPS must be between ${RENDER_FPS_MIN} and ${RENDER_FPS_MAX} — below ${RENDER_FPS_MIN} the video plays slow (the engine clamps a frame to 1/30 s)`);
  }
  if (!isNum(o.scale) || o.scale <= 0 || o.scale > RENDER_SCALE_MAX) problems.push(`Scale must be above 0 and at most ${RENDER_SCALE_MAX}`);
  if (o.format !== 'mp4' && o.format !== 'mov') problems.push('Format must be mp4 or mov');
  if (o.outDir !== null && (typeof o.outDir !== 'string' || !isAbsolutePath(o.outDir))) problems.push('Output folder must be an absolute path, or empty for the take\'s own folder');
  if (typeof o.keepFrames !== 'boolean') problems.push('Keep frames must be true or false');
  return problems;
}

/** POSIX `/…`, or a Windows drive (`C:\…`, `C:/…`) or UNC (`\\host\…`) path. */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** The video's size in pixels. H.264 in yuv420p needs even dimensions, so the CLI pads an odd one by
 *  a pixel (a 375×667 preset at ×1 would otherwise fail to encode); ProRes 4:2:2 needs an even width
 *  only. This is that same arithmetic, so the dialog shows what the file will be. */
export function outputSize(viewport: { width: number; height: number }, scale: number, format: RenderFormat): { width: number; height: number } {
  const w = Math.round(viewport.width * scale);
  const h = Math.round(viewport.height * scale);
  const even = (n: number) => n + (n % 2);
  return format === 'mp4' ? { width: even(w), height: even(h) } : { width: even(w), height: h };
}

/** The scale that renders a layout `layoutHeight` px tall at `outputHeight` px — the project
 *  setting's way of saying "our ads are 1920 tall". Rounded to 3 decimals and clamped into range. */
export function scaleForOutputHeight(outputHeight: number, layoutHeight: number): number | null {
  if (!isNum(outputHeight) || outputHeight <= 0 || !isNum(layoutHeight) || layoutHeight <= 0) return null;
  const s = Math.round((outputHeight / layoutHeight) * 1000) / 1000;
  return Math.min(RENDER_SCALE_MAX, Math.max(0.001, s));
}

/** What the dialog opens with. Per field: the value last used in this project, if it is still
 *  legal; else, for Scale, the project's `recording.outputHeight`; else the fallback. Remembered
 *  wins over the project setting because it is a choice the owner made in this dialog, later. */
export function initialRenderOptions(
  remembered: Partial<RenderOptions> | null,
  projectOutputHeight: number | undefined,
  viewport: { width: number; height: number },
): RenderOptions {
  const out: RenderOptions = { ...FALLBACK_RENDER_OPTIONS };
  const fromSetting = projectOutputHeight !== undefined ? scaleForOutputHeight(projectOutputHeight, viewport.height) : null;
  if (fromSetting !== null) out.scale = fromSetting;
  if (!remembered) return out;
  // Field by field, each checked alone: one stale field must not throw away the others.
  for (const key of Object.keys(FALLBACK_RENDER_OPTIONS) as (keyof RenderOptions)[]) {
    if (!(key in remembered)) continue;
    const candidate = { ...out, [key]: remembered[key] };
    if (renderOptionProblems(candidate).length === 0) Object.assign(out, { [key]: remembered[key] });
  }
  return out;
}

/** The CLI arguments for rendering `takePath` with `options`, after the script path. The editor's
 *  job always asks for machine-readable progress and for stdin to be watched (see the CLI header). */
export function renderCliArgs(takePath: string, options: RenderOptions): string[] {
  const args = [takePath, '--ndjson', '--watch-stdin', '--fps', String(options.fps), '--scale', String(options.scale)];
  if (options.format === 'mov') args.push('--prores');
  if (options.keepFrames) args.push('--keep-frames');
  if (options.outDir) args.push('--out', options.outDir);
  return args;
}

/** Seconds left, from how long `done` of `total` units took. Null until there is a rate to go on. */
export function etaSeconds(done: number, total: number, elapsedSeconds: number): number | null {
  if (!(done > 0) || !(total > 0) || !(elapsedSeconds > 0) || done > total) return null;
  return (elapsedSeconds / done) * (total - done);
}

/** `m:ss` — or `h:mm:ss` from an hour up. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
