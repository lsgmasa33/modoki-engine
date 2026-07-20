/** Assets — browse project assets by category or folder structure */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { backendFetch } from '../backend/editorBackend';
import { getGameConfig } from '../../runtime/config';
import { loadAllFonts } from '../../runtime/loaders/fontLoader';
import {
  instantiatePrefabAsync, setPrefabSource, type PrefabFile, serializePrefab,
} from '../scene/prefab';
import { importModel } from '../scene/modelImport';
import { needsGLBConversion, convertSourceToGLB } from '../scene/convertToGLB';
import { useEditorStore } from '../store/editorStore';
import { pushAction } from '../undo/undoManager';
import { makePrefabInstantiateAction } from '../undo/prefabInstantiateUndo';
import { ASSET_ROOT_RE, firstAssetRoot } from './assetRoots';
// Backend-IO wrappers + create-prefab flow shared with the Hierarchy panel
// (editor-panels F6/F7) — single source of truth for the /api/* calls and the
// "serialize entity → write prefab → tag instance → push undo" flow.
import {
  writeAssetFile as writeFile, deleteAssetFile as deleteAsset, deleteAssetFiles as deleteAssets,
  duplicateAssetFile as duplicateAsset, createFolderApi, moveFileTo, createPrefabFromEntity,
  reimportTargets, planImports, refreshHandlerTypes, HANDLER_TYPES,
} from './assetOps';
import { isTextAsset, makeDeleteUndo, makeDuplicateUndo, type Snapshot, type DeleteResult, type DupResult } from './assetUndo';
import { newGuid, registerAsset } from '../../runtime/loaders/assetManifest';
import { reimportPaths } from './assetViews/reimport';
import { defaultAnimationClip } from '../../runtime/animation/types';
import { defaultParticleEffect } from '../../runtime/particles/types';
import { defaultAssetData } from '../../runtime/assets/assetSchemas';
import { newScene, saveScene, setCurrentScenePath } from '../scene/serialize';
import { findEntity } from '../../runtime/ecs/entityUtils';
import { openAssetInEditor } from './openAssetInEditor';
import { getTraitByName } from '../../runtime/ecs/traitRegistry';
import { saveAssetDialog } from '../utils/saveDialog';

/** Display name from an asset path: last segment minus a known double/single extension. */
function assetDisplayName(p: string, ext: string): string {
  const seg = p.split('/').pop() || p;
  return seg.toLowerCase().endsWith(ext.toLowerCase()) ? seg.slice(0, -ext.length) : seg.replace(/\.[^.]+$/, '');
}
import ContextMenu, { type ContextMenuItem } from '../components/ContextMenu';
import RenameInput from '../components/RenameInput';
import { rangeBetween } from './hierarchySelection';
import { startDragGhost, endDragGhost, setAssetDragPayload, completeAssetDrop, armGrabCursor } from '../utils/dragGhost';
import {
  splitAssetPath, duplicatePathFor, pastePathIn, remapPrefix, buildFolderTree, planAutoImports,
  effectiveAssetsRoot, collectFolderPaths,
  type AssetEntry, type FolderNode,
} from '../utils/assetPaths';
import { ASSET_TYPE_COLORS, AssetTypeGlyph, compareAssetTypes } from './assetTypeIcons';
import ScriptTree from './ScriptTree';
import { SectionHeader, TreeFolderRow, TreeSearchInput, TypeFilterMenu } from './treeChrome';
import { useExpandedSet } from './useExpandedSet';

// Toggle key for the top-level "Assets" section header. Kept out of the folder
// path-space (which the real folders use) so it never collides with one.
const ASSETS_SECTION = '@@assets-section';

async function instantiatePrefabFromPath(prefabPath: string, _name: string) {
  try {
    const res = await fetch(prefabPath);
    if (!res.ok) { console.error(`[Assets] Failed to fetch ${prefabPath}`); return; }
    const prefab: PrefabFile = await res.json();
    const rootId = await instantiatePrefabAsync(prefab);
    setPrefabSource(rootId, prefabPath);
    console.log(`[Assets] Instantiated prefab "${prefab.name}"`);

    const { deleteEntity } = await import('../../runtime/ecs/entityUtils');
    pushAction(makePrefabInstantiateAction({
      label: `Instantiate "${prefab.name}"`,
      initialId: rootId,
      respawn: async () => {
        const r = await fetch(prefabPath);
        if (!r.ok) return null;
        const p: PrefabFile = await r.json();
        const id = await instantiatePrefabAsync(p);
        setPrefabSource(id, prefabPath);
        return id;
      },
      remove: (id) => { deleteEntity(id); },
    }));
  } catch (e) {
    console.error('[Assets] Instantiate failed:', e);
  }
}

/** Try live scan first (dev server), fall back to static manifest (production).
 *  Uses /api/rescan-assets so a refresh forces a fresh filesystem scan + GUID
 *  collision heal rather than serving the watcher's cached manifest. */
async function fetchAssets(): Promise<{ assets: AssetEntry[]; folders: string[] }> {
  try {
    const res = await backendFetch('/api/rescan-assets');
    if (res.ok) {
      const data = await res.json();
      return { assets: (data.assets || []) as AssetEntry[], folders: (data.folders || []) as string[] };
    }
  } catch { /* not available */ }

  const config = getGameConfig();
  const manifestPath = config.assetManifest || '/assets.manifest.json';
  try {
    const res = await fetch(manifestPath);
    if (!res.ok) return { assets: [], folders: [] };
    const data = await res.json();
    return { assets: (data.assets || []) as AssetEntry[], folders: (data.folders || []) as string[] };
  } catch {
    return { assets: [], folders: [] };
  }
}

interface ModelMeta {
  version?: number;
  postprocessor?: string;
  rootTransform?: {
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: number;
  };
}

async function readMeta(assetPath: string): Promise<ModelMeta> {
  try {
    const res = await backendFetch(`/api/read-meta?path=${encodeURIComponent(assetPath)}`);
    if (res.ok) return await res.json();
  } catch { /* ignore */ }
  return {};
}

// Read a browser File as base64 (no data: prefix) for POST /api/write-file.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string; // "data:<mime>;base64,XXXX"
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// The asset tree root ("/") and intermediate nodes (e.g. "/games") are virtual —
// only paths under a real root are writable. Root matching lives in assetRoots.ts
// (shared with the Hierarchy "Create Prefab" flow), so imports have a valid
// default destination when nothing is selected. firstFromEntries adapts the
// shared path-based helper to this panel's AssetEntry[] shape.
function firstFromEntries(assets: AssetEntry[]): string | null {
  return firstAssetRoot(assets.map((a) => a.path));
}

/** Import a model using its .meta.json settings — creates prefab file without instantiating in scene.
 *  Shows modal progress via editor store. */
async function importModelWithMeta(assetPath: string, assetName: string, onDone?: () => void) {
  const { setImportStatus, setImportError, refreshAssets } = useEditorStore.getState();
  setImportStatus(true, `Importing ${assetName}...`);
  try {
    const meta = await readMeta(assetPath);
    const prefix = assetName.replace(/\s+/g, '_').toLowerCase();
    const postprocessorId = meta.postprocessor || 'none';
    const rootTransform = meta.rootTransform;

    // FBX/OBJ/DAE source → generate ONLY the GLB asset (the bake step). No
    // spawn, no prefab — converting a source to GLB is a clean asset-production
    // step. You then "Import Model" the resulting GLB to create its prefab. This
    // also lets you delete the GLB + re-import the FBX to re-bake without
    // accumulating prefabs/entities.
    if (needsGLBConversion(assetPath)) {
      const glbPath = await convertSourceToGLB(assetPath, postprocessorId);
      console.log(`[Assets] Converted ${assetName} → ${glbPath} (GLB only)`);
      refreshAssets(); // surface the newly-baked GLB in the panel
      onDone?.();
      setImportStatus(false);
      return;
    }

    // Temporarily spawn entities to serialize as prefab, then clean up
    const rootId = await importModel(assetPath, prefix, postprocessorId, rootTransform);
    if (!rootId) return;

    const prefab = serializePrefab(rootId);

    // Remove temporary entities from scene
    const { deleteEntity } = await import('../../runtime/ecs/entityUtils');
    deleteEntity(rootId);

    if (prefab) {
      const dir = assetPath.substring(0, assetPath.lastIndexOf('/'));
      const baseName = assetPath.substring(assetPath.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
      const prefabPath = `${dir}/${baseName}.prefab.json`;
      const content = JSON.stringify(prefab, null, 2);
      await writeFile(prefabPath, content);
      console.log(`[Assets] Created prefab: ${prefabPath}`);

      pushAction({
        label: `Import Model "${assetName}"`,
        undo: async () => { await deleteAsset(prefabPath); onDone?.(); },
        redo: async () => { await writeFile(prefabPath, content); onDone?.(); },
      });
    }

    refreshAssets();
    onDone?.();
    setImportStatus(false);
  } catch (e) {
    // Surface conversion/import failures (e.g. unsupported FBX) as a dismissible
    // modal instead of an unhandled rejection — this runs from a fire-and-forget
    // onClick, so a thrown error would otherwise escape uncaught.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[Assets] Import failed for "${assetName}":`, e);
    setImportError(msg);
  }
}

// ─── Asset row (shared between views) ────────────────────────────────

// Folder-relative move (computes the destination path from a target folder).
// Distinct from assetOps.moveFileTo, which takes an explicit full target path.
async function moveFile(fromPath: string, toFolder: string): Promise<boolean> {
  const name = fromPath.substring(fromPath.lastIndexOf('/') + 1);
  const normalizedFolder = toFolder === '/' ? '' : toFolder;
  const toPath = `${normalizedFolder}/${name}`;
  if (fromPath === toPath) return false;
  // Prevent moving a folder into itself or a subfolder
  if (toFolder.startsWith(fromPath + '/') || toFolder === fromPath) return false;
  try {
    const res = await backendFetch('/api/move-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromPath, to: toPath }),
    });
    return res.ok;
  } catch { return false; }
}

// Convertible model SOURCES (kept alongside the GLB they bake into). They share
// the 'model' type with GLB/glTF but aren't the canonical asset, so they get a
// distinct badge — their format in a muted colour — to read as "source".
const SOURCE_MODEL_RE = /\.(obj|fbx|dae)$/i;

const BADGE_BG = '#1a1a2e';

function TypeIcon({ asset }: { asset: AssetEntry }) {
  const isSourceModel = asset.type === 'model' && SOURCE_MODEL_RE.test(asset.path);
  const color = isSourceModel ? '#7f8c8d' : (ASSET_TYPE_COLORS[asset.type] || '#888');
  // Source models (.obj/.fbx/.dae) keep a text FORMAT badge to read as "source,
  // not the shipped GLB". Known types get an SVG glyph; anything else falls back
  // to a 3-letter label.
  const sourceLabel = isSourceModel ? asset.path.slice(asset.path.lastIndexOf('.') + 1).toUpperCase() : null;
  const hasGlyph = asset.type in ASSET_TYPE_COLORS;
  return (
    <span
      title={isSourceModel ? 'Source model — converts to GLB on import (kept for re-import, not shipped)' : asset.type}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        width: 24, height: 18, fontSize: '9px', fontWeight: 'bold',
        color, background: BADGE_BG, borderRadius: 3,
      }}>
      {sourceLabel
        ? sourceLabel
        : hasGlyph
          ? <AssetTypeGlyph type={asset.type} bg={BADGE_BG} />
          : asset.type.slice(0, 3).toUpperCase()}
    </span>
  );
}

