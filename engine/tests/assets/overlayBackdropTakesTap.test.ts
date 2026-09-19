/**
 * A painted full-screen OVERLAY must take the tap — or say, in data, that it lets taps through (#1423).
 *
 * `UINode.tsx` hit-tests a container only when it has a click `UIAction`, `UIElement.swallowClicks`
 * or scroll overflow. Anything else keeps the UIRenderer root's inherited `pointer-events: none`,
 * so a dimmed full-screen backdrop is PAINT ONLY: it looks like it blocks the game behind it, and a
 * tap on it lands on whatever is underneath. Observed in wordweave (#1423): with `TooEasyRoot` up,
 * `elementsFromPoint` at the HUD zoom button returned the button, not the backdrop. The same shape
 * sat in space-console, audio-demo and sling — one field missing per scene, and nothing noticed.
 *
 * So the rule, per `docs/ui-system.md` § Dialog dismissal: an entity that is
 *   - full-screen (width AND height >= 100% — or 100vw/100vh),
 *   - painted (`backgroundOpacity > 0`, or an image — a `backgroundColor` alone paints nothing), and
 *   - an overlay (it or an ancestor has `zIndex > 0`, is authored hidden, or is shown by a
 *     `UIBinding.visibleBinding` — something is drawn beneath it)
 * must carry a click `UIAction` (dismiss), `swallowClicks` (block), scroll overflow, or an explicit
 * `pointerThrough: true` (the author's statement that taps reaching the layer below is intended —
 * sling's "Tap to play again", wordweave's decorative backgrounds).
 *
 * Out of scope, deliberately:
 *   - an always-visible base background with no zIndex: nothing sits under it to reach.
 *   - a `Canvas2D` host: it is a viewport for 2D content with its own pick path, not a backdrop.
 *   - a painted child of a scrim that already takes the tap (`coveredByAncestor`).
 *
 * Known false positive, loud rather than silent: a full-screen painted BASE background inside a
 * container that is raised or store-bound (a HUD root with `visibleBinding: 'playing'`) reads as an
 * overlay with nothing beneath it. None exists today; the answer is `pointerThrough: true` on it.
 *
 * A preventative guard, not an inventory: the corpus half must stay at zero findings, and the
 * named-overlay test below is what stops "zero" from meaning "the predicate stopped matching".
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { hasInternalGames } from '../helpers/repoLayout';

type Binding = { event?: string };
type RawEntity = { name?: string; localId?: number; traits?: Record<string, unknown> };
type UI = {
  width?: number; height?: number; widthUnit?: string; heightUnit?: string;
  backgroundOpacity?: number; imageSrc?: string; zIndex?: number; isVisible?: boolean;
  swallowClicks?: boolean; pointerThrough?: boolean; overflow?: string;
};

/** Full along one axis: >= 100 of `%` (the serializer's default when the unit is omitted on disk)
 *  or of the matching viewport unit. */
const isFull = (value: number | undefined, unit: string | undefined, viewportUnit: 'vw' | 'vh') =>
  (value ?? 0) >= 100 && (unit === undefined || unit === '%' || unit === viewportUnit);

/** Something is drawn beneath it: it (or a container it sits in) is layered up, starts hidden, or
 *  is shown by a store binding. A scrim that is visible at z 0 under a hidden/raised parent is the
 *  same overlay, so the check walks the ancestors. */
const raisesOrHides = (e: RawEntity) => {
  const u = (e.traits?.UIElement ?? {}) as UI;
  const binding = e.traits?.UIBinding as { visibleBinding?: string } | undefined;
  return (u.zIndex ?? 0) > 0 || u.isVisible === false || !!binding?.visibleBinding;
};

function isPaintedOverlay(e: RawEntity, parentOf: (e: RawEntity) => RawEntity | undefined = () => undefined): boolean {
  const u = e.traits?.UIElement as UI | undefined;
  if (!u || e.traits?.Canvas2D) return false;
  const fullScreen = isFull(u.width, u.widthUnit, 'vw') && isFull(u.height, u.heightUnit, 'vh');
  const painted = (u.backgroundOpacity ?? 0) > 0 || !!u.imageSrc;
  if (!fullScreen || !painted) return false;
  for (let n: RawEntity | undefined = e, depth = 0; n && depth < 64; n = parentOf(n), depth++) {
    if (raisesOrHides(n)) return true;
  }
  return false;
}

/** Mirrors UINode's own hit-test decision (`isInteractive` / `swallowsClicks` / scroll), plus the
 *  explicit pass-through statement. */
