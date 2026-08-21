/** uiTreeStore node-reuse tests.
 *
 *  buildTree reconciles each rebuild against the previous frame so an entity
 *  whose data + subtree are unchanged keeps its OLD object reference, letting
 *  React.memo(UINode) skip it. These tests lock that contract:
 *   - unchanged → same ref reused (the whole point)
 *   - any changed field → a NEW ref (correctness; stale UI otherwise)
 *   - reuse propagates bottom-up (changing a leaf only re-refs its ancestors)
 *   - the equality check is EXHAUSTIVE over every scalar field + nested block
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => { vi.resetModules(); });

// ── Trait identity objects (what buildTree passes to entity.has/get) ──
const RUI = { id: 'RenderableUI' };
const UIEL = { id: 'UIElement' };
const ATTR = { id: 'EntityAttributes' };
const BIND = { id: 'UIBinding' };
const ACT = { id: 'UIAction' };
const ANC = { id: 'UIAnchor' };
const CV2 = { id: 'Canvas2D' };
const VID = { id: 'VideoPlayer' };
const TGL = { id: 'UIToggle' };
const TCH = { id: 'TouchControl' };

const UI_DEFAULTS = {
  width: 100, height: 40, widthUnit: 'px', heightUnit: 'px',
  flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'flex-start', alignItems: 'stretch',
  gap: 0, flexGrow: 0, flexShrink: 1,
  paddingTop: 0, paddingLeft: 0, paddingRight: 0, paddingBottom: 0,
  marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
  minWidth: 0, maxWidth: 0, minHeight: 0, maxHeight: 0,
  alignSelf: 'auto', zIndex: 0, overflow: 'visible', isVisible: true,
  backgroundColor: 0, backgroundOpacity: 0, borderRadius: 0, borderWidth: 0, borderColor: 0x333333, borderOpacity: 1, opacity: 1,
  text: 'hi', fontFamily: '', fontSize: 16, fontWeight: 'normal', fontStyle: 'normal',
  textColor: 0xffffff, textOpacity: 1, textAlign: 'left', lineHeight: 0, letterSpacing: 0,
  textShadowColor: 0, textShadowOpacity: 1, textShadowOffsetX: 0, textShadowOffsetY: 0, textShadowBlur: 0,
  textStrokeColor: 0, textStrokeOpacity: 1, textStrokeWidth: 0, textOverflow: 'clip', maxLines: 0,
  imageSrc: '', imageMode: 'cover', elementType: 'div', placeholder: '',
  rangeMin: 0, rangeMax: 100, rangeStep: 1,
};

interface Spec {
  id: number; parentId: number; sortOrder?: number;
  ui?: Record<string, unknown>;
  anchor?: Record<string, unknown>;
  action?: { bindings: unknown[] };
  binding?: { textBinding: string; inputBinding: string };
  canvas2D?: { referenceWidth: number; referenceHeight: number; scaleMode: string };
  /** Present = the entity also carries a `VideoPlayer`. Its FIELDS are deliberately not
   *  modelled: `hasVideo` is presence-only, so a spec that carried values would imply
   *  buildTree reads them. */
  video?: true;
  toggle?: { value: boolean };
  touch?: { action: string; showOn: string; pressedOpacity: number };
}

/** A koota-like world whose entity set is read fresh from `getSpecs()` on every
 *  query, so a test can mutate the specs between projection calls. */
function makeWorld(getSpecs: () => Spec[]) {
  return {
    query: () => ({
      updateEach: (cb: (data: unknown[], entity: unknown) => void) => {
        for (const s of getSpecs()) {
          const data = new Map<unknown, unknown>();
          data.set(UIEL, { ...UI_DEFAULTS, ...(s.ui || {}) });
          data.set(ATTR, { parentId: s.parentId, sortOrder: s.sortOrder ?? 0, guid: '' });
          if (s.anchor) data.set(ANC, s.anchor);
          if (s.action) data.set(ACT, s.action);
          if (s.binding) data.set(BIND, s.binding);
          if (s.canvas2D) data.set(CV2, s.canvas2D);
          if (s.video) data.set(VID, {});
          if (s.toggle) data.set(TGL, s.toggle);
          if (s.touch) data.set(TCH, s.touch);
          const entity = { id: () => s.id, has: (t: unknown) => data.has(t), get: (t: unknown) => data.get(t) };
          cb([data.get(UIEL)], entity);
        }
      },
    }),
  } as never;
}

