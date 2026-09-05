/** entriesSystem — the pool driver, exercised end to end against a real koota world.
 *
 *  The prefab provider is FAKED through the registration seam the system already needs for
 *  layering reasons (runtime/ui is L2; the loaders are L3), so this drives the whole system
 *  with no prefab cache and no asset manifest. What is real here: the koota world, the actual
 *  traits, the window arithmetic, the slot planning and every trait write.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld } from 'koota';
import { UIScrollView } from '../../src/runtime/traits/UIScrollView';
import { UIEntries } from '../../src/runtime/traits/UIEntries';
import { UIEntry } from '../../src/runtime/traits/UIEntry';
import { UIElement } from '../../src/runtime/traits/UIElement';
import { RenderableUI } from '../../src/runtime/traits/RenderableUI';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { PrefabInstance } from '../../src/runtime/traits/PrefabInstance';

let testWorld: ReturnType<typeof createWorld>;
const idIndex = new Map<number, any>();

vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => idIndex.set(e.id(), e),
  spawnEntity: (world: any, ...traits: any[]) => { const e = world.spawn(...traits); idIndex.set(e.id(), e); return e; },
  // Mirrors the real one: destroys exactly ONE entity and does NOT cascade — which is precisely
  // what `releaseViewPool` has to compensate for by walking the subtree itself.
  destroyEntity: (e: any) => { idIndex.delete(e.id()); e.destroy(); },
  onWorldSwap: () => {},
  findEntityById: (id: number) => idIndex.get(id),
  findEntityByGuid: (guid: string) => {
    let found: any;
    testWorld.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { if (!found && ea.guid === guid) found = e; });
    return found;
  },
  indexEntityGuid: () => {},
  // Pulled in transitively since the system began re-targeting focus on recycle: focusManager
  // -> bindings -> uiTreeStore -> entityUtils calls this at module scope.
  setStructureCallback: () => {},
}));

const markUIDirtySpy = vi.fn();
vi.mock('../../src/runtime/core/uiDirty', () => ({
  markUIDirty: () => markUIDirtySpy(),
  isUIDirty: () => false,
  clearUIDirty: () => {},
}));

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'UIScrollView', trait: UIScrollView }, { name: 'UIEntries', trait: UIEntries },
    { name: 'UIEntry', trait: UIEntry }, { name: 'UIElement', trait: UIElement },
    { name: 'RenderableUI', trait: RenderableUI }, { name: 'EntityAttributes', trait: EntityAttributes },
    // Real pooled entries come from a prefab, so every member carries PrefabInstance — and the
    // focus re-target addresses members by its `parentLocalId || localId`. Without this the
    // fixture would exercise only the no-prefab FALLBACK key and vouch for the wrong path.
    { name: 'PrefabInstance', trait: PrefabInstance },
  ];
  return { getAllTraits: () => traits, getTraitByName: (n: string) => traits.find(t => t.name === n) };
});

const ENTRY_H = 120;
const VIEWPORT = 600;
const PREFAB = 'prefab-guid-1';

/** A fake entry prefab: a root UIElement plus one named child, spawned directly.
 *  `rootOverrides` lets a test author extra UIElement fields on the root — e.g. a margin, to
 *  check the system zeroes it (#651). */
function makeProvider(rootOverrides: Record<string, unknown> = {}) {
  const spawned: number[] = [];
  return {
    spawned,
    isCached: () => true,
    rootSize: () => ({ width: 0, height: ENTRY_H }),
    spawnInstance: (world: any, _guid: string, opts: { parentId: number; guidSeed: string }) => {
      const root = world.spawn(UIElement({ height: ENTRY_H, ...rootOverrides }), RenderableUI(),
        PrefabInstance({ source: PREFAB, localId: 1 }),
        EntityAttributes({ name: 'Entry', parentId: opts.parentId, guid: opts.guidSeed }));
      idIndex.set(root.id(), root);
      const label = world.spawn(UIElement({ text: '' }), RenderableUI(),
        PrefabInstance({ source: PREFAB, localId: 2 }),
        EntityAttributes({ name: 'Label', parentId: root.id(), guid: `${opts.guidSeed}|Label` }));
      idIndex.set(label.id(), label);
      spawned.push(root.id());
      return root.id();
    },
  };
}

async function setup(entries: Partial<Record<string, unknown>> = {}, scroll = 0, rootOverrides: Record<string, unknown> = {}) {
  const sys = await import('../../src/runtime/ui/entriesSystem');
  const src = await import('../../src/runtime/ui/entrySource');
  sys.resetEntriesSystem();
  src.clearEntrySources();
  const provider = makeProvider(rootOverrides);
  sys.setEntryPrefabProvider(provider);

  const view = testWorld.spawn(
    UIScrollView({ scrollY: scroll, viewportHeight: VIEWPORT, viewportWidth: 360, axis: 'y' }),
    UIEntries({
      prefabs: JSON.stringify([{ name: 'row', prefab: PREFAB }]),
      entryHeight: 0, entryHeightUnit: 'px', entryWidth: 100, entryWidthUnit: '%',
      countX: 1, countY: 1000, overscan: 1, source: 'test.rows', ...entries,
    }),
    EntityAttributes({ name: 'View', guid: 'view-guid' }),
    UIElement({}), RenderableUI(),
  );
  idIndex.set(view.id(), view);
  return { sys, src, provider, view };
}

beforeEach(() => { testWorld = createWorld(); idIndex.clear(); });
// ⚠️ Koota caps a process at 16 worlds, so a per-test world MUST be released or the 17th test
// in this file dies with "Too many worlds created" — which reads as a bug in the code under
// test rather than as test bookkeeping. Hit exactly that when this file crossed 16 cases.
afterEach(() => { vi.restoreAllMocks(); (testWorld as unknown as { destroy?: () => void })?.destroy?.(); });

