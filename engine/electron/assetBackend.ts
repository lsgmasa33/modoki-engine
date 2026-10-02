/**
 * Host-agnostic asset backend for the Electron main process (ELECTRON_PLAN
 * Phase 2). Provides the same asset-root resolution + manifest cache + file
 * watcher the Vite plugin owns, so the *same* editorBackendRouter can run in
 * main with no Vite server. The pure machinery (findAssetRoots / scanAllAssets /
 * scanDevManifest / resolveAssetPath / absToAssetUrl / detectType) is reused from
 * the scanner; only the transport-specific glue (the shared asset-tree watcher +
 * broadcast callbacks) lives here.
 */

import {
  findAssetRoots, defaultSaveRootDir, scanDevManifest, resolveAssetPath, absToAssetUrl, createSceneChangeBatch,
  type AssetRoot,
  type LiveReloadKind,
} from '../plugins/vite-asset-scanner';
import { createEditorWriteGuard } from '../plugins/editorWriteGuard';
import { createAssetTreeWatcher, type AssetTreeWatcher } from '../plugins/assetTreeWatcher';
import { computeKeptAssets, enumerateRefEdges, type TreeShakeResult, type RefEdgeEnumeration } from '../plugins/asset-tree-shaker';

export interface ElectronAssetManifest { version: 2; assets: Array<{ path: string; type: string; guid?: string }> }

export interface ElectronAssetBackend {
  projectRoot: string;
  resolveAssetPath(urlPath: string): string | null;
  absToAssetUrl(absPath: string, opts?: { onDisk?: boolean }): string | null;
  firstRootDir(): string | null;
  getManifest(): ElectronAssetManifest;
  rebuildManifest(): ElectronAssetManifest;
  /** Run the asset tree-shaker over the project (orphan detection for the
   *  "Clean Up Unused Assets" dialog). Uses the live asset roots. */
  computeUnused(): TreeShakeResult;
  /** Enumerate every reference edge in the project — the shaker's own walk with an
   *  observer attached — for the reverse index behind Find References (#284). */
  computeRefEdges(): RefEdgeEnumeration;
  markEditorWrite(absPath: string, hash?: string | null): void;
  /** Begin watching asset roots for changes. */
  start(): void;
  /** Stop the watcher (app teardown). */
  stop(): Promise<void>;
}

export function createAssetBackend(opts: {
  projectRoot: string;
  /** Called after the manifest is rebuilt (guid→path map refresh). */
  onManifestUpdated?(manifest: ElectronAssetManifest): void;
  /** Called when an active scene/prefab file changes (hot-reload trigger). */
  onSceneChanged?(urlPath: string, kind: LiveReloadKind, viaSibling: boolean): void;
}): ElectronAssetBackend {
  const { projectRoot, onManifestUpdated, onSceneChanged } = opts;
  let assetRoots: AssetRoot[] = findAssetRoots(projectRoot);
  let cachedManifest = scanDevManifest(assetRoots) as ElectronAssetManifest;

  // ── Editor-own-write suppression — the SAME guard the Vite plugin's watcher uses ──
  // A route that changes a watched file marks it (`markEditorWrite`) so the watcher skips the hot-reload broadcast — an
  // editor Cmd+S must not bounce the live scene, and an editor delete must not reload it (#1702). TTL, content
  // fingerprint (the F9 late-rename gap), delete fingerprint and drive-letter keying all live in `createEditorWriteGuard`.
  // This used to be an inline copy, "the logic is identical", kept apart to keep a Vite-plugin module out of the main
  // process — which already imported the scanner for everything else, and #1702 then had to change both copies.
  const editorWriteGuard = createEditorWriteGuard();
  const markEditorWrite = editorWriteGuard.mark;

  const rebuildManifest = (): ElectronAssetManifest => {
    assetRoots = findAssetRoots(projectRoot);
    cachedManifest = scanDevManifest(assetRoots) as ElectronAssetManifest;
    onManifestUpdated?.(cachedManifest);
    return cachedManifest;
  };

  // ── Watcher (`createAssetTreeWatcher`: chokidar on macOS/Linux, one recursive fs.watch per root on Windows so a
  //    folder with subfolders can still be recycled, #1708). What an event does is `createSceneChangeBatch`'s, the ONE
  //    implementation the Vite plugin's watcher uses too — this was a hand-kept copy that drifted from it twice (C7's
  //    'animation' classification, #857's shader-body remap) before #1911 had to change both. ──
  let watcher: AssetTreeWatcher | null = null;
  const changeBatch = createSceneChangeBatch({
    assetRoots: () => assetRoots,
    guard: editorWriteGuard,
    rebuildManifest: () => { rebuildManifest(); },
    broadcast: (urlPath, kind, viaSibling) => onSceneChanged?.(urlPath, kind, viaSibling),
  });
  const onChange = changeBatch.onChange;

  return {
    projectRoot,
    resolveAssetPath: (p) => resolveAssetPath(p, assetRoots),
    absToAssetUrl: (p, opts) => absToAssetUrl(p, assetRoots, opts),
    firstRootDir: () => defaultSaveRootDir(assetRoots),
    getManifest: () => cachedManifest,
    rebuildManifest,
    computeUnused: () => computeKeptAssets(projectRoot, assetRoots),
    computeRefEdges: () => enumerateRefEdges(projectRoot, assetRoots),
    markEditorWrite,
    start() {
      if (watcher) return;
      watcher = createAssetTreeWatcher({ roots: assetRoots.map((r) => r.absDir), onEvent: (_kind, file) => onChange(file) });
    },
    async stop() {
      changeBatch.cancel();
      await watcher?.close();
      watcher = null;
    },
  };
}