function mockDeps() {
  vi.doMock('../../src/runtime/core/ecs/world', () => ({ getCurrentWorld: vi.fn(), onWorldSwap: vi.fn() }));
  vi.doMock('../../src/runtime/core/ecs/entityUtils', () => ({ addDirtyListener: vi.fn() }));
  vi.doMock('../../src/runtime/core/ecs/traitRegistry', () => ({
    getAllTraits: () => [
      { name: 'RenderableUI', trait: RUI, category: 'component', fields: {} },
      { name: 'UIElement', trait: UIEL, category: 'component', fields: {} },
      { name: 'EntityAttributes', trait: ATTR, category: 'component', fields: {} },
      { name: 'UIBinding', trait: BIND, category: 'component', fields: {} },
      { name: 'UIAction', trait: ACT, category: 'component', fields: {} },
      { name: 'UIAnchor', trait: ANC, category: 'component', fields: {} },
      { name: 'Canvas2D', trait: CV2, category: 'component', fields: {} },
      { name: 'VideoPlayer', trait: VID, category: 'component', fields: {} },
      { name: 'UIToggle', trait: TGL, category: 'component', fields: {} },
      { name: 'TouchControl', trait: TCH, category: 'component', fields: {} },
    ],
  }));
}

async function load() {
  mockDeps();
  return import('../../src/runtime/ui/uiTreeStore');
}

/** byId index over the current tree, for ref comparison. */
function index(tree: any[]): Map<number, any> {
  const m = new Map<number, any>();
  const walk = (n: any) => { m.set(n.entityId, n); n.children.forEach(walk); };
  tree.forEach(walk);
  return m;
}