function takesOrDeclaresTap(e: RawEntity): boolean {
  const u = e.traits?.UIElement as UI;
  const bindings = ((e.traits?.UIAction as { bindings?: Binding[] } | undefined)?.bindings) ?? [];
  const click = bindings.some((b) => (b.event || 'click') === 'click');
  return click || u.swallowClicks === true || u.overflow === 'scroll' || u.pointerThrough === true;
}

/** A painted child of a scrim that already takes the tap is covered by that scrim: a childful node
 *  inherits the scrim's `auto` and the click bubbles to it, a leaf is `none` and the hit lands on the
 *  scrim beneath. A `pointerThrough` ancestor ends the search, since it hands `none` down instead. */
function coveredByAncestor(e: RawEntity, parentOf: (e: RawEntity) => RawEntity | undefined): boolean {
  for (let n = parentOf(e), depth = 0; n && depth < 64; n = parentOf(n), depth++) {
    const u = n.traits?.UIElement as UI | undefined;
    if (!u) continue;
    if (u.pointerThrough === true) return false;
    if (takesOrDeclaresTap(n)) return true;
  }
  return false;
}

const EXCLUDE = ['dist', 'ios', 'android', 'ads', 'release', 'node_modules'];
const files = [
  ...repoFiles({ under: ['games', 'demos'], match: /\.scene\.json$/, exclude: EXCLUDE, floor: 0 }),
  ...repoFiles({ under: ['games', 'demos'], match: /\.prefab\.json$/, exclude: EXCLUDE, floor: 0 }),
];

function overlaysInCorpus(): { file: string; name: string; entity: RawEntity; covered: boolean }[] {
  const out: { file: string; name: string; entity: RawEntity; covered: boolean }[] = [];
  for (const { rel, abs } of files) {
    const data = JSON.parse(fs.readFileSync(abs, 'utf8')) as { entities?: RawEntity[] };
    const entities = data.entities ?? [];
    // A scene's parentId is the parent's guid; a prefab's is the parent's localId.
    const byKey = new Map<unknown, RawEntity>();
    for (const e of entities) {
      const guid = (e.traits?.EntityAttributes as { guid?: string } | undefined)?.guid;
      if (guid) byKey.set(guid, e);
      if (e.localId !== undefined) byKey.set(e.localId, e);
    }
    const parentOf = (e: RawEntity) => {
      const p = (e.traits?.EntityAttributes as { parentId?: unknown } | undefined)?.parentId;
      return p === undefined || p === '' ? undefined : byKey.get(p);
    };
    for (const entity of entities) {
      if (isPaintedOverlay(entity, parentOf)) {
        out.push({ file: rel, name: entity.name ?? '?', entity, covered: coveredByAncestor(entity, parentOf) });
      }
    }
  }
  return out;
}

const ui = (fields: UI, extra: Record<string, unknown> = {}): RawEntity =>
  ({ name: 'X', traits: { UIElement: fields, ...extra } });
const DIM: UI = { width: 100, height: 100, backgroundOpacity: 0.8, zIndex: 40 };

