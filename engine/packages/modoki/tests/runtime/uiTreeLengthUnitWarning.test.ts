/** #529/#549: the width/height-vs-min/max unit-mismatch warning must fire for an
 *  entity inside a HIDDEN subtree (`isVisible: false`) — that is the exact shape of
 *  the bug it exists to catch (Court's `RulesClose`/`RulesLine4`, both inside the
 *  How-to-Play dialog, closed until a player opens it).
 *
 *  This pins the warning to the tree-BUILD pass (`uiTreeProjection` → `buildTree` in
 *  `uiTreeStore.ts`), which visits every UIElement regardless of `isVisible` (it skips
 *  only `deactivatedEntities` — a genuinely deactivated entity/ancestor). It does NOT
 *  exercise UINode's render, which early-returns on `!node.isVisible` before recursing
 *  into children — a render-time check would silently miss this case, which is exactly
 *  what happened once and was corrected. If this warning is ever moved back to render
 *  time, this test is the one that catches it.
 *
 *  Two separate assertions, each pinning a DIFFERENT half of the claim above:
 *  - `useUITreeStore.getState().tree` (checked directly, below) pins the ARCHITECTURE —
 *    that a hidden parent's child still gets a node built into the tree at all. Without
 *    this, the warn-message assertions alone would pass identically whether or not
 *    `buildTree` actually visits hidden subtrees, because the warning is emitted from
 *    the same loop that builds the node — this test would then only be proving
 *    `findLengthUnitSuspects` fires on the right shape, not that the hidden-subtree
 *    story is true.
 *  - The `console.warn` assertions pin the BEHAVIOUR — that the warning is one of the
 *    things that happens as a result. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => { vi.resetModules(); });

const RUI = { id: 'RenderableUI' };
const UIEL = { id: 'UIElement' };
const ATTR = { id: 'EntityAttributes' };

// UIElement.width/height default their UNIT to '%' (the trait's own koota default) —
// matched here, unlike buildTree's `ui.widthUnit || 'px'` fallback (a safety net for a
// genuinely missing field, never hit in production since the trait always supplies one).
const UI_DEFAULTS = {
  width: 100, height: 40, widthUnit: '%', heightUnit: '%',
  flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'flex-start', alignItems: 'stretch',
  gap: 0, flexGrow: 0, flexShrink: 1,
  paddingTop: 0, paddingLeft: 0, paddingRight: 0, paddingBottom: 0,
  marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
  minWidth: 0, maxWidth: 0, minHeight: 0, maxHeight: 0,
  alignSelf: 'auto', zIndex: 0, overflow: 'visible', isVisible: true,
  backgroundColor: 0, backgroundOpacity: 0, borderRadius: 0, borderWidth: 0, borderColor: 0x333333, borderOpacity: 1, opacity: 1,
  text: '', fontFamily: '', fontSize: 16, fontWeight: 'normal', fontStyle: 'normal',
  textColor: 0xffffff, textOpacity: 1, textAlign: 'left', lineHeight: 0, letterSpacing: 0,
  textShadowColor: 0, textShadowOpacity: 1, textShadowOffsetX: 0, textShadowOffsetY: 0, textShadowBlur: 0,
  textStrokeColor: 0, textStrokeOpacity: 1, textStrokeWidth: 0, textOverflow: 'clip', maxLines: 0,
  imageSrc: '', imageMode: 'cover', elementType: 'div', placeholder: '',
  rangeMin: 0, rangeMax: 100, rangeStep: 1,
};

interface Spec {
  id: number; parentId: number; name?: string;
  ui?: Record<string, unknown>;
}

/** A koota-like world whose entity set is read fresh from `getSpecs()` on every query. */
function makeWorld(specs: Spec[]) {
  return {
    query: () => ({
      updateEach: (cb: (data: unknown[], entity: unknown) => void) => {
        for (const s of specs) {
          const data = new Map<unknown, unknown>();
          data.set(UIEL, { ...UI_DEFAULTS, ...(s.ui || {}) });
          data.set(ATTR, { parentId: s.parentId, sortOrder: 0, guid: '', name: s.name || '' });
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
    ],
  }));
}

async function load() {
  mockDeps();
  return import('../../src/runtime/ui/uiTreeStore');
}

describe('length-unit mismatch warning fires inside a hidden subtree', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns for a hidden dialog child shaped like Court RulesClose (width/height % default, max* px default)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { uiTreeProjection, markUIDirty } = await load();

    // Dialog root is isVisible:false (closed); RulesClose is its child. UINode's render
    // would never reach the child at all — the tree-build pass still must.
    const specs: Spec[] = [
      { id: 1, parentId: 0, name: 'HowToPlayDialog', ui: { isVisible: false } },
      { id: 2, parentId: 1, name: 'RulesClose', ui: { width: 5.4, height: 5.4, maxWidth: 3.5, maxHeight: 3.5 } },
    ];
    const world = makeWorld(specs);

    markUIDirty();
    uiTreeProjection(world);

    // The architectural property this test rests on: entity 2's node is actually PRESENT
    // in the built tree, nested under its hidden (isVisible:false) parent — not skipped
    // the way `deactivatedEntities` are. Without this, the test above would pass
    // identically even if buildTree started skipping isVisible:false subtrees (it would
    // just also stop finding RulesClose to warn about) — this assertion is the one that
    // tells those two failure modes apart.
    const { useUITreeStore } = await import('../../src/runtime/ui/uiTreeStore');
    const tree = useUITreeStore.getState().tree;
    const dialogRoot = tree.find(n => n.entityId === 1);
    expect(dialogRoot).toBeDefined();
    expect(dialogRoot!.isVisible).toBe(false);
    expect(dialogRoot!.children.some(c => c.entityId === 2)).toBe(true);

    const messages = warnSpy.mock.calls.map(c => String(c[0]));
    const hit = messages.filter(m => m.includes('RulesClose'));
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.some(m => m.includes('maxWidth'))).toBe(true);
    expect(hit.some(m => m.includes('maxHeight'))).toBe(true);
  });

  it('does not warn for a non-suspect field shaped like Court RulesPanel (maxWidth above threshold)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { uiTreeProjection, markUIDirty } = await load();

    const specs: Spec[] = [
      { id: 1, parentId: 0, name: 'HowToPlayDialog', ui: { isVisible: false } },
      { id: 2, parentId: 1, name: 'RulesPanel', ui: { width: 84, maxWidth: 460 } },
    ];
    const world = makeWorld(specs);

    markUIDirty();
    uiTreeProjection(world);

    const messages = warnSpy.mock.calls.map(c => String(c[0]));
    expect(messages.some(m => m.includes('RulesPanel'))).toBe(false);
  });
});