describe('uiTreeStore node reuse', () => {
  it('reuses every node reference when nothing changed', async () => {
    const specs: Spec[] = [
      { id: 1, parentId: 0 },
      { id: 2, parentId: 1 },
      { id: 3, parentId: 2 },
    ];
    const { uiTreeProjection, useUITreeStore, markUIDirty } = await load();
    const world = makeWorld(() => specs);

    uiTreeProjection(world);
    const a = index(useUITreeStore.getState().tree);

    markUIDirty();
    uiTreeProjection(world);
    const b = index(useUITreeStore.getState().tree);

    for (const id of [1, 2, 3]) expect(b.get(id)).toBe(a.get(id)); // same object refs
  });

  it('new ref only for the changed node and its ancestors; siblings reused', async () => {
    // 1 ─┬ 2 ─ 4   (4 is the leaf we change)
    //    └ 3       (unrelated sibling subtree)
    const specs: Spec[] = [
      { id: 1, parentId: 0 },
      { id: 2, parentId: 1 },
      { id: 3, parentId: 1 },
      { id: 4, parentId: 2, ui: { width: 50 } },
    ];
    const { uiTreeProjection, useUITreeStore, markUIDirty } = await load();
    const world = makeWorld(() => specs);

    uiTreeProjection(world);
    const a = index(useUITreeStore.getState().tree);

    specs[3].ui = { width: 999 }; // mutate the leaf
    markUIDirty();
    uiTreeProjection(world);
    const b = index(useUITreeStore.getState().tree);

    expect(b.get(4)).not.toBe(a.get(4)); // changed leaf → new ref
    expect(b.get(2)).not.toBe(a.get(2)); // ancestor → new ref (child changed)
    expect(b.get(1)).not.toBe(a.get(1)); // root → new ref
    expect(b.get(3)).toBe(a.get(3));     // unrelated sibling → reused
  });

  it('reuses a node whose only changed sibling is elsewhere', async () => {
    const specs: Spec[] = [
      { id: 1, parentId: 0 },
      { id: 2, parentId: 1, ui: { text: 'a' } },
      { id: 3, parentId: 1, ui: { text: 'b' } },
    ];
    const { uiTreeProjection, useUITreeStore, markUIDirty } = await load();
    const world = makeWorld(() => specs);
    uiTreeProjection(world);
    const a = index(useUITreeStore.getState().tree);

    specs[1].ui = { text: 'CHANGED' }; // only node 2 changes
    markUIDirty();
    uiTreeProjection(world);
    const b = index(useUITreeStore.getState().tree);

    expect(b.get(2)).not.toBe(a.get(2));
    expect(b.get(3)).toBe(a.get(3)); // sibling reused
    expect(b.get(1)).not.toBe(a.get(1)); // parent re-refs (a child changed)
  });

  it('detects anchor, action, and canvas2D changes', async () => {
    const specs: Spec[] = [{
      id: 1, parentId: 0,
      anchor: { anchor: 'left', top: 0, topUnit: 'px', right: 0, rightUnit: 'px', bottom: 0, bottomUnit: 'px', left: 20, leftUnit: 'px', pivotX: 0, pivotY: 0, safeArea: false, zIndex: 0 },
      action: { bindings: [] },
      canvas2D: { referenceWidth: 800, referenceHeight: 600, scaleMode: 'fit' },
    }];
    const { uiTreeProjection, useUITreeStore, markUIDirty } = await load();
    const world = makeWorld(() => specs);
    uiTreeProjection(world);
    const r1 = useUITreeStore.getState().tree[0];

    // empty action bindings are treated equal → reused when only no-ops happen
    markUIDirty(); uiTreeProjection(world);
    expect(useUITreeStore.getState().tree[0]).toBe(r1);

    // change an anchor offset → new ref
    specs[0].anchor!.left = 200;
    markUIDirty(); uiTreeProjection(world);
    const r2 = useUITreeStore.getState().tree[0];
    expect(r2).not.toBe(r1);

    // change action bindings → new ref
    specs[0].action = { bindings: [{ event: 'Click' }] };
    markUIDirty(); uiTreeProjection(world);
    const r3 = useUITreeStore.getState().tree[0];
    expect(r3).not.toBe(r2);
  });

  it('nodesEqual is exhaustive: mutating ANY scalar field breaks equality', async () => {
    const specs: Spec[] = [{
      id: 1, parentId: 0,
      anchor: { anchor: 'left', top: 1, topUnit: 'px', right: 2, rightUnit: 'px', bottom: 3, bottomUnit: 'px', left: 4, leftUnit: 'px', pivotX: 0.1, pivotY: 0.2, safeArea: true, zIndex: 5 },
      binding: { textBinding: 'x', inputBinding: 'y' },
      canvas2D: { referenceWidth: 800, referenceHeight: 600, scaleMode: 'fit' },
    }];
    const { uiTreeProjection, useUITreeStore, nodesEqual } = await load();
    uiTreeProjection(makeWorld(() => specs));
    const base = useUITreeStore.getState().tree[0];

    // sanity: a structural clone is equal to itself
    const cloneOf = (n: any) => ({ ...n, children: [...n.children], anchor: { ...n.anchor }, binding: { ...n.binding }, canvas2D: { ...n.canvas2D } });
    expect(nodesEqual(base, cloneOf(base))).toBe(true);

    // every scalar field: flipping it alone must make nodesEqual false
    const nested = new Set(['children', 'binding', 'action', 'anchor', 'canvas2D', 'entityId']);
    const scalarKeys = Object.keys(base).filter((k) => !nested.has(k));
    expect(scalarKeys.length).toBeGreaterThan(40); // guard: we really are iterating the full shape
    for (const k of scalarKeys) {
      const m = cloneOf(base);
      const cur = (m as any)[k];
      (m as any)[k] = typeof cur === 'boolean' ? !cur : typeof cur === 'number' ? cur + 1 : `${cur}_changed`;
      expect(nodesEqual(base, m), `field "${k}" not covered by nodesEqual`).toBe(false);
    }

    // nested blocks too
    const aMut = cloneOf(base); (aMut.anchor as any).left = 9999;
    expect(nodesEqual(base, aMut)).toBe(false);
    const bMut = cloneOf(base); (bMut.binding as any).textBinding = 'z';
    expect(nodesEqual(base, bMut)).toBe(false);
    const cMut = cloneOf(base); (cMut.canvas2D as any).scaleMode = 'stretch';
    expect(nodesEqual(base, cMut)).toBe(false);
  });
});

/** `hasVideo` — the projection seam for video-in-a-UI-node.
 *
 *  `UIVideoMount` was covered in isolation and `nodesEqual` covers `hasVideo` as one of the
 *  scalar keys above, but NOTHING drove the chain production actually takes: a `VideoPlayer`
 *  on a UI entity → `buildTree` → `node.hasVideo` → `UINode` mounts the clip. Both halves
 *  could have been green with the projection never setting the flag at all.
 *
 *  The re-ref case is the one the field's own comment in `uiTreeStore.ts` argues for: it is a
 *  PLAIN SCALAR, always written, precisely so a node whose video appeared or vanished does not
 *  keep its old object reference and never re-render. That claim was an assertion in a comment. */
