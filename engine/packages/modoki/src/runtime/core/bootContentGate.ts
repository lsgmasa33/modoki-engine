/** "Every 2D surface and every visible UI image the boot just put on screen has actually ARRIVED"
 *  (#1928) — the 2D/UI twin of `scenePaintSignal` (#334).
 *
 *  WHY THIS EXISTS. `GameShell` (`engine/app/App.tsx`) takes the boot splash down on its "fully
 *  booted" signal. #334 made that signal wait for the 3D renderer's first real submit, but gated
 *  the wait on the project HAVING a 3D surface — so on a 2D/UI-only project (`disable3D`, e.g.
 *  `games/slime-shooter`, `games/audio-demo`) the reveal waited for nothing but two
 *  `requestAnimationFrame`s past the swap. Measured on an iPad mini 5 cold-launching slime-shooter:
 *  the splash came down at 798 ms, the Pixi board's `Application.init` only STARTED at 882 ms and
 *  its first frame drew at 1326 ms, and the backdrop image was still decoding — so the player saw
 *  the bare `body` (near-black navy) and, in dark mode, the WKWebView's black `systemBackground`,
 *  then the art popped in. A first launch after install added a further 1.1 s main-thread stall
 *  on top, all of it after the reveal.
 *
 *  THE SHAPE. A pending SET, not #334's one bit, because the boot does not know up front how many
 *  things it is waiting for — that is decided by what the UI tree renders:
 *   - `armBootContent()` — `GameShell` opens the window at the start of a boot.
 *   - `trackBootContent(label)` — a surface that is about to put content on screen registers while
 *     the window is open and gets back a `done` callback (`null` when nothing is armed, so the
 *     editor — which never arms — pays nothing). Today's four producers (the list, and why each
 *     exists, is docs/rendering.md § "…and so do the 2D and UI surfaces (#1928)"):
 *       · `Canvas2DMount`: done on the slot's next SUCCESSFUL render (`whenNextRendered`), or the
 *         moment it can never render (init failed, a 0×0 box, unmounted).
 *       · `BootContentHold`: the lazy `Canvas2DMount`'s Suspense fallback, while its chunk loads.
 *       · `BootImageProbe` (UINode): done when the image's `decode()` settles, either way.
 *       · `loadPixiTexture` / `loadMtsdfAtlasTexture`: a 2D texture miss, until it lands or fails.
 *   - `waitForBootContent()` — `GameShell` awaits the set emptying, bounded by a ceiling.
 *
 *  ⚠️ EVERY PRODUCER MUST CALL `done` ON ITS FAILURE PATHS TOO. A token nobody settles holds every
 *  boot to the full ceiling — the gate never blocks forever, but 5 s of splash on each launch is a
 *  regression worse than the bug. `done` is idempotent, so calling it from both a success path and
 *  a cleanup is the intended pattern, not a hazard.
 *
 *  It does not make anything faster: the work still takes as long, it now happens under the splash
 *  instead of over a dark page (time-to-content unchanged — #334 measured the same for 3D).
 */

import { rawNow } from './clock';
import { recordBootSpan } from './bootTimeline';
import { createSupersessionToken } from './liveness';
import { notifyListeners } from './notifyListeners';

/** Ceiling on the wait — the same 5 s as `SCENE_PAINT_MAX_WAIT_MS`, for the same reason: a surface
 *  that never arrives (a GPU init that hangs, an image that never settles) must delay the reveal,
 *  never prevent it. A structural bound, not a feel knob. */
export const BOOT_CONTENT_MAX_WAIT_MS = 5000;

export type BootContentOutcome =
  /** Everything that registered has arrived. */
  | 'ready'
  /** Nothing was pending when the wait began — nothing to wait for. */
  | 'idle'
  /** The caller aborted, or the window was closed under the waiter. */
  | 'cancelled'
  /** `BOOT_CONTENT_MAX_WAIT_MS` elapsed; `pending` names what had not arrived. */
  | 'timeout';

