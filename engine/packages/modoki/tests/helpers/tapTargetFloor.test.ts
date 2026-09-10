/**
 * The tap-target floor resolver's own predicates (#1024).
 *
 * ⚠️ **These exist because NO project corpus can falsify them.** Mutation checks on wordweave's
 * original copy showed several branches staying green when deleted — every auto-sized tappable there
 * already carried a `minTapSize`, so the zone short-circuit returned first, and wordweave authors no
 * `UIToggle` at all. A guard whose branches are only reachable through data that does not exist yet
 * is this repo's dominant defect class, so each branch is pinned directly, at its boundaries.
 *
 * The corpus-driven half lives with each project (`games/court/tests/tapTargets.test.ts` and eight
 * siblings). This file is the model; those are the data.
 */

import { describe, expect, it } from 'vitest';
import {
  FLOOR_PT, SHIPPING_VIEWPORTS, resolveAxis, hostsExpander, isTapTarget,
  emitsExpander, ptPerUnit, authoredTapZonePt, tapTargetCorpus,
  type AuthoredEntity, type Viewport,
} from './tapTargetFloor';
import { SHIPPING_DEVICE_CATEGORIES } from '../../src/editor/scene/devicePresets';

/** A viewport with no relationship to any real device, so an assertion cannot pass by coincidence
 *  with a preset's geometry. */
const VP: Viewport = { name: 'synthetic', w: 400, h: 800 };

/** Options for a corpus fed synthetic documents — the directories are never read. */
const SYNTHETIC = { label: 'synthetic', assetsDir: '/nonexistent', expectAtLeast: 0 };
const CLICK = { bindings: [{ event: 'click' }] };
/** A 20 pt square — under the floor on BOTH axes. ⚠️ The units are explicit because `widthUnit`
 *  and `heightUnit` default to `'%'`, so a bare `{ width: 20 }` is 20 PERCENT and would land in the
 *  unresolvable list instead of the measured one. */
const PX_20 = { width: 20, widthUnit: 'px', height: 20, heightUnit: 'px' };
const doc = (entities: AuthoredEntity[]) => [{ file: 'synthetic', entities }];

describe('the device matrix', () => {
  /**
   * ⚠️ **A LITERAL, and it is load-bearing** (#1024 close-out review, F1). Every other assertion in
   * the repo about which categories ship now DERIVES from `SHIPPING_DEVICE_CATEGORIES` — including
   * `games/court/tests/narrationRoom.test.ts`'s category-set pin, which compared the engine's
   * categories against that same constant and so went green when a widening edited both sides. One
   * literal has to survive somewhere, or adding a category to the allow-list is a change nothing
   * asks a human about. This is that literal.
   *
   * Widening it is legitimate — it just has to be deliberate: add the category here, and re-read
   * every guard that sweeps devices (Court's narration room, the tap-target floor) to check the new
   * geometry is one they were meant to hold on.
   */
  it('pins the shipping-category allow-list against a literal', () => {
    expect([...SHIPPING_DEVICE_CATEGORIES]).toEqual(['Apple', 'Samsung', 'Google', 'Android']);
  });

  it('holds only real handhelds, and both extremes a floor can hide behind', () => {
    // ⚠️ An ALLOW-list of categories, so a new preset category defaults to EXCLUDED. The two
    // extremes are asserted because NEITHER is the worst case on its own: a `vmin` control clears
    // 44 at 375 and misses at 360, a `vh` one is the other way round.
    expect(SHIPPING_VIEWPORTS.length).toBeGreaterThan(10);
    expect(SHIPPING_VIEWPORTS.map((v) => v.name)).not.toContain('Free');
    expect(SHIPPING_VIEWPORTS.some((v) => v.name.startsWith('16:9'))).toBe(false);
    expect(Math.min(...SHIPPING_VIEWPORTS.map((v) => v.w)), 'narrowest').toBe(360);
    expect(Math.min(...SHIPPING_VIEWPORTS.map((v) => v.h)), 'shortest').toBe(667);
    // Sorted by width, so a reader can see the worst case first.
    expect([...SHIPPING_VIEWPORTS].sort((a, b) => a.w - b.w)).toEqual(SHIPPING_VIEWPORTS);
  });
});

