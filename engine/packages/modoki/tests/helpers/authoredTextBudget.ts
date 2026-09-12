/**
 * **Does an owner-editable string still fit the row it is authored into? (#1119)**
 *
 * ## The mechanism this exists to guard
 *
 * A row child renders a string the owner edits in the Inspector (a `WordweaveConfig` label, a
 * Court price) and is **floored at min-content**, so a string that cannot WRAP overflows a row with
 * nothing on the chain clipping it. `flexShrink` is not the lever and never was: `cssVal` returns
 * `undefined` for `0` (`runtime/ui/UINode.tsx`), so `min-width: 0` is never emitted and every flex
 * item keeps CSS's automatic minimum size. Shrinking stops at min-content — it buys exactly what
 * word-wrapping can give back, and nothing more.
 *
 * #1038 fixed one instance (the in-progress word) with a max width and a min scale. The sweep that
 * opened #1119 found the untreated shape in eleven more places across two games, which is what
 * makes this a shared resolver rather than a twelfth patch.
 *
 * ## What it does, and the choice behind it
 *
 * It **refuses** a too-long string at the gate rather than making the UI absorb one (owner,
 * 2026-09-12, choosing between accommodate / truncate / refuse). Nothing about the render changes:
 * a rename that would overflow fails `npm run verify` and is shortened by hand, so the owner's
 * chosen words keep the size they were designed at. That is the same answer #1080 gave for the HUD
 * — *"Don't ask to shrink text, board or bars for crossword room"* — generalised.
 *
 * The alternatives were rejected on adoption risk as much as on feel: **no scene in `games/` or
 * `demos/` authors `autoFitText`, and none authors `textOverflow: 'ellipsis'`.** Either would have
 * been this repo's first shipping use of a field exercised only by engine e2e fixtures, and #725
 * records that `ellipsis` is inert under `autoFitText`, so the two do not compose.
 *
 * ## What it CANNOT see — read this before trusting a green run
 *
 * - **It resolves AUTHORED data only.** A row whose width comes from a runtime `patchUI` write, a
 *   pooled `UIEntries` row, or a prefab instance is not modelled; `resolveBoxWidthPx` returns
 *   `null` rather than guessing, and a caller must decide what a `null` means for its case.
 * - **It assumes every child is visible.** Production hides `LevelTab_*` for a locked band, and a
 *   hidden child takes neither width nor gap. Budgeting for all of them is the worst case, which is
 *   the direction a guard should err in — but it means a green run does not prove the row is tight.
 * - **It models ONE line and no wrapping.** That is the point for a label, and it makes this the
 *   wrong tool for text meant to wrap: `TutorialText` wraps to two lines by design and is guarded by
 *   `tutorialNarration.test.ts` instead.
 * - **It does not know where the text actually breaks.** `requiredPx` is the whole string on one
 *   line, so a row that would wrap acceptably is refused. Deliberate, and the reason a caller
 *   should point this at labels rather than sentences.
 * - **No shaping, no kerning** — see `fontMetrics.ts`. The width is an upper bound.
 */

import { type Fields, type Viewport, type AuthoredEntity, uiField, ptPerUnit } from './tapTargetFloor';
import type { FontMetrics } from './fontMetrics';

export type { Viewport, AuthoredEntity, Fields };
export { uiField };

/** A scene indexed for parent-chain walking. Built once per scene, not per assertion. */
export interface SceneIndex {
  readonly byGuid: ReadonlyMap<string, AuthoredEntity>;
  readonly byName: ReadonlyMap<string, AuthoredEntity>;
  readonly childrenOf: ReadonlyMap<string, readonly AuthoredEntity[]>;
}

const guidOf = (e: AuthoredEntity): string | undefined => e.traits?.EntityAttributes?.guid ?? e.guid;
const nameOf = (e: AuthoredEntity): string | undefined => e.traits?.EntityAttributes?.name;
const parentOf = (e: AuthoredEntity): string | undefined => {
  const p = e.traits?.EntityAttributes?.parentId;
  return typeof p === 'string' && p ? p : undefined;
};