describe('isPaintedOverlay / takesOrDeclaresTap (#1423)', () => {
  it('a dimmed full-screen card with nothing authored is an overlay that does NOT take the tap', () => {
    const e = ui(DIM);
    expect(isPaintedOverlay(e)).toBe(true);
    expect(takesOrDeclaresTap(e)).toBe(false);
  });

  it('accepts each way of taking or declaring the tap', () => {
    expect(takesOrDeclaresTap(ui({ ...DIM, swallowClicks: true }))).toBe(true);
    expect(takesOrDeclaresTap(ui({ ...DIM, pointerThrough: true }))).toBe(true);
    expect(takesOrDeclaresTap(ui({ ...DIM, overflow: 'scroll' }))).toBe(true);
    expect(takesOrDeclaresTap(ui(DIM, { UIAction: { bindings: [{ kind: 'set' }] } }))).toBe(true);
    // A non-click binding is not a tap target — UINode would leave it at pointer-events:none.
    expect(takesOrDeclaresTap(ui(DIM, { UIAction: { bindings: [{ event: 'change' }] } }))).toBe(false);
  });

  it('counts hidden-by-default as an overlay, and an image as paint', () => {
    expect(isPaintedOverlay(ui({ width: 100, height: 100, backgroundOpacity: 0.5, isVisible: false }))).toBe(true);
    expect(isPaintedOverlay(ui({ width: 100, height: 100, imageSrc: 'g', zIndex: 5 }))).toBe(true);
  });

  it('counts a store-bound scrim, a scrim inside a hidden/raised container, and vw/vh sizing', () => {
    const base: UI = { width: 100, height: 100, backgroundOpacity: 0.6 };
    expect(isPaintedOverlay(ui(base, { UIBinding: { visibleBinding: 'gameOver' } }))).toBe(true);
    const hiddenParent = ui({ isVisible: false });
    const raisedParent = ui({ zIndex: 50 });
    expect(isPaintedOverlay(ui(base), () => hiddenParent)).toBe(true);
    expect(isPaintedOverlay(ui(base), (e) => (e === raisedParent ? undefined : raisedParent))).toBe(true);
    expect(isPaintedOverlay(ui(base), () => undefined)).toBe(false);
    expect(isPaintedOverlay(ui({ ...DIM, widthUnit: 'vw', heightUnit: 'vh' }))).toBe(true);
    expect(isPaintedOverlay(ui({ ...DIM, widthUnit: 'vh' }))).toBe(false);
  });

  it('a painted child of a scrim that takes the tap is covered by it — unless a pointerThrough sits between', () => {
    const child = ui({ width: 100, height: 100, backgroundOpacity: 0.5 });
    const swallowScrim = ui({ ...DIM, isVisible: false, swallowClicks: true });
    const dismissScrim = ui(DIM, { UIAction: { bindings: [{ kind: 'set' }] } });
    const plainScrim = ui({ ...DIM, isVisible: false });
    expect(coveredByAncestor(child, (e) => (e === child ? swallowScrim : undefined))).toBe(true);
    expect(coveredByAncestor(child, (e) => (e === child ? dismissScrim : undefined))).toBe(true);
    expect(coveredByAncestor(child, (e) => (e === child ? plainScrim : undefined))).toBe(false);
    const through = ui({ width: 100, height: 100, pointerThrough: true });
    expect(coveredByAncestor(child, (e) => (e === child ? through : e === through ? swallowScrim : undefined))).toBe(false);
  });

  it('ignores what cannot cover anything:a base background, a colour with no opacity, a partial box, px sizes, a Canvas2D host', () => {
    expect(isPaintedOverlay(ui({ width: 100, height: 100, backgroundOpacity: 1 }))).toBe(false);
    expect(isPaintedOverlay(ui({ width: 100, height: 100, zIndex: 40 }))).toBe(false);
    expect(isPaintedOverlay(ui({ ...DIM, width: 88 }))).toBe(false);
    expect(isPaintedOverlay(ui({ ...DIM, widthUnit: 'px' }))).toBe(false);
    expect(isPaintedOverlay(ui(DIM, { Canvas2D: {} }))).toBe(false);
  });
});

describe('committed scenes/prefabs: every painted full-screen overlay takes the tap (#1423)', () => {
  it('no overlay leaves the tap to whatever is underneath', () => {
    const leaks = overlaysInCorpus()
      .filter((o) => !takesOrDeclaresTap(o.entity) && !o.covered)
      .map((o) => `${o.file} :: ${o.name}`);
    expect(leaks, 'give the backdrop swallowClicks (block), a click UIAction (dismiss — docs/ui-system.md '
      + '§ Dialog dismissal), or pointerThrough:true if taps are MEANT to reach the layer below').toEqual([]);
  });

  it.skipIf(!hasInternalGames())('sees the #1423 backdrops as overlays (the guard is not passing vacuously)', () => {
    const seen = new Set(overlaysInCorpus().map((o) => `${o.file} :: ${o.name}`));
    for (const key of [
      'games/wordweave/runtime/assets/scenes/main.scene.json :: TooEasyRoot',
      'games/wordweave/runtime/assets/scenes/main.scene.json :: DailyIntroRoot',
      'games/space-console/runtime/assets/scenes/Station.scene.json :: SettingsPanel',
      'games/space-console/runtime/assets/scenes/Station.scene.json :: CreditsPanel',
      'games/space-console/runtime/assets/scenes/Warp.scene.json :: CreditsPanel',
      'games/space-console/runtime/assets/UI/SettingsPanel.prefab.json :: SettingsPanel',
      'games/audio-demo/runtime/assets/scenes/main.scene.json :: CreditsDialog',
      'games/sling/runtime/assets/scenes/Base.scene.json :: ResultRoot',
    ]) expect(seen, key).toContain(key);
  });
});
