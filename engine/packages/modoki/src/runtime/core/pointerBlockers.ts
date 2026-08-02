/** Pointer-block-root registry — lets a DOM overlay (engine `UIRenderer`, the in-game
 *  debug menu, a game's hand-built DOM chrome) claim exclusive ownership of pointer
 *  gestures that start on it, so the engine's `pointerSource` (`runtime/input/`)
 *  never latches them as a game gesture. Lives in `core/` (L0) rather than `input/`
 *  or `ui/` (both L2) because both need to reach it and there is no `ui → input`
 *  zone edge (`eslint.config.js`'s `L2_ALLOWED`) — same reason `uiDirty.ts` exists
 *  here instead of in `ui/`.
 *
 *  Deliberately NOT keyed by `pointerId`: `pointerSource.ts` tracks exactly one
 *  active pointer (the primary-touch rule), so there is nothing to key per-id. A
 *  registered root is consulted once, at the pointerdown/wheel that would otherwise
 *  start a gesture — no per-pointer claim state, so a claim can never leak (the
 *  todo this API replaces called a leaked claim "the worst failure mode in this
 *  list"; this design makes it unrepresentable instead of testing against it).
 *
 *  Structurally typed against `contains()` rather than `Element`, so this file
 *  stays DOM-free like the rest of `core/` (no `lib.dom` dependency, headless-safe,
 *  determinism-guard clean — no clock, no RNG). */

/** The minimal DOM surface this module needs — satisfied by any `Node`/`Element`. */
interface ContainerLike {
  contains(other: unknown): boolean;
}

/** ── PASSTHROUGH SURFACES, and why a block ROOT alone is not enough ──
 *
 *  A block root is registered per DOM subtree, and `UIRenderer` registers its whole UI root. But
 *  that root is not "chrome" — it is a LAYER holding chrome AND, for every 2D game in this repo,
 *  the game's own render surface: the standard scene shape puts `Canvas2D` on a `UIElement`, so the
 *  `<canvas>` is a DESCENDANT of the UI root. Judging by containment alone therefore classified
 *  every press on the game's own canvas as a press on chrome, and `onPointerDown` returned before
 *  latching — killing ALL pointer input to the game (measured: 19 scenes across 10 projects,
 *  including both published demos). The block direction worked; the pass direction was dead.
 *
 *  So a surface can be registered as PASSTHROUGH: it is the game, never chrome, even nested inside
 *  a block root. Resolution is NEAREST-ANCESTOR — the registration closer to the event target wins
 *  — so chrome nested inside a passthrough surface still blocks.
 *
 *  ⚠️ **Register the `<canvas>` ELEMENT, never a wrapper around it.** This is the whole safety
 *  argument for the owner's requirement that "if UI picks the click, the pointer event must not go
 *  to the canvas/Pixi/3D": a UI element can never be a DOM DESCENDANT of a `<canvas>` (canvas
 *  fallback content is not rendered or hit-tested), so a press on a UI button sitting over the
 *  canvas still has `target = button`, which is inside the block root and outside the passthrough
 *  surface — blocked, exactly as before. Register the canvas's PARENT instead and every UI element
 *  inside it starts leaking presses into the game, which is the original bug this system exists to
 *  prevent. `passthroughIsLeafOnly` in the tests pins this. */

// Refcounted, not a plain Set: two independent registrations of the SAME node (e.g. two
// callers sharing a ref, a future double-mount) must both need to dispose before the node
// stops blocking — a plain Set would let either disposer alone unblock it out from under
// the other registration. Every current call site (UIRenderer, DebugMenu, rulesDialog)
// registers 1:1 today, but the API contract shouldn't quietly break the moment one doesn't.
const blockers = new Map<ContainerLike, number>();

/** Register `root` as a pointer-block root: any pointerdown/wheel whose target is
 *  `root` or a descendant is swallowed by `pointerSource` before it can start or
 *  feed a game gesture. Returns a disposer — call it on unmount/close. Safe to register
 *  the same root more than once (refcounted): it only stops blocking once every matching
 *  disposer has been called, and each disposer is idempotent past its first call. */
export function registerPointerBlocker(root: ContainerLike): () => void {
  blockers.set(root, (blockers.get(root) ?? 0) + 1);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const count = blockers.get(root) ?? 0;
    if (count <= 1) blockers.delete(root);
    else blockers.set(root, count - 1);
  };
}

/** Refcounted like `blockers`, and for the same reason. */
const passthrough = new Map<ContainerLike, number>();

/** Register `surface` as a pointer-PASSTHROUGH surface: a press on it belongs to the game even
 *  when it sits inside a registered block root. Returns a disposer, idempotent past its first call.
 *
 *  Pass the render surface ELEMENT ITSELF — see the PASSTHROUGH SURFACES note above. Registering an
 *  ancestor would let UI elements inside that ancestor leak presses into the game. */
export function registerPointerPassthrough(surface: ContainerLike): () => void {
  passthrough.set(surface, (passthrough.get(surface) ?? 0) + 1);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const count = passthrough.get(surface) ?? 0;
    if (count <= 1) passthrough.delete(surface);
    else passthrough.set(surface, count - 1);
  };
}

/** Every registered node of `set` that contains `target`. A real pointer/wheel event's `target` is
 *  always a Node (events only bubble THROUGH `window`, never target it) — but `contains()` throws
 *  on a non-Node argument per WebIDL, so a synthetic/injected event whose target happens to be
 *  `window` itself (or any other non-Node EventTarget) yields nothing rather than crashing the
 *  input source. */
function containing(set: Map<ContainerLike, number>, target: unknown): ContainerLike[] {
  const out: ContainerLike[] = [];
  for (const node of set.keys()) {
    try {
      if (node.contains(target)) out.push(node);
    } catch { /* target isn't a Node — can't be inside node */ }
  }
  return out;
}

/** True if `target` is inside a registered block root and NOT inside a nearer passthrough surface.
 *
 *  NEAREST-ANCESTOR WINS. With both kinds in play, the one closer to `target` decides. Nesting is
 *  read off the registrations themselves: a passthrough `p` is nearer than a blocker `b` exactly
 *  when `b` contains `p`. So:
 *   - press on the game canvas inside the UI root → passthrough is nearer → NOT blocked (the game
 *     gets its input, which is the bug this fixed);
 *   - press on a UI button over that canvas → target is the button, which no passthrough surface
 *     contains → BLOCKED (the requirement that UI never leaks into canvas/Pixi/3D);
 *   - chrome deliberately registered INSIDE a passthrough surface → the blocker is nearer → blocked. */
export function isPointerBlocked(target: unknown): boolean {
  if (target == null) return false;
  const blocking = containing(blockers, target);
  if (blocking.length === 0) return false;
  for (const surface of containing(passthrough, target)) {
    // This surface only wins if EVERY blocker that contains the target also contains the surface —
    // i.e. the surface is strictly nearer than all of them. A blocker nested inside the surface
    // (which `surface.contains(b)` would report, and `b.contains(surface)` would not) keeps the
    // press blocked.
    if (blocking.every((b) => b.contains(surface))) return false;
  }
  return true;
}

/** Test/teardown escape hatch — drop every registration without calling disposers. */
export function clearPointerBlockers(): void {
  blockers.clear();
  passthrough.clear();
}