export function indexScene(entities: readonly AuthoredEntity[]): SceneIndex {
  const byGuid = new Map<string, AuthoredEntity>();
  const byName = new Map<string, AuthoredEntity>();
  const childrenOf = new Map<string, AuthoredEntity[]>();
  for (const e of entities) {
    const g = guidOf(e);
    if (g) byGuid.set(g, e);
    const n = nameOf(e);
    // First wins: a duplicate name is a scene defect other guards own, and silently preferring the
    // LAST one would make this resolver disagree with them about which entity it measured.
    if (n && !byName.has(n)) byName.set(n, e);
  }
  for (const e of entities) {
    const p = parentOf(e);
    if (!p) continue;
    const list = childrenOf.get(p);
    if (list) list.push(e); else childrenOf.set(p, [e]);
  }
  return { byGuid, byName, childrenOf };
}

/**
 * Depth cap for the parent walk, as a backstop only — **a CYCLE is caught by identity, not by
 * depth**, and the difference is the whole reason this comment is long.
 *
 * ⚠️ An earlier cut relied on this cap alone and claimed "returning `null` beats hanging the test
 * run". It did the opposite. The chain was walked TWICE per level (once to size the box, once to
 * resolve the box's own `%` insets), so the cost was `2^depth`: measured against a two-entity
 * `parentId` cycle, entering at a budget of 8 took 0 ms, 12 took 2 ms, 16 took 20 ms, 20 took
 * 354 ms — 16x per four levels — and at the shipped 64 it ran past two minutes and had to be
 * killed. A scene that acquires a parent cycle (a bad reparent, a hand-edited JSON, a merge
 * artifact) would therefore HANG `npm run verify` forever instead of failing, on precisely the
 * input the cap was written for.
 *
 * Two independent fixes, both kept: the walk now resolves each level's containing width ONCE and
 * threads it down (linear, not exponential), and `seen` below makes a revisited entity return
 * `null` immediately. The cap survives only for a chain that is pathologically deep without being
 * cyclic.
 *
 * ⚠️ **Exported so a test can assert AGAINST it.** A cycle costs ~2 parent lookups with `seen` and
 * ~65 without, so a test bounding the lookups at a small number is what distinguishes the two
 * fixes — but only while this cap stays far above that bound. Lower it to 4 and the bound holds for
 * the wrong reason, silently voiding the one case that pins `seen`. The engine test reads this
 * value rather than assuming it.
 */
export const MAX_DEPTH = 64;

/**
 * One authored length in px, resolving its unit through the engine's own table.
 *
 * `containing` is the width a `%` resolves against, and is `null` when that is itself unresolvable.
 * An absent/zero value contributes 0 and never consults `containing` — so a row with no `gap` is
 * resolvable even inside an unresolvable parent.
 */
function lengthPx(
  ui: Fields | undefined, field: string, vp: Viewport, containing: number | null,
): number | null {
  const value = uiField<number>(ui, field);
  if (!value) return 0;
  const per = ptPerUnit(uiField<string>(ui, `${field}Unit`), vp);
  if (per !== null) return value * per;
  return containing === null ? null : (containing * value) / 100;
}

/**
 * The width, in px, that `e`'s own `%` lengths resolve against — its parent's CONTENT width, or the
 * viewport for a root.
 *
 * ⚠️ **This is also what a `%` PADDING resolves against, per CSS**: a percentage padding is a
 * fraction of the containing block's inline size, never of the element's own width. Getting that
 * backwards is the defect `uiLength.ts` records two Court guards shipping.
 */
function containingWidthPx(
  e: AuthoredEntity, idx: SceneIndex, vp: Viewport, depth: number, seen: ReadonlySet<AuthoredEntity>,
): number | null {
  const pid = parentOf(e);
  if (!pid) return vp.w;
  const parent = idx.byGuid.get(pid);
  if (!parent) return null;   // a dangling parentId — other guards own that; do not guess.
  // A cycle is "an entity already on the path from here to the root", which is exactly `seen`.
  if (seen.has(parent)) return null;
  return contentWidthOf(parent, idx, vp, depth + 1, seen);
}

