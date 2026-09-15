// @vitest-environment jsdom
/** UI text overflow warning (#1126) — the decisions (`uiOverflow.ts`) and the scan's wiring
 *  (`uiOverflowScan.ts`) with the DOM measurement stubbed. jsdom has no layout, so whether the
 *  measurement itself reads the right boxes is covered in a real browser by
 *  `engine/tests/e2e/game-view-ui-overflow.spec.ts`; this file covers everything that is not a pixel. */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  classifyTextOverflow, confirmOverflow, uiOverflowKey, recordUIOverflow, getUIOverflowFindings,
  resetUIOverflowFindings, refreshUIOverflowCurrent, OVERFLOW_EPSILON_PX,
  type OverflowBox, type TextOverflowMeasure, type UIOverflowFinding,
} from '../../src/runtime/ui/uiOverflow';
import { scanUIOverflow, installUIOverflowScan, measureTextOverflow, isTranslationOnly, SCAN_DELAY_MS, type MeasureFn } from '../../src/runtime/ui/uiOverflowScan';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import type { UINodeData } from '../../src/runtime/ui/uiTreeStore';

const box = (entityId: number, left: number, right: number, over: Partial<OverflowBox> = {}): OverflowBox =>
  ({ entityId, left, right, clips: false, scrolls: false, transformed: false, positioned: false, ...over });
const ROOT_W = 360;
const measure = (textLeft: number, textRight: number, ...chain: OverflowBox[]): TextOverflowMeasure => ({ textLeft, textRight, chain, rootWidth: ROOT_W });

