/**
 * Offscreen scene capture registry (ELECTRON_PLAN Phase 5 — `render_scene`).
 *
 * `render_scene` needs a live WebGPU renderer + ECS world, which exist only in
 * the renderer process — so the active `Scene3D` registers a render function here
 * on mount, and the agent bridge calls `renderSceneOffscreen()` to produce a
 * deterministic, window-independent frame (caller-chosen size + camera) by
 * rendering the live scene into an offscreen target and reading it back.
 *
 * Unlike `capture_viewport` (a screenshot of the actual editor window — final
 * composited pixels, NPR included, but tied to the window's size/layout), this is
 * reproducible: same scene state + same camera ⇒ same framing, every time. The
 * forward pass only (NPR/post-FX is window-bound) — use it for geometry,
 * material, lighting, and camera-framing checks; use `capture_viewport` for the
 * final stylized look.
 *
 * Single-slot, last-registered-wins: with the editor open, the live game view's
 * Scene3D is the registrant. Throws a clear error if no 3D view is mounted.
 *
 * The registrant NAMES its surface, and `renderSceneOffscreen` echoes that name on
 * every result, because "which surface did I actually render?" is the one question
 * this tool's own description spends a paragraph on. It promised the echo and did not
 * deliver it (bug `XBayncnNfJj3RtjVZiBX`): the reply carried only path/width/height,
 * so a caller who branched on `surface` silently took the `undefined` branch. Deriving
 * it at the registry rather than in the route is what keeps it honest — the label comes
 * from whoever is actually mounted, so a second registrant cannot make it lie.
 */

export interface OffscreenCameraOverride {
  /** World-space camera position [x,y,z]. Omit to keep the live camera's pose. */
  position?: [number, number, number];
  /** Look-at target [x,y,z]. Omit to keep the live camera's orientation. */
  target?: [number, number, number];
  /** Vertical FOV in degrees. Omit to keep the live camera's FOV. */
  fov?: number;
}

/** JPEG quality, ONE UNIT: 1–100 (S3.13).
 *
 *  `quality` used to mean two different things across the three sibling capture tools —
 *  `render_scene`/`render_sequence` took a 0..1 fraction (straight to `canvas.toDataURL`, which
 *  per the HTML spec SILENTLY IGNORES an out-of-range number and uses the browser default), while
 *  `capture_viewport` took 1–100. So a sibling-habituated `quality:70` on render_scene produced
 *  the default with no warning, and `quality:0.9` on capture_viewport could have crashed the
 *  native encoder. The MCP tools now all take 1–100 and this converts; a legacy 0..1 fraction
 *  from a raw curl caller is still accepted rather than silently misread as "1%".
 *
 *  MIRRORED in `engine/electron/rendererOps.ts` (`normalizeJpegQuality`) — the Electron main
 *  process cannot import the runtime package. `engine/tests/electron/captureScale.test.ts` asserts
 *  the two agree over a sample, so the copies cannot drift (conventions §9). */
export function normalizeJpegQuality(raw: number | undefined, fallback = 85): { pct: number; fraction: number } {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  // A value in (0,1] is a legacy fraction; 1 is ambiguous and means "1%" nowhere useful, so it is
  // read as the fraction 1.0 = best quality.
  const pct = n > 0 && n <= 1 ? n * 100 : n;
  const clamped = Math.max(1, Math.min(100, Math.round(pct)));
  return { pct: clamped, fraction: clamped / 100 };
}

export interface OffscreenRenderOpts {
  /** Output width in px (default: the live viewport width; clamped to 4096). */
  width?: number;
  /** Output height in px (default: the live viewport height; clamped to 4096). */
  height?: number;
  /** JPEG quality 1–100 (default 85). A legacy 0..1 fraction is still accepted — see
   *  {@link normalizeJpegQuality}. The effective 1–100 value is echoed back as `quality`. */
  quality?: number;
  /** Optional deterministic camera override. */
  camera?: OffscreenCameraOverride;
}

export interface OffscreenRenderResult {
  width: number;
  height: number;
  /** Which on-screen surface served this render — the label the mounted registrant gave.
   *  Today that is always `'game-3d'` (only the runtime `Scene3D` registers), which is
   *  exactly what the caller needs confirmed: `render_scene` never renders the editor
   *  SceneView you are orbiting. Attached by {@link renderSceneOffscreen}, not by the
   *  renderer function itself. */
  surface?: string;
  /** The EFFECTIVE JPEG quality actually used, 1–100 — echoed so a caller can see that its
   *  out-of-unit value was converted/clamped rather than silently ignored (S3.13). */
  quality?: number;
  /** A `data:image/jpeg;base64,…` URL of the rendered frame. The backend decodes
   *  it to a temp file so an agent gets a path, not an inline image. */
  dataUrl: string;
}

export type SceneRenderer = (opts: OffscreenRenderOpts) => Promise<OffscreenRenderResult>;

let current: SceneRenderer | null = null;
/** The surface label of the currently registered renderer — see {@link registerSceneRenderer}. */
let currentSurface: string | null = null;

// Serialize captures: every renderSceneOffscreen() chains onto the previous one
// so two overlapping callers (e.g. a render-sequence + a manual render-scene, or
// two MCP clients) can never interleave their offscreen render-target binds and
// async readbacks. Without this, the second capture rebinds the renderer mid-
// readback of the first and the live loop can resume into a half-disposed target
// (P1-3). The `.catch` keeps a failed capture from poisoning the chain.
let queue: Promise<unknown> = Promise.resolve();

/** A mounted 3D view registers its offscreen render function (last wins), NAMING the
 *  surface it renders (`'game-3d'` for the runtime `Scene3D`). The name is echoed on
 *  every result so a caller can confirm which surface served the frame instead of
 *  inferring it. */
export function registerSceneRenderer(fn: SceneRenderer, surface = 'game-3d'): void {
  current = fn;
  currentSurface = surface;
}

/** Unregister on unmount — only if still the active one (avoids clobbering a
 *  newer registrant during React's mount-before-unmount ordering). */
export function unregisterSceneRenderer(fn: SceneRenderer): void {
  if (current === fn) { current = null; currentSurface = null; }
}

/** True if a 3D view is mounted and can render offscreen. */
export function hasSceneRenderer(): boolean {
  return current != null;
}

/** Render the live scene offscreen. Throws if no 3D view is mounted. Calls are
 *  serialized — concurrent callers run one-at-a-time, never interleaved. */
export function renderSceneOffscreen(opts: OffscreenRenderOpts = {}): Promise<OffscreenRenderResult> {
  const fn = current;
  if (!fn) return Promise.reject(new Error('no scene renderer registered — is a 3D view (game/scene) mounted?'));
  // Read the label at CALL time, not inside the queued continuation: it must describe the
  // registrant that this call resolved, even if a remount swaps the slot while we wait.
  const surface = currentSurface ?? undefined;
  const run = queue.then(() => fn(opts)).then((res) => ({ ...res, ...(surface ? { surface } : {}) }));
  queue = run.catch(() => {}); // next capture waits for this one, success or fail
  return run;
}