describe('entriesSystem', () => {
  it('spawns a content child and a pool sized visible+1+2*overscan', async () => {
    const { sys, provider, view } = await setup();
    sys.entriesSystem(testWorld);
    // viewport 600 / entry 120 = 5, +1 straddling = 6 visible; +2*1 overscan = 8.
    expect(provider.spawned).toHaveLength(8);
    const en = view.get(UIEntries) as any;
    expect(en.visibleY).toBe(6);
    expect(en.poolSize).toBe(8);

    const contentNames: string[] = [];
    testWorld.query(EntityAttributes).updateEach(([a]: any[]) => contentNames.push(a.name));
    expect(contentNames).toContain(sys.ENTRIES_CONTENT_NAME);
  });

  it('writes the scroll offset as PX padding, never percent', async () => {
    // UIElement's padding units default to '%', and CSS percentage padding resolves against
    // WIDTH on both axes — a % vertical padding is silently wrong.
    const { sys } = await setup({}, 12000);
    sys.entriesSystem(testWorld);
    let content: any;
    testWorld.query(EntityAttributes, UIElement).updateEach(([a, ui]: any[]) => {
      if (a.name === sys.ENTRIES_CONTENT_NAME) content = ui;
    });
    expect(content.paddingTopUnit).toBe('px');
    expect(content.paddingBottomUnit).toBe('px');
    expect(content.paddingTop % ENTRY_H).toBe(0);
    expect(content.paddingTop).toBeGreaterThan(0);
  });

  // #651 — computeAxisWindow solves the whole scroll geometry from `stride = entrySize + gap`
  // alone. A margin authored on the entry prefab's root sits OUTSIDE that box, so the real
  // on-screen stride would silently gain a term the model never carries. The system must
  // zero the root's margin the same way it already pins width/height/flexShrink.
  it('zeroes a margin authored on the entry prefab root, so it cannot desync the stride model', async () => {
    const { sys } = await setup({}, 0, { marginTop: 4, marginRight: 8, marginBottom: 4, marginLeft: 8 });
    sys.entriesSystem(testWorld);
    let entryRoot: any;
    testWorld.query(EntityAttributes, UIElement).updateEach(([a, ui]: any[]) => {
      if (a.name === 'Entry') entryRoot = ui;
    });
    expect(entryRoot.marginTop).toBe(0);
    expect(entryRoot.marginRight).toBe(0);
    expect(entryRoot.marginBottom).toBe(0);
    expect(entryRoot.marginLeft).toBe(0);
  });

  // #651 B1 sibling: minWidth/maxWidth/minHeight/maxHeight override the pinned px width/height
  // from INSIDE the border box, the same desync as an authored margin from outside it — and
  // were missed the first time round.
  it('zeroes a maxWidth authored on the entry prefab root, so it cannot desync the stride model', async () => {
    const { sys } = await setup({}, 0, { maxWidth: 60 });
    sys.entriesSystem(testWorld);
    let entryRoot: any;
    testWorld.query(EntityAttributes, UIElement).updateEach(([a, ui]: any[]) => {
      if (a.name === 'Entry') entryRoot = ui;
    });
    expect(entryRoot.maxWidth).toBe(0);
  });

  it('warns ONCE per entity+field when an authored min/max override is discarded, not every tick', async () => {
    // The fixture pools several entries (see the first test's 8), and EVERY one of them carries
    // the same authored override — so "once" here means once PER ENTITY, not one line total.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sys, src, provider } = await setup({}, 0, { maxWidth: 60 });
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    const named = () => warn.mock.calls.filter(c => String(c[0]).includes('maxWidth'));
    const afterFirstTick = named().length;
    expect(afterFirstTick).toBe(provider.spawned.length);   // one line per pooled entity, not per tick
    expect(String(named()[0][0])).toContain('Entry');        // names the offending entity

    // The pin already self-corrects the value every tick, so running MORE ticks with nothing
    // re-authored proves nothing about the guard by itself — the real test is to put the override
    // BACK on every pooled root, exactly what a live Inspector edit while playing would do, and
    // confirm the GUARD (not the self-correction) is what keeps the count from climbing again.
    sys.entriesSystem(testWorld);
    expect(named().length, 'no growth from an idle tick').toBe(afterFirstTick);

    testWorld.query(EntityAttributes, UIElement).updateEach(([a]: any[], e: any) => {
      if (a.name === 'Entry') e.set(UIElement, { ...(e.get(UIElement) as any), maxWidth: 60 });
    });
    sys.entriesSystem(testWorld);
    expect(named().length, 're-authoring the SAME override must not re-warn').toBe(afterFirstTick);
  });

  // #761 — the six fields pinned in TOTAL SILENCE before this: width/widthUnit/height/heightUnit
  // (pinned to the scroll view's resolved box, not a constant), flexShrink (pinned to 0, but its
  // trait default is 1) and isVisible (pinned to the slot's live state, not a constant).
  it('pins width/height and their units to the resolved size, in px', async () => {
    const { sys } = await setup();
    sys.entriesSystem(testWorld);
    let entryRoot: any;
    testWorld.query(EntityAttributes, UIElement).updateEach(([a, ui]: any[]) => {
      if (a.name === 'Entry') entryRoot = ui;
    });
    // entryWidth: 100% of the 360px viewport; entryHeight: 0 (authored 0 => read from the
    // prefab root, ENTRY_H).
    expect(entryRoot.width).toBe(360);
    expect(entryRoot.widthUnit).toBe('px');
    expect(entryRoot.height).toBe(ENTRY_H);
    expect(entryRoot.heightUnit).toBe('px');
  });

  it('pins flexShrink to 0 even though UIElement.flexShrink defaults to 1', async () => {
    const { sys } = await setup();
    sys.entriesSystem(testWorld);
    let entryRoot: any;
    testWorld.query(EntityAttributes, UIElement).updateEach(([a, ui]: any[]) => {
      if (a.name === 'Entry') entryRoot = ui;
    });
    expect(entryRoot.flexShrink).toBe(0);
  });

  it('pins isVisible to the slot\'s live state, not a constant', async () => {
    // The pool never shrinks (#651): spawn it full-size against 1000 rows, then shrink the DATA
    // under it. The slots the smaller plan no longer covers must PARK (isVisible -> false) while
    // the rest stay live (isVisible -> true) — both values in the same tick, from one pin.
    const { sys, src, view } = await setup();
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    view.set(UIEntries, { ...(view.get(UIEntries) as any), countY: 3, epoch: 1 });
    sys.entriesSystem(testWorld);
    const seen: { live: boolean; visible: boolean }[] = [];
    testWorld.query(UIEntry, UIElement).updateEach(([e, ui]: any[]) => seen.push({ live: e.live, visible: ui.isVisible }));
    expect(seen.some(s => s.live)).toBe(true);
    expect(seen.some(s => !s.live)).toBe(true);
    for (const s of seen) expect(s.visible).toBe(s.live);
  });

  it('warns once when an authored PX width differs from BOTH the resolved pin and the trait default', async () => {
    // ⚠️ Only a `px`-unit authored value is a real trap here (#762-review) — a `%` (or
    // `vw`/`vh`/`vmin`/`vmax`) value is the documented contract the scroll view resolves, and
    // must NOT warn (see the neutral-percent test below, which pins that down). This test
    // therefore authors `widthUnit: 'px'` explicitly rather than leaving it at the trait default
    // ('%'), which is what an earlier version of this test did — encoding the exact false
    // positive the review found (5 of 6 committed entry-prefab roots tripping the warning purely
    // for authoring the documented `%` shape).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sys, src, provider } = await setup({}, 0, { width: 200, widthUnit: 'px' });
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    const named = () => warn.mock.calls.filter(c => String(c[0]).includes('UIElement.width='));
    expect(named().length).toBe(provider.spawned.length);
    // width/widthUnit fold into ONE line per axis, naming the authored unit too.
    expect(String(named()[0][0])).toContain('UIElement.width=200px');
    expect(String(named()[0][0])).toContain('pins width to 360px');
  });

  it('stays SILENT for an authored PERCENT width, even though the raw number differs from the resolved pin', async () => {
    // The canonical pager shape (#762-review): `width: 100, widthUnit: '%'` on the entry prefab
    // root, matching `entryWidth: 100%` on the view. The raw numbers (100 vs. the resolved 360px)
    // will always differ — that comparison is meaningless across units, and warning on it fired
    // on 5 of the 6 committed entry-prefab roots in the repo.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sys, src } = await setup({}, 0, { width: 100, widthUnit: '%' });
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    const named = warn.mock.calls.filter(c => String(c[0]).includes('UIElement.width='));
    expect(named).toHaveLength(0);
  });

  it('warns once when an authored isVisible=false differs from a LIVE slot\'s pin', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // scroll 0 with 1000 rows: every pooled slot in the fixture's window is live, so every one
    // of them carries the authored override and every one should warn.
    const { sys, src, provider } = await setup({}, 0, { isVisible: false });
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    const named = () => warn.mock.calls.filter(c => String(c[0]).includes('UIElement.isVisible='));
    expect(named().length).toBe(provider.spawned.length);
    expect(String(named()[0][0])).toContain('UIElement.isVisible=false');
  });

  it('warns once when an authored flexShrink differs from both the 0 pin and the 1 default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sys, src, provider } = await setup({}, 0, { flexShrink: 3 });
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    const named = () => warn.mock.calls.filter(c => String(c[0]).includes('UIElement.flexShrink='));
    expect(named().length).toBe(provider.spawned.length);
  });

  it('stays SILENT for a row left at its trait defaults — no false positives on the untouched case', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sys, src } = await setup(); // no rootOverrides — every field is at its UIElement default
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    const pooledWarnings = warn.mock.calls.filter(c => String(c[0]).includes('pooled UIEntries root'));
    expect(pooledWarnings).toHaveLength(0);
  });

  it('stays SILENT for a slot PARKED while its isVisible still reads the true default', async () => {
    // The trap the naive `cur !== pinned` rule falls into: a parked slot's pin is `false`, but a
    // slot the author never touched still reads `true` (the trait default) — that must not read
    // as an authored override just because it happens on the tick the slot parks.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sys, src, view } = await setup();
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    warn.mockClear();
    view.set(UIEntries, { ...(view.get(UIEntries) as any), countY: 3, epoch: 1 });
    sys.entriesSystem(testWorld);
    const isVisibleWarnings = warn.mock.calls.filter(c => String(c[0]).includes('UIElement.isVisible='));
    expect(isVisibleWarnings).toHaveLength(0);
  });

  it('pins exactly the field set uiAuthoring.POOLED_ROW_PINNED_FIELDS names — the #761 drift guard', async () => {
    const { POOLED_ROW_PINNED_FIELDS } = await import('../../src/runtime/ui/uiAuthoring');
    const overrides: Record<string, unknown> = {};
    for (const f of POOLED_ROW_PINNED_FIELDS) {
      overrides[f] = f === 'isVisible' ? false : f.endsWith('Unit') ? '%' : 999;
    }
    const { sys, src } = await setup({}, 0, overrides);
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    let entryRoot: any;
    testWorld.query(EntityAttributes, UIElement).updateEach(([a, ui]: any[]) => {
      if (a.name === 'Entry') entryRoot = ui;
    });
    // If entriesSystem's own pin ever drops a field this constant still names (or the constant
    // grows one the pin does not write), the corresponding override survives untouched here.
    for (const f of POOLED_ROW_PINNED_FIELDS) {
      expect(entryRoot[f], `'${f}' was not corrected — pin and POOLED_ROW_PINNED_FIELDS have drifted`).not.toBe(overrides[f]);
    }
  });

  it('asks the resolver for the DATA coordinate and writes what it answers', async () => {
    const { sys, src } = await setup({}, 12000);
    const seen: number[] = [];
    src.registerEntrySource('test.rows', ({ index }) => {
      seen.push(index);
      return { members: { 'Label': { UIElement: { text: `row ${index}` } } } };
    });
    sys.entriesSystem(testWorld);

    // scroll 12000 / 120 = entry 100, minus overscan 1 => first = 99.
    expect(seen[0]).toBe(99);
    const texts: string[] = [];
    testWorld.query(EntityAttributes, UIElement).updateEach(([a, ui]: any[]) => {
      if (a.name === 'Label' && ui.text) texts.push(ui.text);
    });
    expect(texts).toContain('row 99');
    expect(texts).toContain('row 100');
  });

  it('stamps UIEntry with the data index, not the slot', async () => {
    const { sys, src } = await setup({}, 12000);
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    const stamps: { slot: number; index: number }[] = [];
    testWorld.query(UIEntry).updateEach(([e]: any[]) => stamps.push({ slot: e.slot, index: e.index }));
    const slot0 = stamps.find(s => s.slot === 0)!;
    expect(slot0.index).toBe(99);       // the DATA index — slot 0 is not entry 0
  });

  it('PARKS slots the data no longer covers: not live, and hidden', async () => {
    // The pool never shrinks (shrinking would churn entities exactly when the device is
    // busiest), so the realistic over-cover is the DATA shrinking under a grown pool — a
    // filter applied, a track switched. Those slots must be parked, not left showing stale
    // content.
    const { sys, src, view } = await setup();
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    view.set(UIEntries, { ...(view.get(UIEntries) as any), countY: 3, epoch: 1 });
    sys.entriesSystem(testWorld);
    const parked: any[] = [];
    testWorld.query(UIEntry, UIElement).updateEach(([e, ui]: any[]) => {
      if (!e.live) parked.push({ index: e.index, visible: ui.isVisible });
    });
    expect(parked.length).toBeGreaterThan(0);
    expect(parked.every(p => p.visible === false)).toBe(true);
    expect(parked.every(p => p.index === -1)).toBe(true);
  });

  it('orders by ROW then by column — sortOrder is the position within the row, not the slot', async () => {
    const { sys, src } = await setup({}, 12000);
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);

    // A 1-column strip: every entry is alone on its row, so each carries sortOrder 0 and the
    // visual order comes entirely from the ROWS' own sortOrder. Asserting `sortOrder === slot`
    // (the pre-row rule) would pass while every entry sat in the same row.
    const rowIds = new Set<number>();
    const orders: number[] = [];
    testWorld.query(UIEntry, EntityAttributes).updateEach(([, a]: any[]) => {
      orders.push(a.sortOrder); rowIds.add(a.parentId);
    });
    expect(new Set(orders)).toEqual(new Set([0]));
    expect(rowIds.size).toBe(orders.length);       // one row each, none sharing

    const rows: number[] = [];
    testWorld.query(EntityAttributes).updateEach(([a]: any[]) => {
      if (a.name === '__uiEntriesRow') rows.push(a.sortOrder);
    });
    expect(rows.sort((x, y) => x - y)).toEqual([...rows.keys()]);
  });

  it('a 2-D window packs each row with its own entries — the grid case', async () => {
    const { sys, src, view } = await setup({
      countX: 20, countY: 250, entryWidth: 100, entryWidthUnit: 'px', overscan: 0,
    });
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);

    const en = view.get(UIEntries) as any;
    const byRow = new Map<number, number[]>();
    testWorld.query(UIEntry, EntityAttributes).updateEach(([, a]: any[]) => {
      const b = byRow.get(a.parentId) ?? []; b.push(a.sortOrder); byRow.set(a.parentId, b);
    });
    expect(byRow.size).toBe(en.visibleY);
    for (const cols of byRow.values()) {
      expect(cols.sort((x, y) => x - y)).toEqual([...Array(en.visibleX).keys()]);
    }
  });

  it('splits the offset: Y padding on the content child, X padding on every row', async () => {
    const { sys, src } = await setup({
      countX: 20, countY: 250, entryWidth: 100, entryWidthUnit: 'px', gapX: 8, gapY: 4, overscan: 0,
    }, 0);
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);

    let content: any; const rows: any[] = [];
    testWorld.query(EntityAttributes, UIElement).updateEach(([a, ui]: any[]) => {
      if (a.name === '__uiEntriesContent') content = ui;
      if (a.name === '__uiEntriesRow') rows.push(ui);
    });
    // ⚠️ The content child must carry NO horizontal padding. Padding is what collapses the box
    // it sits on, and a `width:100%` content child with a trailing X padding is exactly how the
    // pager rendered 0px-wide pages — see ENTRIES_ROW_NAME.
    expect(content.paddingLeft).toBe(0);
    expect(content.paddingRight).toBe(0);
    expect(content.gap).toBe(4);                  // the column's gap IS the Y gap
    expect(content.gapUnit).toBe('px');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.gap === 8 && r.gapUnit === 'px')).toBe(true);
    expect(rows.every(r => r.paddingRight > 0)).toBe(true);
  });

  it('re-lays-out on a viewport RESIZE, which moves no window origin', async () => {
    // A `%` entry resolves against the viewport, so a resize changes every padding value while
    // `first` stays put. The cheap `!moved` early-out used to keep the old geometry forever —
    // measured live on the pager, which kept a 640px page inside a 395px panel.
    const { sys, src, view } = await setup({
      countX: 1, countY: 40, entryHeight: 100, entryHeightUnit: '%',
    });
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);

    const heightOf = () => {
      let h = -1;
      testWorld.query(UIEntry, UIElement).updateEach(([, ui]: any[]) => { if (h < 0) h = ui.height; });
      return h;
    };
    expect(heightOf()).toBe(VIEWPORT);

    view.set(UIScrollView, { ...(view.get(UIScrollView) as any), viewportHeight: 300 });
    sys.entriesSystem(testWorld);
    expect(heightOf()).toBe(300);
  });

  it('CONVERGES at rest after a jump — the overscan raise must not feed itself', async () => {
    // ⚠️ Overscan is computed from travel, and `first` is `floor(scroll/stride) - overscan`.
    // Measuring travel on `first` therefore closes a loop: a raised overscan moves `first`,
    // which reads as travel, which raises overscan. Measured on a Galaxy A23 (2026-08-21) — a
    // 20 x 250 grid left completely alone flipped between a 9x8 and a 13x10 pool forever,
    // re-driving on 102 of 154 frames at ~30fps with no input. Travel comes from the SCROLL.
    const { sys, src, view } = await setup({ countX: 1, countY: 5000 }, 0);
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);

    // A jump: the exact case that produces a huge one-off travel reading.
    view.set(UIScrollView, { ...(view.get(UIScrollView) as any), scrollY: 120 * 2000 });
    const seen: string[] = [];
    for (let i = 0; i < 16; i++) {
      sys.entriesSystem(testWorld);
      const en = view.get(UIEntries) as any;
      seen.push(`${en.firstY}/${en.poolSize}`);
    }
    // Everything after the first settling tick must be identical — no oscillation, and the
    // system must report no work to do.
    const tail = seen.slice(-5);
    expect(new Set(tail).size).toBe(1);
  });

  it('the pipeline tick does not shrink the window the scroll event just grew', async () => {
    // Two drives land per frame: `driveEntriesFromScroll` (decay:false) when the DOM scrolls,
    // then the pipeline tick. If travel is consumed by whichever ran first, the second reads
    // zero and shrinks the band back in the same frame — and the frame paints the SMALLER one,
    // because the pipeline always runs second. Measured in the editor 2026-08-21: the band
    // pinned at 17 rows for every speed from 8 to 30 entries per frame, and the viewport went
    // black. The baseline for travel therefore advances on the pipeline tick only.
    const { sys, src, view } = await setup({ countX: 1, countY: 5000 }, 0);
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    const base = (view.get(UIEntries) as any).poolSize;

    // One frame of fast scrolling: the scroll-event drive, then the pipeline tick.
    view.set(UIScrollView, { ...(view.get(UIScrollView) as any), scrollY: 120 * 12 });
    sys.entriesSystem(testWorld, { fromScroll: true });
    const afterScroll = (view.get(UIEntries) as any).poolSize;
    sys.entriesSystem(testWorld);
    const afterTick = (view.get(UIEntries) as any).poolSize;

    expect(afterScroll).toBeGreaterThan(base);      // the raise fired at all
    expect(afterTick).toBeGreaterThanOrEqual(afterScroll);
  });

  it('the pool comes back DOWN at the top of the list, where the origin cannot move', async () => {
    // At scroll 0 the window origin is clamped to 0, so a travel spike that raises the overscan
    // and then decays changes `pooled` while `first` never moves. Tracking only the X pooled
    // count left `moved`/`invalidated`/`poolChanged` all false and skipped the re-drive:
    // measured live 2026-08-21 at the top of the 5,000-entry strip, the pool went 8 -> 29 rows
    // and STAYED at 29 through 60 idle frames.
    const { sys, src, view } = await setup({ countX: 1, countY: 5000 }, 0);
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    const settled = (view.get(UIEntries) as any).poolSize;

    // A fast burst away from the top, then straight back to it.
    for (let y = 1; y <= 6; y++) {
      view.set(UIScrollView, { ...(view.get(UIScrollView) as any), scrollY: y * 120 * 15 });
      sys.entriesSystem(testWorld);
    }
    const raised = (view.get(UIEntries) as any).poolSize;
    expect(raised).toBeGreaterThan(settled);

    view.set(UIScrollView, { ...(view.get(UIScrollView) as any), scrollY: 0 });
    for (let i = 0; i < 8; i++) sys.entriesSystem(testWorld);
    const en = view.get(UIEntries) as any;
    expect(en.firstY).toBe(0);
    expect(en.poolSize).toBe(settled);     // back to the floor, not stuck at the raised count
  });

  it('a converted scrollToEntry request DIRTIES the tree, even when the window did not move', async () => {
    // ⚠️ The px request lands on UIScrollView through a raw `entity.set` — the no-dirty scroll
    // path. So if the window did not also move, nothing rebuilds the UI tree, `UINode`'s
    // one-shot scrollTo effect never re-runs, and the request sits on the trait forever.
    // Found by wiring the first real caller of `ui.scrollTo` in games/scroll-demo: the trait
    // read `scrollToY: 480000` while `scrollY` stayed 0 and the view never moved.
    const { sys, src, view } = await setup({ countX: 1, countY: 5000 }, 0);
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);          // settle, so the window is stable at the origin
    markUIDirtySpy.mockClear();

    // Request entry 4000 WITHOUT moving the scroll: only the request changes.
    view.set(UIEntries, { ...(view.get(UIEntries) as any), scrollToEntryY: 4000 });
    sys.entriesSystem(testWorld);

    const sv = view.get(UIScrollView) as any;
    expect(sv.scrollToY).toBe(4000 * ENTRY_H);     // converted from entries to px
    expect((view.get(UIEntries) as any).scrollToEntryY).toBe(-1);   // and cleared
    expect(markUIDirtySpy).toHaveBeenCalled();     // ...and the renderer gets told
  });

  it('does no work when nothing moved — the cheap path a scroll frame takes', async () => {
    const { sys, src } = await setup({}, 12000);
    let calls = 0;
    src.registerEntrySource('test.rows', () => { calls++; return { members: {} }; });
    sys.entriesSystem(testWorld);
    const first = calls;
    sys.entriesSystem(testWorld);
    expect(calls).toBe(first);           // second frame re-resolved nothing
  });

  it('re-drives on an epoch bump even though the window did not move', async () => {
    // Court needs exactly this: a level gets solved, the tile face changes, the page does not.
    const { sys, src, view } = await setup({}, 12000);
    let calls = 0;
    src.registerEntrySource('test.rows', () => { calls++; return { members: {} }; });
    sys.entriesSystem(testWorld);
    const before = calls;
    view.set(UIEntries, { ...(view.get(UIEntries) as any), epoch: 1 });
    sys.entriesSystem(testWorld);
    expect(calls).toBeGreaterThan(before);
  });

  it('warns about a member path that names nothing instead of failing silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sys, src } = await setup();
    src.registerEntrySource('test.rows', () => ({ members: { 'NoSuchChild': { UIElement: { text: 'x' } } } }));
    sys.entriesSystem(testWorld);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NoSuchChild'));
  });

  it('converts a scrollToEntry request from ENTRIES to px, then clears it', async () => {
    const { sys, src, view } = await setup();
    const api = await import('../../src/runtime/ui/scrollApi');
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);

    expect(api.scrollToEntry('view-guid', { y: 42 }, { behavior: 'smooth' })).toBe(true);
    sys.entriesSystem(testWorld);

    const sv = view.get(UIScrollView) as any;
    expect(sv.scrollToY).toBe(42 * ENTRY_H);      // entries -> px, using the size the system resolved
    expect(sv.scrollToBehavior).toBe('smooth');
    // ⚠️ The per-request behaviour rides `scrollToBehavior`; the AUTHORED `scrollBehavior` is
    // untouched by a request (#409) — it used to be the field the request was stored on.
    expect(sv.scrollBehavior).toBe('instant');
    // Cleared immediately: leaving it set would re-issue the same scroll every frame and pin
    // the view in place.
    const en = view.get(UIEntries) as any;
    expect(en.scrollToEntryY).toBe(-1);
  });

  it('builds the window from the REQUESTED entry, not from the scroll it can still observe', async () => {
    // ⚠️ The fix for "a jump lands on the wrong page" (Court's level selector, 2026-08-21).
    //
    // The offset is carried as PADDING, so the window and the scroll position are two halves of
    // one statement. Building this frame's window from the OBSERVED `scrollY` writes the padding
    // for where the view IS, the DOM then scrolls to where it was ASKED to go with the wrong
    // content underneath, and `scroll-snap` drags it back to the nearest entry that actually
    // exists. Measured live: asking for page 12 landed on 4, page 23 on 6 — converging a few
    // pages per attempt, because each round could only move the window by its own extent.
    const { sys, src, view } = await setup();
    const api = await import('../../src/runtime/ui/scrollApi');
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);

    const before = (view.get(UIEntries) as any).firstY;
    expect(before, 'precondition: the view starts at the top').toBe(0);

    api.scrollToEntry('view-guid', { y: 40 });
    sys.entriesSystem(testWorld);

    // ONE tick, and the window is already at the target — not walking toward it.
    const en = view.get(UIEntries) as any;
    expect(en.firstY).toBeGreaterThan(30);
    expect((view.get(UIScrollView) as any).scrollToY).toBe(40 * ENTRY_H);
  });

  it('a converted jump reports NO travel, so it does not inflate the pool', async () => {
    // Travel sizes the band against how fast the scroll is MOVING, and a teleport is not motion:
    // its destination is known exactly. Feeding a jump's distance in is what made a
    // `scrollToEntry` pool thousands of entries (the reason the three-viewport cap exists).
    const { sys, src, view } = await setup();
    const api = await import('../../src/runtime/ui/scrollApi');
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    const restingPool = (view.get(UIEntries) as any).poolSize;

    api.scrollToEntry('view-guid', { y: 400 });
    sys.entriesSystem(testWorld);
    // ⚠️ The DOM landing the scroll is part of the mechanism, not scenery: `UINode` applies the
    // converted px request and writes the new offset back through `writeScrollState`. Without
    // modelling that, the next tick compares a baseline that MOVED against a scroll that never
    // did, and measures the whole teleport as travel — a state production never reaches.
    view.set(UIScrollView, { ...(view.get(UIScrollView) as any), scrollY: 400 * ENTRY_H });
    sys.entriesSystem(testWorld);   // the tick AFTER, where a stale baseline would bite

    expect((view.get(UIEntries) as any).poolSize).toBe(restingPool);
  });

  it('scrollByEntry moves ONE entry from wherever the view sits, not to entry N', async () => {
    // Backs `UIScrollView.wheel: 'entry'`. A delta multiplier cannot bound a wheel gesture under
    // mandatory snap — the browser quantises any offset to a whole entry — so what gets bounded
    // is how many entries one gesture crosses, which needs "where am I + 1".
    const { sys, src, view } = await setup();
    const api = await import('../../src/runtime/ui/scrollApi');
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);

    view.set(UIScrollView, { ...(view.get(UIScrollView) as any), scrollY: 7 * ENTRY_H });
    sys.entriesSystem(testWorld);
    expect(api.scrollByEntry('view-guid', { y: 1 })).toBe(true);
    expect((view.get(UIEntries) as any).scrollToEntryY).toBe(8);

    view.set(UIScrollView, { ...(view.get(UIScrollView) as any), scrollY: 7 * ENTRY_H });
    expect(api.scrollByEntry('view-guid', { y: -1 })).toBe(true);
    expect((view.get(UIEntries) as any).scrollToEntryY).toBe(6);
  });

  it('scrollByEntry does not arm a request on the axis it was not asked to move', async () => {
    // ⚠️ `0` is a REAL request for entry 0, not "no request" — the trap that once left an
    // uncleárable scrollToY on an x-axis view and cancelled every smooth scroll.
    const { sys, src, view } = await setup();
    const api = await import('../../src/runtime/ui/scrollApi');
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    api.scrollByEntry('view-guid', { y: 1 });
    expect((view.get(UIEntries) as any).scrollToEntryX).toBe(-1);
  });

  it('scrollByEntry refuses before the view has a usable window', async () => {
    // Returning "moved" here would teleport a wheel gesture to entry 0 the first time it fired.
    const { view } = await setup();
    const api = await import('../../src/runtime/ui/scrollApi');
    view.set(UIScrollView, { ...(view.get(UIScrollView) as any), viewportHeight: 0 });
    expect(api.scrollByEntry('view-guid', { y: 1 })).toBe(false);
  });

  it('snapToNearest does not arm a request on an axis the view does not scroll', async () => {
    // ⚠️ Sibling of the `{x, y: 0}` trap, found by sweeping the pattern rather than the symptom.
    // This used to ask both axes whenever both had a usable STRIDE — and an `axis: 'x'` view with
    // more than one ROW has a perfectly usable Y stride. Court escaped it only by coincidence
    // (`countY: 1` makes `visibleY` 1, and `entryStride` returns 0 below 2), which is exactly the
    // kind of accident that stops being true when someone authors a second row.
    const { sys, src, view } = await setup();
    const api = await import('../../src/runtime/ui/scrollApi');
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);

    // An x-axis view whose Y window is genuinely measurable — the shape that used to bite.
    view.set(UIScrollView, {
      ...(view.get(UIScrollView) as any), axis: 'x', scrollX: 0, scrollY: 0,
    });
    view.set(UIEntries, { ...(view.get(UIEntries) as any), visibleY: 4, visibleX: 2 });

    expect(api.snapToNearest('view-guid')).toBe(true);
    // 0 is a REAL request for entry 0, not "no request" — the sentinel is -1.
    expect((view.get(UIEntries) as any).scrollToEntryY).toBe(-1);
  });

  it('RELEASES the pool when the view is hidden, and rebuilds it when shown again', async () => {
    // ⚠️ "The pool never shrinks" is about not churning entities mid-SCROLL. It was never a
    // promise to hold them once nothing can see the view — and holding them cost real memory
    // during play: measured on a Galaxy A23 (2026-08-22), opening Court's level selector took the
    // world from 668 entities to 1,477 and closing it released NONE of them.
    const { sys, src, provider, view } = await setup();
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);

    const pooled = () => {
      let n = 0;
      testWorld.query(EntityAttributes).updateEach(([a]: any[]) => {
        if (a.name === 'Entry' || a.name === 'Label') n++;
      });
      return n;
    };
    expect(pooled(), 'precondition: a shown view has a pool').toBeGreaterThan(0);

    view.set(UIElement, { ...(view.get(UIElement) as any), isVisible: false });
    sys.entriesSystem(testWorld);
    expect(pooled(), 'a hidden view releases every pooled entity AND its members').toBe(0);

    view.set(UIElement, { ...(view.get(UIElement) as any), isVisible: true });
    provider.spawned.length = 0;
    sys.entriesSystem(testWorld);
    expect(pooled(), 'showing it again rebuilds the pool').toBeGreaterThan(0);
    expect(provider.spawned.length, 'and rebuilds by re-instantiating, not by resurrecting').toBeGreaterThan(0);
  });

  it('releases when an ANCESTOR is hidden, not only the view itself', async () => {
    // ⚠️ The case that actually ships: Court hides the `LevelSelect` ROOT, an ancestor of the
    // scroll view, so a check on the view's own flags would call a closed selector "shown".
    const { sys, src, view } = await setup();
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    const parent = testWorld.spawn(UIElement({}), RenderableUI(), EntityAttributes({ name: 'Card' }));
    view.set(EntityAttributes, { ...(view.get(EntityAttributes) as any), parentId: parent.id() });
    idIndex.set(parent.id(), parent);
    sys.entriesSystem(testWorld);

    const pooled = () => {
      let n = 0;
      testWorld.query(EntityAttributes).updateEach(([a]: any[]) => { if (a.name === 'Entry') n++; });
      return n;
    };
    expect(pooled()).toBeGreaterThan(0);
    parent.set(UIElement, { ...(parent.get(UIElement) as any), isVisible: false });
    sys.entriesSystem(testWorld);
    expect(pooled()).toBe(0);
  });

  it('refuses a scrollToEntry at a guid that is not a scroll view', async () => {
    await setup();
    const api = await import('../../src/runtime/ui/scrollApi');
    expect(api.scrollToEntry('no-such-guid', { y: 3 })).toBe(false);
  });

  it('leaves the un-requested axis alone', async () => {
    const { sys, src, view } = await setup();
    const api = await import('../../src/runtime/ui/scrollApi');
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    api.scrollToEntry('view-guid', { y: 10 });
    sys.entriesSystem(testWorld);
    // x was never requested, so it must stay at the no-request sentinel rather than scrolling
    // an axis this view does not even scroll.
    expect((view.get(UIScrollView) as any).scrollToX).toBe(-1);
  });

  // ── close-out review findings, each pinned ──

  it('does NOT consume a scrollToEntry while the entry size is still unknown', async () => {
    // Court's own case: "open on the player's frontier page" is issued on scene load, when the
    // prefab is not cached yet. Consuming it then computed index x 0 = 0, scrolled to the TOP,
    // and cleared the request — the view silently opened at the beginning and the ask was gone.
    const { sys, src, view } = await setup();
    const api = await import('../../src/runtime/ui/scrollApi');
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.setEntryPrefabProvider({ isCached: () => false, rootSize: () => ({ width: 0, height: 0 }), spawnInstance: () => 0 });

    api.scrollToEntry('view-guid', { y: 42 });
    sys.entriesSystem(testWorld);

    expect((view.get(UIScrollView) as any).scrollToY).toBe(-1);        // NOT scrolled to 0
    expect((view.get(UIEntries) as any).scrollToEntryY).toBe(42);      // still pending
  });

  it('warns when one axis count is 0 — the view renders nothing and used to say nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sys, src } = await setup({ countX: 0 });
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('one axis is 0'));
  });

  it('warns when the named source is not registered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sys } = await setup({ source: 'nobody.registered.this' });
    sys.entriesSystem(testWorld);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nothing is registered under that name'));
  });

  it('warns ONCE per view, not once per frame', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sys } = await setup({ source: '' });
    sys.entriesSystem(testWorld);
    sys.entriesSystem(testWorld);
    sys.entriesSystem(testWorld);
    expect(warn.mock.calls.filter(c => String(c[0]).includes('renders blank'))).toHaveLength(1);
  });

  // ── #363: a prefab that NEVER caches must say so, not retry silently forever ──
  //
  // The cost of the silence, measured: Court #344 set `"version": 2` on `level-tile.prefab.json`,
  // the loader declined to cache it, `spawnInstance` returned 0 on every frame forever, and the
  // pooled level selector rendered an empty grid. Nothing went red — `npm run verify` green at
  // 8,462 tests, all 40 of the feature's own tests green, `validatePrefabData` green — because
  // every one of them reads the prefab FILE, and the file was well-formed. The console was empty.

  /** A provider that is cached only once `cached.value` flips — the transient/permanent seam. */
  function stubProvider(cached: { value: boolean }, size = { width: 0, height: ENTRY_H }) {
    const spawns: string[] = [];
    return {
      spawns,
      isCached: () => cached.value,
      rootSize: () => (cached.value ? size : { width: 0, height: 0 }),
      spawnInstance: (_w: any, guid: string) => { spawns.push(guid); return 0; },
    };
  }

  it('warns once the entry prefab has been uncached for 120 consecutive ticks', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sys, src } = await setup();
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.setEntryPrefabProvider(stubProvider({ value: false }));

    for (let i = 0; i < 119; i++) sys.entriesSystem(testWorld);
    expect(warn.mock.calls.filter(c => String(c[0]).includes('STILL not cached'))).toHaveLength(0);

    sys.entriesSystem(testWorld);   // the 120th
    const calls = warn.mock.calls.filter(c => String(c[0]).includes('STILL not cached'));
    expect(calls).toHaveLength(1);
    // The message must name the view and the prefab — a bare "a prefab is not cached" sends the
    // reader back to the same hunt this exists to end.
    expect(String(calls[0][0])).toContain('view-guid');
    expect(String(calls[0][0])).toContain(PREFAB);
    // ⚠️ And it must NOT resurrect the `version` theory. An earlier draft told the author to check
    // that the prefab's `version` is 1; no such gate exists in the loader, and the editor's
    // serializer writes 2 for a prefab with nested-instance rows — so that advice would have had
    // people break a legitimate format marker. See resourceRefcount.test.ts § entryPrefabProvider.
    expect(String(calls[0][0]).toLowerCase(), 'the disproved version theory must not come back').not.toContain('version');
  });

  it('stays SILENT for a transient miss — the normal first frames of a scene load', async () => {
    // The whole point of the retry is that "not cached yet" is normal while the scene loads.
    // A diagnostic that cannot tell that from a permanent miss is worse than none.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sys, src } = await setup();
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    const cached = { value: false };
    sys.setEntryPrefabProvider(stubProvider(cached));

    for (let i = 0; i < 119; i++) sys.entriesSystem(testWorld);
    cached.value = true;                                   // the asset lands
    for (let i = 0; i < 200; i++) sys.entriesSystem(testWorld);

    expect(warn.mock.calls.filter(c => String(c[0]).includes('STILL not cached'))).toHaveLength(0);
  });

  it('RESETS the count on a cache hit, so two short misses never sum to a false alarm', async () => {
    // ⚠️ Mutation-pinned. The test above cannot tell "reset to 0" from "stop counting" — both
    // leave it silent — so on its own it lets `return 0` be weakened to `return prior`. A cache
    // that comes and goes (a scene swap re-acquiring, an eviction) would then accumulate across
    // unrelated gaps and warn about a prefab that is working.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sys, src } = await setup();
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    const cached = { value: false };
    sys.setEntryPrefabProvider(stubProvider(cached));

    for (let i = 0; i < 100; i++) sys.entriesSystem(testWorld);   // 100 uncached
    cached.value = true;
    sys.entriesSystem(testWorld);                                  // one hit — resets
    cached.value = false;
    for (let i = 0; i < 100; i++) sys.entriesSystem(testWorld);   // 100 more: 200 in total

    expect(warn.mock.calls.filter(c => String(c[0]).includes('STILL not cached'))).toHaveLength(0);
  });

  it('warns ONCE, not on every tick past the threshold', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sys, src } = await setup();
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.setEntryPrefabProvider(stubProvider({ value: false }));

    for (let i = 0; i < 400; i++) sys.entriesSystem(testWorld);
    expect(warn.mock.calls.filter(c => String(c[0]).includes('STILL not cached'))).toHaveLength(1);
  });

  // ⚠️ **BOTH entrances, and they are genuinely different code paths.** An uncached prefab makes
  // the view blank two ways, and a diagnostic driven by pool starvation would only ever see one:
  //
  //   entryHeight: 0  ("read it from the prefab") -> rootSize 0 -> stride 0 -> EMPTY_WINDOW ->
  //                   a plan of ZERO slots, so `ensurePool` is never asked to spawn at all.
  //   entryHeight: N  (authored) -> a full plan -> `ensurePool` DOES ask, and is handed 0 on
  //                   every frame forever.
  //
  // The first is the one that reads most like "the feature is broken", and it is the one with no
  // starved pool to observe. `setup()`'s own default is `entryHeight: 0`, so the pair below names
  // both explicitly rather than leaning on it — an earlier version passed `{ entryHeight: 0 }`
  // believing it was overriding something, and ran the same configuration twice.
  it('warns via the ZERO-PLAN entrance, where the pool is never even asked to spawn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sys, src } = await setup({ entryHeight: 0, entryHeightUnit: 'px' });
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    const p = stubProvider({ value: false });
    sys.setEntryPrefabProvider(p);

    for (let i = 0; i < 120; i++) sys.entriesSystem(testWorld);

    // The load-bearing half: any future rewrite that diagnoses from a STARVED POOL fails here,
    // because there is no starved pool to see.
    expect(p.spawns, 'spawnInstance is never called in this entrance').toHaveLength(0);
    expect(warn.mock.calls.filter(c => String(c[0]).includes('STILL not cached'))).toHaveLength(1);
  });

  it('warns via the STARVED-POOL entrance too, where spawnInstance is asked and refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sys, src } = await setup({ entryHeight: ENTRY_H, entryHeightUnit: 'px' });
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    const p = stubProvider({ value: false });
    sys.setEntryPrefabProvider(p);

    for (let i = 0; i < 120; i++) sys.entriesSystem(testWorld);

    expect(p.spawns.length, 'this entrance DOES ask, and keeps being refused').toBeGreaterThan(0);
    expect(warn.mock.calls.filter(c => String(c[0]).includes('STILL not cached'))).toHaveLength(1);
  });

  it('counts pipeline TICKS, not scroll-event drives', async () => {
    // The scroll drive re-enters the same code path to remove a frame of latency; counting it
    // would make the threshold depend on how hard the player is flicking.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sys, src } = await setup();
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.setEntryPrefabProvider(stubProvider({ value: false }));

    for (let i = 0; i < 400; i++) sys.entriesSystem(testWorld, { fromScroll: true });
    expect(warn.mock.calls.filter(c => String(c[0]).includes('STILL not cached'))).toHaveLength(0);
  });

  it('does nothing without a provider rather than throwing', async () => {
    const { sys } = await setup();
    sys.setEntryPrefabProvider(null);
    expect(() => sys.entriesSystem(testWorld)).not.toThrow();
  });
});