describe('uiTreeStore hasVideo', () => {
  it('is false for a UI entity with no VideoPlayer', async () => {
    const { uiTreeProjection, useUITreeStore } = await load();
    uiTreeProjection(makeWorld(() => [{ id: 1, parentId: 0 }]));
    expect(useUITreeStore.getState().tree[0].hasVideo).toBe(false);
  });

  it('is true when the entity carries a VideoPlayer', async () => {
    const { uiTreeProjection, useUITreeStore } = await load();
    uiTreeProjection(makeWorld(() => [{ id: 1, parentId: 0, video: true }]));
    expect(useUITreeStore.getState().tree[0].hasVideo).toBe(true);
  });

  it('re-refs the node when the VideoPlayer is added or removed', async () => {
    const specs: Spec[] = [{ id: 1, parentId: 0 }];
    const { uiTreeProjection, useUITreeStore, markUIDirty } = await load();
    const world = makeWorld(() => specs);

    uiTreeProjection(world);
    const before = useUITreeStore.getState().tree[0];
    expect(before.hasVideo).toBe(false);

    specs[0].video = true;
    markUIDirty(); uiTreeProjection(world);
    const added = useUITreeStore.getState().tree[0];
    expect(added).not.toBe(before);   // a reused ref here = a backdrop that never appears
    expect(added.hasVideo).toBe(true);

    delete specs[0].video;
    markUIDirty(); uiTreeProjection(world);
    const removed = useUITreeStore.getState().tree[0];
    expect(removed).not.toBe(added);
    expect(removed.hasVideo).toBe(false);
  });
});

/** `toggle` — the reconciliation guard for the on/off control (#280). `toggle` sits in
 *  `_nestedKeys`, so `nodesEqual` must compare it structurally rather than by reference;
 *  without this, flipping ONLY `UIToggle.value` (the common case — the game writes it via
 *  a binding every click) would keep the node's old object reference and the switch would
 *  never visibly move. */
describe('uiTreeStore toggle', () => {
  it('two nodes differing ONLY in toggle.value are NOT nodesEqual', async () => {
    const specs: Spec[] = [{ id: 1, parentId: 0, toggle: { value: false } }];
    const { uiTreeProjection, useUITreeStore, markUIDirty } = await load();
    const world = makeWorld(() => specs);

    uiTreeProjection(world);
    const before = useUITreeStore.getState().tree[0];
    expect(before.toggle?.value).toBe(false);

    specs[0].toggle = { value: true };
    markUIDirty(); uiTreeProjection(world);
    const after = useUITreeStore.getState().tree[0];
    expect(after).not.toBe(before);          // a reused ref here = a switch that never animates
    expect(after.toggle?.value).toBe(true);
  });
});

/** `fontFamily` — the projection is where a font-asset GUID becomes a CSS family (#231), so
 *  this is the WIRING test for it: a node whose authored `fontFamily` is a GUID must come out
 *  of `buildTree` carrying the resolved family, because `UINode` writes that value straight
 *  into `style.fontFamily` and would otherwise put a GUID there (text in the browser default,
 *  silently — nothing errors when a `font-family` names no font).
 *
 *  Asserted through a real projection rather than by spying on `resolveUIFontFamily`: a spy
 *  passes whether or not the result reaches the node. */
