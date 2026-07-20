/** Initialize the ECS world — register traits/loaders, load scene from file. */

import { getGameConfig, loadAllFonts, loadManifestJson, ensureManifestLoaded, sceneManager } from '@modoki/engine/runtime';
import { registerAll } from './register';
import { useGameStore } from '@modoki/engine/runtime';

/** Synchronous init — registers all ECS traits + kicks off font loading.
 *  Safe to call once at app startup. Does NOT load the scene (await loadInitialScene for that). */
export function initWorldSync() {
  registerAll();

  const config = getGameConfig();

  // Load fonts from asset manifest (fire-and-forget — fonts render once ready)
  loadRuntimeFonts(config.assetManifest || '/assets.manifest.json');
}

/** Await the initial scene from the current GameConfig.
 *  Delegates to SceneManager which handles preload, refcounted resource cache,
 *  two-world atomic swap, and prefab instantiation. Resolves when the new scene
 *  is the active world (and its assets + shaders are ready). */
export async function loadInitialScene(): Promise<void> {
  const config = getGameConfig();
  if (!config.scenePath) return;
  try {
    await ensureManifestLoaded(config.assetManifest || '/assets.manifest.json');
    await sceneManager.loadScene(config.scenePath);
    console.log(`[Runtime] Loaded scene from ${config.scenePath}`);
  } catch (e) {
    console.warn(`[Runtime] Failed to load scene: ${e}`);
    throw e;
  }
}

async function loadRuntimeFonts(manifestPath: string) {
  const setFontStatus = useGameStore.getState().setFontStatus;
  setFontStatus('loading');
  try {
    // Shares the memoized fetch with the scene-load gate (App.tsx awaits the
    // same promise), so the guid → path map is populated exactly once.
    const data = await ensureManifestLoaded(manifestPath);
    if (!data) { setFontStatus('error'); return; }
    if (data.assets) await loadAllFonts(data.assets);
    setFontStatus('ready');
  } catch (e) {
    console.warn('[Runtime] Failed to load fonts:', e);
    setFontStatus('error');
  }

  // Editor-scoped (ELECTRON_PLAN Phase 1): the asset scanner watches the FS and
  // pushes manifest updates so the guid → path map stays current when a file is
  // moved/renamed mid-session. Gated on __MODOKI_EDITOR__; the transport is the
  // HMR socket today (Phase 2 swaps it for IPC under Electron).
  if (__MODOKI_EDITOR__ && import.meta.hot) {
    import.meta.hot.on('asset-manifest-updated', (data: unknown) => {
      try { loadManifestJson(data as Parameters<typeof loadManifestJson>[0]); }
      catch (e) { console.warn('[Runtime] manifest update failed:', e); }
    });
  }
}
