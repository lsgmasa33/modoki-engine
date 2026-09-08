/**
 * Renderer-bound editor ops served only by the Electron main process
 * (ELECTRON_PLAN Phase 5: the `R` / main-driven tools). These complete the MCP
 * verification loop — "does it actually render?" and "exercise the game".
 *
 * Capture uses Electron's NativeImage (resize + JPEG) so no `sharp` is needed and
 * the contract — downscaled JPEG, ≤1568px longest side, quality ~70, returned as
 * a file PATH (never inline) — is honoured to protect Claude's context.
 *
 * Input uses `webContents.sendInputEvent`, which injects REAL OS-level input
 * through Chromium's hit-testing — so PixiJS v8's EventSystem and Three.js
 * raycasting both receive it (synthetic `element.dispatchEvent` would not).
 */

import type { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pruneOldTempFiles } from '../plugins/backend/tempFiles';
// Type-only, from the DOM-free `frameLoopStatus` LEAF rather than `frameDriver.ts` (same reason
// `editorBackendRouter.ts` does — see that leaf's header): this file is compiled under
// `tsconfig.node.json` (no DOM lib), and it's the SAME program `editorBackendRouter.ts`/
// `agentBridge.ts` are reached through, so a member rename here must redden this branch on
// `frameLoop.status` too, not just those two (#682 close-out round 3, BLOCKER 2).
import type { FrameLoopStatus } from '../packages/modoki/src/runtime/rendering/frameLoopStatus';

const MAX_SIDE = 1568;
const JPEG_QUALITY = 70;
let captureSeq = 0;

/** JPEG quality, ONE UNIT: 1–100 (S3.13). Electron's `NativeImage.toJPEG()` wants an INTEGER
 *  1–100; a legacy 0..1 fraction (what `render_scene`'s `canvas.toDataURL` used to take) is
 *  converted rather than passed through, which would otherwise crash the native binding with a
 *  "conversion failure" — or, on the toDataURL side, be silently ignored.
 *
 *  MIRRORS `normalizeJpegQuality` in
 *  `engine/packages/modoki/src/runtime/rendering/offscreenCapture.ts` — the Electron main process
 *  cannot import the runtime package (it would drag three.js into the main bundle), so the rule
 *  exists twice ON PURPOSE, with `engine/tests/electron/captureScale.test.ts` asserting the two
 *  agree over a sample so they cannot drift (conventions §9). Change both, or neither. */
export function normalizeJpegQuality(raw: number | undefined, fallback = 85): { pct: number; fraction: number } {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  const pct = n > 0 && n <= 1 ? n * 100 : n;
  const clamped = Math.max(1, Math.min(100, Math.round(pct)));
  return { pct: clamped, fraction: clamped / 100 };
}

export interface CaptureResult {
  path: string;
  /** Dimensions of the JPEG on disk (post-downscale). */
  width: number; height: number;
  /** Dimensions of the live window in CSS px — the coordinate space `tap`/`drag` use. */
  cssWidth: number; cssHeight: number;
  /** `width / cssWidth`. Multiply an image pixel by `1/scale` to get a tappable CSS
   *  coordinate. 1 when the window was small enough to capture unscaled. */
  scale: number;
  /** Chromium page zoom factor (`webContents.getZoomFactor()`) at capture time. `cssWidth`/
   *  `cssHeight` are DIP (unaffected by page zoom), NOT the public zoomed-CSS space `tap`/
   *  `drag`'s `selector`-less `{x,y}` aim mode uses — divide `cssWidth`/`cssHeight` by this to
   *  get that space, or prefer `selector`/`get_scene_state?bounds=1` and skip the conversion. */
  zoomFactor: number;
}

/** Pure resize math: fit (w,h) inside a longest-side cap, preserving aspect. Split out
 *  from `captureViewport` so the ratio is unit-testable without an Electron window —
 *  it is the number every agent needs to convert image px ↔ CSS px, and getting it
 *  silently wrong is what makes a tap "miss" for reasons no screenshot can show. */
export function fitToMaxSide(width: number, height: number, maxSide: number): { width: number; height: number; scale: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height, scale: 1 };
  const scale = maxSide / longest;
  // Clamp to ≥1px: an extreme aspect ratio rounds the short side to 0, and a
  // zero-dimension `NativeImage.resize` yields an empty image.
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/** What the RENDERER believes it is drawing, fetched ONLY on the failure path (one IPC
 *  round-trip is free when the alternative is an opaque error, and unaffordable on every
 *  successful capture). Shapes mirror `frameLoop` / `rendererGate` in
 *  `modoki_get_editor_state` — the same two liveness signals a human would go read by hand. */
export interface RenderSurfaceFacts {
  frameLoop?: { status?: FrameLoopStatus; refCount?: number; callbacks?: number; fps?: number; detail?: string } | null;
  rendererGate?: { status?: string; detail?: string } | null;
  /** GPU device loss / uncaptured errors (`activeRenderer.ts`'s `GpuFaultState`, mirrored here
   *  the same way `frameLoop`/`rendererGate` are). Checked BEFORE `frameLoop` below — a lost
   *  device is the CAUSE of a stalled loop, not a sibling fact, so it must win the sentence. */
  gpu?: { deviceLost?: boolean; reason?: string; message?: string; uncapturedErrors?: number } | null;
}
/** Injected by main.ts (`requestRenderer('editor-state')`). Must never throw — a probe that
 *  fails just means the explanation loses a paragraph, not that capture loses its error. */
export type SurfaceProbe = () => Promise<RenderSurfaceFacts | null>;

/** Window/page facts, snapshotted from the BrowserWindow. Separated from the message so the
 *  message is a pure function and can be unit-tested without an Electron window. */
export interface CaptureWindowFacts {
  destroyed: boolean;
  wcDestroyed?: boolean;
  crashed?: boolean | null;
  visible?: boolean;
  minimized?: boolean;
  focused?: boolean;
  width?: number;
  height?: number;
  url?: string;
}

/** Turn a compositor refusal into a sentence that names the actual cause.
 *
 *  History, because the previous wording cost real debugging time: when no window-level fault
 *  was found this said the renderer "is most likely wedged". That reads as a diagnosis, and it
 *  was WRONG for a fully-supported state — a layout with no Scene/Game panel open (a 2D-only
 *  project with both closed) has an `idle` frame loop by design, and the message sent the
 *  reader chasing a renderer fault that did not exist. See `docs/debug-tools-mcp.md`.
 *
 *  So: assert a wedge ONLY when the frame loop actually reports `stalled`, and otherwise report
 *  what the renderer says. `idle` and `hidden` get their own actionable text; a `running` loop
 *  is stated as evidence AGAINST a wedge rather than being silently ignored. */