describe('classifyTextOverflow', () => {
  it('text inside its own box and its parent is not a finding', () => {
    expect(classifyTextOverflow(measure(10, 90, box(1, 10, 90), box(2, 0, 100)))).toBeNull();
  });

  it('text wider than its own (definite-width) box is own-box, measured against that box', () => {
    const v = classifyTextOverflow(measure(0, 103, box(1, 0, 88), box(2, 0, 400)));
    expect(v).toEqual({ kind: 'own-box', boxEntityId: 1, overflowPx: 15, availablePx: 88, textPx: 103, clipped: false });
  });

  it('a content-sized child running past its row is a spill, naming the row', () => {
    // #1119's measured LevelTabs shape: the text sits inside its own grown box, both past the row.
    const v = classifyTextOverflow(measure(123.4, 390.6, box(1, 123.4, 390.6), box(2, 130, 384)));
    expect(v?.kind).toBe('spill');
    expect(v?.boxEntityId).toBe(2);
    expect(v?.overflowPx).toBeCloseTo(6.6, 5);   // the larger of the two sides
    expect(v?.clipped).toBe(false);
  });

  it('overshoot at the epsilon is rounding, just past it is a finding', () => {
    expect(classifyTextOverflow(measure(0, 100 + OVERFLOW_EPSILON_PX, box(1, 0, 100)))).toBeNull();
    expect(classifyTextOverflow(measure(0, 100 + OVERFLOW_EPSILON_PX + 0.01, box(1, 0, 100)))?.kind).toBe('own-box');
  });

  it('an empty or unmeasurable text extent is never a finding', () => {
    expect(classifyTextOverflow(measure(0, 0, box(1, 10, 20)))).toBeNull();
    expect(classifyTextOverflow(measure(NaN, NaN, box(1, 10, 20)))).toBeNull();
  });

  it('a scroll container anywhere on the chain exempts the text — its content extends by design', () => {
    expect(classifyTextOverflow(measure(0, 500, box(1, 0, 500), box(2, 0, 100, { scrolls: true })))).toBeNull();
    expect(classifyTextOverflow(measure(0, 500, box(1, 0, 100, { scrolls: true })))).toBeNull();
  });

  it('an enclosing clip box stops the walk without comparing — a hidden pager holds off-page cards', () => {
    expect(classifyTextOverflow(measure(400, 500, box(1, 400, 500), box(2, 0, 100, { clips: true })))).toBeNull();
    // ...and it stops there: the grandparent beyond it is not consulted either.
    expect(classifyTextOverflow(measure(400, 500, box(1, 400, 500), box(2, 0, 100, { clips: true }), box(3, 0, 100)))).toBeNull();
  });

  it('the text\'s OWN clip is reported as truncation, unless the author asked for an ellipsis', () => {
    const clipped = classifyTextOverflow(measure(0, 130, box(1, 0, 100, { clips: true })));
    expect(clipped).toMatchObject({ kind: 'own-box', clipped: true });
    expect(classifyTextOverflow(measure(0, 130, box(1, 0, 100, { clips: true })), { authoredEllipsis: true })).toBeNull();
  });

  it('an authored ellipsis does not exempt a spill past an ENCLOSING box (close-out review, measured)', () => {
    // A 260px ellipsis child centred in a 200px row: its truncated text paints 30px past the row on
    // both sides. Production ALWAYS reports an ellipsis as the text's own clip (the wrapper div's
    // overflow: hidden), so the own box carries clips:true — the state the first version of this test
    // did not build, which is how it passed while the spill went unreported.
    const v = classifyTextOverflow(measure(-30, 500, box(1, -30, 230, { clips: true }), box(2, 0, 200)), { authoredEllipsis: true });
    expect(v).toMatchObject({ kind: 'spill', boxEntityId: 2, clipped: false });
    expect(v?.overflowPx).toBe(30);   // measured from the CLAMPED extent (-30..230), not the full text
  });

  it('the text\'s own clip clamps what is painted, and the walk goes on with that', () => {
    expect(classifyTextOverflow(measure(0, 400, box(1, 0, 100, { clips: true }), box(2, 0, 100)), { authoredEllipsis: true })).toBeNull();
    expect(classifyTextOverflow(measure(0, 100, box(1, 0, 100, { clips: true }), box(2, 20, 80)))?.kind).toBe('spill');
  });

  it('a scaled/rotated box is compared, then the walk stops (a pop tween)', () => {
    expect(classifyTextOverflow(measure(0, 100, box(1, 0, 100, { transformed: true }), box(2, 10, 90)))).toBeNull();
    expect(classifyTextOverflow(measure(0, 130, box(1, 0, 100, { transformed: true })))?.kind).toBe('own-box');
  });

  it('a PLACED box overhanging or out-sizing its HOST is not a finding — a corner badge, a caption under an icon', () => {
    // A badge overhanging its host's edge by 20px.
    expect(classifyTextOverflow(measure(70, 100, box(1, 70, 100, { positioned: true }), box(2, 0, 80)))).toBeNull();
    // "Settings" (50.6px) anchored under a 40px icon (close-out review: the host-width rule flagged it).
    expect(classifyTextOverflow(measure(-5.3, 45.3, box(1, -5.3, 45.3, { positioned: true }), box(2, 0, 40)))).toBeNull();
  });

  it('a PLACED box wider than the whole UI is a spill against the UI root, by excess WIDTH (#1126 live)', () => {
    // The measured AdBannerLabel at 360 wide: 417.2px of text in a 358px-wide UI.
    const m = { ...measure(358.3, 775.5, box(50, 358.3, 775.5, { positioned: true }), box(49, 387.9, 745.9, { positioned: true })), rootWidth: 358 };
    const v = classifyTextOverflow(m);
    expect(v).toMatchObject({ kind: 'spill', boxEntityId: 0, clipped: false });
    expect(v?.overflowPx).toBeCloseTo(417.2 - 358, 5);
    expect(v?.availablePx).toBe(358);
  });

  it('a PLACED box stops the walk — nothing past it is consulted, and an ellipsis clamps its width first', () => {
    expect(classifyTextOverflow(measure(0, 90, box(1, 0, 90, { positioned: true }), box(2, 500, 600), box(3, 0, 10)))).toBeNull();
    // 500px of text clipped by its own 300px ellipsis box: 300 painted, fits a 360px UI.
    expect(classifyTextOverflow(measure(0, 500, box(1, 0, 300, { positioned: true, clips: true })), { authoredEllipsis: true })).toBeNull();
    // A scroll container before the placed box still exempts it.
    expect(classifyTextOverflow(measure(0, 500, box(1, 0, 500, { scrolls: true, positioned: true })))).toBeNull();
  });

  it('a scroll or clip box FURTHER OUT than a placed box still exempts it (close-out re-review)', () => {
    // An anchored 615px credits line inside a scroll view; a translated 669px ticker in a hidden mask.
    expect(classifyTextOverflow(measure(0, 615, box(1, 0, 615, { positioned: true }), box(2, 0, 360), box(3, 0, 360, { scrolls: true })))).toBeNull();
    expect(classifyTextOverflow(measure(0, 669, box(1, 0, 669, { positioned: true }), box(2, 0, 360, { clips: true })))).toBeNull();
    // ...and without them the same line IS a finding, so the two above are the exemption, not a miss.
    expect(classifyTextOverflow(measure(0, 615, box(1, 0, 615, { positioned: true }), box(2, 0, 360)))?.boxEntityId).toBe(0);
  });

  it('keeps walking past a plain in-flow box to the first one the text escapes', () => {
    const v = classifyTextOverflow(measure(0, 120, box(1, 0, 120), box(2, 0, 120), box(3, 0, 100)));
    expect(v).toMatchObject({ kind: 'spill', boxEntityId: 3 });
  });
});

