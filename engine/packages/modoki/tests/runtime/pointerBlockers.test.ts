import { describe, it, expect, afterEach } from 'vitest';
import {
  registerPointerBlocker,
  registerPointerPassthrough,
  isPointerBlocked,
  clearPointerBlockers,
} from '../../src/runtime/core/pointerBlockers';

/** Minimal stand-in for a DOM node — only `contains()` matters to this module. */
class FakeNode {
  private children = new Set<FakeNode>();
  add(child: FakeNode): void { this.children.add(child); }
  contains(other: unknown): boolean {
    if (other === this) return true;
    for (const c of this.children) if (c.contains(other)) return true;
    return false;
  }
}

afterEach(() => { clearPointerBlockers(); });

describe('pointerBlockers', () => {
  it('reports unblocked when nothing is registered', () => {
    const target = new FakeNode();
    expect(isPointerBlocked(target)).toBe(false);
  });

  it('blocks the registered root itself', () => {
    const root = new FakeNode();
    registerPointerBlocker(root);
    expect(isPointerBlocked(root)).toBe(true);
  });

  it('blocks through nested children (containment)', () => {
    const root = new FakeNode();
    const child = new FakeNode();
    const grandchild = new FakeNode();
    child.add(grandchild);
    root.add(child);
    registerPointerBlocker(root);
    expect(isPointerBlocked(grandchild)).toBe(true);
  });

  it('does not block an unrelated node', () => {
    const root = new FakeNode();
    const other = new FakeNode();
    registerPointerBlocker(root);
    expect(isPointerBlocked(other)).toBe(false);
  });

  it('unregisters via the returned disposer', () => {
    const root = new FakeNode();
    const dispose = registerPointerBlocker(root);
    expect(isPointerBlocked(root)).toBe(true);
    dispose();
    expect(isPointerBlocked(root)).toBe(false);
  });

  it('registering the same root twice is refcounted — needs BOTH disposers before it unblocks', () => {
    const root = new FakeNode();
    const disposeA = registerPointerBlocker(root);
    const disposeB = registerPointerBlocker(root);
    disposeA();
    expect(isPointerBlocked(root)).toBe(true); // still blocked — disposeB hasn't run
    disposeB();
    expect(isPointerBlocked(root)).toBe(false);
  });

  it('a disposer is idempotent — calling it twice does not over-decrement someone else\'s registration', () => {
    const root = new FakeNode();
    const disposeA = registerPointerBlocker(root);
    registerPointerBlocker(root); // second, independent registration — never disposed here
    disposeA();
    disposeA(); // repeat call must be a no-op, not a second decrement
    expect(isPointerBlocked(root)).toBe(true); // the other registration must still hold
  });

  it('a stale disposer after clearPointerBlockers is a harmless no-op', () => {
    const root = new FakeNode();
    const dispose = registerPointerBlocker(root);
    clearPointerBlockers();
    expect(() => dispose()).not.toThrow();
    expect(isPointerBlocked(root)).toBe(false);
  });

  it('treats null/undefined targets as unblocked', () => {
    const root = new FakeNode();
    registerPointerBlocker(root);
    expect(isPointerBlocked(null)).toBe(false);
    expect(isPointerBlocked(undefined)).toBe(false);
  });
});

/** ── Passthrough surfaces ──
 *
 *  The regression these exist for: `UIRenderer` registers its whole UI root, and the standard 2D
 *  scene shape puts `Canvas2D` on a `UIElement`, so the game's own `<canvas>` is a DESCENDANT of
 *  that root. Containment alone therefore classified every press on the game's own surface as a
 *  press on chrome, and ALL pointer input to every 2D game died (19 scenes, 10 projects). The block
 *  direction worked; nothing asserted the pass direction. */
