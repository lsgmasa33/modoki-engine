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

const MAX_SIDE = 1568;
const JPEG_QUALITY = 70;
let captureSeq = 0;

export interface CaptureResult {
  path: string;
  /** Dimensions of the JPEG on disk (post-downscale). */
  width: number; height: number;
  /** Dimensions of the live window in CSS px — the coordinate space `tap`/`drag` use. */
  cssWidth: number; cssHeight: number;
  /** `width / cssWidth`. Multiply an image pixel by `1/scale` to get a tappable CSS
   *  coordinate. 1 when the window was small enough to capture unscaled. */
  scale: number;
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

/** Capture the visible editor window → downscaled JPEG on disk. Returns the path
 *  Claude reads, the final dimensions, AND the CSS size + scale it was reduced from —
 *  without which an agent measuring a button in the image has no way to tap it. */
export async function captureViewport(win: BrowserWindow, opts?: { maxSide?: number; quality?: number }): Promise<CaptureResult> {
  const maxSide = opts?.maxSide ?? MAX_SIDE;
  // Electron's NativeImage.toJPEG() wants an INTEGER 0–100. Tolerate a 0–1
  // fraction too (the scale `render-scene`'s canvas.toDataURL uses) so a caller
  // passing e.g. 0.9 can't crash the native binding with a "conversion failure".
  const rawQuality = opts?.quality ?? JPEG_QUALITY;
  const quality = Math.max(1, Math.min(100, Math.round(rawQuality <= 1 ? rawQuality * 100 : rawQuality)));
  let image = await win.webContents.capturePage();
  // `NativeImage.getSize()` reports DIP (CSS) px, not device px — so this IS the
  // coordinate space `tap`/`drag` take, and it is worth returning verbatim.
  const { width: cssWidth, height: cssHeight } = image.getSize();
  const fit = fitToMaxSide(cssWidth, cssHeight, maxSide);
  if (fit.scale !== 1) image = image.resize({ width: fit.width, height: fit.height, quality: 'best' });
  pruneOldTempFiles('modoki-capture-'); // drop stale captures from prior sessions
  const out = path.join(os.tmpdir(), `modoki-capture-${Date.now()}-${captureSeq++}.jpg`);
  fs.writeFileSync(out, image.toJPEG(quality));
  // Trust the encoder's own idea of the final size over our arithmetic.
  const finalSize = image.getSize();
  return {
    path: out,
    width: finalSize.width, height: finalSize.height,
    cssWidth, cssHeight,
    scale: cssWidth > 0 ? finalSize.width / cssWidth : 1,
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

/** Single trusted click at page CSS coordinates (x,y). `opts` unlocks right-click
 *  (context menus), double-click, and modifier+click (multi-select). */
export async function tap(win: BrowserWindow, x: number, y: number, opts?: TapOpts): Promise<void> {
  const wc = win.webContents;
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
  /** Held modifiers (Shift = gizmo snap, Alt = duplicate-drag, …). */
  modifiers?: InputModifier[];
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
  const n = Math.max(2, opts.steps ?? 10);
  const button = opts.button ?? 'left';
  const modifiers = opts.modifiers;
  wc.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y, modifiers } as Electron.MouseInputEvent);
  wc.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button, clickCount: 1, modifiers } as Electron.MouseInputEvent);
  await sleep(16);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = Math.round(from.x + (to.x - from.x) * t);
    const y = Math.round(from.y + (to.y - from.y) * t);
    wc.sendInputEvent({ type: 'mouseMove', x, y, button, modifiers } as Electron.MouseInputEvent);
    await sleep(16);
  }
  wc.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button, clickCount: 1, modifiers } as Electron.MouseInputEvent);
}

/** Bare trusted mouse-move to (x,y) with no button held — triggers hover states,
 *  tooltips, and hover-to-open submenus (which a bracketed drag-move can't). */
