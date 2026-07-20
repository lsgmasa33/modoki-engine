/** uiTreeStore active-highlight tests.
 *
 *  A UIBinding can mark its element "active" by reading the SOURCE OF TRUTH on a
 *  target entity (e.g. SkeletalAnimator.clip) and comparing it to the element's
 *  own value — when they match, the element's background is overridden with
 *  highlightColor. These tests exercise that resolution path in buildTree against
 *  a mock world holding one non-UI target entity plus highlight-bound buttons. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => { vi.resetModules(); });

// Trait identity objects buildTree passes to entity.has/get.
const RUI = { id: 'RenderableUI' };
const UIEL = { id: 'UIElement' };
const ATTR = { id: 'EntityAttributes' };
const BIND = { id: 'UIBinding' };
const SKEL = { id: 'SkeletalAnimator' };

const UI_DEFAULTS = {
  width: 78, height: 38, widthUnit: 'px', heightUnit: 'px',
  flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'center', alignItems: 'center',
  gap: 0, flexGrow: 0, flexShrink: 1,
  paddingTop: 0, paddingLeft: 0, paddingRight: 0, paddingBottom: 0,
  marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
  minWidth: 0, maxWidth: 0, minHeight: 0, maxHeight: 0,
  alignSelf: 'auto', zIndex: 0, overflow: 'visible', isVisible: true,
  backgroundColor: 0x4f7fff, backgroundOpacity: 1, borderRadius: 8, borderWidth: 0, borderColor: 0x333333, borderOpacity: 1, opacity: 1,
  text: 'Clip', fontFamily: '', fontSize: 14, fontWeight: 'bold', fontStyle: 'normal',
  textColor: 0x000000, textOpacity: 1, textAlign: 'center', lineHeight: 0, letterSpacing: 0,
  textShadowColor: 0, textShadowOpacity: 1, textShadowOffsetX: 0, textShadowOffsetY: 0, textShadowBlur: 0,
  textStrokeColor: 0, textStrokeOpacity: 1, textStrokeWidth: 0, textOverflow: 'clip', maxLines: 0,
  imageSrc: '', imageMode: 'cover', elementType: 'div', placeholder: '',
  rangeMin: 0, rangeMax: 100, rangeStep: 1,
};

const BIND_DEFAULTS = {
  textBinding: '', inputBinding: '',
  highlightTarget: '', highlightComponent: '', highlightProperty: '', highlightValue: '', highlightColor: -1,
};

const ACTIVE = 0x2ecc71;
const ALIEN_GUID = 'alien-guid';

/** Build a mock world: one non-UI target entity (the animated alien, carrying a
 *  SkeletalAnimator with `clip`) and a set of highlight-bound buttons. The query
 *  returns the right data[0] + entity set per requested trait. `getClip()` lets a
 *  test flip the live clip between projection calls. */
function makeWorld(getClip: () => string, buttons: { guid: string; clipValue: string; highlightColor?: number; highlightTextColor?: number }[]) {
  const target = {
    [ATTR.id]: { parentId: 0, sortOrder: 0, guid: ALIEN_GUID },
    get [SKEL.id]() { return { clip: getClip() }; },
  } as Record<string, any>;

  const uiEntities = buttons.map((b, i) => ({
    id: 100 + i,
    traits: {
      [RUI.id]: true,
      [UIEL.id]: { ...UI_DEFAULTS, text: b.clipValue },
      [ATTR.id]: { parentId: 0, sortOrder: i, guid: b.guid },
      [BIND.id]: {
        ...BIND_DEFAULTS,
        highlightTarget: ALIEN_GUID, highlightComponent: 'SkeletalAnimator',
        highlightProperty: 'clip', highlightValue: b.clipValue,
        highlightColor: b.highlightColor ?? ACTIVE,
        highlightTextColor: b.highlightTextColor ?? -1,
      },
    },
  }));

  const targetEntity = {
    id: () => 1,
    has: (t: any) => t === ATTR || t === SKEL,
    get: (t: any) => (t === ATTR ? target[ATTR.id] : t === SKEL ? target[SKEL.id] : undefined),
  };
  const mkUI = (e: any) => ({
    id: () => e.id,
    has: (t: any) => !!e.traits[(t as any).id],
    get: (t: any) => e.traits[(t as any).id],
  });

  return {
    query: (...traits: any[]) => ({
      updateEach: (cb: (data: unknown[], entity: unknown) => void) => {
        // UI pass: RenderableUI + UIElement → only UI entities, data[0] = UIElement.
        if (traits.includes(UIEL)) {
          for (const e of uiEntities) cb([e.traits[UIEL.id]], mkUI(e));
          return;
        }
        // byGuid pass: EntityAttributes → ALL entities (target + buttons), data[0] = attr.
        if (traits.includes(ATTR)) {
          cb([target[ATTR.id]], targetEntity);
          for (const e of uiEntities) cb([e.traits[ATTR.id]], mkUI(e));
        }
      },
    }),
  } as never;
}

function mockDeps() {
  vi.doMock('../../src/runtime/ecs/world', () => ({ getCurrentWorld: vi.fn(), onWorldSwap: vi.fn() }));
  vi.doMock('../../src/runtime/ecs/entityUtils', () => ({ addDirtyListener: vi.fn() }));
  vi.doMock('../../src/runtime/ecs/traitRegistry', () => ({
    getAllTraits: () => [
      { name: 'RenderableUI', trait: RUI, category: 'component', fields: {} },
      { name: 'UIElement', trait: UIEL, category: 'component', fields: {} },
      { name: 'EntityAttributes', trait: ATTR, category: 'component', fields: {} },
      { name: 'UIBinding', trait: BIND, category: 'component', fields: {} },
      { name: 'SkeletalAnimator', trait: SKEL, category: 'component', fields: {} },
    ],
    getTraitByName: (n: string) => (n === 'SkeletalAnimator' ? { name: 'SkeletalAnimator', trait: SKEL, category: 'component', fields: {} } : undefined),
  }));
}

