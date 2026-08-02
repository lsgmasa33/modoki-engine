/**
 * Debug Bridge — the device-side handler for the device MCP's requests.
 *
 * Native only (iOS/Android): uses the capacitor-game-debug plugin's TCP server. The connection is a
 * DELIBERATE, Modoki-owned lease (no Bonjour/mDNS) — the editor backend holds the socket and proxies
 * device_* requests through it (eval/screenshot/tap/drag/logs). See docs/debug-tools-mcp.md.
 *
 * For Chrome/web dev: the MCP uses CDP (Chrome DevTools Protocol) directly — no in-page bridge
 * (launch Chrome with --remote-debugging-port).
 */

import { makeDeviceEvalApi } from './deviceEvalApi';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { setJournalEnabled } from '@modoki/engine/runtime';
import {
  safeStringify,
  handleEval as evalCode,
  screenshotToCSS as toCSS,
  createConsoleRing,
  MAX_CONSOLE_LOGS,
  type LastScreenInfo,
  type ScreenInfoParam,
} from './bridgeHelpers';

interface Request {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

let initialized = false;

// --- Input fidelity (#32) ---

/** What mechanism EVERY device input handler below actually uses to deliver a tap/drag/pointer/
 *  key/hover/scroll/type. Today that is a synthetic DOM event (+ a private-API PixiJS v8 poke for
 *  the canvas ops) — never OS-level trusted input. This is the SINGLE place that fact lives; every
 *  handler reads this constant rather than a per-handler literal, so Phase 1 (Android CDP) and
 *  Phase 2 (iOS WebDriverAgent) in docs/plans/trusted-device-input-plan.md change ONLY this one
 *  spot (eventually replacing the constant with per-platform detection) as each trusted route
 *  lands. See also `docs/enact.md` § "Input fidelity".
 *  Wire format: appended to a successful string reply as ` [input:synthetic]`; the object-shaped
 *  type-text reply carries it as a real `inputMechanism` field instead (see handleType).
 *  Exported so `deviceInputMechanism.test.ts` asserts against THIS value rather than a duplicated
 *  literal — a test that hardcodes 'synthetic' would keep passing if the two silently diverged. */
export const INPUT_MECHANISM = 'synthetic' as const;

/** Append the mechanism marker to a SUCCESSFUL string reply from an input-dispatch handler. Never
 *  applied to an `Error: …` reply — a refusal/aim-resolution failure did not deliver any input, so
 *  there is no mechanism to report. One helper so the wire format (` [input:synthetic]`) cannot
 *  drift between the six string-returning handlers that call it. */
function withMechanismSuffix(reply: string): string {
  return reply.startsWith('Error:') ? reply : `${reply} [input:${INPUT_MECHANISM}]`;
}

// Original console for bridge's own logging (avoids feedback loop)
const _log = console.log.bind(console);

// Screen info from the last native screenshot — used for iOS tap coordinate mapping.
let lastScreenInfo: LastScreenInfo | null = null;

// Console capture ring buffer.
const consoleRing = createConsoleRing(MAX_CONSOLE_LOGS);

// --- Console Capture ---

function patchConsole() {
  const levels = ['log', 'warn', 'error', 'info'] as const;
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      consoleRing.push(level, args);
    };
  }
}

// --- Command Handlers ---

/** Exported for `deviceEvalWiring.test.ts` — same reason the input handlers below are: the unit
 *  test for `makeDeviceEvalApi()` calls that builder DIRECTLY, so it stays green even if this
 *  function stops passing the object it builds. This is the seam production actually takes
 *  (`case 'eval'` → here → `evalCode(code, api)`), so it is the one worth asserting. */
export async function handleEval(params: Record<string, unknown>): Promise<unknown> {
  return evalCode((params.code as string) ?? '', await makeDeviceEvalApi());
}

/** Convert screenshot pixel coords → CSS, reading the bridge's live `lastScreenInfo` + device dpr.
 *  The pure conversion (which prefers an explicit `screenInfo` param over the stale global — L5)
 *  lives in bridgeHelpers so it's unit-tested directly. */
function screenshotToCSS(sx: number, sy: number, screenInfo?: ScreenInfoParam): { x: number; y: number } {
  return toCSS(sx, sy, { screenInfo, lastScreenInfo, dpr: window.devicePixelRatio || 1 });
}

/** Create a PointerEvent for PixiJS */
function mkPointerEvent(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    clientX: x, clientY: y, bubbles: true,
    pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0,
  });
}

// --- Visual Debug Markers ---

let markerContainer: HTMLDivElement | null = null;
// Track outstanding fade/remove timers so they can be cancelled on teardown.
const markerTimers = new Set<ReturnType<typeof setTimeout>>();
function scheduleMarkerTimeout(fn: () => void, ms: number) {
  const id = setTimeout(() => { markerTimers.delete(id); fn(); }, ms);
  markerTimers.add(id);
}

/** Cancel pending marker timeouts and remove the container. Call on bridge teardown. */
export function clearDebugMarkers() {
  for (const id of markerTimers) clearTimeout(id);
  markerTimers.clear();
  if (markerContainer) {
    markerContainer.remove();
    markerContainer = null;
  }
}

function ensureMarkerContainer(): HTMLDivElement {
  if (!markerContainer) {
    markerContainer = document.createElement('div');
    markerContainer.id = 'debug-markers';
    markerContainer.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;';
    document.body.appendChild(markerContainer);
  }
  return markerContainer;
}

