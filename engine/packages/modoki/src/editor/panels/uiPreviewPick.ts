/** uiPreviewPick — reconciles a real click in the SceneView "ui" preview mode against the
 *  browser's own paint order (#337).
 *
 *  THE BUG. `UINode` gives every UI element `pointerEvents:'auto'` in this preview mode and its
 *  `onClick` handler unconditionally calls `e.stopPropagation()` — so ANY UI element visually
 *  above a 2D canvas eats the click before the canvas's own `pick2D` hit-test ever runs,
 *  regardless of whether that UI element paints anything visible at the click point. A fully
 *  transparent decorative wrapper (e.g. Court's narration band) sitting over a board cell would
 *  therefore always win, even though nothing about it is visually in front of the cell.
 *
 *  THE FIX. Walk the REAL browser paint stack at the click point (`document.elementsFromPoint`,
 *  topmost first) and ask each layer whether it actually paints something there:
 *   - An opaque UI element in the stack wins outright — paint order always wins, no
 *     `pointerThrough`-based override (owner decision: a visible panel over a 2D entity selects
 *     the panel).
 *   - A 2D canvas layer in the stack runs `pick2D` (the SAME hit-test the canvas's own pointer
 *     handler uses) — a genuine 2D hit there wins over any DECORATIVE (non-opaque) UI element
 *     above it, but not over an OPAQUE one.
 *   - A decorative UI element with nothing else beating it stays selectable (preserves today's
 *     behavior for a fully-transparent full-bleed container over empty 2D space).
 *
 *  `resolvePreviewPick` is pure (no DOM) so it can be unit-tested headlessly; `readPreviewStack`
 *  and `classifyPreviewElement` are the DOM adapters, with `elementsAt` injectable because jsdom
 *  has no `elementsFromPoint`. */

import { UI_PAINT_ATTR } from '../../runtime/ui/uiPaintMarker';

/** One layer of the real browser paint stack at a click point, already classified. */
export type PreviewStackEntry =
  | { kind: 'ui'; entityId: number; opaque: boolean }
  | { kind: '2d'; canvasEntityId: number };

/** What a real click at this point would select, and through which surface. */
export type PreviewPick = { kind: 'ui' | '2d'; id: number };

/** Reconcile paint order (`stack`, topmost first) against each 2D canvas layer's own hit-test
 *  (`pick2DAt`). See the file header for the policy. Returns `null` when nothing in the stack
 *  answers (empty click). */
export function resolvePreviewPick(
  stack: readonly PreviewStackEntry[],
  pick2DAt: (canvasEntityId: number) => number | null,
): PreviewPick | null {
  let decorative: PreviewPick | null = null;
  for (const entry of stack) {
    if (entry.kind === '2d') {
      const id = pick2DAt(entry.canvasEntityId);
      if (id != null) return { kind: '2d', id };
      continue; // this canvas painted nothing at the point — keep descending
    }
    // entry.kind === 'ui'
    if (entry.opaque) return { kind: 'ui', id: entry.entityId };
    // Decorative — remember the FIRST (topmost) one as a fallback, but keep looking for
    // either an opaque UI element or a genuine 2D hit underneath it.
    if (decorative === null) decorative = { kind: 'ui', id: entry.entityId };
  }
  return decorative;
}

function parseAlpha(colorStr: string): number {
  // getComputedStyle resolves to 'rgb(r, g, b)', 'rgba(r, g, b, a)', or 'transparent'.
  if (!colorStr || colorStr === 'transparent') return 0;
  const m = colorStr.match(/rgba?\(([^)]+)\)/);
  if (!m) return 0;
  const parts = m[1].split(',').map((s) => s.trim());
  if (parts.length < 4) return 1; // rgb(...) with no alpha channel = fully opaque
  const a = Number.parseFloat(parts[3]);
  return Number.isFinite(a) ? a : 1;
}

// A background alpha at or below this is treated as invisible, not opaque. Several UI elements
// (e.g. Court's HintCatcher, backgroundOpacity 0.01) paint a near-zero-alpha background purely as
// a full-bleed click-catcher, not to be seen — a strict alpha>0 test would let them always beat a
// genuine 2D hit underneath, reproducing #337 for exactly the entity the issue was filed against.
// A real dim scrim (Court's BackdropDim) uses 0.16, well clear of this threshold.
const MIN_PERCEPTIBLE_ALPHA = 0.05;

/** Box-granular opaque-paint test (matches `pick2D`'s own AABB-not-per-glyph philosophy — this
 *  is deliberately not pixel-perfect). True if the element paints ANYTHING a viewer would see at
 *  its own box: a background color/image, a visible border, direct text content, a naturally
 *  opaque tag (input — the only one `UINode` ever stamps `data-entity-id` on; `img`/`video` never
 *  reach here since images are CSS backgrounds and video is a decorative child, both covered
 *  below), a UIToggle's track+knob (`role="switch"`, drawn as two colored boxes regardless of the
 *  generic checks below), or a DECORATIVE PAINT LAYER — a child `UINode` renders that is not
 *  itself an addressable entity, so it carries no `data-entity-id` of its own and would otherwise
 *  be invisible to this test entirely:
 *   - `NineSliceImage` (a bordered sprite — most of Court's dialog/card art) renders as an
 *     `aria-hidden`, `pointerEvents:'none'` child, not a CSS background on the host element.
 *   - `UIVideoMount` (a video backdrop) is likewise an out-of-flow, pointer-transparent child.
 *   - `AnimatedText` (playing a `TextAnimation`) wraps the text in its OWN `<span>`, so the text
 *     is no longer a direct text-node child of the host element the generic check above looks at.
 *  All three stamp `data-ui-paint` so this test can find them WITHOUT falsely crediting a nested
 *  UI ENTITY's own decorative content to its ancestor: the search stops at the first
 *  `data-ui-paint` descendant whose nearest `data-entity-id` ancestor is `el` itself, not some
 *  child entity's marker bubbling up through `querySelector`. Missing this class of paint is a
 *  real, previously-shipped regression (opus-reviewer, #337 close-out) — without it, every
 *  9-sliced dialog in Court (SolvedPanel, RulesPanel, NarrationBand, ...) reads as fully
 *  decorative and loses to whatever 2D entity happens to be behind it.
 *  False outright when the COMPOSITED opacity (this element's own, times every ancestor's up to
 *  the preview frame — see `compositedOpacity`) is at or below `MIN_PERCEPTIBLE_ALPHA`,
 *  regardless of which paint signal would otherwise fire. */
