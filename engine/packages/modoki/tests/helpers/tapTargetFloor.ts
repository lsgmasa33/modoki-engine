/**
 * ⚠️ **ONE tap-target floor resolver, shared by every project that gates one (#1024).**
 *
 * The class #1024 filed: **nothing engine-side gates a tappable's authored hit SIZE, so every
 * project re-derives the check by hand.** Three passes found it that way — #948 (Court), #969
 * (Court again), #1017 (wordweave) — each scoped to one game, each starting from zero, each
 * writing its own enumeration. The instances were never the problem; the absence of a shared
 * gate was.
 *
 * What lives HERE is the part that is an **engine fact**: what counts as tappable, how an
 * unauthored axis behaves, when `UIElement.minTapSize` is structurally inert, and which screens a
 * control has to clear. What stays in each project's own test is the part only its owner knows:
 * which controls are allowed under the floor, and why.
 *
 * ⚠️ **It lives in the PACKAGE, not in `engine/tests/`, and that is load-bearing.** A demo is
 * published as a standalone snapshot (`scripts/publish-demo.sh`) that carries its own `tests/` and
 * nothing else from the monorepo, so `engine/tests/…` is unreachable from it by construction —
 * `@modoki/engine` is the only specifier a published project can name (CLAUDE.md § "Games must be
 * SELF-CONTAINED"). Exported as `@modoki/engine/testing/tapTargetFloor`.
 *
 * ## The five things that were each learned by a measurement reddening an earlier cut
 *
 * 1. **An axis has FOUR outcomes, not a number** (`Axis` below). Collapsing any two of them was a
 *    real defect twice in #1017.
 * 2. **`minTapSize` is inert in several structural cases**, not one (`hostsExpander` /
 *    `emitsExpander`). ⚠️ The COUNT lives in `docs/ui-system.md` § "Tap zones" and nowhere else —
 *    that page enumerates every case including the two this file cannot see (an expander over a
 *    `Canvas2D` host, and a value control whose floor is met by its own box). What this file models
 *    is the subset decidable from authored data.
 * 3. **No single viewport is the worst case** (`SHIPPING_VIEWPORTS`). A `vmin` control clears the
 *    floor at 375 and misses at 360; a `vh` one does the opposite.
 * 4. **The population is `UIAction` AND `TouchControl`** (`isTapTarget`). A d-pad arrow is a held
 *    LEVEL, never a click, so no `UIAction` sweep can see one.
 * 5. **A field equal to its trait default is STRIPPED on save**, so every read goes through
 *    `traitFieldOrDefault` and never through `?? <literal>` — a literal is not a fallback here,
 *    it is the only branch that ever runs.
 *
 * ## What this deliberately does NOT do
 *
 * **Clearance.** Whether two controls' hit areas overlap is NOT soundly derivable from authored
 * data: `games/court/tests/tapZoneClearance.test.ts` records a first cut being wrong three times
 * out of five, because a sound answer needs flex-wrap, absolute positioning, stacking contexts and
 * paint order — a layout engine. Size is derivable; clearance is measured live. That boundary is
 * why #963 was handled as its own issue rather than folded into this class.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// ⚠️ **Relative, and deliberately NARROW.** This module is imported by every project's guard, so a
// barrel import here would pull the whole runtime (and, for the device catalog, the whole EDITOR)
// into nine test files that need two symbols. Relative rather than `@modoki/engine/...` because
// this file lives INSIDE the package — a self-referencing specifier would also have to resolve
// under the package's own vitest config, which aliases three/react/koota and not itself.
import { UIElement } from '../../src/runtime/traits/UIElement';
import { traitFieldOrDefault } from '../../src/runtime/core/ecs/traitSchema';
import { DEVICE_PRESETS, SHIPPING_DEVICE_CATEGORIES } from '../../src/editor/scene/devicePresets';

/** Apple HIG asks 44 pt; Material asks 48 dp. **44 is the floor being enforced** (#1024 Q2,
 *  answered from evidence 2026-09-10) — the repo authors 48 and gates 44, so an author has room
 *  to be slightly wrong without the gate firing on taste. */
export const FLOOR_PT = 44;

export interface Viewport { readonly name: string; readonly w: number; readonly h: number }

