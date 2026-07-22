// HMR: `_customPanels`/`_gameView`/`_extraMenus`/`_projectSettings` below are written ONLY
// by createEditor(), which app/editor/setup.ts calls once at bootstrap. A module swap
// resets them to empty with nothing to repopulate them, and EditorApp reads
// getGameViewComponent() at MODULE scope — so the Game panel silently falls back to a stub.
// The returned component's identity also can't be swapped into the mounted tree (App.tsx
// resolved it through React.lazy). Reload instead; see input/keymap.ts for the pattern.
if (import.meta.hot) import.meta.hot.accept(() => { window.location.reload(); });

/** createEditor — factory that returns a configured React editor component.
 *  Games call this with their config, postprocessors, traits, and custom panels. */

import React from 'react';
import type { GameConfig } from '../runtime/config';
import type { EditorPanelDef } from '../runtime/gameDefinition';
import type { TraitMeta } from '../runtime/ecs/traitRegistry';
import { registerModelPostprocessor, type ModelPostprocessor } from '../runtime/loaders/modelPostprocessorRegistry';
import { registerTrait } from '../runtime/ecs/traitRegistry';
import { setGameConfig } from '../runtime/config';
import { getCurrentWorld, registerEntity } from '../runtime/ecs/world';
import { Camera } from '../runtime/traits/Camera';
import { Transform } from '../runtime/traits/Transform';
import { EntityAttributes } from '../runtime/traits/EntityAttributes';
import { loadScene, setCurrentScenePath, setScenePersistenceProject, lastSceneKey } from './scene/serialize';
import { registerSelectionRestore } from './store/selectionRestore';
import { registerLastAnimationClipPersistence, restoreLastAnimationClip } from './animation/lastAnimationClip';
import { registerLastSkinRigPersistence, restoreLastSkinRig } from './panels/lastSkinRig';
import { ensureManifestLoaded, loadManifestJson, getGuidForPath, resolveGuidToPath, isGuid } from '../runtime/loaders/assetManifest';
import { rendererReady } from '../runtime/loaders/textureResolver';
import { installConsoleCapture } from './consoleCapture';
import { useEditorStore } from './store/editorStore';
import { assetSetSignature } from './assetSetSignature';

/** Last asset-set signature the Assets panel was refreshed on (see assetSetSignature
 *  for why we dedupe rather than refresh on every broadcast). */
let lastAssetSig: string | null = null;

// `lastSceneKey` now lives in scene/serialize (single source shared with the writer,
// setCurrentScenePath). Re-exported here for existing test imports.
export { lastSceneKey };

/** Build the ordered, de-duplicated list of scene paths to try, most-preferred
 *  first: the stored last-opened scene, then the project's configured default.
 *  Falsy entries are dropped and duplicates collapsed (a last-scene equal to the
 *  default yields a single candidate). Pure — exported for unit testing. */
export function resolveSceneCandidates(lastScene: string | null | undefined, configScenePath: string | undefined): string[] {
  return [...new Set(
    [lastScene, configScenePath].filter((p): p is string => !!p),
  )];
}

/** Map a boot-scene candidate to its canonical working-copy path before loading.
 *
 *  A BUILT editor (cloud host, packaged Electron) gets `config.scenePath` from a
 *  Vite `?url` import — a HASHED, bundled COPY of the scene baked into the editor
 *  dist (`/assets/tropical-island-DC3lOki3.json`), NOT the working-copy file. If
 *  the editor boots that path, the loaded scene's path never matches the asset
 *  watcher's working-copy broadcast (`/assets/scenes/tropical-island.json`), so an
 *  external/agent/git edit to the auto-loaded scene doesn't hot-reload and a save
 *  doesn't round-trip — cloud-editor gap #2. (Scenes opened via the Scenes panel
 *  already use the canonical path, so they round-trip; only the *first auto-load*
 *  was affected.) The manifest already maps the scene's GUID → its canonical
 *  working-copy path, so resolve through it and boot that instead.
 *
 *  Cheap path: a candidate already registered in the manifest (a Scenes-panel
 *  path, or a prior canonical `lastScene`) is returned untouched — no fetch.
 *  Otherwise fetch the candidate once, read its scene `id` (GUID), and map it to
 *  the canonical manifest path. ANY failure (non-OK fetch, missing/non-GUID id,
 *  unregistered scene) falls back to the raw candidate, preserving the dev `?url`
 *  behaviour. Requires the manifest to be loaded first. The `doFetch` injection
 *  point exists for unit testing. */