/** Focus follows the ENTRY, not the slot (#319).
 *
 *  The guid of a pooled instance is deterministic at the SLOT — deliberately, so an agent can
 *  address "the third pooled instance" across a re-drive. Focus is addressed by guid. So without
 *  a re-target the focused guid keeps resolving to a live, visible element that is now showing
 *  DIFFERENT DATA: a gamepad cursor on level 5 is silently on level 12, and Confirm launches the
 *  wrong one. Nothing errors, which is why this needed a test rather than a bug report.
 *
 *  It runs inside `entriesSystem` (priority 270) rather than in `uiFocusSystem`, which is
 *  GAME-tier and therefore dead while paused — and a level select is exactly what you scroll
 *  while paused. */
describe('entriesSystem — focus on recycle', () => {
  /** The pooled entry root's guid, from the guid of a member inside it (the fake provider names
   *  a Label `${rootGuid}|Label`). */
  const rootGuidOf = (guid: string) => guid.replace(/\|Label$/, '');

  /** The DATA index the currently-focused element is sitting on. */
  function focusedEntryIndex(focus: { focusedGuid: () => string }): number {
    const root = rootGuidOf(focus.focusedGuid());
    let index = -1;
    testWorld.query(EntityAttributes, UIEntry).updateEach(([a, e]: any[]) => {
      if (a.guid === root) index = e.index;
    });
    return index;
  }

  /** Focus the Label inside whichever slot currently shows entry `dataIndex`. */
  function focusLabelOfEntry(focus: { setFocus: (g: string) => void }, dataIndex: number): string {
    let rootGuid = '';
    testWorld.query(EntityAttributes, UIEntry).updateEach(([a, e]: any[]) => {
      if (e.index === dataIndex && e.live) rootGuid = a.guid;
    });
    expect(rootGuid).not.toBe('');
    focus.setFocus(`${rootGuid}|Label`);
    return `${rootGuid}|Label`;
  }

  it('re-points focus at the slot that now holds the same entry', async () => {
    const { sys, src, view } = await setup();
    const focus = await import('../../src/runtime/ui/focusManager');
    focus.resetFocus();
    src.registerEntrySource('test.rows', ({ index }) => ({ members: { 'Label': { UIElement: { text: `row ${index}` } } } }));
    sys.entriesSystem(testWorld);

    const before = focusLabelOfEntry(focus, 3);
    expect(focusedEntryIndex(focus)).toBe(3);

    // Scroll ONE ENTRY AT A TIME, driving between each. A single big jump reports a large travel
    // and raises the overscan to cover it, which widens the band instead of moving `first` — so a
    // teleport is exactly the wrong way to make the pool recycle, and the first cut of this test
    // asserted against a window that had not moved at all.
    for (let i = 1; i <= 2; i++) {
      view.set(UIScrollView, { ...(view.get(UIScrollView) as any), scrollY: i * ENTRY_H });
      sys.entriesSystem(testWorld);
    }

    expect(focus.focusedGuid()).not.toBe(before);      // it moved to a different SLOT...
    expect(focusedEntryIndex(focus)).toBe(3);          // ...to stay on the same ENTRY
  });

  it('clamps to the nearest resident entry when the focused one has left the pool', async () => {
    // Owner's call, 2026-08-22: clearing focus reads as a dropped input on a gamepad, and
    // autofocus would then drop the cursor at the list's lowest focusOrder rather than where the
    // player was looking. Clamping makes focus ride the leading edge of the fling.
    const { sys, src, view } = await setup();
    const focus = await import('../../src/runtime/ui/focusManager');
    focus.resetFocus();
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);
    focusLabelOfEntry(focus, 3);

    view.set(UIScrollView, { ...(view.get(UIScrollView) as any), scrollY: 100 * ENTRY_H });
    sys.entriesSystem(testWorld);

    // Against the LIVE resident set, not a hardcoded index: a jump raises the travel-driven
    // overscan, so where the band starts is an engine decision this test has no business
    // predicting. The claim is only that focus landed on the resident entry NEAREST to 3.
    const resident: number[] = [];
    testWorld.query(UIEntry).updateEach(([e]: any[]) => { if (e.live) resident.push(e.index); });
    const nearest = Math.min(...resident);
    expect(nearest).toBeGreaterThan(3);                // entry 3 really is out of the pool
    expect(focusedEntryIndex(focus)).toBe(nearest);
    expect(focus.focusedGuid()).toMatch(/\|Label$/);   // still the same MEMBER, not the root
  });

  it('carries a QUEUED activation with the focus, so Confirm cannot fire on the wrong entry', async () => {
    // The sibling of the same defect, found by the close-out sweep. A "confirm" is deferred:
    // uiFocusSystem queues `pendingActivateGuid` inside the pipeline tick and UIRenderer drains
    // it from a React effect AFTER commit. `driveEntriesFromScroll` runs straight off the DOM
    // scroll event and can land in that gap — so a queued guid left on the old slot would
    // activate whatever entry that slot recycled to.
    const { sys, src, view } = await setup();
    const focus = await import('../../src/runtime/ui/focusManager');
    focus.resetFocus();
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);

    const before = focusLabelOfEntry(focus, 3);
    focus.requestActivate(before);
    for (let i = 1; i <= 2; i++) {
      view.set(UIScrollView, { ...(view.get(UIScrollView) as any), scrollY: i * ENTRY_H });
      sys.entriesSystem(testWorld);
    }

    const pending = focus.useFocusStore.getState().pendingActivateGuid;
    expect(pending).not.toBe(before);                  // it did not stay on the old slot...
    expect(pending).toBe(focus.focusedGuid());         // ...it followed the focus
    expect(focusedEntryIndex(focus)).toBe(3);          // which is still entry 3
  });

  it('leaves focus alone when it is not inside this view pool', async () => {
    const { sys, src, view } = await setup();
    const focus = await import('../../src/runtime/ui/focusManager');
    focus.resetFocus();
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);

    focus.setFocus('view-guid');                       // the scroll view itself, not an entry
    view.set(UIScrollView, { ...(view.get(UIScrollView) as any), scrollY: 40 * ENTRY_H });
    sys.entriesSystem(testWorld);

    expect(focus.focusedGuid()).toBe('view-guid');
  });

  it('does not touch focus when nothing is focused', async () => {
    const { sys, src, view } = await setup();
    const focus = await import('../../src/runtime/ui/focusManager');
    focus.resetFocus();
    src.registerEntrySource('test.rows', () => ({ members: {} }));
    sys.entriesSystem(testWorld);

    view.set(UIScrollView, { ...(view.get(UIScrollView) as any), scrollY: 40 * ENTRY_H });
    sys.entriesSystem(testWorld);

    expect(focus.focusedGuid()).toBe('');
  });
});