/**
 * Every screen a tap target has to clear, **DERIVED from the engine's own catalog**.
 *
 * ⚠️ **Never transcribed.** `games/court/tests/devices.ts` records the first hand-written version
 * being wrong on its second line (the Galaxy S22 at 360x800 — that is the Motorola Edge 50's
 * height; the S22 is 360x780). A hand-copied geometry table is exactly the shadowing this repo's
 * single-source-of-truth rule exists to stop, and two copies is how a floor comes to hold in one
 * guard's matrix and not the other's.
 *
 * ⚠️ **No single entry is the worst case, which is the whole reason this is a matrix.** A control
 * authored `11.8vmin` clears 44 pt at 375 (44.25) and misses it at 360 (42.5); a `vh` one is the
 * other way round, so its worst case is the SHORTEST screen. Both named Android targets in
 * CLAUDE.md § Device Info are 360 dp, and the iPhone SE is the shortest at 667.
 *
 * Widths are safe-area-inset (`logicalW - left - right`) because that is the box a control is laid
 * out in; heights are logical, since no unit resolved here takes a top/bottom inset. The category
 * filter is `SHIPPING_DEVICE_CATEGORIES` — an ALLOW-list, engine-owned, so a new preset category
 * defaults to EXCLUDED rather than silently entering this matrix; see its doc.
 *
 * ⚠️ **That inset subtraction is INERT today and would introduce a mixed basis if it stopped being
 * inert.** Every preset in the catalog has portrait `left`/`right` at 0, so `w` is the logical
 * width in every row. If one ever gains a side inset, `w` becomes the LAYOUT box while CSS resolves
 * `vw`/`vmin` against the full viewport — so the two terms would disagree, and the right fix is to
 * carry both rather than to pick one. Copied deliberately from `games/court/tests/devices.ts`,
 * which chose the layout box for a floor that resolves against a PARENT.
 */
export const SHIPPING_VIEWPORTS: readonly Viewport[] = DEVICE_PRESETS
  .filter((p) => SHIPPING_DEVICE_CATEGORIES.includes(p.category))
  .map((p) => ({
    name: p.name,
    w: p.logicalW - p.safeArea.portrait.left - p.safeArea.portrait.right,
    h: p.logicalH,
  }))
  .sort((a, b) => a.w - b.w);

export type Fields = Record<string, unknown>;

export interface AuthoredEntity {
  localId?: number;
  traits?: {
    EntityAttributes?: { name?: string; guid?: string; parentId?: string | number };
    UIElement?: Fields;
    UIAction?: { bindings?: Array<{ event?: string; kind?: string }> };
    /** ⚠️ A SEPARATE TRAIT, not a `UIElement` field — see `hostsExpander`. */
    UIToggle?: Fields;
    /** ⚠️ The repo's OTHER first-class tappable — see `isTapTarget`. */
    TouchControl?: Fields;
    [trait: string]: unknown;
  };
}

/**
 * Read a `UIElement` field through the trait's own default rather than hardcoding it.
 *
 * ⚠️ **A field equal to its trait default is STRIPPED on save**, so the raw JSON cannot tell an
 * authored-at-default field from an absent one. Hardcoding the defaults here would also SHADOW the
 * trait — a single-source-of-truth violation that goes stale silently the day someone changes
 * `widthUnit`'s default.
 */
export function uiField<T>(bag: Fields | undefined, key: string): T {
  return traitFieldOrDefault<T>(UIElement, bag, key);
}

/**
 * One axis, resolved as far as the authored data allows. **FOUR outcomes**, and collapsing any two
 * makes the resolver wrong — two of the four were merged in earlier cuts and both were real
 * defects (#1017):
 *
 * - `pt` — viewport-resolvable. Compare to the floor.
 * - `content` — an unauthored axis that really is glyph-sized. ⚠️ wordweave's
 *   `DictionaryPrev`/`DictionaryNext` shape: no width, no height, just `fontSize: 28`, measured
 *   **16.90 x 40.21 pt** live. This is the hazard, and it is INVISIBLE to anyone scanning the JSON
 *   for small numbers, because there is no number.
 * - `stretched` — an unauthored CROSS axis under a parent whose `alignItems` is `stretch`. It
 *   fills the parent and is not small. ⚠️ Merging this into `content` claimed `MenuPlay` (~232 pt
 *   wide) and `SettingsClose` (~315 pt) were under the floor, whose prescribed fix would be a
 *   `minTapSize` that `max(100%, 48px)` makes a NO-OP — the guard mandating an authored field that
 *   does nothing.
 * - `parent` — a `%`. Nothing here resolves the parent chain to a real size.
 *   ⚠️ Merging this into `content` flagged a full-width dialog button at `100% x 52 px` as a defect.
 *
 * ⚠️ **Only `pt` is a MEASUREMENT; the other three are the guard's blind spot**, and that is the
 * whole reason a project keeps two lists rather than one. An earlier cut collapsed them behind a
 * single `axisUnderFloor` predicate that presumed `content` and `% < 100` short and `stretched`
 * adequate — presumptions this cannot support in either direction, since Court's `62% x content`
 * dialog buttons measure 133 x 46 pt live while wordweave's `content x content` arrows measured
 * 16.90 x 40.21 pt. That predicate was deleted in #1024's close-out rather than left exported,
 * because it returned the opposite verdict from the suite beside it.
 *
 * ⚠️ **Two inputs this deliberately does NOT model, both latent today** (swept across all nine
 * corpora, zero live instances): `alignSelf`, which overrides the parent's `alignItems` per child,
 * and `UIAnchor`, which makes an element `position: absolute` so a stretch parent does not stretch
 * it. Either would make an auto cross axis report `stretched` — i.e. adequate — when it is not.
 */