export async function canonicalBootScenePath(
  scenePath: string,
  doFetch: typeof fetch = fetch,
): Promise<string> {
  // Already a registered manifest path (the working-copy canonical) → nothing to do.
  if (getGuidForPath(scenePath)) return scenePath;
  try {
    const res = await doFetch(scenePath, { cache: 'no-store' });
    if (!res.ok) return scenePath;
    const data = (await res.json()) as { id?: unknown };
    const id = typeof data?.id === 'string' ? data.id : null;
    if (id && isGuid(id)) {
      const canonical = resolveGuidToPath(id);
      if (canonical && canonical !== scenePath) return canonical;
    }
  } catch {
    /* fall back to the raw candidate */
  }
  return scenePath;
}

/** Load the first candidate that loads, canonicalizing each to its working-copy
 *  path first (gap #2) and falling back to the RAW candidate if the canonical
 *  form fails — so a host that can't serve the working copy still boots the
 *  always-present baked bundle copy instead of dropping to an empty world.
 *  Returns the path actually loaded, or null if none did. Pure over its injected
 *  collaborators — exported for unit testing. */
export async function loadFirstScene(
  candidates: string[],
  deps: { canonicalize: (p: string) => Promise<string>; load: (p: string) => Promise<boolean> },
): Promise<string | null> {
  // A candidate that THROWS must not abort the fallback chain. `load` rejects (it
  // does not merely return false) whenever the host serves something that isn't the
  // scene JSON — most commonly the dev server's SPA index.html fallback, which makes
  // JSON.parse throw `Unexpected token '<'`. That escaped this loop, so the very
  // fallback the loop exists to provide never ran and editor boot died on the first
  // bad candidate. Real case: a stale `/@fs/<abs>` last-scene pointing at a project
  // on a DIFFERENT Windows drive — Vite's html-fallback middleware refuses such
  // paths (vitejs/vite#12816, closed as not-planned), so it 404s to index.html while
  // the project's own `/assets/...` candidate right behind it would have loaded.
  const tryLoad = async (p: string): Promise<boolean> => {
    try {
      return await deps.load(p);
    } catch (err) {
      console.warn(`[Editor] Scene at ${p} failed to load, trying next fallback…`, err);
      return false;
    }
  };
  for (const candidate of candidates) {
    // Canonicalization is best-effort: fall back to the raw candidate if it throws.
    let canonical = candidate;
    try {
      canonical = await deps.canonicalize(candidate);
    } catch {
      canonical = candidate;
    }
    if (await tryLoad(canonical)) return canonical;
    if (canonical !== candidate && (await tryLoad(candidate))) return candidate;
    console.warn(`[Editor] Scene not found at ${candidate}, trying next fallback…`);
  }
  return null;
}

/** HARD deadline for `rendererReady` to fire (SceneView calling setActiveRenderer).
 *  Beyond this we surface a failure instead of hanging forever. Deliberately generous:
 *  a PACKAGED first-launch-after-update clears the Vite dep-cache, and the cold
 *  re-optimize + first WebGPU/WGSL compile can take a LONG time on a slow machine
 *  (observed >50s on Windows with Defender scanning every chunk). The old 15s cap
 *  ABORTED that legitimate cold start — the scene load rejected and the user got a
 *  blank world + a scary "scene load failed" until they reloaded (which is fast
 *  because the cache is then warm). 120s comfortably covers the cold path while still
 *  eventually surfacing a genuinely dead renderer (a real WebGPU/WebGL init failure). */
export const RENDERER_READY_TIMEOUT_MS = 120_000;

/** SOFT deadline: at this point the renderer usually IS ready, so if it isn't we emit a
 *  NON-FATAL warning (kept waiting up to the hard cap) — otherwise a slow cold start is a
 *  silent blank screen for up to two minutes. This is the old hard value, repurposed as a
 *  progress signal (it forwards to the packaged main.log for diagnosis). */
export const RENDERER_READY_SOFT_TIMEOUT_MS = 15_000;