export async function hover(win: BrowserWindow, x: number, y: number, modifiers?: InputModifier[]): Promise<void> {
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y, modifiers } as Electron.MouseInputEvent);
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
): Promise<void> {
  const dx = -deltaX, dy = -deltaY; // DOM-sign → native-sign (see GOTCHA above)
  // wheelTicks track deltas in "clicks" — some listeners read them instead of the
  // pixel delta, so send both (120px ≈ one wheel tick, the Chromium convention).
  win.webContents.sendInputEvent({
    type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy,
    wheelTicksX: dx / 120, wheelTicksY: dy / 120,
    canScroll: true,
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
const KEYCODE_ALIAS: Record<string, string> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};

export async function pressKey(win: BrowserWindow, key: string, modifiers?: InputModifier[]): Promise<{ activeElement: string | null; editableFocused: boolean }> {
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
  return { activeElement: active.descriptor, editableFocused: active.editable };
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
): Promise<{ view: boolean; focused: string | null; blurred: string | null; ok: boolean }> {
  const wc = win.webContents;
  wc.focus(); // window/view-level focus — required for keyboard sendInputEvent to land
  const sel = selector ? JSON.stringify(selector) : 'null';
  try {
    const dom = await wc.executeJavaScript(
      `(() => {
        const sel = ${sel};
        const tag = (el) => !el ? null : (el.tagName ? el.tagName.toLowerCase() : String(el)) + (el.id ? '#' + el.id : '');
        if (!sel) {
          const a = document.activeElement;
          if (a && a !== document.body) { const t = tag(a); a.blur(); return { focused: null, blurred: t, ok: true }; }
          return { focused: null, blurred: null, ok: true };
        }
        const el = document.querySelector(sel);
        if (!el) return { focused: null, blurred: null, ok: false };
        if (el.tabIndex < 0 && !/^(input|textarea|select|a|button)$/i.test(el.tagName)) el.setAttribute('tabindex', '-1');
        el.focus();
        return { focused: tag(el), blurred: null, ok: document.activeElement === el };
      })()`,
      true,
    );
    return { view: true, ...dom };
  } catch {
    return { view: true, focused: null, blurred: null, ok: false };
  }
}

/** Type text into the CURRENTLY-FOCUSED element via trusted keyboard events.
 *  `sendInputEvent` char events flow through Chromium's input pipeline, so a React
 *  controlled input (e.g. the Inspector's BufferedTextInput) fires its real
 *  onChange — a synthetic `element.value =` would not. Focus the target first
 *  (e.g. `tap` on the input). `clearFirst` selects-all + deletes so the field is
 *  replaced rather than appended; `submitKey` presses a terminal key afterward —
 *  'Tab'/'Escape' BLUR the field (the key case for verifying commit-on-blur),
 *  'Enter' submits. */
/** Read the DOM's currently-focused element and whether it can receive typed text.
 *  Mirrors the game's own `keyboardSource.editing()` predicate (INPUT/TEXTAREA/SELECT/
 *  contentEditable) so "editable" here means the same thing it does to the running game. */
async function readActiveElement(wc: Electron.WebContents): Promise<{ editable: boolean; descriptor: string | null }> {
  return wc.executeJavaScript(
    `(() => {
      const a = document.activeElement;
      const editable = !!a && (/^(input|textarea|select)$/i.test(a.tagName) || a.isContentEditable === true);
      const descriptor = a && a !== document.body ? (a.tagName ? a.tagName.toLowerCase() : String(a)) + (a.id ? '#' + a.id : '') : null;
      return { editable, descriptor };
    })()`,
    true,
  ).catch(() => ({ editable: false, descriptor: null }));
}

export async function typeText(
  win: BrowserWindow,
  text: string,
  opts?: { clearFirst?: boolean; submitKey?: string },
): Promise<{ typed: number; editable: boolean; activeElement: string | null }> {
  const wc = win.webContents;
  // A trusted `char` event only INSERTS text when an editable element holds focus. With nothing
  // (or a non-editable div/canvas) focused, the chars land nowhere yet `sendInputEvent` can't
  // fail — so the route used to report {ok:true, typed:N} typing into the void. Check first and
  // report where focus actually is, so a skipped/stolen focus step is a visible failure. (C7 re-audit.)
  const active = await readActiveElement(wc);
  if (!active.editable) return { typed: 0, editable: false, activeElement: active.descriptor };
  if (opts?.clearFirst) {
    // Cmd+A (macOS) / Ctrl+A elsewhere, then Backspace — empty the field first.
    const mod = process.platform === 'darwin' ? 'meta' : 'control';
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: [mod] } as Electron.KeyboardInputEvent);
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: [mod] } as Electron.KeyboardInputEvent);
    await sleep(8);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' } as Electron.KeyboardInputEvent);
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' } as Electron.KeyboardInputEvent);
    await sleep(8);
  }
  for (const ch of text) {
    // Only the `char` event inserts text; keyDown/keyUp bracket it so key handlers
    // (shortcut guards, Enter-to-commit) still see a real press.
    wc.sendInputEvent({ type: 'keyDown', keyCode: ch } as Electron.KeyboardInputEvent);
    wc.sendInputEvent({ type: 'char', keyCode: ch } as Electron.KeyboardInputEvent);
    wc.sendInputEvent({ type: 'keyUp', keyCode: ch } as Electron.KeyboardInputEvent);
    await sleep(8);
  }
  if (opts?.submitKey) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: opts.submitKey } as Electron.KeyboardInputEvent);
    wc.sendInputEvent({ type: 'keyUp', keyCode: opts.submitKey } as Electron.KeyboardInputEvent);
    await sleep(8);
  }
  return { typed: text.length, editable: true, activeElement: active.descriptor };
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
  wc.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y } as Electron.MouseInputEvent);
  wc.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 } as Electron.MouseInputEvent);
  await sleep(16);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = Math.round(from.x + (to.x - from.x) * t);
    const y = Math.round(from.y + (to.y - from.y) * t);
    wc.sendInputEvent({ type: 'mouseMove', x, y, button: 'left' } as Electron.MouseInputEvent);
    await sleep(16);
    frames.push({ t, x, y, sample: await opts.sample().catch(() => null) });
  }
  wc.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 } as Electron.MouseInputEvent);
  await sleep(16);
  frames.push({ t: 1, x: to.x, y: to.y, sample: await opts.sample().catch(() => null) });
  return { frames };
}
