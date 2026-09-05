/** sceneChrome — write live values onto the chrome entities authored in a SCENE.
 *
 *  A game's chrome is `UIElement`/`UIAnchor` entities authored in its scene ("dom should be in the
 *  scene"), so the engine's anchor system owns WHERE each control is and what it looks like at rest.
 *  What the scene cannot author is the part that changes while playing — a button's current icon,
 *  whether an action is available, a counter's text, a narration beat. That is this module: the
 *  one place game state is pushed onto authored entities.
 *
 *  ── Two rules, and the first one is a performance correctness issue, not a preference ──
 *
 *  **Write ONLY when the value changed.** A `set` on `UIElement` has to be followed by
 *  `markUIDirty()` or the renderer never re-reads it — but that rebuilds the whole UI projection.
 *  Writing unconditionally every frame would therefore rebuild the DOM tree every frame, which
 *  wastes the work and can disturb focus/interaction state. So every write here diffs first. This is
 *  the exact OPPOSITE of the DOM chrome's old "sync unconditionally" rule, and for a good reason: assigning
 *  an unchanged `textContent` to a DOM node is free, assigning an unchanged trait is not.
 *  (`games/3d-test/runtime/PlaybackManager.ts` is the precedent: `if (el.text !== text) { set; mark }`.)
 *
 *  **Resolve by NAME, and re-resolve when the world changes.** Runtime entity ids are reassigned on
 *  every scene load, so a cached entity goes stale exactly like the `boardRootId` trap in
 *  `systems.ts`. The name cache here is READ-THROUGH (Court's original said "both caches" — it had a
 *  second one this module never carried): a hit is returned only after `world.has()` says
 *  the entity is alive and it still carries that name, so a stale entry falls back to the scan
 *  rather than writing to a destroyed one. ⚠️ The cache was **write-only** until 2026-08-19 —
 *  populated every call, read only to evict — so the scan always ran; see `findByName` for the
 *  measurement, which is also why this is a tidiness fix and not the performance win it looks like.
 *
 *  ⚠️ **This module addresses TOP-LEVEL scene entities only, and that is now a real boundary.**
 *  It once carried a `patchUIInInstance` twin for reaching a member INSIDE a prefab instance
 *  (`Num`, `Mark`, `Solved`…, names that are unique only within one instance). Its sole caller was
 *  the level selector's 25 authored tiles, and #316 moved those into a POOLED scroll view — a pool
 *  mints its own entities, so there is no stable root name to scope from and the helper had no
 *  caller left. The engine's `registerEntrySource` + member paths is the answer for that shape
 *  now; it is a better one, because it treats an ambiguous path as an error rather than writing
 *  every match. Deleted rather than kept "in case": a helper with no caller is how a stale one
 *  gets picked up and trusted.
 */

import type { World, Entity } from 'koota';
import { markUIDirty } from '../core/uiDirty';
import { EntityAttributes } from '../core/traits/EntityAttributes';
import { onWorldSwap } from '../core/ecs/world';
import { UIElement } from '../traits/UIElement';
import { UIAnchor } from '../traits/UIAnchor';
import { UIToggle } from '../traits/UIToggle';
import { Animator } from '../traits/Animator';

/** Field subset of `UIElement` this module ever writes. Deliberately narrow: a patch that could
 *  touch layout fields would let game code fight the scene over positioning, which is the whole
 *  thing the migration away from hand-computed coordinates was meant to stop. */
/** The `UIToggle` fields chrome code drives: the live state, and the two track colours a palette
 *  owns. Deliberately NOT the geometry (`knobInset`, the radii) — those are authored in
 *  the scene and game code has no business moving them. */
export interface ChromeTogglePatch {
  value?: boolean;
  disabled?: boolean;
  trackOnColor?: number;
  trackOffColor?: number;
  knobColor?: number;
}

