/** Editor SceneView 2D renderer (SceneView-Pixi migration, Phase 1).
 *
 *  A SECOND {@link Scene2DRenderer} on its OWN {@link Canvas2DPool}, so the authoring viewport
 *  renders 2D through the SAME PixiJS path as the runtime GameView instead of the legacy
 *  immediate-mode DOM Canvas2D (`Canvas2DLayer`). This kills the dual-renderer "twin" tax, the
 *  KTX2/Canvas2D texture seam, and the Pixi-plugin ceiling — see the 2D rendering section of docs/rendering.md.
 *
 *  `primary: false` → this renderer NEVER registers the layout-bounds provider or the prewarm hook,
 *  and never nukes the SHARED skin buffers / Assets texture net on its own stop (only the last live
 *  renderer does). Its frame key derives to `EDITOR_SCENE2D_FRAME_KEY` ('render2d:editor') so it can't
 *  collide with the runtime's 'render2d' callback. It renders the same world as GameView through a
 *  separate pool (a Pixi display object + a <canvas> can each live in only one place). */

import { Canvas2DPool } from '../../runtime/rendering/canvas2DPool';
import { Scene2DRenderer } from '../../runtime/rendering/Scene2D';
import { useEditorStore } from '../store/editorStore';

/** The editor viewport's own Pixi Canvas2D pool (distinct slots from the runtime `defaultPool`). */
export const editorCanvas2DPool = new Canvas2DPool();

// 2D particle preview clock (Phase 4). The editor `Time` trait isn't advancing, so while the FX button
// (particlePreview) is ON we feed the 2D emitter sim a wall-clock delta; OFF returns undefined, telling
// renderFrame to dispose the preview emitters. This mirrors the SceneView 3D preview (which drives
// syncParticles with its own performance.now() delta) so the SINGLE FX toggle previews BOTH 2D + 3D.
// Editor-only module (not runtime/**), so the wall-clock read is outside the determinism guard.
let lastPreview2DT = 0;
function editorParticlePreviewDt(): number | undefined {
  if (!useEditorStore.getState().particlePreview) { lastPreview2DT = 0; return undefined; }
  const now = performance.now();
  const dt = lastPreview2DT ? Math.min((now - lastPreview2DT) / 1000, 0.05) : 0;
  lastPreview2DT = now;
  return dt;
}

/** The editor viewport's 2D renderer (non-primary, editor frame key/priority derived from `primary`). */
export const editorScene2DRenderer = new Scene2DRenderer({ pool: editorCanvas2DPool, primary: false, particleDt: editorParticlePreviewDt });

/** Wake the editor renderer's dirty gate (passed to Canvas2DMount so a resize dirties THIS surface). */
export const editorMarkScene2DDirty = () => editorScene2DRenderer.markDirty();