export function explainCaptureFailure(
  w: CaptureWindowFacts | null,
  s: RenderSurfaceFacts | null,
): string {
  const reasons: string[] = [];
  let ctx = '';
  if (w) {
    if (w.destroyed) reasons.push('the editor window has been destroyed');
    else {
      if (w.wcDestroyed) reasons.push('the editor webContents has been destroyed');
      if (w.crashed) reasons.push('the renderer process has CRASHED');
      if (w.visible === false) reasons.push('the window is not visible (hidden or on another Space)');
      if (w.minimized) reasons.push('the window is minimized');
      if (w.width === 0 || w.height === 0) reasons.push('the window has a zero-sized bounds');
      ctx = ` [visible=${w.visible} minimized=${w.minimized} focused=${w.focused} ` +
        `bounds=${w.width}x${w.height} crashed=${w.crashed ?? 'n/a'} url=${w.url}`;
    }
  }
  const loop = s?.frameLoop?.status;
  const gate = s?.rendererGate?.status;
  if (ctx) ctx += `${loop ? ` frameLoop=${loop}` : ''}${gate ? ` rendererGate=${gate}` : ''}]`;

  if (reasons.length) return `Likely cause: ${reasons.join('; ')}.${ctx}`;

  // GPU device loss, checked BEFORE `frameLoop` below (including `stalled`) ON PURPOSE: a lost
  // device is the CAUSE of a stalled loop, not a sibling fact alongside it. Reporting the stall
  // instead told a reader to relaunch because "the renderer is wedged" when the real, more
  // specific answer was sitting in `gpu` the whole time — see activeRenderer.ts's GPU fault
  // channel. Does not self-recover; the editor must be relaunched.
  if (s?.gpu?.deviceLost) {
    return `THE GPU DEVICE WAS LOST (reason=${s.gpu.reason ?? 'unknown'}${s.gpu.message ? `: ${s.gpu.message}` : ''}), ` +
      'which is why nothing is rendering — this is not a wedged frame loop that will recover on ' +
      'its own; the editor must be relaunched.' + ctx;
  }

  // Window is fine — so the answer, if there is one, is in the renderer.
  if (loop === 'idle') {
    return 'NOTHING IS RENDERING TO CAPTURE: the frame loop is idle (no viewport holds a ' +
      `frame-driver start ref${typeof s?.frameLoop?.refCount === 'number' ? `, refCount=${s.frameLoop.refCount}` : ''}), ` +
      'so no scene content is being drawn. That is a LEGAL, supported state for a layout with ' +
      'no Scene or Game panel open — it is NOT a wedged renderer, and the window itself is ' +
      'healthy. Open a Scene/Game panel and retry, or use modoki_render_scene, which renders ' +
      'offscreen and needs no mounted viewport.' + ctx;
  }
  if (loop === 'hidden') {
    return 'The renderer document is HIDDEN, so the browser throttles requestAnimationFrame and ' +
      'the compositor has no fresh frame to hand over. Not a fault: bring the editor window to ' +
      'the front (or off the occluded Space) and retry.' + ctx;
  }
  if (loop === 'stalled') {
    return 'The frame loop is STALLED — the renderer is wedged, which is why the compositor has ' +
      `nothing to composite.${s?.frameLoop?.detail ? ` ${s.frameLoop.detail}` : ''}` + ctx;
  }
  if (gate && gate !== 'ready') {
    return `The 3D renderer gate is '${gate}', so the viewport's renderer is not up yet` +
      `${s?.rendererGate?.detail ? ` — ${s.rendererGate.detail}` : ''}. A 'failed' gate never ` +
      'self-recovers (relaunch the editor); a \'pending\' one may just need another moment.' + ctx;
  }
  // `loop === 'running'` OR the probe answered and simply OMITTED frameLoop — which is the
  // healthy case, not a missing one (independent review, 2026-07-30). `readEditorState`'s
  // `frameLoopFields()` returns `{}` when the loop is running with no recoveries ("a running loop
  // is the norm and needs no words"), so `s.frameLoop` is undefined in exactly the situation this
  // branch was written for: window fine, loop fine, compositor still refused. It therefore fell
  // through to the final "the IPC probe failed — the renderer may be gone" paragraph and told the
  // reader a healthy renderer was missing. The unit tests passed because they hand-build
  // `{frameLoop:{status:'running'}}`, a shape the real probe never produces.
  //
  // `s` being a non-null object IS the evidence the probe answered; only a null `s` means it did
  // not. So an answered probe with no frameLoop and no bad gate means running-and-healthy.
  if (loop === 'running' || (s && !loop && (!gate || gate === 'ready'))) {
    return 'The window is alive and the frame loop IS running' +
      `${typeof s?.frameLoop?.fps === 'number' ? ` (${s.frameLoop.fps}fps)` : ''}, so the renderer ` +
      'is NOT wedged — the compositor refused a frame for a reason outside the page (a window ' +
      'just shown/resized/moved between displays, or GPU-process churn). Retrying usually works; ' +
      'if it never does, use CDP Page.captureScreenshot or modoki_render_scene.' + ctx;
  }
  // No renderer facts at all (the probe failed, or the bridge is down) — describe the gap
  // instead of inventing a cause.
  return 'The window looks alive and visible, but the compositor produced no frame and the ' +
    'renderer could not be asked why (the IPC probe failed — the editor renderer may be gone). ' +
    'Read `frameLoop.status` in modoki_get_editor_state: "idle" means no viewport is mounted ' +
    '(nothing to capture), "hidden" means the window is occluded, "stalled" means a real wedge.' + ctx;
}

/** `webContents.capturePage()` asks Chromium's compositor (Viz) for a frame. When the
 *  compositor cannot produce one it rejects with a bare `UnknownVizError` — no window
 *  state, no page state, nothing pointing at WHY. That opaque string is what agents have
 *  been left holding while the real story (a minimised/occluded window, a destroyed
 *  webContents, an unmounted viewport, or a renderer whose frame loop has died) sat one
 *  property lookup away. Re-throw with the facts that actually identify the cause. */
