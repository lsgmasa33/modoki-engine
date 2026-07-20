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
 */

export interface OffscreenCameraOverride {
  /** World-space camera position [x,y,z]. Omit to keep the live camera's pose. */
  position?: [number, number, number];
  /** Look-at target [x,y,z]. Omit to keep the live camera's orientation. */
  target?: [number, number, number];
  /** Vertical FOV in degrees. Omit to keep the live camera's FOV. */
  fov?: number;
}

export interface OffscreenRenderOpts {
  /** Output width in px (default: the live viewport width; clamped to 4096). */
  width?: number;
  /** Output height in px (default: the live viewport height; clamped to 4096). */
  height?: number;
  /** JPEG quality 0..1 (default 0.85). */
  quality?: number;
  /** Optional deterministic camera override. */
  camera?: OffscreenCameraOverride;
}

export interface OffscreenRenderResult {
  width: number;
  height: number;
  /** A `data:image/jpeg;base64,…` URL of the rendered frame. The backend decodes
   *  it to a temp file so an agent gets a path, not an inline image. */
  dataUrl: string;
}

export type SceneRenderer = (opts: OffscreenRenderOpts) => Promise<OffscreenRenderResult>;

let current: SceneRenderer | null = null;

// Serialize captures: every renderSceneOffscreen() chains onto the previous one
// so two overlapping callers (e.g. a render-sequence + a manual render-scene, or
// two MCP clients) can never interleave their offscreen render-target binds and
// async readbacks. Without this, the second capture rebinds the renderer mid-
// readback of the first and the live loop can resume into a half-disposed target
// (P1-3). The `.catch` keeps a failed capture from poisoning the chain.
let queue: Promise<unknown> = Promise.resolve();

/** A mounted 3D view registers its offscreen render function (last wins). */
export function registerSceneRenderer(fn: SceneRenderer): void {
  current = fn;
}

/** Unregister on unmount — only if still the active one (avoids clobbering a
 *  newer registrant during React's mount-before-unmount ordering). */
export function unregisterSceneRenderer(fn: SceneRenderer): void {
  if (current === fn) current = null;
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
  const run = queue.then(() => fn(opts));
  queue = run.catch(() => {}); // next capture waits for this one, success or fail
  return run;
}
