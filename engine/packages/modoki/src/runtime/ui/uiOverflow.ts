/** UI text overflow — the DECISIONS behind the dev/debug-build warning that a UI element's text
 *  paints outside a box that holds it (#1126). The DOM half (what gets measured, when) is
 *  `uiOverflowScan.ts`; everything here is pure or a plain store, so it is unit-testable without a
 *  layout engine (jsdom has none).
 *
 *  ## Why a runtime check, and not a static budget
 *  A row child's text is floored at min-content (`cssVal` never emits `min-width: 0`), so a string
 *  the author does not control the length of runs past its row; a child with a definite width
 *  overflows its OWN box instead. Where the string comes from varies — owner-authored config, a
 *  store-localized price, an unbounded runtime number — and only the first is enumerable at test
 *  time (#1119's `authoredLabelBudget`). The owner chose this check (#1126, 2026-09-13) because it
 *  is the one shape that sees all three: it asks the laid-out DOM, not the string's source.
 *  Its standing limit is the other side of that: it fires only on a path that is actually rendered
 *  with the long string present.
 *
 *  ## Surfaces
 *  A confirmed finding is recorded ONCE per element per world: a `console.warn`, a `@ui.overflow`
 *  journal event at level `warn`, and an entry in the findings store `diagnose` reads. `diagnose`
 *  fails `ok` on a finding that is still CURRENT (owner, 2026-09-14) and lists the rest. The store,
 *  not the journal, backs `diagnose`, because the journal is a ring and evicts; that an element
 *  overflowed at all is the finding, since the offending string may be gone by the time an agent
 *  asks. */

import { emit } from '../core/journal';
import { getCurrentWorld, onWorldSwap } from '../core/ecs/world';
import { guidOfEntityId } from '../core/ecs/entityUtils';

/** Overshoot below this is sub-pixel rounding between two independently laid-out boxes, not a
 *  visible overflow. A measurement epsilon — mechanism, not config. */
export const OVERFLOW_EPSILON_PX = 1;

/** One box on the walk from the text's own element outward — `chain[0]` is the element carrying
 *  the text, then each enclosing UI element in order. Edges are the PADDING box (inside the
 *  border), horizontal only, all in one coordinate space. */
export interface OverflowBox {
  entityId: number;
  left: number;
  right: number;
  /** Computed `overflow-x` is `hidden`/`clip` — this box cuts off what passes its edge. */
  clips: boolean;
  /** Computed `overflow-x` is `auto`/`scroll` — content extends past it by design. */
  scrolls: boolean;
  /** Carries a computed `transform` that SCALES or ROTATES (authored rotation/scale, a pop tween) —
   *  its size on screen is not its layout size, so nothing past it can be compared. A pure translation
   *  is not this; it is `positioned`. */
  transformed: boolean;
  /** PLACED rather than laid out: `position: absolute|fixed`, or moved by a pure translation. Every
   *  `UIAnchor` element is both (absolute, centred by a `translate`). Where it sits relative to its
   *  host is authored — a corner badge, a caption under an icon — so only its width against the whole
   *  UI is judged (see `classifyTextOverflow`). */
  positioned: boolean;
}

export interface TextOverflowMeasure {
  textLeft: number;
  textRight: number;
  chain: readonly OverflowBox[];
  /** The UI root's width, same space — what a PLACED element is measured against. */
  rootWidth: number;
}

export type UIOverflowKind = 'own-box' | 'spill';

export interface UIOverflowVerdict {
  kind: UIOverflowKind;
  // `textPx` is the FULL text width; `overflowPx`/`availablePx` are measured on what is painted, which
  // an own clip (an ellipsis) can make narrower. A clipped spill therefore reads "text is 399px, paints
  // 20px outside a 200px row" — both true.
  /** The UI element whose box the text escapes — the text's own element for `own-box`, and `0` for
   *  the UI root itself (a placed element wider than the whole UI). */
  boxEntityId: number;
  overflowPx: number;
  availablePx: number;
  textPx: number;
  /** The text's own element clips it, so the overflow shows as TRUNCATED text rather than text
   *  painting over its neighbours. Reported all the same: a cut-off price is worse than a small
   *  one (#1125's ruling). */
  clipped: boolean;
}