describe('resolving one axis', () => {
  it('converts each viewport unit, and refuses to convert a %', () => {
    expect(ptPerUnit('px', VP)).toBe(1);
    expect(ptPerUnit('vw', VP)).toBe(4);
    expect(ptPerUnit('vh', VP)).toBe(8);
    expect(ptPerUnit('vmin', VP)).toBe(4);
    expect(ptPerUnit('vmax', VP)).toBe(8);
    expect(ptPerUnit('%', VP)).toBeNull();
  });

  it('reads an authored length through the unit, and a % as parent-relative', () => {
    expect(resolveAxis({ width: 48, widthUnit: 'px' }, 'width', undefined, VP)).toEqual({ kind: 'pt', pt: 48 });
    expect(resolveAxis({ width: 11, widthUnit: 'vmin' }, 'width', undefined, VP)).toEqual({ kind: 'pt', pt: 44 });
    // ⚠️ **No `widthUnit` at all resolves as a `%`, because that is `UIElement`'s DEFAULT** — and a
    // scene save STRIPS a field left at its default, so this is the shape most authored controls
    // actually have on disk. Read through the trait, never hardcoded: a literal `'px'` here would
    // silently call every unitless control a pixel size and shadow the trait besides.
    expect(resolveAxis({ width: 100 }, 'width', undefined, VP)).toEqual({ kind: 'parent', pct: 100 });
    expect(resolveAxis({ width: 20 }, 'width', undefined, VP)).toEqual({ kind: 'parent', pct: 20 });
  });

  it('stretches an auto CROSS axis only, and only under alignItems stretch', () => {
    // A column parent stretches its child's WIDTH, not its height.
    const col = { flexDirection: 'column', alignItems: 'stretch' };
    expect(resolveAxis({}, 'width', col, VP)).toEqual({ kind: 'stretched' });
    expect(resolveAxis({}, 'height', col, VP)).toEqual({ kind: 'content' });
    // A row parent stretches the HEIGHT.
    expect(resolveAxis({}, 'height', { flexDirection: 'row', alignItems: 'stretch' }, VP))
      .toEqual({ kind: 'stretched' });
    // `center` stretches nothing.
    const row = { flexDirection: 'row', alignItems: 'center' };
    expect(resolveAxis({}, 'width', row, VP)).toEqual({ kind: 'content' });
    expect(resolveAxis({}, 'height', row, VP)).toEqual({ kind: 'content' });
    // No parent at all (a scene root) cannot stretch.
    expect(resolveAxis({}, 'width', undefined, VP)).toEqual({ kind: 'content' });
  });

  it('rescales a DESIGN-px axis and leaves every other unit alone', () => {
    // ⚠️ The "guard that cannot fail" shape arriving through a UNIT rather than a value: a control
    // the game rescales through its canvas authors 100 and a naive reading calls that 100 pt.
    const scaled = resolveAxis({ width: 100, widthUnit: 'px' }, 'width', undefined, VP, 0.347);
    expect(scaled.kind).toBe('pt');
    expect(scaled.kind === 'pt' && scaled.pt).toBeCloseTo(34.7, 10);
    // Only `px` is design-space. A `vmin` on the same entity is still viewport-relative.
    expect(resolveAxis({ width: 11, widthUnit: 'vmin' }, 'width', undefined, VP, 0.347))
      .toEqual({ kind: 'pt', pt: 44 });
  });
});

describe('deciding what an axis says about the floor', () => {
  // ⚠️ Only `pt` is a MEASUREMENT. There is deliberately no single `axisUnderFloor` predicate any
  // more — an earlier cut had one and it presumed `content`/`% < 100` short and `stretched`
  // adequate, presumptions the authored data cannot support in either direction. The corpus asks
  // the two questions separately, and these cases pin the boundary of each.
  const one = (ui: Record<string, unknown>) => tapTargetCorpus(SYNTHETIC, doc([
    { traits: { EntityAttributes: { name: 'X' }, UIElement: ui, UIAction: CLICK } },
  ]));

  it('compares a resolvable length against the floor, INCLUSIVELY', () => {
    const at = one({ width: FLOOR_PT, widthUnit: 'px', height: FLOOR_PT, heightUnit: 'px' });
    expect(at.resolvedUnderFloor(at.byName('X')!)).toBe(false);
    const under = one({ width: FLOOR_PT - 0.01, widthUnit: 'px', height: FLOOR_PT, heightUnit: 'px' });
    expect(under.resolvedUnderFloor(under.byName('X')!)).toBe(true);
  });

  it('calls a content, stretched or % axis UNRESOLVABLE rather than short or adequate', () => {
    for (const ui of [
      { height: 60, heightUnit: 'px' },                    // width auto -> content
      { width: 62, height: 60, heightUnit: 'px' },         // width 62% -> parent
      { width: 100, height: 60, heightUnit: 'px' },        // width 100% -> parent
    ]) {
      const c = one(ui);
      expect(c.resolvedUnderFloor(c.byName('X')!), JSON.stringify(ui)).toBe(false);
      expect(c.hasUnresolvableAxis(c.byName('X')!), JSON.stringify(ui)).toBe(true);
    }
  });
});