describe('isTranslationOnly', () => {
  it('a missing or pure-translation transform only moves the box', () => {
    expect(isTranslationOnly('none')).toBe(true);
    expect(isTranslationOnly('')).toBe(true);
    expect(isTranslationOnly('matrix(1, 0, 0, 1, -208.719, -9.58514)')).toBe(true);   // measured: UIAnchor centring
  });
  it('scale, rotation, skew and 3D are not a translation', () => {
    expect(isTranslationOnly('matrix(0.5, 0, 0, 0.5, 0, 0)')).toBe(false);
    expect(isTranslationOnly('matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0)')).toBe(false);
    expect(isTranslationOnly('matrix(1, 0, 0.2, 1, 0, 0)')).toBe(false);
    expect(isTranslationOnly('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)')).toBe(false);
  });
});

describe('confirmOverflow', () => {
  it('records only what was already pending, and holds the new ones for the next pass', () => {
    const r1 = confirmOverflow(new Set(), new Map([['a', 1], ['b', 2]]));
    expect(r1.confirmed).toEqual([]);
    expect([...r1.pending]).toEqual(['a', 'b']);
    // 'a' went away (a transient — AutoFitText converged), 'b' persisted, 'c' is new.
    const r2 = confirmOverflow(r1.pending, new Map([['b', 2], ['c', 3]]));
    expect(r2.confirmed).toEqual([['b', 2]]);
    expect([...r2.pending]).toEqual(['c']);
  });
});

describe('uiOverflowKey', () => {
  it('uses the guid, else the recycle-safe id:generation pair', () => {
    expect(uiOverflowKey({ guid: 'g-1', entityId: 4, generation: 2 })).toBe('g-1');
    expect(uiOverflowKey({ guid: '', entityId: 4, generation: 2 })).toBe('4:2');
  });
});

const finding = (over: Partial<UIOverflowFinding> = {}): Omit<UIOverflowFinding, 'current' | 'boxGuid'> => ({
  kind: 'own-box', boxEntityId: 7, overflowPx: 15.04, availablePx: 88.26, textPx: 103.31, clipped: false,
  entityId: 7, guid: 'g-7', text: 'Vibration on', viewport: { w: 360.4, h: 640 }, ...over,
});

