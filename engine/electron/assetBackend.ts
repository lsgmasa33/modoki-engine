/**
 * Host-agnostic asset backend for the Electron main process (ELECTRON_PLAN
 * Phase 2). Provides the same asset-root resolution + manifest cache + file
 * watcher the Vite plugin owns, so the *same* editorBackendRouter can run in
 * main with no Vite server. The pure machinery (findAssetRoots / scanAllAssets /
 * buildManifest / resolveAssetPath / absToAssetUrl / detectType) is reused from
 * the scanner; only the transport-specific glue (a standalone chokidar watcher +
 * broadcast callbacks) lives here.
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  findAssetRoots, scanAllAssets, buildManifest, resolveAssetPath, absToAssetUrl, classifySceneChange,
  type AssetRoot,
  type LiveReloadKind,
} from '../plugins/vite-asset-scanner';
import { computeKeptAssets, type TreeShakeResult } from '../plugins/asset-tree-shaker';

export interface ElectronAssetManifest { version: 2; assets: Array<{ path: string; type: string; guid?: string }> }

export interface ElectronAssetBackend {
  projectRoot: string;
  resolveAssetPath(urlPath: string): string | null;
  absToAssetUrl(absPath: string): string | null;
  firstRootDir(): string | null;
  getManifest(): ElectronAssetManifest;
  rebuildManifest(): ElectronAssetManifest;
  /** Run the asset tree-shaker over the project (orphan detection for the
   *  "Clean Up Unused Assets" dialog). Uses the live asset roots. */
  computeUnused(): TreeShakeResult;
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
  onSceneChanged?(urlPath: string, kind: LiveReloadKind): void;
}): ElectronAssetBackend {
  const { projectRoot, onManifestUpdated, onSceneChanged } = opts;
  let assetRoots: AssetRoot[] = findAssetRoots(projectRoot);
  let cachedManifest = buildManifest(scanAllAssets(assetRoots), true) as ElectronAssetManifest;

  // ── Editor-own-write suppression (mirrors the Vite plugin) ──
  // A write via /api/write-file marks the file so the watcher skips the
  // hot-reload broadcast — an editor Cmd+S must not bounce the live scene. The
  // 1500ms TTL covers chokidar's add+change burst; the content fingerprint closes
  // the F9 late-rename gap (a rename event past the TTL is still a self-write while
  // the on-disk bytes equal what we wrote). Kept inline (not the Vite plugin's
  // createEditorWriteGuard) to avoid importing a Vite-plugin module into the
  // Electron main process; the logic is identical. (editor-core F9)
  const recentEditorWrites = new Map<string, { exp: number; hash: string | null }>();
  const markEditorWrite = (absPath: string, hash: string | null = null) => {
    recentEditorWrites.set(absPath, { exp: Date.now() + 1500, hash });
    setTimeout(() => {
      const e = recentEditorWrites.get(absPath);
      if (e && e.exp <= Date.now() && e.hash == null) recentEditorWrites.delete(absPath);
    }, 1600);
  };
  const hashFileSync = (file: string): string | null => {
    try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); }
    catch { return null; }
  };
  const isEditorWrite = (absPath: string, currentHash?: () => string | null) => {
    const e = recentEditorWrites.get(absPath);
    if (!e) return false;
    if (e.exp > Date.now()) return true;
    if (e.hash != null && currentHash) {
      const cur = currentHash();
      if (cur != null && cur === e.hash) return true;
      recentEditorWrites.delete(absPath);
    }
    return false;
  };

  const rebuildManifest = (): ElectronAssetManifest => {
    assetRoots = findAssetRoots(projectRoot);
    cachedManifest = buildManifest(scanAllAssets(assetRoots), true) as ElectronAssetManifest;
    onManifestUpdated?.(cachedManifest);
    return cachedManifest;
  };

  // ── Watcher (chokidar). Debounced rebuild + scene/prefab classification —
  //    same logic as the Vite plugin's onChange/flushPending. ──
  let watcher: FSWatcher | null = null;
  let pendingRebuild: NodeJS.Timeout | null = null;
  const pendingSceneChanges = new Map<string, LiveReloadKind>();
  const flushPending = () => {
    pendingRebuild = null;
    rebuildManifest();
    if (pendingSceneChanges.size) {
      for (const [urlPath, kind] of pendingSceneChanges) onSceneChanged?.(urlPath, kind);
      pendingSceneChanges.clear();
    }
  };
  const scheduleRebuild = () => {
    if (pendingRebuild) clearTimeout(pendingRebuild);
    pendingRebuild = setTimeout(flushPending, 150);
  };
  const onChange = (file: string) => {
    if (!assetRoots.some((r) => file.startsWith(r.absDir))) return;
    if (path.extname(file).toLowerCase() === '.json' && !isEditorWrite(file, () => hashFileSync(file))) {
      const rel = file.split(path.sep).join('/');
      // CALL the shared classifier — do NOT re-implement it. This block used to duplicate
      // classifySceneChange's logic ("same logic as the Vite plugin"), so when that gained
      // 'animation' (C7 — invalidate the stale clip cache) the fix reached the Vite path and
      // silently MISSED this one: i.e. it worked in a browser and was dead in the Electron
      // editor, dev AND packaged — every surface the modoki MCP actually targets. Duplicated
      // logic rots; one function cannot.
      const kind = classifySceneChange(rel);
      if (kind) {
        const urlPath = absToAssetUrl(file, assetRoots);
        if (urlPath) pendingSceneChanges.set(urlPath, kind);
      }
    }
    scheduleRebuild();
  };

  return {
    projectRoot,
    resolveAssetPath: (p) => resolveAssetPath(p, assetRoots),
    absToAssetUrl: (p) => absToAssetUrl(p, assetRoots),
    firstRootDir: () => assetRoots[0]?.absDir ?? null,
    getManifest: () => cachedManifest,
    rebuildManifest,
    computeUnused: () => computeKeptAssets(projectRoot, assetRoots),
    markEditorWrite,
    start() {
      if (watcher) return;
      watcher = chokidar.watch(assetRoots.map((r) => r.absDir), {
        ignoreInitial: true,
        ignored: (p) => p.split(path.sep).some((seg) => seg.startsWith('.')),
      });
      watcher.on('add', onChange).on('change', onChange).on('unlink', onChange);
    },
    async stop() {
      if (pendingRebuild) clearTimeout(pendingRebuild);
      await watcher?.close();
      watcher = null;
    },
  };
}