async function capturePageOrExplain(win: BrowserWindow, probe?: SurfaceProbe) {
  try {
    return await win.webContents.capturePage();
  } catch (e) {
    let facts: CaptureWindowFacts | null = null;
    try {
      if (win.isDestroyed()) facts = { destroyed: true };
      else {
        const wc = win.webContents;
        const bounds = win.getBounds();
        facts = {
          destroyed: false,
          wcDestroyed: wc.isDestroyed(),
          crashed: wc.isCrashed?.() ?? null,
          visible: win.isVisible(),
          minimized: win.isMinimized(),
          focused: win.isFocused(),
          width: bounds.width,
          height: bounds.height,
          url: wc.getURL(),
        };
      }
    } catch { /* the window died mid-inspection — the raw cause below still stands */ }
    let surface: RenderSurfaceFacts | null = null;
    try { surface = (await probe?.()) ?? null; } catch { /* explanation loses a paragraph, not the error */ }
    throw new Error(`capture_viewport failed: ${String(e)}. ${explainCaptureFailure(facts, surface)}`, { cause: e });
  }
}

/** Capture the visible editor window → downscaled JPEG on disk. Returns the path
 *  Claude reads, the final dimensions, AND the CSS size + scale it was reduced from —
 *  without which an agent measuring a button in the image has no way to tap it. */
/** Pixel dimensions of an encoded JPEG, read from its SOF marker — or null if the buffer is not
 *  a JPEG we can parse.
 *
 *  WHY THIS EXISTS (S3.5): `captureViewport` reported `NativeImage.getSize()`, which is DIP, as the
 *  size of the FILE. When a downscale happens the resize makes the two agree, but with
 *  `maxSide` ≥ the window size no resize occurs and `toJPEG()` writes the underlying bitmap — so on
 *  a HiDPI display the reported `width`/`scale` could be off by the device pixel ratio, and the
 *  documented conversion "image px ÷ scale = DIP px" would mis-place an eyeballed coordinate by 2×.
 *
 *  Rather than reason about which representation Electron encodes (it varies by platform and by how
 *  the image was created — and this repo's own attempt to verify it stalled on having no HiDPI
 *  window available), read the answer out of the bytes that were actually written. That is correct
 *  in every branch, on every display, and it doubles as a check that the encode produced a real
 *  JPEG. Falls back to the DIP size when the buffer cannot be parsed, which is what the code did
 *  everywhere before. */
export function jpegSize(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;   // not SOI
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }                                // resync on fill bytes
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = (buf[i + 2] << 8) | buf[i + 3];
    // SOF0/1/2/3/5/6/7/9/10/11/13/14/15 — every frame header carries height then width.
    // 0xc4 (DHT), 0xc8 (JPG) and 0xcc (DAC) are NOT frame headers despite sitting in the range.
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      if (i + 9 >= buf.length) return null;
      const height = (buf[i + 5] << 8) | buf[i + 6];
      const width = (buf[i + 7] << 8) | buf[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (len < 2) return null;                                              // malformed
    i += 2 + len;
  }
  return null;
}

export async function captureViewport(
  win: BrowserWindow,
  opts?: { maxSide?: number; quality?: number; probe?: SurfaceProbe },
): Promise<CaptureResult> {
  const maxSide = opts?.maxSide ?? MAX_SIDE;
  const quality = normalizeJpegQuality(opts?.quality, JPEG_QUALITY).pct;
  let image = await capturePageOrExplain(win, opts?.probe);
  // `NativeImage.getSize()` reports DIP (CSS) px, not device px — so this IS the
  // coordinate space `tap`/`drag` take, and it is worth returning verbatim.
  const { width: cssWidth, height: cssHeight } = image.getSize();
  const fit = fitToMaxSide(cssWidth, cssHeight, maxSide);
  if (fit.scale !== 1) image = image.resize({ width: fit.width, height: fit.height, quality: 'best' });
  pruneOldTempFiles('modoki-capture-'); // drop stale captures from prior sessions
  const out = path.join(os.tmpdir(), `modoki-capture-${Date.now()}-${captureSeq++}.jpg`);
  const jpeg = image.toJPEG(quality);
  fs.writeFileSync(out, jpeg);
  // The size of the FILE, read from the file's own header (S3.5) — not `getSize()`, which is DIP
  // and can differ from the encoded bitmap when no downscale happened on a HiDPI display. Falls
  // back to the DIP size if the buffer is unparseable.
  const finalSize = jpegSize(jpeg) ?? image.getSize();
  return {
    path: out,
    width: finalSize.width, height: finalSize.height,
    cssWidth, cssHeight,
    scale: cssWidth > 0 ? finalSize.width / cssWidth : 1,
    zoomFactor: win.webContents.getZoomFactor(),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Which mouse button a click/drag uses. `right` opens context menus; `middle`
 *  is orbit-pan in the 3D viewport. */
export type MouseButton = 'left' | 'right' | 'middle';
/** Chromium input modifier keys (as `sendInputEvent` expects them). */
export type InputModifier = 'shift' | 'control' | 'alt' | 'meta' | 'cmd' | 'command';

export interface TapOpts {
  /** Mouse button (default 'left'). 'right' → context menu. */
  button?: MouseButton;
  /** 1 = single, 2 = double-click (open asset / expand tree / insert keyframe). */
  clickCount?: number;
  /** Held modifiers (Shift/Cmd → canvas multi-select). */
  modifiers?: InputModifier[];
}

/** Convert a PUBLIC coordinate (zoomed-CSS — what getBoundingClientRect / selectors /
 *  Percept bounds report) to the DIP space `sendInputEvent` expects. Under VS Code–style
 *  page zoom (factor f = 1.2^level) they differ: Chromium maps an injected DIP coordinate
 *  into the page by DIVIDING by f, so to land on the element at zoomed-CSS point P we must
 *  inject P·f. No-op at zoom 0 (f=1). MEASURED + rationale: the coordinate audit in
 *  docs/debug-tools-mcp.md. */
const toDip = (wc: Electron.WebContents, x: number, y: number): { x: number; y: number } => {
  const f = wc.getZoomFactor();
  return { x: x * f, y: y * f };
};

/** Single trusted click at page CSS coordinates (x,y). `opts` unlocks right-click
 *  (context menus), double-click, and modifier+click (multi-select). */
export async function tap(win: BrowserWindow, x: number, y: number, opts?: TapOpts): Promise<void> {
  const wc = win.webContents;
  ({ x, y } = toDip(wc, x, y)); // zoomed-CSS → DIP for the trusted event
  const button = opts?.button ?? 'left';
  const clickCount = opts?.clickCount ?? 1;
  const modifiers = opts?.modifiers;
  wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers } as Electron.MouseInputEvent);
  for (let c = 1; c <= clickCount; c++) {
    // For a double-click the DOWN/UP pair must carry the *cumulative* clickCount
    // (1 then 2) — that's how Chromium recognizes the dblclick, not two separate
    // clickCount:1 pairs.
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: c, modifiers } as Electron.MouseInputEvent);
    await sleep(16);
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: c, modifiers } as Electron.MouseInputEvent);
    if (c < clickCount) await sleep(16);
  }
}