function showMarker(cssX: number, cssY: number, color: string, label: string) {
  const container = ensureMarkerContainer();
  const dot = document.createElement('div');
  dot.style.cssText = `position:absolute;left:${cssX - 8}px;top:${cssY - 8}px;width:16px;height:16px;border-radius:50%;background:${color};opacity:0.85;border:2px solid white;box-shadow:0 0 6px ${color};`;
  const txt = document.createElement('div');
  txt.style.cssText = `position:absolute;left:${cssX + 12}px;top:${cssY - 6}px;color:white;font-size:9px;background:rgba(0,0,0,0.8);padding:2px 4px;border-radius:3px;white-space:nowrap;font-family:monospace;`;
  txt.textContent = label;
  container.appendChild(dot);
  container.appendChild(txt);
  // Fade out after 3 seconds (timers tracked so teardown can cancel them)
  scheduleMarkerTimeout(() => { dot.style.transition = 'opacity 1s'; txt.style.transition = 'opacity 1s'; dot.style.opacity = '0'; txt.style.opacity = '0'; }, 3000);
  scheduleMarkerTimeout(() => { dot.remove(); txt.remove(); }, 4000);
}

function showDragLine(fromX: number, fromY: number, toX: number, toY: number) {
  const container = ensureMarkerContainer();
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
  svg.innerHTML = `<line x1="${fromX}" y1="${fromY}" x2="${toX}" y2="${toY}" stroke="yellow" stroke-width="2" stroke-dasharray="6,3" opacity="0.8"/>`;
  container.appendChild(svg);
  scheduleMarkerTimeout(() => { svg.style.transition = 'opacity 1s'; svg.style.opacity = '0'; }, 3000);
  scheduleMarkerTimeout(() => svg.remove(), 4000);
}

/**
 * Dispatch pointer event through PixiJS's internal EventSystem.
 * Synthetic DOM events (canvas.dispatchEvent) don't reach PixiJS v8 —
 * we must call _onPointerDown/_onPointerMove/_onPointerUp directly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPixiEventSystem(): any | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).__pixiApp?.renderer?.events ?? null;
}

// --- Aim resolution (Enact: selector OR screenshot pixels → a CSS viewport point) ---

/** The serializable shape of the `resolve-dom-point` op (engine/app/debug/domResolve). */
interface DomResolution {
  ok: boolean; x?: number; y?: number;
  matched?: string | null; hitTarget?: string | null; occluded?: boolean; error?: string;
}

type Aim = { x: number; y: number; label: string } | { error: string };

/** Resolve a CSS selector to a viewport point (+ occlusion) via the shared runtime op — reused so a
 *  device tap/drag can aim by selector, occlusion-checked server-side, with no screenshot round-trip. */
async function resolveSelectorPoint(selector: string): Promise<DomResolution> {
  const runAgentOp = await getRunAgentOp();
  return (await runAgentOp('resolve-dom-point', { selector })) as DomResolution;
}

/** Resolve an aim point from EITHER a CSS `selector` (resolved + occlusion-checked on-device) or
 *  screenshot pixel coords (converted via the last capture). `selKey`/`xKey`/`yKey` name the params
 *  (tap uses selector/x/y; drag uses fromSelector/fromX/fromY and toSelector/toX/toY). A selector
 *  that misses or is occluded returns an `Error:` string (surfaced as isError by the MCP client). */
async function resolveAim(params: Record<string, unknown>, selKey: string, xKey: string, yKey: string): Promise<Aim> {
  const selector = params[selKey];
  if (typeof selector === 'string' && selector) {
    const r = await resolveSelectorPoint(selector);
    if (!r.ok || typeof r.x !== 'number' || typeof r.y !== 'number') {
      return { error: `Error: ${r.error ?? `selector ${JSON.stringify(selector)} did not resolve`}` };
    }
    if (r.occluded) {
      return { error: `Error: ${JSON.stringify(selector)} (${r.matched}) is occluded by ${r.hitTarget} — not aiming there` };
    }
    return { x: r.x, y: r.y, label: `${selector}→${r.hitTarget}` };
  }
  const screenInfo = params.screenInfo as { imgW: number; imgH: number; nativeW: number; nativeH: number } | undefined;
  const { x, y } = screenshotToCSS(params[xKey] as number, params[yKey] as number, screenInfo);
  return { x, y, label: `css(${Math.round(x)},${Math.round(y)})` };
}

/** A window-bubbling pointer event init at (x,y) — the mouse-pointer shape a real tap/drag carries. */
function ptrInit(x: number, y: number): PointerEventInit {
  return { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true };
}

/** Dispatch a tap at a CSS point.
 *
 *  A DOM button/anchor gets a real click. Otherwise it's a canvas/game tap: dispatch a real pointer
 *  sequence ON the canvas so it bubbles to `window` — feeding the engine's source-agnostic pointer
 *  source (`pointerSource`), which is what a game reads via `Input.pointer*` regardless of 2D/3D
 *  renderer — AND drive PixiJS's federated EventSystem directly when present (a synthetic DOM event
 *  does NOT reach Pixi v8). Doing BOTH mirrors a real finger: `window` (the Input seam) and Pixi's own
 *  canvas listener both see it, so the tap works whether the game reads the seam or Pixi's
 *  `sprite.on('pointerdown')`. The old code returned after the Pixi branch, so a Pixi game never fed
 *  the seam. A short hold between down and up lets per-frame Input sampling catch the down edge. */