/** The parent's `UIElement` bag, or `undefined` for a root / a dangling `parentId`. */
function parentUiOf(e: AuthoredEntity, idx: SceneIndex): Fields | undefined {
  const pid = parentOf(e);
  if (!pid) return undefined;
  return idx.byGuid.get(pid)?.traits?.UIElement;
}

/**
 * `e`'s own border-box width in px at `vp`, or `null` when the authored data does not determine it
 * (a content-sized `width: 0`, a `%` off an unresolvable parent, a dangling `parentId`).
 */
export function resolveBoxWidthPx(
  e: AuthoredEntity, idx: SceneIndex, vp: Viewport, depth = 0,
): number | null {
  return boxWidthOf(e, idx, vp, depth, new Set([e]));
}

function boxWidthOf(
  e: AuthoredEntity, idx: SceneIndex, vp: Viewport, depth: number, seen: ReadonlySet<AuthoredEntity>,
): number | null {
  if (depth > MAX_DEPTH) return null;
  const containing = containingWidthPx(e, idx, vp, depth, seen);
  return boxWidthFrom(e, idx, vp, containing);
}

/** The box width given an ALREADY-RESOLVED containing width — so a caller that also needs
 *  `containing` for its own insets resolves the parent chain once, not twice. */
function boxWidthFrom(
  e: AuthoredEntity, idx: SceneIndex, vp: Viewport, containing: number | null,
): number | null {
  const ui = e.traits?.UIElement;

  if (!uiField<number>(ui, 'width')) {
    // `width: 0` is auto — but auto does NOT mean content-sized on the CROSS axis. A child of a
    // COLUMN whose `alignItems` is `stretch` fills its parent's content width, and `stretch` is the
    // engine default, so this is the ordinary shape rather than an edge case: wordweave's three
    // Settings rows author no width at all and are exactly as wide as `SettingsPanel`'s content box.
    // Reading them as content-sized made every Settings label unbudgetable.
    //
    // The cross-axis test is `tapTargetFloor`'s (`isCrossAxis` + a `stretch` check), not a second
    // model of the same rule — width is the cross axis iff the parent lays out in a COLUMN.
    const parentUi = parentUiOf(e, idx);
    const stretches = parentUi !== undefined
      && uiField<string>(parentUi, 'flexDirection') !== 'row'
      && uiField<string>(parentUi, 'alignItems') === 'stretch';
    return stretches ? containing : null;
  }

  let w = lengthPx(ui, 'width', vp, containing);
  if (w === null) return null;

  // A cap and a floor, each in its own unit. `maxWidth`/`minWidth` default to px (uiLength.ts).
  const max = lengthPx(ui, 'maxWidth', vp, containing);
  if (max === null) return null;
  if (max > 0) w = Math.min(w, max);
  const min = lengthPx(ui, 'minWidth', vp, containing);
  if (min === null) return null;
  if (min > 0) w = Math.max(w, min);
  return w;
}

/** Left+right padding plus both borders, in px. Margins are NOT included — they sit outside the
 *  border box and belong to the parent's flex arithmetic, where `outerWidthPx` adds them. */
function sideInsetsPx(ui: Fields | undefined, vp: Viewport, containing: number | null): number | null {
  const l = lengthPx(ui, 'paddingLeft', vp, containing);
  const r = lengthPx(ui, 'paddingRight', vp, containing);
  if (l === null || r === null) return null;
  // `borderWidth` is a plain px number with no unit field (UIElement.ts) and paints on all four
  // sides, so it costs the content box twice.
  return l + r + uiField<number>(ui, 'borderWidth') * 2;
}

/** `e`'s CONTENT width: its border box less its own side padding and borders. */
export function resolveContentWidthPx(
  e: AuthoredEntity, idx: SceneIndex, vp: Viewport, depth = 0,
): number | null {
  return contentWidthOf(e, idx, vp, depth, new Set([e]));
}