async function load() {
  mockDeps();
  return import('../../src/runtime/ui/uiTreeStore');
}

describe('uiTreeStore active-highlight', () => {
  it('overrides backgroundColor on the element whose value matches the live clip', async () => {
    const buttons = [
      { guid: 'b-idle', clipValue: 'Idel_Normal' },
      { guid: 'b-walk', clipValue: 'Walk-Cycle', highlightTextColor: 0xffffff }, // invert text on active
      { guid: 'b-run', clipValue: 'Run-Cycle' },
    ];
    const { uiTreeProjection, useUITreeStore } = await load();

    uiTreeProjection(makeWorld(() => 'Walk-Cycle', buttons));
    const tree = useUITreeStore.getState().tree;
    const byText = Object.fromEntries(tree.map((n: any) => [n.text, n]));

    expect(byText['Walk-Cycle'].backgroundColor).toBe(ACTIVE);   // active → highlighted
    expect(byText['Walk-Cycle'].backgroundOpacity).toBe(1);
    expect(byText['Walk-Cycle'].textColor).toBe(0xffffff);        // active text inverted to white
    expect(byText['Idel_Normal'].backgroundColor).toBe(0x4f7fff); // inactive → unchanged
    expect(byText['Idel_Normal'].textColor).toBe(0x000000);       // inactive text untouched (default black)
    expect(byText['Run-Cycle'].backgroundColor).toBe(0x4f7fff);
  });

  it('moves the highlight when the live clip changes between projections', async () => {
    const buttons = [
      { guid: 'b-idle', clipValue: 'Idel_Normal' },
      { guid: 'b-run', clipValue: 'Run-Cycle' },
    ];
    let clip = 'Idel_Normal';
    const { uiTreeProjection, useUITreeStore, markUIDirty } = await load();
    const world = makeWorld(() => clip, buttons);

    uiTreeProjection(world);
    let byText = Object.fromEntries(useUITreeStore.getState().tree.map((n: any) => [n.text, n]));
    expect(byText['Idel_Normal'].backgroundColor).toBe(ACTIVE);
    expect(byText['Run-Cycle'].backgroundColor).toBe(0x4f7fff);

    clip = 'Run-Cycle';
    markUIDirty();           // a clip set marks the projection dirty
    uiTreeProjection(world);
    byText = Object.fromEntries(useUITreeStore.getState().tree.map((n: any) => [n.text, n]));
    expect(byText['Idel_Normal'].backgroundColor).toBe(0x4f7fff); // highlight left
    expect(byText['Run-Cycle'].backgroundColor).toBe(ACTIVE);     // ...and moved here
  });

  // F1 (#7) — lock the documented repaint invariant: the highlight only re-resolves
  // when the tree rebuilds (on a UI dirty). A watched value mutated via a raw write
  // that bypasses markUIDirty (the animationSystem-style per-frame path) leaves the
  // highlight STALE until the next dirty. If F1 is ever upgraded to a watch-set that
  // tracks system-driven state, this assertion flips.
  it('does NOT re-resolve the highlight when the watched value changes without a dirty signal (F1)', async () => {
    const buttons = [
      { guid: 'b-idle', clipValue: 'Idel_Normal' },
      { guid: 'b-run', clipValue: 'Run-Cycle' },
    ];
    let clip = 'Idel_Normal';
    const { uiTreeProjection, useUITreeStore, markUIDirty } = await load();
    const world = makeWorld(() => clip, buttons);

    uiTreeProjection(world); // first build (module starts dirty)
    let byText = Object.fromEntries(useUITreeStore.getState().tree.map((n: any) => [n.text, n]));
    expect(byText['Idel_Normal'].backgroundColor).toBe(ACTIVE);

    // A system flips the live clip via a raw write — NO markUIDirty → projection clean.
    clip = 'Run-Cycle';
    uiTreeProjection(world); // _dirty is false → skipped, tree NOT rebuilt
    byText = Object.fromEntries(useUITreeStore.getState().tree.map((n: any) => [n.text, n]));
    expect(byText['Idel_Normal'].backgroundColor).toBe(ACTIVE);   // stale — still on Idle
    expect(byText['Run-Cycle'].backgroundColor).toBe(0x4f7fff);   // not yet moved

    // Any UI dirty makes it catch up to the live value.
    markUIDirty();
    uiTreeProjection(world);
    byText = Object.fromEntries(useUITreeStore.getState().tree.map((n: any) => [n.text, n]));
    expect(byText['Idel_Normal'].backgroundColor).toBe(0x4f7fff);
    expect(byText['Run-Cycle'].backgroundColor).toBe(ACTIVE);
  });

  it('ignores the highlight when disabled (highlightColor < 0) even on a clip match', async () => {
    const { uiTreeProjection, useUITreeStore } = await load();
    // Button's clip IS the live clip, but highlight is off → background unchanged.
    const world = makeWorld(() => 'Walk-Cycle', [{ guid: 'b-walk', clipValue: 'Walk-Cycle', highlightColor: -1 }]);
    uiTreeProjection(world);
    expect((useUITreeStore.getState().tree[0] as any).backgroundColor).toBe(0x4f7fff);
  });
});
