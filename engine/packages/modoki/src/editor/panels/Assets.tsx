/** Assets — browse project assets by category or folder structure */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { backendFetch, importedFileBytes } from '../backend/editorBackend';
import { fileToBase64 } from './fileBytes';
import { getGameConfig } from '../../runtime/core/config';
import { loadAllFonts } from '../../runtime/loaders/fontLoader';
import { classifyExistingPrefabId } from '../scene/prefabCache';
import { serializeRebuildOver } from '../scene/prefabSerialize';
import { runtimeExcludedMessage } from '../scene/authoringScope';
import { importModel } from '../scene/modelImport';
import { needsGLBConversion, convertSourceToGLB } from '../scene/convertToGLB';
import { readMetaPreferringPark, getPendingMetaPaths } from '../scene/pendingMeta';
import { getDirtyAssetPaths } from '../scene/dirtyAssets';
import { useEditorStore, type SelectedAsset } from '../store/editorStore';
import { pushAction } from '../undo/undoManager';
import { placePrefabFromPath } from '../scene/prefabPlace';
import { commitPrefabWrite, prefabConflictReason } from '../scene/prefabCommit';
import { ASSET_ROOT_RE, firstAssetRoot } from './assetRoots';
// Backend-IO wrappers + create-prefab flow shared with the Hierarchy panel
// (editor-panels F6/F7) — single source of truth for the /api/* calls and the
// "serialize entity → write prefab → tag instance → push undo" flow. The FILE operations below push no undo
// (#1868, owner ruling D2): a delete, rename, move, duplicate, paste, new folder or import changes disk at once and
// Cmd+Z does not reach it — as in Unity, where a delete says "You cannot undo the delete assets action.".
import {
  trashAssetFile, deleteAssetFiles as deleteAssets,
  describeRefusedDeletes, planDeleteOutcome,
  duplicateAssetFileReport as duplicateAsset, readPriorDocument, createAssetFolder, moveAsset, createPrefabFromEntity, readWritableAssetRoot,
  reimportTargets, planImports, writeDroppedImport, refreshHandlerTypes, HANDLER_TYPES,
  deletionPathsFor, planRename, assetEditorHoldMessage, deleteConfirmText, deletionFootprint,
} from './assetOps';
import { resolveClickSelection, dragPathsFor } from './assetSelection';
import { reportGestureRefusal, reportBackgroundRefusal, fileNameOf, refusedItemsText } from '../backend/refusalChannel';
import { createStoreSelectionTracker, revealKeysFor } from './assetReveal';
import { unbindDeletedAssetEditors, applyAssetPathMoves } from './assetEditorBindings';
import { newGuid } from '../../runtime/loaders/assetManifest';
import { getCreatableAssets, type CreatableAssetDef } from './creatableAssets';
import { reimportPaths } from './assetViews/reimport';
import { reimportAsset, reimportProblem } from './assetViews/reimportAsset';
import { openAssetInEditor } from './openAssetInEditor';
import { chooseNewAssetPath, confirmReplaceAsset, confirmInEditor } from '../utils/saveDialog';
import { confirmDiscardUnsaved } from '../scene/unsavedGate';
import { mayCreateOver } from '../scene/createAssetDocument';
import { createRegisteredAssetAskingToReplace } from './createRegisteredAsset';

/** Every path ONE asset's delete trashes — `collectDeletion`'s answer. */
type DeleteTarget = { asset: AssetEntry; deletePaths: string[] };

/** Display name from an asset path: last segment minus a known double/single extension. */
function assetDisplayName(p: string, ext: string): string {
  const seg = p.split('/').pop() || p;
  return seg.toLowerCase().endsWith(ext.toLowerCase()) ? seg.slice(0, -ext.length) : seg.replace(/\.[^.]+$/, '');
}
import ContextMenu, { type ContextMenuItem } from '../components/ContextMenu';
import RenameInput from '../components/RenameInput';
import { startDragGhost, endDragGhost, setAssetDragPayload, completeAssetDrop, armGrabCursor } from '../utils/dragGhost';
import {
  splitAssetPath, duplicatePathFor, pastePathIn, buildFolderTree, autoImportBaseline, diffAutoImportScan, markAutoImported,
  effectiveAssetsRoot, collectFolderPaths, planFilesDropMoves, isFolderPath,
  type AssetEntry, type AutoImportBaseline, type FolderNode, type RelocateMove,
} from '../utils/assetPaths';
import { ASSET_TYPE_COLORS, AssetTypeGlyph, compareAssetTypes } from './assetTypeIcons';
import {
  spritesByTexture as spritesByTextureOf, filterAssets, flatAssetTotal, fileActionTargets, fileActionPaths, groupByType, visibleOrder,
  ASSETS_SECTION, type ViewMode,
} from './assetListing';
import { resolveAssetKey } from './assetKeyCommands';
import ScriptTree from './ScriptTree';
import { SectionHeader, TreeFolderRow, TreeSearchInput, TypeFilterMenu } from './treeChrome';
import { useExpandedSet } from './useExpandedSet';
import {
  useExpanded, usePendingFolders, useTypeFilter, useViewMode,
  setExpanded, setPendingFolders, setTypeFilter, setViewMode,
  getCurrentFolder, setCurrentFolder,
} from './assetFolderState';
import { ModalShell } from '../components/ModalShell';
import { assetUrl } from '../../runtime/loaders/assetUrl';


/** The Assets panel's "Instantiate" (the shared flow, `prefabPlace.ts`). */
async function instantiatePrefabFromPath(prefabPath: string, _name: string) {
  await placePrefabFromPath(prefabPath, { tag: 'Assets' });
}

/** Show a path in the OS file manager. The three "Reveal in Finder" menu items used
 *  to call `backendFetch` bare — no `ok` check, no `catch`, not even `void` — so the
 *  route's failures were invisible and a rejection surfaced as an unhandled promise.
 *  That mattered more once `/api/reveal-in-finder` started answering 404 for a row
 *  that outlived its file (#1515): without this, a stale row reveals nothing and says
 *  nothing. Mirrors `ScriptTree.tsx`'s `postPath`, the other consumer of this route —
 *  the two disagreed, which is how one of them ended up silent. */
function revealPathInFinder(assetPath: string): void {
  void (async () => {
    try {
      const r = await backendFetch('/api/reveal-in-finder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: assetPath }),
      });
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        console.error(`[Assets] Reveal failed (${r.status})`, (detail as { error?: string }).error ?? '', assetPath);
      }
    } catch (e) {
      console.error('[Assets] Reveal request failed', e, assetPath);
    }
  })();
}

/** Try live scan first (dev server), fall back to static manifest (production).
 *  Uses /api/rescan-assets so a refresh forces a fresh filesystem scan + GUID
 *  collision heal rather than serving the watcher's cached manifest. */
