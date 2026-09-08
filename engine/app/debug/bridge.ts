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
import { describeElement } from './domResolve';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { setJournalEnabled, getFrameLoopHealth } from '@modoki/engine/runtime';
import { createSupersessionToken, createTeardownToken } from '@modoki/engine/runtime/core/liveness';
import { consoleRing, installDeviceConsoleCapture, unpatchedLog } from './deviceConsoleCapture';
import { getConsoleRingDropped } from '@modoki/engine/runtime/core/consoleRing';
import {
  safeStringify,
  describeShape,
  handleEval as evalCode,
  screenshotToCSS as toCSS,
  clampEvalTimeout,
  DEVICE_EVAL_TIMEOUT_MS,
  DEVICE_EVAL_MAX_TIMEOUT_MS,
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
 *  key/hover/scroll/type. Today that is a synthetic DOM event — never OS-level trusted input. (It
 *  once also poked PixiJS v8's private event system for the canvas ops; that was inert and is gone
 *  — see `pickCanvasAt` and #93.) This is the SINGLE place that fact lives; every
 *  handler reads this constant rather than a per-handler literal.
 *
 *  Note this is the IN-PAGE mechanism only, and it stays 'synthetic' permanently: trusted input is
 *  injected HOST-SIDE (a page cannot dispatch a trusted event to itself), so neither the Android
 *  CDP route nor the iOS WebDriverAgent route runs through this bundle at all. What a device_* reply
 *  reports is chosen by the router; this constant is what the FALLBACK path uses. See
 *  docs/trusted-device-input.md and `docs/enact.md` § "Input fidelity".
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

/** Refuse an input dispatch when the frame loop cannot actually deliver it (#682).
 *
 *  The "hold ~1-2 frames" `setTimeout`s below (and in `handlePressKey`/`handlePointer`) assume
 *  per-frame `Input` sampling is running so the down/up edge gets seen — true only while the ECS
 *  pipeline is registered as a frame callback and rAF is actually pumping it. On a dead chain the
 *  wall-clock timer still fires (timers keep running — `declareUnrecoverable`'s own text), the
 *  dispatch below still runs, and the reply still says `ok`, but zero frames pass and
 *  `inputSystem` never samples anything: a false success, worse than a hang because the caller
 *  acts on it.
 *
 *  `device_step`'s existing refusal (`agentBridge.ts`) GUESSES — "the frame loop may be stopped".
 *  `getFrameLoopHealth()` can say it FOR CERTAIN: `.detail` already states how long, whether the
 *  watchdog has given up (`unrecoverable`), and whether the GPU device was lost, so this reuses it
 *  rather than re-deriving the same facts. Returns `null` (proceed) unless the loop is genuinely
 *  `'stalled'` or `unrecoverable` — `'idle'`/`'hidden'` are left alone: a loop that never armed at
 *  all (no viewport mounted yet) or is merely throttled by an occluded window is not this bug. */
function frameLoopRefusal(op: string): string | null {
  const h = getFrameLoopHealth();
  if (h.status !== 'stalled' && !h.unrecoverable) return null;
  return `Error: refusing ${op} — ${h.detail ?? `the frame loop has not ticked for ${h.msSinceLastFrame}ms`} `
    + 'Dispatching this input now would report success while the game never receives it.';
}

// The bridge's OWN logging, deliberately kept OUT of `consoleRing` (avoids a feedback loop, and
// stops 25 chatter call sites evicting the 200-entry ring that `device_console_logs` reads).
// ⚠️ Imported, NOT `console.log.bind(console)` here: since #591 installs the capture eagerly from
// `main.tsx`, `console.log` is ALREADY the ring wrapper by the time this module evaluates, so a
// local bind would capture the wrapper and put every `[debug-bridge]` line into the ring. See
// `unpatchedLog`'s comment in ./deviceConsoleCapture.ts.
const _log = unpatchedLog;
/** The ERROR twin of `_log`. Separate because a bridge that failed to start must not report it at
 *  `log` level: on a device the only readable channel is logcat/OSLog, and a `console.log` line
 *  there is indistinguishable from ordinary chatter — see `initDebugBridge`'s note on #164 for the
 *  hour that cost.
 *
 *  It reads live `console.error` (NOT `unpatchedLog`'s error twin) on purpose, and that is the whole
 *  difference between the two: `_log` must stay out of `consoleRing`, `_err` must land IN it.
 *  `installDeviceConsoleCapture` replaces `console.error` with a wrapper that also pushes into the
 *  ring, so a failure reported through `_err` is readable via `device_console_logs`.
 *  That distinction is invisible for a boot failure — if the server never binds, nothing can read
 *  the ring anyway — but it is not for the port-lifecycle failure, which is RECOVERABLE: a later
 *  foreground can succeed, and then `device_console_logs` is reachable again with a gap it cannot
 *  explain. Late-bound, the failure is in the ring waiting. No recursion risk: the wrapper calls the
 *  original and appends to an array, it does not log. */
const _err = (...args: unknown[]) => console.error(...args);

// Screen info from the last native screenshot — used for iOS tap coordinate mapping.
let lastScreenInfo: LastScreenInfo | null = null;
// A retried `screenshot` request (the MCP client times out and re-sends while the native
// `GameDebug.captureScreen()` for the FIRST request is still in flight) can resolve out of order —
// the newer request's response can land before the older one's. Without this, the older, in-flight
// call's `await` resumes last and overwrites `lastScreenInfo` with stale dimensions (e.g. from
// before a device rotation the newer capture already reflects), corrupting tap-coordinate mapping
// until the next screenshot. A newer request always wins.
const screenshotEpoch = createSupersessionToken();

// --- Command Handlers ---

/** Exported for `deviceEvalWiring.test.ts` — same reason the input handlers below are: the unit
 *  test for `makeDeviceEvalApi()` calls that builder DIRECTLY, so it stays green even if this
 *  function stops passing the object it builds. This is the seam production actually takes
 *  (`case 'eval'` → here → `evalCode(code, api)`), so it is the one worth asserting. */
export async function handleEval(params: Record<string, unknown>): Promise<unknown> {
  // The ceiling here USED to be dictated by the transport — `TcpLeaseTransport` fixed its request
  // deadline at 5000ms per CONNECTION (host-side, its clock starting before the request even
  // reached us), so a device budget at or above that could never be the one that fires. #153 made
  // that deadline per-request and sized from this budget, so the ceiling is a policy choice again.
  // See DEVICE_EVAL_MAX_TIMEOUT_MS.
  const timeoutMs = clampEvalTimeout(params.timeoutMs, DEVICE_EVAL_TIMEOUT_MS, DEVICE_EVAL_MAX_TIMEOUT_MS);
  return evalCode((params.code as string) ?? '', await makeDeviceEvalApi(), timeoutMs);
}

/** Convert screenshot pixel coords → CSS, reading the bridge's live `lastScreenInfo` + device dpr.
 *  The pure conversion (which prefers an explicit `screenInfo` param over the stale global — L5)
 *  lives in bridgeHelpers so it's unit-tested directly. */
function screenshotToCSS(sx: number, sy: number, screenInfo?: ScreenInfoParam): { x: number; y: number } {
  return toCSS(sx, sy, { screenInfo, lastScreenInfo, dpr: window.devicePixelRatio || 1 });
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

/** Which canvas is under the aim point (#93).
 *
 *  This USED to be `document.querySelector('canvas')` — the first canvas in the document,
 *  regardless of where the call aimed. Measured on `games/3d-test`, which mounts a full-screen
 *  Three.js canvas (index 0) and a 200x300 PixiJS canvas at (30,353) (index 1): a synthetic aim at
 *  (130,503), squarely inside the Pixi canvas, was dispatched on canvas 0 — while the trusted CDP
 *  path at the same point correctly reached canvas 1. The reply still said `ok` and echoed the
 *  coordinates, so it read as a hit. Any project with a 2D layer over a 3D one was affected.
 *
 *  `how` is reported back in the reply so the caller can tell a real hit from a guess:
 *  - `hit`       — `elementFromPoint` landed on a canvas (or inside one). The honest answer.
 *  - `only`      — the point is not over a canvas, but the document has exactly one, so there is
 *                  nothing to disambiguate. (Also the jsdom case: no layout, so every rect is 0x0.)
 *  - `contains`  — several canvases and the point missed them all per hit-testing (the hit landed on
 *                  a CONTAINER of them — `<body>`, an app root), so pick the LAST one whose rect
 *                  contains the point: DOM order approximates paint order, so the last is topmost.
 *  - `ambiguous` — several canvases and none contains the point. Falls back to the first, i.e. the
 *                  OLD behaviour, but now says so instead of reporting a clean hit.
 *
 *  This is reached only AFTER `pickDomTargetAt` declines (#299): a hit-test landing on genuine DOM
 *  UI is dispatched THERE, not routed to a canvas underneath it — a real finger on an overlay does
 *  not reach the canvas either. So `contains`/`ambiguous` now describe a hit on a container or a
 *  layout miss, not an overlay.
 *
 *  Note the marker overlay cannot skew the hit test: `ensureMarkerContainer` sets
 *  `pointer-events:none`, which is also why `pickDomTargetAt` can trust `elementFromPoint` after a
 *  marker has been drawn. */
type CanvasPick = { canvas: HTMLCanvasElement | null; how: 'hit' | 'only' | 'contains' | 'ambiguous' };

function pickCanvasAt(x: number, y: number): CanvasPick {
  const hit = document.elementFromPoint(x, y);
  const hitCanvas = hit instanceof HTMLCanvasElement ? hit : (hit?.closest('canvas') ?? null);
  if (hitCanvas) return { canvas: hitCanvas as HTMLCanvasElement, how: 'hit' };

  const all = Array.from(document.querySelectorAll('canvas'));
  if (all.length === 0) return { canvas: null, how: 'ambiguous' };
  if (all.length === 1) return { canvas: all[0], how: 'only' };

  for (let i = all.length - 1; i >= 0; i--) {
    const r = all[i].getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { canvas: all[i], how: 'contains' };
  }
  return { canvas: all[0], how: 'ambiguous' };
}

// --- Aim resolution (Enact: selector OR screenshot pixels → a CSS viewport point) ---

/** The serializable shape of the `resolve-dom-point` op (engine/app/debug/domResolve). */
interface DomResolution {
  ok: boolean; x?: number; y?: number;
  matched?: string | null; hitTarget?: string | null; occluded?: boolean; error?: string;
}

// `hitTarget` is set ONLY by the selector branch of `resolveAim` — a raw x/y aim never claimed
// anything was under it, so there is nothing for a later re-check to have drifted FROM. `undefined`
// (not resolved by selector) and `null` (selector resolved, but nothing was there) are both real,
// distinct answers; see `aimDriftSuffix` below, which is the sole reader of this field.
type Aim = { x: number; y: number; label: string; hitTarget?: string | null } | { error: string };

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
    return { x: r.x, y: r.y, label: `${selector}→${r.hitTarget}`, hitTarget: r.hitTarget };
  }
  const screenInfo = params.screenInfo as { imgW: number; imgH: number; nativeW: number; nativeH: number } | undefined;
  const { x, y } = screenshotToCSS(params[xKey] as number, params[yKey] as number, screenInfo);
  return { x, y, label: `css(${Math.round(x)},${Math.round(y)})` };
}

/** #486 finding C: `resolveAim`'s selector branch crosses a dynamic import PLUS a round trip through
 *  the shared agent-op registry (`resolve-dom-point`) before it ever returns — real async hops, not
 *  a same-tick lookup. `layoutSettle.ts` exists because that window is not instantaneous: #261
 *  measured 0–1 frames of settle after a dock change, which is exactly long enough for the element
 *  under a resolved point to no longer be the one the resolution named. `handleHover`/`handleScroll`
 *  then dispatch at the OLD coordinates and, without this, would still label the reply with the
 *  PRE-await `hitTarget` — a claim that can go stale in the gap.
 *
 *  `dispatchTapAt` already draws the shape this follows: re-check after the gap, and say plainly
 *  what you can no longer stand behind rather than silently keep the old claim. This is the same
 *  honesty extended to an aim that is USED, not pressed.
 *
 *  Deliberately a WARNING, not a refusal — matching `modoki_dnd`'s documented behavior for a
 *  compromised aim (#260). The event has already been (or is about to be) dispatched at real
 *  coordinates; refusing to report success would discard a gesture that in fact landed. Comparing
 *  against `describeElement` is not optional: it is the SAME function `hitTarget` came from
 *  (`domResolve.ts`), so "did it change" is a like-for-like comparison — `describeEl` in this file
 *  is a different, differently-formatted function, and diffing across the two would report drift
 *  that never happened. */
function aimDriftSuffix(aim: { hitTarget?: string | null }, nowEl: Element | null): string {
  if (aim.hitTarget === undefined) return ''; // a pixel aim claimed nothing, so nothing can have drifted
  const now = describeElement(nowEl);
  if (now === (aim.hitTarget ?? null)) return '';
  return ` — ⚠ the element under this aim CHANGED between resolving it and acting on it: resolved `
    + `${aim.hitTarget}, acted on ${now ?? 'nothing'}. The layout moved in that window; re-aim before `
    + `resting a verdict on this.`;
}

/** Resolve-ONLY twin of `resolveAim`, for the trusted-CDP route (#32 Phase 1): the backend needs a
 *  CSS point to feed `Input.dispatchTouchEvent`/etc, but a page can't dispatch a TRUSTED event to
 *  itself, so injection has to happen host-side — while aim resolution (selector lookup, occlusion
 *  check, screenshot-pixel→CSS conversion) is in-page state only this bridge has. This splits the
 *  two: same `resolveAim` logic, no dispatch. `selKey`/`xKey`/`yKey` default to 'selector'/'x'/'y'
 *  (a plain tap/hover) but the caller can point them at 'fromSelector'/'fromX'/'fromY' or
 *  'toSelector'/'toX'/'toY' for a drag's two ends.
 *
 *  `center:true` replicates the ONE piece of pre-processing `handleScroll` does before calling
 *  `resolveAim` — defaulting to the viewport center when no selector/x/y was given — so a
 *  host-side scroll route gets the same "no aim ⇒ center" behavior without the backend having to
 *  know the device's viewport size (only the page does). This is NOT duplicated aim logic, just
 *  the same default `handleScroll` already applies, generalized to whichever key names the caller
 *  is resolving. */
export async function handleResolveAim(params: Record<string, unknown>): Promise<Aim> {
  const selKey = (params.selKey as string) || 'selector';
  const xKey = (params.xKey as string) || 'x';
  const yKey = (params.yKey as string) || 'y';
  let p = params;
  if (params.center === true) {
    const hasAim = typeof params[selKey] === 'string' && params[selKey]
      || (typeof params[xKey] === 'number' && typeof params[yKey] === 'number');
    if (!hasAim) p = { ...params, [xKey]: window.innerWidth / 2, [yKey]: window.innerHeight / 2 };
  }
  return resolveAim(p, selKey, xKey, yKey);
}

/** The DOM element a synthetic aim should be dispatched ON, or null to fall through to the game
 *  canvas (#299).
 *
 *  THE DEFECT this closes: `dispatchTapAt`/`handlePointer` only recognised `<button>`/`<a>` as DOM
 *  targets and sent everything else at the canvas. An on-screen control built from a `div` — the
 *  engine `UIRenderer`'s output, a game's own touch controls — therefore
 *  received an event whose `target` was the CANVAS, so every `closest(...)`/`e.target` handler
 *  missed while the reply said `ok (canvas:only)`. Measured on the Galaxy A23: a `device_pointer`
 *  down on the d-pad left `CharacterController3D.moveX` at 0, and a `device_tap` on the aim button
 *  never toggled archery. That is the false-success shape this surface exists to refuse.
 *
 *  Dispatching on the element loses nothing the canvas path provided: the events still bubble to
 *  `window`, which is where `pointerSource` (the source-agnostic Input seam a game reads) listens,
 *  and `isPointerBlocked` then suppresses the game read for a registered UI root exactly as it does
 *  for a real finger. What it does NOT reach is a canvas-local listener (Pixi's federated
 *  EventSystem) — which is correct, because a real finger landing on an overlay does not reach it
 *  either.
 *
 *  The guard is deliberately conservative: an element that CONTAINS a canvas (`<body>`, an app root,
 *  a wrapper) is not a UI target — the aim is meant for the surface beneath it, so those keep the
 *  `pickCanvasAt` geometry fallback and its honest `contains`/`ambiguous` labels. jsdom returns
 *  `null` here by default (tests/setup.ts), so every coordinate-aimed test keeps the canvas path. */
function pickDomTargetAt(x: number, y: number): Element | null {
  const el = document.elementFromPoint(x, y);
  // `Element`, NOT `HTMLElement`: an inline `<svg>` icon inside a button is an SVGElement, which is
  // not an HTMLElement — narrowing to HTMLElement sent every icon-button tap back down the canvas
  // path with a clean `ok`, i.e. the #299 defect again, scoped to SVG-rooted UI.
  if (!(el instanceof Element)) return null;
  if (el instanceof HTMLCanvasElement || el.closest('canvas')) return null; // the game surface itself
  if (el === document.body || el === document.documentElement) return null; // never a UI control
  // A container OF the game surface, not UI. Only a VISIBLE canvas counts: a UI panel that happens
  // to hold a hidden utility canvas (an offscreen text-metrics scratch surface is the usual one) is
  // ordinary UI, and treating it as a container would route its whole subtree back to the canvas.
  // `checkVisibility` is Chromium 105+; where it is absent (jsdom) fall back to "any canvas counts",
  // which is the conservative reading.
  const canvases = Array.from(el.querySelectorAll('canvas'));
  if (canvases.some((c) => (typeof c.checkVisibility === 'function' ? c.checkVisibility() : true))) return null;
  return el;
}

/** A short, stable description of a dispatch target for the reply line — the agent has to be able to
 *  tell from the reply WHICH element it actually drove, since that is the fact #299 got wrong.
 *  `data-entity-id` is what the GAME `UIRenderer` emits (the editor's `data-ui-id` handles are not
 *  on this surface — see docs/debug-tools-mcp.md), so it is the handle an agent aims a device
 *  selector at. Nothing here is keyed to a particular game's markup; an element carrying neither
 *  attribute still names its tag. */
function describeEl(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const entity = el.getAttribute('data-entity-id');
  const uiId = el.getAttribute('data-ui-id');
  const attr = entity ? `[data-entity-id="${entity}"]` : uiId ? `[data-ui-id="${uiId}"]` : '';
  return `${el.tagName.toLowerCase()}${id}${attr}`;
}

/** The full event sequence a real finger produces on a DOM element, in order. Pointer events alone
 *  are NOT enough and that gap nearly shipped inside the #299 fix: the engine `UIRenderer` binds
 *  React `onClick`, so a control tapped with only `pointerdown`/`pointerup` still does nothing —
 *  the exact silence the fix exists to end. `mousedown`/`mouseup` come along for handlers written
 *  against mouse events. `click` is dispatched AT the aim point rather than via `el.click()` so it
 *  carries real coordinates and reaches an enclosing `<button>` by bubbling, the way a finger's
 *  does. */
function mouseInit(x: number, y: number): MouseEventInit {
  return { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 };
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

  // DOM UI first: dispatch ON the element under the aim, so `e.target` is what a real finger would
  // have hit (#299). A button/anchor additionally gets a real `click()` — a synthetic pointer pair
  // does not synthesize one, and that is what those elements' handlers listen for.
  const domTarget = pickDomTargetAt(x, y);
  if (domTarget) {
    domTarget.dispatchEvent(new PointerEvent('pointerdown', ptrInit(x, y)));
    domTarget.dispatchEvent(new MouseEvent('mousedown', mouseInit(x, y)));
    await new Promise((r) => setTimeout(r, 50)); // same hold as the canvas path — let Input sample the down edge
    // The element can be GONE by now — a control that unmounts itself on its own press is an
    // ordinary React pattern. `dispatchEvent` on a detached node neither throws nor fails, but the
    // events cannot bubble to React's delegated root listener, so the `click` (what most controls
    // actually listen for) reaches nothing. Saying `ok` alone there would be a false success of
    // exactly the kind this fix exists to remove, so the reply states it instead.
    const detached = !domTarget.isConnected;
    domTarget.dispatchEvent(new PointerEvent('pointerup', ptrInit(x, y)));
    domTarget.dispatchEvent(new MouseEvent('mouseup', mouseInit(x, y)));
    domTarget.dispatchEvent(new MouseEvent('click', mouseInit(x, y)));
    const msg = `ok (dom:${describeEl(domTarget)})`
      + (detached ? ' — the target left the DOM during the press, so only the down half was delivered; the click reached nothing' : '');
    _log(`[debug-bridge] TAP → ${msg} css(${x.toFixed(1)},${y.toFixed(1)})`);
    return msg;
  }

  const { canvas, how } = pickCanvasAt(x, y);
  if (!canvas) return 'Error: No canvas element found';
  canvas.dispatchEvent(new PointerEvent('pointerdown', ptrInit(x, y)));
  await new Promise((r) => setTimeout(r, 50)); // hold ~1–2 frames so per-frame Input sampling sees the down edge
  canvas.dispatchEvent(new PointerEvent('pointerup', ptrInit(x, y)));
  _log(`[debug-bridge] TAP → canvas:${how} css(${x.toFixed(1)},${y.toFixed(1)})`);
  return `ok (canvas:${how}) css(${Math.round(x)},${Math.round(y)})`;
}

/** Release a sustained press before dispatching a NEW gesture, and say so in the reply (#305).
 *
 *  Two presses cannot coexist, and the failure is silent in both directions. `pointerSource`
 *  latches `activeId` on the held down and early-returns for every later `pointerdown` — and
 *  #299's trusted-takeover cannot save this one, because a synthetic tap is not `isTrusted`
 *  either. So the tap's press reaches nothing while the call still answers `ok`: a false success,
 *  the outcome `mcp-tool-conventions.md` §0 ranks worst on this surface. Its `pointerup` then
 *  matches the held `pointerId` and ends the gesture anyway, leaving `heldPointer` and
 *  `pointerSource` disagreeing about whether anything is down.
 *
 *  Called AFTER the aim resolves and BEFORE the dispatch: a call that is refused dispatches
 *  nothing, so it must steal nothing. Mirrors the editor's `MOUSE_GESTURE_ROUTES`, and stops at
 *  the same place — `device_hover`/`device_scroll`/`device_press_key` are all legitimate
 *  mid-gesture and leave the hold alone. */
function supersedeHeldPress(by: string): string {
  const dropped = dropHeldPress('superseded');
  if (!dropped) return '';
  _log(`[debug-bridge] ${by} released a press left held: ${dropped}`);
  return ` — released a pointer left held (${dropped}); a new gesture cannot coexist with it`;
}

/** Drop a held press on behalf of a gesture dispatched from the HOST, not from here (#305).
 *
 *  The trusted route (CDP on Android, WebDriverAgent on iOS) resolves its aim in-page and then
 *  injects the touch host-side, so `handleTap`/`handleDrag` — and the supersede they do for
 *  themselves — are never reached. Measured on an S22: after a trusted `device_tap`, the bridge
 *  still reported `held:true` while `pointerSource` had already handed the gesture to the tap via
 *  #299's takeover. The two then disagree about whether anything is down, so a later `up` sends a
 *  stray `pointerup`, and a later `down` is refused as "already held" when nothing is.
 *
 *  Note the asymmetry with the synthetic path, and that it is not a smaller version of the same
 *  bug: a TRUSTED tap is not swallowed — the takeover admits it — so nothing is lost here. What is
 *  wrong is only the bookkeeping, which is why this is a plain release with no reply suffix of its
 *  own; the host decides what to tell the agent. */
function handleReleaseHeldPointer(): { released: string | null } {
  return { released: dropHeldPress('superseded') };
}

export async function handleTap(params: Record<string, unknown>): Promise<string> {
  const refusal = frameLoopRefusal('tap');
  if (refusal) { _log(`[debug-bridge] TAP → ${refusal}`); return refusal; }
  const aim = await resolveAim(params, 'selector', 'x', 'y');
  if ('error' in aim) { _log(`[debug-bridge] TAP → ${aim.error}`); return aim.error; }
  _log(`[debug-bridge] TAP @ ${aim.label}`);
  const superseded = supersedeHeldPress('TAP');
  return withMechanismSuffix(`${await dispatchTapAt(aim.x, aim.y)} @ ${aim.label}${superseded}`);
}

export async function handleDrag(params: Record<string, unknown>): Promise<string> {
  const refusal = frameLoopRefusal('drag');
  if (refusal) { _log(`[debug-bridge] DRAG → ${refusal}`); return refusal; }
  const fromAim = await resolveAim(params, 'fromSelector', 'fromX', 'fromY');
  if ('error' in fromAim) { _log(`[debug-bridge] DRAG → ${fromAim.error}`); return fromAim.error; }
  const toAim = await resolveAim(params, 'toSelector', 'toX', 'toY');
  if ('error' in toAim) { _log(`[debug-bridge] DRAG → ${toAim.error}`); return toAim.error; }
  const from = { x: fromAim.x, y: fromAim.y };
  const to = { x: toAim.x, y: toAim.y };
  const steps = (params.steps as number) || 5;
  const delayMs = (params.delayMs as number) || 20;
  // Both aims resolved, so this call WILL dispatch — see `supersedeHeldPress` for why it must not
  // dispatch on top of a held press. Before the markers, so the overlay never shows a drag being
  // set up while the old press is still down.
  const superseded = supersedeHeldPress('DRAG');

  _log(`[debug-bridge] DRAG ${fromAim.label}→${toAim.label} → css(${from.x.toFixed(1)},${from.y.toFixed(1)})→(${to.x.toFixed(1)},${to.y.toFixed(1)})`);
  showMarker(from.x, from.y, 'lime', `from(${Math.round(from.x)},${Math.round(from.y)})`);
  showMarker(to.x, to.y, 'cyan', `to(${Math.round(to.x)},${Math.round(to.y)})`);
  showDragLine(from.x, from.y, to.x, to.y);

  // #486 finding C: `fromAim` was resolved before any of the above — re-check what's under `from`
  // right before acting on it, and fold the verdict into BOTH replies below. A drag resolves two
  // aims at two different instants and reports them as one gesture; this covers the one that is
  // actually USED to pick/drive the drag (`from`, via `grabEl`/`pickCanvasAt`). Computed once,
  // independently of `grabEl`'s own selection (which prefers `fromSelector`'s `querySelector` over
  // `elementFromPoint`) — this must always compare against what `elementFromPoint` says NOW, the
  // same kind of read `hitTarget` came from.
  const driftAtFrom = aimDriftSuffix(fromAim, document.elementFromPoint(from.x, from.y));

  // DOM-element-targeted drag: move DOM chrome (a debug widget, slider) by dispatching the pointer
  // sequence ON the grabbed element — the world path below dispatches on the canvas, which never
  // reaches a DOM element's React handlers. Auto-engaged when the grab lands on a non-canvas element
  // (or forced with dom:true); dom:false forces the world path. The `fromSelector` element is
  // preferred over elementFromPoint so the drag lands on the exact handle (e.g. a widget header).
  const explicitDom = params.dom as boolean | undefined;
  const grabEl = (typeof params.fromSelector === 'string' && params.fromSelector
    ? document.querySelector(params.fromSelector)
    : document.elementFromPoint(from.x, from.y)) as HTMLElement | null;
  // `!grabEl.querySelector('canvas')` matches `pickDomTargetAt`'s container rule (#299): an element
  // that CONTAINS the game surface (body, an app root, a wrapper) is not a DOM UI target.
  const domMode = explicitDom === true || (explicitDom !== false && !!grabEl && grabEl.tagName !== 'CANVAS' && !grabEl.closest('canvas') && !grabEl.querySelector('canvas'));
  if (domMode) {
    if (!grabEl) return `Error: no element to drag at ${typeof params.fromSelector === 'string' ? JSON.stringify(params.fromSelector) : `(${Math.round(from.x)},${Math.round(from.y)})`}`;
    return withMechanismSuffix(`${await domDrag(grabEl, from, to, steps, delayMs)}${driftAtFrom}${superseded}`);
  }

  // World-space drag: dispatch a real pointer sequence ON the canvas under the GRAB point so it
  // bubbles to `window` and feeds the source-agnostic pointer source (the sanctioned Input seam a
  // game reads via Input.pointerDrag), and so the canvas's own listeners — Pixi's federated
  // EventSystem, Three's raycast handlers — see the same sequence a real finger would produce.
  // The whole gesture goes to the canvas picked at `from`, not re-picked per step: a real pointer
  // capture stays with the element it grabbed, so a drag that leaves the canvas still delivers its
  // moves and its up there. (#93 — this used to be the FIRST canvas in the document, so a grab on a
  // 2D layer over a 3D one dragged the 3D canvas instead.)
  const { canvas, how } = pickCanvasAt(from.x, from.y);
  if (!canvas) return 'Error: No canvas element found';
  canvas.dispatchEvent(new PointerEvent('pointerdown', ptrInit(from.x, from.y)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    await new Promise((r) => setTimeout(r, delayMs));
    canvas.dispatchEvent(new PointerEvent('pointermove', ptrInit(x, y)));
  }
  canvas.dispatchEvent(new PointerEvent('pointerup', ptrInit(to.x, to.y)));
  _log(`[debug-bridge] DRAG → canvas:${how}`);
  return withMechanismSuffix(`ok (canvas:${how}) css(${Math.round(from.x)},${Math.round(from.y)})→(${Math.round(to.x)},${Math.round(to.y)})${driftAtFrom}${superseded}`);
}

/** ⚠️ SHAPE CHANGE, coordinated with `engine/tools/game-debug-mcp/src/mcp-tools.ts`'s
 *  `device_console_logs` (the only consumer of this bridge method — do not change one without the
 *  other). Used to return the bare array `consoleRing.query()` produces; now wraps it with
 *  `dropped`, for the same reason the editor's `console-logs` agent op does (see its own comment,
 *  `agentBridge.ts`) — the ring is `[pinned] ++ [tail]`, discontiguous once it wraps, and on device
 *  there is no devtools console to notice the gap any other way. */
function handleConsoleLogs(params: Record<string, unknown>): { logs: ReturnType<typeof consoleRing.query>; dropped: number } {
  return {
    logs: consoleRing.query((params.limit as number) || 50, params.level as string | undefined),
    dropped: getConsoleRingDropped(),
  };
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
 *  fallback keeps this handler total rather than a rejection the router would have to translate.
 *
 *  It also reports the HARDWARE the app is running on (#146), because the host cannot otherwise
 *  tell which phone the lease is holding. See `readDeviceHardware` for why those two fields and
 *  not a device id.
 *
 *  Additive on purpose: an older bridge answers without `deviceModel`/`osVersion`, and the host
 *  treats their absence as "unknown", never as a mismatch. */
export async function handleAppIdentity(): Promise<{
  platform: string; appId: string; appName: string; deviceModel?: string; osVersion?: string;
}> {
  const platform = Capacitor.getPlatform();
  const hardware = await readDeviceHardware();
  try {
    const info = await CapacitorApp.getInfo();
    return { platform, appId: info.id, appName: info.name, ...hardware };
  } catch {
    return { platform, appId: '', appName: '', ...hardware };
  }
}

/** The two hardware facts that let the HOST identify which paired iPhone this lease is holding
 *  (#146), so it does not launch a signed WebDriverAgent on someone else's phone.
 *
 *  **Why these two and not a device id.** iOS forbids an app reading the hardware UDID, and
 *  `identifierForVendor` is a per-vendor GUID that appears in no `xcrun` listing — so no id the app
 *  can see is comparable with anything the Mac knows. `model` and `osVersion` are, exactly: the
 *  plugin reads `model` from `hw.machine`, which is byte-identical to devicectl's
 *  `hardwareProperties.productType` (`iPhone18,4`), and `osVersion` matches its `osVersionNumber`.
 *  Two phones can share both, which is why the host REFUSES on an ambiguous match rather than
 *  picking — this narrows the candidates honestly, it does not pretend to be a serial number.
 *
 *  **Read from `capacitor-game-debug`, NOT `@capacitor/device`.** The first version of #146 read
 *  `Capacitor.Plugins.Device`, which looked safe — `deviceCaps.ts` reads the same global — but that
 *  plugin is OPTIONAL and **no Modoki project installs it** (checked across all 22 games + demos:
 *  none has the dependency, none has `CapacitorDevice` in its iOS `Package.swift`). So the probe
 *  returned `{}` on every real device and the host silently fell back to guessing which phone to
 *  launch on — the fix was inert in production while every test passed. `capacitor-game-debug` is
 *  present by construction instead: #146 only matters while a device holds a lease, and holding one
 *  REQUIRES this plugin. Precedent is not evidence; presence is.
 *
 *  Dynamically imported like the rest of this module's plugin use, so the web build does not pull
 *  it into the initial chunk. Total by design — a plugin older than #146 has no such method and
 *  rejects, which lands in the same `{}` as the web stub. */
async function readDeviceHardware(): Promise<{ deviceModel?: string; osVersion?: string }> {
  try {
    const { GameDebug } = await import('capacitor-game-debug');
    const info = await GameDebug.getDeviceHardware();
    return {
      ...(info?.model ? { deviceModel: info.model } : {}),
      ...(info?.osVersion ? { osVersion: info.osVersion } : {}),
    };
  } catch { return {}; }
}

/** Build the `appStateChange` handler that makes THE FOREGROUND APP OWN THE PORT (#95).
 *
 *  Port 9095 is a fixed default shared by every Modoki game, and a backgrounded app kept its
 *  listener alive — so a stale app silently owned the socket and answered for the one you had just
 *  launched (#88), or forced it onto an OS-assigned port nothing on the host could discover (#95).
 *  Releasing on pause makes "at most one Modoki app is listening, and it is the one on screen" an
 *  invariant, which removes the collision at its source instead of teaching the host to chase a
 *  moving port.
 *
 *  Extracted from `initNativeBridge` so it is unit-testable without Capacitor: the behaviour was
 *  verified on hardware, but hardware cannot re-run in CI, and the parts most likely to rot are
 *  exactly the ones a device run makes invisible — that each state maps to the right call, and that
 *  a slow rebind cannot stack with the next state flip. If the pause branch stops calling `stop`,
 *  nothing fails loudly: the port just stays held and the #88 wrong-app hazard quietly returns.
 *
 *  Deliberately accepted: a BACKGROUNDED Android app can no longer be driven. The device tools
 *  drive what is on screen, and on iOS a backgrounded app is suspended and could not answer anyway.
 *  This NARROWS the app-switch race rather than closing it (resume can precede the other app's
 *  pause), so the EADDRINUSE fallback and its loud reporting stay. */
export function createPortLifecycleHandler(deps: {
  start: () => Promise<{ port: number }>;
  stop: () => Promise<{ ok: boolean }>;
  log: (...args: unknown[]) => void;
  /** Where a failure goes, when it is one that leaves the bridge UNREACHABLE. Defaults to `log`,
   *  which is what every existing caller got — but a failed re-bind deserves better than that, see
   *  the catch below. Injected rather than reaching for `console.error` directly so this stays as
   *  testable as the rest of the handler. */
  logError?: (...args: unknown[]) => void;
}): (state: { isActive: boolean }) => void {
  const logError = deps.logError ?? deps.log;
  let busy = false;
  return ({ isActive }) => {
    void (async () => {
      if (busy) return; // a slow rebind must not stack with the next state flip
      busy = true;
      try {
        if (!isActive) {
          await deps.stop();
          deps.log('[debug-bridge] backgrounded — released the port so the next app can bind it (#95)');
        } else {
          // Idempotent natively (startServer early-returns when already running), so a resume with
          // no preceding pause is harmless. Logs the ACTUAL bound port, which is not necessarily
          // the default if something else got there first.
          const r = await deps.start();
          deps.log('[debug-bridge] foregrounded — TCP server listening on port', r.port);
        }
      } catch (e) {
        // Never let debug-bridge plumbing break the app's lifecycle handling — hence swallowing at
        // all. But the two failures are NOT equally serious, and reporting them identically is the
        // #164 mistake in miniature (found sweeping for its pattern, not its symptom):
        //   • a failed STOP restores the old behaviour — the port stays held. Benign, stays at log.
        //   • a failed START means nothing is listening on 9095 after a foreground, so every
        //     device_* tool is unreachable for the rest of the session. That is byte-for-byte the
        //     symptom #164 was filed about, and at log level it is just as unfindable: the app runs
        //     fine, the lease refuses, and the one line explaining it reads like ordinary chatter.
        // The message carries the same greppable tokens as `initDebugBridge`'s, so ONE grep finds
        // this whether the bridge died at boot or on a later resume.
        if (isActive) {
          logError(
            '[debug-bridge] FAILED to re-bind on foreground — the GameDebug TCP server is NOT '
            + 'listening, so every device_* tool is unreachable until the app is backgrounded and '
            + 'brought forward again. Reason:', (e as Error).message,
          );
        } else {
          deps.log('[debug-bridge] appStateChange handling failed:', (e as Error).message);
        }
      } finally {
        busy = false;
      }
    })();
  };
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
let heldPointer: { button: number; x: number; y: number; target: Element; how: HeldHow } | null = null;

/** How the sustained press chose its dispatch target — a `pickCanvasAt` verdict, or `dom` when the
 *  aim landed on a DOM UI element and the press went there instead (#299). */
type HeldHow = CanvasPick['how'] | 'dom';

/** Invalidated by every `releaseHeldPointer` call, i.e. every point at which a held press was
 *  supposed to end. `handlePointer` captures it on entry and re-checks after its awaits, because a
 *  `down` whose lease died WHILE it was resolving its aim would otherwise set `heldPointer` AFTER
 *  the disconnect handler's release had already run and found nothing to release — leaving a press
 *  nothing can ever lift, which is exactly the state these defences exist to make unreachable.
 *  The window is one async hop (`resolveSelectorPoint`'s dynamic import), and the consequence is
 *  the unrecoverable one, so it is worth a token. Invalidating on releases rather than disconnects
 *  keeps the whole mechanism reachable from `releaseHeldPointer` alone — nothing needs a
 *  test-only seam to exercise it. */
const leaseLiveness = createTeardownToken();

/** Release a press left held, by dispatching its matching `pointerup` at the held point (#299).
 *
 *  A sustained press spans calls BY DESIGN, so nothing in `handlePointer` can know a gesture was
 *  abandoned. The one moment we do know is the lease dropping: from then on the agent cannot send
 *  the `up` at all. Leaving it held is not inert — `pointerSource` latches `activeId` on the down
 *  and early-returns for every later pointerdown, so the phone goes DEAF TO THE HUMAN'S FINGER for
 *  dragging until the app is force-stopped. That is what happened on the A23 while the owner was
 *  playing, and it read as a product bug in the feature under test.
 *
 *  Returns a description of what it released, or null if nothing was held. */
export function releaseHeldPointer(): string | null {
  leaseLiveness.invalidateAll(); // invalidated even with nothing held — `handlePointer` must notice that case too
  return dropHeldPress('lease');
}

/** Why a held press ended without the agent's own `action:'up'`. Quoted back to the agent, because
 *  both causes are otherwise invisible: the press simply stops existing. */
type HeldLossReason = 'lease' | 'superseded';

/** The last press that ended without an `up`, cleared by the next `down`. A `move`/`up` that
 *  follows one is refused, and the bare "no pointer is held" would be a lie by omission there —
 *  the agent DID press, and something else ended it. */
let lastHeldLoss: { reason: HeldLossReason; button: number; x: number; y: number } | null = null;

/** Explain a refusal that is really "your press was ended for you". Empty when the agent simply
 *  never pressed — the two are different mistakes and must not read alike. */
function heldLossNote(): string {
  if (!lastHeldLoss) return '';
  const { reason, button, x, y } = lastHeldLoss;
  const why = reason === 'lease'
    ? 'the debugger lease dropped, and from that moment you could no longer send the up yourself'
    : 'a later device_tap/device_drag dispatched a new gesture, which cannot coexist with a held '
      + 'press, so the hold was released first';
  return ` NOTE: your ${POINTER_BUTTON_NAME[button]} press at ${x.toFixed(1)},${y.toFixed(1)} was `
    + `released for you — ${why}. Send a fresh down.`;
}

/** The DISPATCH half of a release, without invalidating `leaseLiveness`.
 *
 *  The split keeps `leaseLiveness` meaning exactly one thing: "a release happened because the
 *  agent can no longer send the `up`". `handlePointer` re-checks it after its awaits to catch a
 *  `down` whose lease died mid-resolve, and self-releases the press it just latched. A SUPERSEDE
 *  is not that — the lease is alive and the agent is actively driving — so routing it through the
 *  exported `releaseHeldPointer` (which invalidates even with nothing held, deliberately) would
 *  overload the signal.
 *
 *  ⚠️ The concrete consequence is NOT demonstrated, and this comment is deliberately weaker than
 *  its first draft. A `down` that entered before such an invalidation and latched after it would
 *  read it as stale and cancel itself — a stranded-gesture shape invented by the fix for the old one.
 *  The transport makes that reachable in principle: the `message` listener is async with no queue,
 *  so two requests genuinely interleave. But a single agent drives the lease sequentially, and no
 *  test here pins it — every attempt raced the wrong way, because `handleTap`'s own 50 ms hold
 *  lets the `down` latch first. Treat the split as preserving a signal's meaning, which is
 *  checkable by reading, rather than as a guard against a failure anyone has measured. */
function dropHeldPress(reason: HeldLossReason): string | null {
  if (!heldPointer) return null;
  const { target, button, x, y, how } = heldPointer;
  lastHeldLoss = { reason, button, x, y };
  heldPointer = null; // cleared FIRST — a throwing dispatch must not leave the press held anyway
  try {
    target.dispatchEvent(mkButtonedPointerEvent('pointerup', x, y, button));
    // Mirror the mouse modality exactly as the live `up` path does — otherwise a handler that
    // tracks the press via `mousedown`/`mouseup` sees the press begin and never end, which is the
    // stranded-press shape this function exists to prevent, one modality over.
    if (how === 'dom') target.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true, cancelable: true, button, buttons: 0 }));
  } catch { /* the target may be detached by now; the point is to clear our own held state */ }
  const where = how === 'dom' ? `dom:${describeEl(target)}` : `canvas:${how}`;
  return `${POINTER_BUTTON_NAME[button]} at ${x.toFixed(1)},${y.toFixed(1)} on ${where}`;
}

/** Test-only reset — a held gesture left by one test would otherwise leak into the next
 *  (module state persists for the life of the imported module, and vitest does not re-import
 *  per test). Not called by production code. */
export function _resetHeldPointerForTests(): void { heldPointer = null; }

const POINTER_BUTTON_CODE: Record<string, number> = { left: 0, middle: 1, right: 2 };
const POINTER_BUTTON_NAME = ['left', 'middle', 'right'];

/** A pointer event carrying a real button/buttons state (unlike the atomic tap's `ptrInit`, which
 *  is hardcoded to button 0). `buttons` is the CURRENTLY-held mask — 0 on
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
  // `frameLoopRefusal` exists to stop an ACQUIRE from reporting success into a dead loop — it must
  // not also block the RELEASE half of an already-held gesture. Refusing 'up' here strands the
  // press down forever (down landed while healthy, the loop then stalled, up gets refused), which
  // is exactly the state-leaking failure this guard's own error text warns against — just on the
  // other end of the gesture. `deviceCdp.ts`'s `releaseHeldBeforeTrustedGesture` treats "a failure
  // after one landed leaves a finger DOWN" as the hazard to avoid, not to cause (#682 close-out
  // round 3, MEDIUM 3 — round 1's defect in a new hat: a guard meant for the acquire half applied
  // to both).
  if (action !== 'up') {
    const refusal = frameLoopRefusal('pointer');
    if (refusal) return refusal;
  }
  const stillLive = leaseLiveness.capture();
  if (action !== 'down' && action !== 'move' && action !== 'up') {
    return `Error: pointer action must be 'down', 'move', or 'up' (got ${JSON.stringify(action)})`;
  }
  if (action === 'down' && heldPointer) {
    return `Error: a pointer is already held (button ${POINTER_BUTTON_NAME[heldPointer.button]} down at ${heldPointer.x.toFixed(1)},${heldPointer.y.toFixed(1)}). Release it with action:'up' before pressing again.`;
  }
  if ((action === 'move' || action === 'up') && !heldPointer) {
    return `Error: no pointer is held — send action:'down' first (this ${action} would be a stray event).${heldLossNote()}`;
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

  // The canvas is picked ONCE, at `down`, and reused for every move/up of that gesture (#93).
  // Re-picking per call would let a drag that crosses onto another canvas switch mid-gesture and
  // deliver its `up` to an element that never saw the `down` — the same pointer-capture break the
  // held button and held position already exist to avoid.
  let target: Element;
  let how: HeldHow;
  if (action === 'down') {
    // DOM UI under the aim wins, for the reason in `pickDomTargetAt` (#299): a press sent at the
    // canvas arrives with the wrong `e.target` and no DOM handler ever sees it.
    const domTarget = pickDomTargetAt(aim.x, aim.y);
    if (domTarget) {
      target = domTarget;
      how = 'dom';
    } else {
      const picked = pickCanvasAt(aim.x, aim.y);
      if (!picked.canvas) return 'Error: No canvas element found';
      target = picked.canvas;
      how = picked.how;
    }
  } else {
    target = heldPointer!.target;
    how = heldPointer!.how;
  }

  const type = action === 'down' ? 'pointerdown' : action === 'move' ? 'pointermove' : 'pointerup';
  target.dispatchEvent(mkButtonedPointerEvent(type, aim.x, aim.y, button));
  if (how === 'dom') {
    // Mirror the mouse modality for handlers written against it. Deliberately NO synthetic `click`
    // on `up`: a sustained gesture is often a drag, and a finger that travelled does not produce
    // one. Use `device_tap` when a click is what you mean.
    const mouseType = action === 'down' ? 'mousedown' : action === 'move' ? 'mousemove' : 'mouseup';
    target.dispatchEvent(new MouseEvent(mouseType, { ...mouseInit(aim.x, aim.y), button, buttons: action === 'up' ? 0 : (1 << button) }));
  }
  showMarker(aim.x, aim.y, action === 'down' ? 'orange' : action === 'move' ? 'yellow' : 'purple', `pointer${action}(${Math.round(aim.x)},${Math.round(aim.y)})`);
  if (action === 'down') lastHeldLoss = null; // a fresh press — the previous gesture's fate is no longer the story
  heldPointer = action === 'up' ? null : { button, x: aim.x, y: aim.y, target, how };
  await new Promise((r) => setTimeout(r, 16)); // let per-frame Input sampling see the edge, same as tap/drag

  const where = how === 'dom' ? `dom:${describeEl(target)}` : `canvas:${how}`;
  // The lease died while this call was resolving its aim, so the disconnect handler's release ran
  // before there was anything to release. Release it here instead of returning a held press nobody
  // can ever lift.
  if (heldPointer && !stillLive()) {
    releaseHeldPointer();
    _log(`[debug-bridge] POINTER ${action} → ${where}, then released: the lease dropped mid-call`);
    return withMechanismSuffix(`ok (${action} ${where}, button ${buttonName}, held:false) @ ${aim.label} — the lease dropped during this call, so the press was released rather than left held`);
  }
  _log(`[debug-bridge] POINTER ${action} → ${where} @ ${aim.label}`);
  return withMechanismSuffix(`ok (${action} ${where}, button ${buttonName}, held:${heldPointer !== null}) @ ${aim.label}`);
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
  // Object-shaped twin of the string handlers' refusal above — see `frameLoopRefusal`.
  const refusal = frameLoopRefusal('type-text');
  if (refusal) return { ok: false, typed: 0, activeElement: null, error: refusal };
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
  const refusal = frameLoopRefusal('press-key');
  if (refusal) return refusal;
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
  const refusal = frameLoopRefusal('hover');
  if (refusal) return refusal;
  const aim = await resolveAim(params, 'selector', 'x', 'y');
  if ('error' in aim) return aim.error;
  const el = document.elementFromPoint(aim.x, aim.y);
  if (!el) return `Error: no element at (${Math.round(aim.x)},${Math.round(aim.y)}) to hover`;
  const base = { clientX: aim.x, clientY: aim.y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' as const };
  el.dispatchEvent(new PointerEvent('pointerover', base));
  el.dispatchEvent(new PointerEvent('pointerenter', { ...base, bubbles: false }));
  el.dispatchEvent(new PointerEvent('pointermove', base));
  el.dispatchEvent(new MouseEvent('mousemove', { clientX: aim.x, clientY: aim.y, bubbles: true, cancelable: true }));
  return withMechanismSuffix(`ok (hover ${el.tagName.toLowerCase()}) @ ${aim.label}${aimDriftSuffix(aim, el)}`);
}

/** Scroll: dispatch a wheel event at the resolved point (defaults to viewport center). */
export async function handleScroll(params: Record<string, unknown>): Promise<string> {
  const refusal = frameLoopRefusal('scroll');
  if (refusal) return refusal;
  const hasAim = typeof params.selector === 'string' || (typeof params.x === 'number' && typeof params.y === 'number');
  const p = hasAim ? params : { ...params, x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const aim = await resolveAim(p, 'selector', 'x', 'y');
  if ('error' in aim) return aim.error;
  const hit = document.elementFromPoint(aim.x, aim.y);
  const el = hit ?? document.scrollingElement ?? document.body;
  const dx = (params.dx as number) ?? 0;
  const dy = (params.dy as number) ?? 0;
  el.dispatchEvent(new WheelEvent('wheel', { clientX: aim.x, clientY: aim.y, deltaX: dx, deltaY: dy, bubbles: true, cancelable: true }));
  // `hit` is passed even when NULL, deliberately. For a SELECTOR aim a null hit is the loudest
  // drift there is — the resolution named an element, nothing is under that point any more, and
  // the wheel just went to the scrollingElement/body fallback instead: precisely the false claim
  // this suffix exists to stop (`@ selector→X` on an event X never saw). `aimDriftSuffix` already
  // returns '' for a pixel aim, and returns '' when the resolution ALSO found nothing there, so
  // passing the fallback element instead would be the only way to manufacture a wrong answer here.
  return withMechanismSuffix(`ok (scroll dx=${dx} dy=${dy}) @ ${aim.label}${aimDriftSuffix(aim, hit)}`);
}

// --- Message Router ---

async function handleMessage(req: Request): Promise<unknown> {
  const p = req.params ?? {};
  switch (req.method) {
    case 'eval': return handleEval(p);
    // 'screenshot' is intercepted natively in initNativeBridge (GameDebug.captureScreen) before it
    // reaches here; the old in-page canvas-extract path was dead and has been removed (D4).
    // Resolve-only twin of the dispatch ops below (#32 Phase 1) — used by the backend's
    // trusted-CDP route, which resolves the aim in-page then dispatches host-side.
    case 'resolve-aim': return await handleResolveAim(p);
    // Release-only twin of the supersede `handleTap`/`handleDrag` do for themselves — for the
    // TRUSTED route, which resolves the aim in-page and then dispatches host-side over CDP/WDA,
    // so it never reaches those handlers at all. See `handleReleaseHeldPointer` (#305).
    case 'release-held-pointer': return handleReleaseHeldPointer();
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
    // handleMessage never runs → the chunk never loads). See docs/debug-tools-mcp.md.
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
    _log('[debug-bridge] Native TCP server listening on port', result.port);
    // A fallback port is a SILENT unreachability, so it is warned rather than logged (#283). The
    // start SUCCEEDED — nothing throws, nothing looks wrong — but every device_* tool connects on
    // the default port and this app is not on it, for the rest of its life. `_log` would not do:
    // the console ring keeps warn/error, so a log-level line is invisible to `device_console_logs`
    // and the one trace left is a single logcat line nobody greps for. The measured case is
    // launching a game while another Modoki app is still releasing 9095 (#283).
    if (result.fallbackPort) {
      console.warn(
        `[debug-bridge] listening on FALLBACK port ${result.port}, not the default 9095 — another `
        + 'Modoki app still held it. Every device_* tool assumes 9095, so connect with '
        + `device_connect {useAdb:true, port:${result.port}}, or close the other app and relaunch.`,
      );
    }
  } catch (e) {
    _err('[debug-bridge] GameDebug.startServer failed:', (e as Error).message);
    throw e;
  }

  // THE FOREGROUND APP OWNS THE PORT (#95). Port 9095 is a fixed default shared by every Modoki
  // game, and a backgrounded app keeps its listener alive — so a stale app silently owned the
  // socket and answered for the one you had just launched (#88), or forced it onto an
  // OS-assigned port the host had no way to discover. Releasing on pause makes "at most one
  // Modoki app is listening, and it is the one on screen" an INVARIANT, which removes the
  // collision at its source rather than teaching the host to chase a moving port.
  //
  // Cost, accepted deliberately: a BACKGROUNDED Android app can no longer be driven. The device
  // tools drive what is on screen, and on iOS a backgrounded app is suspended and could not
  // answer anyway, so this only gives up something Android alone ever had.
  //
  // This narrows the race, it does NOT close it: two apps switching can interleave resume-before-
  // pause, so the EADDRINUSE fallback and its loud reporting stay exactly as they are.
  void CapacitorApp.addListener('appStateChange', createPortLifecycleHandler({
    start: () => GameDebug.startServer(),
    stop: () => GameDebug.stopServer(),
    log: _log,
    logError: _err,
  }));

  GameDebug.addListener('request', async (data) => {
    const id = data.id;
    const method = data.method;
    const params = typeof data.params === 'string' ? JSON.parse(data.params) : data.params;

    try {
      // iOS screenshot: native capture via drawHierarchy (captures WebGL on iOS)
      // Android screenshots are handled by adb screencap in the MCP server
      if (method === 'screenshot') {
        const stillLatest = screenshotEpoch.begin();
        const result = await GameDebug.captureScreen();
        // Superseded by a retried/newer screenshot request that already resolved — do not let this
        // stale capture overwrite the newer one's `lastScreenInfo`. This request's OWN response
        // still goes out below regardless; only the shared coordinate-mapping state is guarded.
        if (stillLatest()) {
          lastScreenInfo = {
            imageWidth: result.imageWidth,
            imageHeight: result.imageHeight,
            screenWidth: result.screenWidth,
            screenHeight: result.screenHeight,
          };
        }
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
        // #648: this used to be `const { logs } = await …` — which DROPPED the declared `error`
        // field entirely. `getNativeLogs` returns `Promise<{logs: string[]; error?: string}>`
        // (capacitor-game-debug/src/definitions.ts), so a native failure answering
        // `{logs: [], error: 'OSLogStore denied'}` reached the agent as an empty log list:
        // "could not look" collapsed into "nothing is there", which are opposite findings and
        // lead to opposite next moves.
        //
        // ⚠️ The TS type is NOT a guarantee here. The value crosses the Capacitor bridge from
        // Swift/Kotlin in the INSTALLED BINARY, while this JS is rebuilt and OTA'd independently
        // — the same producer/consumer version skew that made #644 happen. So decode, don't trust.
        const raw = await GameDebug.getNativeLogs({
          limit: params?.limit ?? 50,
          seconds: params?.seconds ?? 60,
          filter: params?.filter,
          subsystem: params?.subsystem,
        }) as unknown;
        // A native side answering a BARE ARRAY (an older binary) is still a valid answer.
        const asObj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as { logs?: unknown; error?: unknown } : null;
        const logs = Array.isArray(raw) ? raw as string[]
          : Array.isArray(asObj?.logs) ? asObj.logs as string[]
            : null;
        const nativeError = typeof asObj?.error === 'string' && asObj.error ? asObj.error : null;
        if (logs === null) {
          // No readable `logs` at all. Report it as a failure rather than as an empty list —
          // `safeStringify(undefined)` used to return undefined here (despite its `: string`
          // type), shipping a RESULT-LESS reply that the MCP could not distinguish from silence.
          await GameDebug.sendResponse({
            id,
            error: nativeError
              ?? `getNativeLogs returned a shape this build cannot read: ${describeShape(raw)}. `
                + 'The native plugin in the installed binary may predate this JS bundle.',
          });
          return;
        }
        // `{logs, error}` ONLY when there is something extra to say. The happy path stays a bare
        // array so an older game-debug MCP keeps reading it unchanged (the consumer tolerates
        // both — see parseNativeLogsReply in game-debug-mcp/src/reply.ts).
        await GameDebug.sendResponse({ id, result: safeStringify(nativeError ? { logs, error: nativeError } : logs) });
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
      // Never leave a press the agent can no longer release (#299) — see `releaseHeldPointer`.
      const released = releaseHeldPointer(); // invalidates `leaseLiveness` — see there
      if (released) _log(`[debug-bridge] released a pointer left held by the dropped lease: ${released}`);
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

  // `main.tsx`'s eager `./installDeviceConsoleCapture` side-effect import already calls this on
  // every build that reaches here (#591) — this call stays anyway so `initDebugBridge` does not
  // DEPEND on that having fired. `installDeviceConsoleCapture()` is idempotent, so the two never
  // double-wrap.
  installDeviceConsoleCapture();

  if (Capacitor.isNativePlatform()) {
    _log('[debug-bridge] Initializing native bridge');
    initNativeBridge().catch((e) => {
      // LOUD, and self-explaining (#164). This used to be a `console.log` reading "Native bridge
      // init failed", which is the worst possible shape for the failure it reports: the app runs
      // fine, nothing listens on 9095, and the ONE line explaining why is (a) at log level, where a
      // device log is pure chatter, and (b) worded so that neither `GameDebug` nor `TCP server
      // listening` — the two things anyone actually greps for — matches it. A session lost an hour
      // concluding the branch had never run, while this line was sitting in logcat all along.
      //
      // So: error level, both greppable tokens in the text, and the two flags NAMED. There are two
      // independent answers to "is this a debug build" and only one of them is the JS define —
      // `__MODOKI_DEBUG_BUILD__` gates whether this code runs at all, while the native plugin gates
      // `startServer` on the AndroidManifest meta-data / Info.plist that `healNativeConfig` writes
      // from the same `build.debugBuild` (#112). A project scaffolded without a heal has the first
      // and not the second, and every symptom points at the first.
      _err(
        '[debug-bridge] FAILED to start — the GameDebug TCP server is NOT listening, so every '
        + 'device_* tool is unreachable for this app. Reason:', (e as Error).message,
        '\n  If that says the debug bridge is disabled, or the plugin is not implemented: the JS '
        + 'side is on (this ran) but the NATIVE gate is off. Reopen the project in the editor, or '
        + 'run healNativeConfig(projectRoot), to sync build.debugBuild into the native project — '
        + 'then rebuild.',
      );
    });
  } else {
    _log('[debug-bridge] Web mode — use Chrome with --remote-debugging-port=9222 for MCP debugging');
  }
}
