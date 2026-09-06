/** ParticleEditor's GPU-context-loss teardown, extracted to a plain `.ts` so it can be
 *  unit-tested without mounting the panel (`CLAUDE.md` § Editor Panels — `.tsx` carries no tests).
 *
 *  Before #795 wired context-loss detection into ParticleEditor's viewport, `teardown` ran ONLY on
 *  unmount, when no other effect in the panel could still be running. #795 made it reachable
 *  MID-MOUNT too (from the loss handler), but only disposed the renderer/handle — it never told
 *  the "apply def to the live preview" effect that the scene died. That effect gates on
 *  `sceneReady` + `sceneRef.current`, and neither was cleared, so the panel became a ZOMBIE: still
 *  mounted, `sceneReady` still true, `sceneRef.current` still pointing at the orphaned scene.
 *  Dragging any slider then re-created a particle handle via `particleBackend.create(def)` against
 *  whatever renderer now owns the global active-renderer slot (usually the SceneView's), parenting
 *  GPU buffers into a scene nothing draws — and closing the panel never disposed them, because
 *  `cleanupRef.current` had already been nulled (adversarial review of #795, finding 1). */

/** The two pieces of state the "apply def" effect gates on — kept as an interface (not the
 *  component's actual THREE.Scene type) so this module doesn't need to import `three`. */
export interface ParticlePreviewGate {
  sceneReady: boolean;
  scene: unknown | null;
}

/** True when the apply effect may create/update the live particle handle. Mirrors the effect's
 *  own guard (`if (!def || !sceneReady || !asset) return; ... if (!scene) return;`) so a test can
 *  pin the exact condition that finding 1 broke, without mounting the component. */
export function canApplyParticleDef(gate: ParticlePreviewGate, hasDef: boolean, hasAsset: boolean): boolean {
  return hasDef && hasAsset && gate.sceneReady && gate.scene !== null;
}

export interface ParticleLossLifecycle {
  setSceneReady: (ready: boolean) => void;
  clearScene: () => void;
}

/** Run from the loss `onLost` handler, IN ADDITION to the panel's own renderer/handle disposal —
 *  never as a replacement for it. Clears the state `canApplyParticleDef` reads, so a loss mid-mount
 *  leaves the apply effect permanently blocked instead of a zombie that reports success. */
export function handleParticleLossTeardown(lifecycle: ParticleLossLifecycle, disposeRenderer: () => void): void {
  lifecycle.setSceneReady(false);
  lifecycle.clearScene();
  disposeRenderer();
}
