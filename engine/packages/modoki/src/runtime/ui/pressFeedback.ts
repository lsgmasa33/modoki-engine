/** pressFeedback — a UI button grows while it is held (#2011).
 *
 *  ## What it does
 *
 *  `UINode.tsx` stamps `data-press-scale` (and `data-press-ms`) on every element with a `click`
 *  binding whose resolved press scale is not 1. While the primary pointer is held on one, this
 *  module writes the CSS `scale` property on it (plus a compensating `translate`, below); on
 *  release or cancel it clears both. A CSS `transition` does the easing in both directions, so no
 *  tween runs in JS.
 *
 *  ## Which element is pressed — the press's OWN target, never an ancestor of it
 *
 *  The element that grows is the one that will take the click: the press target's nearest
 *  `[data-press-origin]` (`pressOrigin.ts`'s "interactive" marker), and only if THAT element is
 *  stamped. Walking straight to the nearest `[data-press-scale]` instead was wrong (review): a
 *  press on a slider, a toggle or a `swallowClicks` dialog body walked PAST the control that
 *  takes it, up to the dismiss scrim behind the dialog, and the whole Settings dialog grew for
 *  the length of a volume drag.
 *
 *  A press on a tap-zone expander that `pressOrigin.ts` will hand to a neighbour (#977) grows the
 *  NEIGHBOUR, through the same `resolveTapZoneVeto` — otherwise one button grows and another fires.
 *
 *  ## A backdrop is never a button
 *
 *  A pressable that covers half the UI root or more is a backdrop — a dismiss-on-tap scrim or a
 *  full-screen tap catcher — and is skipped. Its own edges are off screen, so scaling it shows
 *  only its CHILDREN growing: the dialog it holds. This is a rule rather than a per-entity
 *  opt-out because every game has these (22 outside Court when this landed) and the feature is
 *  on by default; an opt-out each game must remember is one most will not.
 *
 *  ## Why the press needs a compensating `translate`
 *
 *  The CSS `scale` property is applied OUTSIDE `transform`, about `transform-origin` measured on
 *  the untransformed layout box. An anchored element's `transform` carries its pivot offset
 *  (`translate(-px%, -py%)`, `anchorCss.ts`), so a bare `scale` grows it about a point off its
 *  visible centre and the button DRIFTS toward a corner (review, measured: a centred pivot moved
 *  the centre (-8, -4) px on a 200x100 box at 1.08). `pressTranslate` computes the exact
 *  correction from the resolved `transform` matrix, so the visible centre stays put for any
 *  pivot, rotation or `UIElement.scale`. The `translate` property is applied outside `scale`, so
 *  it adds without being scaled.
 *
 *  ## Why the DOM is written directly
 *
 *  Same reasoning as `input/touchControlSource.ts`'s held highlight: rebuilding the UI tree on
 *  every press and release would be a frame's work for a visual, and writing `UIElement.scale`
 *  would put a transient press into the scene, where a save could persist it. React leaves an
 *  inline property it never set alone, so neither re-render nor reconcile clears these.
 *
 *  Only the primary pointer's primary button counts, for the reason `pressOrigin.ts` gives: a
 *  second finger landing must not move the press, and a right-click is not a press. A
 *  `pointercancel` releases too, because a touch that turns into a scroll is cancelled mid-press
 *  and no `pointerup` ever follows. (So a button inside a scroll view starts to grow and settles
 *  back when the scroll takes over — a known flicker; iOS delays its own highlight for that.)
 */
import { UI_PRESS_ORIGIN_ATTR, UI_TAP_ZONE_ATTR, resolveTapZoneVeto } from './pressOrigin';

/** The resolved press scale for this element, stamped by `UINode.tsx`. */
export const UI_PRESS_SCALE_ATTR = 'data-press-scale';
/** The resolved press duration (ms), stamped beside it. */
export const UI_PRESS_MS_ATTR = 'data-press-ms';
const ORIGIN_SEL = `[${UI_PRESS_ORIGIN_ATTR}]`;
const TAP_ZONE_SEL = `[${UI_TAP_ZONE_ATTR}]`;