export interface DragOpts {
  /** Intermediate move count (default 10) — gesture thresholds need them. */
  steps?: number;
  /** Mouse button (default 'left'). 'middle'/'right' = orbit-pan in 3D. */
  button?: MouseButton;
  /** Held modifiers (Shift = gizmo snap, Alt = duplicate-drag, …). Set on every mouse
   *  event of the gesture AND sent as real keyDown/keyUp around it — see `MODIFIER_KEYCODE`. */
  modifiers?: InputModifier[];
}

/** An `InputModifier` → the Electron `keyCode` for the physical modifier key.
 *
 *  A drag's `modifiers` used to set the bit on the MOUSE event only, which is invisible to a
 *  `window` keydown/keyup listener — and that is how the editor tracks a modifier whose LEVEL
 *  matters rather than its edge. `SceneView`'s 3D-gizmo snap is exactly that (`onSnapKey`, which
 *  needs the keyup as much as the keydown), so no sequence of MCP calls could hold Shift for the
 *  duration of a gizmo drag and the 3D half of snapping was untestable (bug XmytWgSlUzMPCNHtrhUw);
 *  `modoki_press_key` could not close the gap either, because it completes keyDown→keyUp inside
 *  one call. Sending the real key events around the gesture makes both consumers agree. */
type CanonModifier = 'shift' | 'control' | 'alt' | 'meta';
const CANON_MODIFIER: Record<InputModifier, CanonModifier> = {
  shift: 'shift', control: 'control', alt: 'alt', meta: 'meta', cmd: 'meta', command: 'meta',
};
const MODIFIER_KEYCODE: Record<CanonModifier, string> = {
  shift: 'Shift', control: 'Control', alt: 'Alt', meta: 'Meta',
};

/** `modifiers` as distinct canonical keys, stable order ('cmd'/'command'/'meta' collapse to one). */
function canonModifiers(modifiers: InputModifier[] | undefined): CanonModifier[] {
  return [...new Set((modifiers ?? []).map((m) => CANON_MODIFIER[m]).filter(Boolean))];
}

/** Trusted drag from → to with intermediate moves (gesture thresholds — match-3
 *  swaps, gizmo drags — won't fire without them). Coordinates are page CSS px.
 *  `opts` unlocks middle/right-button drags (orbit-pan) and held modifiers. */
export async function drag(
  win: BrowserWindow,
  from: { x: number; y: number },
  to: { x: number; y: number },
  optsOrSteps?: DragOpts | number,
): Promise<void> {
  const opts: DragOpts = typeof optsOrSteps === 'number' ? { steps: optsOrSteps } : (optsOrSteps ?? {});
  const wc = win.webContents;
  from = toDip(wc, from.x, from.y); // zoomed-CSS → DIP (both endpoints; interpolation stays in DIP)
  to = toDip(wc, to.x, to.y);
  const n = Math.max(2, opts.steps ?? 10);
  const button = opts.button ?? 'left';
  const modifiers = opts.modifiers;
  // Intermediate moves must re-assert the held-button modifier — same reason as
  // `pointerMove` (see `buttonHeldModifier`): without it Chromium reports `buttons:0`
  // on each move, so a listener gating on `e.buttons` sees the gesture as released.
  const heldModifiers = [...(modifiers ?? []), buttonHeldModifier(button)];
  const modKeys = canonModifiers(modifiers);
  // Keyboard events dispatch to the FOCUSED web contents (mouse events hit-test by coordinate),
  // so an agent-driven window that isn't OS-focused would drop the modifier keyDown. Same reason
  // `pressKey` focuses. Only when there IS a modifier — a plain drag must not touch focus.
  if (modKeys.length) { wc.focus(); await sleep(16); }
  wc.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y, modifiers } as Electron.MouseInputEvent);
  wc.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button, clickCount: 1, modifiers } as Electron.MouseInputEvent);
  // Press the modifier AFTER mouseDown: the press is what gives the panel keyboard scope, and
  // SceneView's snap listener only arms while its own panel is focused. Released after mouseUp
  // so the whole gesture — every intermediate move — happens with the key genuinely down.
  modKeys.forEach((m, i) => {
    // Each keyDown reports the modifiers held INCLUDING itself — what a real keyboard does.
    wc.sendInputEvent({ type: 'keyDown', keyCode: MODIFIER_KEYCODE[m], modifiers: modKeys.slice(0, i + 1) } as Electron.KeyboardInputEvent);
  });
  await sleep(16);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = Math.round(from.x + (to.x - from.x) * t);
    const y = Math.round(from.y + (to.y - from.y) * t);
    wc.sendInputEvent({ type: 'mouseMove', x, y, button, modifiers: heldModifiers } as unknown as Electron.MouseInputEvent);
    await sleep(16);
  }
  wc.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button, clickCount: 1, modifiers } as Electron.MouseInputEvent);
  // Release in reverse, each keyUp reporting only the modifiers STILL held — so the last one
  // reports `shiftKey:false`. A listener that reads the level off the event (onSnapKey does)
  // would otherwise latch the modifier ON forever after an agent drag.
  for (let i = modKeys.length - 1; i >= 0; i--) {
    wc.sendInputEvent({ type: 'keyUp', keyCode: MODIFIER_KEYCODE[modKeys[i]], modifiers: modKeys.slice(0, i) } as Electron.KeyboardInputEvent);
  }
}

export interface PointerOpts {
  /** Mouse button (default 'left'). */
  button?: MouseButton;
  /** Held modifiers. */
  modifiers?: InputModifier[];
}