// React.memo so a selection change re-renders only the rows whose `selected`
// flag actually flipped, not the whole list (editor-panels F5). The callbacks
// are all stable `useCallback`s that take the asset, and `getDragPaths` is
// computed lazily at dragstart — so no per-render prop (e.g. an eager
// `dragPaths` array or the live selection Set) breaks memoization.
const AssetRow = React.memo(function AssetRow({ asset, depth, selected, onSelect, onDoubleClick, onContextMenu, viewMode, renaming, onCommitRename, onCancelRename, getDragPaths, expandable, expanded, onToggleExpand, childCount }: {
  asset: AssetEntry;
  depth: number;
  selected: boolean;
  onSelect: (asset: AssetEntry, e: React.MouseEvent) => void;
  onDoubleClick: (asset: AssetEntry) => void;
  onContextMenu: (e: React.MouseEvent, asset: AssetEntry) => void;
  viewMode: ViewMode;
  renaming: boolean;
  onCommitRename: (asset: AssetEntry, newBase: string) => void;
  onCancelRename: () => void;
  // The files this row's drag should move — the whole selection when this row
  // is part of a multi-select, otherwise just this asset. Resolved lazily at
  // dragstart so the row needn't depend on the live selection Set.
  getDragPaths: (asset: AssetEntry) => string[];
  // A texture with sliced sprites shows a disclosure triangle to reveal them.
  expandable?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  childCount?: number;
}) {
  // All assets are draggable (to Inspector fields, Hierarchy for prefabs, folder
  // moves) — except while the row's name is being edited inline.
  const canDrag = !renaming;
  // Sliced sprites have no file of their own — they can be dragged onto a ref field
  // (asset payload) but NOT file-moved/renamed, so suppress the file-move payload.
  const isSprite = asset.type === 'sprite';

  return (
    <div
      data-asset-path={asset.path}
      onClick={(e) => onSelect(asset, e)}
      onDoubleClick={() => onDoubleClick(asset)}
      onContextMenu={(e) => onContextMenu(e, asset)}
      onMouseDown={(e) => { if (canDrag && selected) armGrabCursor(e); }}
      onMouseUp={() => document.body.classList.remove('editor-mousedown')}
      draggable={canDrag}
      onDragStart={(e) => {
        if (!canDrag) return;
        const dragPaths = getDragPaths(asset);
        const many = dragPaths.length > 1;
        const assetData = JSON.stringify({ type: asset.type, path: asset.path, name: asset.name, guid: asset.guid });
        e.dataTransfer.setData('application/editor-asset', assetData);
        // Full multi-selection as plain paths — carried in EVERY view mode (unlike the
        // folder-only file-move payload) so multi-asset drop targets (e.g. the Skin editor's
        // Parts list) get the whole selection. Consumers resolve each path to a GUID.
        e.dataTransfer.setData('application/editor-asset-paths', JSON.stringify(dragPaths));
        if (viewMode === 'folder' && !isSprite) {
          // `paths` carries the whole selection for a multi-drag; `path` stays
          // for back-compat with single-file consumers.
          e.dataTransfer.setData('application/editor-file-move', JSON.stringify({ path: asset.path, name: asset.name, paths: dragPaths }));
        }
        // copyMove allows both: file-move to another folder, OR copy/instantiate (e.g. prefab → Hierarchy)
        e.dataTransfer.effectAllowed = viewMode === 'folder' && !isSprite ? 'copyMove' : 'copy';
        setAssetDragPayload(assetData);
        startDragGhost(e, many ? `${dragPaths.length} items` : asset.name);
      }}
      onDragEnd={() => { completeAssetDrop(); endDragGhost(); }}
      style={{
        padding: '3px 8px', paddingLeft: 8 + depth * 14,
        cursor: canDrag && selected ? 'grab' : 'pointer',
        background: selected ? '#3a3a5c' : 'transparent',
        borderLeft: selected ? '3px solid #f1c40f' : '3px solid transparent',
        display: 'flex', alignItems: 'center', gap: 6,
      }}
      title={asset.type === 'prefab' ? 'Drag to Hierarchy to instantiate' : isSprite ? `Sprite — drag onto a 2D sprite field` : asset.path}
    >
      <span
        onClick={expandable ? (e) => { e.stopPropagation(); onToggleExpand?.(); } : undefined}
        style={{ width: 10, flexShrink: 0, textAlign: 'center', color: '#888', fontSize: '10px', cursor: expandable ? 'pointer' : 'default' }}
      >{expandable ? (expanded ? '▼' : '▶') : ''}</span>
      <TypeIcon asset={asset} />
      {renaming ? (
        <RenameInput
          initial={splitAssetPath(asset.path).base}
          onCommit={(v) => onCommitRename(asset, v)}
          onCancel={onCancelRename}
        />
      ) : (
        <span style={{ color: selected ? '#fff' : '#bbb' }}>{asset.name}</span>
      )}
      {expandable && !expanded && childCount != null && (
        <span style={{ color: '#555', fontSize: '10px' }}>({childCount})</span>
      )}
    </div>
  );
});

/** Render a texture/asset row and, when it's a sliced texture, its sprite children
 *  nested below (Unity-style). Used by both the folder and category views. */
function AssetRowWithSprites(props: React.ComponentProps<typeof AssetRow> & {
  spritesByTexture: Map<string, AssetEntry[]>;
  selectedSet: Set<string>;
  expandedSet: Set<string>;
  onToggleRow: (key: string) => void;
}) {
  const { asset, depth, spritesByTexture, selectedSet, expandedSet, onToggleRow, ...rowProps } = props;
  const kids = asset.type === 'texture' && asset.guid ? spritesByTexture.get(asset.guid) : undefined;
  const hasKids = !!kids && kids.length > 0;
  const isExpanded = expandedSet.has(asset.path);
  return (
    <>
      <AssetRow
        {...rowProps}
        asset={asset}
        depth={depth}
        expandable={hasKids}
        expanded={isExpanded}
        childCount={kids?.length}
        onToggleExpand={() => onToggleRow(asset.path)}
      />
      {hasKids && isExpanded && kids!.map((s) => (
        <AssetRow
          key={s.path}
          {...rowProps}
          asset={s}
          depth={depth + 1}
          selected={selectedSet.has(s.path)}
          renaming={false}
        />
      ))}
    </>
  );
}

// ─── Folder view ─────────────────────────────────────────────────────

// React.memo so a folder subtree re-renders only when its own props change.
// All callbacks are stable; `getDragPaths` resolves the drag selection lazily.
// (editor-panels F5.)
const FolderView = React.memo(function FolderView({ node, depth, expanded, onToggle, onToggleDeep, selectedSet, onSelect, onDoubleClick, onContextMenu, onFolderContextMenu, onEntityDrop, onFilesDrop, dropHighlight, setDropHighlight, renamingPath, onCommitRename, onCancelRename, renamingFolderPath, onCommitFolderRename, onCancelFolderRename, getDragPaths, spritesByTexture }: {
  node: FolderNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  /** Option/Alt-click a folder → expand/collapse its whole subtree. */
  onToggleDeep: (node: FolderNode) => void;
  spritesByTexture: Map<string, AssetEntry[]>;
  selectedSet: Set<string>;
  onSelect: (asset: AssetEntry, e: React.MouseEvent) => void;
  onDoubleClick: (asset: AssetEntry) => void;
  onContextMenu: (e: React.MouseEvent, asset: AssetEntry) => void;
  onFolderContextMenu: (e: React.MouseEvent, folderPath: string, folderName: string) => void;
  onEntityDrop: (e: React.DragEvent, folderPath: string) => void;
  onFilesDrop: (filePaths: string[], targetFolder: string) => void;
  dropHighlight: string | null;
  setDropHighlight: (path: string | null) => void;
  renamingPath: string | null;
  onCommitRename: (asset: AssetEntry, newBase: string) => void;
  onCancelRename: () => void;
  renamingFolderPath: string | null;
  onCommitFolderRename: (node: FolderNode, newName: string) => void;
  onCancelFolderRename: () => void;
  getDragPaths: (asset: AssetEntry) => string[];
}) {
  const isExpanded = expanded.has(node.path);
  const totalCount = node.files.length + node.children.reduce((s, c) => s + countAll(c), 0);
  const isDropTarget = dropHighlight === node.path;
  const isRenaming = renamingFolderPath === node.path;

  return (
    <>
      <div
        onClick={(e) => { if (!isRenaming) { if (e.altKey) onToggleDeep(node); else onToggle(node.path); } }}
        onContextMenu={(e) => onFolderContextMenu(e, node.path, node.name)}
        draggable={depth > 0 && !isRenaming}
        onDragStart={(e) => {
          if (depth === 0) { e.preventDefault(); return; }
          e.dataTransfer.setData('application/editor-file-move', JSON.stringify({ path: node.path, name: node.name, isFolder: true }));
          e.dataTransfer.effectAllowed = 'move';
          e.stopPropagation();
          startDragGhost(e, '📁 ' + node.name);
        }}
        onDragEnd={endDragGhost}
        onDragOver={(e) => {
          const t = e.dataTransfer.types;
          if (t.includes('application/editor-entity') || t.includes('application/editor-file-move') || t.includes('Files')) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = t.includes('application/editor-file-move') ? 'move' : 'copy';
            setDropHighlight(node.path);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropHighlight(null);
        }}
        onDrop={(e) => {
          e.stopPropagation();
          setDropHighlight(null);
          // File move within folder view (one file, or a whole multi-selection)
          const fileRaw = e.dataTransfer.getData('application/editor-file-move');
          if (fileRaw) {
            e.preventDefault();
            const parsed = JSON.parse(fileRaw) as { path: string; paths?: string[] };
            const paths = Array.isArray(parsed.paths) && parsed.paths.length ? parsed.paths : [parsed.path];
            onFilesDrop(paths, node.path);
            return;
          }
          // Entity drop from Hierarchy
          onEntityDrop(e, node.path);
        }}
        style={{
          padding: '3px 8px', paddingLeft: 8 + depth * 14, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 4,
          background: isDropTarget ? 'rgba(52, 152, 219, 0.25)' : depth === 0 ? 'transparent' : '#2a2a40',
          outline: isDropTarget ? '1px dashed #3498db' : 'none',
        }}
      >
        <span style={{ color: '#888', fontSize: '10px', width: 10, textAlign: 'center' }}>
          {isExpanded ? '▼' : '▶'}
        </span>
        <span style={{ color: '#f0c040', fontSize: '11px' }}>📁</span>
        {isRenaming ? (
          <RenameInput
            initial={node.name}
            onCommit={(name) => onCommitFolderRename(node, name)}
            onCancel={onCancelFolderRename}
          />
        ) : (
          <>
            <span style={{ fontWeight: depth === 0 ? 'bold' : 'normal', color: '#ddd' }}>{node.name}</span>
            <span style={{ color: '#555', fontSize: '10px', marginLeft: 2 }}>({totalCount})</span>
          </>
        )}
      </div>
      {isExpanded && (
        <>
          {node.children.map((child) => (
            <FolderView
              key={child.path} node={child} depth={depth + 1}
              expanded={expanded} onToggle={onToggle} onToggleDeep={onToggleDeep}
              selectedSet={selectedSet} onSelect={onSelect}
              onDoubleClick={onDoubleClick} onContextMenu={onContextMenu} onFolderContextMenu={onFolderContextMenu}
              onEntityDrop={onEntityDrop} onFilesDrop={onFilesDrop} dropHighlight={dropHighlight} setDropHighlight={setDropHighlight}
              renamingPath={renamingPath} onCommitRename={onCommitRename} onCancelRename={onCancelRename}
              renamingFolderPath={renamingFolderPath} onCommitFolderRename={onCommitFolderRename} onCancelFolderRename={onCancelFolderRename}
              getDragPaths={getDragPaths}
              spritesByTexture={spritesByTexture}
            />
          ))}
          {node.files.map((a) => (
            <AssetRowWithSprites
              key={a.path} asset={a} depth={depth + 1}
              selected={selectedSet.has(a.path)}
              onSelect={onSelect}
              onDoubleClick={onDoubleClick}
              onContextMenu={onContextMenu}
              viewMode="folder"
              renaming={renamingPath === a.path}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              getDragPaths={getDragPaths}
              spritesByTexture={spritesByTexture}
              selectedSet={selectedSet}
              expandedSet={expanded}
              onToggleRow={onToggle}
            />
          ))}
        </>
      )}
    </>
  );
});

function countAll(node: FolderNode): number {
  return node.files.length + node.children.reduce((s, c) => s + countAll(c), 0);
}

// ─── Main component ──────────────────────────────────────────────────

type ViewMode = 'category' | 'folder';

const LS_VIEW_MODE = 'editor:assets:viewMode';
// v2: the top-level tree gained an "Assets" section header (ASSETS_SECTION key),
// so bump the key to seed it open by default over any older saved set.
const LS_EXPANDED = 'editor:assets:expanded:v2';
const LS_PENDING_FOLDERS = 'editor:assets:pendingFolders';
const LS_TYPE_FILTER = 'editor:assets:typeFilter';
const LS_CURRENT_FOLDER = 'editor:assets:currentFolder';

function loadStringSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === 'string')) : new Set();
  } catch { return new Set(); }
}

function loadViewMode(): ViewMode {
  try {
    const v = localStorage.getItem(LS_VIEW_MODE);
    return v === 'folder' ? 'folder' : 'category';
  } catch { return 'category'; }
}

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_EXPANDED);
    if (!raw) return new Set([ASSETS_SECTION]);
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === 'string')) : new Set([ASSETS_SECTION]);
  } catch { return new Set([ASSETS_SECTION]); }
}