async function dispatchTapAt(x: number, y: number): Promise<string> {
  showMarker(x, y, 'red', `tap(${Math.round(x)},${Math.round(y)})`);

  // Try DOM element first (buttons)
  const el = document.elementFromPoint(x, y);
  if (el && (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement || el.closest('button'))) {
    const clickTarget = el.closest('button') ?? el;
    (clickTarget as HTMLElement).click();
    const msg = `ok (clicked DOM: ${clickTarget.tagName})`;
    _log(`[debug-bridge] TAP → ${msg}`);
    return msg;
  }

  const canvas = document.querySelector('canvas');
  const es = getPixiEventSystem();
  if (!canvas && !es) return 'Error: No canvas element found';
  if (canvas) canvas.dispatchEvent(new PointerEvent('pointerdown', ptrInit(x, y)));
  if (es) es._onPointerDown(mkPointerEvent('pointerdown', x, y));
  await new Promise((r) => setTimeout(r, 50)); // hold ~1–2 frames so per-frame Input sampling sees the down edge
  if (canvas) canvas.dispatchEvent(new PointerEvent('pointerup', ptrInit(x, y)));
  if (es) es._onPointerUp(mkPointerEvent('pointerup', x, y));
  const via = [canvas && 'window', es && 'pixi'].filter(Boolean).join('+');
  _log(`[debug-bridge] TAP → ${via} css(${x.toFixed(1)},${y.toFixed(1)})`);
  return `ok (${via}) css(${Math.round(x)},${Math.round(y)})`;
}

export async function handleTap(params: Record<string, unknown>): Promise<string> {
  const aim = await resolveAim(params, 'selector', 'x', 'y');
  if ('error' in aim) { _log(`[debug-bridge] TAP → ${aim.error}`); return aim.error; }
  _log(`[debug-bridge] TAP @ ${aim.label}`);
  return withMechanismSuffix(`${await dispatchTapAt(aim.x, aim.y)} @ ${aim.label}`);
}

export async function handleDrag(params: Record<string, unknown>): Promise<string> {
  const fromAim = await resolveAim(params, 'fromSelector', 'fromX', 'fromY');
  if ('error' in fromAim) { _log(`[debug-bridge] DRAG → ${fromAim.error}`); return fromAim.error; }
  const toAim = await resolveAim(params, 'toSelector', 'toX', 'toY');
  if ('error' in toAim) { _log(`[debug-bridge] DRAG → ${toAim.error}`); return toAim.error; }
  const from = { x: fromAim.x, y: fromAim.y };
  const to = { x: toAim.x, y: toAim.y };
  const steps = (params.steps as number) || 5;
  const delayMs = (params.delayMs as number) || 20;

  _log(`[debug-bridge] DRAG ${fromAim.label}→${toAim.label} → css(${from.x.toFixed(1)},${from.y.toFixed(1)})→(${to.x.toFixed(1)},${to.y.toFixed(1)})`);
  showMarker(from.x, from.y, 'lime', `from(${Math.round(from.x)},${Math.round(from.y)})`);
  showMarker(to.x, to.y, 'cyan', `to(${Math.round(to.x)},${Math.round(to.y)})`);
  showDragLine(from.x, from.y, to.x, to.y);

  // DOM-element-targeted drag: move DOM chrome (a debug widget, slider) by dispatching the pointer
  // sequence ON the grabbed element — the world path below dispatches on the canvas, which never
  // reaches a DOM element's React handlers. Auto-engaged when the grab lands on a non-canvas element
  // (or forced with dom:true); dom:false forces the world path. The `fromSelector` element is
  // preferred over elementFromPoint so the drag lands on the exact handle (e.g. a widget header).
  const explicitDom = params.dom as boolean | undefined;
  const grabEl = (typeof params.fromSelector === 'string' && params.fromSelector
    ? document.querySelector(params.fromSelector)
    : document.elementFromPoint(from.x, from.y)) as HTMLElement | null;
  const domMode = explicitDom === true || (explicitDom !== false && !!grabEl && grabEl.tagName !== 'CANVAS' && !grabEl.closest('canvas'));
  if (domMode) {
    if (!grabEl) return `Error: no element to drag at ${typeof params.fromSelector === 'string' ? JSON.stringify(params.fromSelector) : `(${Math.round(from.x)},${Math.round(from.y)})`}`;
    return withMechanismSuffix(await domDrag(grabEl, from, to, steps, delayMs));
  }

  // World-space drag: dispatch a real pointer sequence ON the canvas so it bubbles to `window` and
  // feeds the source-agnostic pointer source (the sanctioned Input seam a game reads via
  // Input.pointerDrag), AND drive PixiJS's federated EventSystem directly when present (synthetic DOM
  // events don't reach Pixi v8). Doing BOTH mirrors a real finger — window + Pixi's canvas listener
  // both see it — so the drag works whether the game reads the Input seam or Pixi sprite interaction.
  // (The old code returned after the Pixi branch, so a Pixi game never fed the seam.)
  const canvas = document.querySelector('canvas');
  const es = getPixiEventSystem();
  if (!canvas && !es) return 'Error: No canvas element found';
  if (canvas) canvas.dispatchEvent(new PointerEvent('pointerdown', ptrInit(from.x, from.y)));
  if (es) es._onPointerDown(mkPointerEvent('pointerdown', from.x, from.y));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    await new Promise((r) => setTimeout(r, delayMs));
    if (canvas) canvas.dispatchEvent(new PointerEvent('pointermove', ptrInit(x, y)));
    if (es) es._onPointerMove(mkPointerEvent('pointermove', x, y));
  }
  if (canvas) canvas.dispatchEvent(new PointerEvent('pointerup', ptrInit(to.x, to.y)));
  if (es) es._onPointerUp(mkPointerEvent('pointerup', to.x, to.y));
  const via = [canvas && 'window', es && 'pixi'].filter(Boolean).join('+');
  _log(`[debug-bridge] DRAG → ${via}`);
  return withMechanismSuffix(`ok (${via}) css(${Math.round(from.x)},${Math.round(from.y)})→(${Math.round(to.x)},${Math.round(to.y)})`);
}