describe('the findings store', () => {
  let game: TestWorld | undefined;
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { game?.dispose(); game = undefined; resetUIOverflowFindings(); vi.restoreAllMocks(); });

  it('records once per key, rounds once for every surface, and cuts long text', () => {
    game = createTestWorld({});
    expect(recordUIOverflow('g-7', finding({ text: 'x'.repeat(200) }))).toBe(true);
    expect(recordUIOverflow('g-7', finding())).toBe(false);
    const [f] = getUIOverflowFindings();
    expect(getUIOverflowFindings()).toHaveLength(1);
    expect(f).toMatchObject({ overflowPx: 15, availablePx: 88.3, textPx: 103.3, viewport: { w: 360, h: 640 }, current: true });
    expect(f.text).toBe(`${'x'.repeat(80)}…`);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('emits one @ui.overflow journal event at warn level, carrying the same numbers', () => {
    game = createTestWorld({});
    recordUIOverflow('g-7', finding());
    recordUIOverflow('g-7', finding());
    const events = game.events().filter((e) => e.type === '@ui.overflow');
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('warn');
    expect(events[0].payload).toMatchObject({ key: 'g-7', kind: 'own-box', overflowPx: 15, text: 'Vibration on' });
  });

  it('current is exactly "overflowing in the latest scan" — fixed, or no longer rendered, is not current', () => {
    game = createTestWorld({});
    recordUIOverflow('a', finding());
    recordUIOverflow('b', finding());
    const cur = () => Object.fromEntries(getUIOverflowFindings().map((f, i) => [['a', 'b'][i], f.current]));
    refreshUIOverflowCurrent(new Set(['b']));   // a fixed or unmounted; b still overflowing
    expect(cur()).toEqual({ a: false, b: true });
    refreshUIOverflowCurrent(new Set(['a']));   // a overflows again; b gone
    expect(cur()).toEqual({ a: true, b: false });
    expect(console.warn).toHaveBeenCalledTimes(2);   // re-overflowing does not warn again
  });

  it('a read cannot mutate the store', () => {
    game = createTestWorld({});
    recordUIOverflow('a', finding());
    const [f] = getUIOverflowFindings();
    f.current = false; f.viewport.w = 1;
    expect(getUIOverflowFindings()[0]).toMatchObject({ current: true, viewport: { w: 360 } });
  });

  it('is cleared by a world swap — a finding describes an element of the world it was seen in', () => {
    game = createTestWorld({});
    recordUIOverflow('g-7', finding());
    expect(getUIOverflowFindings()).toHaveLength(1);
    game.dispose();
    game = createTestWorld({});   // makes a NEW world current, which fires onWorldSwap
    expect(getUIOverflowFindings()).toHaveLength(0);
  });
});

// ── The scan, with the DOM measurement stubbed ──────────────────────────────────────────────────

const node = (entityId: number, text: string, children: UINodeData[] = [], over: Partial<UINodeData> = {}): UINodeData =>
  ({ entityId, guid: `g-${entityId}`, generation: 0, text, textOverflow: 'clip', children, ...over }) as unknown as UINodeData;

function domFor(ids: number[]): HTMLElement {
  const root = document.createElement('div');
  let parent = root;
  for (const id of ids) {
    const el = document.createElement('div');
    el.setAttribute('data-entity-id', String(id));
    el.textContent = `label ${id}`;
    parent.appendChild(el);
    parent = el;
  }
  document.body.appendChild(root);
  return root;
}

const overflowing: MeasureFn = () => measure(0, 130, box(1, 0, 100));

describe('scanUIOverflow', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('measures every rendered node that carries text, at any depth, and skips the ones without', () => {
    const root = domFor([1, 2, 3]);
    const seen: number[] = [];
    const m: MeasureFn = (host) => { seen.push(Number(host.getAttribute('data-entity-id'))); return measure(0, 130, box(1, 0, 100)); };
    const found = scanUIOverflow(root, [node(1, 'a', [node(2, '', [node(3, 'c')])])], m);
    expect(seen).toEqual([1, 3]);
    expect([...found.keys()]).toEqual(['g-1', 'g-3']);
    expect(found.get('g-3')).toMatchObject({ entityId: 3, guid: 'g-3', kind: 'own-box', text: 'label 3' });
  });

  it('passes an authored ellipsis through to the decision', () => {
    const root = domFor([1]);
    const clippedOwn: MeasureFn = () => measure(0, 130, box(1, 0, 100, { clips: true }));
    expect(scanUIOverflow(root, [node(1, 'a')], clippedOwn).size).toBe(1);
    expect(scanUIOverflow(root, [node(1, 'a', [], { textOverflow: 'ellipsis' })], clippedOwn).size).toBe(0);
  });

  it('a projected node with no rendered element (hidden by a binding) is skipped, not an error', () => {
    const root = domFor([1]);
    expect(scanUIOverflow(root, [node(1, 'a'), node(9, 'not rendered')], overflowing).size).toBe(1);
  });
});

