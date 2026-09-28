/**
 * Host-agnostic asset backend for the Electron main process (ELECTRON_PLAN
 * Phase 2). Provides the same asset-root resolution + manifest cache + file
 * watcher the Vite plugin owns, so the *same* editorBackendRouter can run in
 * main with no Vite server. The pure machinery (findAssetRoots / scanAllAssets /
 * buildManifest / resolveAssetPath / absToAssetUrl / detectType) is reused from
 * the scanner; only the transport-specific glue (the shared asset-tree watcher +
 * broadcast callbacks) lives here.
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import {
  findAssetRoots, defaultSaveRootDir, scanAllAssets, buildManifest, resolveAssetPath, absToAssetUrl, classifySceneChange,
  isUnderAssetRoot, pathToClassifyForChange, isSiblingRaisedChange,
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
  let cachedManifest = buildManifest(scanAllAssets(assetRoots), true) as ElectronAssetManifest;

  // ── Editor-own-write suppression — the SAME guard the Vite plugin's watcher uses ──
  // A route that changes a watched file marks it (`markEditorWrite`) so the watcher skips the hot-reload broadcast — an
  // editor Cmd+S must not bounce the live scene, and an editor delete must not reload it (#1702). TTL, content
  // fingerprint (the F9 late-rename gap), delete fingerprint and drive-letter keying all live in `createEditorWriteGuard`.
  // This used to be an inline copy, "the logic is identical", kept apart to keep a Vite-plugin module out of the main
  // process — which already imported the scanner for everything else, and #1702 then had to change both copies.
  const { mark: markEditorWrite, isWrite: isEditorWrite } = createEditorWriteGuard();
  const hashFileSync = (file: string): string | null => {
    try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); }
    catch { return null; }
  };

  const rebuildManifest = (): ElectronAssetManifest => {
    assetRoots = findAssetRoots(projectRoot);
    cachedManifest = buildManifest(scanAllAssets(assetRoots), true) as ElectronAssetManifest;
    onManifestUpdated?.(cachedManifest);
    return cachedManifest;
  };

  // ── Watcher (`createAssetTreeWatcher`: chokidar on macOS/Linux, one recursive fs.watch per root on Windows so a
  //    folder with subfolders can still be recycled, #1708). Debounced rebuild + scene/prefab classification —
  //    same logic as the Vite plugin's onChange/flushPending. ──
  let watcher: AssetTreeWatcher | null = null;
  let pendingRebuild: NodeJS.Timeout | null = null;
  // `viaSibling` = this urlPath's OWN file did not change; a SIBLING did (today: a
  // `.glsl`/`.wgsl` body remapped to its `.shader.json` descriptor, #857). The consumer needs
  // it because `dropParkedWriteFor` discards an unsaved parked edit on the grounds that "the
  // file on disk is now authoritative" — true when the descriptor itself was rewritten, FALSE
  // when only its body sibling was, and discarding then throws away exactly the Inspector edit
  // the author was iterating on. Collapsing several changes in one debounce window ANDs the
  // flag, so a direct write to the descriptor in the same window wins and the drop still happens.
  const pendingSceneChanges = new Map<string, { kind: LiveReloadKind; viaSibling: boolean }>();
  const flushPending = () => {
    pendingRebuild = null;
    rebuildManifest();
    if (pendingSceneChanges.size) {
      for (const [urlPath, { kind, viaSibling }] of pendingSceneChanges) onSceneChanged?.(urlPath, kind, viaSibling);
      pendingSceneChanges.clear();
    }
  };
  const scheduleRebuild = () => {
    if (pendingRebuild) clearTimeout(pendingRebuild);
    pendingRebuild = setTimeout(flushPending, 150);
  };
  const onChange = (file: string) => {
    // Reuse the scanner's helper rather than a bare `file.startsWith(r.absDir)`, which
    // has no separator boundary and so also matches a sibling root sharing the prefix
    // (`<root>-evil`, `…/assets-extra`) — the same shape as the traversal bug fixed in
    // asset-tree-shaker. Benign here (an extra manifest rebuild, not an escape) because
    // the watcher is seeded from these very roots, but there's no reason to keep a fourth
    // hand-rolled copy of containment logic when a tested one is already exported.
    if (!isUnderAssetRoot(file, assetRoots)) return;
    // CALL the shared classifier — do NOT re-implement it. This block used to duplicate
    // classifySceneChange's logic ("same logic as the Vite plugin"), so when that gained
    // 'animation' (C7 — invalidate the stale clip cache) the fix reached the Vite path and
    // silently MISSED this one: i.e. it worked in a browser and was dead in the Electron
    // editor, dev AND packaged — every surface the modoki MCP actually targets. Duplicated
    // logic rots; one function cannot.
    //
    // ⚠️ Sharing `classifySceneChange` fixed THAT gap but left the raw `extname(file) ===
    // '.json'` extension test itself duplicated — the ONE line the fix above didn't route
    // through a shared helper. That is exactly the line #857's shader-body fix exposed: a
    // `.glsl`/`.wgsl` body edit is never itself `.json`, so when the Vite plugin's `onChange`
    // was taught (via `pathToClassifyForChange`) to remap a shader BODY to its sibling
    // `.shader.json` descriptor before classifying, this copy's own `.json` test kept gating on
    // the un-remapped body path and could never pass — the fix worked in a browser and stayed
    // dead here. `pathToClassifyForChange` is now the one shared gate for BOTH what to test and
    // what to classify, so this can't drift from the Vite plugin's copy again.
    const target = pathToClassifyForChange(file);
    // isEditorWrite is checked against `file` (the BODY actually written), never `target` (the
    // remapped descriptor) — it's a content-hash guard, and hashing the wrong file would defeat it.
    if (target && !isEditorWrite(file, () => hashFileSync(file))) {
      const rel = target.split(path.sep).join('/');
      const kind = classifySceneChange(rel);
      if (kind) {
        const urlPath = absToAssetUrl(target, assetRoots);
        if (urlPath) {
          const viaSibling = isSiblingRaisedChange(file, target, pendingSceneChanges.get(urlPath)?.viaSibling);
          pendingSceneChanges.set(urlPath, { kind, viaSibling });
        }
      }
    }
    scheduleRebuild();
  };

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
      if (pendingRebuild) clearTimeout(pendingRebuild);
      await watcher?.close();
      watcher = null;
    },
  };
}