/** SUSTAINED-pointer primitives — the split, cross-call twin of `drag`. `drag` is atomic
 *  (down→moves→up in one call), so any state that exists ONLY while the button is physically
 *  held — a slingshot pull preview, a charge-up meter, a drag-to-aim rubber-band — is gone
 *  before the call returns and is therefore unobservable. These three send the SAME trusted
 *  `sendInputEvent`s but across SEPARATE calls, so the agent can hold the press, read the
 *  held-only state (get_scene_state / modoki_eval / a screenshot), move to re-aim, read
 *  again, then release. Chromium keeps the button pressed between events as long as no
 *  `mouseUp` is sent, so a `move` with the button set reads as a drag-move, not a hover.
 *  The held-button STATE (and the "nothing is held" guard) lives in the route, not here —
 *  these stay stateless so the button is explicit per event. */
export async function pointerDown(win: BrowserWindow, x: number, y: number, opts?: PointerOpts): Promise<void> {
  const wc = win.webContents;
  ({ x, y } = toDip(wc, x, y)); // zoomed-CSS → DIP
  const button = opts?.button ?? 'left';
  const modifiers = opts?.modifiers;
  wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers } as Electron.MouseInputEvent);
  wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1, modifiers } as Electron.MouseInputEvent);
  await sleep(16);
}

/** The Chromium "this button is CURRENTLY held" modifier for a button — distinct from the
 *  `button` field (which names the button an event is ABOUT). Across SEPARATE injected events
 *  Blink does not infer a still-pressed button from an earlier mouseDown, so a held move must
 *  re-assert it or the DOM move reports `buttons=0` (measured) and a handler that gates on
 *  `e.buttons` treats the gesture as released. */
function buttonHeldModifier(button: MouseButton): string {
  return button === 'right' ? 'rightButtonDown' : button === 'middle' ? 'middleButtonDown' : 'leftButtonDown';
}

/** Move the HELD pointer to (x,y). `button` MUST be the one held (the route threads it). We send
 *  both the `button` field AND the `*ButtonDown` held-modifier so Chromium reports `buttons` with
 *  the button set — the move reads as a real drag-move across calls, not a hover. */
export async function pointerMove(win: BrowserWindow, x: number, y: number, opts?: PointerOpts): Promise<void> {
  const wc = win.webContents;
  ({ x, y } = toDip(wc, x, y)); // zoomed-CSS → DIP
  const button = opts?.button ?? 'left';
  const modifiers = [...(opts?.modifiers ?? []), buttonHeldModifier(button)];
  wc.sendInputEvent({ type: 'mouseMove', x, y, button, modifiers } as unknown as Electron.MouseInputEvent);
  await sleep(16);
}

/** Release the held pointer at (x,y), ending the sustained gesture. */
export async function pointerUp(win: BrowserWindow, x: number, y: number, opts?: PointerOpts): Promise<void> {
  const wc = win.webContents;
  ({ x, y } = toDip(wc, x, y)); // zoomed-CSS → DIP
  const button = opts?.button ?? 'left';
  const modifiers = opts?.modifiers;
  wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1, modifiers } as Electron.MouseInputEvent);
  await sleep(16);
}

/** Bare trusted mouse-move to (x,y) with no button held — triggers hover states,
 *  tooltips, and hover-to-open submenus (which a bracketed drag-move can't). */
export async function hover(win: BrowserWindow, x: number, y: number, modifiers?: InputModifier[]): Promise<void> {
  const wc = win.webContents;
  ({ x, y } = toDip(wc, x, y)); // zoomed-CSS → DIP
  wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers } as Electron.MouseInputEvent);
  await sleep(16);
}

/** Trusted mouse-wheel at (x,y), following the DOM `WheelEvent` sign convention:
 *  deltaY > 0 scrolls the content DOWN, deltaX > 0 scrolls RIGHT — same as every
 *  caller expects. Unlocks orbit-cam wheel-zoom, long-list scroll, and
 *  cursor-anchored zoom in the Canvas2D editors (Skin/Slicer/Particle).
 *
 *  GOTCHA (Electron): `sendInputEvent` carries the NATIVE WebMouseWheelEvent delta,
 *  whose sign Chromium FLIPS when it synthesizes the DOM WheelEvent (native +Δ →
 *  DOM −Δ). So a raw positive deltaY would scroll UP. We negate here so this helper
 *  honours the DOM convention in its signature — callers pass DOM-style deltas. */
export async function scroll(
  win: BrowserWindow,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
  modifiers?: InputModifier[],
): Promise<void> {
  const wc = win.webContents;
  ({ x, y } = toDip(wc, x, y)); // zoomed-CSS → DIP for the wheel's target point (deltas are unscaled)
  const dx = -deltaX, dy = -deltaY; // DOM-sign → native-sign (see GOTCHA above)
  // wheelTicks track deltas in "clicks" — some listeners read them instead of the
  // pixel delta, so send both (120px ≈ one wheel tick, the Chromium convention).
  // `modifiers` set ctrlKey/metaKey/… on the synthesized WheelEvent, so a modifier-gated
  // wheel handler (Ctrl/Cmd+wheel UI-zoom, the Curve Editor's value-axis zoom, Shift+wheel
  // horizontal) is drivable — without them a bare wheel never trips those handlers.
  wc.sendInputEvent({
    type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy,
    wheelTicksX: dx / 120, wheelTicksY: dy / 120,
    canScroll: true,
    ...(modifiers && modifiers.length ? { modifiers } : {}),
  } as Electron.MouseWheelInputEvent);
  await sleep(16);
}

/** Press a single trusted key chord into the focused element — standalone
 *  Escape/Delete/arrows and hotkeys (W/E/R gizmo, F frame, Cmd+Z undo) that
 *  `typeText` can only send as a terminal `submitKey`. `key` is an Electron
 *  keyCode ('Escape', 'Delete', 'ArrowUp', 'w', …).
 *
 *  HOLD ACROSS FRAMES: the key is held ~3 frames (≈48ms @60fps) between keyDown and
 *  keyUp. The engine samples input once per frame (keyboardSource → inputSystem), so a
 *  0ms keyDown+keyUp "sub-frame burst" is never observed as HELD and the game's
 *  edge-derived actions (nav / jump / confirm) never fire. Holding across a few frames
 *  guarantees at least one sample sees the key down → the rising edge registers. DOM-level
 *  hotkeys (Escape/Cmd+Z/…) fire on keyDown regardless, so the hold only helps, never hurts. */