export interface BootContentResult {
  outcome: BootContentOutcome;
  /** Labels still pending when the wait ended — non-empty only on `'timeout'`/`'cancelled'`. */
  pending: string[];
}

interface Token { label: string; startedAt: number }

/** One attempt per armed window, so a `disarm` from an OLDER window is inert. */
const windows = createSupersessionToken();
let armed = false;
const pending = new Set<Token>();
let waiters = new Set<(r: BootContentResult) => void>();

function pendingLabels(): string[] {
  return [...pending].map(t => t.label);
}

function settle(outcome: BootContentOutcome): void {
  if (waiters.size === 0) return;
  const result: BootContentResult = { outcome, pending: outcome === 'ready' ? [] : pendingLabels() };
  // Swap the set out BEFORE resolving, so a waiter's own detach cannot mutate it mid-iteration.
  const list = waiters;
  waiters = new Set();
  notifyListeners(list, 'bootContentGate', [result]);
}

/** The set is empty only if it is STILL empty once the current synchronous work is done. A
 *  producer that hands off to another in one React commit — `BootContentHold`, the lazy
 *  `Canvas2DMount`'s Suspense fallback, unmounts in the same effect flush that mounts the real
 *  `Canvas2DMount` — releases its token a moment before the successor registers. Deciding on the
 *  spot would call that gap "everything arrived" and reveal before the board drew. */
function settleIfEmpty(): void {
  if (pending.size === 0) settle('ready');
}

/** Open the window: from now until the returned `disarm`, surfaces that put content on screen
 *  register with `trackBootContent`. Any earlier window is closed first. The returned function is
 *  idempotent and only closes THIS window — a game change's cleanup running after the next boot
 *  armed cannot close the newer one. */
export function armBootContent(): () => void {
  closeWindow();
  armed = true;
  const stillMine = windows.begin();
  return () => { if (stillMine()) closeWindow(); };
}

function closeWindow(): void {
  armed = false;
  settle('cancelled');
  pending.clear();
}

/** Register a piece of content that is on its way to the screen. Returns its `done` callback, or
 *  `null` when no boot is armed. `done` is idempotent, and a no-op once the window has closed. */
export function trackBootContent(label: string): (() => void) | null {
  if (!armed) return null;
  const token: Token = { label, startedAt: rawNow() };
  pending.add(token);
  return () => {
    // Idempotent by construction: the token is in the set at most once, and a closed window
    // CLEARED the set, so a `done` from an earlier boot finds nothing to delete.
    if (!pending.delete(token)) return;
    // A span per item, so `profiler {action:'boot'}` shows what the reveal waited on, per device.
    recordBootSpan('boot-content', token.startedAt, rawNow(), label);
    if (pending.size === 0) queueMicrotask(settleIfEmpty);
  };
}

/** Resolve once nothing registered is still pending. Resolves IMMEDIATELY (`'idle'`) when the set
 *  is already empty — including the fast case where everything arrived while the caller was busy.
 *  Content that registers WHILE this waits is waited for too: the set has to be empty, not merely
 *  the items that existed when the wait began. */
export function waitForBootContent(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<BootContentResult> {
  if (pending.size === 0) return Promise.resolve({ outcome: 'idle', pending: [] });
  const signal = opts?.signal;
  if (signal?.aborted) return Promise.resolve({ outcome: 'cancelled', pending: pendingLabels() });
  return new Promise<BootContentResult>((resolve) => {
    const finish = (r: BootContentResult) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const leave = (outcome: BootContentOutcome) => {
      waiters.delete(finish);
      finish({ outcome, pending: pendingLabels() });
    };
    const onAbort = () => leave('cancelled');
    const timer = setTimeout(() => leave('timeout'), opts?.timeoutMs ?? BOOT_CONTENT_MAX_WAIT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    waiters.add(finish);
  });
}

/** Labels currently pending — diagnostics and tests. */
export function pendingBootContent(): string[] {
  return pendingLabels();
}

/** Test-only reset: closes any window, releasing parked waiters as `'cancelled'`. */
export function resetBootContentGate(): void {
  closeWindow();
}