/** Await `ready`, but reject if it doesn't settle within `timeoutMs` (the HARD cap). A
 *  non-fatal soft warning fires at `softTimeoutMs` and we KEEP waiting — a slow-but-fine
 *  cold start (Vite dep-optimize / GPU warm-up) recovers instead of aborting the scene load.
 *  Both pending timers are ALWAYS cleared once the race settles (success OR hard timeout) so
 *  a slow-then-eventually-ready renderer doesn't leave a dangling timer (which under Node/test
 *  would also keep the process alive). Pure (timer-injectable) — exported for unit testing. */
export async function awaitRendererReady(
  ready: Promise<unknown>,
  timeoutMs: number = RENDERER_READY_TIMEOUT_MS,
  // NOTE: the defaults MUST be bound to globalThis. A bare `{ setTimeout, clearTimeout }`
  // is invoked as `timers.setTimeout(...)` → `this === timers`, which browsers reject with
  // "Illegal invocation" (the real scene-load path, not exercised by injected fake timers).
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  },
  opts: { softTimeoutMs?: number; onSoftTimeout?: () => void } = {},
): Promise<void> {
  const softMs = Math.min(opts.softTimeoutMs ?? RENDERER_READY_SOFT_TIMEOUT_MS, timeoutMs);
  const onSoftTimeout = opts.onSoftTimeout ?? (() => console.warn(
    `[Editor] renderer still initializing after ${softMs}ms — a cold Vite dep-optimize / GPU ` +
    `warm-up (common on the FIRST launch after an update, especially on Windows) can take a while. ` +
    `Waiting up to ${timeoutMs}ms before giving up…`,
  ));
  let hardId: ReturnType<typeof setTimeout> | undefined;
  const rendererTimeout = new Promise<never>((_, reject) => {
    hardId = timers.setTimeout(() => {
      reject(new Error(
        `[Editor] rendererReady did not resolve within ${timeoutMs}ms — ` +
        `SceneView never called setActiveRenderer. Check the browser console for a WebGPU/WebGL init error.`,
      ));
    }, timeoutMs);
  });
  const softId = timers.setTimeout(() => { onSoftTimeout(); }, softMs);
  try {
    await Promise.race([ready, rendererTimeout]);
  } finally {
    if (hardId !== undefined) timers.clearTimeout(hardId);
    timers.clearTimeout(softId);
  }
}

/** A single editable field in the Project Settings window. `key` is a dot-path
 *  into the settings object (e.g. "build.webBucket"). */
export interface ProjectSettingsField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'checkbox' | 'select' | 'combo' | 'string-list' | 'physics-layers' | 'path' | 'scene-list' | 'module-toggles';
  /** Options for `select` fields, and suggestions for a `combo` (free-text +
   *  datalist) field — the stored value is the option's `value`. */
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
  /** For `path` fields — whether the Browse… button picks a file or a folder. */
  pathMode?: 'file' | 'folder';
  /** Conditional visibility: show this field only when the current value at
   *  `key` (a dot-path into the settings object) is one of `in`. Used e.g. to
   *  show the GCS/CDN fields only in the matching web-deploy mode. */
  showIf?: { key: string; in: string[] };
}

/** One group of fields inside a Project Settings tab. */
export interface ProjectSettingsGroup {
  title: string;
  fields: ProjectSettingsField[];
}

/** One tab in the Project Settings window (e.g. General, Web, iOS). */
export interface ProjectSettingsTab {
  title: string;
  groups: ProjectSettingsGroup[];
}

/** Project-specific Project Settings definition, injected by the host so the
 *  reusable engine stays free of project-specific fields. */
export interface ProjectSettingsSchema {
  tabs: ProjectSettingsTab[];
  /** Fetch the current values (e.g. GET /api/project-settings). */
  load: () => Promise<Record<string, unknown>>;
  /** Persist values on Apply. Resolve `true` on success. */
  save: (values: Record<string, unknown>) => Promise<boolean>;
  /** Open a native file/folder chooser for `path` fields. Resolves the chosen
   *  path (project-relative when inside the project, else absolute), or null on
   *  cancel/unsupported. Host-provided so the package stays backend-agnostic. */
  pickPath?: (mode: 'file' | 'folder') => Promise<string | null>;
}