/** Decide whether the measured text paints outside a box that holds it.
 *
 *  The walk compares the text's horizontal extent against each box from the inside out:
 *  - a box the text runs past by more than `OVERFLOW_EPSILON_PX` → a finding;
 *  - a SCROLL container, anywhere on the chain → never a finding (a scroll view's content extends
 *    past it by design);
 *  - an enclosing CLIP box (not the text's own) → stop: a `hidden` box is also how a pager is
 *    built (#743), whose off-page cards legitimately sit outside it;
 *  - the text's OWN clip → what is still painted is the part inside that box, so the walk goes on
 *    with the extent CLAMPED to it. An ellipsis is the natural fix for an overflow, and stopping here
 *    would let it hide a spill that is still there (close-out review: a 260px ellipsis child in a
 *    200px row painted 30px past the row on both sides and was not reported);
 *  - a scaled/rotated box → stop after comparing it: past it, screen size is not layout size;
 *  - a PLACED box → stop after comparing it, and compare the painted WIDTH against the UI root's
 *    (`rootWidth`, `boxEntityId: 0`). Where a placed element sits relative to its host is authored —
 *    a corner badge, a caption under a 40px icon — so neither its position nor its host's width says
 *    it overflows; being wider than the whole UI does. Found live (#1126): wordweave's anchored
 *    `AdBannerLabel` painted 417px into a 358px-wide UI and the walk, stopping at the anchor, was
 *    silent. The accepted miss: a placed label wider than its host but narrower than the screen.
 *
 *  `authoredEllipsis` exempts the text's own clip from being a finding by itself: `textOverflow:
 *  'ellipsis'` is the author asking for truncation. Any other own clip is reported, `clipped: true`. */
export function classifyTextOverflow(m: TextOverflowMeasure, opts: { authoredEllipsis?: boolean } = {}): UIOverflowVerdict | null {
  const textPx = m.textRight - m.textLeft;
  if (!(textPx > 0)) return null;   // nothing painted (display:none, empty) — also rejects NaN
  let left = m.textLeft;
  let right = m.textRight;
  for (let i = 0; i < m.chain.length; i++) {
    const box = m.chain[i];
    if (box.scrolls) return null;
    const own = i === 0;
    if (!own && box.clips) return null;
    const overflowPx = Math.max(box.left - left, right - box.right);
    if (overflowPx > OVERFLOW_EPSILON_PX && !(own && box.clips && opts.authoredEllipsis)) {
      return {
        kind: own ? 'own-box' : 'spill',
        boxEntityId: box.entityId,
        overflowPx,
        availablePx: box.right - box.left,
        textPx,
        clipped: own && box.clips,
      };
    }
    if (own && box.clips) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
    if (box.transformed) return null;
    if (box.positioned) {
      // A scroll or clip box further out still decides first: an anchored credits line inside a scroll
      // view, a translated ticker inside a `hidden` mask (close-out re-review; the first version of this
      // rule returned before reaching them).
      for (let j = i + 1; j < m.chain.length; j++) if (m.chain[j].scrolls || m.chain[j].clips) return null;
      const excess = (right - left) - m.rootWidth;
      return excess > OVERFLOW_EPSILON_PX
        ? { kind: 'spill', boxEntityId: 0, overflowPx: excess, availablePx: m.rootWidth, textPx, clipped: false }
        : null;
    }
  }
  return null;
}

/** Findings seen on one scan must still be there on the NEXT scan before they are recorded. A
 *  recorded finding stays listed for the world, and warns once, so a transient one — a label
 *  measured one pass before `AutoFitText` converges, a font still swapping in — would otherwise be
 *  a false alarm on every surface. Returns what to record now and what to hold. */
export function confirmOverflow<T>(pending: ReadonlySet<string>, current: ReadonlyMap<string, T>): { confirmed: Array<[string, T]>; pending: Set<string> } {
  const confirmed: Array<[string, T]> = [];
  const next = new Set<string>();
  for (const [key, value] of current) {
    if (pending.has(key)) confirmed.push([key, value]);
    else next.add(key);
  }
  return { confirmed, pending: next };
}

/** The recycle-safe warn-once key UINode's other authoring warnings use (#759): the guid when the
 *  entity has one, else `entityId:generation`. */
export function uiOverflowKey(n: { guid: string; entityId: number; generation: number }): string {
  return n.guid || `${n.entityId}:${n.generation}`;
}