describe('pointerBlockers — passthrough surfaces', () => {
  /** The real shape: UI root (blocker) > entity node > canvas (passthrough), plus a UI button
   *  sibling of the canvas that must STILL be blocked. */
  function gameLayer() {
    const uiRoot = new FakeNode();
    const entityNode = new FakeNode();
    const canvas = new FakeNode();
    const uiButton = new FakeNode();
    entityNode.add(canvas);
    uiRoot.add(entityNode);
    uiRoot.add(uiButton);
    return { uiRoot, entityNode, canvas, uiButton };
  }

  it('lets a press on the game canvas through, even though it sits inside the UI block root', () => {
    const { uiRoot, canvas } = gameLayer();
    registerPointerBlocker(uiRoot);
    expect(isPointerBlocked(canvas), 'blocked before registering the surface').toBe(true);
    registerPointerPassthrough(canvas);
    expect(isPointerBlocked(canvas)).toBe(false);
  });

  it('STILL blocks a UI element over that canvas — the requirement passthrough must not break', () => {
    // The owner's rule, and the reason passthrough is registered on the canvas ELEMENT: "if UI
    // picks the click, the pointer event should not go to the canvas/2D Pixi layer or 3D."
    const { uiRoot, canvas, uiButton } = gameLayer();
    registerPointerBlocker(uiRoot);
    registerPointerPassthrough(canvas);
    expect(isPointerBlocked(uiButton)).toBe(true);
  });

  it('passthrough is LEAF-ONLY in practice: registering a WRAPPER would leak UI presses', () => {
    // Not a behaviour we want, but the failure mode a future caller must not walk into — hence the
    // API doc's "register the <canvas> element itself, never a wrapper". Registering the entity
    // node (an ancestor of the canvas) unblocks anything inside it. A real `<canvas>` can have no
    // rendered element descendants, which is exactly what makes the correct registration safe.
    const { uiRoot, entityNode } = gameLayer();
    const uiInsideWrapper = new FakeNode();
    entityNode.add(uiInsideWrapper);
    registerPointerBlocker(uiRoot);
    registerPointerPassthrough(entityNode);
    expect(isPointerBlocked(uiInsideWrapper), 'a wrapper registration leaks — do not do this').toBe(false);
  });

  it('a blocker NESTED INSIDE a passthrough surface still wins — nearest ancestor decides', () => {
    const surface = new FakeNode();
    const chrome = new FakeNode();
    const chromeChild = new FakeNode();
    chrome.add(chromeChild);
    surface.add(chrome);
    registerPointerPassthrough(surface);
    registerPointerBlocker(chrome);
    expect(isPointerBlocked(chromeChild)).toBe(true);
    expect(isPointerBlocked(surface), 'the surface itself is not inside the chrome').toBe(false);
  });

  it('is a no-op where no blocker applies — passthrough only ever subtracts', () => {
    const surface = new FakeNode();
    registerPointerPassthrough(surface);
    expect(isPointerBlocked(surface)).toBe(false);
  });

  it('is refcounted, and its disposer is idempotent', () => {
    const { uiRoot, canvas } = gameLayer();
    registerPointerBlocker(uiRoot);
    const disposeA = registerPointerPassthrough(canvas);
    registerPointerPassthrough(canvas);
    disposeA();
    disposeA(); // must not over-decrement the second registration
    expect(isPointerBlocked(canvas), 'one registration still holds').toBe(false);
  });

  it('re-blocks the surface once every passthrough registration is disposed', () => {
    const { uiRoot, canvas } = gameLayer();
    registerPointerBlocker(uiRoot);
    const dispose = registerPointerPassthrough(canvas);
    expect(isPointerBlocked(canvas)).toBe(false);
    dispose();
    expect(isPointerBlocked(canvas), 'a destroyed canvas must not keep a stale exemption').toBe(true);
  });

  it('clearPointerBlockers drops passthrough registrations too', () => {
    const { uiRoot, canvas } = gameLayer();
    registerPointerBlocker(uiRoot);
    registerPointerPassthrough(canvas);
    clearPointerBlockers();
    expect(isPointerBlocked(canvas)).toBe(false); // nothing registered at all now
    registerPointerBlocker(uiRoot);
    expect(isPointerBlocked(canvas), 'the exemption did not survive the clear').toBe(true);
  });
});
