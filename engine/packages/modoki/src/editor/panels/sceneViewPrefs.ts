/** Persistence for SceneView's "View ▾" toggles (Grid, Colliders, the 2D-mode Colliders-only
 *  switch, and the 3D/2D/UI layer-visibility buttons) — split out of SceneView.tsx so it's
 *  unit-testable without the giant panel around it (mirrors why `layoutStore.ts` and
 *  `layoutNames.ts` live outside EditorApp). These are editor-only display preferences, not
 *  scene/gameplay data, so they persist to `localStorage` under an `editor:`-prefixed key —
 *  same rationale as `editorStore.ts`'s CAM_GIZMO_LS_KEY and `showFocusGraph`. */

const KEY = 'editor:sceneViewOptions';

export interface SceneViewLayers {
  show3D: boolean;
  show2D: boolean;
  showUI: boolean;
}

export interface SceneViewPrefs {
  showGrid: boolean;
  showColliders: boolean;
  colliders2DOnly: boolean;
  layers: SceneViewLayers;
}

export const DEFAULT_SCENE_VIEW_PREFS: SceneViewPrefs = {
  showGrid: true,
  showColliders: false,
  colliders2DOnly: false,
  layers: { show3D: true, show2D: true, showUI: true },
};

/** Read the persisted prefs, filling in any missing/malformed field from the default so a
 *  partial or stale-shape blob (an older build persisted fewer fields) never crashes SceneView
 *  on mount. */
export function loadSceneViewPrefs(): SceneViewPrefs {
  if (typeof localStorage === 'undefined') return DEFAULT_SCENE_VIEW_PREFS;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SCENE_VIEW_PREFS;
    const parsed = JSON.parse(raw) as Partial<SceneViewPrefs>;
    return {
      showGrid: typeof parsed.showGrid === 'boolean' ? parsed.showGrid : DEFAULT_SCENE_VIEW_PREFS.showGrid,
      showColliders: typeof parsed.showColliders === 'boolean' ? parsed.showColliders : DEFAULT_SCENE_VIEW_PREFS.showColliders,
      colliders2DOnly: typeof parsed.colliders2DOnly === 'boolean' ? parsed.colliders2DOnly : DEFAULT_SCENE_VIEW_PREFS.colliders2DOnly,
      layers: {
        show3D: typeof parsed.layers?.show3D === 'boolean' ? parsed.layers.show3D : DEFAULT_SCENE_VIEW_PREFS.layers.show3D,
        show2D: typeof parsed.layers?.show2D === 'boolean' ? parsed.layers.show2D : DEFAULT_SCENE_VIEW_PREFS.layers.show2D,
        showUI: typeof parsed.layers?.showUI === 'boolean' ? parsed.layers.showUI : DEFAULT_SCENE_VIEW_PREFS.layers.showUI,
      },
    };
  } catch { return DEFAULT_SCENE_VIEW_PREFS; }
}

/** Merge and persist a partial update — callers pass only the field(s) that changed. */
export function saveSceneViewPrefs(patch: Partial<SceneViewPrefs>): void {
  if (typeof localStorage === 'undefined') return;
  const next = { ...loadSceneViewPrefs(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage full/blocked */ }
}