export interface UIOverflowFinding extends UIOverflowVerdict {
  entityId: number;
  guid: string;
  /** The box named by guid (#1223): `null` for the UI root (`boxEntityId: 0`) or a box with no guid.
   *  Set by `recordUIOverflow`, so the journal event carries it as well as `diagnose`. */
  boxGuid: string | null;
  /** The text as rendered, cut to `TEXT_SNIPPET_CHARS`. */
  text: string;
  /** The UI container's size when it was measured, in CSS px — overflow is a function of it. */
  viewport: { w: number; h: number };
  /** Overflowing in the LATEST scan. Starts true; a later scan that does not see it overflow flips it
   *  off — the author widened the box, the count went back down, or the element is no longer rendered
   *  (a closed screen paints nothing). `diagnose` fails `ok` on CURRENT findings only, so a fix is
   *  visible without a reload and a toast that overflowed once does not pin `ok: false` for the rest
   *  of the world; it still LISTS the rest, because that it overflowed at all is the finding. */
  current: boolean;
}

const TEXT_SNIPPET_CHARS = 80;

// ── The gate ────────────────────────────────────────────────────────────────────────────────
// OFF by default, turned on by the app shell in the editor and in a debug game build
// (`engine/app/main.tsx`, the same `__MODOKI_EDITOR__ || __MODOKI_DEBUG_BUILD__` pair as the
// journal) — not `import.meta.env.DEV`, which is false in a debug DEVICE build, and a debug device
// build is where real fonts and real store strings are. A release build never installs the scan.
let _enabled = false;
export function setUIOverflowCheckEnabled(on: boolean): void { _enabled = on; }
export function isUIOverflowCheckEnabled(): boolean { return _enabled; }

// ── The findings store ──────────────────────────────────────────────────────────────────────
const _findings = new Map<string, UIOverflowFinding>();
// Cleared on world swap: a finding describes an element of THIS world, and the id fallback key
// restarts from zero in a new one (the reason spelled out over UINode's `_deadToggles`).
onWorldSwap(() => _findings.clear());

/** Record a confirmed finding. First sighting per key only — returns false for a repeat. */
export function recordUIOverflow(key: string, f: Omit<UIOverflowFinding, 'current' | 'boxGuid'>): boolean {
  if (_findings.has(key)) return false;
  // Rounded once, here, so the console line, the journal event and `diagnose` all quote the same
  // numbers (Percept rounds floats; three surfaces rounding separately would disagree).
  const finding: UIOverflowFinding = {
    ...f,
    boxGuid: f.boxEntityId === 0 ? null : guidOfEntityId(f.boxEntityId),
    current: true,
    overflowPx: round1(f.overflowPx), availablePx: round1(f.availablePx), textPx: round1(f.textPx),
    viewport: { w: Math.round(f.viewport.w), h: Math.round(f.viewport.h) },
    text: f.text.length > TEXT_SNIPPET_CHARS ? `${f.text.slice(0, TEXT_SNIPPET_CHARS)}…` : f.text,
  };
  _findings.set(key, finding);
  const where = finding.kind === 'own-box'
    ? `its own box (${finding.availablePx}px wide${finding.clipped ? ', which clips it' : ''})`
    : finding.boxEntityId === 0
      ? `the UI itself (${finding.availablePx}px wide) — a placed element wider than the screen`
      : `the box of enclosing UI element ${finding.boxGuid ?? `id:${finding.boxEntityId}`} (${finding.availablePx}px wide)`;
  console.warn(`[UIOverflow] ${key} text "${finding.text}" is ${finding.textPx}px and paints ${finding.overflowPx}px outside ${where} at a ${finding.viewport.w}x${finding.viewport.h} UI. A string longer than the layout allows overflows instead of shrinking: give the element a width it can wrap in, autoFitText, or a flexible sibling — see docs/ui-system.md § Text overflow warning.`);
  try { emit('@ui.overflow', { key, ...finding }, getCurrentWorld(), 'warn'); } catch { /* no world yet — the store still has it */ }
  return true;
}

export function isUIOverflowRecorded(key: string): boolean {
  return _findings.has(key);
}

/** Refresh `current` on already-recorded findings from one scan's overflowing keys. Recording NEW
 *  findings is `recordUIOverflow`'s, behind the confirmation pass; this never adds one. */
export function refreshUIOverflowCurrent(overflowing: ReadonlySet<string>): void {
  for (const [key, f] of _findings) f.current = overflowing.has(key);
}

/** Every finding recorded in the current world, oldest first. */
export function getUIOverflowFindings(): UIOverflowFinding[] {
  return [..._findings.values()].map((f) => ({ ...f, viewport: { ...f.viewport } }));
}

/** Test seam — the world-swap clear is the production path. */
export function resetUIOverflowFindings(): void {
  _findings.clear();
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