describe('whether minTapSize does anything at all', () => {
  it('refuses a void element, a UIToggle host and a clipped box', () => {
    expect(hostsExpander({ elementType: 'div' }, false)).toBe(true);
    expect(hostsExpander({}, false), 'elementType defaults to div').toBe(true);
    expect(hostsExpander({ elementType: 'div' }, true), 'a UIToggle owns its inner layout').toBe(false);
    expect(hostsExpander({ elementType: 'range' }, false)).toBe(false);
    expect(hostsExpander({ elementType: 'input' }, false)).toBe(false);
    expect(hostsExpander({ overflow: 'hidden' }, false)).toBe(false);
    expect(hostsExpander({ overflow: 'scroll' }, false)).toBe(false);
    expect(hostsExpander({ overflow: 'visible' }, false)).toBe(true);
  });

  it('resolves an authored zone through its unit, and a % to zero', () => {
    expect(authoredTapZonePt({ minTapSize: 48 }, VP), 'minTapSizeUnit defaults to px').toBe(48);
    expect(authoredTapZonePt({ minTapSize: 12, minTapSizeUnit: 'vmin' }, VP)).toBe(48);
    expect(authoredTapZonePt({}, VP)).toBe(0);
    // Conservative and loud rather than guessed: a `%` zone resolves to 0, so the control is treated
    // as uncovered instead of silently credited with a size nothing here can compute.
    expect(authoredTapZonePt({ minTapSize: 50, minTapSizeUnit: '%' }, VP)).toBe(0);
  });
});

describe('who is a tap target, and who gets an expander', () => {
  const E = (traits: AuthoredEntity['traits']) => ({ traits } as AuthoredEntity);
  const click = E({ UIAction: CLICK });
  const implicit = E({ UIAction: { bindings: [{}] } });               // event defaults to click
  const change = E({ UIAction: { bindings: [{ event: 'change' }] } }); // a slider
  const shield = E({ UIElement: { swallowClicks: true } });            // a modal backdrop
  const pad = E({ UIElement: {}, TouchControl: { action: 'moveLeft' } });
  const inert = E({ UIElement: {} });

  it('counts a click binding and a TouchControl, and no other binding', () => {
    // ⚠️ A binding is not a click binding — a slider binds `change` and is not aimed at. And a
    // `TouchControl` NEVER carries a UIAction (its own docblock forbids it), so a UIAction-only
    // sweep sees zero of them; that blind spot is what #1024's filed census had.
    expect([click, implicit, change, shield, pad, inert].map(isTapTarget))
      .toEqual([true, true, false, false, true, false]);
  });

  it('drops a shield whose swallow is overridden by pointerThrough', () => {
    // ⚠️ `swallowsClicks` is `swallowClicks === true && !pointerThrough` (`UINode.tsx:1181`) —
    // `UIElement`'s own doc says "Contradicts `pointerThrough`, which WINS". Reading only
    // `swallowClicks` reported `emits: true` for an element the renderer drops entirely, so an
    // authored `minTapSize` there passed the inert check while doing nothing on screen. Nothing in
    // any corpus authors both fields today, so only this case can tell the two reads apart.
    const shielded = E({ UIElement: { swallowClicks: true } });
    const through = E({ UIElement: { swallowClicks: true, pointerThrough: true } });
    expect(emitsExpander(shielded)).toBe(true);
    expect(emitsExpander(through)).toBe(false);
    // A click binding still wins — `pointerThrough` only cancels the SWALLOW half.
    expect(emitsExpander(E({ UIElement: { swallowClicks: true, pointerThrough: true }, UIAction: CLICK }))).toBe(true);
  });

  it('emits an expander for a shield but NOT for a TouchControl', () => {
    // ⚠️ The asymmetry both ways. A shield is not aimed at, yet `takesClick` is true for it, so an
    // authored `minTapSize` on one is really emitted and the inert check must look wider than the
    // target list. A pad is aimed at, yet `takesClick` is FALSE — `UINode.tsx` reads click bindings
    // and knows nothing about `TouchControl` — so its zone would be silently dropped, with no DEV
    // warning either, because the branch that warns sits inside the gate this fails.
    expect([click, implicit, change, shield, pad, inert].map(emitsExpander))
      .toEqual([true, true, false, true, false, false]);
  });
});