export interface ChromeUIPatch {
  text?: string;
  textColor?: number;
  imageSrc?: string;
  opacity?: number;
  isVisible?: boolean;
  /**
   * Whether pointer events pass THROUGH this element.
   *
   * Added for layout C (#343): Back is hidden by dropping its `opacity` to 0 rather than its
   * `isVisible`, because it is the first item of a `space-between` row and collapsing it re-spaces
   * every other control (MEASURED: the coin purse jumped 167 px). An element that is invisible but
   * still in the flow must also stop swallowing taps, or the top-left corner eats presses aimed at
   * nothing — so the two fields are set together at that call site, and neither is much use alone.
   */
  pointerThrough?: boolean;
  /**
   * ⚠️ **`swallowClicks` is deliberately NOT here, and that asymmetry with `pointerThrough` above
   * is a decision, not an oversight** (#728). A swallow is a property of what a panel IS — a
   * dialog body is never sometimes-a-dialog-body — so it is authored in the scene and read from
   * there, per `CLAUDE.md` § "Author values in the SCENE and the PREFAB". `pointerThrough` earned
   * its slot here because Court genuinely toggles it at runtime (hiding a control by `opacity`
   * while keeping it in the flow, so it must stop eating taps for exactly that period).
   *
   * ⚠️ If a game ever DOES need a conditional swallow, add the field here — do NOT go back to
   * authoring a no-op `call` binding to get it. That workaround is what #728 removed, and it
   * costs the click cue and the global 300ms input lock on every tap of the panel body.
   */
  backgroundColor?: number;
  /**
   * The `backgroundColor` companion — and effectively REQUIRED alongside it.
   * `UIElement.backgroundOpacity` defaults to **0** (`traits/UIElement.ts`, and see that field's
   * own doc comment — cited without a line number on purpose, the last one went stale the moment
   * this very commit added lines above it), and the renderer
   * only paints a background when it is nonzero (`ui/UINode.tsx:267`:
   * `if (node.backgroundOpacity > 0) style.backgroundColor = …`). So `patchUI({ backgroundColor })`
   * against an entity whose scene never authored a nonzero `backgroundOpacity` writes a colour
   * that paints NOTHING — a silent no-op that looks like a success (`patchEntity` returns `true`,
   * the trait holds the value, nothing renders). `UIToggle`'s own `trackOpacity` field
   * (`traits/UIToggle.ts:50-52`) documents this exact trap as a scar that has already shipped an
   * invisible panel, and `core/ecs/traitRegistry.ts:54` treats the two fields as a PAIR for the
   * same reason.
   */
  backgroundOpacity?: number;
  borderColor?: number;
  /**
   * `borderColor`'s companions — and `borderWidth` is effectively REQUIRED alongside it, for
   * exactly the reason `backgroundOpacity` is required alongside `backgroundColor` above.
   * `UIElement.borderWidth` defaults to **0** and the renderer gates the whole border on it
   * (`ui/UINode.tsx`: `if (node.borderWidth) { … style.borderColor = … }`), so
   * `patchUI({ borderColor })` against an entity whose scene never authored a nonzero
   * `borderWidth` writes the colour, fires `markUIDirty()`, returns `true` — and paints NOTHING.
   *
   * ⚠️ This was the SIBLING the `backgroundOpacity` fix missed: that fix closed the background
   * half of a two-field trap and left the border half open, with neither companion exposed, so a
   * caller could not open the gate through this API at all. Both halves are now here.
   *
   * `borderOpacity` is NOT a trap (it defaults to 1, so a border with a width paints), but it is
   * exposed for the same reason `backgroundOpacity` is: fading a border via `opacity` would fade
   * the element's children too. Paint, not layout — the renderer is `box-sizing: border-box`
   * (`ui/UINode.tsx`), so a border draws INSIDE the box and never moves anything.
   */
  borderWidth?: number;
  borderOpacity?: number;
}

/** name → last-known entity id. Validated on every lookup (see the banner). */
const byName = new Map<string, Entity>();