export type Axis =
  | { kind: 'pt'; pt: number }
  | { kind: 'content' }
  | { kind: 'stretched' }
  | { kind: 'parent'; pct: number };

/** pt per unit at one viewport, or `null` for a unit that is parent-relative. */
export function ptPerUnit(unit: string, vp: Viewport): number | null {
  switch (unit) {
    case 'px': return 1;
    case 'vw': return vp.w / 100;
    case 'vh': return vp.h / 100;
    case 'vmin': return Math.min(vp.w, vp.h) / 100;
    case 'vmax': return Math.max(vp.w, vp.h) / 100;
    default: return null;   // '%' — parent-relative
  }
}

/**
 * Whether `axisKey` is the CROSS axis of its parent's flex layout — the one `alignItems`
 * stretches. A `column` parent stretches its children's WIDTH; a `row` parent stretches HEIGHT.
 */
function isCrossAxis(axisKey: 'width' | 'height', parentUi: Fields | undefined): boolean {
  return uiField<string>(parentUi, 'flexDirection') === 'row' ? axisKey === 'height' : axisKey === 'width';
}

/** Resolve one axis. `ptPerDesignPx` is non-null only for a control whose authored `px` is DESIGN
 *  px rather than CSS px — see `TapTargetFloorOptions.designPx`. */
export function resolveAxis(
  ui: Fields, axisKey: 'width' | 'height', parentUi: Fields | undefined, vp: Viewport,
  ptPerDesignPx: number | null = null,
): Axis {
  const size = uiField<number>(ui, axisKey);
  if (size === 0) {
    const stretches =
      parentUi !== undefined &&
      isCrossAxis(axisKey, parentUi) &&
      uiField<string>(parentUi, 'alignItems') === 'stretch';
    return stretches ? { kind: 'stretched' } : { kind: 'content' };
  }
  const unit = uiField<string>(ui, `${axisKey}Unit`);
  // ⚠️ Same unit STRING, different space. Only a caller-declared control is rescaled.
  if (ptPerDesignPx !== null && unit === 'px') return { kind: 'pt', pt: size * ptPerDesignPx };
  const per = ptPerUnit(unit, vp);
  return per === null ? { kind: 'parent', pct: size } : { kind: 'pt', pt: size * per };
}

/**
 * Whether this element can HOST the expander `minTapSize` emits. Mirrors the two structural gates
 * `UINode.tsx` applies inside `if (tapZone && takesClick)` (`:1353`-`:1366`), plus the clip gate.
 *
 * 1. **`elementType` must be `div`** — `input`/`range` render a VOID element and nothing can be
 *    nested inside one.
 * 2. **No `UIToggle`** — ⚠️ a SEPARATE TRAIT, not a `UIElement` field. `uiTreeStore.ts` builds
 *    `node.toggle` from `entity.has(UIToggle)`; reading a `toggle` key off `UIElement` yields
 *    `undefined` for every entity in the repo, so that check is VACUOUS. Court's
 *    `SettingsHapticsToggle` (a `div` carrying `UIToggle`) is the live entity it mis-classifies.
 * 3. **`overflow` must not be `hidden`/`scroll`** — the expander is a CHILD, so the clip cuts it
 *    back to the box and it does nothing. ⚠️ Mutation-proved in #1017: adding `overflow: 'hidden'`
 *    to `DictionaryPrev` left every scene-driven test green while production silently dropped it
 *    back to 16.90 x 40.21 pt.
 */