describe('building a corpus', () => {
  it('reads the toggle flag off the UIToggle TRAIT, never off UIElement', () => {
    // `uiTreeStore.ts` builds `node.toggle` from `entity.has(UIToggle)`. Reading a `toggle` key off
    // `UIElement` yields `undefined` for every entity in the repo, so that check would be VACUOUS —
    // and it would mis-classify Court's `SettingsHapticsToggle`, a `div` carrying the trait.
    const [real] = tapTargetCorpus(SYNTHETIC, doc([
      { traits: { EntityAttributes: { name: 'RealToggle' }, UIElement: {}, UIAction: CLICK, UIToggle: { value: false } } },
    ])).controls;
    expect(real.hasToggle).toBe(true);
    expect(real.hosts, 'a UIToggle host cannot carry the expander').toBe(false);

    const [decoy] = tapTargetCorpus(SYNTHETIC, doc([
      { traits: { EntityAttributes: { name: 'Decoy' }, UIElement: { toggle: true }, UIAction: CLICK } },
    ])).controls;
    expect(decoy.hasToggle, 'a `toggle` key on UIElement is not a field of that trait at all').toBe(false);
    expect(decoy.hosts).toBe(true);
  });

  it('indexes parents by guid AND by localId, because scenes and prefabs address differently', () => {
    const stretchy = { flexDirection: 'column', alignItems: 'stretch' };
    const byGuid = tapTargetCorpus(SYNTHETIC, doc([
      { traits: { EntityAttributes: { name: 'Parent', guid: 'g-1' }, UIElement: stretchy } },
      { traits: { EntityAttributes: { name: 'Child', parentId: 'g-1' }, UIElement: {}, UIAction: CLICK } },
    ]));
    expect(byGuid.axis(byGuid.byName('Child')!, 'width', VP)).toEqual({ kind: 'stretched' });

    const byLocalId = tapTargetCorpus(SYNTHETIC, doc([
      { localId: 7, traits: { EntityAttributes: { name: 'Parent' }, UIElement: stretchy } },
      { traits: { EntityAttributes: { name: 'Child', parentId: 7 }, UIElement: {}, UIAction: CLICK } },
    ]));
    expect(byLocalId.axis(byLocalId.byName('Child')!, 'width', VP)).toEqual({ kind: 'stretched' });

    // An unresolvable parentId must not silently become "stretched" — it becomes no parent at all.
    const orphan = tapTargetCorpus(SYNTHETIC, doc([
      { traits: { EntityAttributes: { name: 'Child', parentId: 'g-missing' }, UIElement: {}, UIAction: CLICK } },
    ]));
    expect(orphan.axis(orphan.byName('Child')!, 'width', VP)).toEqual({ kind: 'content' });
  });

  it('credits a tap zone ONLY where the renderer would deliver it', () => {
    // ⚠️ Otherwise an inert `minTapSize` silently satisfies the floor — the guard disarmed by the
    // very authoring mistake it exists to catch. All three of these author a 48 pt zone on a 20 pt
    // box; only the first one gets it.
    const c = tapTargetCorpus(SYNTHETIC, doc([
      { traits: { EntityAttributes: { name: 'Button' }, UIElement: { ...PX_20, minTapSize: 48 }, UIAction: CLICK } },
      { traits: { EntityAttributes: { name: 'Pad' }, UIElement: { ...PX_20, minTapSize: 48 }, TouchControl: {} } },
      { traits: { EntityAttributes: { name: 'Slider' }, UIElement: { ...PX_20, minTapSize: 48, elementType: 'range' }, UIAction: CLICK } },
    ]));
    expect(c.effectiveTapZonePt(c.byName('Button')!, VP)).toBe(48);
    expect(c.effectiveTapZonePt(c.byName('Pad')!, VP), 'takes no click, so no expander').toBe(0);
    expect(c.effectiveTapZonePt(c.byName('Slider')!, VP), 'a void element cannot host one').toBe(0);

    expect(c.resolvedUnderFloor(c.byName('Button')!)).toBe(false);
    expect(c.resolvedUnderFloor(c.byName('Pad')!)).toBe(true);
    expect(c.resolvedUnderFloor(c.byName('Slider')!)).toBe(true);
  });

  it('separates a MEASURED shortfall from an unresolvable axis', () => {
    // The two lists a project keeps, and the reason they are two: `62% x content` measured 133x46 pt
    // live in one game and 16.90x40.21 pt in another. Same authored shape, opposite verdicts.
    const c = tapTargetCorpus(SYNTHETIC, doc([
      { traits: { EntityAttributes: { name: 'Small' }, UIElement: PX_20, UIAction: CLICK } },
      { traits: { EntityAttributes: { name: 'Auto' }, UIElement: { width: 200, widthUnit: 'px' }, UIAction: CLICK } },
      { traits: { EntityAttributes: { name: 'Big' }, UIElement: { width: 200, widthUnit: 'px', height: 60, heightUnit: 'px' }, UIAction: CLICK } },
      { traits: { EntityAttributes: { name: 'Scrim' }, UIElement: { width: 100, height: 100 }, UIAction: CLICK } },
    ]));
    expect(c.controls.filter(c.resolvedUnderFloor).map((x) => x.name)).toEqual(['Small']);
    expect(c.controls.filter(c.hasUnresolvableAxis).map((x) => x.name)).toEqual(['Auto', 'Scrim']);
    // `Scrim` is 100% x 100% — unresolvable on both axes and yet the one control nobody can miss.
    expect(c.controls.filter(c.isFullScreenScrim).map((x) => x.name)).toEqual(['Scrim']);
    expect(c.isFullScreenScrim(c.byName('Auto')!)).toBe(false);
  });

  it('only calls a 100% control full-screen when its whole ANCESTOR CHAIN fills too', () => {
    // ⚠️ The hole this closes: `100% x 100%` says "fill my parent" and nothing more. An icon
    // authored that way inside a 24 px wrapper is a 24 pt target — and with no `pt` axis to measure
    // it lands in NO list at all if the exclusion looks only at the element. Checking the chain is
    // what keeps it in the blind-spot register, which is where a control nobody can size belongs.
    const fill = { width: 100, height: 100 };
    const c = tapTargetCorpus(SYNTHETIC, doc([
      { traits: { EntityAttributes: { name: 'Root', guid: 'g-root' }, UIElement: fill } },
      { traits: { EntityAttributes: { name: 'RealScrim', guid: 'g-s', parentId: 'g-root' }, UIElement: fill, UIAction: CLICK } },
      { traits: { EntityAttributes: { name: 'Wrapper', guid: 'g-w' }, UIElement: { width: 24, widthUnit: 'px', height: 24, heightUnit: 'px' } } },
      { traits: { EntityAttributes: { name: 'TinyIcon', parentId: 'g-w' }, UIElement: fill, UIAction: CLICK } },
      // Two levels up: the near parent fills, the far one does not.
      { traits: { EntityAttributes: { name: 'Mid', guid: 'g-m', parentId: 'g-w' }, UIElement: fill } },
      { traits: { EntityAttributes: { name: 'NestedIcon', parentId: 'g-m' }, UIElement: fill, UIAction: CLICK } },
    ]));
    expect(c.controls.filter(c.isFullScreenScrim).map((x) => x.name)).toEqual(['RealScrim']);
    // Both of the non-scrims stay in the blind-spot register rather than vanishing from both lists.
    for (const name of ['TinyIcon', 'NestedIcon']) {
      expect(c.hasUnresolvableAxis(c.byName(name)!), name).toBe(true);
      expect(c.resolvedUnderFloor(c.byName(name)!), name).toBe(false);
    }
  });

  it('walks the whole assets tree, and survives a parentId cycle', () => {
    // A scene file is authored data and nothing validates it before this reads it, so a cycle must
    // terminate rather than hang the suite.
    const c = tapTargetCorpus(SYNTHETIC, doc([
      { traits: { EntityAttributes: { name: 'A', guid: 'g-a', parentId: 'g-b' }, UIElement: {}, UIAction: CLICK } },
      { traits: { EntityAttributes: { name: 'B', guid: 'g-b', parentId: 'g-a' }, UIElement: {} } },
    ]));
    expect(c.byName('A')!.ancestorUi.length).toBe(2);
  });

  it('collects a control for ANY binding, a TouchControl or a swallow — and nothing else', () => {
    // Narrowing happens per-assertion, never at collection: a `change`-only control is not a tap
    // target but is still a control `minTapSize` cannot help, and a shield is neither.
    const c = tapTargetCorpus(SYNTHETIC, doc([
      { traits: { EntityAttributes: { name: 'Click' }, UIElement: {}, UIAction: CLICK } },
      { traits: { EntityAttributes: { name: 'Change' }, UIElement: {}, UIAction: { bindings: [{ event: 'change' }] } } },
      { traits: { EntityAttributes: { name: 'Pad' }, UIElement: {}, TouchControl: {} } },
      { traits: { EntityAttributes: { name: 'Shield' }, UIElement: { swallowClicks: true } } },
      { traits: { EntityAttributes: { name: 'Label' }, UIElement: { text: 'hi' } } },
      { traits: { EntityAttributes: { name: 'NoUI' }, UIAction: CLICK } },
    ])).controls.map((x) => x.name);
    expect(c).toEqual(['Click', 'Change', 'Pad', 'Shield']);
  });
});
