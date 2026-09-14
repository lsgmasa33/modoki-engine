/** The DOM half of the UI text overflow warning (#1126): what is measured, and when. The decisions
 *  live in `uiOverflow.ts`; this file only turns a laid-out UI tree into `TextOverflowMeasure`s and
 *  schedules the pass.
 *
 *  ## One scan, not an observer per element
 *  A ResizeObserver on each text element cannot see the OWN-BOX case at all — a fixed-width box
 *  whose text runs past it never changes size. So the check is one pass over the whole UI root:
 *  every element whose projected node carries `text`, measured against the boxes that hold it.
 *
 *  ## When it runs
 *  Coalesced to one pass per `SCAN_DELAY_MS`, scheduled by anything that can move text or its box:
 *  - a DOM mutation under the root — children or text (a bound coin count changes the text node
 *    without rebuilding the projected tree);
 *  - a UI tree rebuild (an Inspector edit to a width lands as a STYLE change only);
 *  - the root resizing (device preset, rotation);
 *  - a web font finishing loading (widths measured against the fallback face are wrong).
 *
 *  ⚠️ **Style-attribute mutations are deliberately NOT observed.** A tween or text animation writes
 *  style every frame, which would turn this into a continuous scan on the debug device builds perf
 *  is measured on. A binding that moves only a style, with no tree rebuild and no text change, is
 *  therefore seen on the next pass something else triggers — a known gap, not an oversight.
 *
 *  ## Coordinates
 *  Every edge is read from `getBoundingClientRect`/`getClientRects` (screen px, transform-aware) and divided by the
 *  root's own screen/layout ratio, so the numbers reported are CSS px of the UI — the editor's
 *  preview frame is scaled, and a screen-px figure there would not match the authored layout.
 *  A box's padding edges add its border back SCALED, the lesson in `AutoFitText`'s
 *  `contentWidthOf` header: mixing a transform-aware rect with a transform-blind length is wrong
 *  by the scale factor. */

import type { UINodeData } from './uiTreeStore';
import { UI_PAINT_ATTR } from './uiPaintMarker';
import {
  classifyTextOverflow, confirmOverflow, recordUIOverflow, refreshUIOverflowCurrent, isUIOverflowRecorded, uiOverflowKey,
  type OverflowBox, type TextOverflowMeasure, type UIOverflowFinding,
} from './uiOverflow';

const ENTITY_ATTR = 'data-entity-id';
export const SCAN_DELAY_MS = 200;

/** The nodes of an element that paint its OWN text: bare text nodes, and the text wrappers UINode
 *  stamps `data-ui-paint="text"` (the clamp/ellipsis div, `AutoFitText`'s span, `AnimatedText`'s
 *  span). Everything else under the host — the tap-zone, nine-slice and video layers, and child UI
 *  elements — is not this element's text. */
function textNodesOf(host: Element): Node[] {
  const out: Node[] = [];
  for (const child of Array.from(host.childNodes)) {
    if (child.nodeType === 3) { if (child.textContent?.trim()) out.push(child); continue; }
    if (child.nodeType === 1 && (child as Element).getAttribute(UI_PAINT_ATTR) === 'text') out.push(child);
  }
  return out;
}

/** A computed transform that only MOVES the box: `none`, or a 2D `matrix(1, 0, 0, 1, tx, ty)`. Anything
 *  else scales, rotates or skews, and `matrix3d` is treated as such rather than decomposed. Exported for
 *  the unit test — the one piece of this file that is pure string logic. */
export function isTranslationOnly(transform: string): boolean {
  if (!transform || transform === 'none') return true;
  const m = /^matrix\(([^)]+)\)$/.exec(transform);
  if (!m) return false;
  const [a, b, c, d] = m[1].split(',').map((v) => Number(v.trim()));
  return a === 1 && b === 0 && c === 0 && d === 1;
}

function isClipX(overflowX: string): boolean {
  return overflowX === 'hidden' || overflowX === 'clip';
}

/** Per-pass memo of computed boxes and translations. A pass reads the same ancestors once per text
 *  element under them, so without it the cost is text elements x depth `getComputedStyle` calls. */
export interface ScanCache {
  boxes: Map<Element, OverflowBox>;
  translateX: Map<Element, number>;
}
export const newScanCache = (): ScanCache => ({ boxes: new Map(), translateX: new Map() });