export function hostsExpander(ui: Fields, hasToggle: boolean): boolean {
  if (uiField<string>(ui, 'elementType') !== 'div' || hasToggle) return false;
  const overflow = uiField<string>(ui, 'overflow');
  return overflow !== 'hidden' && overflow !== 'scroll';
}

/**
 * Whether this entity is something the player AIMS AT — the population the 44 pt floor is about.
 *
 * ⚠️ **A binding is not a click binding.** `UINode.tsx:1163` reads
 * `bindings.some(b => (b.event || 'click') === 'click')`. A slider binds `event: 'change'`, so it
 * is not a tap target; counting any-binding flags a control for a tap it never receives.
 *
 * ⚠️ **`TouchControl` is the OTHER half, and #1024's own census was blind to it.** It is an engine
 * trait (`runtime/traits/TouchControl.ts`) and the repo's second first-class tappable: a d-pad
 * arrow or a hold-to-move button. Its docblock says *"Do not reach for `UIAction` for this"* — a
 * movement control is a held LEVEL, not a click — so **no `TouchControl` entity can ever appear in
 * a `UIAction` sweep**, and a gate built to #1024's filed spec would inherit that blind spot.
 * (`demos/forest-camp`'s four pads plus its AIM button are exactly this shape. They are 48 px and
 * clear the floor, so the RULE was wrong without any count being wrong — which is precisely the
 * shape that ships.)
 */
export function isTapTarget(e: AuthoredEntity): boolean {
  if (e.traits?.TouchControl !== undefined) return true;
  return (e.traits?.UIAction?.bindings ?? []).some((b) => (b.event || 'click') === 'click');
}

/**
 * Whether the renderer would EMIT an expander here at all — `UINode.tsx`'s own
 * `takesClick = isInteractive || swallowsClicks` (`:1182`), the outer gate on the whole tap-zone
 * branch.
 *
 * ⚠️ **`TouchControl` is an inert case in its own right, and it was in no list because nothing had
 * looked** (found building this resolver, 2026-09-10; `docs/ui-system.md` § "Tap zones" holds the
 * enumeration and the count — this file deliberately keeps neither, so the two cannot disagree). `takesClick` reads CLICK BINDINGS and
 * `swallowClicks` — it knows nothing about `TouchControl`. So a d-pad arrow, which is a tap target
 * by any human definition, gets **no expander**: `minTapSize` on one is authored and inert, and
 * unlike the other three cases the renderer does not even warn, because the branch that warns is
 * inside the gate this fails. A `TouchControl` under the floor must therefore be fixed by AUTHORED
 * SIZE. (Verified against `demos/forest-camp/runtime/assets/scenes/main.scene.json`: none of the
 * five pads carries a `UIAction`, so none of them could host a zone.)
 *
 * ⚠️ **Deliberately NOT the same question as `isTapTarget`, in the other direction too.** A
 * `swallowClicks` panel with zero bindings is a SHIELD — it stops a press reaching a dismissing
 * scrim, and nobody aims at it — but the renderer does emit for one, so an authored `minTapSize`
 * on a shield is NOT silently dropped and the inert check has to look wider than the target list.
 * Collapsing the two concepts put all five of wordweave's panels into its offender list.
 */
export function emitsExpander(e: AuthoredEntity): boolean {
  const ui = e.traits?.UIElement;
  const isInteractive = (e.traits?.UIAction?.bindings ?? []).some((b) => (b.event || 'click') === 'click');
  // ⚠️ `&& !pointerThrough` is part of `swallowsClicks`, NOT a refinement of it (`UINode.tsx:1181`).
  // `UIElement`'s own doc states it: "Contradicts `pointerThrough`, which WINS." Omitting it made
  // this predicate report `emits: true` for a shield that the renderer drops entirely — so an
  // authored `minTapSize` there would pass the inert check while doing nothing on screen, which is
  // the exact authoring-lie the inert check is named for. Caught in #1024's close-out review.
  const swallows = uiField<boolean>(ui, 'swallowClicks') === true && uiField<boolean>(ui, 'pointerThrough') !== true;
  return isInteractive || swallows;
}

/** The authored tap zone in pt at one viewport, or 0 when absent or unresolvable. A `%` resolves
 *  to 0 — conservative, and it fails loud rather than passing a control this cannot measure. */