/** A pressable covering at least this fraction of the UI root's AREA is a backdrop.
 *
 *  Area, not "both axes near 100%": a catcher in flex flow under a top bar is a backdrop too, and
 *  is not full height — Court's `HintCatcher` measured 383x324 in a 383x389 root (83%), and its
 *  flyout scrims sit in the same parent. No button covers half the screen. */
const BACKDROP_AREA = 0.5;

/** A button's effective press, or `null` when it gets none.
 *
 *  `actionScale` is the button's own `UIAction.pressScale`: `0`, absent or negative inherits the
 *  scene's `UISettings.pressScale` (absent is the common case — an AoS trait loaded with params
 *  never runs its factory, so a scene-loaded `UIAction` carries no `pressScale` at all, and the
 *  Inspector shows that as 0). `sceneScale`/`sceneMs` are `UISettings`' values, already defaulted
 *  by the caller when the scene has no `UISettings` entity. A scale of exactly 1 is "off", and so
 *  is a non-finite or non-positive scene scale. */
export function resolvePress(
  actionScale: number | undefined, sceneScale: number, sceneMs: number,
): { scale: number; ms: number } | null {
  const scale = typeof actionScale === 'number' && actionScale > 0 ? actionScale : sceneScale;
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) return null;
  const ms = Number.isFinite(sceneMs) && sceneMs > 0 ? sceneMs : 0;
  return { scale, ms };
}

/** The `translate` (local px) that keeps an element's VISIBLE centre fixed while the `scale`
 *  property grows it by `s`.
 *
 *  `m` is the resolved `transform` as a 2D matrix `[a, b, c, d, e, f]` (identity when `none`),
 *  `originX/Y` the resolved `transform-origin` in px, `w/h` the untransformed layout box. The box
 *  centre maps to `v = M·(centre - origin)` relative to the origin; the `scale` property sends
 *  that to `s·v`, so the correction is `(1 - s)·v`. */
export function pressTranslate(
  m: readonly number[], originX: number, originY: number, w: number, h: number, s: number,
): { x: number; y: number } {
  const [a, b, c, d, e, f] = m;
  const dx = w / 2 - originX;
  const dy = h / 2 - originY;
  const vx = a * dx + c * dy + e;
  const vy = b * dx + d * dy + f;
  return { x: (1 - s) * vx, y: (1 - s) * vy };
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** `getComputedStyle(...).transform` → `[a, b, c, d, e, f]`. A 3D `matrix3d` keeps its 2D part. */
export function parseCssMatrix(t: string): number[] {
  const m2 = /^matrix\(([^)]+)\)$/.exec(t);
  if (m2) {
    const v = m2[1].split(',').map(Number);
    if (v.length === 6 && v.every(Number.isFinite)) return v;
  }
  const m3 = /^matrix3d\(([^)]+)\)$/.exec(t);
  if (m3) {
    const v = m3[1].split(',').map(Number);
    if (v.length === 16 && v.every(Number.isFinite)) return [v[0], v[1], v[4], v[5], v[12], v[13]];
  }
  return IDENTITY;
}

/** The element a primary press at `target` should grow, or `null`. */
function pressedElement(target: EventTarget | null, x: number, y: number): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  let origin = target.closest(ORIGIN_SEL);
  // A tap zone `pressOrigin.ts` vetoes in favour of a neighbour (#977): the neighbour gets the
  // click, so the neighbour grows. Same pure rule, same hit stack.
  const zone = target.closest(TAP_ZONE_SEL);
  if (zone) {
    const veto = resolveTapZoneVeto(zone.ownerDocument.elementsFromPoint?.(x, y) ?? [], zone);
    if (veto) origin = veto.closest(ORIGIN_SEL);
  }
  if (!(origin instanceof HTMLElement) || !origin.hasAttribute(UI_PRESS_SCALE_ATTR)) return null;
  return isBackdrop(origin) ? null : origin;
}