/** Electron `sendInputEvent` keyCode wants Accelerator names (`Up`/`Down`/…), not the
 *  DOM `key` names (`ArrowUp`/…). Alias the DOM arrow names so callers can pass either and
 *  the game still receives a DOM keydown with `e.key === 'ArrowDown'`. */
export const KEYCODE_ALIAS: Record<string, string> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};

export async function pressKey(win: BrowserWindow, key: string, modifiers?: InputModifier[]): Promise<{ activeElement: string | null; gameSwallows: boolean }> {
  const wc = win.webContents;
  const keyCode = KEYCODE_ALIAS[key] ?? key;
  // Keyboard sendInputEvent dispatches to the FOCUSED web contents — unlike mouse events,
  // which hit-test by coordinate. When the editor window isn't the OS-focused window (agent-
  // driven, headless), a keyDown otherwise never reaches the page's window listeners. Focus
  // the web contents first so the key actually lands.
  wc.focus();
  await sleep(16); // let the renderer apply focus before the keyDown (else the first press races it)
  // Snapshot DOM focus BEFORE the press: the game's input sampler ignores keys while an editable
  // field holds focus (keyboardSource.editing()), so a key meant for the GAME is silently
  // swallowed. We still dispatch (the key IS pressed — DOM hotkeys fire), but report the focused
  // element so a caller can see a text field is intercepting it. (C7 re-audit.)
  const active = await readActiveElement(wc);
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers } as Electron.KeyboardInputEvent);
  await sleep(48); // ≈3 frames @60fps — spans a frame boundary so the per-frame sampler catches it
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers } as Electron.KeyboardInputEvent);
  await sleep(8);
  return { activeElement: active.descriptor, gameSwallows: active.gameSwallows };
}

/** Give the editor window/view keyboard focus (and optionally focus a specific element).
 *
 *  Always focuses the WEB CONTENTS (`webContents.focus()`) — the load-bearing part: trusted
 *  keyboard `sendInputEvent`s dispatch to the focused web contents, so when the editor isn't
 *  the OS-focused window (agent-driven), keys are dropped until this runs. That's why a
 *  viewport click alone (mouse hit-tests by coordinate, no window focus) doesn't let key
 *  input through.
 *
 *  Then, DOM-side: focus the element matching `selector`, or — with no selector — blur any
 *  focused text field (so the game's input sampler, which ignores keys while an INPUT/
 *  TEXTAREA/SELECT/contentEditable holds focus, receives them). A non–natively-focusable
 *  target (canvas/div) is given `tabindex=-1` so it can take focus. Returns what happened. */