export interface EditorOptions {
  /** Game configuration */
  config: GameConfig;
  /** The open project's game id (e.g. "space-console"). Used to activate the
   *  project's game-scoped managers on boot — the canonical working-copy scene
   *  path the editor boots (gap #2) has no `/games/<id>/` segment for SceneManager
   *  to derive it from. Distinct from `config.name` (the display name). */
  gameId?: string;
  /** Game-specific model postprocessors */
  postprocessors?: { id: string; postprocessor: ModelPostprocessor }[];
  /** Game-specific trait registrations */
  traits?: (TraitMeta & { priority?: number })[];
  /** Game-specific editor panels (id/name/component + optional openByDefault/dockLocation) */
  panels?: EditorPanelDef[];
  /** Game View component (renders the live game preview) */
  gameView?: React.ComponentType;
  /** Extra menus to add to the editor menu bar (e.g., Build) */
  extraMenus?: Record<string, { label: string; action?: () => void; separator?: boolean; disabled?: boolean; shortcut?: string }[]>;
  /** Project Settings window schema + persistence (adds File → Project Settings). */
  projectSettings?: ProjectSettingsSchema;
}

/** Registry of custom panels added by the game */
let _customPanels: EditorPanelDef[] = [];
let _gameView: React.ComponentType | null = null;
let _extraMenus: EditorOptions['extraMenus'] = {};
let _projectSettings: ProjectSettingsSchema | null = null;

export function getCustomPanels() { return _customPanels; }
export function getGameViewComponent() { return _gameView; }
export function getExtraMenus() { return _extraMenus; }
export function getProjectSettings() { return _projectSettings; }