// Register the world-swap listener lazily, on first lookup — not at module scope. A module-eval
// `onWorldSwap(...)` here would fire on IMPORT, and this module is pulled in by every game's chrome
// (Court's alone has 25 test files importing `resetSceneChromeCache`, several mocking
// `core/ecs/world` with an explicit export list); a call inside a function does not run until
// something actually calls it. Same pattern as `chessChatProjection.ts` / `uiTreeStore.ts`.
let _initialized = false;
function ensureInitialized(): void {
  if (_initialized) return;
  // ⚠️ Latch AFTER the registration, never before. If `onWorldSwap` throws — the exact
  // population this lazy registration exists for is tests that mock `core/ecs/world` with an
  // explicit export list, and one omitting `onWorldSwap` throws right here — a latch set first
  // would be left permanently true with NO listener registered, so every later call proceeds
  // normally and the cache silently never self-clears across a world swap again. That is the
  // defect this module was built to prevent, reintroduced by statement order.
  onWorldSwap(() => byName.clear());
  _initialized = true;
}

/**
 * A cache HIT is O(1): if `byName` names an id, and that id is still alive and still carries
 * this name, it is returned directly — no query runs. A cache MISS (a name never seen before, a
 * renamed entity, or the first lookup after `byName` was cleared by a world swap or
 * `resetSceneChromeCache`) costs one full pass over every `EntityAttributes` entity, and
 * `forEach` visits them ALL even after a match — koota's `forEach` does not break early, so
 * `if (found) return;` skips the body for the rest, not the remaining iterations. So a MISS costs
 * one pass over a few hundred entities (Court measured ~380 mid-play; the 2026-08-19
 * measurement below counted 448 in a different scene state — two snapshots of the same
 * game, not a contradiction, and neither is a budget).
 *
 * That is the whole reason chrome pushes are gated on a CHANGE rather than run per frame: see
 * `applyPaletteToChrome`'s signature gate in `palette.ts` and the flyout-art gate in `systems.ts`.
 * A new unconditional per-frame `patchUI` loop means a per-frame lookup at every one of ~100 call
 * sites, and any MISS among them (a renamed entity, a scene not yet settled) is a full world
 * scan, which will not show up as anything but a vague frame-time regression.
 *
 * ⚠️ **HISTORY: the cache was write-only until 2026-08-19.** It stored `found.id()` on every
 * call and read it back only to decide whether to EVICT a stale entry — never to short-circuit
 * the scan above — so every call, hit or miss, paid for the full pass; the "self-heals" claim
 * was true only in the sense that a thing never consulted cannot go stale. Measured then: 35
 * no-op calls over a 448-entity world (Court's live count while playing) cost **0.095 ms/frame**
 * — 0.57% of a 60 fps budget on this Mac, so it was never the performance problem it looked
 * like. It was fixed because the code should do what it says, not because a frame was being lost.
 */
function findByName(world: World, name: string): Entity | null {
  ensureInitialized();
  const cached = byName.get(name);
  if (cached !== undefined && world.has(cached) && cached.get(EntityAttributes)?.name === name) {
    return cached;
  }
  let found: Entity | undefined;
  world.query(EntityAttributes).forEach((e) => {
    if (found) return;
    if (e.get(EntityAttributes)?.name === name) found = e;
  });
  if (found) byName.set(name, found);
  else byName.delete(name);
  return found ?? null;
}

/**
 * Push `patch` onto the scene entity called `name`, if anything actually differs.
 *
 * Returns true when a write happened — mostly useful to a test that wants to prove the diffing
 * works rather than assert on the value twice.
 */
export function patchUI(world: World, name: string, patch: ChromeUIPatch): boolean {
  const entity = findByName(world, name);
  if (!entity || !entity.has(UIElement)) return false;
  return patchEntity(entity, patch);
}

/**
 * `patchUI`'s twin for the on/off switches — same name lookup, same diff-before-write, same
 * `markUIDirty`, but onto the `UIToggle` trait instead of `UIElement`.
 *
 * ⚠️ It exists because a switch's colours and its live `value` do NOT live on `UIElement`, and
 * `patchUI` is hardcoded to that trait — so a palette push aimed at a toggle silently wrote
 * nothing. Kept as a separate NAME rather than a `component` argument on `patchUI` for the same
 * reason a scoped position patcher is separate: a reviewer should see which trait is being written.
 */