function contentWidthOf(
  e: AuthoredEntity, idx: SceneIndex, vp: Viewport, depth: number, seen: ReadonlySet<AuthoredEntity>,
): number | null {
  if (depth > MAX_DEPTH) return null;
  // ONE walk: `containing` serves both the width resolution and the `%` insets below.
  const next = new Set(seen);
  next.add(e);
  const containing = containingWidthPx(e, idx, vp, depth, next);
  const box = boxWidthFrom(e, idx, vp, containing);
  if (box === null) return null;
  const insets = sideInsetsPx(e.traits?.UIElement, vp, containing);
  return insets === null ? null : Math.max(0, box - insets);
}

/**
 * What a content-sized entity is worth, when the caller can say what text it renders.
 *
 * ⚠️ **Without this the resolver is useless on the rows that need it most.** `LevelPager`'s three
 * children — a glyph, the page label, a glyph — are all content-sized, so every sibling lookup
 * returned `null` and the row could not be budgeted at all. A text node's intrinsic width IS its
 * text width, so the same measurement that answers the target answers its siblings.
 */
function intrinsicWidthPx(
  e: AuthoredEntity, ctx: BudgetContext, vp: Viewport,
): number | null {
  const text = ctx.textOf(e);
  if (text === undefined) return null;
  const ui = e.traits?.UIElement;
  const containing = containingWidthPx(e, ctx.idx, vp, 0, new Set([e]));
  const fontPx = lengthPx(ui, 'fontSize', vp, containing);
  const insets = sideInsetsPx(ui, vp, containing);
  const tracking = lengthPx(ui, 'letterSpacing', vp, containing);
  if (fontPx === null || insets === null || tracking === null) return null;
  return ctx.font.widthEm(text).em * fontPx + tracking * [...text].length + insets;
}

/** A child's outer width — border box (or intrinsic text width) plus margins — as its parent's flex
 *  layout counts it. */
function outerWidthPx(e: AuthoredEntity, ctx: BudgetContext, vp: Viewport): number | null {
  const box = resolveBoxWidthPx(e, ctx.idx, vp) ?? intrinsicWidthPx(e, ctx, vp);
  if (box === null) return null;
  const ui = e.traits?.UIElement;
  const containing = containingWidthPx(e, ctx.idx, vp, 0, new Set([e]));
  const l = lengthPx(ui, 'marginLeft', vp, containing);
  const r = lengthPx(ui, 'marginRight', vp, containing);
  return (l === null || r === null) ? null : box + l + r;
}

/** Everything a budget needs beyond the entity itself. */
export interface BudgetContext {
  readonly idx: SceneIndex;
  readonly font: FontMetrics;
  /**
   * The string an entity renders, or `undefined` when the caller does not know.
   *
   * ⚠️ **A caller that returns `undefined` for a content-sized SIBLING makes its row
   * unresolvable**, and `measureTextFit` then returns `null` rather than budgeting off a guess. That
   * is the honest outcome, but it is also silent — assert on `null` in the test rather than letting
   * a case pass by not running.
   */
  readonly textOf: (e: AuthoredEntity) => string | undefined;
}

export interface RowSlot {
  /** px the target child can occupy before the row overflows. */
  readonly availablePx: number;
  /** The row entity the budget was computed from. */
  readonly row: AuthoredEntity;
}

/**
 * The px available to `target` inside its parent row: the row's content width, less every SIBLING's
 * outer width, less the gaps.
 *
 * Returns `null` when any sibling's width is not determined by authored data or by `textOf` —
 * better an explicit "cannot tell" the caller must handle than a budget computed off a guess.
 *
 * ⚠️ **Every sibling is assumed visible.** See the file header.
 */
export function rowSlotPx(target: AuthoredEntity, ctx: BudgetContext, vp: Viewport): RowSlot | null {
  const pid = parentOf(target);
  if (!pid) return null;
  const row = ctx.idx.byGuid.get(pid);
  if (!row) return null;
  const content = resolveContentWidthPx(row, ctx.idx, vp);
  if (content === null) return null;

  const gap = lengthPx(row.traits?.UIElement, 'gap', vp, containingWidthPx(row, ctx.idx, vp, 0, new Set([row])));
  if (gap === null) return null;

  const children = ctx.idx.childrenOf.get(pid) ?? [];
  let used = gap * Math.max(0, children.length - 1);
  for (const c of children) {
    if (c === target) continue;
    const w = outerWidthPx(c, ctx, vp);
    if (w === null) return null;
    used += w;
  }
  return { availablePx: Math.max(0, content - used), row };
}