export default function Assets() {
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  // Engine built-ins (/modoki/assets: white.hdr, icons, fonts, …) — kept OUT of
  // `assets` (so they don't bury the project's tree/categories/counts/auto-import)
  // and shown in their own read-only "Engine" section below the project tree.
  const [engineAssets, setEngineAssets] = useState<AssetEntry[]>([]);
  // Total source-script count, reported up by ScriptTree so the type filter can
  // offer a "script" chip (scripts aren't asset-manifest entries).
  const [scriptCount, setScriptCount] = useState(0);
  // Empty on-disk folders reported by the scanner (folders with no file assets in their
  // subtree) — merged into the tree below so externally-created empty dirs are visible.
  const [diskFolders, setDiskFolders] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  // `selected` = the active/lead item (drives the Inspector, scroll-to, and the
  // shift-range anchor). `selection` = the full multi-select set (highlighting,
  // batch ops). The active item is always a member of the selection.
  const [selected, setSelected] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  // Mirror of `selection` for the stable `getDragPaths` callback below — lets
  // AssetRow resolve its drag set at dragstart without depending on the live
  // selection Set (which would break its React.memo on every selection change).
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const anchorRef = useRef<string | null>(null); // shift-range anchor
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode);
  // Freshly-created empty folders (persisted) — the scanner only reports files,
  // so without this an empty folder vanishes from the tree on the next rescan.
  const [pendingFolders, setPendingFolders] = useState<Set<string>>(() => loadStringSet(LS_PENDING_FOLDERS));
  const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(null);
  // Active type filter — when non-empty, only assets whose `type` is in the set
  // are shown (the chips bar). Empty = show everything.
  const [typeFilter, setTypeFilter] = useState<Set<string>>(() => loadStringSet(LS_TYPE_FILTER));
  // Cut/copy clipboard + keyboard-nav helpers.
  const [clipboard, setClipboard] = useState<{ paths: string[]; op: 'copy' | 'cut' } | null>(null);
  const visiblePathsRef = useRef<string[]>([]);   // in-render-order asset paths
  const typeAheadRef = useRef<{ str: string; t: number }>({ str: '', t: 0 });
  // OS import: hidden file <input> + the folder a picker/drop targets.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importTargetRef = useRef<string>('/');
  // Auto-import-on-discovery: the last seen asset-path set (null until the first
  // scan, which is baseline-only — never bulk-import an existing project on open),
  // and a flag serializing import batches (importModel mutates the live world).
  const seenAssetPathsRef = useRef<Set<string> | null>(null);
  const autoImportingRef = useRef(false);

  // "Current folder" — the last folder the user interacted with (clicked a
  // folder row, or selected a file inside one). Imports, paste, and New Folder
  // default here so new content lands where the user is looking, instead of the
  // first asset root. Persisted so it survives editor restarts.
  const currentFolderRef = useRef<string | null>(
    (() => { try { return localStorage.getItem(LS_CURRENT_FOLDER); } catch { return null; } })(),
  );
  const setCurrentFolder = useCallback((path: string | null) => {
    currentFolderRef.current = path;
    try {
      if (path) localStorage.setItem(LS_CURRENT_FOLDER, path);
      else localStorage.removeItem(LS_CURRENT_FOLDER);
    } catch { /* ignore */ }
  }, []);
  // Resolve the default target folder for new content: the current folder when
  // it's under a writable asset root (this holds for freshly-created EMPTY
  // folders too — they have no assets but are valid targets; /api/write-file
  // creates the dir on demand), else the folder of the selected asset, else the
  // first writable asset root.
  const defaultTargetFolder = useCallback((): string => {
    const cur = currentFolderRef.current;
    if (cur && ASSET_ROOT_RE.test(cur)) return cur;
    if (selected) return splitAssetPath(selected).dir || '/';
    return firstFromEntries(assets) ?? '/';
  }, [assets, selected]);

  // Persist view mode + expanded + pending folders across sessions.
  useEffect(() => {
    try { localStorage.setItem(LS_VIEW_MODE, viewMode); } catch { /* ignore */ }
  }, [viewMode]);
  useEffect(() => {
    try { localStorage.setItem(LS_EXPANDED, JSON.stringify([...expanded])); } catch { /* ignore */ }
  }, [expanded]);
  useEffect(() => {
    try { localStorage.setItem(LS_PENDING_FOLDERS, JSON.stringify([...pendingFolders])); } catch { /* ignore */ }
  }, [pendingFolders]);
  useEffect(() => {
    try { localStorage.setItem(LS_TYPE_FILTER, JSON.stringify([...typeFilter])); } catch { /* ignore */ }
  }, [typeFilter]);
  const selectAsset = useEditorStore((s) => s.selectAsset);
  const setSelectedAssets = useEditorStore((s) => s.setSelectedAssets);
  const selectedAsset = useEditorStore((s) => s.selectedAsset);
  const assetsVersion = useEditorStore((s) => s.assetsVersion);
  const setImportStatus = useEditorStore((s) => s.setImportStatus);

  // Publish a MULTI-asset selection to the store so the Inspector can render a
  // batch editor. Single/none selection is already handled by the selectAsset()
  // calls in activate()/selectEngineAsset()/etc. (which set selectedAssets to
  // [asset] or []); we only need to upgrade to the array form when >1 is picked.
  useEffect(() => {
    if (selection.size <= 1) return;
    const byPath = new Map<string, AssetEntry>();
    for (const a of assets) byPath.set(a.path, a);
    for (const a of engineAssets) byPath.set(a.path, a);
    const list = [...selection]
      .map((p) => byPath.get(p))
      .filter((a): a is AssetEntry => !!a)
      .map((a) => ({ path: a.path, type: a.type, name: a.name }));
    if (list.length <= 1) return; // paths not yet resolvable to entries
    const primary = list.find((a) => a.path === selected) ?? null;
    setSelectedAssets(list, primary);
  }, [selection, assets, engineAssets, selected, setSelectedAssets]);

  const [loading, setLoading] = useState(false);
  // Confirmation gate for "Re-import all" — it reconverts every texture/model
  // under the asset roots and can take a while, so guard it behind a dialog.
  const [confirmReimportAll, setConfirmReimportAll] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    fetchAssets().then(({ assets: aRaw, folders }) => {
      // Fonts must load from the FULL scan (engine fonts live under /modoki/assets).
      loadAllFonts(aRaw);
      // Engine built-ins (/modoki/assets: fonts, favicon, icons, white.hdr, …) are
      // served + GUID-resolvable, but they are NOT this project's assets — keep them
      // out of the main panel (tree, categories, counts, auto-import) so 130+ engine
      // files don't bury the project. They render in a separate read-only "Engine"
      // section instead, and still resolve at runtime via the boot manifest.
      const a = aRaw.filter((x) => !x.path.startsWith('/modoki/'));
      // Sprites render nested under their texture, never as engine top-level rows.
      setEngineAssets(aRaw.filter((x) => x.path.startsWith('/modoki/') && x.type !== 'sprite'));
      // The FIRST completed scan is the auto-import baseline — set it here (the
      // authoritative "scan done" point) rather than in the effect, where the
      // initial empty `assets` would otherwise baseline as empty and make the
      // first real scan look like every asset was just added (bulk import on open).
      if (seenAssetPathsRef.current === null) seenAssetPathsRef.current = new Set(a.map((x) => x.path));
      setAssets(a);
      setDiskFolders(folders);
      // Reconcile the optimistic pendingFolders set against disk reality: drop any entry
      // the scan now covers (an empty folder it reported, or a folder implied by an asset
      // path / its ancestors) — compared CASE-INSENSITIVELY. Without this, a folder whose
      // on-disk case differs from the cached pending entry (e.g. disk "sprites" vs a stale
      // pending "Sprites") lingers as a phantom node that can't be renamed onto the real
      // one (the rename collides with the real folder's files). The scanner's folders +
      // asset paths are now the source of truth; pendingFolders only bridges the gap
      // before the first scan returns.
      setPendingFolders((prev) => {
        if (prev.size === 0) return prev;
        const real = new Set<string>();
        for (const f of folders) real.add(f.toLowerCase());
        for (const x of a) {
          let dir = x.path.substring(0, x.path.lastIndexOf('/'));
          while (dir) { real.add(dir.toLowerCase()); const i = dir.lastIndexOf('/'); dir = i > 0 ? dir.substring(0, i) : ''; }
        }
        const next = new Set<string>();
        for (const p of prev) if (!real.has(p.toLowerCase())) next.add(p);
        return next.size === prev.size ? prev : next;
      });
      setLoading(false);
    });
  }, []);

  useEffect(() => { refresh(); }, [refresh, assetsVersion]);

  // Derive the re-importable type set from the server registry once on mount, so
  // the per-row "Re-import" menu + recursive re-import count track what the server
  // can actually handle instead of a hardcoded client constant. (F9.)
  useEffect(() => { void refreshHandlerTypes(); }, []);

  // Sync local selection with store (e.g., when clicking an asset directly)
  useEffect(() => {
    // Store cleared the asset selection (e.g., user selected an entity) — drop local too
    if (!selectedAsset && selected !== null) {
      setSelected(null);
      setSelection(new Set());
      anchorRef.current = null;
      return;
    }
    if (selectedAsset && selectedAsset.path !== selected) {
      setSelected(selectedAsset.path);
      // External (single) selection — collapse the multi-select to just it.
      setSelection(new Set([selectedAsset.path]));
      anchorRef.current = selectedAsset.path;
      setExpanded((prev) => {
        const next = new Set(prev);
        // Category view: expand the asset's type group
        next.add(selectedAsset.type);
        // Folder view: expand all ancestor folders so the asset is visible
        const lastSlash = selectedAsset.path.lastIndexOf('/');
        if (lastSlash > 0) {
          const parts = selectedAsset.path.substring(0, lastSlash).split('/').filter(Boolean);
          for (let i = 1; i <= parts.length; i++) {
            next.add('/' + parts.slice(0, i).join('/'));
          }
        }
        next.add('/'); // root folder
        return next;
      });
      // Double rAF: wait for React to commit expanded state before scrolling
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = document.querySelector(`[data-asset-path="${CSS.escape(selectedAsset.path)}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }));
    }
  }, [selectedAsset, selected]);

  const toggle = useCallback((key: string) => {
    // Folder-view keys are '/'-prefixed paths; category-view keys are type-group
    // names. Clicking a folder row (expand OR collapse) makes it the current
    // folder so subsequent imports land there.
    if (key.startsWith('/')) setCurrentFolder(key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, [setCurrentFolder]);

  // Option/Alt-click on a folder (or the Assets header): expand or collapse the
  // WHOLE subtree. Direction keys off the node's own current state — expanded →
  // collapse all, collapsed → expand all. `extraKeys` lets the section header also
  // flip its own ASSETS_SECTION key alongside the folder paths.
  const toggleDeep = useCallback((node: FolderNode, extraKeys: string[] = []) => {
    setCurrentFolder(node.path);
    const paths = [...collectFolderPaths(node), ...extraKeys];
    // Direction anchors on the section key when present (the header's own open
    // state), else the clicked folder's own key: open → collapse all, else expand.
    const anchor = extraKeys.length > 0 ? extraKeys[0] : node.path;
    setExpanded((prev) => {
      const expand = !prev.has(anchor);
      const next = new Set(prev);
      for (const p of paths) { if (expand) next.add(p); else next.delete(p); }
      return next;
    });
  }, [setCurrentFolder]);

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; asset: AssetEntry } | null>(null);
  const [folderCtx, setFolderCtx] = useState<{ x: number; y: number; path: string; name: string } | null>(null);
  // Inline rename — path of the asset whose filename is currently editable
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  // Re-import: convert a single asset, or every asset under a folder (recursive),
  // dispatched per-type by the dev server. Textures and models have handlers.
  //
  // Iterate file-by-file on the client so the progress modal can name the file
  // currently being converted — makes hangs visible (the slow file is in the
  // bar) and gives a real step/total bar instead of an indeterminate animation.
  const reimport = useCallback(async (target: string, recursive: boolean) => {
    const targets = reimportTargets(assets, target, recursive);
    try {
      const summary = await reimportPaths(
        targets.map((a) => ({ path: a.path, type: a.type })),
        setImportStatus,
        `Re-importing ${target === '/' ? 'all assets' : target}…`,
      );
      if (!summary.errors.length) console.log('[Assets] Re-import:', summary);
    } finally {
      setImportStatus(false);
      refresh();
    }
  }, [assets, setImportStatus, refresh]);

  // Auto-import newly-discovered models/textures with default config (Unity-style
  // import-on-add): a freshly-dropped GLB becomes a prefab and a freshly-dropped
  // texture is converted, with no manual "Import Model" / "Re-import". Diffs the
  // current scan against the last seen set so ONLY assets that just appeared are
  // imported — never a bulk import of an existing project on open (the first scan
  // is baseline-only), never a re-import (a model is skipped once its sibling
  // prefab exists; a texture is seen-once). Import OUTPUTS (prefab/mesh/mat/
  // converted texture) that appear on the next scan aren't model/texture SOURCES,
  // so planAutoImports ignores them — no loop. The baseline is only advanced when
  // not mid-batch, so a rapid second drop during an import isn't dropped silently.
  useEffect(() => {
    const prev = seenAssetPathsRef.current;
    if (prev === null) return; // first scan not done yet — refresh() sets the baseline
    if (autoImportingRef.current) return; // a batch is running; re-diff after it finishes (don't advance the baseline, so nothing dropped during it is missed)
    const current = new Set(assets.map((a) => a.path));
    const added = assets.filter((a) => !prev.has(a.path));
    seenAssetPathsRef.current = current;
    if (added.length === 0) return;
    const { models, textures } = planAutoImports(added, current);
    if (models.length === 0 && textures.length === 0) return;
    autoImportingRef.current = true;
    void (async () => {
      try {
        // Order matters for the source→glb→prefab chain: a dropped FBX/OBJ/DAE
        // bakes to a GLB here, the GLB appears on the NEXT scan and imports to a
        // prefab then (each step is a separate diff). importModelWithMeta refreshes
        // when done; the resulting prefab/mesh/mat are not model/texture SOURCES,
        // and a model with a sibling prefab is skipped — so the chain converges and
        // never re-imports.
        for (const m of models) await importModelWithMeta(m.path, m.name, refresh);
        for (const t of textures) await reimport(t.path, false);
      } catch (e) {
        console.error('[Assets] auto-import failed:', e);
      } finally {
        autoImportingRef.current = false;
        // Re-scan so the effect re-evaluates against the NEW disk state. This both
        // (a) advances the source→glb→prefab chain one step — the freshly-written
        // glb/prefab appears on this scan and is picked up next — and (b) catches
        // anything dropped WHILE the batch held the busy flag (those scans bailed).
        // It terminates: chain outputs (prefab/mesh/mat) aren't import sources, so
        // the next pass finds nothing to do and stops without another re-scan.
        refresh();
      }
    })();
  }, [assets, reimport, refresh]);

  const handleFolderContextMenu = useCallback((e: React.MouseEvent, folderPath: string, folderName: string) => {
    e.preventDefault();
    e.stopPropagation();
    setFolderCtx({ x: e.clientX, y: e.clientY, path: folderPath, name: folderName });
  }, []);

  // Make `a` the active item and push it to the store (drives the Inspector).
  const activate = useCallback((a: AssetEntry) => {
    setSelected(a.path);
    selectAsset({ path: a.path, type: a.type, name: a.name });
    // Selecting a file makes its containing folder the current folder.
    setCurrentFolder(splitAssetPath(a.path).dir || '/');
  }, [selectAsset, setCurrentFolder]);

  // Selecting a read-only engine asset: surface it in the Inspector + highlight
  // it, WITHOUT touching the current-folder (imports must never target /modoki)
  // or the project shift-range anchor (engine rows aren't in visiblePaths).
  const selectEngineAsset = useCallback((a: AssetEntry) => {
    setSelected(a.path);
    setSelection(new Set([a.path]));
    anchorRef.current = a.path;
    selectAsset({ path: a.path, type: a.type, name: a.name });
  }, [selectAsset]);

  // Finder-style click selection: plain = replace, ⌘/Ctrl = toggle, Shift =
  // range from the anchor through the visible order.
  const handleSelect = useCallback((a: AssetEntry, e?: React.MouseEvent) => {
    const toggle = !!e && (e.metaKey || e.ctrlKey);
    const range = !!e && e.shiftKey;
    if (range && anchorRef.current) {
      // Shares rangeBetween with the Hierarchy panel (generic over item type).
      const span = rangeBetween(visiblePathsRef.current, anchorRef.current, a.path);
      setSelection(new Set(span ?? [a.path]));
    } else if (toggle) {
      setSelection((prev) => {
        const next = new Set(prev);
        if (next.has(a.path)) next.delete(a.path); else next.add(a.path);
        return next;
      });
      anchorRef.current = a.path;
    } else {
      setSelection(new Set([a.path]));
      anchorRef.current = a.path;
    }
    activate(a);
  }, [activate]);

  const handleDoubleClick = useCallback(async (a: AssetEntry) => {
    await openAssetInEditor({ path: a.path, type: a.type, name: a.name });
  }, []);

  /** Create a new `.anim.json` clip — native Save dialog picks the location — then open it. */
  const createAnimationClip = useCallback(async (folder?: string) => {
    const path = await saveAssetDialog({ defaultName: 'New Animation.anim.json', ext: '.anim.json', defaultFolder: folder, prompt: 'Create Animation Clip' });
    if (!path) return;
    const name = assetDisplayName(path, '.anim.json');
    const guid = newGuid();
    const ok = await writeFile(path, JSON.stringify(defaultAnimationClip(guid, name), null, 2));
    if (!ok) { console.error(`[Assets] Failed to write ${path}`); return; }
    registerAsset(guid, path, 'animation');
    refresh();
    // Open immediately, bound to the currently-selected Animator entity if any.
    const animMeta = getTraitByName('Animator');
    const sel = useEditorStore.getState().selectedEntityId;
    const ent = sel != null ? findEntity(sel) : null;
    const rootId = ent && animMeta && ent.has(animMeta.trait) ? sel : null;
    useEditorStore.getState().openAnimationEditor({ path, type: 'animation', name }, rootId);
  }, []);

  /** Create a new `.particle.json` effect — native Save dialog picks the location — then open it. */
  const createParticle = useCallback(async (folder?: string) => {
    const path = await saveAssetDialog({ defaultName: 'New Particle.particle.json', ext: '.particle.json', defaultFolder: folder, prompt: 'Create Particle Effect' });
    if (!path) return;
    const guid = newGuid();
    const def = { ...defaultParticleEffect(), id: guid };
    const ok = await writeFile(path, JSON.stringify(def, null, 2));
    if (!ok) { console.error(`[Assets] Failed to write ${path}`); return; }
    registerAsset(guid, path, 'particle');
    refresh();
    useEditorStore.getState().openParticleEditor({ path, type: 'particle', name: assetDisplayName(path, '.particle.json') });
  }, []);

  /** Create a new empty `.atlas.json` — native Save dialog picks the location, then
   *  select it so the Atlas inspector opens (add members + Pack there). */
  const createAtlas = useCallback(async (folder?: string) => {
    const path = await saveAssetDialog({ defaultName: 'New Atlas.atlas.json', ext: '.atlas.json', defaultFolder: folder, prompt: 'Create Sprite Atlas' });
    if (!path) return;
    const guid = newGuid();
    const def = { id: guid, version: 1, members: [], pageSize: 1024, padding: 2, extrude: 1 };
    const ok = await writeFile(path, JSON.stringify(def, null, 2));
    if (!ok) { console.error(`[Assets] Failed to write ${path}`); return; }
    registerAsset(guid, path, 'atlas');
    refresh();
    useEditorStore.getState().selectAsset({ path, type: 'atlas', name: assetDisplayName(path, '.atlas.json') });
  }, []);

  /** Create a new `.mat.json` material — native Save dialog picks the location —
   *  then select it so the Material inspector opens. */
  const createMaterial = useCallback(async (folder?: string) => {
    const path = await saveAssetDialog({ defaultName: 'New Material.mat.json', ext: '.mat.json', defaultFolder: folder, prompt: 'Create Material' });
    if (!path) return;
    const guid = newGuid();
    // `id` first so a fresh guid is stamped even though defaultMaterial() has no id.
    const def = { id: guid, ...(defaultAssetData('material') as Record<string, unknown>) };
    const ok = await writeFile(path, JSON.stringify(def, null, 2));
    if (!ok) { console.error(`[Assets] Failed to write ${path}`); return; }
    registerAsset(guid, path, 'material');
    refresh();
    useEditorStore.getState().selectAsset({ path, type: 'material', name: assetDisplayName(path, '.mat.json') });
  }, []);

  /** Create a new empty `.animset.json` — native Save dialog picks the location —
   *  then select it so the AnimSet inspector opens (add clips there). */
  const createAnimSet = useCallback(async (folder?: string) => {
    const path = await saveAssetDialog({ defaultName: 'New Animset.animset.json', ext: '.animset.json', defaultFolder: folder, prompt: 'Create Animset' });
    if (!path) return;
    const guid = newGuid();
    const def = { id: guid, clips: [] };
    const ok = await writeFile(path, JSON.stringify(def, null, 2));
    if (!ok) { console.error(`[Assets] Failed to write ${path}`); return; }
    registerAsset(guid, path, 'animset');
    refresh();
    useEditorStore.getState().selectAsset({ path, type: 'animset', name: assetDisplayName(path, '.animset.json') });
  }, []);

  /** Create a new `.spriteanim.json` (a named set of flipbook clips) — native Save
   *  dialog picks the location — then open it in the SpriteAnim Editor panel. */
  const createSpriteAnim = useCallback(async (folder?: string) => {
    const path = await saveAssetDialog({ defaultName: 'New Sprite Animation.spriteanim.json', ext: '.spriteanim.json', defaultFolder: folder, prompt: 'Create Sprite Animation' });
    if (!path) return;
    const guid = newGuid();
    const def = { id: guid, ...(defaultAssetData('spriteanim') as Record<string, unknown>) };
    const ok = await writeFile(path, JSON.stringify(def, null, 2));
    if (!ok) { console.error(`[Assets] Failed to write ${path}`); return; }
    registerAsset(guid, path, 'spriteanim');
    refresh();
    useEditorStore.getState().openSpriteAnimEditor({ path, type: 'spriteanim', name: assetDisplayName(path, '.spriteanim.json') });
  }, []);

  /** Create a new `.rig2d.json` (2D skinning rig) — native Save dialog picks the
   *  location — then open it in the Skin Editor panel. Seeds a single `root` bone +
   *  empty mesh (same minimal shape as the Skin Editor's own "New Rig"). */
  const createRig2D = useCallback(async (folder?: string) => {
    const path = await saveAssetDialog({ defaultName: 'New Rig.rig2d.json', ext: '.rig2d.json', defaultFolder: folder, prompt: 'Create 2D Rig' });
    if (!path) return;
    const guid = newGuid();
    const def = { id: guid, sprite: '', bones: [{ name: 'root', parent: -1, x: 0, y: 0, rot: 0 }], mesh: { verts: [], uvs: [], tris: [] }, skinIndices: [], skinWeights: [] };
    const ok = await writeFile(path, JSON.stringify(def, null, 2));
    if (!ok) { console.error(`[Assets] Failed to write ${path}`); return; }
    registerAsset(guid, path, 'rig2d');
    refresh();
    useEditorStore.getState().openSkinEditor({ path, type: 'rig2d', name: assetDisplayName(path, '.rig2d.json') });
  }, []);

  /** Create a new scene file (default content: Camera + white-HDR Environment, via
   *  newScene) at the chosen folder and switch to it. This replaces the old
   *  File → New Scene, persisted to disk. Dialog first so a cancel leaves the
   *  current world untouched. */
  const createScene = useCallback(async (folder?: string) => {
    const path = await saveAssetDialog({ defaultName: 'New Scene.json', ext: '.json', defaultFolder: folder ?? '/assets/scenes', prompt: 'Create Scene' });
    if (!path) return;
    newScene();
    useEditorStore.getState().selectEntity(null);
    setCurrentScenePath(path);
    await saveScene();
    refresh();
  }, [refresh]);

  const handleContextMenu = useCallback((e: React.MouseEvent, asset: AssetEntry) => {
    e.preventDefault();
    e.stopPropagation();
    // Sliced sprites have no file of their own — rename/delete/duplicate/move don't
    // apply (edit them in the texture's Sprite Editor), so skip the context menu.
    if (asset.type === 'sprite') { handleSelect(asset); return; }
    // Right-clicking inside an existing multi-selection keeps it (so context
    // actions apply to all); otherwise select just this row.
    if (!selection.has(asset.path)) handleSelect(asset);
    else activate(asset);
    setCtxMenu({ x: e.clientX, y: e.clientY, asset });
  }, [handleSelect, activate, selection]);

  // Do all the disk work + optimistic UI removal for ONE asset, returning a
  // descriptor (snapshots + generated set) so the caller can build undo/redo.
  // No pushAction, no refresh here — callers coalesce those so a batch delete is
  // a SINGLE undo entry and a SINGLE rescan, not one per file. Snapshot /
  // DeleteResult / DupResult + the undo builders live in assetUndo.ts (F6).

  // Gather everything ONE asset's delete must touch — the file, its sidecar, and
  // (for models) every generated mesh/material/texture + their sidecars — as
  //   (a) undo snapshots, so undo restores the FULL set (not just the GLB);
  //       otherwise a model delete + undo leaves every prefab/scene that
  //       referenced the generated meshes/materials dangling, because the stable
  //       guids lived inside JSON `id` fields and `.meta.json` sidecars the
  //       delete also removed.
  //   (b) a flat list of paths to trash.
  // Does NOT hit the trash backend or mutate UI — the caller aggregates across
  // the whole selection and fires a SINGLE trash request, so the OS plays one
  // trash sound, not one per file.
  const collectDeletion = useCallback(async (asset: AssetEntry): Promise<DeleteResult | null> => {
    const snapshots: Snapshot[] = [];
    const snapshot = async (filePath: string): Promise<void> => {
      try {
        const res = await fetch(filePath);
        if (!res.ok) return;
        if (isTextAsset(filePath)) {
          snapshots.push({ path: filePath, content: await res.text() });
        } else {
          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          snapshots.push({ path: filePath, content: btoa(bin), encoding: 'base64' });
        }
      } catch { /* unreachable read — leave it out of the undo set */ }
    };

    const deletePaths: string[] = [];
    // Snapshot a path for undo (if it exists) AND queue it for deletion. The
    // backend skips paths that no longer exist, so queuing a maybe-absent
    // sidecar is harmless.
    const mark = async (filePath: string): Promise<void> => {
      await snapshot(filePath);
      deletePaths.push(filePath);
    };

    // Primary asset first (so the undo restore order matches the original
    // existence order in case anything cares).
    await mark(asset.path);
    // The asset's sidecar (binary assets only — JSON assets carry their id
    // inline). It holds the asset's GUID + texture/model import settings, both
    // of which dangle if lost across a delete-undo. Previously this was
    // snapshotted for undo but NEVER trashed → an orphaned `.meta.json` was
    // left on disk after every binary/model delete; now it's trashed too.
    if (!isTextAsset(asset.path)) await mark(asset.path + '.meta.json');

    // For model assets: also remove every generated mesh.json / mat.json /
    // texture (plus the textures' sidecars), snapshotting each for undo.
    if (asset.type === 'model') {
      try {
        const metaRes = await backendFetch(`/api/read-meta?path=${encodeURIComponent(asset.path)}`);
        if (metaRes.ok) {
          const meta = await metaRes.json();
          const generated = meta.generated || {};
          const generatedFiles: string[] = [...(generated.meshes || []), ...(generated.materials || []), ...(generated.textures || [])];
          for (const f of generatedFiles) {
            await mark(f);
            // Texture sidecars carry the texture's stable guid + import settings.
            if (!isTextAsset(f)) await mark(f + '.meta.json');
          }
          if (generatedFiles.length > 0) console.log(`[Assets] Will clean up ${generatedFiles.length} generated files for ${asset.name}`);
        }
      } catch { /* no meta or read failed — proceed with the bare model delete */ }
    }

    return { asset, snapshots, deletePaths };
  }, []);

  // Build + push a single coalesced undo/redo for one or more completed
  // deletes (builder in assetUndo.ts — F6).
  const pushDeleteUndo = useCallback((results: DeleteResult[]) => {
    pushAction(makeDeleteUndo(results, refresh));
  }, [refresh]);

  // Delete one or more assets in a SINGLE OS-trash call (one trash sound),
  // coalesced into ONE undo entry (and, for batch, ONE rescan). `rescan` mirrors
  // the original split: the single context-menu delete relies on the optimistic
  // row removal below (no rescan), the batch path rescans to reconcile generated
  // files the optimistic pass doesn't enumerate.
  const executeDeletion = useCallback(async (targets: AssetEntry[], rescan: boolean) => {
    if (targets.length === 0) return;
    const results: DeleteResult[] = [];
    for (const a of targets) { const r = await collectDeletion(a); if (r) results.push(r); }
    if (results.length === 0) return;
    const allPaths = Array.from(new Set(results.flatMap((r) => r.deletePaths)));
    const ok = await deleteAssets(allPaths);
    if (!ok) { console.error('[Assets] Delete failed'); return; }
    const removed = new Set(results.map((r) => r.asset.path));
    setAssets((prev) => prev.filter((a) => !removed.has(a.path)));
    if (selected && removed.has(selected)) { setSelected(null); selectAsset(null); }
    console.log(`[Assets] Moved ${allPaths.length} file(s) to trash`);
    pushDeleteUndo(results); // ONE undo entry for the whole gesture
    if (rescan) refresh();   // ONE rescan, not one per file
  }, [collectDeletion, pushDeleteUndo, refresh, selected, selectAsset]);

  const handleDelete = useCallback(async (asset: AssetEntry) => {
    await executeDeletion([asset], false);
  }, [executeDeletion]);

  // Do the disk work for ONE duplicate, returning a descriptor. No refresh /
  // pushAction (callers coalesce). `taken` is threaded so a batch duplicate
  // can't pick the same target path twice. (DupResult in assetUndo.ts — F6.)
  const performDuplicate = useCallback(async (asset: AssetEntry, taken: Set<string>): Promise<DupResult | null> => {
    const toPath = duplicatePathFor(asset.path, taken);
    const ok = await duplicateAsset(asset.path, toPath);
    if (!ok) { console.error(`[Assets] Failed to duplicate ${asset.path}`); return null; }
    taken.add(toPath);
    console.log(`[Assets] Duplicated ${asset.path} → ${toPath}`);
    return { asset, toPath };
  }, []);

  // Build + push the coalesced duplicate undo (builder in assetUndo.ts — F6).
  const pushDuplicateUndo = useCallback((results: DupResult[]) => {
    pushAction(makeDuplicateUndo(results, refresh));
  }, [refresh]);

  const handleDuplicate = useCallback(async (asset: AssetEntry) => {
    const r = await performDuplicate(asset, new Set(assets.map((a) => a.path)));
    if (!r) return;
    refresh();
    pushDuplicateUndo([r]);
  }, [assets, performDuplicate, pushDuplicateUndo, refresh]);

  // Rename an asset's file (keeps its folder + compound extension). The backend
  // moves the .meta.json sidecar alongside it, so the asset's GUID + import
  // settings survive — only the on-disk filename changes.
  const handleRename = useCallback(async (asset: AssetEntry, newBase: string) => {
    const { dir, base, ext } = splitAssetPath(asset.path);
    const safe = newBase.trim().replace(/[/\\]/g, '_');
    if (!safe || safe === base) return;
    const toPath = `${dir}/${safe}${ext}`;
    if (assets.some((a) => a.path === toPath)) { console.warn(`[Assets] Rename target exists: ${toPath}`); return; }
    const ok = await moveFileTo(asset.path, toPath);
    if (!ok) { console.error(`[Assets] Failed to rename ${asset.path}`); return; }
    console.log(`[Assets] Renamed ${asset.path} → ${toPath}`);
    if (selected === asset.path) { setSelected(toPath); selectAsset({ path: toPath, type: asset.type, name: safe }); }
    refresh();

    pushAction({
      label: `Rename ${asset.name}`,
      undo: async () => { await moveFileTo(toPath, asset.path); refresh(); },
      redo: async () => { await moveFileTo(asset.path, toPath); refresh(); },
    });
  }, [assets, selected, selectAsset, refresh]);

  const commitRename = useCallback((asset: AssetEntry, newBase: string) => {
    setRenamingPath(null);
    handleRename(asset, newBase);
  }, [handleRename]);

  const cancelRename = useCallback(() => setRenamingPath(null), []);
  const onCancelFolderRename = useCallback(() => setRenamingFolderPath(null), []);

  // The drag set for a row, resolved lazily at dragstart from the live selection
  // (via the ref) so AssetRow needn't take the selection Set as a prop. The whole
  // selection when this row is part of a multi-select, otherwise just this asset.
  const getDragPaths = useCallback((asset: AssetEntry): string[] => {
    const sel = selectionRef.current;
    return sel.has(asset.path) && sel.size > 1 ? [...sel] : [asset.path];
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(new Set());
    setSelected(null);
    selectAsset(null);
    anchorRef.current = null;
  }, [selectAsset]);

  // Delete a folder (to the OS trash) along with everything under it. Asset files in
  // the subtree are snapshotted first so the delete is undoable (their restore recreates
  // the dirs); an empty folder gets a simple recreate-on-undo. One trash call.
  const handleDeleteFolder = useCallback(async (folderPath: string, folderName: string) => {
    if (folderPath === '/') return;
    const inside = assets.filter((a) => a.path === folderPath || a.path.startsWith(folderPath + '/'));
    const results: DeleteResult[] = [];
    for (const a of inside) { const r = await collectDeletion(a); if (r) results.push(r); }
    const ok = await deleteAsset(folderPath); // trashes files + the dir shell in one call
    if (!ok) { console.error(`[Assets] Failed to delete folder ${folderPath}`); return; }
    // Prune any client-side folder state for this subtree.
    const prune = (set: Set<string>) => {
      const n = new Set<string>();
      for (const x of set) if (x !== folderPath && !x.startsWith(folderPath + '/')) n.add(x);
      return n;
    };
    setPendingFolders(prune);
    setExpanded(prune);
    setDiskFolders((prev) => prev.filter((x) => x !== folderPath && !x.startsWith(folderPath + '/')));
    clearSelection();
    refresh();
    if (results.length > 0) {
      pushDeleteUndo(results); // restoring the files recreates the folder
    } else {
      pushAction({
        label: `Delete folder ${folderName}`,
        undo: async () => { await createFolderApi(folderPath); refresh(); },
        redo: async () => { await deleteAsset(folderPath); refresh(); },
      });
    }
  }, [assets, collectDeletion, pushDeleteUndo, clearSelection, refresh]);

  // The AssetEntry objects currently selected (falls back to the active item).
  const selectedAssets = useCallback((): AssetEntry[] => {
    const inSel = assets.filter((a) => selection.has(a.path));
    if (inSel.length) return inSel;
    const a = assets.find((x) => x.path === selected);
    return a ? [a] : [];
  }, [assets, selection, selected]);

  const deleteSelection = useCallback(async () => {
    // ONE trash call → one trash sound; ONE undo entry; ONE rescan.
    await executeDeletion(selectedAssets(), true);
  }, [selectedAssets, executeDeletion]);

  const duplicateSelection = useCallback(async () => {
    const targets = selectedAssets();
    if (targets.length === 0) return;
    const taken = new Set(assets.map((a) => a.path)); // grows as we go so targets stay unique
    const results: DupResult[] = [];
    for (const a of targets) { const r = await performDuplicate(a, taken); if (r) results.push(r); }
    if (results.length === 0) return;
    pushDuplicateUndo(results);
    refresh();
  }, [selectedAssets, assets, performDuplicate, pushDuplicateUndo, refresh]);

  // ── Cut / Copy / Paste ──────────────────────────────────────────────
  const copySelection = useCallback((op: 'copy' | 'cut') => {
    const paths = selectedAssets().map((a) => a.path);
    if (paths.length) setClipboard({ paths, op });
  }, [selectedAssets]);

  const pasteClipboard = useCallback(async (targetOverride?: string) => {
    if (!clipboard || clipboard.paths.length === 0) return;
    // Paste into the given folder, else the active item's folder (Finder pastes
    // into the current location), else the root.
    const targetFolder = targetOverride ?? defaultTargetFolder();
    const taken = new Set(assets.map((a) => a.path));
    const done: { from: string; to: string }[] = [];
    for (const from of clipboard.paths) {
      const to = pastePathIn(targetFolder, from, taken);
      if (to === from) continue; // cut into same folder — no-op
      taken.add(to);
      const ok = clipboard.op === 'cut' ? await moveFileTo(from, to) : await duplicateAsset(from, to);
      if (ok) done.push({ from, to });
    }
    if (done.length === 0) return;
    const op = clipboard.op;
    if (op === 'cut') setClipboard(null);
    refresh();
    pushAction({
      label: `${op === 'cut' ? 'Move' : 'Paste'} ${done.length} item(s)`,
      undo: async () => {
        for (const { from, to } of done) {
          if (op === 'cut') await moveFileTo(to, from);
          else { await deleteAsset(to); if (!isTextAsset(to)) await deleteAsset(to + '.meta.json'); }
        }
        refresh();
      },
      redo: async () => {
        for (const { from, to } of done) {
          if (op === 'cut') await moveFileTo(from, to);
          else await duplicateAsset(from, to);
        }
        refresh();
      },
    });
  }, [clipboard, selected, assets, refresh]);

  // ── New Folder + folder rename ──────────────────────────────────────
  const createFolder = useCallback(async (parentFolder: string) => {
    const norm = parentFolder === '/' ? '' : parentFolder;
    const isTaken = (p: string) => pendingFolders.has(p) || diskFolders.includes(p) || assets.some((a) => a.path === p || a.path.startsWith(p + '/'));
    let name = 'New Folder';
    let path = `${norm}/${name}`;
    let n = 2;
    while (isTaken(path)) { name = `New Folder ${n}`; path = `${norm}/${name}`; n++; }
    const ok = await createFolderApi(path);
    if (!ok) { console.error(`[Assets] Failed to create folder under ${parentFolder}`); return; }
    setPendingFolders((prev) => new Set(prev).add(path));
    // Expand the WHOLE ancestor chain down to the new folder's parent — not just
    // the immediate parent — so a folder created in a deep target (e.g.
    // /games/x/assets) actually renders instead of staying buried inside collapsed
    // ancestors. Without this the Finder-style "create → rename inline" input never
    // mounts when the target folder's ancestors aren't already open.
    setExpanded((prev) => {
      const next = new Set(prev).add('/');
      let acc = '';
      for (const part of parentFolder.split('/').filter(Boolean)) { acc += `/${part}`; next.add(acc); }
      return next;
    });
    setViewMode('folder');
    setRenamingFolderPath(path); // immediately editable, Finder-style
    pushAction({
      label: 'New Folder',
      undo: async () => {
        await deleteAsset(path);
        setPendingFolders((p) => { const n2 = new Set(p); n2.delete(path); return n2; });
        refresh();
      },
      redo: async () => {
        await createFolderApi(path);
        setPendingFolders((p) => new Set(p).add(path));
        refresh();
      },
    });
  }, [assets, pendingFolders, diskFolders, refresh]);

  const commitFolderRename = useCallback(async (node: FolderNode, newName: string) => {
    setRenamingFolderPath(null);
    const safe = newName.trim().replace(/[/\\]/g, '_');
    const parts = node.path.split('/').filter(Boolean);
    if (!safe || safe === parts[parts.length - 1]) return;
    const parent = '/' + parts.slice(0, -1).join('/');
    const newPath = (parent === '/' ? '' : parent) + '/' + safe;
    if (pendingFolders.has(newPath) || diskFolders.includes(newPath) || assets.some((a) => a.path === newPath || a.path.startsWith(newPath + '/'))) {
      console.warn(`[Assets] Folder already exists: ${newPath}`); return;
    }
    const ok = await moveFileTo(node.path, newPath);
    if (!ok) { console.error(`[Assets] Failed to rename folder ${node.path}`); return; }
    const oldPath = node.path;
    setPendingFolders((p) => remapPrefix(p, oldPath, newPath));
    setExpanded((p) => remapPrefix(p, oldPath, newPath).add(newPath));
    clearSelection();
    refresh();
    pushAction({
      label: `Rename folder ${node.name}`,
      undo: async () => { await moveFileTo(newPath, oldPath); setPendingFolders((p) => remapPrefix(p, newPath, oldPath)); refresh(); },
      redo: async () => { await moveFileTo(oldPath, newPath); setPendingFolders((p) => remapPrefix(p, oldPath, newPath)); refresh(); },
    });
  }, [assets, pendingFolders, diskFolders, clearSelection, refresh]);

  // Smooth-scroll a path's row into view (after the tree commits).
  const scrollToPath = useCallback((p: string) => {
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-asset-path="${CSS.escape(p)}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }, []);

  // Keyboard handling is scoped to the (focusable) asset list container, so it
  // only fires when the Assets panel is the active pane — no global listener
  // that would clash with the Hierarchy's Cmd+D / Delete / F2.
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // e.g. inline rename field
    const isMac = navigator.platform.includes('Mac');
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const order = visiblePathsRef.current;
    const find = (p: string | null) => assets.find((x) => x.path === p);
    // Claim the key so the Hierarchy's document-level Cmd+D/Delete/F2 listeners
    // don't ALSO fire while the Assets pane is focused. Non-handled keys (e.g.
    // Cmd+Z undo) fall through to global listeners untouched.
    const stop = () => { e.preventDefault(); e.stopPropagation(); };

    if (mod && e.shiftKey && (e.key === 'n' || e.key === 'N')) {
      stop();
      createFolder(defaultTargetFolder());
      return;
    }
    if (mod && (e.key === 'a' || e.key === 'A')) { stop(); setSelection(new Set(order)); return; }
    if (mod && (e.key === 'c' || e.key === 'C')) { stop(); copySelection('copy'); return; }
    if (mod && (e.key === 'x' || e.key === 'X')) { stop(); copySelection('cut'); return; }
    if (mod && (e.key === 'v' || e.key === 'V')) { stop(); pasteClipboard(); return; }
    if (mod && (e.key === 'd' || e.key === 'D')) { stop(); duplicateSelection(); return; }
    if (e.key === 'F2') { stop(); if (selected) setRenamingPath(selected); return; }
    const isDelete = isMac ? (e.key === 'Backspace' && e.metaKey) : e.key === 'Delete';
    if (isDelete) { stop(); deleteSelection(); return; }
    if (e.key === 'Enter') { stop(); const a = find(selected); if (a) handleDoubleClick(a); return; }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      stop();
      if (order.length === 0) return;
      const idx = selected ? order.indexOf(selected) : -1;
      const ni = e.key === 'ArrowDown'
        ? (idx < 0 ? 0 : Math.min(order.length - 1, idx + 1))
        : (idx < 0 ? 0 : Math.max(0, idx - 1));
      const np = order[ni];
      const a = find(np);
      if (!a) return;
      if (e.shiftKey && anchorRef.current) {
        const i0 = order.indexOf(anchorRef.current);
        if (i0 >= 0) { const [lo, hi] = i0 <= ni ? [i0, ni] : [ni, i0]; setSelection(new Set(order.slice(lo, hi + 1))); }
      } else {
        setSelection(new Set([np])); anchorRef.current = np;
      }
      activate(a); scrollToPath(np);
      return;
    }

    // Type-ahead: jump to the first visible item whose name starts with the
    // recently-typed string (resets after 700ms of no typing).
    if (e.key.length === 1 && !mod && !e.altKey) {
      const now = performance.now();
      const ta = typeAheadRef.current;
      if (now - ta.t > 700) ta.str = '';
      ta.str += e.key.toLowerCase();
      ta.t = now;
      const match = order.find((p) => {
        const a = assets.find((x) => x.path === p);
        return !!a && (a.name.toLowerCase().startsWith(ta.str) || splitAssetPath(p).base.toLowerCase().startsWith(ta.str));
      });
      if (match) {
        const a = assets.find((x) => x.path === match)!;
        setSelection(new Set([match])); anchorRef.current = match; activate(a); scrollToPath(match);
      }
    }
  }, [selected, assets, createFolder, copySelection, pasteClipboard, duplicateSelection, deleteSelection, handleDoubleClick, activate, scrollToPath]);

  const ctxMenuItems = useCallback((asset: AssetEntry): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    // Number of items the action will apply to (the menu was opened on a row
    // inside the current multi-selection ⇒ act on the whole selection).
    const count = selection.has(asset.path) ? Math.max(1, selection.size) : 1;
    const many = count > 1;
    const suffix = many ? ` (${count})` : '';
    if (!many && asset.type === 'prefab') {
      items.push({ label: 'Instantiate', onClick: () => instantiatePrefabFromPath(asset.path, asset.name) });
    }
    if (!many && asset.type === 'model') {
      // Models have their own "Import Model" flow (instantiate + prefab), distinct
      // from the generic convert-in-place re-import below.
      items.push({ label: 'Import Model', onClick: () => importModelWithMeta(asset.path, asset.name, refresh) });
    } else if (!many && HANDLER_TYPES.has(asset.type)) {
      // Any other server-handled type (texture today, e.g. audio if a handler is
      // registered) gets a generic in-place re-import. Derived from the server
      // registry, not a hardcoded type, so client/server can't drift. (F9.)
      items.push({ label: 'Re-import', onClick: () => reimport(asset.path, false) });
    }
    if (!many) items.push({ label: 'Rename', onClick: () => setRenamingPath(asset.path) });
    items.push({ label: `Duplicate${suffix}`, onClick: () => (many ? duplicateSelection() : handleDuplicate(asset)) });
    items.push({ label: `Copy${suffix}`, onClick: () => copySelection('copy') });
    items.push({ label: `Cut${suffix}`, onClick: () => copySelection('cut') });
    if (clipboard) items.push({ label: `Paste${clipboard.paths.length > 1 ? ` (${clipboard.paths.length})` : ''}`, onClick: () => pasteClipboard() });
    if (!many) items.push({ label: 'Copy Path', onClick: () => navigator.clipboard.writeText(asset.path) });
    items.push({ label: 'Reveal in Finder', onClick: () => backendFetch('/api/reveal-in-finder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: asset.path }),
    }) });
    items.push({ label: `Move to Trash${suffix}`, onClick: () => (many ? deleteSelection() : handleDelete(asset)), danger: true });
    return items;
  }, [handleDelete, handleDuplicate, refresh, reimport, selection, clipboard, duplicateSelection, deleteSelection, copySelection, pasteClipboard]);

  // Drop handler: entity dragged from Hierarchy → create prefab
  const [dropHighlight, setDropHighlight] = useState<string | null>(null); // folder path being hovered

  // Import files from the OS (file picker or drag-in from Finder) into a folder.
  // Bytes are read as base64 and written via /api/write-file; freshly-imported
  // textures/models are run through the conversion pipeline. Collisions get a
  // " copy" suffix (never silently overwrite). One batch = one undo entry.
  const importFiles = useCallback(async (files: FileList | File[], targetFolder: string) => {
    const list = Array.from(files);
    if (!list.length) return;
    // "/" and intermediate nodes aren't writable — fall back to the first real root.
    const target = ASSET_ROOT_RE.test(targetFolder) ? targetFolder : firstFromEntries(assets);
    if (!target) { console.error('[Assets] No writable asset root to import into'); return; }
    // Plan collision-free dest paths (+ which trigger conversion) up front —
    // shared, unit-tested policy (planImports in assetOps).
    const taken = new Set(assets.map((a) => a.path));
    const plan = planImports(list.map((f) => f.name), target, taken);
    const imported: { path: string; content: string; convert: boolean }[] = [];
    setImportStatus(true, `Importing ${list.length} file(s)…`, 0, list.length);
    try {
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        const { dest, convert } = plan[i];
        setImportStatus(true, file.name, i, list.length);
        const content = await fileToBase64(file);
        const ok = await writeFile(dest, content, 'base64');
        if (!ok) { console.error(`[Assets] Failed to import ${file.name}`); continue; }
        imported.push({ path: dest, content, convert });
        setImportStatus(true, file.name, i + 1, list.length);
      }
    } finally {
      setImportStatus(false);
    }
    if (!imported.length) return;
    console.log(`[Assets] Imported ${imported.length} file(s) → ${target}`);
    // Convert any freshly-imported textures/models through the asset pipeline.
    for (const f of imported) {
      if (f.convert) {
        await backendFetch('/api/reimport', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: f.path, recursive: false }),
        }).catch(() => {});
      }
    }
    refresh();
    pushAction({
      label: imported.length > 1 ? `Import ${imported.length} files` : `Import "${imported[0].path.split('/').pop()}"`,
      undo: async () => { for (const f of imported) await deleteAsset(f.path); refresh(); },
      redo: async () => { for (const f of imported) await writeFile(f.path, f.content, 'base64'); refresh(); },
    });
  }, [assets, refresh, setImportStatus]);

  const handleDrop = useCallback(async (e: React.DragEvent, targetFolder?: string) => {
    e.preventDefault();
    setDropHighlight(null);
    // Files dragged in from the OS (Finder/desktop) — import into the target.
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      await importFiles(e.dataTransfer.files, targetFolder ?? '/');
      return;
    }
    const raw = e.dataTransfer.getData('application/editor-entity');
    if (!raw) return;
    const { id, name } = JSON.parse(raw) as { id: number; name: string };

    // Determine save path — the drop-target folder (or /prefabs as a fallback).
    // Everything else (serialize → write → register/cache/tag → undo descriptor)
    // is shared with the Hierarchy "Create Prefab" flow via createPrefabFromEntity
    // (F7); only the asset-panel refresh() is layered on here.
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const savePath = targetFolder
      ? `${targetFolder}/${safeName}.prefab.json`
      : `/prefabs/${safeName}.prefab.json`;

    const result = await createPrefabFromEntity(id, savePath, `Save prefab "${name}"`);
    if (!result) { console.error(`[Assets] Failed to create prefab ${savePath}`); return; }
    console.log(`[Assets] Created prefab: ${savePath}`);
    refresh();

    const { action } = result;
    pushAction({
      label: action.label,
      undo: async () => { await action.undo(); refresh(); },
      redo: async () => { await action.redo(); refresh(); },
    });
  }, [refresh, importFiles]);

  // File move handler: drag one or many assets (a multi-selection) between
  // folders. Illegal/no-op drops (onto its own folder, itself, or a subfolder)
  // are skipped silently — they're mis-drops, not errors. Successful moves are
  // bundled into a single undo entry.
  const handleFilesDrop = useCallback(async (filePaths: string[], targetFolder: string) => {
    const normalizedTarget = targetFolder === '/' ? '' : targetFolder;
    const moves: { from: string; to: string; originalFolder: string }[] = [];
    for (const filePath of filePaths) {
      const originalFolder = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
      if (targetFolder === originalFolder || targetFolder === filePath || targetFolder.startsWith(filePath + '/')) continue;
      const ok = await moveFile(filePath, targetFolder);
      if (!ok) { console.warn(`[Assets] Could not move ${filePath} → ${targetFolder}`); continue; }
      const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
      moves.push({ from: filePath, to: `${normalizedTarget}/${fileName}`, originalFolder });
    }
    if (moves.length === 0) return;
    console.log(`[Assets] Moved ${moves.length} item(s) → ${targetFolder}`);
    refresh();

    pushAction({
      label: moves.length > 1 ? `Move ${moves.length} items` : `Move "${moves[0].from.split('/').pop()}"`,
      undo: async () => { for (const m of moves) await moveFile(m.to, m.originalFolder); refresh(); },
      redo: async () => { for (const m of moves) await moveFile(m.from, targetFolder); refresh(); },
    });
  }, [refresh]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/editor-entity') || e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  // Available types for the filter menu — derived from ALL shown items (project +
  // engine assets), plus a synthetic "script" entry (scripts aren't asset-manifest
  // entries, so their count is reported up from ScriptTree). Not the filtered set,
  // so toggling never makes an option vanish.
  const availableTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of assets) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
    for (const a of engineAssets) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
    if (scriptCount > 0) counts.set('script', scriptCount);
    // Canonical order (shared with the category/list view) so the two never drift.
    return [...counts.entries()].sort((x, y) => compareAssetTypes(x[0], y[0]));
  }, [assets, engineAssets, scriptCount]);

  // A type filter gates every section, not just the project tree: scripts show
  // when no filter is active OR 'script' is selected; engine assets are narrowed
  // to the selected types (the section hides itself when nothing matches).
  const showScripts = typeFilter.size === 0 || typeFilter.has('script');
  const engineFiltered = useMemo(
    () => (typeFilter.size === 0 ? engineAssets : engineAssets.filter((a) => typeFilter.has(a.type))),
    [engineAssets, typeFilter],
  );

  const toggleTypeFilter = useCallback((type: string) => {
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  }, []);

  // Sliced sprites are nested UNDER their source texture (Unity-style sub-assets),
  // not shown as standalone rows — index them by parent texture GUID.
  const spritesByTexture = useMemo(() => {
    const m = new Map<string, AssetEntry[]>();
    for (const a of assets) {
      if (a.type !== 'sprite' || !a.sprite?.texture) continue;
      const arr = m.get(a.sprite.texture); if (arr) arr.push(a); else m.set(a.sprite.texture, [a]);
    }
    return m;
  }, [assets]);

  // Filtered assets — search text AND (when any chip is active) the type filter.
  // Sprites are always excluded from the flat lists (they render as texture children).
  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    const hasType = typeFilter.size > 0;
    return assets.filter((a) => {
      if (a.type === 'sprite') return false;
      if (hasType && !typeFilter.has(a.type)) return false;
      if (q && !a.name.toLowerCase().includes(q) && !a.path.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [assets, filter, typeFilter]);

  // Total assets that CAN appear in the flat list. Sliced sprites are nested under
  // their source texture (never listed standalone), so they're excluded here too —
  // otherwise the footer compares `filtered` (no sprites) against a sprite-inflated
  // `assets.length` and is stuck on "N of M assets" forever once any texture is sliced.
  const flatTotal = useMemo(() => assets.reduce((n, a) => n + (a.type === 'sprite' ? 0 : 1), 0), [assets]);

  // Category view: group by type, ordered by the shared canonical type order (so
  // the section order matches the type-filter menu). A Map preserves insertion
  // order, so inserting sorted keys makes both the render and visiblePaths (which
  // iterate `grouped`) walk the sections in canonical order.
  const grouped = useMemo(() => {
    const m = new Map<string, AssetEntry[]>();
    for (const a of filtered) {
      if (!m.has(a.type)) m.set(a.type, []);
      m.get(a.type)!.push(a);
    }
    return new Map([...m.entries()].sort((x, y) => compareAssetTypes(x[0], y[0])));
  }, [filtered]);

  // Folder view: build tree (seeded with empty pending folders)
  const folderTree = useMemo(() => buildFolderTree(filtered, [...pendingFolders, ...diskFolders]), [filtered, pendingFolders, diskFolders]);
  // The node the "Assets" section renders from — redundant single-folder wrappers
  // collapsed away (see effectiveAssetsRoot). Its children are the category folders.
  const assetsRoot = useMemo(() => effectiveAssetsRoot(folderTree), [folderTree]);

  // Visible asset paths in on-screen order — drives shift-range + arrow-key
  // navigation and Cmd+A. Mirrors the render: category groups in insertion
  // order (only expanded ones), or a DFS of the folder tree (children before
  // files, only under expanded nodes).
  const visiblePaths = useMemo(() => {
    const out: string[] = [];
    if (viewMode === 'category') {
      for (const [type, items] of grouped) {
        if (expanded.has(type)) for (const a of items) out.push(a.path);
      }
    } else if (expanded.has(ASSETS_SECTION)) {
      // The "Assets" section header sits above the tree; its children render at
      // depth 1, so nav walks the collapsed root's children/files directly.
      const walk = (node: FolderNode) => {
        if (!expanded.has(node.path)) return;
        for (const c of node.children) walk(c);
        for (const f of node.files) out.push(f.path);
      };
      for (const c of assetsRoot.children) walk(c);
      for (const f of assetsRoot.files) out.push(f.path);
    }
    return out;
  }, [viewMode, grouped, assetsRoot, expanded]);
  useEffect(() => { visiblePathsRef.current = visiblePaths; }, [visiblePaths]);

  return (
    <div style={{ width: '100%', height: '100%', background: '#252536', color: '#ccc', fontFamily: 'monospace', fontSize: '11px', display: 'flex', flexDirection: 'column' }}>
      {/* Header — flex-wraps so the action buttons flow onto a second row on
          narrow widths instead of being clipped. The buttons are INDIVIDUAL flex
          children (not one rigid group) so they keep wrapping even when the panel
          is narrower than the whole button strip. minWidth:0 lets the header
          shrink to the panel width so wrapping actually engages. */}
      <div style={{ minWidth: 0, minHeight: 32, padding: '4px 8px', borderBottom: '1px solid #333', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <span style={{ fontWeight: 'bold', color: '#f1c40f', fontSize: '13px' }}>Assets</span>
        <TreeSearchInput value={filter} onChange={setFilter} uiId="assets.toolbar.search" />
        {/* Hidden OS file picker for Import */}
        <input
          ref={fileInputRef} type="file" multiple data-import-input
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length) importFiles(files, importTargetRef.current);
            e.target.value = ''; // allow re-importing the same file
          }}
        />
        {/* Action buttons — INDIVIDUAL flex children of the wrapping header (no
            rigid wrapper), grouped by function (view · create · scan) with a thin
            divider between groups. Order: View toggle first, then create/add, then
            scan/convert (Re-import last — heavy, behind a confirm). */}
        {/* — View toggle (leftmost) — */}
        <button
          onClick={() => setViewMode(viewMode === 'category' ? 'folder' : 'category')}
          title={viewMode === 'category' ? 'Switch to folder view' : 'Switch to category view'}
          data-ui-id="assets.toolbar.viewToggle" data-ui-kind="toggle" data-ui-label="view mode"
          style={toolbarBtnStyle}
        >
          {viewMode === 'category' ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ display: 'block' }}>
              <path d="M1 2h6l2 2h6v10H1V2zm1 1v10h12V5H8.5L6.5 3H2z"/>
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ display: 'block' }}>
              <path d="M0 2h4v4H0V2zm6 0h10v2H6V2zm-6 5h4v4H0V7zm6 0h10v2H6V7zm-6 5h4v4H0v-4zm6 0h10v2H6v-2z"/>
            </svg>
          )}
        </button>
        {availableTypes.length > 1 && (
          <TypeFilterMenu
            types={availableTypes}
            selected={typeFilter}
            onToggle={toggleTypeFilter}
            onClear={() => setTypeFilter(new Set())}
          />
        )}
        <div style={toolbarDividerStyle} />
        {/* — Create / add: New Folder, Import. (Create Animation/Particle/Atlas
            live in the folder + Assets-header right-click menu, not the toolbar.) — */}
        <button
          onClick={() => createFolder(defaultTargetFolder())}
          title="New Folder (⇧⌘N)"
          data-ui-id="assets.toolbar.newFolder" data-ui-kind="button" data-ui-label="new folder"
          style={toolbarBtnStyle}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ display: 'block' }}>
            <path d="M1 3h5l2 2h7v8H1V3zm11 4h-2v2H8v2h2v2h2v-2h2V9h-2V7z"/>
          </svg>
        </button>
        <button
          onClick={() => {
            importTargetRef.current = defaultTargetFolder();
            fileInputRef.current?.click();
          }}
          title="Import files… (copy into project)"
          style={toolbarBtnStyle}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ display: 'block' }}>
            <path d="M8 11V3m0 0L5 6m3-3l3 3" stroke="currentColor" strokeWidth="1.6" fill="none"/>
            <path d="M2 11v2a1 1 0 001 1h10a1 1 0 001-1v-2"/>
          </svg>
        </button>
        <div style={toolbarDividerStyle} />
        {/* — Scan / convert: Refresh, Re-import all (heavy → last) — */}
        <button
          onClick={refresh}
          disabled={loading}
          title="Scan public/ folder"
          data-ui-id="assets.toolbar.refresh" data-ui-kind="button" data-ui-label="refresh"
          style={toolbarBtnStyle}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ display: 'block', animation: loading ? 'spin 1s linear infinite' : 'none' }}>
            <path d="M13.65 2.35A7.96 7.96 0 008 0a8 8 0 108 8h-2a6 6 0 11-1.76-4.24l-2.12.12L14 6V0l-2.35 2.35z" fill="currentColor"/>
          </svg>
        </button>
        <button
          onClick={() => setConfirmReimportAll(true)}
          disabled={loading}
          title="Re-import all assets (convert textures)"
          data-ui-id="assets.toolbar.reimportAll" data-ui-kind="button" data-ui-label="re-import all"
          style={toolbarBtnStyle}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ display: 'block' }}>
            <path d="M8 1l3 3H9v4H7V4H5l3-3zM2 9h2v3h8V9h2v4a1 1 0 01-1 1H3a1 1 0 01-1-1V9z"/>
          </svg>
        </button>
      </div>

      {/* Asset list (focusable so keyboard shortcuts only fire for this pane) */}
      <div
        data-editor-panel="assets"
        tabIndex={0}
        style={{ flex: 1, overflow: 'auto', padding: '2px 0', outline: 'none' }}
        onKeyDown={handleKeyDown}
        onDragOver={handleDragOver}
        onDrop={(e) => handleDrop(e, viewMode === 'folder' ? assetsRoot.path : undefined)}
        onClick={(e) => { if (e.target === e.currentTarget) clearSelection(); }}
      >
        {viewMode === 'category' ? (
          /* ── Category view ── */
          Array.from(grouped.entries()).map(([type, items]) => (
            <div key={type}>
              <SectionHeader
                label={type.charAt(0).toUpperCase() + type.slice(1)}
                count={items.length}
                open={expanded.has(type)}
                onToggle={() => toggle(type)}
              />
              {expanded.has(type) && items.map((a) => (
                <AssetRowWithSprites
                  key={a.path} asset={a} depth={1}
                  selected={selection.has(a.path)}
                  onSelect={handleSelect}
                  onDoubleClick={handleDoubleClick}
                  onContextMenu={handleContextMenu}
                  viewMode="category"
                  renaming={renamingPath === a.path}
                  onCommitRename={commitRename}
                  onCancelRename={cancelRename}
                  getDragPaths={getDragPaths}
                  spritesByTexture={spritesByTexture}
                  selectedSet={selection}
                  expandedSet={expanded}
                  onToggleRow={toggle}
                />
              ))}
            </div>
          ))
        ) : (
          /* ── Folder view ── The "Assets" section header replaces the redundant
             virtual root; its (collapsed) root's folders/files render at depth 1. */
          <>
            <SectionHeader
              label="Assets"
              count={countAll(assetsRoot)}
              open={expanded.has(ASSETS_SECTION)}
              onToggle={(e) => { if (e.altKey) toggleDeep(assetsRoot, [ASSETS_SECTION]); else toggle(ASSETS_SECTION); }}
              onContextMenu={(e) => handleFolderContextMenu(e, assetsRoot.path, 'Assets')}
            />
            {expanded.has(ASSETS_SECTION) && (
              <>
                {assetsRoot.children.map((child) => (
                  <FolderView
                    key={child.path} node={child} depth={1}
                    expanded={expanded} onToggle={toggle} onToggleDeep={toggleDeep}
                    selectedSet={selection} onSelect={handleSelect}
                    onDoubleClick={handleDoubleClick} onContextMenu={handleContextMenu} onFolderContextMenu={handleFolderContextMenu}
                    onEntityDrop={handleDrop} onFilesDrop={handleFilesDrop} dropHighlight={dropHighlight} setDropHighlight={setDropHighlight}
                    renamingPath={renamingPath} onCommitRename={commitRename} onCancelRename={cancelRename}
                    renamingFolderPath={renamingFolderPath} onCommitFolderRename={commitFolderRename} onCancelFolderRename={onCancelFolderRename}
                    getDragPaths={getDragPaths}
                    spritesByTexture={spritesByTexture}
                  />
                ))}
                {assetsRoot.files.map((a) => (
                  <AssetRowWithSprites
                    key={a.path} asset={a} depth={1}
                    selected={selection.has(a.path)}
                    onSelect={handleSelect}
                    onDoubleClick={handleDoubleClick}
                    onContextMenu={handleContextMenu}
                    viewMode="folder"
                    renaming={renamingPath === a.path}
                    onCommitRename={commitRename}
                    onCancelRename={cancelRename}
                    getDragPaths={getDragPaths}
                    spritesByTexture={spritesByTexture}
                    selectedSet={selection}
                    expandedSet={expanded}
                    onToggleRow={toggle}
                  />
                ))}
              </>
            )}
          </>
        )}

        {filtered.length === 0 && engineFiltered.length === 0 && !showScripts && (
          <div style={{ padding: 12, color: '#555' }}>
            {assets.length === 0 ? 'No assets found' : 'No results'}
          </div>
        )}

        {/* Engine built-in assets (white.hdr, icons, fonts, …) — read-only,
            served from the engine package. Kept out of the project tree above so
            they don't bury it; still selectable (Inspector) + draggable onto ref
            fields (e.g. white.hdr → an Environment's HDR field). Narrowed by the
            active type filter. */}
        <EngineAssetsSection
          assets={engineFiltered}
          filter={filter}
          selectedSet={selection}
          onSelect={selectEngineAsset}
          onDoubleClick={handleDoubleClick}
          getDragPaths={getDragPaths}
        />

        {/* Source scripts (project working copy + read-only engine source).
            Self-contained — NOT asset-manifest entries; open in the OS default
            editor on click. Always mounted (so it can report its count for the
            "script" filter chip); `hidden` when a type filter excludes scripts. */}
        <ScriptTree filter={filter} hidden={!showScripts} onCount={setScriptCount} />
      </div>

      {/* Footer */}
      <div style={{ padding: '4px 8px', borderTop: '1px solid #333', color: '#555', fontSize: '10px' }}>
        {selection.size > 1
          ? `${selection.size} selected`
          : (selected || (filtered.length !== flatTotal
              ? `${filtered.length} of ${flatTotal} assets`
              : `${flatTotal} assets`))}
      </div>

      {ctxMenu && (
        <ContextMenu
          items={ctxMenuItems(ctxMenu.asset)}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {folderCtx && (
        <ContextMenu
          items={[
            { label: 'New Folder', onClick: () => createFolder(folderCtx.path) },
            { label: 'Create Scene', onClick: () => createScene(folderCtx.path) },
            { label: 'Create Material', onClick: () => createMaterial(folderCtx.path) },
            { label: 'Create Animation', onClick: () => createAnimationClip(folderCtx.path) },
            { label: 'Create Animset', onClick: () => createAnimSet(folderCtx.path) },
            { label: 'Create Sprite Animation', onClick: () => createSpriteAnim(folderCtx.path) },
            { label: 'Create 2D Rig', onClick: () => createRig2D(folderCtx.path) },
            { label: 'Create Particle', onClick: () => createParticle(folderCtx.path) },
            { label: 'Create Atlas', onClick: () => createAtlas(folderCtx.path) },
            { label: 'Import Files…', onClick: () => { setCurrentFolder(folderCtx.path); importTargetRef.current = folderCtx.path; fileInputRef.current?.click(); } },
            ...(folderCtx.path !== '/' && folderCtx.path !== assetsRoot.path ? [{ label: 'Rename', onClick: () => setRenamingFolderPath(folderCtx.path) }] : []),
            ...(folderCtx.path !== '/' && folderCtx.path !== assetsRoot.path ? [{ label: 'Delete', onClick: () => handleDeleteFolder(folderCtx.path, folderCtx.name) }] : []),
            ...(clipboard ? [{ label: `Paste${clipboard.paths.length > 1 ? ` (${clipboard.paths.length})` : ''}`, onClick: () => pasteClipboard(folderCtx.path) }] : []),
            { label: 'Re-import all (recursive)', onClick: () => reimport(folderCtx.path, true) },
            { label: 'Reveal in Finder', onClick: () => backendFetch('/api/reveal-in-finder', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: folderCtx.path }),
            }) },
          ]}
          x={folderCtx.x}
          y={folderCtx.y}
          onClose={() => setFolderCtx(null)}
        />
      )}

      {/* Re-import all confirmation — guards a potentially slow full reconvert. */}
      {confirmReimportAll && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setConfirmReimportAll(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#1e1e30', border: '1px solid #555', borderRadius: 6,
              padding: '16px 20px', width: 380, fontFamily: 'monospace',
            }}
          >
            <div style={{ color: '#fff', fontSize: 13, fontWeight: 'bold', marginBottom: 8 }}>Re-import all assets?</div>
            <div style={{ color: '#bbb', fontSize: 12, lineHeight: 1.5, marginBottom: 16 }}>
              This reconverts every texture and model under the asset roots
              {(() => {
                const n = assets.filter((a) => a.type === 'texture' || a.type === 'model').length;
                return n > 0 ? ` (${n} asset${n === 1 ? '' : 's'})` : '';
              })()}. It may take a while.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setConfirmReimportAll(false)}
                style={{
                  padding: '5px 16px', border: '1px solid #555', borderRadius: 3,
                  background: '#2a2a40', color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11,
                }}
              >Cancel</button>
              <button
                onClick={() => { setConfirmReimportAll(false); reimport('/', true); }}
                style={{
                  padding: '5px 16px', border: '1px solid #3a4a5a', borderRadius: 3,
                  background: '#2d4a6a', color: '#fff', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11,
                }}
              >Re-import all</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const toolbarBtnStyle: React.CSSProperties = {
  background: 'none', border: '1px solid #555', borderRadius: 3,
  cursor: 'pointer', color: '#ccc', padding: '1px 5px', fontSize: '12px', lineHeight: 1,
};

// Thin vertical separator between functional toolbar groups.
const toolbarDividerStyle: React.CSSProperties = {
  width: 1, alignSelf: 'stretch', background: '#3a3a4a', margin: '2px 1px', flexShrink: 0,
};

// Key for the engine section's own expanded-set (folders + the section header).
// Section header collapsed by default so 130+ engine files stay hidden until asked.
const LS_ENGINE_EXPANDED = 'editor:assets:engineExpanded:v1';
const ENGINE_SECTION = '@@engine-section';

/** Read-only "Engine" section: the engine package's built-in assets
 *  (/modoki/assets — white.hdr, icons, fonts, …) as a collapsible folder tree.
 *  Deliberately NOT wired to the folder-view drag/drop/rename/delete machinery —
 *  these files ship with the engine and mustn't be moved or trashed. Rows are
 *  still selectable (→ Inspector) and draggable onto ref fields (editor-asset
 *  payload only, no file-move), plus a minimal Copy Path / Reveal context menu. */
/** Reveal an engine asset when it's selected externally (e.g. an AssetRefField
 *  "locate" on white.hdr): expand the section + every ancestor folder so the row
 *  mounts, then scroll it into view. The project tree's own reveal effect can't
 *  do this — the Engine section owns a SEPARATE expanded set. Isolated into this
 *  null-rendering leaf so the (frequent) selection-driven store subscription lives
 *  here, NOT in EngineAssetsSection — otherwise every asset selection anywhere
 *  would re-render the whole (memo'd) engine tree. */
function EngineRevealWatcher({ setExpanded }: { setExpanded: React.Dispatch<React.SetStateAction<Set<string>>> }) {
  const selectedAsset = useEditorStore((s) => s.selectedAsset);
  useEffect(() => {
    const p = selectedAsset?.path;
    if (!p || !p.startsWith('/modoki/')) return;
    setExpanded((prev) => {
      const next = new Set(prev).add(ENGINE_SECTION);
      const lastSlash = p.lastIndexOf('/');
      if (lastSlash > 0) {
        let acc = '';
        for (const part of p.substring(0, lastSlash).split('/').filter(Boolean)) { acc += '/' + part; next.add(acc); }
      }
      return next;
    });
    // Double rAF: wait for the expand to commit + the row to mount before scrolling.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.querySelector(`[data-asset-path="${CSS.escape(p)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }));
  }, [selectedAsset, setExpanded]);
  return null;
}

const EngineAssetsSection = React.memo(function EngineAssetsSection({ assets, filter, selectedSet, onSelect, onDoubleClick, getDragPaths }: {
  assets: AssetEntry[];
  filter: string;
  selectedSet: Set<string>;
  onSelect: (a: AssetEntry, e?: React.MouseEvent) => void;
  onDoubleClick: (a: AssetEntry) => void;
  getDragPaths: (a: AssetEntry) => string[];
}) {
  const { expanded, setExpanded, toggle, toggleMany } = useExpandedSet(LS_ENGINE_EXPANDED);
  const [ctx, setCtx] = useState<{ x: number; y: number; asset: AssetEntry } | null>(null);

  const q = filter.trim().toLowerCase();
  const searching = q.length > 0;
  const shown = useMemo(
    () => (searching ? assets.filter((a) => a.path.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)) : assets),
    [assets, q, searching],
  );
  // Collapse the /modoki → /modoki/assets single-folder wrapper chain so the
  // "Engine" header replaces it (mirrors the project Assets header).
  const root = useMemo(() => effectiveAssetsRoot(buildFolderTree(shown, [])), [shown]);

  const toggleDeep = (node: FolderNode, extraKeys: string[] = []) =>
    toggleMany([...collectFolderPaths(node), ...extraKeys], extraKeys[0] ?? node.path);

  const openCtx = (e: React.MouseEvent, asset: AssetEntry) => {
    e.preventDefault(); e.stopPropagation();
    onSelect(asset);
    setCtx({ x: e.clientX, y: e.clientY, asset });
  };
  const row = (a: AssetEntry, depth: number) => (
    <AssetRow
      key={a.path} asset={a} depth={depth} selected={selectedSet.has(a.path)}
      onSelect={onSelect} onDoubleClick={onDoubleClick} onContextMenu={openCtx}
      viewMode="category" renaming={false} onCommitRename={() => {}} onCancelRename={() => {}}
      getDragPaths={getDragPaths}
    />
  );
  const renderNode = (node: FolderNode, depth: number): React.ReactNode => {
    const isOpen = searching || expanded.has(node.path);
    return (
      <div key={node.path}>
        <TreeFolderRow
          name={node.name} depth={depth} open={isOpen} count={countAll(node)}
          onToggle={(e) => { if (e.altKey) toggleDeep(node); else toggle(node.path); }}
        />
        {isOpen && (
          <>
            {node.children.map((c) => renderNode(c, depth + 1))}
            {node.files.map((a) => row(a, depth + 1))}
          </>
        )}
      </div>
    );
  };

  if (assets.length === 0) return null;
  const open = searching || expanded.has(ENGINE_SECTION);
  return (
    <div style={{ borderTop: '1px solid #333' }}>
      <EngineRevealWatcher setExpanded={setExpanded} />
      <SectionHeader
        label="Engine"
        count={countAll(root)}
        open={open}
        tag="read-only"
        onToggle={(e) => { if (e.altKey) toggleDeep(root, [ENGINE_SECTION]); else toggle(ENGINE_SECTION); }}
      />
      {open && (
        <>
          {root.children.map((c) => renderNode(c, 1))}
          {root.files.map((a) => row(a, 1))}
        </>
      )}
      {ctx && (
        <ContextMenu
          items={[
            { label: 'Copy Path', onClick: () => navigator.clipboard.writeText(ctx.asset.path) },
            { label: 'Reveal in Finder', onClick: () => backendFetch('/api/reveal-in-finder', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: ctx.asset.path }),
            }) },
          ]}
          x={ctx.x} y={ctx.y} onClose={() => setCtx(null)}
        />
      )}
    </div>
  );
});