/** Measured on LAYOUT size (`offsetWidth`/`offsetHeight`), not the on-screen rect: the rect
 *  includes the element's own transforms — a release still easing back from 1.08 when the next
 *  press lands (a quick double-tap) would inflate the area by up to 1.17x and could misclassify a
 *  large button (second review). */
function isBackdrop(el: HTMLElement): boolean {
  for (const root of roots.keys()) {
    if (!root.contains(el)) continue;
    const rw = (root as HTMLElement).offsetWidth;
    const rh = (root as HTMLElement).offsetHeight;
    // jsdom (and a not-yet-laid-out root) measures 0 — unknown, so not a backdrop.
    if (!(rw > 0 && rh > 0)) return false;
    return el.offsetWidth * el.offsetHeight >= rw * rh * BACKDROP_AREA;
  }
  return false;
}

let pressed: HTMLElement | null = null;
/** The runtime UI roots, for the backdrop rule — refcounted like the listeners, so disposing one
 *  of two installs on the same root does not switch the backdrop rule off for the other. */
const roots = new Map<Element, number>();

function release() {
  const el = pressed;
  pressed = null;
  // The transition stays on the element: it is what eases the scale back to 1 on release.
  if (el) {
    el.style.removeProperty('scale');
    el.style.removeProperty('translate');
  }
}

function onPointerDown(e: PointerEvent) {
  if (!e.isPrimary) return;
  release();
  if (e.button !== 0) return;
  const el = pressedElement(e.target, e.clientX, e.clientY);
  if (!el) return;
  const scale = Number(el.getAttribute(UI_PRESS_SCALE_ATTR));
  if (!Number.isFinite(scale) || scale <= 0) return;
  const ms = Number(el.getAttribute(UI_PRESS_MS_ATTR)) || 0;
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
  const [ox, oy] = (cs?.transformOrigin ?? '').split(' ').map(parseFloat);
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const t = pressTranslate(
    parseCssMatrix(cs?.transform ?? 'none'),
    Number.isFinite(ox) ? ox : w / 2, Number.isFinite(oy) ? oy : h / 2, w, h, scale,
  );
  el.style.setProperty('transition', `scale ${ms}ms ease-out, translate ${ms}ms ease-out`);
  el.style.setProperty('scale', String(scale));
  if (t.x || t.y) el.style.setProperty('translate', `${t.x}px ${t.y}px`);
  pressed = el;
}

function onPointerEnd(e: PointerEvent) {
  if (!e.isPrimary) return;
  release();
}

const installCounts = new WeakMap<Document, number>();

/** Registers capture-phase, passive pointer listeners on `root`'s document, and records `root`
 *  for the backdrop rule. Listeners are refcounted per document, the same way
 *  `installPressOriginTracking` is. Returns a disposer; disposing the last install also releases
 *  a press still held, so an unmounted UI cannot leave a button grown. */
export function installPressFeedback(root: Element): () => void {
  const doc = root.ownerDocument;
  roots.set(root, (roots.get(root) ?? 0) + 1);
  const count = installCounts.get(doc) ?? 0;
  if (count === 0) {
    doc.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    doc.addEventListener('pointerup', onPointerEnd, { capture: true, passive: true });
    doc.addEventListener('pointercancel', onPointerEnd, { capture: true, passive: true });
  }
  installCounts.set(doc, count + 1);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const left = (roots.get(root) ?? 1) - 1;
    if (left > 0) roots.set(root, left); else roots.delete(root);
    const remaining = (installCounts.get(doc) ?? 1) - 1;
    installCounts.set(doc, remaining);
    if (remaining === 0) {
      doc.removeEventListener('pointerdown', onPointerDown, { capture: true });
      doc.removeEventListener('pointerup', onPointerEnd, { capture: true });
      doc.removeEventListener('pointercancel', onPointerEnd, { capture: true });
      release();
    }
  };
}