export function createEditor(options: EditorOptions): React.ComponentType {
  // Capture console output + uncaught errors/rejections at the VERY START of
  // editor launch, before any lazy panel bundle (incl. Console) loads — so no
  // early-init log or error is missed. Idempotent.
  installConsoleCapture();

  // Register game config
  setGameConfig(options.config);

  // Dev-only: expose a window bridge so E2E (Playwright) tests can observe
  // selection + trait state. Stripped from production builds via DEV gate.
  if (import.meta.env.DEV) {
    import('./devTestBridge').then((m) => m.installEditorTestBridge());
  }

  // Register game-specific model postprocessors
  for (const { id, postprocessor } of options.postprocessors || []) {
    registerModelPostprocessor(id, postprocessor);
  }

  // Register game-specific traits
  for (const traitDef of options.traits || []) {
    registerTrait(traitDef);
  }

  // Store custom panels, game view, and extra menus for EditorApp to pick up
  _customPanels = options.panels || [];
  _gameView = options.gameView || null;
  _extraMenus = options.extraMenus || {};
  _projectSettings = options.projectSettings || null;

  // Subscribe to world swaps to restore the editor's selection across scene loads
  registerSelectionRestore();
  // Mirror the open animation clip to localStorage (restored below once the scene loads).
  registerLastAnimationClipPersistence();
  // Mirror the open .rig2d rig to localStorage (restored below once the manifest loads).
  registerLastSkinRigPersistence();
  // Tell the scene-path writer which project we're in, so every scene switch persists
  // the PER-PROJECT last-scene key that we restore from on the next launch.
  setScenePersistenceProject(options.config.name);

  // Keep the guid → path map current when the asset scanner detects a file
  // move/rename. Editor-scoped (ELECTRON_PLAN Phase 1): gated on __MODOKI_EDITOR__;
  // the transport is the HMR socket today (Phase 2 swaps it for IPC under Electron).
  if (__MODOKI_EDITOR__ && import.meta.hot) {
    import.meta.hot.on('asset-manifest-updated', (data: unknown) => {
      try {
        const manifest = data as Parameters<typeof loadManifestJson>[0];
        loadManifestJson(manifest);
        // Auto-refresh the Assets panel when the set of files on disk changes
        // (Finder drops, Create Prefab, external edits, deletes/renames) so the
        // user never has to hit Refresh. assetSetSignature dedupes the watcher's
        // self-echo to avoid a refresh→fetch→rebuild→refresh loop.
        const sig = assetSetSignature(manifest?.assets);
        if (sig !== lastAssetSig) {
          lastAssetSig = sig;
          useEditorStore.getState().refreshAssets();
        }
      } catch (e) { console.warn('[Editor] manifest update failed:', e); }
    });
  }

  // Scene loading: try last opened scene, then config.scenePath, then initWorld.
  // This runs in parallel with the React app mounting: the manifest load is
  // cheap and can proceed immediately, but the actual scene load (which
  // preloads materials → textures → KTX2Loader) waits on `rendererReady` so
  // KTX2Loader.detectSupport has run before any loadAsync call. That gate
  // resolves when SceneView's renderer fires setActiveRenderer, which
  // requires the EditorApp bundle to have mounted — hence the React.lazy
  // below is no longer gated on sceneReady (it can't be, or we'd deadlock).
  const sceneReady = (async () => {
    // Populate the guid → path map BEFORE loading any scene — otherwise every
    // GUID ref resolves to undefined (missing meshes, black materials). The
    // editor has no game-shell boot, so this is the only place it gets loaded.
    await ensureManifestLoaded(options.config.assetManifest || '/assets.manifest.json');

    // Re-open the .rig2d the user was last editing in the Skin panel. A rig is a
    // scene-independent asset (loaded by path, sprites resolved via the manifest), so
    // restore it here — right after the manifest, before the scene — not gated on which
    // scene loads. Sets the store; the Skin panel shows it whenever it next mounts.
    restoreLastSkinRig();

    // Wait for the renderer to be registered with the texture resolver. Until
    // then KTX2Loader has no workerConfig and loadAsync throws. If SceneView
    // never resolves `rendererReady` (WebGL init failure inside the lazy
    // EditorApp bundle, mount loop, etc.), the scene load would otherwise
    // hang forever silently — time it out and surface the failure.
    await awaitRendererReady(rendererReady);

    // Scope the "last opened scene" by project (config.name) — otherwise the key
    // is global and one project's scene (e.g. 3d-test's "2D Animation.json")
    // leaks into every other project, which then 404s. As a second guard, fall
    // back to this project's own config.scenePath when the stored scene fails to
    // load (stale/deleted, or a leaked path from before this fix): a wrong
    // last-scene self-heals to the project default instead of a blank world.
    const LAST_SCENE_KEY = lastSceneKey(options.config.name);
    const lastScene = localStorage.getItem(LAST_SCENE_KEY);
    const candidates = resolveSceneCandidates(lastScene, options.config.scenePath);

    // Boot the working-copy scene, not a hashed bundle copy, so saves +
    // external-edit hot-reload round-trip in a built/cloud editor (gap #2); pass
    // the project's game id so its game-scoped managers activate (the canonical
    // path carries no `/games/<id>/` segment to derive it from).
    const loadedPath = await loadFirstScene(candidates, {
      canonicalize: canonicalBootScenePath,
      load: (p) => loadScene(p, options.gameId),
    });
    if (loadedPath) {
      localStorage.setItem(LAST_SCENE_KEY, loadedPath);
      // Re-open the clip the user was editing last time (same scene only).
      restoreLastAnimationClip();
      return;
    }
    const scenePath = candidates[candidates.length - 1] ?? null;

    // Try initWorld (game-provided setup)
    if (options.config.initWorld) {
      options.config.initWorld();
      if (scenePath) setCurrentScenePath(scenePath);
      return;
    }

    // Empty scene: just a camera
    const cameraEntity = getCurrentWorld().spawn(
      Transform({ x: 0, y: 5, z: 10 }),
      Camera({ fov: 60 }),
      EntityAttributes({ name: 'Camera', sortOrder: 0 }),
    );
    registerEntity(cameraEntity);
    console.log('[Editor] Created empty scene with default camera');
  })();

  // Lazy-import EditorApp. We intentionally do NOT gate on `sceneReady`:
  // sceneReady awaits `rendererReady`, which only fires once SceneView
  // (inside EditorApp) mounts its WebGPU renderer. EditorApp must therefore
  // mount BEFORE sceneReady resolves. The empty initial world renders fine
  // for a fraction of a second until the scene populates entities.
  // sceneReady is awaited here only to keep the promise rejection visible.
  sceneReady.catch((e) => console.error('[Editor] scene load failed:', e));
  const LazyEditor = React.lazy(() => import('./EditorApp'));

  const EditorWrapper: React.FC = () => (
    <React.Suspense fallback={<div style={{ background: '#1a1a2e', color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100vw', height: '100vh' }}>Loading editor...</div>}>
      <LazyEditor />
    </React.Suspense>
  );

  return EditorWrapper;
}