export function patchToggle(world: World, name: string, patch: ChromeTogglePatch): boolean {
  const entity = findByName(world, name);
  if (!entity || !entity.has(UIToggle)) return false;
  const current = entity.get(UIToggle) as Record<string, unknown>;
  // Same "present-but-undefined means leave alone" rule as `patchEntity` — see its doc comment.
  const defined = Object.entries(patch).filter(([, v]) => v !== undefined);
  let changed = false;
  for (const [k, v] of defined) {
    if (current[k] !== v) { changed = true; break; }
  }
  if (!changed) return false;
  entity.set(UIToggle, { ...current, ...Object.fromEntries(defined) });
  markUIDirty();
  return true;
}

/**
 * Play the named entity's authored `Animator` clip from the top — the entrance-animation twin of
 * `patchUI`: same name lookup, same "the scene authored it, this only triggers it" split.
 *
 * ⚠️ **Deliberately NOT diffed, unlike every other write in this module.** The diff rule above
 * exists because an unchanged `UIElement` write costs a whole UI-projection rebuild; this writes
 * `Animator`, which the animation system reads directly, and the whole POINT of the call is to
 * rewind a playhead that may already be at a value it held before. A diff would make a re-show
 * that lands on the same frame silently skip its animation. Callers must therefore edge-detect —
 * calling this every frame would pin the clip at t=0 and it would never visibly play.
 *
 * The clip itself — duration, easing, how far it overshoots — is authored data in the `.anim.json`
 * and editable in the editor's animation panel. Nothing about the motion is decided here.
 */
export function restartClip(world: World, name: string): boolean {
  const entity = findByName(world, name);
  if (!entity || !entity.has(Animator)) return false;
  const a = entity.get(Animator)!;
  entity.set(Animator, { ...a, time: 0, playing: true });
  return true;
}

/** The diff-then-write half of `patchUI`, once an entity handle is already in hand.
 *
 *  ⚠️ **A key present with value `undefined` means "leave this field alone", not "write
 *  undefined".** Every field on `ChromeUIPatch` is optional, so `patchUI(w, n, { isVisible:
 *  flags.show })` where `flags.show` is `boolean | undefined` is ordinary caller code — and
 *  without this skip it is a trap: koota's generated SoA setter tests `if ('key' in value)`, not
 *  whether the value is defined, so the spread below would write a real `undefined` into the
 *  store. For `isVisible` that is not cosmetic — `UINode` renders `null` for a falsy `isVisible`,
 *  so the element AND its whole subtree vanish, and it does not self-heal: the next call passing
 *  the same `undefined` diffs as unchanged and writes nothing, so only an explicit `true` brings
 *  it back. Not reachable from Court (every call site there passes a definite value), but this
 *  interface is engine API now, reached by authors who have not read Court's history. */
function patchEntity(entity: Entity, patch: ChromeUIPatch): boolean {
  const current = entity.get(UIElement) as Record<string, unknown>;
  const defined = Object.entries(patch).filter(([, v]) => v !== undefined);
  let changed = false;
  for (const [k, v] of defined) {
    if (current[k] !== v) { changed = true; break; }
  }
  if (!changed) return false;
  entity.set(UIElement, { ...current, ...Object.fromEntries(defined) });
  // Without this the projection keeps serving the old values and nothing reaches the screen —
  // the same "state changed, the screen never rebuilt" class that produced four play reports in
  // Court's Phase 6, one layer up.
  markUIDirty();
  return true;
}

/**
 * Read an authored `UIElement` back, so game code can DERIVE from what the scene says instead of
 * keeping a second copy of it.
 *
 * One use (Court's region-chip flyout): a popover has to know how wide its own panel is, to keep
 * it on screen when it opens over a badge near the edge. Measuring the rendered DOM would work but
 * only AFTER a frame of it being rendered — so the first open on a narrow device would show the
 * panel cut off for one frame and then snap, which is precisely where a player is looking.
 * Computing it from the authored sizes gives the answer before the first render.
 *
 * ⚠️ This is the read-only counterpart to the "the scene owns WHERE and HOW BIG" rule — the point
 * is that the scene stays the single source and code asks IT, rather than hardcoding a size in two
 * files and watching them drift.
 */
export function readChromeUI(world: World, name: string): Record<string, unknown> | null {
  const entity = findByName(world, name);
  if (!entity || !entity.has(UIElement)) return null;
  return entity.get(UIElement) as Record<string, unknown>;
}