export interface TextFit {
  readonly text: string;
  readonly viewport: Viewport;
  /** One-line width the string needs, including the child's own padding, borders and margins. */
  readonly requiredPx: number;
  /** What the row leaves it. */
  readonly availablePx: number;
  readonly fits: boolean;
  /** Characters the font has no glyph for — a separate defect, surfaced rather than silently 0-wide. */
  readonly missingGlyphs: readonly string[];
}

/**
 * Does `text` fit `target`'s slot in its row, on one line, at `vp`?
 *
 * Returns `null` when the row's geometry is not resolvable (see `rowSlotPx`).
 */
export function measureTextFit(
  target: AuthoredEntity, text: string, ctx: BudgetContext, vp: Viewport,
): TextFit | null {
  const slot = rowSlotPx(target, ctx, vp);
  if (slot === null) return null;

  const ui = target.traits?.UIElement;
  const containing = containingWidthPx(target, ctx.idx, vp, 0, new Set([target]));
  const fontPx = lengthPx(ui, 'fontSize', vp, containing);
  const insets = sideInsetsPx(ui, vp, containing);
  const ml = lengthPx(ui, 'marginLeft', vp, containing);
  const mr = lengthPx(ui, 'marginRight', vp, containing);
  const tracking = lengthPx(ui, 'letterSpacing', vp, containing);
  if (fontPx === null || insets === null || ml === null || mr === null || tracking === null) return null;

  const w = ctx.font.widthEm(text);
  // CSS `letter-spacing` is added after EVERY character, the last one included — so a string of n
  // characters carries n spacings, not n-1.
  const requiredPx = w.em * fontPx + tracking * [...text].length + insets + ml + mr;

  return {
    text,
    viewport: vp,
    requiredPx,
    availablePx: slot.availablePx,
    fits: requiredPx <= slot.availablePx,
    missingGlyphs: w.missing,
  };
}

/**
 * Can flex layout change this element's USED width away from its authored one?
 *
 * ⚠️ **Without this the own-box budget reports a confidently wrong box, in the one direction a
 * refuse-don't-accommodate gate must never err.** `resolveContentWidthPx` returns the authored
 * width clamped by min/max — the flex BASE size — and models no flex resolution. wordweave's
 * `TutorialSkipConfirm`/`TutorialSkipCancel` are each `width: 50` (`%`) with `flexGrow: 1` and the
 * default `flexShrink: 1`, two in a `row` with a 12 px gap: the bases over-subscribe the line, so
 * both shrink, and the authored 50% over-states the real box. Measured by close-out review at
 * 360 px wide: base 125.2 px, used ~119.2 px — so a label needing 124.96 px was reported as
 * FITTING while overflowing by ~5.8 px.
 *
 * So: on the MAIN axis of a row, an item that can grow or shrink has no width this resolver knows,
 * and `null` ("cannot tell") is the only honest answer. In a COLUMN parent, width is the CROSS axis
 * and `flexGrow`/`flexShrink` do not touch it, so an authored width there IS the used width.
 *
 * ⚠️ Modelling the flex resolution itself would recover these cases. It is deliberately NOT done
 * here: it needs every sibling's base, min-content floor and grow/shrink factor, which is a
 * layout engine, not a budget.
 *
 * ⚠️ **Consequence worth knowing before you add a row label to an own-box budget: `flexShrink`
 * DEFAULTS to 1** (`runtime/traits/UIElement.ts`), so every row child that does not explicitly
 * author `flexShrink: 0` is refused here. The budget is therefore effectively opt-in via a scene
 * field, and the next authored-width row label will fail with "own width is not resolvable" until
 * someone either authors `flexShrink: 0` — **a render-affecting edit, so do not make it merely to
 * satisfy a test** — or records the label as flex-sized instead. The direction is safe (a refusal,
 * never a wrong number), and a caller's own skip-set assertion is what stops the refusal being
 * mistaken for coverage.
 */
