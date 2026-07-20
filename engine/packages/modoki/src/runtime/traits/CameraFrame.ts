import { trait } from 'koota';

/** CameraFrame — an oriented "framing box" that the active camera fits to the
 *  viewport, so the play area stays framed across screen resolutions/aspects.
 *
 *  Authored ON a box entity: the entity's Transform IS the box — position =
 *  center, scale = size, rotation (Y-yaw) orients it. The camera is moved to fit
 *  this box for the chosen `mode` + margins (perspective dollies; orthographic
 *  sets orthoSize). A scene may hold SEVERAL CameraFrame boxes; exactly one is
 *  `active` (switchable at runtime, optionally with a blend — see blendTime).
 *
 *  When a CameraFrame drives the camera it OWNS the fit — the camera's authored
 *  position (perspective) / orthoSize (ortho) along the framing axis stops
 *  mattering; only its orientation (and the box) do. */
export const CameraFrame = trait({
  /** Is this the active frame? Exactly one active per scene; the camera fits it. */
  active: true,
  /** How to resolve an aspect mismatch:
   *   'contain'   — whole box always visible (letterbox slack on the looser axis)
   *   'fitWidth'  — box width fills the screen (may crop top/bottom)
   *   'fitHeight' — box height fills the screen (may crop sides) */
  mode: 'contain',
  /** Per-edge viewport-fraction padding. Asymmetric margins (e.g. a bigger `top`
   *  to reserve HUD/notch space) shift the framed content when autoAim is on. */
  marginTop: 0.06,
  marginBottom: 0.06,
  marginLeft: 0.06,
  marginRight: 0.06,
  /** true → camera owns lateral position and recenters the box into the margined
   *  rect. false → keep the authored lateral aim; dolly for size only. */
  autoAim: false,
  /** Vertical edge anchor — pins a chosen edge of the framed box to an exact screen
   *  line, OVERRIDING the mode/margin vertical centering (autoAim just centers).
   *   'off'    — no anchor (margins/autoAim own the vertical position)
   *   'bottom' — the box's bottom (nearest-the-camera) edge lands at `anchorPosV`
   *   'center' — the box's vertical center lands at `anchorPosV`
   *   'top'    — the box's top (farthest) edge lands at `anchorPosV`
   *  Use with `fitWidth`/`contain` to get "biggest width AND the near edge exactly at
   *  N% up the screen" (e.g. reserve a fixed bottom UI band): fitWidth + bottom + 0.2. */
  anchorV: 'off' as 'off' | 'bottom' | 'center' | 'top',
  /** Viewport fraction (0 = screen bottom, 1 = top) where the anchored edge lands.
   *  Only used when `anchorV` !== 'off'. */
  anchorPosV: 0.5,
  /** Horizontal edge anchor — the left/right twin of `anchorV` (overrides the
   *  mode/margin horizontal centering). 'left'/'right' pin that edge; 'center' the
   *  box's horizontal center. Use to reserve a fixed side band (e.g. a landscape HUD). */
  anchorH: 'off' as 'off' | 'left' | 'center' | 'right',
  /** Viewport fraction (0 = screen left, 1 = right) where the anchored edge lands.
   *  Only used when `anchorH` !== 'off'. */
  anchorPosH: 0.5,
  /** true → refit every frame (follows a moving/growing box or animated camera).
   *  false → refit only on load + viewport resize (cheapest; static field). */
  continuous: false,
  // NOTE: the "show framing-box gizmo" toggle is EDITOR-ONLY display state, not a serialized
  // trait field — it lives in editorStore.cameraGizmoShown (localStorage, per guid) so it
  // survives reloads without a Cmd+S and never ships. (Old scenes' `showGizmo` is stripped on
  // load by loadSceneFile.) The SceneView reads that store to gate the box.
  /** Seconds to blend INTO this frame when it becomes active at runtime (0 =
   *  instant cut). Timing lives on the TARGET frame (Cinemachine-style ease-in). */
  blendTime: 0,
  /** Easing for the blend into this frame. */
  blendEase: 'quadInOut',
});
