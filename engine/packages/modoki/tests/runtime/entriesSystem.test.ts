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

let testWorld: ReturnType<typeof createWorld>;
const idIndex = new Map<number, any>();

vi.mock('../../src/runtime/core/ecs/world', () => ({
  getCurrentWorld: () => testWorld,
  registerEntity: (e: any) => idIndex.set(e.id(), e),
  spawnEntity: (world: any, ...traits: any[]) => { const e = world.spawn(...traits); idIndex.set(e.id(), e); return e; },
  onWorldSwap: () => {},
  findEntityById: (id: number) => idIndex.get(id),
  findEntityByGuid: (guid: string) => {
    let found: any;
    testWorld.query(EntityAttributes).updateEach(([ea]: any[], e: any) => { if (!found && ea.guid === guid) found = e; });
    return found;
  },
  indexEntityGuid: () => {},
}));

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'UIScrollView', trait: UIScrollView }, { name: 'UIEntries', trait: UIEntries },
    { name: 'UIEntry', trait: UIEntry }, { name: 'UIElement', trait: UIElement },
    { name: 'RenderableUI', trait: RenderableUI }, { name: 'EntityAttributes', trait: EntityAttributes },
  ];
  return { getAllTraits: () => traits, getTraitByName: (n: string) => traits.find(t => t.name === n) };
});

const ENTRY_H = 120;
const VIEWPORT = 600;
const PREFAB = 'prefab-guid-1';

/** A fake entry prefab: a root UIElement plus one named child, spawned directly. */
function makeProvider() {
  const spawned: number[] = [];
  return {
    spawned,
    rootSize: () => ({ width: 0, height: ENTRY_H }),
    spawnInstance: (world: any, _guid: string, opts: { parentId: number; guidSeed: string }) => {
      const root = world.spawn(UIElement({ height: ENTRY_H }), RenderableUI(),
        EntityAttributes({ name: 'Entry', parentId: opts.parentId, guid: opts.guidSeed }));
      idIndex.set(root.id(), root);
      const label = world.spawn(UIElement({ text: '' }), RenderableUI(),
        EntityAttributes({ name: 'Label', parentId: root.id(), guid: `${opts.guidSeed}|Label` }));
      idIndex.set(label.id(), label);
      spawned.push(root.id());
      return root.id();
    },
  };
}

async function setup(entries: Partial<Record<string, unknown>> = {}, scroll = 0) {
  const sys = await import('../../src/runtime/ui/entriesSystem');
  const src = await import('../../src/runtime/ui/entrySource');
  sys.resetEntriesSystem();
  src.clearEntrySources();
  const provider = makeProvider();
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
    for (let i = 0; i < 12; i++) {
      sys.entriesSystem(testWorld);
      const en = view.get(UIEntries) as any;
      seen.push(`${en.firstY}/${en.poolSize}`);
    }
    // Everything after the first settling tick must be identical — no oscillation, and the
    // system must report no work to do.
    const tail = seen.slice(3);
    expect(new Set(tail).size).toBe(1);
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
    expect(sv.scrollBehavior).toBe('smooth');
    // Cleared immediately: leaving it set would re-issue the same scroll every frame and pin
    // the view in place.
    const en = view.get(UIEntries) as any;
    expect(en.scrollToEntryY).toBe(-1);
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
    sys.setEntryPrefabProvider({ rootSize: () => ({ width: 0, height: 0 }), spawnInstance: () => 0 });

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

  it('does nothing without a provider rather than throwing', async () => {
    const { sys } = await setup();
    sys.setEntryPrefabProvider(null);
    expect(() => sys.entriesSystem(testWorld)).not.toThrow();
  });
});