function handleConsoleLogs(params: Record<string, unknown>): ReturnType<typeof consoleRing.query> {
  return consoleRing.query((params.limit as number) || 50, params.level as string | undefined);
}

// --- App identity (#88) ---

/** Which app is actually holding this socket — the on-device twin of `modoki_identity`.
 *
 *  Port 9095 is a fixed default shared by every Modoki game, and Android keeps a backgrounded
 *  app's process (and its bound socket) alive — so a `device_*` call can silently be answered by
 *  a DIFFERENT app than the one just launched (#88). The MCP's `device_status` reports this so
 *  that mismatch is one call away instead of a logcat hunt: it's read here, in the SAME page
 *  context as the TCP server, so the answer is reported by the app that actually holds the
 *  socket — not derived by the MCP client, which could only ever guess.
 *
 *  `@capacitor/app`'s `getInfo()` is unimplemented on web (throws) — this bridge only runs the
 *  native path in practice (`initNativeBridge`, gated on `Capacitor.isNativePlatform()`), but the
 *  fallback keeps this handler total rather than a rejection the router would have to translate. */
export async function handleAppIdentity(): Promise<{ platform: string; appId: string; appName: string }> {
  const platform = Capacitor.getPlatform();
  try {
    const info = await CapacitorApp.getInfo();
    return { platform, appId: info.id, appName: info.name };
  } catch {
    return { platform, appId: '', appName: '' };
  }
}

// --- Sustained pointer (held across calls): down / move / up (#31) ---

/** The currently-HELD sustained pointer, or null between gestures.
 *
 *  Lives at MODULE scope in this file — the device-side analogue of the editor route's
 *  `heldPointer` closure (`engine/electron/inputRoutes.ts`). The editor keeps the held state in
 *  the Node BACKEND because the thing that can go away mid-gesture is the renderer (a page
 *  reload wipes it, so the backend resets it explicitly on reload — see `resetHeldPointer`
 *  there). On the device there is no separate backend: this bridge script IS the thing that
 *  would go away on a reload, and a reload re-runs this whole module from scratch (this `let`
 *  reinitializes to null for free) — so module scope is the honest equivalent of "the process
 *  that owns the gesture", not a workaround. A held press does NOT currently survive a page
 *  navigation/reload on the device (unlike the editor, which explicitly persists across one);
 *  that asymmetry is inherent to there being no separate backend process here. */
let heldPointer: { button: number; x: number; y: number } | null = null;

/** Test-only reset — a held gesture left by one test would otherwise leak into the next
 *  (module state persists for the life of the imported module, and vitest does not re-import
 *  per test). Not called by production code. */
export function _resetHeldPointerForTests(): void { heldPointer = null; }

const POINTER_BUTTON_CODE: Record<string, number> = { left: 0, middle: 1, right: 2 };
const POINTER_BUTTON_NAME = ['left', 'middle', 'right'];

/** A pointer event carrying a real button/buttons state (unlike `mkPointerEvent`, which is
 *  hardcoded to button 0 for the atomic tap). `buttons` is the CURRENTLY-held mask — 0 on
 *  pointerup, the bit for the pressed button otherwise — so a held move reads as a drag, not a
 *  hover, mirroring the `buttonHeldModifier` re-assertion `rendererOps.pointerMove` does for the
 *  Electron path. */
function mkButtonedPointerEvent(type: string, x: number, y: number, button: number): PointerEvent {
  return new PointerEvent(type, {
    clientX: x, clientY: y, bubbles: true, cancelable: true,
    pointerId: 1, pointerType: 'mouse', isPrimary: true, button,
    buttons: type === 'pointerup' ? 0 : (1 << button),
  });
}

/** Sustained pointer: `action:'down'` presses and HOLDS (no matching up is sent), `'move'`
 *  re-aims the still-held pointer, `'up'` releases. A `move`/`up` with nothing held, or a `down`
 *  while already held, is refused rather than silently re-aiming/re-pressing — the same guard
 *  the editor route (`/api/input/pointer`) makes. Each call is aimed independently (selector or
 *  screenshot-pixel `x`/`y`, already resolved to CSS by the caller via `resolveAim`). */