function boxOf(el: HTMLElement, scale: number, cache: ScanCache): OverflowBox {
  const hit = cache.boxes.get(el);
  if (hit) return hit;
  const r = el.getBoundingClientRect();
  const s = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
  const cs = getComputedStyle(el);
  const left = r.left + el.clientLeft * s;
  const box: OverflowBox = {
    entityId: Number(el.getAttribute(ENTITY_ATTR)),
    left: left / scale,
    right: (left + el.clientWidth * s) / scale,
    clips: isClipX(cs.overflowX),
    scrolls: cs.overflowX === 'auto' || cs.overflowX === 'scroll',
    transformed: !isTranslationOnly(cs.transform),
    positioned: cs.position === 'absolute' || cs.position === 'fixed' || (cs.transform !== 'none' && cs.transform !== ''),
  };
  cache.boxes.set(el, box);
  return box;
}

/** The horizontal shift, in SCREEN px, a pure-translate transform on `el` applies; 0 otherwise. The
 *  computed `tx` is in `el`'s own CSS px, so it is scaled by `el`'s own screen/layout ratio — which a
 *  translate does not change, and which carries every scale above it (an authored `UIElement.scale`,
 *  a pop tween on the panel, the preview frame). The root's ratio alone under-subtracted on a scaled
 *  host (close-out re-review: a jitter label on a scale(1.5) host read as a 1.6px overflow). */
function translateXOf(el: Element, cache: ScanCache): number {
  const hit = cache.translateX.get(el);
  if (hit !== undefined) return hit;
  const t = getComputedStyle(el).transform;
  let shift = 0;
  if (t && t !== 'none' && isTranslationOnly(t)) {
    const tx = Number(/^matrix\(([^)]+)\)$/.exec(t)![1].split(',')[4]) || 0;
    const w = (el as HTMLElement).offsetWidth;
    shift = tx * (w > 0 ? el.getBoundingClientRect().width / w : 1);
  }
  cache.translateX.set(el, shift);
  return shift;
}

/** Where the element's GLYPHS paint, horizontally, in screen px — or null when it paints none.
 *
 *  Read from the text itself, not from the wrapper elements around it, for reasons the close-out
 *  reviews measured in Chromium:
 *  - a wrapper's BOX is not text. `AutoFitText`/`AnimatedText` spans are `display: block`, stretched
 *    to the host.
 *  - whitespace is not text. In `pre-wrap` (those same spans) a space at the end of the string or at
 *    a soft wrap HANGS past the box: a sentence whose last glyph ends at 168.95 in a 170px box had its
 *    wrap space reach 173.4, and 9 of 60 wrapped sentences read as false 1.6-4.3px overflows. So only
 *    the runs of non-whitespace characters are measured.
 *  - a text ANIMATION moves the glyphs. `jitter` shakes its span with a translate, which read as a
 *    1-3px own-box overflow on 13 of 20 samples of text_demo's `Jitter` label and flickered `current`.
 *    Pure translations on elements between a text node and the host are subtracted, so the extent is
 *    where the text is laid out, not where the animation has it this frame. */
function glyphExtent(host: HTMLElement, nodes: Node[], cache: ScanCache): { left: number; right: number } | null {
  const doc = host.ownerDocument;
  let left = Infinity;
  let right = -Infinity;
  const texts: Text[] = [];
  for (const n of nodes) {
    if (n.nodeType === 3) { texts.push(n as Text); continue; }
    const walker = doc.createTreeWalker(n, 4 /* NodeFilter.SHOW_TEXT */);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) texts.push(t as Text);
  }
  const range = doc.createRange();
  for (const t of texts) {
    const runs = t.data.matchAll(/\S+/g);
    let dx: number | null = null;
    for (const run of runs) {
      if (dx === null) {
        dx = 0;
        for (let el = t.parentElement; el && el !== host; el = el.parentElement) dx += translateXOf(el, cache);
      }
      range.setStart(t, run.index!);
      range.setEnd(t, run.index! + run[0].length);
      for (const r of Array.from(range.getClientRects())) {
        if (r.width <= 0) continue;
        left = Math.min(left, r.left - dx);
        right = Math.max(right, r.right - dx);
      }
    }
  }
  return left < right ? { left, right } : null;
}

/** The padding-box edges of a text wrapper that clips, same space as `boxOf` — where the clip cuts. */
function clipEdges(el: HTMLElement, scale: number): { left: number; right: number } {
  const r = el.getBoundingClientRect();
  const s = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
  const left = r.left + el.clientLeft * s;
  return { left: left / scale, right: (left + el.clientWidth * s) / scale };
}

/** Measure one UI element's text against the boxes that hold it. `null` when it paints no text.
 *  `scale` is the root's screen-px per CSS px. */
