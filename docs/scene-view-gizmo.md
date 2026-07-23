# SceneView Orientation Gizmo + Ortho Editor Camera

The Unity-style Scene Gizmo in the SceneView's top-right corner — a rotating axis tripod whose
6 axis cones snap the editor orbit camera to top/bottom/left/right/front/back (animated), plus
an orthographic editor-camera mode toggled independently of snapping.

> Graduated from `docs/plans/scene-view-gizmo-plan.md` (both phases landed + live-verified;
> Phase 1 = `eadb5800`, Phase 2 = ortho camera + persp/ortho toggle). Kept as a design
> reference because `SceneView.tsx` cites it by path — and because the spiked ortho risk
> analysis + touch-list below is what future ortho work reuses.

## What it is

- **Projection is an independent toggle (Unity model):** clicking an axis cone snaps the view
  *direction* but keeps the current projection; a separate center element toggles Persp↔Ortho.
- **Axis snap is an animated tween** (~250ms ease), not an instant jump.
- The center toggle sits **on top of** a viewer-facing axis cone so it stays clickable in
  axis-aligned views (the center-hub occlusion fix).

Live-verified: ortho toggle (parallel grid, extent-matched), snap-in-ortho, picking under ortho,
persp↔ortho round-trip, and the center-hub occlusion fix.

## Key files

- `editor/panels/SceneView.tsx` — the editor orbit camera + `OrbitControls`, the idle-gated
  `animate()` loop, the view-snap tween, and (Phase 2) the `OrthographicCamera` sibling.
- `editor/panels/SceneViewGizmo.tsx` — the DOM/SVG corner widget (3D-mode only); a local rAF
  re-projects the 3 axis basis vectors to 6 cone endpoints and dispatches snap/projection commands.
- `editor/scene/sceneViewBus.ts` — the viewport-controller command channel
  (`setViewportController` / `snapEditorViewToAxis`), mirroring the focus-entity pattern.
- `editor/scene/sceneViewMath.ts` — pure snap/slerp math (`axisSnapCameraPosition`,
  constant-distance offset slerp), unit-tested in `sceneViewGizmoMath.test.ts`.

## How it works

**Snap tween.** The controller captures the start offset (`camera.position − controls.target`)
and its distance, computes the end offset (`dir * distance`), and advances a `stepViewTween()`
closure by wall-clock elapsed (editor-only — not under the determinism allowlist). Each step sets
`camera.position`, keeps `controls.target`, and calls `controls.update()`.

**The idle gate is the one non-obvious coupling.** The viewport draws only when
`gate.shouldDraw(live, controlsMoving)` is truthy (`viewportDirtyGate.ts` draws when `live ||
controlsMoving || dirtyFrames>0`). The tween keeps the gate open by OR-ing its `stepViewTween()`
bool into the `controlsMoving` arg — **without short-circuiting**:
`const a = controls.update(); const b = stepViewTween(); … a || b`, so the tween step always runs.
(Backstop: setting `camera.position` + `controls.update()` fires `'change'` → `markViewportDirty`,
re-arming grace anyway.)

## Gotchas — the ortho spike (2026-07-23, all cleared)

Phase 2 was invasive because the active camera is threaded through OrbitControls,
TransformControls, every raycast, and `setEditorViewportCamera` — all originally assuming
`PerspectiveCamera`. The spike (against three 0.184) found **no math forking is needed**:

- **`pick3D` / raycasting** — already takes a generic `THREE.Camera` and calls
  `raycaster.setFromCamera`; Three branches on `isOrthographicCamera` internally. Zero change.
- **OrbitControls** — reads `this.object` live every `update()` and has an explicit ortho branch
  (dolly → `camera.zoom`). Swapping `controls.object = orthoCam` at runtime is supported.
- **TransformControls** — uses `setFromCamera` + an `isOrthographicCamera` eye branch; `.camera`
  is settable and was **already swapped** for the UI-mode game cam — proven precedent.
- **`.project(camera)`** is projectionMatrix-based → ortho-safe. The Inspector "Copy from Editor
  Camera" reads `position`/`rotation` only (not `.fov`) → ortho-safe.

**The one genuinely new bit of math:** ortho zoom is `camera.zoom`-based, not distance-based, so
**frustum-match-on-toggle** must size `orthoCam.zoom`/frustum from the perspective pivot distance
so the view doesn't jump. On window resize the ortho frustum aspect must be kept in sync
(perspective only updates `.aspect`).

**Phase-2 touch points** (the active editor camera must be pointed into all of these): the
`OrbitControls` object, the active/gizmo camera selectors, `setEditorViewportCamera`, the
game-cam `fov` copy (guard when ortho), the resize handler (add ortho frustum recompute alongside
`camera.aspect`), and the bus camera type (widen `PerspectiveCamera` → `Perspective|Orthographic`).

**HMR** — `SceneView.tsx` is engine code (Fast Refresh); the mount-effect closures re-run cleanly,
and a bus command registered from a `[]`-dep effect is fine (registered on mount). Keep the
widget's rAF cheap — redraw only when the camera quaternion changes.

## Related

- [editor.md](./editor.md) — the SceneView panel and the rest of the editor's viewports.
- [rendering.md](./rendering.md) — the runtime game-Camera ortho path (`applyOrthoFrustum`), a
  separate previewer of the game Camera trait whose frustum-sizing math this borrows the shape of.