export function authoredTapZonePt(ui: Fields, vp: Viewport): number {
  const size = uiField<number>(ui, 'minTapSize');
  if (size === 0) return 0;
  const per = ptPerUnit(uiField<string>(ui, 'minTapSizeUnit'), vp);
  return per === null ? 0 : size * per;
}

export interface Control {
  name: string;
  /** Absolute path of the scene or prefab it was authored in. */
  file: string;
  ui: Fields;
  hasToggle: boolean;
  parentUi: Fields | undefined;
  /** Every ancestor's `UIElement`, nearest first. Only `isFullScreenScrim` reads it — see there. */
  ancestorUi: Array<Fields | undefined>;
  /** Aimed at by the player — the floor applies. `UIAction` click binding OR `TouchControl`. */
  isTarget: boolean;
  /** The renderer's `takesClick` — whether an authored `minTapSize` is emitted rather than dropped. */
  emits: boolean;
  /** Whether the element can carry the expander, once emitted. */
  hosts: boolean;
}

/**
 * Every authored file a tappable can hide in — **the whole `runtime/assets` tree, recursively.**
 *
 * ⚠️ **Prefabs are in here because leaving them out made an earlier guard's promise FALSE.** A
 * prefab carries `UIElement` in the identical shape, and both shipping projects already have UI
 * prefabs with click bindings (`level-tile.prefab.json`, `dictionary-card.prefab.json`) — exactly
 * the place the next tap binding lands. With a hardcoded single scene path such a file could gain
 * one and the guard would stay green while claiming to derive the whole population.
 *
 * ⚠️ **Recursive, and over the whole tree rather than a `scenes/` + `prefabs/` pair** (#1024
 * close-out review). Naming two directories delivered the promise above for two projects and
 * quietly broke it for three: `demos/forest-camp` keeps **19** prefabs under `runtime/assets/models/`,
 * `demos/postfx-demo` 7, `demos/3d-physics-demo` 1 — none of them scanned, none of them able to
 * make `expectAtLeast` or `expectNames` notice. A scene in a subdirectory of `scenes/` was invisible
 * for the same reason. Model prefabs carry no `UIElement` today; the promise is what was wrong.
 */