export function measureTextOverflow(host: HTMLElement, root: HTMLElement, scale: number, cache: ScanCache = newScanCache()): TextOverflowMeasure | null {
  const nodes = textNodesOf(host);
  if (nodes.length === 0) return null;
  const extent = glyphExtent(host, nodes, cache);
  if (!extent) return null;
  const own = { ...boxOf(host, scale, cache) };
  // The text's OWN clip can sit on its wrapper rather than the element: UINode puts `overflow:
  // hidden` on the clamp/ellipsis div (#725) and on `AutoFitText`'s clamped span (#727), inside a
  // host that stays `visible`. The glyph extent is the text's full, unclipped one, so without this an
  // authored ellipsis read as text painting past its box (caught by the e2e spec). The own box then
  // takes the WRAPPER's edges, because that is where the clip cuts: on a padded host the wrapper sits
  // inside the padding, and clamping to the host's padding box reported glyphs the clip had already
  // removed (close-out re-review: a padded ellipsis box flush with its row read as a 20px spill).
  const clipper = nodes.find((n) => n.nodeType === 1 && isClipX(getComputedStyle(n as Element).overflowX)) as HTMLElement | undefined;
  if (clipper) Object.assign(own, clipEdges(clipper, scale), { clips: true });
  const chain: OverflowBox[] = [own];
  for (let el = host.parentElement; el && el !== root; el = el.parentElement) {
    if (el.hasAttribute(ENTITY_ATTR)) chain.push(boxOf(el, scale, cache));
  }
  return { textLeft: extent.left / scale, textRight: extent.right / scale, chain, rootWidth: root.clientWidth };
}

export type MeasureFn = (host: HTMLElement, root: HTMLElement, scale: number, cache: ScanCache) => TextOverflowMeasure | null;

export type ScannedFinding = Omit<UIOverflowFinding, 'current'>;

/** One pass: every text-bearing node of `tree` rendered under `root`, classified. Returns the
 *  findings keyed by `uiOverflowKey` — recording is the caller's. */
export function scanUIOverflow(root: HTMLElement, tree: readonly UINodeData[], measure: MeasureFn = measureTextOverflow): Map<string, ScannedFinding> {
  const byId = new Map<number, UINodeData>();
  const visit = (nodes: readonly UINodeData[]) => {
    for (const n of nodes) { if (n.text) byId.set(n.entityId, n); visit(n.children); }
  };
  visit(tree);
  const found = new Map<string, ScannedFinding>();
  if (byId.size === 0) return found;
  const rootRect = root.getBoundingClientRect();
  const scale = root.offsetWidth > 0 && rootRect.width > 0 ? rootRect.width / root.offsetWidth : 1;
  const viewport = { w: root.clientWidth, h: root.clientHeight };
  const cache = newScanCache();
  for (const host of Array.from(root.querySelectorAll<HTMLElement>(`[${ENTITY_ATTR}]`))) {
    const node = byId.get(Number(host.getAttribute(ENTITY_ATTR)));
    if (!node) continue;
    const m = measure(host, root, scale, cache);
    if (!m) continue;
    const verdict = classifyTextOverflow(m, { authoredEllipsis: node.textOverflow === 'ellipsis' });
    if (!verdict) continue;
    const text = textNodesOf(host).map((t) => t.textContent ?? '').join('').trim();
    found.set(uiOverflowKey(node), { ...verdict, entityId: node.entityId, guid: node.guid, text, viewport });
  }
  return found;
}

/** Install the scheduled scan on a runtime UI root. Returns the teardown.
 *  `subscribeTree` is the UI tree store's change feed; `getTree` its current value. */
export function installUIOverflowScan(
  root: HTMLElement,
  getTree: () => readonly UINodeData[],
  subscribeTree: (cb: () => void) => () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let pending = new Set<string>();

  const run = () => {
    timer = null;
    if (disposed || !root.isConnected) return;
    const found = scanUIOverflow(root, getTree());
    refreshUIOverflowCurrent(new Set(found.keys()));
    // Only UNRECORDED findings go through confirmation. A recorded one that is still overflowing
    // would otherwise re-enter `pending` on every triggered pass, and a non-empty `pending`
    // reschedules — so each trigger would cost two passes, the second confirming nothing new.
    const result = confirmOverflow(pending, new Map([...found].filter(([key]) => !isUIOverflowRecorded(key))));
    for (const [key, f] of result.confirmed) recordUIOverflow(key, f);
    pending = result.pending;
    // An unconfirmed candidate needs a second look even if nothing else changes.
    if (pending.size > 0) schedule();
  };
  const schedule = () => {
    if (disposed || timer !== null) return;
    timer = setTimeout(run, SCAN_DELAY_MS);
  };

  const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(schedule) : null;
  mo?.observe(root, { childList: true, subtree: true, characterData: true });
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
  ro?.observe(root);
  const unsubscribe = subscribeTree(schedule);
  const fonts = root.ownerDocument.fonts as FontFaceSet | undefined;
  fonts?.addEventListener?.('loadingdone', schedule);
  schedule();

  return () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    mo?.disconnect();
    ro?.disconnect();
    unsubscribe();
    fonts?.removeEventListener?.('loadingdone', schedule);
  };
}