describe('measureTextOverflow — what counts as the text', () => {
  const realCreateRange = document.createRange;
  afterEach(() => { document.createRange = realCreateRange; document.body.innerHTML = ''; });

  it('measures the runs of non-whitespace characters only — a hanging space is not text', () => {
    // jsdom has no layout, so a range answers as monospace: each character 10px wide from x=0.
    const rect = (l: number, r: number) => ({ left: l, right: r, width: r - l, top: 0, bottom: 10, height: 10, x: l, y: 0, toJSON() {} }) as DOMRect;
    document.createRange = () => {
      let start = 0; let end = 0;
      return { setStart: (_n: Node, o: number) => { start = o; }, setEnd: (_n: Node, o: number) => { end = o; }, getClientRects: () => [rect(start * 10, end * 10)] } as unknown as Range;
    };
    const root = domFor([1]);
    const host = root.firstElementChild as HTMLElement;
    host.textContent = 'ab  cd     ';   // glyphs end at 60px; the trailing spaces would reach 110px
    const m = measureTextOverflow(host, root, 1);
    expect(m).toMatchObject({ textLeft: 0, textRight: 60 });
  });
});

describe('installUIOverflowScan', () => {
  let game: TestWorld | undefined;
  const realCreateRange = document.createRange;
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}); game = createTestWorld({}); });
  afterEach(() => {
    vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = '';
    document.createRange = realCreateRange;
    game?.dispose(); game = undefined; resetUIOverflowFindings();
  });

  // The installer always uses the REAL measurement, and jsdom has no layout: every rect is 0x0 and
  // Range has no getClientRects. So the one host is given a 100px box and its text node's range a
  // 130px extent — an own-box overflow the real `measureTextOverflow` then reads end to end.
  let textRight = 130;
  beforeEach(() => { textRight = 130; });
  function install(tree: () => UINodeData[], subscribe = (_cb: () => void) => () => {}) {
    const root = domFor([1]);
    const rect = (l: number, r: number) => ({ left: l, right: r, width: r - l, top: 0, bottom: 10, height: 10, x: l, y: 0, toJSON() {} }) as DOMRect;
    const host = root.firstElementChild as HTMLElement;
    Object.defineProperty(host, 'clientWidth', { value: 100, configurable: true });
    host.getBoundingClientRect = () => rect(0, 100);
    document.createRange = () => ({ setStart() {}, setEnd() {}, getClientRects: () => [rect(0, textRight)] }) as unknown as Range;
    return { root, dispose: installUIOverflowScan(root, tree, subscribe) };
  }

  it('records a finding only after a SECOND pass still sees it', () => {
    const { dispose } = install(() => [node(1, 'a')]);
    vi.advanceTimersByTime(SCAN_DELAY_MS);
    expect(getUIOverflowFindings()).toHaveLength(0);   // first pass: pending only
    vi.advanceTimersByTime(SCAN_DELAY_MS);             // the pending candidate schedules its own re-look
    expect(getUIOverflowFindings()).toHaveLength(1);
    dispose();
  });

  it('a RECORDED overflow that persists is not re-confirmed — a later trigger costs one pass, not two', () => {
    let notify: () => void = () => {};
    const { dispose } = install(() => [node(1, 'a')], (cb) => { notify = cb; return () => {}; });
    vi.advanceTimersByTime(SCAN_DELAY_MS * 2);
    expect(getUIOverflowFindings()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    notify();                                // any later trigger while it still overflows
    vi.advanceTimersByTime(SCAN_DELAY_MS);
    expect(vi.getTimerCount()).toBe(0);      // re-entering confirmation would queue a second pass
    dispose();
  });

  it('a later pass that measures the element clean marks the finding no longer current', () => {
    let notify: () => void = () => {};
    const { dispose } = install(() => [node(1, 'a')], (cb) => { notify = cb; return () => {}; });
    vi.advanceTimersByTime(SCAN_DELAY_MS * 2);
    expect(getUIOverflowFindings()[0].current).toBe(true);
    textRight = 90;                          // the author widened the box / shortened the string
    notify();
    vi.advanceTimersByTime(SCAN_DELAY_MS);
    expect(getUIOverflowFindings()[0].current).toBe(false);
    dispose();
  });

  it('a candidate gone by the second pass is never recorded', () => {
    let tree = [node(1, 'a')];
    const { dispose } = install(() => tree);
    vi.advanceTimersByTime(SCAN_DELAY_MS);
    tree = [];                                         // e.g. the label was replaced by something that fits
    vi.advanceTimersByTime(SCAN_DELAY_MS * 3);
    expect(getUIOverflowFindings()).toHaveLength(0);
    dispose();
  });

  it('a UI tree change schedules a pass', () => {
    let notify: () => void = () => {};
    let tree: UINodeData[] = [];
    const { dispose } = install(() => tree, (cb) => { notify = cb; return () => {}; });
    vi.advanceTimersByTime(SCAN_DELAY_MS * 5);         // the initial pass finds nothing and goes quiet
    tree = [node(1, 'a')];
    notify();
    vi.advanceTimersByTime(SCAN_DELAY_MS * 2);
    expect(getUIOverflowFindings()).toHaveLength(1);
    dispose();
  });

  it('teardown cancels the queued pass and unsubscribes from the tree', () => {
    const unsubscribe = vi.fn();
    const { dispose } = install(() => [node(1, 'a')], () => unsubscribe);
    dispose();
    vi.advanceTimersByTime(SCAN_DELAY_MS * 5);
    expect(getUIOverflowFindings()).toHaveLength(0);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  // The `disposed` flag alone already stops a leaked observer from SCANNING, so without these a
  // deleted disconnect() stays green while the observer (and its root) leak — the close-out review's
  // mutation. Each teardown call is pinned on its own.
  it('teardown disconnects the mutation + resize observers and drops the font listener', () => {
    const moDisconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const ros: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe = vi.fn(); disconnect = vi.fn(); constructor() { ros.push(this); } };
    const fonts = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
    try {
      const { dispose } = install(() => [node(1, 'a')]);
      const listener = fonts.addEventListener.mock.calls[0]?.[1];
      expect(fonts.addEventListener).toHaveBeenCalledWith('loadingdone', listener);
      dispose();
      expect(moDisconnect).toHaveBeenCalledTimes(1);
      expect(ros).toHaveLength(1);
      expect(ros[0].disconnect).toHaveBeenCalledTimes(1);
      expect(fonts.removeEventListener).toHaveBeenCalledWith('loadingdone', listener);
    } finally {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      delete (document as { fonts?: unknown }).fonts;
    }
  });
});