describe('uiTreeStore fontFamily resolution', () => {
  const FONT_GUID = '30000000-0000-4000-8000-000000000001';

  async function loadWithFontProvider() {
    const mod = await load();
    const { domFontProvider } = await import('../../src/runtime/core/domFontProvider');
    domFontProvider.provide({ familyForGuid: (g) => (g === FONT_GUID ? 'Varela Round' : undefined) });
    return mod;
  }

  it('resolves an authored GUID to the CSS family on the node', async () => {
    const specs: Spec[] = [{ id: 1, parentId: 0, ui: { fontFamily: FONT_GUID } }];
    const { uiTreeProjection, useUITreeStore } = await loadWithFontProvider();

    uiTreeProjection(makeWorld(() => specs));
    expect(useUITreeStore.getState().tree[0].fontFamily).toBe('"Varela Round"');
  });

  it('falls back to systemFont, and the asset wins when both are authored', async () => {
    const specs: Spec[] = [
      { id: 1, parentId: 0, ui: { fontFamily: '', systemFont: 'system-ui' } },
      { id: 2, parentId: 0, ui: { fontFamily: FONT_GUID, systemFont: 'system-ui' } },
    ];
    const { uiTreeProjection, useUITreeStore } = await loadWithFontProvider();

    uiTreeProjection(makeWorld(() => specs));
    const byId = index(useUITreeStore.getState().tree);
    expect(byId.get(1).fontFamily).toBe('system-ui');
    expect(byId.get(2).fontFamily).toBe('"Varela Round"');
  });

  /** Perturbation, per CLAUDE.md's authoring rule: changing the authored value must change
   *  the node. A value that coincides with the default cannot tell "read" from "ignored". */
  it('a changed font ref produces a NEW node with the new family', async () => {
    const specs: Spec[] = [{ id: 1, parentId: 0, ui: { fontFamily: '', systemFont: 'system-ui' } }];
    const { uiTreeProjection, useUITreeStore, markUIDirty } = await loadWithFontProvider();
    const world = makeWorld(() => specs);

    uiTreeProjection(world);
    const before = useUITreeStore.getState().tree[0];

    specs[0].ui = { fontFamily: FONT_GUID, systemFont: 'system-ui' };
    markUIDirty(); uiTreeProjection(world);
    const after = useUITreeStore.getState().tree[0];
    expect(after).not.toBe(before);
    expect(after.fontFamily).toBe('"Varela Round"');
  });
});

/** `touch` — the reconciliation guard for on-screen controls (#297). Same shape as `toggle`
 *  above and the same reason: `touch` sits in `_nestedKeys`, so `nodesEqual` must compare it
 *  STRUCTURALLY. Without that comparison the projection would carry the block correctly and the
 *  reconciler would still hand back the previous node object, `React.memo(UINode)` would bail,
 *  and the DOM would keep the OLD `data-modoki-touch` — so re-authoring an arrow from `moveLeft`
 *  to `moveRight` in the Inspector would leave it walking left, with correct data everywhere and
 *  a stale attribute in the one place that decides. `showOn` has the same failure with a worse
 *  face: flipping it to `never` would leave a live control on screen.
 *
 *  The exhaustiveness test above cannot cover this — it derives its key list from a fixture node,
 *  and an OPTIONAL nested block is absent from that node, so the loop skips it silently. */
describe('uiTreeStore touch', () => {
  const base = { action: 'moveLeft', showOn: 'touch', pressedOpacity: 0.6 };

  it('two nodes differing ONLY in touch.action are NOT nodesEqual', async () => {
    const specs: Spec[] = [{ id: 1, parentId: 0, touch: { ...base } }];
    const { uiTreeProjection, useUITreeStore, markUIDirty } = await load();
    const world = makeWorld(() => specs);

    uiTreeProjection(world);
    const before = useUITreeStore.getState().tree[0];
    expect(before.touch?.action).toBe('moveLeft');

    specs[0].touch = { ...base, action: 'moveRight' };
    markUIDirty(); uiTreeProjection(world);
    const after = useUITreeStore.getState().tree[0];
    expect(after).not.toBe(before);   // a reused ref here = an arrow that still walks the old way
    expect(after.touch?.action).toBe('moveRight');
  });

  it('two nodes differing ONLY in touch.showOn are NOT nodesEqual', async () => {
    const specs: Spec[] = [{ id: 1, parentId: 0, touch: { ...base } }];
    const { uiTreeProjection, useUITreeStore, markUIDirty } = await load();
    const world = makeWorld(() => specs);

    uiTreeProjection(world);
    const before = useUITreeStore.getState().tree[0];

    specs[0].touch = { ...base, showOn: 'never' };
    markUIDirty(); uiTreeProjection(world);
    const after = useUITreeStore.getState().tree[0];
    expect(after).not.toBe(before);   // a reused ref here = a control that refuses to disappear
    expect(after.touch?.showOn).toBe('never');
  });

  it('an unchanged touch block still REUSES the node — the comparison must not churn every frame', async () => {
    const specs: Spec[] = [{ id: 1, parentId: 0, touch: { ...base } }];
    const { uiTreeProjection, useUITreeStore, markUIDirty } = await load();
    const world = makeWorld(() => specs);

    uiTreeProjection(world);
    const before = useUITreeStore.getState().tree[0];
    specs[0].touch = { ...base };     // a FRESH object with identical values
    markUIDirty(); uiTreeProjection(world);
    expect(useUITreeStore.getState().tree[0]).toBe(before);
  });
});