function flexesOnWidth(e: AuthoredEntity, idx: SceneIndex): boolean {
  const parentUi = parentUiOf(e, idx);
  if (parentUi === undefined) return false;                      // a root is not a flex item
  if (uiField<string>(parentUi, 'flexDirection') !== 'row') return false;   // width is the cross axis
  const ui = e.traits?.UIElement;
  return uiField<number>(ui, 'flexGrow') > 0 || uiField<number>(ui, 'flexShrink') > 0;
}

/**
 * Does `text` fit inside `target`'s OWN content box, on one line, at `vp`?
 *
 * ⚠️ **A second, genuinely different mechanism from `measureTextFit`, and conflating them leaves a
 * hole.** A child with an authored `width` cannot be squeezed by its text — a definite width caps
 * the flex automatic minimum size, so it never pushes its ROW over. What it can do instead is
 * overflow ITSELF: the text paints past its own rounded box with nothing on the chain clipping.
 * A close-out review found four such labels silently dropped from a row-only guard's population,
 * the worst being wordweave's `SettingsHapticsValue` — an owner-editable On/Off word at
 * `fontSize: 18` in an authored `width: 88`, where the longest string that fits is about ten
 * characters and `"Vibration on"` needs ~103 px.
 *
 * Returns `null` when the box's own width is not resolvable from authored data.
 */
export function measureTextFitInOwnBox(
  target: AuthoredEntity, text: string, ctx: BudgetContext, vp: Viewport,
): TextFit | null {
  if (flexesOnWidth(target, ctx.idx)) return null;
  const availablePx = resolveContentWidthPx(target, ctx.idx, vp);
  if (availablePx === null) return null;

  const ui = target.traits?.UIElement;
  const containing = containingWidthPx(target, ctx.idx, vp, 0, new Set([target]));
  const fontPx = lengthPx(ui, 'fontSize', vp, containing);
  const tracking = lengthPx(ui, 'letterSpacing', vp, containing);
  if (fontPx === null || tracking === null) return null;

  const w = ctx.font.widthEm(text);
  // No insets and no margins here, deliberately: `resolveContentWidthPx` has already taken this
  // element's own padding and borders off, which is exactly the box the text is laid out in.
  const requiredPx = w.em * fontPx + tracking * [...text].length;
  return {
    text, viewport: vp, requiredPx, availablePx,
    fits: requiredPx <= availablePx, missingGlyphs: w.missing,
  };
}

/** `measureTextFitInOwnBox`'s worst case across `viewports`. Same contract as `worstTextFit`. */
export function worstTextFitInOwnBox(
  target: AuthoredEntity, text: string, ctx: BudgetContext, viewports: readonly Viewport[],
): TextFit | null {
  let worst: TextFit | null = null;
  for (const vp of viewports) {
    const fit = measureTextFitInOwnBox(target, text, ctx, vp);
    if (!fit) continue;
    if (!worst || (fit.availablePx - fit.requiredPx) < (worst.availablePx - worst.requiredPx)) worst = fit;
  }
  return worst;
}

/**
 * The WORST fit for `text` across `viewports` — the one with the least headroom, which is the only
 * one worth asserting on.
 *
 * ⚠️ **No single viewport is the worst case**, which is why callers pass a matrix rather than a
 * constant. A row sized in `%` is worst on the NARROWEST screen; one whose fixed-px sibling eats a
 * `vh`-sized slot is worst on the SHORTEST. `tapTargetFloor.SHIPPING_VIEWPORTS` is the engine's
 * derived list and the right default.
 *
 * Returns `null` if the geometry is unresolvable at EVERY viewport.
 */
export function worstTextFit(
  target: AuthoredEntity, text: string, ctx: BudgetContext, viewports: readonly Viewport[],
): TextFit | null {
  let worst: TextFit | null = null;
  for (const vp of viewports) {
    const fit = measureTextFit(target, text, ctx, vp);
    if (!fit) continue;
    if (!worst || (fit.availablePx - fit.requiredPx) < (worst.availablePx - worst.requiredPx)) worst = fit;
  }
  return worst;
}
