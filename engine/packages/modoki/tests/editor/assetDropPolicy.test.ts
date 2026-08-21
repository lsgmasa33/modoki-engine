// @vitest-environment jsdom
/**
 * #306 — a non-prefab asset dropped on the Hierarchy used to be DOM-accepted (copy cursor,
 * row highlight) and then silently discarded by `handlePrefabDrop`'s `type !== 'prefab'`
 * bail. The fix is a visible refusal, and it has two halves that must BOTH hold:
 *
 *   1. the decision — `decideHierarchyAssetDrop` says accept:false, so the dragover handler
 *      returns without preventDefault (no-drop cursor, no highlight, `drop` never fires,
 *      `modoki_dnd` reports accepted:false);
 *   2. the explanation — `setDragGhostRefusal` repaints the ghost already following the
 *      cursor with the reason.
 *
 * A test that only checked half 1 would pass on a silent refusal, which is a different bug
 * (the user is told "not here" and nothing else), so both are asserted here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  decideHierarchyAssetDrop,
  decideSkinPartAssetDrop,
  HIERARCHY_ASSET_REFUSAL,
  SKIN_PART_ASSET_REFUSAL,
} from '../../src/editor/panels/assetDropPolicy';
import {
  startDragGhost,
  endDragGhost,
  setDragGhostRefusal,
  setAssetDragPayload,
  getAssetDragInfo,
  completeAssetDrop,
} from '../../src/editor/utils/dragGhost';

const fakeDragEvent = () => ({ dataTransfer: { setDragImage: () => {} } }) as unknown as React.DragEvent;
const ghost = () => document.getElementById('editor-drag-ghost');
const ghostText = () => ghost()?.querySelector('[data-ghost-label]')?.textContent ?? null;
const ghostIcon = () => ghost()?.querySelector('[data-ghost-icon]')?.textContent ?? null;

beforeEach(() => {
  document.body.innerHTML = '';
  delete (window as any).__editorDragCleanup;
  completeAssetDrop();
});
afterEach(() => { endDragGhost(); completeAssetDrop(); });

const info = (type: string | null, path = '/x.json') => ({ type, path });

describe('decideHierarchyAssetDrop', () => {
  it('accepts a prefab', () => {
    expect(decideHierarchyAssetDrop(true, info('prefab', '/p.prefab.json'))).toEqual({ accept: true, refusal: null });
  });

  it('refuses every other asset kind, with a reason', () => {
    // The kinds the Assets panel can actually produce — each is a REF (mesh/material/
    // texture/clip), not a thing with an entity shape, so there is nothing to instantiate.
    for (const type of ['sprite', 'texture', 'model', 'mesh', 'material', 'audio', 'particle', 'anim', 'timeline', 'scene', 'font']) {
      const d = decideHierarchyAssetDrop(true, info(type));
      expect(d.accept, `${type} must be refused`).toBe(false);
      expect(d.refusal, `${type} must explain itself`).toBe(HIERARCHY_ASSET_REFUSAL);
    }
  });

  it('refuses a PNG — the Hierarchy keys off type, never the extension', () => {
    // Guards against the Skin rule below being copy-pasted here: an image is droppable on a
    // Skin part and is NOT droppable on the Hierarchy, so the two predicates must stay apart.
    expect(decideHierarchyAssetDrop(true, info('texture', '/art/tree.png')).accept).toBe(false);
  });

  it('refuses an asset drag whose payload is not from this document', () => {
    // getAssetDragInfo() returns null for a foreign/stale drag. Refusing is correct rather
    // than conservative: handlePrefabDrop parses the same JSON and would discard it anyway,
    // so accepting would reinstate exactly the accept-then-discard shape being fixed.
    expect(decideHierarchyAssetDrop(true, null)).toEqual({ accept: false, refusal: HIERARCHY_ASSET_REFUSAL });
  });

  it('leaves non-asset drags (entity reparent, folder move) alone', () => {
    expect(decideHierarchyAssetDrop(false, null)).toEqual({ accept: true, refusal: null });
    // An entity drag can coexist with a stale asset payload; the isAssetDrag flag decides.
    expect(decideHierarchyAssetDrop(false, info('sprite'))).toEqual({ accept: true, refusal: null });
  });

  it('names what WOULD work, not just that it failed', () => {
    // A refusal reading only "cannot drop here" leaves the user unsure whether they missed
    // the target or picked the wrong file. Pinning the mention of prefabs keeps that.
    expect(HIERARCHY_ASSET_REFUSAL).toMatch(/prefab/i);
  });
});

describe('decideSkinPartAssetDrop', () => {
  // Same accept-then-discard shape, second site: the Skin editor's parts list accepted every
  // asset on dragover (copy cursor + blue outline) and its drop resolved only images.
  it('accepts a sprite or a texture — a dropped texture is resolved to its whole-image sprite', () => {
    expect(decideSkinPartAssetDrop(true, info('sprite', '/art/arm.png')).accept).toBe(true);
    expect(decideSkinPartAssetDrop(true, info('texture', '/art/sheet.png')).accept).toBe(true);
  });

  it('accepts an image whose manifest type is missing or unexpected, by extension', () => {
    // The extension arm is the rule the drop handler has always applied; lifted verbatim so
    // the affordance and the action cannot disagree.
    for (const path of ['/a.png', '/a.PNG', '/a.jpg', '/a.jpeg', '/a.webp']) {
      expect(decideSkinPartAssetDrop(true, info(null, path)).accept, path).toBe(true);
    }
  });

  it('refuses a non-image, with a reason', () => {
    for (const [type, path] of [['prefab', '/p.prefab.json'], ['mesh', '/m.mesh.json'], ['audio', '/s.mp3'], ['anim', '/a.anim.json']] as const) {
      const d = decideSkinPartAssetDrop(true, info(type, path));
      expect(d.accept, `${type} must be refused`).toBe(false);
      expect(d.refusal).toBe(SKIN_PART_ASSET_REFUSAL);
    }
    // A .webpage/.pngx style near-miss must not squeak through the extension regex.
    expect(decideSkinPartAssetDrop(true, info(null, '/a.png.bak')).accept).toBe(false);
    expect(decideSkinPartAssetDrop(true, info(null, '/a.webpx')).accept).toBe(false);
  });

  it('refuses a foreign payload and leaves non-asset drags (part reorder) alone', () => {
    expect(decideSkinPartAssetDrop(true, null).accept).toBe(false);
    expect(decideSkinPartAssetDrop(false, null)).toEqual({ accept: true, refusal: null });
  });

  it('names what WOULD work', () => {
    expect(SKIN_PART_ASSET_REFUSAL).toMatch(/sprite|texture/i);
  });
});

describe('getAssetDragInfo (readable during dragover, unlike dataTransfer.getData)', () => {
  it('reads type + path out of the payload the Assets panel stored at dragstart', () => {
    setAssetDragPayload(JSON.stringify({ type: 'prefab', path: '/p.prefab.json', name: 'p' }));
    expect(getAssetDragInfo()).toEqual({ type: 'prefab', path: '/p.prefab.json' });
  });

  it('is null with no drag in flight, and again once the drag completes', () => {
    expect(getAssetDragInfo()).toBeNull();
    setAssetDragPayload(JSON.stringify({ type: 'sprite', path: '/x.png', name: 'x' }));
    expect(getAssetDragInfo()).not.toBeNull();
    completeAssetDrop();
    expect(getAssetDragInfo()).toBeNull();
  });

  it('reports a MISSING type as null rather than dropping the path with it', () => {
    // The Skin rule can still accept such a payload by extension, so the path must survive.
    setAssetDragPayload(JSON.stringify({ path: '/x.png' }));
    expect(getAssetDragInfo()).toEqual({ type: null, path: '/x.png' });
  });

  it('is null for a malformed or path-less payload rather than throwing', () => {
    setAssetDragPayload('not json');
    expect(getAssetDragInfo()).toBeNull();
    setAssetDragPayload(JSON.stringify({ type: 'prefab' }));
    expect(getAssetDragInfo()).toBeNull();
  });
});

describe('setDragGhostRefusal (the explanation half)', () => {
  it('repaints the ghost with the reason, then restores it', () => {
    startDragGhost(fakeDragEvent(), 'tree.png');
    const okBg = ghost()!.style.background;
    expect(ghostText()).toBe('tree.png');

    setDragGhostRefusal(HIERARCHY_ASSET_REFUSAL);
    expect(ghostText()).toContain('tree.png');
    expect(ghostText()).toContain(HIERARCHY_ASSET_REFUSAL);
    expect(ghostIcon()).toBe('\u{1F6AB}');
    expect(ghost()!.style.background).not.toBe(okBg);

    // Dragging back off the Hierarchy onto a target that DOES accept must undo it —
    // a stuck refusal would mislabel a perfectly good drop.
    setDragGhostRefusal(null);
    expect(ghostText()).toBe('tree.png');
    expect(ghostIcon()).toBe('✊');
    expect(ghost()!.style.background).toBe(okBg);
  });

  it('does not leak a refusal into the NEXT drag', () => {
    startDragGhost(fakeDragEvent(), 'tree.png');
    setDragGhostRefusal(HIERARCHY_ASSET_REFUSAL);
    endDragGhost();

    startDragGhost(fakeDragEvent(), 'house.prefab.json');
    expect(ghostText()).toBe('house.prefab.json');
    expect(ghostIcon()).toBe('✊');
  });

  it('is inert with no ghost mounted', () => {
    expect(() => setDragGhostRefusal('nope')).not.toThrow();
    expect(ghost()).toBeNull();
  });

  it('renders a name containing markup as text, not HTML', () => {
    // The label is a user-authored asset/entity name and reaches the ghost verbatim.
    startDragGhost(fakeDragEvent(), '<img src=x onerror=1>');
    expect(ghost()!.querySelector('img')).toBeNull();
    expect(ghostText()).toBe('<img src=x onerror=1>');
  });
});
