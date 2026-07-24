/** Dev-only `window` bridge that lets external E2E tests (Playwright) observe
 *  editor state — selection and trait values — which is otherwise locked inside
 *  ES-module closures. Installed only under `import.meta.env.DEV` by createEditor,
 *  so it never ships in a production build. */

import * as THREE from 'three';
import { useEditorStore } from './store/editorStore';
import { getAllEntities, readTraitData, deleteEntity } from '../runtime/ecs/entityUtils';
import { getTraitByName } from '../runtime/ecs/traitRegistry';
import { importModel } from './scene/modelImport';
import { loadScene } from './scene/serialize';
import { isSkeletalPreviewing } from '../runtime/systems/skeletalPreview';
import { previewTimelineAt } from '../runtime/systems/timelineSystem';
import { getCurrentWorld } from '../runtime/ecs/world';
import { fireDirtyListeners } from '../runtime/ecs/entityUtils';
import { normalizeTimeline, type TimelineDef } from '../runtime/timeline/types';
import { getEditorViewportCamera, isEcsObjectVisible } from './scene/sceneViewBus';
import { worldTransforms } from '../three/systems/transformPropagationSystem';
import { editorScene2DRenderer } from './rendering/editorScene2D';

export interface EditorTestBridge {
  /** The raw Zustand store (read selectedEntityId, gizmoMode, etc.). */
  store: typeof useEditorStore;
  getAllEntities: typeof getAllEntities;
  /** Load a scene by path into the live editor world (returns true on success).
   *  E2E setup uses this instead of seeding the project-namespaced
   *  `modoki-last-scene:<project>` localStorage key, so fixture loading is
   *  independent of which project the dev server happens to open. */
  loadScene(scenePath: string): Promise<boolean>;
  /** Name of the currently selected entity, or null if none. */
  selectedEntityName(): string | null;
  /** Read a single trait field off an entity (for asserting edits landed). */
  traitField(entityId: number, traitName: string, field: string): unknown;
  /** Run the real editor model-import pipeline (extract textures/meshes/
   *  materials, spawn entities). Returns the spawned root entity id. Used by
   *  the model-pipeline E2E to drive a true import in a real browser. */
  importModel(glbPath: string, prefix?: string, postprocessorId?: string): Promise<number>;
  /** Delete an entity (E2E cleanup of imported entities). */
  deleteEntity(entityId: number): void;
  /** Whether the runtime "advance skeletal mixers while stopped" flag is set.
   *  The Animation-editor preview of a keyframe clip must NOT turn this on (it
   *  would animate every rig's baked clip out of Play mode and clobber the
   *  keyframe pose) — the E2E asserts it stays false during preview. */
  isSkeletalPreviewing(): boolean;
  /** Pose a Director's timeline at absolute time `t` while STOPPED — the same
   *  scrub-preview path the Timeline panel drives (previewTimelineAt + repaint).
   *  Lets an E2E verify skeletal seek-scrub (Phase 5) deterministically: scrub,
   *  then read back SkeletalAnimator.time / capture the pose. `def` is the raw
   *  timeline JSON (normalized here). */
  scrubTimeline(directorId: number, def: unknown, t: number): void;
  /** Project an entity's WORLD position through the live 3D SceneView camera into PAGE (client)
   *  coordinates — the same camera + canvas-rect math the real marquee/raycast use (see
   *  ThreeJSViewport's marquee `consider()`). Lets an E2E compute a click/drag target for an
   *  arbitrary entity instead of relying on a hardcoded camera/projection fact. Returns null
   *  when no 3D viewport is mounted, the entity has no world transform yet (not in the current
   *  scene, or hasn't propagated this frame), or it projects behind the camera. */
  screenPositionOf(entityId: number): { x: number; y: number } | null;
  /** Whether an entity's rendered 3D object is currently visible in the SceneView — `null`
   *  when no 3D viewport is mounted or the entity has no rendered object. Lets an E2E assert
   *  collider-only mode (the "Colliders" toolbar toggle) actually hides meshes, not just that
   *  the button's style changed. */
  isMeshVisible(entityId: number): boolean | null;
  /** Whether an entity has a live 2D display-object slot in the editor's SceneView (ui-mode)
   *  Pixi renderer — lets an E2E assert the 2D "Colliders" toggle actually hides sprites. */
  has2DSprite(entityId: number): boolean;
}

export function installEditorTestBridge(): void {
  const bridge: EditorTestBridge = {
    store: useEditorStore,
    getAllEntities,
    loadScene,
    selectedEntityName() {
      const id = useEditorStore.getState().selectedEntityId;
      if (id == null) return null;
      return getAllEntities().find((e) => e.id === id)?.name ?? null;
    },
    traitField(entityId, traitName, field) {
      const meta = getTraitByName(traitName);
      if (!meta) return undefined;
      const data = readTraitData(entityId, meta);
      return data ? data[field] : undefined;
    },
    importModel(glbPath, prefix = 'e2e', postprocessorId = 'none') {
      return importModel(glbPath, prefix, postprocessorId);
    },
    deleteEntity(entityId) {
      deleteEntity(entityId);
    },
    isSkeletalPreviewing() {
      return isSkeletalPreviewing();
    },
    scrubTimeline(directorId, def, t) {
      previewTimelineAt(getCurrentWorld(), directorId, normalizeTimeline(def as Partial<TimelineDef>), t);
      fireDirtyListeners();
    },
    screenPositionOf(entityId) {
      const cam = getEditorViewportCamera();
      const w = worldTransforms.get(entityId);
      const canvas = document.querySelector('[data-scene-viewport] canvas') as HTMLCanvasElement | null;
      if (!cam || !w || !canvas) return null;
      const v = new THREE.Vector3(w.x, w.y, w.z).project(cam);
      if (v.z > 1) return null; // behind the camera / beyond the far plane
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
        y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
      };
    },
    isMeshVisible(entityId) {
      return isEcsObjectVisible(entityId);
    },
    has2DSprite(entityId) {
      return editorScene2DRenderer.hasSprite(entityId);
    },
  };
  (window as unknown as { __modokiEditorTest?: EditorTestBridge }).__modokiEditorTest = bridge;
}