export async function focusElement(
  win: BrowserWindow,
  selector?: string,
): Promise<{ view: boolean; focused: string | null; blurred: string | null; ok: boolean; error?: string; activeElement?: string | null }> {
  const wc = win.webContents;
  wc.focus(); // window/view-level focus — required for keyboard sendInputEvent to land
  const sel = selector ? JSON.stringify(selector) : 'null';
  try {
    // S3.7 — a failure here used to come back as a bare `{ok:false}`, which the route passed
    // through with no error string, so the tool reported "the operation reported ok:false": no
    // cause, no fix, and no way to tell "no element matched" from "the element refused focus".
    // Every other Enact aim path returns a NAMED miss (see `domResolve.ts`), so this one names
    // its three distinct failures too, and echoes where focus actually ended up.
    const dom = await wc.executeJavaScript(
      `(() => {
        const sel = ${sel};
        const tag = (el) => !el ? null : (el.tagName ? el.tagName.toLowerCase() : String(el)) + (el.id ? '#' + el.id : '');
        const active = () => tag(document.activeElement);
        if (!sel) {
          const a = document.activeElement;
          if (a && a !== document.body) { const t = tag(a); a.blur(); return { focused: null, blurred: t, ok: true, activeElement: active() }; }
          return { focused: null, blurred: null, ok: true, activeElement: active() };
        }
        let el;
        try { el = document.querySelector(sel); }
        catch (e) {
          return { focused: null, blurred: null, ok: false, activeElement: active(),
            error: 'selector is not valid CSS: ' + sel + ' (' + (e && e.message ? e.message : e) + ')' };
        }
        if (!el) {
          return { focused: null, blurred: null, ok: false, activeElement: active(),
            error: 'no element matches ' + sel + ' — re-read the DOM (get_layout_bounds / a screenshot) and aim at a selector that exists' };
        }
        if (el.tabIndex < 0 && !/^(input|textarea|select|a|button)$/i.test(el.tagName)) el.setAttribute('tabindex', '-1');
        el.focus();
        if (document.activeElement !== el) {
          return { focused: null, blurred: null, ok: false, activeElement: active(),
            error: tag(el) + ' matched ' + sel + ' but REFUSED focus (disabled, hidden, or inside an inert/aria-hidden subtree); focus is on ' + (active() || 'body') };
        }
        return { focused: tag(el), blurred: null, ok: true, activeElement: active() };
      })()`,
      true,
    );
    return { view: true, ...dom };
  } catch (e) {
    // The evaluate itself failed (renderer navigating/destroyed) — distinct from a DOM miss.
    return { view: true, focused: null, blurred: null, ok: false, activeElement: null,
      error: `could not evaluate in the renderer: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Type text into the CURRENTLY-FOCUSED element via trusted keyboard events.
 *  `sendInputEvent` char events flow through Chromium's input pipeline, so a React
 *  controlled input (e.g. the Inspector's BufferedTextInput) fires its real
 *  onChange — a synthetic `element.value =` would not. Focus the target first
 *  (e.g. `tap` on the input). `clearFirst` selects the field's contents (in the renderer — a
 *  native Cmd+A accelerator is unreachable from `sendInputEvent`) and deletes them with a trusted
 *  Backspace, so the field is replaced rather than appended, and says so if it could not; `submitKey` presses a terminal key afterward —
 *  'Tab'/'Escape' BLUR the field (the key case for verifying commit-on-blur),
 *  'Enter' submits. */
/** TWO DIFFERENT QUESTIONS, deliberately not one predicate (measured 2026-07-22).
 *
 *  `typable`  — can this element actually RECEIVE typed characters? A readOnly or disabled
 *               input, a checkbox, a <select> all hold focus and all reject text. Mirrors
 *               the editor's `focusScope.isTextEditable()`, which is the authority: its
 *               docblock requires these to stay in sync, and `predicateParity.test.ts`
 *               enforces it.
 *  `gameSwallows` — will the RUNNING GAME's sampler ignore keys right now? That is
 *               `keyboardSource.editing()`, which is deliberately BLUNTER
 *               (INPUT/TEXTAREA/SELECT/contentEditable, readOnly included) because it
 *               ships in games and errs toward "the human is busy in a field".
 *
 *  Collapsing them produced two measured defects: `typeText` reported `{ok:true, typed:3}`
 *  into a readOnly Inspector field that was provably unchanged, and `pressKey` warned that
 *  a key "will be swallowed" on a press that demonstrably ran an editor shortcut (`f`
 *  framed the selection, camera [12,15,20] → [-0.1,1.4,1.8]). */
export const ACTIVE_ELEMENT_PROBE = `(() => {
  const a = document.activeElement;
  const tag = a ? a.tagName : '';
  const TEXT_TYPES = ['text','search','url','tel','email','password','number','date','datetime-local','month','week','time'];
  let typable = false;
  if (a) {
    if (a.isContentEditable === true) typable = true;
    else if (tag === 'TEXTAREA') typable = !a.readOnly && !a.disabled;
    else if (tag === 'INPUT') typable = !a.readOnly && !a.disabled && TEXT_TYPES.indexOf((a.type || 'text').toLowerCase()) !== -1;
  }
  const gameSwallows = !!a && (/^(input|textarea|select)$/i.test(tag) || a.isContentEditable === true);
  const descriptor = a && a !== document.body ? (tag ? tag.toLowerCase() : String(a)) + (a.id ? '#' + a.id : '') : null;
  return { typable, gameSwallows, descriptor };
})()`;

async function readActiveElement(wc: Electron.WebContents): Promise<{ typable: boolean; gameSwallows: boolean; descriptor: string | null }> {
  return wc.executeJavaScript(ACTIVE_ELEMENT_PROBE, true)
    .catch(() => ({ typable: false, gameSwallows: false, descriptor: null }));
}

/** Select the focused field's entire contents, from INSIDE the renderer.
 *
 *  NOT Cmd+A. On macOS Select All in a text field is a native Edit-menu ACCELERATOR, and
 *  Chromium's `sendInputEvent` does not trigger native menu accelerators — `pressKey`'s own
 *  description already says so. So the old clearFirst sent an inert Cmd+A followed by a
 *  Backspace that deleted exactly ONE character, and the caller got old-text-minus-a-letter with
 *  the new text appended, reported as `{ok:true, typed:<full length>}`. Selection is not input,
 *  so doing it in the renderer costs nothing in fidelity: the DELETE that follows is still a
 *  trusted key event, which is the part a React controlled input must see.
 *
 *  Returns the selected text (so the caller knows how much to delete), or null if there is
 *  nothing selectable. */
const SELECT_ALL_PROBE = `(() => {
  const a = document.activeElement;
  if (!a) return null;
  if (a.isContentEditable === true) {
    const r = document.createRange();
    r.selectNodeContents(a);
    const sel = window.getSelection();
    if (!sel) return null;
    sel.removeAllRanges();
    sel.addRange(r);
    return a.textContent || '';
  }
  if (typeof a.select === 'function') { a.select(); return a.value == null ? '' : String(a.value); }
  return null;
})()`;

/** Empty the focused field. Returns undefined on success, or an explanation of what is STILL in
 *  it — clearFirst failing silently is what made the original bug invisible. */
async function clearFocusedField(wc: Electron.WebContents): Promise<string | undefined> {
  const selected: string | null = await wc.executeJavaScript(SELECT_ALL_PROBE, true).catch(() => null);
  if (selected === null) return undefined; // nothing selectable (canvas/div) — nothing to clear
  const backspace = async () => {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' } as Electron.KeyboardInputEvent);
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' } as Electron.KeyboardInputEvent);
    await sleep(8);
  };
  await backspace(); // deletes the whole SELECTION in one press
  let left = await readFocusedValue(wc);
  // Belt and braces for a field that re-seeds itself or swallows the selection: delete what is
  // left one character at a time, bounded by its own length so this can never spin.
  for (let i = 0; left && i < left.length + 1 && i < 256; i++) {
    await backspace();
    const next = await readFocusedValue(wc);
    if (next === left) break; // no progress — stop rather than hammer the field
    left = next;
  }
  if (left) {
    return `clearFirst did NOT empty the field — it still holds ${JSON.stringify(left)}, so what `
      + 'you typed is appended to it rather than replacing it. Clear it through the app\'s own UI, '
      + 'or set the value with modoki_eval.';
  }
  return undefined;
}

/** Read the focused element's current text — the MEASUREMENT `typed` is derived from (S3.18).
 *
 *  `typed: text.length` was a restatement of the request, not an observation: `sendInputEvent`
 *  cannot fail, so a field that silently rejected or reformatted the input was reported as typed
 *  under ok:true while it was unchanged. Same false-success class `enact.md` records for the
 *  readOnly case, which was only closed for "nothing typable is focused".
 *
 *  ⚠️ This comment used to name non-ASCII input as the example, and that example is FALSE
 *  (bug `xaewBYMBYXoeuiTllsI8`): Japanese, accented letters and emoji all insert cleanly through
 *  the `char` path on Electron 43. Keeping the MEASUREMENT is still right — it is what makes any
 *  such rejection visible — but the stated cause was steering agents away from a path that
 *  works. */
const FOCUSED_VALUE_PROBE = `(() => {
  const a = document.activeElement;
  if (!a) return null;
  if (a.isContentEditable === true) return a.textContent ?? '';
  if (typeof a.value === 'string') return a.value;
  return null;
})()`;

async function readFocusedValue(wc: Electron.WebContents): Promise<string | null> {
  return wc.executeJavaScript(FOCUSED_VALUE_PROBE, true).catch(() => null);
}

export async function typeText(
  win: BrowserWindow,
  text: string,
  opts?: { clearFirst?: boolean; submitKey?: string },
): Promise<{
  typed: number; editable: boolean; activeElement: string | null;
  /** The focused element's text AFTER typing, when it could be read (null for a canvas/div or a
   *  submitKey that blurred the field). Present so `typed` is checkable rather than asserted. */
  valueAfter?: string | null;
  /** Set when the measured insert is shorter than the requested text — see S3.18. */
  error?: string;
}> {
  const wc = win.webContents;
  // A trusted `char` event only INSERTS text when an editable element holds focus. With nothing
  // (or a non-editable div/canvas) focused, the chars land nowhere yet `sendInputEvent` can't
  // fail — so the route used to report {ok:true, typed:N} typing into the void. Check first and
  // report where focus actually is, so a skipped/stolen focus step is a visible failure. (C7 re-audit.)
  const active = await readActiveElement(wc);
  // `typable`, not `gameSwallows`: a readOnly/disabled input, a checkbox and a <select> all hold
  // focus and all reject characters, so typing into them is a NO-OP that used to report
  // {ok:true, typed:N}. Measured against the Inspector's readOnly name field.
  if (!active.typable) return { typed: 0, editable: false, activeElement: active.descriptor };
  // Read BEFORE `clearFirst` runs? No — after it, so the delta measures what THIS call inserted
  // rather than counting the cleared text as a negative.
  let clearError: string | undefined;
  if (opts?.clearFirst) clearError = await clearFocusedField(wc);
  const before: string | null = await readFocusedValue(wc);
  for (const ch of text) {
    // Only the `char` event inserts text; keyDown/keyUp bracket it so key handlers
    // (shortcut guards, Enter-to-commit) still see a real press.
    wc.sendInputEvent({ type: 'keyDown', keyCode: ch } as Electron.KeyboardInputEvent);
    wc.sendInputEvent({ type: 'char', keyCode: ch } as Electron.KeyboardInputEvent);
    wc.sendInputEvent({ type: 'keyUp', keyCode: ch } as Electron.KeyboardInputEvent);
    await sleep(8);
  }
  // MEASURE before the submitKey: 'Tab'/'Escape' blur the field, after which there is nothing
  // left to read (and 'Enter' may commit + reformat the value).
  const after = await readFocusedValue(wc);
  if (opts?.submitKey) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: opts.submitKey } as Electron.KeyboardInputEvent);
    wc.sendInputEvent({ type: 'keyUp', keyCode: opts.submitKey } as Electron.KeyboardInputEvent);
    await sleep(8);
  }
  // The measured insert. `before` is null for an unreadable target (a contentEditable canvas
  // wrapper, say) — then there is nothing to measure and `typed` falls back to the request, which
  // is at least no worse than before and is not dressed up as an observation.
  if (before === null || after === null) {
    return {
      typed: text.length, editable: true, activeElement: active.descriptor, valueAfter: after,
      ...(clearError ? { error: clearError } : {}),
    };
  }
  // WHAT LANDED, not how much the length grew (independent review, 2026-07-30). A length delta is
  // the insert count only when typing APPENDS — but Chromium replaces the current SELECTION, so
  // any flow that leaves text selected (the documented `clickCount:2` rename, or `clearFirst`)
  // under-counts, and when the replaced selection was longer than the new text the delta is
  // negative and clamps to 0. A correct rename therefore reported `ok:false, typed:0` and blamed
  // non-ASCII — a cause that is simply false for a plain ASCII rename, sending the reader off to
  // work around a limitation they had not hit.
  //
  // Containment answers the real question ("did the requested text reach the field?") for both
  // append and replace, and needs no knowledge of what was selected.
  const landed = text.length === 0 || after.includes(text);
  const inserted = landed ? text.length : Math.max(0, after.length - before.length);
  // A clearFirst that did not clear is a FAILURE even when the typed text landed: the field then
  // holds old+new concatenated, and `ok:true` with a correct `typed` count hides it completely
  // (the bug this replaced produced 'New EntitBuffalo Fort' and reported success).
  if (clearError) {
    return {
      typed: inserted, editable: true, activeElement: active.descriptor, valueAfter: after,
      error: clearError,
    };
  }
  return {
    typed: inserted,
    editable: true,
    activeElement: active.descriptor,
    valueAfter: after,
    ...(landed ? {} : {
      // Describe the OBSERVATION and leave the cause open. This string used to blame non-ASCII
      // input and recommend modoki_eval; both halves were wrong (bug `xaewBYMBYXoeuiTllsI8`) —
      // non-ASCII types fine, and modoki_eval is a non-input write a controlled input never sees,
      // so the "workaround" was more fragile than the path it replaced.
      error: `the requested text is NOT in the field after typing — ${inserted} of ${text.length} `
        + `character(s) appear to have reached it (before: ${JSON.stringify(before)}, after: `
        + `${JSON.stringify(after)}). The usual cause is a field that reformats, truncates or `
        + `rejects input as you type (a numeric field, a max-length, an input mask), so `
        + `\`valueAfter\` above is what it actually accepted. Retype in the shape the field wants, `
        + `or drive the value through the control the app gives it.`,
    }),
  };
}