// Exported for direct unit testing (bridgePointerAndType.test.ts) — the held-pointer refusal
// logic and the synthetic-typing fallback live ONLY here (device-side), so a test that stubs the
// backend and asserts on the MCP tool's relayed payload cannot exercise them; jsdom lets this
// module import cleanly (measured), so a direct call is the honest way to cover them.
export async function handlePointer(params: Record<string, unknown>): Promise<string> {
  const action = params.action as string;
  if (action !== 'down' && action !== 'move' && action !== 'up') {
    return `Error: pointer action must be 'down', 'move', or 'up' (got ${JSON.stringify(action)})`;
  }
  if (action === 'down' && heldPointer) {
    return `Error: a pointer is already held (button ${POINTER_BUTTON_NAME[heldPointer.button]} down at ${heldPointer.x.toFixed(1)},${heldPointer.y.toFixed(1)}). Release it with action:'up' before pressing again.`;
  }
  if ((action === 'move' || action === 'up') && !heldPointer) {
    return `Error: no pointer is held — send action:'down' first (this ${action} would be a stray event).`;
  }
  // A 'move'/'up' MAY omit the aim, and an 'up' normally does — releasing happens wherever the
  // gesture got to. Fall back to the HELD position, for the same reason the button is reused
  // below: the event must state where the pointer is, and there is no aim to resolve.
  // Measured on-device before this fell back: `up` with no coords resolved to NaN and the
  // canvas received pointerup at (0,0) instead of the drag-end point — a Pixi drag would
  // release at the origin rather than where it was dragged to.
  const hasAim = params.x !== undefined || params.y !== undefined
    || params.selector !== undefined || params.entity !== undefined;
  let aim: { x: number; y: number; label: string };
  if (hasAim || action === 'down') {
    const resolved = await resolveAim(params, 'selector', 'x', 'y');
    if ('error' in resolved) { _log(`[debug-bridge] POINTER ${action} → ${resolved.error}`); return resolved.error; }
    aim = resolved;
  } else {
    aim = { x: heldPointer!.x, y: heldPointer!.y, label: `css(${heldPointer!.x},${heldPointer!.y}) [held]` };
  }

  // 'down' picks the button (default left); 'move'/'up' MUST reuse the one already held — the
  // event has to say which button is down, and there is no way to change it mid-gesture.
  const buttonName = action === 'down' ? ((params.button as string) ?? 'left') : POINTER_BUTTON_NAME[heldPointer!.button];
  const button = POINTER_BUTTON_CODE[buttonName] ?? 0;

  const canvas = document.querySelector('canvas');
  const es = getPixiEventSystem();
  if (!canvas && !es) return 'Error: No canvas element found';

  const type = action === 'down' ? 'pointerdown' : action === 'move' ? 'pointermove' : 'pointerup';
  if (canvas) canvas.dispatchEvent(mkButtonedPointerEvent(type, aim.x, aim.y, button));
  if (es) {
    const ev = mkButtonedPointerEvent(type, aim.x, aim.y, button);
    if (action === 'down') es._onPointerDown(ev);
    else if (action === 'move') es._onPointerMove(ev);
    else es._onPointerUp(ev);
  }
  showMarker(aim.x, aim.y, action === 'down' ? 'orange' : action === 'move' ? 'yellow' : 'purple', `pointer${action}(${Math.round(aim.x)},${Math.round(aim.y)})`);
  heldPointer = action === 'up' ? null : { button, x: aim.x, y: aim.y };
  await new Promise((r) => setTimeout(r, 16)); // let per-frame Input sampling see the edge, same as tap/drag

  const via = [canvas && 'window', es && 'pixi'].filter(Boolean).join('+');
  _log(`[debug-bridge] POINTER ${action} → ${via} @ ${aim.label}`);
  return withMechanismSuffix(`ok (${action} ${via}, button ${buttonName}, held:${heldPointer !== null}) @ ${aim.label}`);
}

// --- Type text into the focused element (#31) ---

/** e.code for a submitKey (Enter/Tab/Escape already match; reuse the tap-key helper otherwise). */
function typeCode(key: string): string {
  return keyToCode(key);
}

/** Set a form element's value through its NATIVE property setter and fire a real `input` event.
 *
 *  React patches `HTMLInputElement.prototype.value`'s setter on the instance so it can detect a
 *  plain `el.value = x` and IGNORE it (to keep the controlled value authoritative) — so a raw
 *  assignment does not fire `onChange`, which is exactly the outcome we must avoid (the editor's
 *  `typeText` gets this for free because Electron's `sendInputEvent` flows through Chromium's
 *  real input pipeline, which the device has no equivalent of). Calling the ORIGINAL prototype
 *  setter bypasses React's instance override, and the `input` event is what React's synthetic
 *  event system actually listens for — the same technique `@testing-library/react`'s
 *  `fireEvent.change` uses under the hood. This is a SYNTHETIC event, not a trusted OS-level one
 *  (out of scope here — see #32); it is the closest available substitute on a device WebView. */
function setControlledValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Same TWO QUESTIONS the editor's `typeText` distinguishes (`rendererOps.ts` ACTIVE_ELEMENT_PROBE):
 *  can this element receive typed characters at all (readOnly/disabled/checkbox/select all hold
 *  focus and all reject text)? Kept in sync by inspection, not import — this file cannot import
 *  Electron-main code, and the predicate is small enough that duplicating it is cheaper than a
 *  cross-package shared module for one boolean. */