/**
 * The named chrome entity itself, for the callers that need a trait this module does not wrap.
 *
 * ⚠️ **Deliberately narrow.** `patchUI`/`patchToggle` exist so that a caller cannot forget the
 * diff-before-write or the `markUIDirty`, and handing out the entity gives both up — so this is
 * for traits with DIFFERENT rules, not a general escape hatch. Court's one caller is the level
 * selector's scroll view (#316): `UIScrollView` and `UIEntries` are read every tick by the
 * entries system rather than by the UI projection, so a write to `countX`/`epoch` must NOT
 * dirty the tree, and the window fields (`firstX`, `viewportWidth`) are read-only engine output.
 * Wrapping either in a `patch*` twin would state the opposite of both rules.
 */
export function findChromeEntity(world: World, name: string): Entity | null {
  return findByName(world, name);
}

/**
 * Push an anchor OFFSET onto the named entity's `UIAnchor` — the position twin of `patchUI`, for
 * the one class of value neither `patchUI` nor a scene can carry: an offset that depends on a
 * RUNTIME HOST MEASUREMENT the scene cannot know at author time (a safe-area inset is the
 * canonical example — 0 on a home-button device, non-zero on a notched one, and unknowable until
 * the host is actually measured).
 *
 * ⚠️ **Takes PERCENTAGES, never pixels**, for the same reason `patchUI` diffs before writing: a `%`
 * anchor is resolved by the engine INSIDE whatever transform the host sits under (a device-preview
 * `scale()` in the editor, none on a real device), while a pixel value computed from
 * `getBoundingClientRect` is measured OUTSIDE it. Mixing the two is a coordinate-SPACE bug that
 * looks correct on one and wrong on the other; refusing px here makes it unrepresentable rather
 * than merely discouraged.
 */
export interface ChromeAnchorPatch {
  leftPct?: number;
  topPct?: number;
  /** The `bottom` offset. On a bottom-anchored element this LIFTS the box — the shape a banner
   *  strip held above a home indicator takes, since the inset is a runtime fact the scene cannot
   *  author. */
  bottomPct?: number;
}

/**
 * Write `patch` onto the named entity's `UIAnchor`, diffed like `patchUI` — see `ChromeAnchorPatch`
 * above for what this is for and why it takes percentages.
 */
export function patchAnchorPct(world: World, name: string, patch: ChromeAnchorPatch): boolean {
  const entity = findByName(world, name);
  if (!entity || !entity.has(UIAnchor)) return false;
  const current = entity.get(UIAnchor) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  if (patch.leftPct !== undefined) { next.left = patch.leftPct; next.leftUnit = '%'; }
  if (patch.topPct !== undefined) { next.top = patch.topPct; next.topUnit = '%'; }
  if (patch.bottomPct !== undefined) { next.bottom = patch.bottomPct; next.bottomUnit = '%'; }
  // Sub-pixel churn would re-write (and so re-project) the whole UI tree every frame, which is the
  // cost `patchUI`'s diffing exists to avoid. A 0.01% deadband is well under a physical pixel at
  // any viewport this ships on.
  const moved = (a: unknown, b: unknown) => Math.abs(Number(a ?? 0) - Number(b ?? 0)) > 0.01;
  if (!moved(next.left, current.left) && !moved(next.top, current.top) &&
      !moved(next.bottom, current.bottom) &&
      next.leftUnit === current.leftUnit && next.topUnit === current.topUnit &&
      next.bottomUnit === current.bottomUnit) return false;
  entity.set(UIAnchor, next);
  markUIDirty();
  return true;
}

/** Drop the name caches — call on teardown/world swap so a stale id can never be reused.
 *
 *  ⚠️ Now redundant with the automatic `onWorldSwap` clear above on the common path (a fresh
 *  `createTestWorld()` per test already triggers it) — kept as an explicit, always-safe seam
 *  because a wide set of existing tests already call it by hand, and a manual call when the
 *  cache is already empty costs nothing. */
export function resetSceneChromeCache(): void {
  byName.clear();
}