export function authoredFiles(assetsDir: string): string[] {
  if (!existsSync(assetsDir)) return [];
  // ⚠️ **Node's OWN recursion (`recursive: true`), never a hand-rolled walker.**
  // `engine/tests/architecture/corpusProducerIsShared.test.ts` Rule 2 forbids one, and its remedy —
  // `repoFiles()` from `engine/scripts/repoCorpus.mjs` — is unreachable from here twice over: this
  // module lives inside the published package and may not import out of it, and `repoFiles()` shells
  // out to `git ls-files`, which answers nothing in a demo snapshot that is its own repo. Node's
  // built-in is neither a second corpus definition nor an exemption; it is simply the right call.
  return readdirSync(assetsDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && (e.name.endsWith('.scene.json') || e.name.endsWith('.prefab.json')))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

export interface TapTargetFloorOptions {
  /** Names the `describe` block — the project id, e.g. `'wordweave'`. */
  label: string;
  /** The project's `runtime/assets` directory. Walked RECURSIVELY for every `*.scene.json` and
   *  `*.prefab.json` under it — see `authoredFiles` for why it is the whole tree and not a
   *  `scenes/` + `prefabs/` pair. */
  assetsDir: string;
  /**
   * Tap targets **MEASURED under the floor** — at least one `px`/`vw`/`vh`/`vmin`/`vmax` axis
   * resolves below 44 pt on some shipping screen, and no effective tap zone covers it. Asserted as
   * SET EQUALITY, both directions: a new one reds the suite, and so does fixing one, which must
   * shrink the list deliberately rather than leave a stale constant behind.
   *
   * **Every name here needs a reason.** This is the defect list.
   */
  underFloor?: readonly string[];
  /**
   * Tap targets whose size **this guard cannot resolve at all** — at least one axis is `content`,
   * `stretched` or a `%`, so the authored data does not say how big it is on screen. Set equality,
   * for the same reason.
   *
   * ⚠️ **These are NOT offenders, and calling them that was measured wrong.** Court's
   * `TutorialSkipNoticeConfirm`/`Cancel` are `62% x content` here and measure **133 x 46 pt** live
   * (#969, in the editor on a Galaxy S22 preview) — comfortably over the floor. Equally, wordweave's
   * `DictionaryPrev` was `content x content` here and measured **16.90 x 40.21 pt** live, which is
   * the hazard this whole class exists for and is INVISIBLE to anyone scanning the JSON for small
   * numbers, because there is no number.
   *
   * So the list means exactly one thing: *the only way to know is to measure it live.* It is
   * enumerated rather than ignored so that adding the next one is a deliberate act.
   */
  unresolvable?: readonly string[];
  /**
   * Controls that **cannot host the expander at all** and are under the floor — a `range`, an
   * `input`, a `UIToggle` host, or a box clipped by `overflow`. Set equality, like the two above.
   *
   * ⚠️ **A separate list because these are not necessarily tap TARGETS.** A slider and a toggle bind
   * `change`, not `click`, so a target-only sweep cannot see them — and they are still controls a
   * finger has to hit. `minTapSize` is not the field for them (#1025): a `range` hit-tests its whole
   * authored box, so it is fixed by authoring a bigger height; a `UIToggle` draws its knob off its
   * track height, so it is fixed by a WRAPPER div carrying its own click binding and the zone. Court
   * ships one of each remedy.
   */
  cannotHostUnderFloor?: readonly string[];
  /**
   * Controls whose authored `px` is **DESIGN px, not CSS px** — a game that rescales them through
   * its canvas every frame, so the authored number is not the rendered size.
   *
   * ⚠️ **Without this the guard silently STOPS MEASURING them** (#1017). They author 100, and a
   * naive `px -> pt` reading calls that 100 pt, comfortably over the floor — so the controls the
   * project is tracking drop out of the under-floor set and the suite goes green while nothing on
   * screen has reached the floor. That is the "guard that cannot fail" shape, arriving through a
   * UNIT rather than a value.
   */
  designPx?: { names: ReadonlySet<string>; ptPerDesignPx(vp: Viewport): number };
  /**
   * Anti-vacuity: the corpus must hold at least this many controls.
   *
   * ⚠️ **`0` is legitimate and is not a disarmed guard** — a project with no UI yet (the starter
   * template, `demos/postfx-demo`) still gets the suite, and it reds the day a tappable is added
   * under the floor. That is the "born covered" case #1024 asks for. The file check below still
   * fails if the assets directory itself goes missing, which is the failure `0` could otherwise hide.
   */
  expectAtLeast: number;
  /** Anti-vacuity: these controls must be present by name. A renamed trait or a moved directory
   *  otherwise empties the corpus and every set-equality assertion passes vacuously. */
  expectNames?: readonly string[];
  /** Override the screen matrix. Only for a project that ships to something else. */
  viewports?: readonly Viewport[];
}

export interface TapTargetCorpus {
  files: string[];
  controls: Control[];
  viewports: readonly Viewport[];
  axis(c: Control, key: 'width' | 'height', vp: Viewport): Axis;
  /** The tap zone the renderer would ACTUALLY deliver — 0 where it would be dropped. */
  effectiveTapZonePt(c: Control, vp: Viewport): number;
  /** A resolvable axis measures under the floor, and no effective zone covers it. A MEASUREMENT. */
  resolvedUnderFloor(c: Control): boolean;
  /** Some axis is `content`/`stretched`/`%`, and no effective zone covers it. A BLIND SPOT. */
  hasUnresolvableAxis(c: Control): boolean;
  /** `100% x 100%` on every screen — a modal backdrop, not a control anyone aims at. */
  isFullScreenScrim(c: Control): boolean;
  byName(name: string): Control | undefined;
}

/** Build the corpus without registering any assertion — for a project that needs its own cases.
 *  `docs` is injectable only so a synthetic entity can reach a branch the real corpus cannot. */
export function tapTargetCorpus(
  opts: TapTargetFloorOptions,
  docs?: Array<{ file: string; entities: AuthoredEntity[] }>,
): TapTargetCorpus {
  const viewports = opts.viewports ?? SHIPPING_VIEWPORTS;
  const files = authoredFiles(opts.assetsDir);
  const src = docs ?? files.map((file) => ({
    file,
    entities: (JSON.parse(readFileSync(file, 'utf8')) as { entities?: AuthoredEntity[] }).entities ?? [],
  }));

  const controls: Control[] = [];
  for (const { file, entities } of src) {
    // Parent index, per document. Scenes address by `guid`; prefabs by numeric `localId`.
    const byKey = new Map<string | number, AuthoredEntity>();
    for (const e of entities) {
      const g = e.traits?.EntityAttributes?.guid;
      if (g) byKey.set(g, e);
      if (e.localId !== undefined) byKey.set(e.localId, e);
    }
    for (const e of entities) {
      const ui = e.traits?.UIElement;
      // Everything carrying a binding of ANY event, every TouchControl, and every swallow surface.
      // Narrowing happens per-assertion via `isTarget` / `emits`, never here.
      const hasAnyBinding = (e.traits?.UIAction?.bindings ?? []).length > 0;
      const isTouch = e.traits?.TouchControl !== undefined;
      if (!ui || !(hasAnyBinding || isTouch || uiField<boolean>(ui, 'swallowClicks') === true)) continue;
      const pid = e.traits?.EntityAttributes?.parentId;
      const hasToggle = e.traits?.UIToggle !== undefined;
      // Nearest-first ancestor chain, depth-capped so a malformed `parentId` cycle cannot hang the
      // suite (a scene file is authored data and nothing validates it before this reads it).
      const ancestorUi: Array<Fields | undefined> = [];
      let cursor = pid;
      const seen = new Set<string | number>();
      while (cursor !== undefined && cursor !== '' && !seen.has(cursor) && ancestorUi.length < 64) {
        seen.add(cursor);
        const parent = byKey.get(cursor);
        if (!parent) break;
        ancestorUi.push(parent.traits?.UIElement);
        cursor = parent.traits?.EntityAttributes?.parentId;
      }
      controls.push({
        name: e.traits?.EntityAttributes?.name ?? '(unnamed)',
        file,
        ui,
        hasToggle,
        parentUi: pid !== undefined && pid !== '' ? byKey.get(pid)?.traits?.UIElement : undefined,
        ancestorUi,
        isTarget: isTapTarget(e),
        emits: emitsExpander(e),
        hosts: hostsExpander(ui, hasToggle),
      });
    }
  }

  const axis = (c: Control, key: 'width' | 'height', vp: Viewport) =>
    resolveAxis(c.ui, key, c.parentUi, vp, opts.designPx?.names.has(c.name) ? opts.designPx.ptPerDesignPx(vp) : null);

  /** ⚠️ **The zone counts only where the renderer would deliver it.** An authored `minTapSize` on a
   *  control that takes no click (a `TouchControl`) or cannot host the expander (a `range`, a
   *  `UIToggle`, a clipped box) buys nothing on screen, so treating it as coverage here would let an
   *  inert field silently satisfy the floor — a guard disarmed by the very authoring mistake it is
   *  supposed to catch. */
  const effectiveTapZonePt = (c: Control, vp: Viewport) =>
    c.emits && c.hosts ? authoredTapZonePt(c.ui, vp) : 0;

  /** True on ANY screen — no single one is the worst case, which is why `viewports` is a matrix. */
  const onSomeScreen = (c: Control, p: (a: Axis) => boolean) => viewports.some((vp) => {
    if (effectiveTapZonePt(c, vp) >= FLOOR_PT) return false;
    return p(axis(c, 'width', vp)) || p(axis(c, 'height', vp));
  });

  return {
    files,
    controls,
    viewports,
    axis,
    effectiveTapZonePt,
    resolvedUnderFloor: (c) => onSomeScreen(c, (a) => a.kind === 'pt' && a.pt < FLOOR_PT),
    hasUnresolvableAxis: (c) => onSomeScreen(c, (a) => a.kind !== 'pt'),
    /** ⚠️ Excluded from the blind-spot list below, and it is a real exclusion rather than tidying:
     *  a dismiss scrim is `100% x 100%`, so BOTH its axes are unresolvable `%` and it would head
     *  every project's list while being the one control nobody could possibly miss. Court has ten
     *  of them, wordweave four.
     *
     *  ⚠️ **The whole ANCESTOR CHAIN must be `100%` too, and checking only the element was a hole**
     *  (#1024 close-out review). `100% x 100%` says "fill my parent" and nothing more — an icon
     *  authored that way inside a `24 x 24 px` wrapper is a 24 pt target, and a geometry-only
     *  exclusion dropped it from the blind-spot list while `resolvedUnderFloor` could not see it
     *  either (there is no `pt` axis), so it appeared in NO list and the suite stayed green. Only a
     *  chain that reaches a root — or an ancestor sized in something this cannot resolve — is
     *  genuinely full-screen. Latent when found: all 28 live matches satisfy the chain check. */
    isFullScreenScrim: (c) => {
      const fills = (ui: Fields | undefined, vp: Viewport) => {
        if (ui === undefined) return false;
        const w = resolveAxis(ui, 'width', undefined, vp);
        const h = resolveAxis(ui, 'height', undefined, vp);
        return w.kind === 'parent' && w.pct >= 100 && h.kind === 'parent' && h.pct >= 100;
      };
      return viewports.every((vp) => {
        const w = axis(c, 'width', vp);
        const h = axis(c, 'height', vp);
        if (!(w.kind === 'parent' && w.pct >= 100 && h.kind === 'parent' && h.pct >= 100)) return false;
        // Every ancestor up to the root must fill its own parent as well.
        return c.ancestorUi.every((ui) => fills(ui, vp));
      });
    },
    byName: (name) => controls.find((c) => c.name === name),
  };
}

/**
 * Register the standard floor suite for one project. Everything project-specific arrives as DATA in
 * `opts`; a project needing more adds its own `it`s over `tapTargetCorpus(opts)`.
 *
 * ⚠️ Every list is asserted as **set equality in both directions**, so the suite reds on a new
 * under-floor control (the case it exists for) AND when an accepted one is finally fixed. A
 * hand-maintained "these are fine" list drifts silently on the first control anybody adds.
 */
export function describeTapTargetFloor(opts: TapTargetFloorOptions): void {
  describe(`${opts.label} — tap targets meet the ${FLOOR_PT} pt floor, or are KNOWN (#1024)`, () => {
    const corpus = tapTargetCorpus(opts);
    const sorted = (names: readonly string[]) => [...new Set(names)].sort();
    const targets = () => corpus.controls.filter((c) => c.isTarget);

    it('reads a real corpus — a renamed directory or trait cannot make this vacuous', () => {
      expect(corpus.files.length, 'no scene or prefab files found').toBeGreaterThan(0);
      expect(corpus.controls.length).toBeGreaterThanOrEqual(opts.expectAtLeast);
      for (const name of opts.expectNames ?? []) {
        expect(corpus.controls.map((c) => c.name), `${name} is missing from the corpus`).toContain(name);
      }
      expect(corpus.viewports.length, 'the device matrix is empty').toBeGreaterThan(0);
    });

    it('every tap target MEASURED under the floor is a known, reasoned exception', () => {
      expect(sorted(targets().filter(corpus.resolvedUnderFloor).map((c) => c.name)))
        .toEqual(sorted(opts.underFloor ?? []));
    });

    it('only the named tap targets depend on an axis this guard cannot resolve', () => {
      // The guard over the guard's own blind spot. `content`, `stretched` and `%` are all sizes
      // the authored data does not state; whoever adds the next one has to say so here, which is
      // the moment to ask whether it wants a live measurement.
      expect(sorted(targets()
        .filter((c) => !corpus.isFullScreenScrim(c))
        .filter(corpus.hasUnresolvableAxis)
        .map((c) => c.name)))
        .toEqual(sorted(opts.unresolvable ?? []));
    });

    it('every control that cannot host an expander and is under the floor is KNOWN', () => {
      // ⚠️ Read over EVERY control with a binding, not just tap targets — a `range` binds
      // `event: 'change'`, so a target-only sweep cannot see it. It is still a control a finger has
      // to hit, and still one `minTapSize` cannot help (#1025).
      expect(sorted(corpus.controls
        .filter((c) => !c.hosts)
        .filter((c) => corpus.resolvedUnderFloor(c) || corpus.hasUnresolvableAxis(c))
        .map((c) => c.name)))
        .toEqual(sorted(opts.cannotHostUnderFloor ?? []));
    });

    it('no control anywhere authors an INERT minTapSize', () => {
      // The "authoring surface that is a lie" failure (CLAUDE.md): the Inspector shows the field,
      // the renderer refuses to emit or to host the expander, and the control stays under the floor.
      // Four ways that happens — the host cannot carry it (`hosts` false: a void element, a
      // `UIToggle`, a clipped box), or it never takes a click at all (`emits` false: a `change`-only
      // control, or a `TouchControl`, which `takesClick` knows nothing about).
      const lying = corpus.controls
        .filter((c) => !c.hosts || !c.emits)
        .filter((c) => corpus.viewports.some((vp) => authoredTapZonePt(c.ui, vp) > 0))
        .map((c) => c.name);
      expect(lying).toEqual([]);
    });
  });
}
