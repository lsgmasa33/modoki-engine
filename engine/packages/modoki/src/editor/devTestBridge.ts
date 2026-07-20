/** Dev-only `window` bridge that lets external E2E tests (Playwright) observe
 *  editor state — selection and trait values — which is otherwise locked inside
 *  ES-module closures. Installed only under `import.meta.env.DEV` by createEditor,
 *  so it never ships in a production build. */

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
  };
  (window as unknown as { __modokiEditorTest?: EditorTestBridge }).__modokiEditorTest = bridge;
}