export interface GestureFrame { t: number; x: number; y: number; sample: unknown }

/** Run a trusted drag while SAMPLING live state each step — the "input feel"
 *  probe. `sample()` (injected so this stays decoupled from the IPC relay) is
 *  called after every move + the final up; main passes a sampler that reads the
 *  tracked entity's Transform via requestRenderer. Returns the trajectory so an
 *  agent can tune thresholds/easing against the human's reference feel numerically. */
export async function captureGesture(
  win: BrowserWindow,
  opts: { from: { x: number; y: number }; to: { x: number; y: number }; steps?: number; sample: () => Promise<unknown> },
): Promise<{ frames: GestureFrame[] }> {
  const wc = win.webContents;
  const { from, to } = opts;
  const n = Math.max(2, opts.steps ?? 12);
  const frames: GestureFrame[] = [];
  // Dispatch in DIP (toDip), but REPORT the trajectory in the public zoomed-CSS space the
  // caller gave — so the returned feel numbers stay comparable to selector/Percept coords.
  const send = (type: string, x: number, y: number, extra?: Record<string, unknown>) => {
    const p = toDip(wc, x, y);
    wc.sendInputEvent({ type, x: p.x, y: p.y, ...extra } as Electron.MouseInputEvent);
  };
  send('mouseMove', from.x, from.y);
  send('mouseDown', from.x, from.y, { button: 'left', clickCount: 1 });
  await sleep(16);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = Math.round(from.x + (to.x - from.x) * t);
    const y = Math.round(from.y + (to.y - from.y) * t);
    send('mouseMove', x, y, { button: 'left' });
    await sleep(16);
    frames.push({ t, x, y, sample: await opts.sample().catch(() => null) });
  }
  send('mouseUp', to.x, to.y, { button: 'left', clickCount: 1 });
  await sleep(16);
  frames.push({ t: 1, x: to.x, y: to.y, sample: await opts.sample().catch(() => null) });
  return { frames };
}
