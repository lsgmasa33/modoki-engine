/** #1576 — does a press at (x, y) reach `own` canvas, or does ANOTHER canvas on top take it?
 *
 *  `pickAt` asks a surface's providers in priority order and takes the first non-null answer, so a
 *  provider's `null` reads as "not my point, ask the next one". An overlay that ABSORBS a press and
 *  selects nothing answers `null` too — the SceneView's Canvas2D pick overlay does exactly that on
 *  a 2D miss: it deselects, and the press never reaches the Three.js canvas beneath it. The 3D
 *  viewport's provider, asked next, then named the mesh under the point, and `modoki_tap` reported
 *  ok for an entity no click can reach (measured: `2D Animation.scene`, whose full-screen Canvas2D
 *  host covers the whole 'ui' preview — the tap said "cube", the click selected nothing).
 *
 *  So the 3D viewport's pick function asks this FIRST, inside the one function both its pointer
 *  handler and its provider registration call (`pickProviderSharedPath.test.ts` forbids a wrapper).
 *  For a real press it is always true — that handler runs only for a press the canvas received —
 *  so it changes the PREDICTION only. Positive identification of the canvas that gets the press
 *  covers any overlay, including ones that do not exist yet, rather than teaching each to say
 *  "absorbed".
 *
 *  ⚠️ Only a FOREIGN CANVAS answers false. A non-canvas cover (a toolbar, a dialog, a HUD node) is
 *  `entityResolve`'s DOM check — reported as `occluded` with the cover named, a flag the aim
 *  contract documents — and withholding the pick for it would turn that flag into a refusal that
 *  says "selects nothing", which is wrong about what covers it. A canvas on top is another
 *  rendering surface with its own press handler: that is the case the DOM check cannot see,
 *  because to it "anything inside a canvas counts as reaching one".
 *
 *  `elementAt` is injectable — jsdom has no layout, so a test supplies the stack. */
export function pressReachesCanvas(
  own: Element,
  x: number,
  y: number,
  elementAt: (x: number, y: number) => Element | null = (px, py) => document.elementFromPoint(px, py),
): boolean {
  // A canvas's children are never rendered, so the hit-test answers with the canvas itself.
  const top = elementAt(x, y);
  return !top || top.tagName !== 'CANVAS' || top === own;
}