export function isPaintOpaque(el: Element): boolean {
  const cs = getComputedStyle(el);
  // Gate on COMPOSITED opacity first, once, for every paint signal below — not just
  // background/border alpha, and not just this element's OWN `opacity`. CSS opacity on an
  // ANCESTOR fades the whole subtree, and `elementsFromPoint` returns a low-opacity ancestor's
  // descendants unchanged (opacity does not affect hit-testing) — so a container authored at
  // `opacity:0.02` with an ordinary, fully-opaque child reproduces the exact HintCatcher case
  // (opus-reviewer, #337 close-out) one level down: the CHILD reads opaque on its own computed
  // style, wins the arbiter, and the user selects a panel they cannot see.
  const effectiveAlpha = compositedOpacity(el);
  if (effectiveAlpha <= MIN_PERCEPTIBLE_ALPHA) return false;
  if (el.getAttribute('role') === 'switch') return true; // UIToggle track — see UINode.tsx
  if (el.tagName.toLowerCase() === 'input') return true;
  if (parseAlpha(cs.backgroundColor) * effectiveAlpha > MIN_PERCEPTIBLE_ALPHA) return true;
  if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
  // ⚠️ jsdom does NOT zero `borderTopWidth` when `borderTopStyle` is `none` (real browsers do,
  // per spec) — it reports the UA-default "medium" width regardless, which would read every
  // plain unstyled div as having a visible border. Gate on the style explicitly.
  const hasBorderStyle = cs.borderTopStyle !== 'none' && cs.borderTopStyle !== 'hidden';
  const borderWidth = Number.parseFloat(cs.borderTopWidth || '0');
  if (hasBorderStyle && borderWidth > 0 && parseAlpha(cs.borderTopColor) * effectiveAlpha > MIN_PERCEPTIBLE_ALPHA) return true;
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && (child.textContent || '').trim().length > 0) return true;
  }
  for (const marker of Array.from(el.querySelectorAll(`[${UI_PAINT_ATTR}]`))) {
    if (marker.closest('[data-entity-id]') === el) return true;
  }
  return false;
}

/** This element's own `opacity` × every ancestor's, stopping at (not including) the "ui" preview
 *  frame — an element outside it is not part of this reconciliation and its opacity is not this
 *  test's concern. Stops early the moment the running product drops to/under
 *  `MIN_PERCEPTIBLE_ALPHA`: the answer is already "no" and cannot un-decide by climbing further,
 *  and a deep UI tree with real content should not pay for walking to the root every click. */
function compositedOpacity(el: Element): number {
  let node: Element | null = el;
  let product = 1;
  while (node && !node.hasAttribute('data-ui-preview-frame')) {
    const raw = Number.parseFloat(getComputedStyle(node).opacity || '1');
    product *= Number.isFinite(raw) ? raw : 1;
    if (product <= MIN_PERCEPTIBLE_ALPHA) return product;
    node = node.parentElement;
  }
  return product;
}

/** Classify one DOM element from the paint stack, or `null` if it carries no picking decision
 *  of its own (a layout wrapper — the click should keep descending through it). */
export function classifyPreviewElement(el: Element): PreviewStackEntry | null {
  // The Pixi pick-overlay canvas (Scene2DChromeOverlay) IS the 2D hit-test surface — see
  // SceneView.tsx's `data-canvas-entity-id` on the same element.
  if (el.hasAttribute('data-2d-pick')) {
    const raw = el.getAttribute('data-canvas-entity-id');
    const canvasEntityId = raw != null ? Number(raw) : NaN;
    return Number.isFinite(canvasEntityId) ? { kind: '2d', canvasEntityId } : null;
  }
  // Mount wrappers / the legacy overlay canvas are not decision-bearing layers themselves —
  // the pick canvas above (or the UI node underneath) is. Skip, keep descending.
  if (el.hasAttribute('data-canvas2d-mount')) return null;
  if (el.tagName === 'CANVAS' && el.hasAttribute('data-2d-overlay')) return null;
  if (el.hasAttribute('data-entity-id')) {
    const raw = el.getAttribute('data-entity-id');
    const entityId = raw != null ? Number(raw) : NaN;
    if (!Number.isFinite(entityId)) return null;
    return { kind: 'ui', entityId, opaque: isPaintOpaque(el) };
  }
  return null;
}

/** Read the real browser paint stack at a viewport point (topmost first), classified into
 *  `PreviewStackEntry`s. `elementsAt` is injectable — jsdom has no `elementsFromPoint`. */
export function readPreviewStack(
  x: number,
  y: number,
  elementsAt: (x: number, y: number) => Element[] = (px, py) => document.elementsFromPoint(px, py),
): PreviewStackEntry[] {
  const out: PreviewStackEntry[] = [];
  for (const el of elementsAt(x, y)) {
    const entry = classifyPreviewElement(el);
    if (entry) out.push(entry);
  }
  return out;
}