async function fetchAssets(): Promise<{ assets: AssetEntry[]; folders: string[] }> {
  try {
    const res = await backendFetch('/api/rescan-assets', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      return { assets: (data.assets || []) as AssetEntry[], folders: (data.folders || []) as string[] };
    }
  } catch { /* not available */ }

  const config = getGameConfig();
  const manifestPath = config.assetManifest || '/assets.manifest.json';
  try {
    const res = await fetch(assetUrl(manifestPath));
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
  // #845 close-out: prefer a still-parked Inspector edit (postprocessor / rootTransform, parked by
  // ModelBatchView.applyPostprocessor / Inspector.handlePostprocessorChange / ModelAssetView.update)
  // over disk — a stale disk read here would drive the import with the PRE-edit settings while the
  // panel already shows the new ones. This never writes the sidecar back itself (the import that
  // follows does — see modelImport.ts), so there is no park to drop here.
  try {
    const { meta } = await readMetaPreferringPark(assetPath);
    return meta as ModelMeta;
  } catch { /* ignore */ }
  return {};
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
/** Resolves false when the import was refused, aborted or failed (each says so itself), true otherwise: the source
 *  baked to a GLB, or the model imported and its prefab, if it produced one, written. Import-on-add reads it to know
 *  the asset is imported (#2054). */
async function importModelWithMeta(assetPath: string, assetName: string, onDone?: () => void): Promise<boolean> {
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
      return true;
    }

    const dir = assetPath.substring(0, assetPath.lastIndexOf('/'));
    const baseName = assetPath.substring(assetPath.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
    const prefabPath = `${dir}/${baseName}.prefab.json`;

    // ⚠️ CLASSIFY THE PREFAB FIRST — before `importModel` writes anything (#1468 close-out review
    // F3). Refusing after the import has already rewritten the model's generated files leaves the
    // editor holding a half-done operation; refusing here means nothing has been touched. It costs
    // nothing to move, because `prefabPath` derives from `assetPath` alone and this read depends on
    // nothing the import produces — and it removes the `await` that otherwise sat between the
    // import's temp spawn and `serializePrefab`, where a scene reload would have made the serialize
    // see a different tree (review H1).
    const existing = await classifyExistingPrefabId(prefabPath);
    if (existing.kind === 'refuse') {
      setImportError(`Import of "${assetName}" was aborted — ${existing.reason}`);
      return false;
    }
    // A RE-import replaces the prefab already there, so its undo must put those bytes back rather than trash the file
    // (#1264's shape, found by #1679's sweep). Read now, before anything is written, and decided by the FILE, not the
    // manifest: a `known` id can outlive it, and a `no-id` file is there all the same — or by the PARK over a parked
    // prefab, the document the editor shows (#1868, #1872; both are `readPriorDocument`).
    const previousContent = await readPriorDocument(prefabPath);
    // …and the write is conditional on it (#1692, I10), so a prefab that is there and cannot be read is not overwritten
    // blind. Refused before anything is spawned or written.
    if (previousContent === null) {
      setImportError(`Import of "${assetName}" was aborted — ${prefabPath} is there but could not be read, so it was not overwritten.`);
      return false;
    }

    // Temporarily spawn entities to serialize as prefab, then clean up
    const rootId = await importModel(assetPath, prefix, postprocessorId, rootTransform);
    // #311: `importModel` returns 0 when a generated-file write failed and it aborted. This
    // early return is OLDER than that and used to be dead code — before the abort existed the
    // import always returned a real spawned entity id — so it returned from inside the `try`
    // WITHOUT clearing the progress modal, leaving a full-screen blocking spinner with no OK
    // button until a page reload. Report it the same way the catch below reports a throw: an
    // abort is an import failure, and `setImportError` is the dismissible modal for one.
    // (A blanket `finally { setImportStatus(false) }` would be wrong — it resets `failed`,
    // wiping the very error modal the catch sets.)
    // ⚠️ NAME NO CAUSE HERE. `importModel` aborts for three different reasons now — a write that
    // did not land (#311), a refusal to overwrite a too-new/corrupt existing asset doc (#784), and
    // a failed `.meta.json` READ (#880, which would otherwise mint a fresh GUID over the model's
    // own) — and only the abort itself is visible from this side; the reason travels in
    // `importModel`'s own toast and console line. This modal hard-coded "a generated file could
    // not be written", which `importModel` had already fixed in its toast for exactly this reason
    // and which would now send a user to check disk permissions for a dev-server blip.
    if (!rootId) {
      setImportError(`Import of "${assetName}" was aborted — nothing was written. See the notification and console for the reason.`);
      return false;
    }

    // ⚠️ KEEP the existing prefab's stable id (#1468). This call used to be `serializePrefab(rootId)`
    // with no id at all, so re-importing a model over an existing one minted a FRESH file guid and
    // every scene whose `PrefabInstance.source` named the old one was orphaned outright — no
    // mitigation, no repair pass. That is the tropical-island bug (`classifyExistingPrefabId`'s own
    // reason for existing) reproduced at a second import entry point, and the asymmetry is the tell:
    // `ModelAssetView`'s re-import has resolved the id all along. Same operation, two code paths, one
    // of them asking. The classify itself is hoisted above the import — see the note up there.
    //
    // Node identity is the other half (#1782): a freshly imported GLB tree carries no link to the old
    // document's rows, so the rebuild matches each node to a row by its hierarchy PATH, as Unity's model
    // importer does — a matched node keeps its localId and nodeGuid, so a scene's edit of it and a ref to it
    // survive the reimport; a new node goes above the old mark (#1774). It used to renumber by position.
    const prefab = serializeRebuildOver(rootId, existing.kind === 'known' ? existing.id : undefined, previousContent);

    // Remove temporary entities from scene
    const { deleteEntity } = await import('../../runtime/core/ecs/entityUtils');
    deleteEntity(rootId);

    let prefabFailed = false;
    if (prefab) {
      // ONE step (#1692): only over what was read at the path, then both caches — so the instances placed from a
      // re-imported prefab are rebuilt from it now, not at the next reload.
      const committed = await commitPrefabWrite(prefabPath, prefab, { expected: previousContent ?? null });
      const wrote = committed.ok;
      if (!wrote) {
        // The commit's own reason when it has one (#1750: "a scene is still loading" refuses a write, and says so), and a
        // conflict's cause (#1872 close-out review: over a prefab parked across an outside change, a retry cannot land).
        // Shown as the import's error, not only logged: the import otherwise finished as a success.
        const why = committed.conflict ? prefabConflictReason(prefabPath).reason : committed.error;
        console.error(`[Assets] Failed to create prefab ${prefabPath}${why ? ` — ${why}` : ''}`);
        setImportError(`Import of "${assetName}" did not write its prefab${why ? ` — ${why}` : ''}.`);
        prefabFailed = true;
      } else {
        // No undo entry (#1868, D2): an import is a file operation, and its prefab is a new asset saved on creation.
        console.log(`[Assets] Created prefab: ${prefabPath}`);
      }
    }

    refreshAssets();
    onDone?.();
    // Not over a failed prefab write: `setImportStatus` clears the modal's failed state, which is what shows it.
    if (!prefabFailed) setImportStatus(false);
    return !prefabFailed;
  } catch (e) {
    // Surface conversion/import failures (e.g. unsupported FBX) as a dismissible
    // modal instead of an unhandled rejection — this runs from a fire-and-forget
    // onClick, so a thrown error would otherwise escape uncaught.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[Assets] Import failed for "${assetName}":`, e);
    setImportError(msg);
    return false;
  }
}

// ─── Asset row (shared between views) ────────────────────────────────

// Repair notes are logged by `applyAssetPathMoves` itself (#898) — the pass that produces
// them. They used to be logged here, which stopped working when #867 moved the repair to
// `/api/move-file`: that pass runs first, so the panel's call had nothing left to report.
//
// A folder-relative `moveFile(from, toFolder)` used to live here, deriving the destination and
// re-checking "onto itself" / "into its own descendant" itself. #867 extracted those decisions
// into `planFilesDropMoves`, which left two independent computations of one destination — they
// agreed, but the day one grew a collision-suffix rule (as `pastePathIn` already has) the other
// becomes a lie and the binding repair follows a path the file is not at. Deleted; the
// drop loop calls `assetOps.moveAsset(from, to)` with the destination the planner derived.

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

// The current-folder memory lives in assetFolderState.ts with the panel's other persisted
// path state (#473) — it is per-project there, and testable without mounting this panel.

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
  const expanded = useExpanded();
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
  const viewMode = useViewMode();
  // Freshly-created empty folders (persisted) — the scanner only reports files,
  // so without this an empty folder vanishes from the tree on the next rescan.
  const pendingFolders = usePendingFolders();
  const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(null);
  // Active type filter — when non-empty, only assets whose `type` is in the set
  // are shown (the chips bar). Empty = show everything.
  const typeFilter = useTypeFilter();
  // Cut/copy clipboard + keyboard-nav helpers.
  const [clipboard, setClipboard] = useState<{ paths: string[]; op: 'copy' | 'cut' } | null>(null);
  const visiblePathsRef = useRef<string[]>([]);   // in-render-order asset paths
  const typeAheadRef = useRef<{ str: string; t: number }>({ str: '', t: 0 });
  // OS import: hidden file <input> + the folder a picker/drop targets.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importTargetRef = useRef<string>('/');
  // Auto-import-on-discovery: the last scan's paths + GUIDs (null until the first
  // scan, which is baseline-only — never bulk-import an existing project on open),
  // and a flag serializing import batches (importModel mutates the live world).
  const seenAssetsRef = useRef<AutoImportBaseline | null>(null);
  const autoImportingRef = useRef(false);

  // "Current folder" — the last folder the user interacted with (clicked a
  // folder row, or selected a file inside one). Imports, paste, and New Folder
  // default here so new content lands where the user is looking, instead of the
  // first asset root. Persisted so it survives editor restarts.
  // Resolve the default target folder for new content: the current folder when
  // it's under a writable asset root (this holds for freshly-created EMPTY
  // folders too — they have no assets but are valid targets; /api/write-file
  // creates the dir on demand), else the folder of the selected asset, else the
  // first writable asset root.
  const defaultTargetFolder = useCallback((): string => {
    const cur = getCurrentFolder();
    if (cur && ASSET_ROOT_RE.test(cur)) return cur;
    if (selected) return splitAssetPath(selected).dir || '/';
    return firstFromEntries(assets) ?? '/';
  }, [assets, selected]);

  // Every selection this panel publishes is marked as its OWN, so the store-sync effect below does not
  // react to it as an external request (`createStoreSelectionTracker`). Wrapping the two actions here,
  // rather than marking at each call site, is what keeps a future call site covered.
  const selectionTrackerRef = useRef<ReturnType<typeof createStoreSelectionTracker> | null>(null);
  selectionTrackerRef.current ??= createStoreSelectionTracker();
  const storeSelectAsset = useEditorStore((s) => s.selectAsset);
  const storeSetSelectedAssets = useEditorStore((s) => s.setSelectedAssets);
  const selectAsset = useCallback((a: SelectedAsset | null) => {
    selectionTrackerRef.current!.markOwn([a]);
    storeSelectAsset(a);
  }, [storeSelectAsset]);
  const setSelectedAssets = useCallback((list: SelectedAsset[], primary?: SelectedAsset | null) => {
    selectionTrackerRef.current!.markOwn([...list, primary]);
    storeSetSelectedAssets(list, primary);
  }, [storeSetSelectedAssets]);
  const selectedAsset = useEditorStore((s) => s.selectedAsset);
  const assetsVersion = useEditorStore((s) => s.assetsVersion);
  const setImportStatus = useEditorStore((s) => s.setImportStatus);
  const openFindReferences = useEditorStore((s) => s.openFindReferences);

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

  // Scans resolve in any order, and a refresh is issued from many places at once (an import's own refresh, the
  // batch's, a watcher bump). Only the LATEST one applies: an older scan landing after a newer one shows a disk
  // that is already gone, and import-on-add would diff it (#2054 review: a model moved mid-batch read as a move of
  // an asset the stale scan had just made known, and was never imported).
  const refreshSeqRef = useRef(0);
  const refresh = useCallback(() => {
    setLoading(true);
    const seq = ++refreshSeqRef.current;
    fetchAssets().then(({ assets: aRaw, folders }) => {
      if (seq !== refreshSeqRef.current) return; // superseded — the newer scan applies, and clears `loading`
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
      if (seenAssetsRef.current === null) seenAssetsRef.current = autoImportBaseline(a);
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

  /** What the toolbar's Refresh button runs — NOT `refresh` directly.
   *
   *  `refresh` re-scans and repopulates THIS panel only. `assetsVersion` is the
   *  editor-wide "assets changed" signal, and other views subscribe to it — the
   *  Script tree re-fetches on it, and it is the only trigger it has. So a Refresh
   *  that called `refresh` left a script added or deleted on disk invisible until
   *  something unrelated (an asset save, a full editor reload) happened to bump the
   *  version: the one affordance a human reaches for did not fix the one thing they
   *  reached for it about (QA-EDITOR-0009).
   *
   *  Bumping the version is enough for this panel too — the effect above is keyed on
   *  it — so this is a bump, not a bump PLUS a direct call, which would scan twice. */
  const refreshAll = useCallback(() => {
    useEditorStore.getState().refreshAssets();
  }, []);

  // Derive the re-importable type set from the server registry once on mount, so
  // the per-row "Re-import" menu + recursive re-import count track what the server
  // can actually handle instead of a hardcoded client constant. (F9.)
  useEffect(() => { void refreshHandlerTypes(); }, []);

  // Sync local selection with store (e.g., when clicking an asset directly). Which reactions a
  // store change earns — and why expand needs the row to be absent — is `createStoreSelectionTracker`.
  useEffect(() => {
    // Store cleared the asset selection (e.g., user selected an entity) — drop local too
    if (!selectedAsset && selected !== null) {
      setSelected(null);
      setSelection(new Set());
      anchorRef.current = null;
    }
    const plan = selectionTrackerRef.current!.next(selectedAsset, selected,
      (path) => !!document.querySelector(`[data-asset-path="${CSS.escape(path)}"]`));
    if (!selectedAsset) return;
    if (plan.syncLocal) {
      setSelected(selectedAsset.path);
      // External (single) selection — collapse the multi-select to just it.
      setSelection(new Set([selectedAsset.path]));
      anchorRef.current = selectedAsset.path;
    }
    if (plan.expand) {
      setExpanded((prev) => {
        const keys = revealKeysFor(selectedAsset, { spriteRow: filtered.some((a) => a.path === selectedAsset.path) });
        if (keys.every((k) => prev.has(k))) return prev;
        const next = new Set(prev);
        for (const k of keys) next.add(k);
        return next;
      });
    }
    if (plan.scroll) {
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
  const [folderCtx, setFolderCtx] = useState<{ x: number; y: number; path: string; name: string; createOnly?: boolean } | null>(null);
  // Inline rename — path of the asset whose filename is currently editable
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  // Re-import: convert a single asset, or every asset under a folder (recursive),
  // dispatched per-type by the dev server. Textures and models have handlers.
  //
  // Iterate file-by-file on the client so the progress modal can name the file
  // currently being converted — makes hangs visible (the slow file is in the
  // bar) and gives a real step/total bar instead of an indeterminate animation.
  const reimport = useCallback(async (target: string, recursive: boolean, channel: 'gesture' | 'background' = 'gesture') => {
    const targets = reimportTargets(assets, target, recursive);
    try {
      const summary = await reimportPaths(
        targets.map((a) => ({ path: a.path, type: a.type })),
        setImportStatus,
        `Re-importing ${target === '/' ? 'all assets' : target}…`,
        channel,
      );
      if (!summary.errors.length) console.log('[Assets] Re-import:', summary);
      // `attempted`: a target the scan no longer lists resolves to no work and an empty error list, which is not a
      // success. (A texture moved mid-batch is still listed here and fails at the server, which errors.)
      return { ...summary, attempted: targets.length };
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
  // prefab exists; a texture is seen-once), and never a MOVED asset: a path whose
  // GUID the last scan knew elsewhere is a move, not an add (#2054). Import OUTPUTS (prefab/mesh/mat/
  // converted texture) that appear on the next scan aren't model/texture SOURCES,
  // so planAutoImports ignores them — no loop. The baseline is only advanced when
  // not mid-batch, so a rapid second drop during an import isn't dropped silently.
  useEffect(() => {
    const prev = seenAssetsRef.current;
    if (prev === null) return; // first scan not done yet — refresh() sets the baseline
    if (autoImportingRef.current) return; // a batch is running; re-diff after it finishes (don't advance the baseline, so nothing dropped during it is missed)
    const { models, textures, next } = diffAutoImportScan(prev, assets);
    seenAssetsRef.current = next;
    if (models.length === 0 && textures.length === 0) return;
    // A finished import makes its GUID known, so a move of it during the rest of the batch is a move (#2054).
    const imported = (a: AssetEntry) => { if (seenAssetsRef.current) seenAssetsRef.current = markAutoImported(seenAssetsRef.current, a); };
    autoImportingRef.current = true;
    void (async () => {
      try {
        // Order matters for the source→glb→prefab chain: a dropped FBX/OBJ/DAE
        // bakes to a GLB here, the GLB appears on the NEXT scan and imports to a
        // prefab then (each step is a separate diff). importModelWithMeta refreshes
        // when done; the resulting prefab/mesh/mat are not model/texture SOURCES,
        // and a model with a sibling prefab is skipped — so the chain converges and
        // never re-imports.
        for (const m of models) if (await importModelWithMeta(m.path, m.name, refresh)) imported(m);
        // Import-on-add is background work — nobody clicked for these (#1824, ruling FA): a failure is the console's.
        for (const t of textures) {
          const r = await reimport(t.path, false, 'background');
          if (r.attempted > 0 && r.errors.length === 0) imported(t);
        }
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
  // The click policy lives in assetSelection.ts (#105 Phase 3) — pure, unit-tested.
  const handleSelect = useCallback((a: AssetEntry, e?: React.MouseEvent) => {
    setSelection((prev) => {
      const { paths, anchor } = resolveClickSelection({
        path: a.path,
        current: prev,
        anchor: anchorRef.current,
        order: visiblePathsRef.current,
        toggle: !!e && (e.metaKey || e.ctrlKey),
        range: !!e && e.shiftKey,
      });
      if (anchor !== undefined) anchorRef.current = anchor;
      return paths;
    });
    activate(a);
  }, [activate]);

  const handleDoubleClick = useCallback(async (a: AssetEntry) => {
    await openAssetInEditor({ path: a.path, type: a.type, name: a.name });
  }, []);

  /** Generic driver for every registered `CreatableAssetDef` (creatableAssets.ts) — the
   *  shared "New X" flow that used to be duplicated per asset kind: native Save dialog
   *  picks the location → mint a guid → either run `def.create` fully (Scene) or write
   *  `def.body`'s JSON + `registerAsset` → refresh the panel → `def.onCreated` opens the
   *  right editor / selects the new asset. `folder` (a right-clicked folder path) wins
   *  over the def's own `defaultFolder`. */
  const runCreate = useCallback(async (def: CreatableAssetDef, folder?: string) => {
    // A `create` override (Scene) replaces the live world — ask before the path picker, so a Cancel
    // here costs nothing and the picker is not answered for a create that then does not happen (#1419).
    if (def.create && !(await confirmDiscardUnsaved(`create ${def.label.replace(/^Create /, 'a new ').toLowerCase()}`, 'world-swap'))) return;
    const pick = await chooseNewAssetPath({
      defaultName: def.defaultName + def.ext, ext: def.ext,
      defaultFolder: folder ?? def.defaultFolder, prompt: def.prompt ?? def.label,
    });
    if (!pick) return;
    const { path } = pick;
    // The `create`-OVERRIDE kinds (Scene) stay HERE and are not routed through
    // `createRegisteredAsset`, which refuses them. That is not an inconsistency: the override
    // discards the live world, and the dialog above is what makes a cancel safe — which is exactly
    // the guard an explicit-path call would remove. See createRegisteredAsset.ts's header.
    if (def.create) {
      // ⚠️ Asked BEFORE the override, not at its write (#1264): Scene's override throws the live
      // world away first and writes last, so a create-only 409 would arrive after the damage.
      const may = await mayCreateOver(path, pick.confirmReplace, def.assetType);
      if (may === 'declined') return;
      if ('existingType' in may) {
        useEditorStore.getState().showToast(`${path} is not a ${def.assetType} (it is typed '${may.existingType}') — choose another name.`, 'warn');
        return;
      }
      // `may.create`, not `path`: over an existing file it is that file's on-disk spelling (#1273).
      await def.create(may.create);
      refresh();
      def.onCreated?.({ path: may.create, name: assetDisplayName(may.create, def.ext), guid: newGuid() });
      return;
    }
    // Everything else shares ONE create path with the agent op (#288 gap 5), so a kind that works
    // for the human cannot silently differ for a tool.
    // Create-only, then an in-app "Replace?" if the file exists — the save dialog above cannot be
    // trusted to have asked for the real destination (#1215). A Replace keeps the replaced guid.
    const r = await createRegisteredAssetAskingToReplace(def.id, path, pick.confirmReplace);
    if (!r) return;
    if (!r.ok) { console.error(`[Assets] ${r.error}`); return; }
    refresh();
    def.onCreated?.({ path: r.path, name: r.name, guid: r.guid });
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

  // Gather everything ONE asset's delete must touch — the file, its sidecar, and
  // (for models) every generated mesh/material/texture + their sidecars — as a flat
  // list of paths to trash.
  // Does NOT hit the trash backend or mutate UI — the caller aggregates across
  // the whole selection and fires a SINGLE trash request, so the OS plays one
  // trash sound, not one per file.
  const collectDeletion = useCallback(async (asset: AssetEntry): Promise<DeleteTarget> => {

    // For a model, the set also covers everything the import generated — read the
    // sidecar to find out what that was. A missing/unreadable meta just means the
    // bare model delete.
    type GeneratedFiles = { meshes?: string[]; materials?: string[]; textures?: string[] };
    let generated: GeneratedFiles | null = null;
    if (asset.type === 'model') {
      try {
        // #845 close-out: through the shared helper for consistency with every other .meta.json
        // read — `generated` is never itself a parked field (only an import writes it, and every
        // re-import flushes any outstanding park for this path first), so this is unaffected by
        // whether a park exists, but it must not be the one remaining raw fetch either.
        const { meta } = await readMetaPreferringPark(asset.path);
        generated = (meta.generated as GeneratedFiles | undefined) || null;
      } catch { /* no meta or read failed — proceed with the bare model delete */ }
    }

    // WHICH paths a delete covers is decided by assetOps.deletionPathsFor (pure,
    // unit-tested). The backend skips paths that no longer exist, so a maybe-absent
    // sidecar in the list is harmless.
    const deletePaths = deletionPathsFor(asset.path, asset.type, generated);
    // Counts the generated FILES, not the sidecars they drag along — matches what
    // the meta actually lists.
    const generatedCount = (generated?.meshes?.length ?? 0) + (generated?.materials?.length ?? 0) + (generated?.textures?.length ?? 0);
    if (generatedCount > 0) console.log(`[Assets] Will clean up ${generatedCount} generated files for ${asset.name}`);

    return { asset, deletePaths };
  }, []);

  // Delete one or more assets in a SINGLE OS-trash call (one trash sound), and, for
  // batch, ONE rescan. `rescan` mirrors the original split: the single context-menu
  // delete relies on the optimistic row removal below (no rescan), the batch path
  // rescans to reconcile generated files the optimistic pass doesn't enumerate.
  // Asked first: a delete is not undoable (#1868, D2) — `deleteConfirmText`.
  const executeDeletion = useCallback(async (targets: AssetEntry[], rescan: boolean) => {
    if (targets.length === 0) return;
    // Collected BEFORE asking (reads only), so the question names what the delete drags along.
    const results: DeleteTarget[] = [];
    for (const a of targets) results.push(await collectDeletion(a));
    const allPaths = Array.from(new Set(results.flatMap((r) => r.deletePaths)));
    const names = targets.map((a) => a.path);
    const ask = deleteConfirmText(names, deletionFootprint(names, allPaths, [...getDirtyAssetPaths(), ...getPendingMetaPaths()]));
    if (!await confirmInEditor(ask.title, ask.message, ask.okLabel)) return;
    const del = await deleteAssets(allPaths);
    // ⚠️ Report the refusal BEFORE branching on `ok` (#884). A total refusal is `ok:false` WITH
    // `failed` populated, so an early return that only logs "Delete failed" throws away the one
    // thing the human needs — WHICH files are still on disk. Both levels get the same message.
    const refusal = describeRefusedDeletes(del.failed, { trashed: del.trashed });
    if (refusal) {
      console.error(`[Assets] The OS refused to trash: ${refusal.detail}`);
      useEditorStore.getState().showToast(refusal.toast, 'warn');
    } else if (!del.ok) {
      // ⚠️ A failed delete with NO named survivors — which is every failure on macOS and Linux,
      // where the trash command throws as a whole and `failed` is therefore always empty (see
      // DeleteFilesResult). Without this the human gets a toast when a FOLDER delete fails and
      // silence when a FILE delete does, on every non-Windows machine — and the owner's machine
      // is one. Named paths would be better; not telling them at all is the actual defect.
      // ⚠️ Says "did not complete", NOT "nothing was deleted". `deleteAssetFiles` answers ok:false
      // for a transport throw too, where the request may well have reached the server and deleted —
      // and "nothing was deleted" about files that ARE gone is the precise over-claim the route's
      // own comment refuses to make. Same correction as the folder toast below.
      // The route's reason when it gave one (#1824); "did not complete" stays the claim, for the reason above.
      console.error(`[Assets] Delete did not complete for: ${allPaths.join(', ')}`);
      reportGestureRefusal(`Could not move to the Trash — the delete did not complete: ${del.error ?? 'see the console'}`);
    }
    if (!del.ok) return;
    // ⚠️ Everything below acts on what ACTUALLY went, not on what was requested. A file the OS
    // refused is still on disk, so its row must stay and its editor must stay bound. The route already draws this line for its own half of the repair
    // ("Unbinding an editor from a file that is still on disk would be the wrong direction") and
    // the panel used to undo that care by passing the full requested list to every step.
    const outcome = planDeleteOutcome(allPaths, results.map((r) => r.asset.path), del.failed);
    const removed = new Set(outcome.removed);
    setAssets((prev) => prev.filter((a) => !removed.has(a.path)));
    if (selected && removed.has(selected)) { setSelected(null); selectAsset(null); }
    // Same idea as the selection reset above, one layer deeper: an ASSET EDITOR bound to a
    // deleted file would keep editing it, and the write parked for that path would put the file
    // back at the next Cmd+S (#186; the same hazard when the panels autosaved, now deferred to
    // save time — which is also why this repairs the dirty-asset REGISTRY, not only the binding,
    // see applyAssetPathMoves). Checked against every path that WENT, not against `removed`, so a
    // generated file that a model delete drags along also unbinds — and, since #884, so that a
    // file the OS refused does NOT: unbinding an editor from a file still on disk is the wrong
    // direction, which is the same call the route makes for its own half of this repair.
    unbindDeletedAssetEditors(outcome.went);
    console.log(`[Assets] Moved ${del.trashed} file(s) to trash`);
    if (rescan) refresh();   // ONE rescan, not one per file
  }, [collectDeletion, refresh, selected, selectAsset]);

  const handleDelete = useCallback(async (asset: AssetEntry) => {
    await executeDeletion([asset], false);
  }, [executeDeletion]);

  // Do the disk work for ONE duplicate, answering whether it landed. No refresh
  // (callers coalesce). `taken` is threaded so a batch duplicate can't pick the
  // same target path twice.
  const performDuplicate = useCallback(async (asset: AssetEntry, taken: Set<string>): Promise<boolean> => {
    const toPath = duplicatePathFor(asset.path, taken);
    const dup = await duplicateAsset(asset.path, toPath);
    // A human Duplicate of an asset with unsaved edits is refused by the route by design — say why (#1824, FA).
    if (!dup.ok) { reportGestureRefusal(`Could not duplicate ${fileNameOf(asset.path)}: ${dup.error}`); return false; }
    taken.add(toPath);
    console.log(`[Assets] Duplicated ${asset.path} → ${toPath}`);
    return true;
  }, []);

  const handleDuplicate = useCallback(async (asset: AssetEntry) => {
    if (await performDuplicate(asset, new Set(assets.map((a) => a.path)))) refresh();
  }, [assets, performDuplicate, refresh]);

  // Rename an asset's file (keeps its folder + compound extension). The backend
  // moves the .meta.json sidecar alongside it, so the asset's GUID + import
  // settings survive — only the on-disk filename changes.
  const handleRename = useCallback(async (asset: AssetEntry, newBase: string) => {
    const plan = planRename(asset.path, newBase, assets.map((a) => a.path));
    if (!plan.ok) {
      if (plan.reason === 'exists') console.warn(`[Assets] Rename target exists: ${plan.toPath}`);
      return;
    }
    const { toPath, base: safe } = plan;
    // #1362: the backend refuses this move while a texture editor holds unsaved edits on it. `moveAsset` now carries
    // the route's reason too (#1824); this pre-flight names the editor before any request is made. The refusal itself
    // stays server-side; this is the message, not the guard.
    const held = assetEditorHoldMessage([asset.path]);
    if (held) { useEditorStore.getState().showToast(held, 'warn'); return; }
    const moved = await moveAsset(asset.path, toPath);
    if (!moved.ok) { reportGestureRefusal(`Could not rename ${fileNameOf(asset.path)}: ${moved.error}`); return; }
    console.log(`[Assets] Renamed ${asset.path} → ${toPath}`);
    // …and an open editor bound to it, or its next autosave FORKS the asset: the write goes
    // to the old path, re-creating the file you renamed away from, while the renamed file
    // stops receiving edits (#186).
    //
    // Repair the registry BEFORE selectAsset: selectAsset re-points the Inspector, and
    // AtlasAssetView's load effect is keyed on that path — it reads the parked entry to recover
    // its compare-and-swap baseline. Doing the repair first means the panel can never observe a
    // half-repaired registry.
    //
    // ⚠️ Not a live bug today, but NOT for the reason an earlier draft of this comment gave. It
    // said "React's automatic batching guarantees no render interleaves", which is the wrong
    // mechanism: batching governs setState, and the registry reaches the Atlas panel through
    // `useSyncExternalStore`, which React schedules on SyncLane *specifically so it cannot be
    // batched away*. Nothing interleaves because even SyncLane flushes in a microtask at the end
    // of the task — a weaker guarantee than the one that was claimed, and one nobody has
    // observed here either way. The reorder makes the invariant structural so it does not rest
    // on either.
    //
    // ⚠️ This is also ONE move site of several. `pasteClipboard`'s cut branch and `handleFilesDrop`
    // move files and never re-point the Inspector at all — see the
    // move-repair class issue #867. Ordering here does not make the selection correct there.
    applyAssetPathMoves([{ from: asset.path, to: toPath, name: safe }]);
    if (selected === asset.path) { setSelected(toPath); selectAsset({ path: toPath, type: asset.type, name: safe }); }
    refresh();
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
  const getDragPaths = useCallback((asset: AssetEntry): string[] => dragPathsFor(asset.path, selectionRef.current), []);

  const clearSelection = useCallback(() => {
    setSelection(new Set());
    setSelected(null);
    selectAsset(null);
    anchorRef.current = null;
  }, [selectAsset]);

  // Delete a folder (to the OS trash) along with everything under it, in one trash call. Asked
  // first, like every delete: it is not undoable (#1868, D2).
  const handleDeleteFolder = useCallback(async (folderPath: string, folderName: string) => {
    if (folderPath === '/') return;
    const ask = deleteConfirmText([folderPath], { folder: true, ...deletionFootprint([folderPath], [], [...getDirtyAssetPaths(), ...getPendingMetaPaths()], folderPath) });
    if (!await confirmInEditor(ask.title, ask.message, ask.okLabel)) return;
    const trashed = await trashAssetFile(folderPath); // trashes files + the dir shell in one call
    // ⚠️ `ok` only became trustworthy in #884 — it was the HTTP status, and a folder the OS
    // refused answers 200, so this guard could not fire and the branch below pruned the tree,
    // unbound the editors and refreshed for a folder still on disk. It gets the same toast as
    // the file path: a locked folder is something the human can fix and retry.
    if (!trashed.ok) {
      console.error(`[Assets] Failed to delete folder ${folderPath} (HTTP ${trashed.status})`);
      // ⚠️ Does NOT claim the folder is still on disk. `trashAssetFile` refuses a 404 (the folder was already gone — a
      // stale panel after a branch switch or a Finder delete) and a network error as well as a real OS refusal. The
      // message says what is certainly true — the delete did not complete — and the route's own reason (#1824).
      reportGestureRefusal(`Could not delete "${folderName}" — the delete did not complete: ${trashed.error}`);
      return;
    }
    // Prune any client-side folder state for this subtree.
    const prune = (set: Set<string>) => {
      const n = new Set<string>();
      for (const x of set) if (x !== folderPath && !x.startsWith(folderPath + '/')) n.add(x);
      return n;
    };
    setPendingFolders(prune);
    setExpanded(prune);
    setDiskFolders((prev) => prev.filter((x) => x !== folderPath && !x.startsWith(folderPath + '/')));
    // Folder delete does NOT go through executeDeletion, so it needs its own unbind — an
    // editor bound to an asset inside would otherwise autosave the file back and RECREATE
    // the folder along with it (#186).
    // remapCurrentFolder runs from inside applyAssetPathMoves now — see its comment.
    applyAssetPathMoves([{ from: folderPath, to: null, prefix: true }]);
    clearSelection();
    refresh();
  }, [clearSelection, refresh]);

  // The AssetEntry objects currently selected (falls back to the active item).
  // Sprites are dropped — they have no file to act on (fileActionTargets, assetListing.ts).
  const selectedAssets = useCallback((): AssetEntry[] => {
    const inSel = assets.filter((a) => selection.has(a.path));
    if (inSel.length) return fileActionTargets(inSel);
    const a = assets.find((x) => x.path === selected);
    return a ? fileActionTargets([a]) : [];
  }, [assets, selection, selected]);

  const deleteSelection = useCallback(async () => {
    // ONE trash call → one trash sound; ONE rescan.
    await executeDeletion(selectedAssets(), true);
  }, [selectedAssets, executeDeletion]);

  const duplicateSelection = useCallback(async () => {
    const targets = selectedAssets();
    if (targets.length === 0) return;
    const taken = new Set(assets.map((a) => a.path)); // grows as we go so targets stay unique
    let landed = 0;
    for (const a of targets) if (await performDuplicate(a, taken)) landed++;
    if (landed > 0) refresh();
  }, [selectedAssets, assets, performDuplicate, refresh]);

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
    // #1362: a CUT is a move, so the same refusal applies. A COPY is not — it leaves the held asset
    // where it is, so an open editor is no reason to block it.
    if (clipboard.op === 'cut') {
      const cutHeld = assetEditorHoldMessage(clipboard.paths);
      if (cutHeld) { useEditorStore.getState().showToast(cutHeld, 'warn'); return; }
    }
    const done: RelocateMove[] = [];
    // Each item the route refused, with its reason (#1824): the loop used to skip them silently.
    const refused: string[] = [];
    for (const from of clipboard.paths) {
      const to = pastePathIn(targetFolder, from, taken);
      if (to === from) continue; // cut into same folder — no-op
      taken.add(to);
      if (clipboard.op === 'cut') {
        const moved = await moveAsset(from, to);
        if (moved.ok) done.push({ from, to }); else refused.push(`${fileNameOf(from)}: ${moved.error}`);
      } else {
        const dup = await duplicateAsset(from, to);
        if (dup.ok) done.push({ from, to });
        else refused.push(`${fileNameOf(from)}: ${dup.error}`);
      }
    }
    if (refused.length) reportGestureRefusal(`Paste skipped ${refusedItemsText(refused)}`, refused.join('\n'));
    if (done.length === 0) return;
    const op = clipboard.op;
    if (op === 'cut') setClipboard(null);
    // A CUT moves the file, so a bound editor must follow it (#186). A copy/paste creates a
    // NEW file and leaves the original where it is, so nothing bound has moved.
    if (op === 'cut') applyAssetPathMoves(done.map(({ from, to }) => ({ from, to })));
    refresh();
  }, [clipboard, selected, assets, refresh]);

  // ── New Folder + folder rename ──────────────────────────────────────
  const createFolder = useCallback(async (parentFolder: string) => {
    const norm = parentFolder === '/' ? '' : parentFolder;
    const isTaken = (p: string) => isFolderPath(p, { pendingFolders, diskFolders, assets });
    let name = 'New Folder';
    let path = `${norm}/${name}`;
    let n = 2;
    while (isTaken(path)) { name = `New Folder ${n}`; path = `${norm}/${name}`; n++; }
    const made = await createAssetFolder(path);
    if (!made.ok) { reportGestureRefusal(`Could not create a folder under ${parentFolder}: ${made.error}`); return; }
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
  }, [assets, pendingFolders, diskFolders]);

  const commitFolderRename = useCallback(async (node: FolderNode, newName: string) => {
    setRenamingFolderPath(null);
    const safe = newName.trim().replace(/[/\\]/g, '_');
    const parts = node.path.split('/').filter(Boolean);
    if (!safe || safe === parts[parts.length - 1]) return;
    const parent = '/' + parts.slice(0, -1).join('/');
    const newPath = (parent === '/' ? '' : parent) + '/' + safe;
    if (isFolderPath(newPath, { pendingFolders, diskFolders, assets })) {
      console.warn(`[Assets] Folder already exists: ${newPath}`); return;
    }
    // #1362: the fourth move seam, and the one that needs the reason MOST — the held texture is not
    // the thing the user named, so a silent no-op is baffling here.
    const heldFolder = assetEditorHoldMessage([node.path]);
    if (heldFolder) { useEditorStore.getState().showToast(heldFolder, 'warn'); return; }
    const moved = await moveAsset(node.path, newPath);
    if (!moved.ok) { reportGestureRefusal(`Could not rename folder ${node.path}: ${moved.error}`); return; }
    const oldPath = node.path;
    // The remap itself is the seam's now (#867). What stays here is the gesture's own nicety:
    // keep the renamed folder OPEN, which belongs to renaming rather than to the repair.
    setExpanded((p) => new Set(p).add(newPath));
    // The same prefix remap the two lines above do for folder state, for an open editor
    // bound to an asset INSIDE the renamed folder (#186) — every one of them just moved.
    // remapCurrentFolder runs from inside applyAssetPathMoves now — see its comment.
    applyAssetPathMoves([{ from: oldPath, to: newPath, prefix: true }]);
    clearSelection();
    refresh();
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
  // WHAT each key means is decided by `resolveAssetKey` (assetKeyCommands.ts, #105
  // Phase 3) — pure, and unit-tested there. This handler only reads the event and
  // performs the resulting command.
  //
  // This handler is ELEMENT-scoped (on the focusable list container), so unlike the
  // other panels it was already correctly scoped by DOM focus and did not need
  // migrating into the keymap registry (focus-scope refactor P6) — the Hierarchy's
  // document-level rival listener it was written to deny is now gone.
  //
  // stopPropagation still matters: it keeps a claimed key from ALSO reaching the
  // window-level keymap dispatcher. Non-handled keys (e.g. Cmd+Z undo) fall through
  // to it untouched — which is what makes "let unhandled keys pass" work. Note that
  // type-ahead deliberately does NOT claim its key; that is why the resolver reports
  // `preventDefault` separately from the command.
  //
  // TODO(P8): register these in the keymap under the `assets` scope anyway, purely so
  // they are INTROSPECTABLE (Shortcuts panel, menu generation, MCP). Behaviour is
  // already right; only discoverability is missing.
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const { command, preventDefault, typeAhead } = resolveAssetKey({
      key: e.key,
      metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey,
      targetTag: (e.target as HTMLElement).tagName,
      isMac: navigator.platform.includes('Mac'),
      order: visiblePathsRef.current,
      selected,
      anchor: anchorRef.current,
      assets,
      typeAhead: typeAheadRef.current,
      now: performance.now(),
    });
    if (typeAhead) typeAheadRef.current = typeAhead;
    if (preventDefault) { e.preventDefault(); e.stopPropagation(); }

    const find = (p: string | null) => assets.find((x) => x.path === p);
    switch (command.kind) {
      case 'none':
      case 'handled':
        return;
      case 'new-folder': createFolder(defaultTargetFolder()); return;
      case 'clipboard':
        if (command.op === 'paste') pasteClipboard(); else copySelection(command.op);
        return;
      case 'duplicate': duplicateSelection(); return;
      case 'delete': deleteSelection(); return;
      case 'rename': if (command.path) setRenamingPath(command.path); return;
      case 'open': { const a = find(command.path); if (a) handleDoubleClick(a); return; }
      case 'select': {
        if (command.paths) setSelection(new Set(command.paths));
        if (command.anchor !== undefined) anchorRef.current = command.anchor;
        const a = find(command.activate); if (a) activate(a);
        if (command.scrollTo) scrollToPath(command.scrollTo);
        return;
      }
    }
  }, [selected, assets, createFolder, defaultTargetFolder, copySelection, pasteClipboard, duplicateSelection, deleteSelection, handleDoubleClick, activate, scrollToPath]);

  const ctxMenuItems = useCallback((asset: AssetEntry): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    // Number of items the action will apply to (the menu was opened on a row
    // inside the current multi-selection ⇒ act on the whole selection). Counted over FILE rows
    // only (#1257): selected sprite rows are not acted on, and counting them made one texture
    // plus a few sprites read as `many` and hid this file's single-item actions.
    const count = selection.has(asset.path) ? Math.max(1, fileActionPaths(selection, assets).length) : 1;
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
    items.push({ label: 'Reveal in Finder', onClick: () => revealPathInFinder(asset.path) });
    // Inspection, not a mutation — GUID when we have one (the route also accepts a
    // virtual path, but a GUID is the stable address a moved/renamed file keeps).
    if (!many) items.push({ label: 'Find References', onClick: () => openFindReferences(asset.guid || asset.path, asset.name) });
    items.push({ label: `Move to Trash${suffix}`, onClick: () => (many ? deleteSelection() : handleDelete(asset)), danger: true });
    return items;
  }, [handleDelete, handleDuplicate, refresh, reimport, selection, assets, clipboard, duplicateSelection, deleteSelection, copySelection, pasteClipboard, openFindReferences]);

  // Drop handler: entity dragged from Hierarchy → create prefab
  const [dropHighlight, setDropHighlight] = useState<string | null>(null); // folder path being hovered

  // Import files from the OS (file picker or drag-in from Finder) into a folder.
  // Bytes are read as base64 (a JSON asset keeps its id unless the project holds it, #1713) and written via /api/write-file; freshly-imported
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
    const claimed = new Set<string>(); // the ids this batch decided on — see importedFileBytes
    const refused: string[] = []; // each file not imported, with why — said once, on screen (#1824, ruling FA)
    setImportStatus(true, `Importing ${list.length} file(s)…`, 0, list.length);
    try {
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        const { dest, convert, sidecarOf, ambiguous } = plan[i];
        // A sidecar dropped WITH its file is written in that file's request (#2048), not on its own.
        if (sidecarOf) continue;
        if (ambiguous) { refused.push(`${file.name}: the drop holds more than one ${file.name} or more than one of the file it belongs to, so which file it is the sidecar of cannot be told. Any such file was imported with a new identity; delete it, then drop each file with its .meta.json on its own`); continue; }
        setImportStatus(true, file.name, i, list.length);
        // A JSON asset's identity is decided BEFORE the write (#1713), as modoki_import_file decides it — and these
        // are the bytes the redo re-writes, so it never brings the source's id back.
        // Its paired sidecars are named with it in a refusal: they were not imported either.
        const pairedOf = plan.flatMap((p, j) => (p.sidecarOf?.index === i ? [j] : []));
        const named = pairedOf.length ? `${file.name} (with ${pairedOf.map((j) => list[j].name).join(', ')})` : file.name;
        const bytes = await importedFileBytes(dest, await fileToBase64(file), claimed);
        if ('error' in bytes) { refused.push(`${named}: ${bytes.error}`); continue; }
        const content = bytes.content;
        const sidecars = await Promise.all(pairedOf.map((j) => list[j].text().then((text) => ({ suffix: plan[j].sidecarOf!.suffix, content: text }))));
        // Only into an EMPTY path (#1784): `dest` was planned against the listing, not the disk.
        const wrote = await writeDroppedImport(dest, content, sidecars);
        if (wrote.result === 'taken') { refused.push(`${named}: a file appeared at ${dest} since the panel listed the folder, and it was left as it is — drop it again to import it as a copy`); continue; }
        if (wrote.result === 'failed') { refused.push(`${named}: ${wrote.error}`); continue; }
        imported.push({ path: dest, content, convert });
        setImportStatus(true, file.name, i + 1, list.length);
      }
    } finally {
      setImportStatus(false);
    }
    if (refused.length) reportGestureRefusal(`Not imported: ${refusedItemsText(refused)}`, refused.join('\n'));
    if (!imported.length) return;
    console.log(`[Assets] Imported ${imported.length} file(s) → ${target}`);
    // Convert any freshly-imported textures/models through the asset pipeline.
    // A follow-up the import started itself, so a failed convert is background work: the console, with the route's
    // reason (#1824, ruling FA) — it used to be discarded outright. The file itself did land.
    for (const f of imported) {
      if (f.convert) {
        const problem = reimportProblem(await reimportAsset(f.path, { recursive: false }));
        if (problem) reportBackgroundRefusal(`[Assets] ${f.path} was imported but not converted: ${problem}`);
      }
    }
    refresh();
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

    // Determine save path — the drop-target folder, or (category view, which has none) a writable root's /prefabs, as
    // the Hierarchy's Create Prefab does. The fallback was a bare `/prefabs/…`, which is under no asset root, so a drop
    // in category view wrote nothing (#1776, observed). Everything else (serialize → write → register/cache/tag → undo
    // descriptor) is shared with the Hierarchy flow via createPrefabFromEntity (F7); only refresh() is layered on here.
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    let folder = targetFolder;
    if (!folder) {
      const root = await readWritableAssetRoot();
      if (!root.ok) { reportGestureRefusal(`Create Prefab failed — the asset roots could not be read: ${root.error}`); return; }
      folder = root.root ? `${root.root}/prefabs` : undefined;
    }
    if (!folder) { useEditorStore.getState().showToast('Create Prefab failed — this project has no writable asset root.', 'warn'); return; }
    const savePath = `${folder}/${safeName}.prefab.json`;

    // Asked when a prefab of that name is already in the folder; a Replace keeps its guid (#1264).
    const result = await createPrefabFromEntity(id, savePath, `Save prefab "${name}"`, confirmReplaceAsset);
    if (result === 'declined') return;
    if (result && 'refused' in result) { useEditorStore.getState().showToast(result.refused, 'warn'); return; }
    console.log(`[Assets] Created prefab: ${savePath}`);
    if (result.unlinked) useEditorStore.getState().showToast(result.unlinked, 'warn');
    if (result.runtimeExcluded > 0) useEditorStore.getState().showToast(runtimeExcludedMessage(result.runtimeExcluded), 'warn');
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
  // are skipped silently — they're mis-drops, not errors.
  const handleFilesDrop = useCallback(async (filePaths: string[], targetFolder: string) => {
    // The DECISION (which drops are skipped, where each lands, and whether it is a FOLDER move)
    // is pure and lives in `planFilesDropMoves`; only the awaited backend call stays here. A
    // dragged folder gets `prefix: true` — without it the repair below matched the folder itself
    // and returned `undefined` for every file under it (#867 member 2).
    const known = { pendingFolders, diskFolders, assets };
    // #1257 — a multi-drag carries the whole selection, sprite rows included (the asset-paths payload
    // needs them), but a sprite has no file to move: each one 404'd and logged "Could not move".
    const planned = planFilesDropMoves(fileActionPaths(filePaths, assets), targetFolder, (p) => isFolderPath(p, known));
    // #1362: refuse the WHOLE drop when a texture editor holds unsaved edits on anything in it,
    // rather than moving the other items and leaving that one behind — a half-applied drag is worse
    // to undo than one that did not start. The backend refuses the move itself; this is the reason.
    const dropHeld = assetEditorHoldMessage(planned.map((m) => m.from));
    if (dropHeld) { useEditorStore.getState().showToast(dropHeld, 'warn'); return; }
    const moves: RelocateMove[] = [];
    const refused: string[] = [];
    for (const m of planned) {
      // `moveAsset(from, TO)`, not `moveFile(from, FOLDER)`: the planner has already derived the
      // destination, and letting the mover derive its own would be two independent computations
      // of one value. They agree today; the day `moveFile` grows a collision-suffix rule (as
      // `pastePathIn` already has) the planner's `to` silently becomes a lie, and the binding
      // repair below would follow a path the file is not at — the forking bug.
      const moved = await moveAsset(m.from, m.to);
      if (!moved.ok) { refused.push(`${fileNameOf(m.from)}: ${moved.error}`); continue; }
      moves.push(m);
    }
    if (refused.length) reportGestureRefusal(`Could not move ${refusedItemsText(refused)}`, refused.join('\n'));
    if (moves.length === 0) return;
    console.log(`[Assets] Moved ${moves.length} item(s) → ${targetFolder}`);
    // Drag-drop into a folder is a MOVE like any other, so a bound editor must follow it
    // (#186). This site uses `moveFile` (folder-target) rather than `moveFileTo`
    // (explicit-path) — which is exactly why the first sweep for this bug missed it.
    applyAssetPathMoves(moves);
    refresh();
  }, [refresh, pendingFolders, diskFolders, assets]);

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

  // Sliced sprites are nested UNDER their source texture (Unity-style sub-assets) —
  // index them by parent texture GUID — unless the `sprite` chip makes them rows (#1249).
  // The list-shaping decisions live in assetListing.ts (#105 Phase 3) — pure, and
  // unit-tested there rather than only through e2e.
  const spritesByTexture = useMemo(() => spritesByTextureOf(assets, typeFilter), [assets, typeFilter]);
  const filtered = useMemo(() => filterAssets(assets, filter, typeFilter), [assets, filter, typeFilter]);
  const flatTotal = useMemo(() => flatAssetTotal(assets, filter, typeFilter), [assets, filter, typeFilter]);
  const grouped = useMemo(() => groupByType(filtered), [filtered]);

  // Folder view: build tree (seeded with empty pending folders)
  const folderTree = useMemo(() => buildFolderTree(filtered, [...pendingFolders, ...diskFolders]), [filtered, pendingFolders, diskFolders]);
  // The node the "Assets" section renders from — redundant single-folder wrappers
  // collapsed away (see effectiveAssetsRoot). Its children are the category folders.
  const assetsRoot = useMemo(() => effectiveAssetsRoot(folderTree), [folderTree]);

  // Visible asset paths in on-screen order — drives shift-range + arrow-key
  // navigation and Cmd+A. Must mirror the render; see assetListing.visibleOrder.
  const visiblePaths = useMemo(
    () => visibleOrder({ viewMode, grouped, assetsRoot, expanded }),
    [viewMode, grouped, assetsRoot, expanded],
  );
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
            onClear={() => setTypeFilter(() => new Set())}
            uiId="assets.toolbar.typeFilter"
          />
        )}
        <div style={toolbarDividerStyle} />
        {/* — Create / add: the full Create menu (New Folder, Create Material/Particle/…),
            New Folder, Import. QA-ASSET-0030: right-click-empty-space is the only OTHER path
            to this menu, and a large project's asset tree fills the panel — no empty space
            survives to right-click, and scrolling to the bottom doesn't create any (the last
            row sits directly above the status bar). This button is a position-independent
            path to the SAME menu (`setFolderCtx`), so it works regardless of tree size.
            `createOnly: true` (close-out review): the row-menu builder below suppresses
            Rename/Delete/Re-import-all/Reveal for `assetsRoot.path`, matching the SAME check
            the existing Assets-header right-click already relies on — but THIS button targets
            `defaultTargetFolder()` (wherever the user is currently working), which is usually a
            REAL folder the suppression does not cover. Without the flag, "+" on a selected
            texture opened Delete on that texture's folder with no confirmation dialog. */}
        <button
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setFolderCtx({ x: r.left, y: r.bottom, path: defaultTargetFolder(), name: 'Assets', createOnly: true });
          }}
          title="Create…"
          data-ui-id="assets.toolbar.create" data-ui-kind="button" data-ui-label="create"
          style={toolbarBtnStyle}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ display: 'block' }}>
            <path d="M7 1h2v6h6v2H9v6H7V9H1V7h6V1z"/>
          </svg>
        </button>
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
          onClick={refreshAll}
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
        // Right-clicking empty background (either view) reaches the Create menu — it used
        // to be reachable ONLY via a folder row's context menu, so category view (which has
        // no folder rows) had no way to create anything. Targets defaultTargetFolder() (the
        // same fallback chain a toolbar "New" action would use), not a specific folder.
        onContextMenu={(e) => { if (e.target === e.currentTarget) handleFolderContextMenu(e, defaultTargetFolder(), 'Assets'); }}
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
                onContextMenu={(e) => handleFolderContextMenu(e, defaultTargetFolder(), 'Assets')}
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

      {/* Footer — a type filter narrowing the list gets a distinct, clickable-to-clear
          callout (not just the dim count text) so a stale filter from a past session
          can't silently hide most of a project's assets with no visible sign. */}
      <div style={{ padding: '4px 8px', borderTop: '1px solid #333', color: '#555', fontSize: '10px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>
          {selection.size > 1
            ? `${selection.size} selected`
            : (selected || (filtered.length !== flatTotal
                ? `${filtered.length} of ${flatTotal} assets`
                : `${flatTotal} assets`))}
        </span>
        {typeFilter.size > 0 && (
          <span
            onClick={() => setTypeFilter(() => new Set())}
            title="A type filter is active, hiding non-matching assets — click to clear"
            data-ui-id="assets.toolbar.typeFilterBanner" data-ui-kind="button" data-ui-label="clear type filter"
            style={{ color: '#5a8ec5', cursor: 'pointer', textDecoration: 'underline' }}
          >
            type filter active ✕
          </span>
        )}
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
            // Read live at menu-open time (not memoized) so a late-registering game's
            // entries show up without a remount — see creatableAssets.ts.
            ...getCreatableAssets().map((d) => ({ label: d.label, onClick: () => runCreate(d, folderCtx.path) })),
            { label: 'Import Files…', onClick: () => { setCurrentFolder(folderCtx.path); importTargetRef.current = folderCtx.path; fileInputRef.current?.click(); } },
            // `createOnly` (the toolbar Create button, close-out review): this menu's `path` is
            // wherever the user is currently working, not necessarily the Assets root the
            // '/' / assetsRoot.path check below assumes — so a folder-scoped action here would
            // reach a REAL folder without ever having been an intentional right-click on it.
            ...(!folderCtx.createOnly && folderCtx.path !== '/' && folderCtx.path !== assetsRoot.path ? [{ label: 'Rename', onClick: () => setRenamingFolderPath(folderCtx.path) }] : []),
            ...(!folderCtx.createOnly && folderCtx.path !== '/' && folderCtx.path !== assetsRoot.path ? [{ label: 'Delete', onClick: () => handleDeleteFolder(folderCtx.path, folderCtx.name) }] : []),
            ...(!folderCtx.createOnly && clipboard ? [{ label: `Paste${clipboard.paths.length > 1 ? ` (${clipboard.paths.length})` : ''}`, onClick: () => pasteClipboard(folderCtx.path) }] : []),
            ...(!folderCtx.createOnly ? [{ label: 'Re-import all (recursive)', onClick: () => reimport(folderCtx.path, true) }] : []),
            ...(!folderCtx.createOnly ? [{ label: 'Reveal in Finder', onClick: () => revealPathInFinder(folderCtx.path) }] : []),
          ]}
          x={folderCtx.x}
          y={folderCtx.y}
          onClose={() => setFolderCtx(null)}
        />
      )}

      {/* Re-import all confirmation — guards a potentially slow full reconvert. */}
      {confirmReimportAll && (
        <ModalShell kind="reimport-all-confirm" onDismiss={() => setConfirmReimportAll(false)}>
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
        </ModalShell>
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
            { label: 'Reveal in Finder', onClick: () => revealPathInFinder(ctx.asset.path) },
          ]}
          x={ctx.x} y={ctx.y} onClose={() => setCtx(null)}
        />
      )}
    </div>
  );
});