function typableFocus(): { typable: boolean; descriptor: string | null; el: HTMLElement | null } {
  const a = document.activeElement as HTMLElement | null;
  const tag = a?.tagName ?? '';
  const TEXT_TYPES = ['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'datetime-local', 'month', 'week', 'time'];
  let typable = false;
  if (a) {
    if ((a as HTMLElement).isContentEditable === true) typable = true;
    else if (tag === 'TEXTAREA') typable = !(a as HTMLTextAreaElement).readOnly && !(a as HTMLTextAreaElement).disabled;
    else if (tag === 'INPUT') {
      const inp = a as HTMLInputElement;
      typable = !inp.readOnly && !inp.disabled && TEXT_TYPES.includes((inp.type || 'text').toLowerCase());
    }
  }
  const descriptor = a && a !== document.body ? (tag ? tag.toLowerCase() : String(a)) + ((a as HTMLElement).id ? '#' + (a as HTMLElement).id : '') : null;
  return { typable, descriptor, el: a };
}

function readFocusedValue(el: HTMLElement): string | null {
  if (el.isContentEditable) return el.textContent ?? '';
  const v = (el as HTMLInputElement | HTMLTextAreaElement).value;
  return typeof v === 'string' ? v : null;
}

/** Type text into the CURRENTLY-focused element. `clearFirst` empties the field before typing
 *  (replace vs append); `submitKey` dispatches a terminal key chord afterward ('Enter' submits,
 *  'Tab'/'Escape' blur — mirrors `modoki_type_text`'s `submitKey`). Returns the SAME envelope
 *  shape as the editor route (`ok`, `typed`, `activeElement`, `valueAfter`, `error`) so the MCP
 *  tool can report it identically. `typed` is MEASURED (whether the requested text landed in the
 *  field afterward), not the length of what was asked for — an unfocused/non-typable target is a
 *  reported failure, never a silent no-op dressed as success. A successful reply also carries
 *  `inputMechanism` (see INPUT_MECHANISM above) — this handler returns an OBJECT rather than the
 *  string the other input handlers do, so the mechanism is a real field here instead of the
 *  ` [input:synthetic]` suffix those use; a failure carries no field, matching the string handlers'
 *  rule that a refusal never claims a mechanism because nothing was dispatched. */
export async function handleType(params: Record<string, unknown>): Promise<{ ok: boolean; typed: number; activeElement: string | null; valueAfter?: string | null; error?: string; inputMechanism?: typeof INPUT_MECHANISM }> {
  const text = params.text;
  if (typeof text !== 'string') return { ok: false, typed: 0, activeElement: null, error: 'type-text needs a `text` string' };

  const { typable, descriptor, el } = typableFocus();
  if (!typable || !el) {
    return {
      ok: false, typed: 0, activeElement: descriptor,
      error: descriptor
        ? `the focused element (${descriptor}) cannot receive typed text — it is readOnly/disabled, or not a text control (checkbox, select, button). Nothing was typed.`
        : 'no element is focused, so nothing was typed — device_tap the target input first, then type.',
    };
  }

  const clearFirst = params.clearFirst === true;
  if (el.isContentEditable) {
    if (clearFirst) el.textContent = '';
    el.textContent = (el.textContent ?? '') + text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    const before = clearFirst ? '' : input.value;
    setControlledValue(input, before + text);
  }
  const after = readFocusedValue(el) ?? '';

  const submitKey = params.submitKey;
  if (typeof submitKey === 'string' && submitKey) {
    const init: KeyboardEventInit = { key: submitKey, code: typeCode(submitKey), bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  // WHAT LANDED, not a length delta (mirrors rendererOps.typeText's S3.18 reasoning) — a landed
  // insert is a substring of the after-value for both append and replace(clearFirst) flows.
  const landed = text.length === 0 || after.includes(text);
  _log(`[debug-bridge] TYPE "${text.length > 40 ? text.slice(0, 40) + '…' : text}" → ${descriptor}`);
  if (!landed) {
    return {
      ok: false, typed: 0, activeElement: descriptor, valueAfter: after,
      error: `the requested text did not land in the field (valueAfter: ${JSON.stringify(after)}) — a device WebView can only insert characters through a synthetic value-set, which some controlled inputs may reject or transform`,
    };
  }
  return { ok: true, typed: text.length, activeElement: descriptor, valueAfter: after, inputMechanism: INPUT_MECHANISM };
}

// --- Enact: DOM-element drag, keyboard, hover, scroll (Phase 4) ---

/** Drag by dispatching the pointer sequence ON a DOM element (not the game canvas), so a DOM
 *  widget's own `onPointerDown`/`onPointerMove` handlers fire — the way to move DOM chrome
 *  (debug widgets, sliders) that the canvas-targeted world drag can't reach.
 *
 *  `useDraggable` (and most React drag hooks) call `e.currentTarget.setPointerCapture(pointerId)` on
 *  pointerdown BEFORE latching the drag. A SYNTHETIC pointer isn't an active pointer, so that call
 *  throws `InvalidStateError` and aborts the latch. We neutralize the three capture methods on the
 *  target for the duration of the synthetic sequence, then restore them. */
async function domDrag(el: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }, steps: number, delayMs: number): Promise<string> {
  const pointerId = 1;
  const savedSet = el.setPointerCapture, savedHas = el.hasPointerCapture, savedRel = el.releasePointerCapture;
  el.setPointerCapture = () => {}; el.hasPointerCapture = () => false; el.releasePointerCapture = () => {};
  const ev = (type: string, x: number, y: number, buttons: number) => new PointerEvent(type, {
    clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId, pointerType: 'mouse', isPrimary: true, button: 0, buttons,
  });
  try {
    el.dispatchEvent(ev('pointerdown', from.x, from.y, 1));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await new Promise((r) => setTimeout(r, delayMs));
      el.dispatchEvent(ev('pointermove', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 1));
    }
    el.dispatchEvent(ev('pointerup', to.x, to.y, 0));
  } finally {
    el.setPointerCapture = savedSet; el.hasPointerCapture = savedHas; el.releasePointerCapture = savedRel;
  }
  _log(`[debug-bridge] DOM-DRAG on ${el.tagName} → css(${Math.round(from.x)},${Math.round(from.y)})→(${Math.round(to.x)},${Math.round(to.y)})`);
  return `ok (dom drag ${el.tagName.toLowerCase()}) css(${Math.round(from.x)},${Math.round(from.y)})→(${Math.round(to.x)},${Math.round(to.y)})`;
}

/** e.code for a bare key: single letters → `KeyX`, else the key itself (Fn keys, arrows already match). */
function keyToCode(key: string): string {
  return key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key;
}

/** Press a key chord (keydown, hold ~1–2 frames, keyup) — open the debug menu (F12), Escape a modal,
 *  drive gameplay keys. Dispatched on the focused element (bubbles to `window`, where the menu +
 *  input sources listen). The hold lets per-frame input sampling see the down edge. */
export async function handlePressKey(params: Record<string, unknown>): Promise<string> {
  const key = params.key as string;
  if (!key) return 'Error: press-key needs a key';
  const mods = (params.modifiers as string[]) ?? [];
  const init: KeyboardEventInit = {
    key, code: (params.code as string) || keyToCode(key), bubbles: true, cancelable: true,
    ctrlKey: mods.includes('ctrl'), shiftKey: mods.includes('shift'), altKey: mods.includes('alt'), metaKey: mods.includes('meta'),
  };
  const target: EventTarget = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : window;
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  await new Promise((r) => setTimeout(r, 50)); // hold ~1–2 frames so per-frame input sampling sees the edge
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  _log(`[debug-bridge] KEY ${key}${mods.length ? ' +' + mods.join('+') : ''}`);
  return withMechanismSuffix(`ok (key ${key}${mods.length ? ' +' + mods.join('+') : ''})`);
}

/** Hover: move the pointer over the resolved element/point (pointerover/enter/move + mousemove) so
 *  :hover styles, tooltips, and hover-gated UI light up. */
export async function handleHover(params: Record<string, unknown>): Promise<string> {
  const aim = await resolveAim(params, 'selector', 'x', 'y');
  if ('error' in aim) return aim.error;
  const el = document.elementFromPoint(aim.x, aim.y);
  if (!el) return `Error: no element at (${Math.round(aim.x)},${Math.round(aim.y)}) to hover`;
  const base = { clientX: aim.x, clientY: aim.y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' as const };
  el.dispatchEvent(new PointerEvent('pointerover', base));
  el.dispatchEvent(new PointerEvent('pointerenter', { ...base, bubbles: false }));
  el.dispatchEvent(new PointerEvent('pointermove', base));
  el.dispatchEvent(new MouseEvent('mousemove', { clientX: aim.x, clientY: aim.y, bubbles: true, cancelable: true }));
  return withMechanismSuffix(`ok (hover ${el.tagName.toLowerCase()}) @ ${aim.label}`);
}

/** Scroll: dispatch a wheel event at the resolved point (defaults to viewport center). */
export async function handleScroll(params: Record<string, unknown>): Promise<string> {
  const hasAim = typeof params.selector === 'string' || (typeof params.x === 'number' && typeof params.y === 'number');
  const p = hasAim ? params : { ...params, x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const aim = await resolveAim(p, 'selector', 'x', 'y');
  if ('error' in aim) return aim.error;
  const el = document.elementFromPoint(aim.x, aim.y) ?? document.scrollingElement ?? document.body;
  const dx = (params.dx as number) ?? 0;
  const dy = (params.dy as number) ?? 0;
  el.dispatchEvent(new WheelEvent('wheel', { clientX: aim.x, clientY: aim.y, deltaX: dx, deltaY: dy, bubbles: true, cancelable: true }));
  return withMechanismSuffix(`ok (scroll dx=${dx} dy=${dy}) @ ${aim.label}`);
}

// --- Message Router ---

async function handleMessage(req: Request): Promise<unknown> {
  const p = req.params ?? {};
  switch (req.method) {
    case 'eval': return handleEval(p);
    // 'screenshot' is intercepted natively in initNativeBridge (GameDebug.captureScreen) before it
    // reaches here; the old in-page canvas-extract path was dead and has been removed (D4).
    case 'tap': return await handleTap(p);
    case 'drag': return await handleDrag(p);
    case 'pointer': return await handlePointer(p);
    case 'press-key': return await handlePressKey(p);
    case 'hover': return await handleHover(p);
    case 'scroll': return await handleScroll(p);
    case 'type-text': return await handleType(p);
    case 'consoleLogs': return handleConsoleLogs(p);
    case 'app-identity': return await handleAppIdentity();
    // Percept / Enact on device (device_get_scene_state, device_diagnose, device_journal, …).
    // Delegate any other method to the SHARED runtime op registry (engine/app/debug/agentBridge)
    // — the same summary-first, GUID-addressed, float-rounded ops the editor MCP uses. Its
    // registration side-effects run on first import, so runAgentOp then resolves. Imported
    // DYNAMICALLY so the ops chunk is code-split out of the main bundle and only loads on the
    // first Percept request over a live lease (a release game's server rejects connections, so
    // handleMessage never runs → the chunk never loads). See docs/plans/device-percept-enact-plan.md.
    default: return await delegateToAgentOps(req.method, p);
  }
}

/** Lazily get the shared runtime op registry's dispatcher. Imported DYNAMICALLY (see the
 *  handleMessage delegation note) so the ops chunk stays code-split out of the main bundle and only
 *  loads on the first Percept/Enact request over a live lease. Shared by the delegation and by
 *  selector-aim (`resolve-dom-point`). Module caching makes the repeated import a no-op after the first. */
async function getRunAgentOp(): Promise<(op: string, params?: unknown) => Promise<unknown>> {
  const { runAgentOp } = await import('./agentBridge');
  return runAgentOp;
}

/** Route a non-native method to the shared agent-op registry, translating a thrown/unknown-op into
 *  the same `Error:` / `Unknown method:` sentinel the MCP client's `isDeviceError` already flags. */
async function delegateToAgentOps(method: string, params: Record<string, unknown>): Promise<unknown> {
  try {
    const runAgentOp = await getRunAgentOp();
    return await runAgentOp(method, params);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unknown agent op/i.test(msg)) return `Unknown method: ${method}`;
    return `Error: ${msg}`;
  }
}

// --- Native Bridge (iOS/Android via Capacitor plugin) ---

async function initNativeBridge() {
  _log('[debug-bridge] Loading native plugin...');
  const { GameDebug } = await import('capacitor-game-debug');
  _log('[debug-bridge] Plugin loaded, starting server...');

  try {
    const result = await GameDebug.startServer();
    _log('[debug-bridge] Native TCP server started on port', result.port);
  } catch (e) {
    _log('[debug-bridge] startServer failed:', (e as Error).message);
    throw e;
  }

  GameDebug.addListener('request', async (data) => {
    const id = data.id;
    const method = data.method;
    const params = typeof data.params === 'string' ? JSON.parse(data.params) : data.params;

    try {
      // iOS screenshot: native capture via drawHierarchy (captures WebGL on iOS)
      // Android screenshots are handled by adb screencap in the MCP server
      if (method === 'screenshot') {
        const result = await GameDebug.captureScreen();
        lastScreenInfo = {
          imageWidth: result.imageWidth,
          imageHeight: result.imageHeight,
          screenWidth: result.screenWidth,
          screenHeight: result.screenHeight,
        };
        await GameDebug.sendResponse({
          id,
          result: safeStringify({
            image: result.image,
            imageWidth: result.imageWidth,
            imageHeight: result.imageHeight,
            screenWidth: result.screenWidth,
            screenHeight: result.screenHeight,
          }),
        });
        return;
      }
      // iOS native logs via OSLogStore, Android native logs via logcat (in-process)
      if (method === 'nativeLogs') {
        const { logs } = await GameDebug.getNativeLogs({
          limit: params?.limit ?? 50,
          seconds: params?.seconds ?? 60,
          filter: params?.filter,
          subsystem: params?.subsystem,
        });
        await GameDebug.sendResponse({ id, result: safeStringify(logs) });
        return;
      }

      const result = await handleMessage({ id, method, params });
      await GameDebug.sendResponse({ id, result: safeStringify(result) });
    } catch (e) {
      await GameDebug.sendResponse({ id, error: (e as Error).message });
    }
  });

  GameDebug.addListener('connectionChanged', (data) => {
    if (data.connected) {
      _log(`[debug-bridge] MCP client connected from ${data.remoteAddress}`);
      // Percept: a debugger is attached — record journal events from NOW, not from the
      // first `journal-events` read. A shipped game boots with journaling OFF (main.tsx),
      // so without this, everything before that first read (launch-time physics contacts,
      // scene events) is silently lost. Never disabled on disconnect — the zero-overhead
      // default only matters for sessions that never attach a debugger.
      setJournalEnabled(true);
    } else {
      _log('[debug-bridge] MCP client disconnected');
    }
  });

  // Page-reload-while-connected (the N12 repro): a full reload (e.g. `engine.reload` →
  // window.location.reload) re-runs main.tsx, which re-disables journaling on a shipped
  // game — and since the native TCP socket persists across the reload, NO connectionChanged
  // fires to re-enable it. Ask the native side whether a client is already attached.
  // (Listener above is registered first, so a client connecting in between is not missed.)
  try {
    const status = await GameDebug.getStatus();
    if (status.clientConnected) {
      _log('[debug-bridge] client already connected (page reload) — journaling on');
      setJournalEnabled(true);
    }
  } catch (e) {
    _log('[debug-bridge] getStatus failed:', (e as Error).message);
  }
}

// --- Public API ---

export function initDebugBridge() {
  if (initialized) return;
  initialized = true;

  patchConsole();

  if (Capacitor.isNativePlatform()) {
    _log('[debug-bridge] Initializing native bridge');
    initNativeBridge().catch((e) => {
      _log('[debug-bridge] Native bridge init failed:', (e as Error).message);
    });
  } else {
    _log('[debug-bridge] Web mode — use Chrome with --remote-debugging-port=9222 for MCP debugging');
  }
}
