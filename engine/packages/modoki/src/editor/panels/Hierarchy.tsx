/** Hierarchy — shows ECS entities as a tree with parent-child relationships */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { onWorldSwap } from '../../runtime/ecs/world';
import { getAllTraits, getTraitByName, COMPONENT_CATEGORY_ORDER } from '../../runtime/ecs/traitRegistry';
import { getAllEntities, buildEntityTree, deleteEntity, onStructureDirtyCoalesced, getStructureVersion, writeTraitField, readTraitData, subtreeIds, type EntityInfo } from '../../runtime/ecs/entityUtils';
import { flattenVisibleIds, rangeBetween } from './hierarchySelection';
import { deleteEntitiesWithUndo, duplicateEntity, reparentEntity, createEntityWithUndo as createEntityAction, writeTraitFieldWithUndo, writeTraitFieldMultiWithUndo, writeTraitFieldPerEntityWithUndo, snapshotEntity, respawnFromSnapshot, regenerateSnapshotGuids, classifyPrefabDuplicate, stripPrefabInstanceFromSnapshot, reRootPrefabInstanceSubtree, type EntitySnapshot } from '../undo/entityActions';
import { entityRef } from '../undo/entityRef';
import { instantiatePrefabAsync, setPrefabSource, detachPrefabInstance, reattachPrefabInstance, type PrefabFile } from '../scene/prefab';
import { focusEntityInSceneView } from '../scene/sceneViewBus';
import { getCurrentScenePath } from '../scene/serialize';
import { useEditorStore } from '../store/editorStore';
import { pushAction } from '../undo/undoManager';
import { makePrefabInstantiateAction } from '../undo/prefabInstantiateUndo';
import { makeReorderSiblingsAction, diffSiblingSorts } from '../undo/reorderSiblingsUndo';
import ContextMenu, { type ContextMenuItem } from '../components/ContextMenu';
import RenameInput from '../components/RenameInput';
import { TreeSearchInput, TypeFilterMenu, treeRowPadLeft } from './treeChrome';
import { useExpandedSet } from './useExpandedSet';
import { remapPrefix } from '../utils/assetPaths';
import { filterEntityTree, collectEntityTypes, normalizeFolderPath, buildHierarchyFolders, countFolderRoots, folderSubtreePaths, folderSubtreeRootIds, revealTargetsFor, type HierarchyFolder } from './hierarchyFolders';
import { startDragGhost, endDragGhost, armGrabCursor } from '../utils/dragGhost';
import { PRIMITIVE_NAMES } from '../../runtime/loaders/primitives';
import { type UiPreset } from '../uiAuthoring';
import {
  emptySpecs, primitiveSpecs, shape2DSpecs, canvas2DSpecs, uiSpecs, cameraSpecs, lightSpecs, environmentSpecs, particleSpecs,
  type LightKind,
} from '../entityCreateSpecs';
// Backend-IO + create-prefab flow shared with the Assets panel (editor-panels
// F6/F7): new prefab files must land under a *real* writable asset root —
// virtual tree nodes like "/" aren't writable. firstWritableAssetRoot + root
// matching live in assetOps/assetRoots so the flat-project "/assets" prefix
// can't be forgotten in one copy again (#29).
import { firstWritableAssetRoot, createPrefabFromEntity } from './assetOps';

type DropZone = 'before' | 'child' | 'after' | null;

// ── Empty-folder persistence (editor-local, per scene) ──
// A folder is normally DERIVED from tagged roots, so a brand-new EMPTY folder has
// nowhere to live in the scene. We remember such folders' paths in localStorage,
// keyed by scene path, and feed them to buildHierarchyFolders so they render + survive
// reload. Once a root is dropped in, the folder is scene-backed and its marker is pruned.
const EMPTY_FOLDERS_LS_KEY = 'editor:hierarchy:emptyFolders:v1';
function loadEmptyFoldersMap(): Record<string, string[]> {
  try { const raw = localStorage.getItem(EMPTY_FOLDERS_LS_KEY); const o = raw ? JSON.parse(raw) : {}; return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
function loadEmptyFolders(scenePath: string): Set<string> {
  const arr = loadEmptyFoldersMap()[scenePath];
  return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
}
function saveEmptyFolders(scenePath: string, set: Set<string>) {
  if (!scenePath) return;
  try {
    const map = loadEmptyFoldersMap();
    if (set.size) map[scenePath] = [...set]; else delete map[scenePath];
    localStorage.setItem(EMPTY_FOLDERS_LS_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

// ── Entity collapse persistence (editor-local, per scene, keyed by GUID) ──
// Expand/collapse is per-user VIEW state, so it lives in localStorage — NOT the scene
// file (would churn + isn't scene data). Keyed by EntityAttributes.guid so it survives
// the runtime-id reassignment on every scene reload / Play→Stop. Per scene path, mirroring
// the empty-folders map above. A saved (even empty) array = "this scene has been seen"
// (all-expanded is remembered); a MISSING entry = never seen → collapse-all default.
const ENTITY_COLLAPSE_LS_KEY = 'editor:hierarchy:entityCollapsed:v1';
function loadCollapseMap(): Record<string, string[]> {
  try { const raw = localStorage.getItem(ENTITY_COLLAPSE_LS_KEY); const o = raw ? JSON.parse(raw) : {}; return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
function loadCollapsedGuids(scenePath: string): string[] | null {
  if (!scenePath) return null;
  const arr = loadCollapseMap()[scenePath];
  return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : null;
}
function saveCollapsedGuids(scenePath: string, guids: string[]) {
  if (!scenePath) return;
  try {
    const map = loadCollapseMap();
    map[scenePath] = guids;
    localStorage.setItem(ENTITY_COLLAPSE_LS_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

/** Empty collapsed-set reused while a search/type filter is active so every kept
 *  node renders expanded (matches can sit arbitrarily deep). Stable identity so the
 *  memoized EntityNode comparator treats "filtering" as one unchanging collapsed set. */
const NO_COLLAPSE: Set<number> = new Set();

/** A collapsible, interactive Hierarchy folder row: caret · 📁 · name · count, with
 *  entity/asset drop, a right-click menu, and inline rename. Bespoke (not treeChrome's
 *  read-only TreeFolderRow) because it needs drop + rename, mirroring how the Assets
 *  FolderView is the interactive superset of the shared row. */
function HierarchyFolderRow({ node, depth, open, count, selected, renaming, onToggle, onSelect, onContextMenu, onDropEntity, onDropAsset, onDropFolder, onCommitRename, onCancelRename }: {
  node: HierarchyFolder;
  depth: number;
  open: boolean;
  count: number;
  selected: boolean;
  renaming: boolean;
  onToggle: (recursive: boolean) => void;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDropEntity: (entityId: number) => void;
  onDropAsset: (e: React.DragEvent) => void;
  onDropFolder: (srcPath: string) => void;
  onCommitRename: (newName: string) => void;
  onCancelRename: () => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      onClick={(e) => { if (!renaming) { onSelect(); onToggle(e.altKey); } }}
      title="Click to expand/collapse · Alt-click for the whole folder subtree"
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e); }}
      draggable={!renaming}
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.setData('application/editor-folder', JSON.stringify({ path: node.path }));
        e.dataTransfer.effectAllowed = 'move';
        startDragGhost(e, `📁 ${node.name}`);
      }}
      onDragEnd={endDragGhost}
      onDragOver={(e) => {
        const isEntity = e.dataTransfer.types.includes('application/editor-entity');
        const isAsset = e.dataTransfer.types.includes('application/editor-asset');
        const isFolder = e.dataTransfer.types.includes('application/editor-folder');
        if (!isEntity && !isAsset && !isFolder) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = isAsset ? 'copy' : 'move';
        setOver(true);
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        if (e.dataTransfer.types.includes('application/editor-asset')) { onDropAsset(e); return; }
        const folderRaw = e.dataTransfer.getData('application/editor-folder');
        if (folderRaw) { onDropFolder((JSON.parse(folderRaw) as { path: string }).path); return; }
        const raw = e.dataTransfer.getData('application/editor-entity');
        if (raw) onDropEntity((JSON.parse(raw) as { id: number }).id);
      }}
      style={{
        padding: '3px 8px', paddingLeft: treeRowPadLeft(depth), cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 4,
        background: over ? 'rgba(52, 152, 219, 0.35)' : selected ? 'rgba(52, 152, 219, 0.22)' : '#2a2a40',
        boxShadow: selected ? 'inset 2px 0 0 #3498db' : 'none',
        userSelect: 'none', whiteSpace: 'nowrap',
      }}
    >
      <span style={{ color: '#888', fontSize: 10, width: 10, textAlign: 'center' }}>{open ? '▼' : '▶'}</span>
      <span style={{ color: '#f0c040', fontSize: 11 }}>📁</span>
      {renaming ? (
        <RenameInput initial={node.name} onCommit={onCommitRename} onCancel={onCancelRename} />
      ) : (
        <span style={{ color: '#ddd', flex: 1 }}>{node.name}</span>
      )}
      <span style={{ color: '#555', fontSize: 10, marginLeft: 2 }}>({count})</span>
    </div>
  );
}

interface EntityNodeProps {
  entity: EntityInfo;
  depth: number;
  /** Primary (anchor) selection — styled distinctly from secondary members. */
  selectedId: number | null;
  /** Full multi-selection set (includes the primary). */
  selectedIds: Set<number>;
  onSelect: (id: number, e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent, entity: EntityInfo) => void;
  onReparent: (entityId: number, newParentId: number, sortOrder?: number) => void;
  onPrefabDrop: (e: React.DragEvent, parentId: number) => void;
  collapsed: Set<number>;
  onToggle: (id: number, recursive?: boolean) => void;
  prevSiblingSort: number | null;
  nextSiblingSort: number | null;
  parentLayer?: string;
  parentHasCanvas2D?: boolean;
  renamingId: number | null;
  onCommitRename: (id: number, name: string) => void;
  onCancelRename: () => void;
}

const EntityNode = React.memo(function EntityNode({ entity, depth, selectedId, selectedIds, onSelect, onContextMenu, onReparent, onPrefabDrop, collapsed, onToggle, prevSiblingSort, nextSiblingSort, parentLayer, parentHasCanvas2D, renamingId, onCommitRename, onCancelRename }: EntityNodeProps) {
  const isRenaming = renamingId === entity.id;
  const hasChildren = entity.children && entity.children.length > 0;
  const isCollapsed = collapsed.has(entity.id);
  // isSelected = member of the multi-selection set; isPrimary = the anchor.
  const isSelected = selectedIds.has(entity.id);
  const isPrimary = selectedId === entity.id;
  const isPrefab = entity.traits.includes('PrefabInstance');
  // 2d entities under a Canvas2D parent (ui layer) are valid — not a mismatch
  const layerMismatch = !!(parentLayer && entity.layer && entity.layer !== parentLayer
    && !(entity.layer === '2d' && parentHasCanvas2D));
  const [dropZone, setDropZone] = useState<DropZone>(null);

  /** Detect which zone the cursor is in: top 25% = before, middle 50% = child, bottom 25% = after */
  const detectZone = (e: React.DragEvent): DropZone => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height;
    if (y < h * 0.25) return 'before';
    if (y > h * 0.75) return 'after';
    return 'child';
  };

  return (
    <>
      <div
        // Addressable so a selection made OUTSIDE the panel (viewport click, undo, an
        // agent's set-selection) can scroll this row into view — see revealSelected.
        data-entity-row={entity.id}
        onClick={(e) => onSelect(entity.id, e)}
        onDoubleClick={(e) => { if (hasChildren) onToggle(entity.id, e.altKey); }}
        onContextMenu={(e) => onContextMenu(e, entity)}
        onMouseDown={(e) => { if (isSelected) armGrabCursor(e); }}
        onMouseUp={() => document.body.classList.remove('editor-mousedown')}
        draggable={!isRenaming}
        onDragStart={(e) => {
          e.dataTransfer.setData('application/editor-entity', JSON.stringify({
            id: entity.id, name: entity.name, parentId: entity.parentId, sortOrder: entity.sortOrder,
          }));
          e.dataTransfer.effectAllowed = 'copyMove';
          startDragGhost(e, entity.name);
        }}
        onDragEnd={endDragGhost}
        onDragOver={(e) => {
          const isEntity = e.dataTransfer.types.includes('application/editor-entity');
          const isAsset = e.dataTransfer.types.includes('application/editor-asset');
          if (!isEntity && !isAsset) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = isAsset ? 'copy' : 'move';
          setDropZone(isAsset ? 'child' : detectZone(e));
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropZone(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const zone = detectZone(e);
          setDropZone(null);
          // Prefab drop from Assets → instantiate as child of this entity
          if (e.dataTransfer.types.includes('application/editor-asset')) {
            onPrefabDrop(e, entity.id);
            return;
          }
          const raw = e.dataTransfer.getData('application/editor-entity');
          if (!raw) return;
          const { id } = JSON.parse(raw) as { id: number };
          if (id === entity.id) return;

          if (zone === 'child') {
            // Drop ON entity → make child (append at end)
            const lastChild = entity.children?.length ? entity.children[entity.children.length - 1] : null;
            const newSort = lastChild ? lastChild.sortOrder + 1 : 0;
            onReparent(id, entity.id, newSort);
          } else {
            // Drop before/after → same parent, place between neighbors. If the two
            // neighbors collide (e.g. legacy entities all have sortOrder 0), renumber
            // siblings first so we can compute a unique midpoint.
            const targetParent = entity.parentId;
            const loSort = zone === 'before' ? prevSiblingSort : entity.sortOrder;
            const hiSort = zone === 'before' ? entity.sortOrder : nextSiblingSort;
            const collides = loSort !== null && hiSort !== null && loSort === hiSort;
            if (collides) {
              const eaMeta = getAllTraits().find(t => t.name === 'EntityAttributes');
              if (eaMeta) {
                const siblings = getAllEntities()
                  .filter(e => e.parentId === targetParent && e.id !== id)
                  .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
                // Renumber as ONE undoable entry (snapshot old sorts → restore on
                // undo). Previously a raw writeTraitField loop bypassed undo, so
                // Cmd+Z left every sibling rewritten (Hierarchy F1). Pushed before
                // the reparent so undo peels reparent → renumber in order.
                const changes = diffSiblingSorts(
                  siblings.map((s, i) => ({ id: s.id, oldSort: s.sortOrder, newSort: i * 10 })),
                );
                if (changes.length) {
                  const action = makeReorderSiblingsAction(
                    changes,
                    (eid, sort) => writeTraitField(eid, eaMeta, 'sortOrder', sort),
                    'Renumber siblings',
                  );
                  action.redo(); // apply the renumber now
                  pushAction(action); // make it undoable
                }
              }
              const flat = getAllEntities();
              const updatedEntity = flat.find(e => e.id === entity.id);
              const updatedSort = updatedEntity?.sortOrder ?? 0;
              const newSort = zone === 'before' ? updatedSort - 5 : updatedSort + 5;
              onReparent(id, targetParent, newSort);
            } else {
              const newSort = zone === 'before'
                ? ((prevSiblingSort ?? entity.sortOrder - 2) + entity.sortOrder) / 2
                : (entity.sortOrder + (nextSiblingSort ?? entity.sortOrder + 2)) / 2;
              onReparent(id, targetParent, newSort);
            }
          }
        }}
        style={{
          padding: '3px 10px',
          paddingLeft: 10 + depth * 16,
          cursor: isSelected ? 'grab' : 'default',
          position: 'relative',
          background: dropZone === 'child' ? 'rgba(52, 152, 219, 0.3)' : isPrimary ? '#3a3a5c' : isSelected ? '#33334a' : isPrefab ? 'rgba(52, 152, 219, 0.08)' : 'transparent',
          borderLeft: isPrimary ? '3px solid #f1c40f' : isSelected ? '3px solid rgba(241, 196, 15, 0.45)' : '3px solid transparent',
          borderTop: dropZone === 'before' ? '2px solid #3498db' : '2px solid transparent',
          borderBottom: dropZone === 'after' ? '2px solid #3498db' : '2px solid transparent',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {/* Expand/collapse toggle */}
        {hasChildren ? (
          <span
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onToggle(entity.id, e.altKey); }}
            title="Click to expand/collapse · Alt-click for all descendants"
            style={{ color: '#888', fontSize: '10px', cursor: 'pointer', width: 20, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 3, flexShrink: 0 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.1)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            {isCollapsed ? '▶' : '▼'}
          </span>
        ) : (
          <span style={{ width: 20, flexShrink: 0 }} />
        )}
        {isPrefab && <span style={{ color: '#3498db', fontSize: '10px', fontWeight: 'bold' }}>P</span>}
        {layerMismatch && <span style={{ color: '#e74c3c', fontSize: '10px' }} title={`Layer mismatch: ${entity.layer} child under ${parentLayer} parent`}>⚠</span>}
        {isRenaming ? (
          <RenameInput
            initial={entity.name}
            onCommit={(name) => onCommitRename(entity.id, name)}
            onCancel={onCancelRename}
          />
        ) : (
          <span style={{ color: isSelected ? '#fff' : isPrefab ? '#5dade2' : '#bbb', flex: 1 }}>{entity.name}</span>
        )}
        {entity.isResource && <span style={{ color: '#888', fontSize: '9px', fontWeight: 'bold' }}>R</span>}
        {entity.layer && <span style={{ color: layerColor[entity.layer], fontSize: '9px', fontWeight: 'bold' }}>{entity.layer.toUpperCase()}</span>}
        <span style={{ color: '#555', fontSize: '10px' }}>{entity.traits.length}</span>
      </div>

      {/* Children */}
      {hasChildren && !isCollapsed && entity.children!.map((child, i, arr) => (
        <EntityNode
          key={child.id}
          entity={child}
          depth={depth + 1}
          selectedId={selectedId}
          selectedIds={selectedIds}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          onReparent={onReparent}
          onPrefabDrop={onPrefabDrop}
          collapsed={collapsed}
          onToggle={onToggle}
          prevSiblingSort={i > 0 ? arr[i - 1].sortOrder : null}
          nextSiblingSort={i < arr.length - 1 ? arr[i + 1].sortOrder : null}
          parentLayer={entity.layer}
          parentHasCanvas2D={entity.traits.includes('Canvas2D')}
          renamingId={renamingId}
          onCommitRename={onCommitRename}
          onCancelRename={onCancelRename}
        />
      ))}
    </>
  );
}, (prev, next) => {
  if (prev.entity.id !== next.entity.id) return false;
  if (prev.entity.name !== next.entity.name) return false;
  // Re-render when THIS node enters/leaves rename mode.
  if ((prev.renamingId === prev.entity.id) !== (next.renamingId === next.entity.id)) return false;
  if (prev.entity.traits.length !== next.entity.traits.length) return false;
  if (prev.entity.children?.length !== next.entity.children?.length) return false;
  if (prev.depth !== next.depth) return false;
  // Re-render only when THIS node's selection state (membership or primary) flips.
  if (prev.selectedIds.has(prev.entity.id) !== next.selectedIds.has(next.entity.id)) return false;
  if ((prev.selectedId === prev.entity.id) !== (next.selectedId === next.entity.id)) return false;
  if (prev.onSelect !== next.onSelect) return false;
  if (prev.onContextMenu !== next.onContextMenu) return false;
  if (prev.onReparent !== next.onReparent) return false;
  // onPrefabDrop is a stable useCallback today (never changes), but it was the one
  // handler prop the comparator omitted — compare it so a future dependency on it can't
  // leave deep nodes calling a stale closure. (F13)
  if (prev.onPrefabDrop !== next.onPrefabDrop) return false;
  if (prev.collapsed !== next.collapsed) return false;
  if (prev.onToggle !== next.onToggle) return false;
  if (prev.prevSiblingSort !== next.prevSiblingSort) return false;
  if (prev.nextSiblingSort !== next.nextSiblingSort) return false;
  if (prev.parentLayer !== next.parentLayer) return false;
  if (prev.parentHasCanvas2D !== next.parentHasCanvas2D) return false;
  return true;
});

export default function Hierarchy() {
  const selectedId = useEditorStore((s) => s.selectedEntityId);
  const selectedEntityIds = useEditorStore((s) => s.selectedEntityIds);
  const selectEntity = useEditorStore((s) => s.selectEntity);
  const setSelectedEntities = useEditorStore((s) => s.setSelectedEntities);
  const toggleEntitySelection = useEditorStore((s) => s.toggleEntitySelection);
  const [tree, setTree] = useState<EntityInfo[]>([]);
  const [entityCount, setEntityCount] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  /** Scroll container for the entity tree — used to reveal the selected row. */
  const listRef = useRef<HTMLDivElement>(null);
  /** Bumped whenever the collapse set is restored/reset, so the reveal effect re-opens the selection. */
  const [collapseEpoch, setCollapseEpoch] = useState(0);

  // ── Search + type filter (mirrors the Assets panel) ──
  // `filter` = name substring (case-insensitive); `typeFilter` = selected component
  // types, AND-combined with the name match. Both ephemeral (entity component types
  // vary per scene, so persisting a trait filter across scenes would mislead).
  const [filter, setFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
  const isFiltering = filter.trim() !== '' || typeFilter.size > 0;

  const availableTypes = useMemo(() => collectEntityTypes(tree), [tree]);

  const toggleTypeFilter = useCallback((type: string) => {
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  }, []);

  // Pruned view: name match AND (no type chip active OR entity has a selected type),
  // keeping ancestors of matches. `tree` stays the source of truth for structure edits.
  const displayTree = useMemo(() => {
    if (!isFiltering) return tree;
    const q = filter.trim().toLowerCase();
    const hasType = typeFilter.size > 0;
    const pred = (e: EntityInfo) =>
      (!q || e.name.toLowerCase().includes(q)) &&
      (!hasType || e.traits.some((t) => typeFilter.has(t)));
    return filterEntityTree(tree, pred);
  }, [tree, isFiltering, filter, typeFilter]);

  // While filtering, force every kept node visible (ignore the user's collapse set).
  const effectiveCollapsed = isFiltering ? NO_COLLAPSE : collapsed;

  // ── Folder grouping ──
  // Derive the folder tree from the display roots' editorFolder tags. `folders` are
  // nestable collapsible rows; `ungrouped` roots render at the top level as before —
  // so a scene with zero tags looks exactly like it always has.
  // Active scene path — keys per-scene empty-folder persistence; re-read on world swap.
  const [scenePath, setScenePath] = useState<string>(() => getCurrentScenePath() || '');
  useEffect(() => onWorldSwap(() => setScenePath(getCurrentScenePath() || '')), []);

  // Empty (just-created, rootless) folders — editor-local, persisted per scene. Loaded
  // when the scene changes, saved on every mutation.
  const [emptyFolders, setEmptyFolders] = useState<Set<string>>(() => loadEmptyFolders(getCurrentScenePath() || ''));
  useEffect(() => { setEmptyFolders(loadEmptyFolders(scenePath)); }, [scenePath]);
  useEffect(() => { saveEmptyFolders(scenePath, emptyFolders); }, [scenePath, emptyFolders]);

  // The folder path currently selected in the panel (for "New Folder" placement +
  // highlight). Folders aren't entities, so this is separate from entity selection.
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);

  const { folders, ungrouped } = useMemo(() => buildHierarchyFolders(displayTree, emptyFolders), [displayTree, emptyFolders]);
  // Collapsed-folder state (localStorage). Membership = collapsed, so a brand-new /
  // untracked folder defaults to EXPANDED (empty set = all open).
  const { expanded: collapsedFolders, setExpanded: setCollapsedFolders, toggle: toggleFolder } = useExpandedSet('editor:hierarchy:foldersCollapsed:v1');
  // The folder path currently in inline-rename mode (Finder-style: create → rename).
  const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(null);
  // All folder paths currently in use (from the FULL tree, not the filtered view) so
  // new-folder naming + rename collision checks see every folder — tagged AND empty.
  const usedFolderPaths = useMemo(() => {
    const s = new Set<string>();
    for (const r of tree) { const f = normalizeFolderPath(r.editorFolder || ''); if (f) s.add(f); }
    for (const p of emptyFolders) s.add(p);
    return s;
  }, [tree, emptyFolders]);

  // Prune empty-folder markers that have become scene-backed (a root now lives in the
  // folder or a descendant), so they don't linger / resurrect when later emptied.
  useEffect(() => {
    setEmptyFolders((prev) => {
      if (!prev.size) return prev;
      const tagged = new Set<string>();
      for (const r of tree) { const f = normalizeFolderPath(r.editorFolder || ''); if (f) tagged.add(f); }
      const next = new Set([...prev].filter((p) => !(tagged.has(p) || [...tagged].some((u) => u.startsWith(p + '/')))));
      return next.size === prev.size ? prev : next;
    });
  }, [tree]);

  // Drop the folder selection when it no longer names a live folder (deleted/renamed).
  useEffect(() => {
    if (selectedFolderPath !== null && !usedFolderPaths.has(selectedFolderPath)) setSelectedFolderPath(null);
  }, [usedFolderPaths, selectedFolderPath]);

  // Refresh entity tree on structural changes (create/delete/reparent)
  const prevVersionRef = useRef(-1);
  // True until the Hierarchy collapse state has been restored for the CURRENT world.
  // Set on mount + every world swap; cleared by a SETTLED refresh (see below). Also gates
  // the persistence effect so a transient pre-restore set can't clobber the saved state.
  const restoreNeededRef = useRef(true);
  useEffect(() => {
    // Restore per-scene collapse (by guid), or apply the collapse-all default for a
    // never-seen scene. MUST run from a SETTLED refresh: getCurrentScenePath() is correct
    // on the next-RAF coalesced refresh but STALE inside the synchronous onWorldSwap
    // handler (the editor sets the scene path AFTER the swap fires).
    const restoreCollapse = (flat: EntityInfo[]) => {
      restoreNeededRef.current = false;
      if (flat.length <= 5) { setCollapsed(new Set()); setCollapseEpoch((n) => n + 1); return; }
      const parents = flat.filter((e) => flat.some((c) => c.parentId === e.id));
      const saved = loadCollapsedGuids(getCurrentScenePath() || '');
      if (saved) {
        // Seen before → restore exactly (map saved guids → current ids). An entity with
        // no guid, or not in the saved set, renders expanded.
        const wanted = new Set(saved);
        setCollapsed(new Set(parents.filter((e) => e.guid && wanted.has(e.guid)).map((e) => e.id)));
      } else {
        // Never-seen scene → collapse all parents (the tidy default).
        setCollapsed(new Set(parents.map((e) => e.id)));
      }
      // Lands AFTER the selection's own reveal (restored by guid on load); bump the epoch
      // so the reveal effect re-opens the selected row's ancestors.
      setCollapseEpoch((n) => n + 1);
    };
    const refresh = (settled: boolean) => {
      // O(1) dedup: only rebuild the tree if the structure version bumped since last time.
      const v = getStructureVersion();
      if (v !== prevVersionRef.current) {
        prevVersionRef.current = v;
        const flat = getAllEntities();
        setEntityCount(flat.length);
        setTree(buildEntityTree(flat));
      }
      // Collapse restore is scene-path-dependent → only on a settled refresh, once per world.
      if (settled && restoreNeededRef.current) {
        const flat = getAllEntities();
        if (flat.length > 0) restoreCollapse(flat);
      }
    };
    refresh(true); // initial build + restore (the editor boots with a scene already loaded)
    const unsub = onStructureDirtyCoalesced(() => refresh(true));
    const unsubSwap = onWorldSwap(() => {
      prevVersionRef.current = -1;     // invalidate so the coalesced refresh isn't deduped
      restoreNeededRef.current = true; // re-restore (remap ids) once the swap settles
      refresh(false);                  // rebuild the tree now; path may be stale → skip restore
    });
    return () => { unsub(); unsubSwap(); };
  }, []);

  // Persist collapse per scene (by guid). Gated on restoreNeededRef so a transient
  // pre-restore collapsed set (stale ids from before a swap) can't overwrite the save.
  useEffect(() => {
    if (restoreNeededRef.current) return;
    const path = getCurrentScenePath() || '';
    if (!path) return;
    const idToGuid = new Map(getAllEntities().map((e) => [e.id, e.guid || '']));
    const guids: string[] = [];
    for (const id of collapsed) { const g = idToGuid.get(id); if (g) guids.push(g); }
    saveCollapsedGuids(path, guids);
  }, [collapsed]);

  const handleToggle = useCallback((id: number, recursive = false) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!recursive) {
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      }
      // Alt-click: expand/collapse this node AND its whole subtree. Direction anchors on
      // the clicked node — currently collapsed → expand all; else collapse all. Leaf ids
      // in the set are harmless (only nodes with children read as collapsed).
      const ids = subtreeIds(getAllEntities(), id);
      const expand = next.has(id);
      for (const d of ids) { if (expand) next.delete(d); else next.add(d); }
      return next;
    });
  }, []);

  // Folder caret toggle. Plain click toggles just this folder; Alt-click (recursive)
  // expands/collapses the WHOLE folder subtree — this folder + every descendant subfolder
  // AND every member entity's subtree — so a later plain re-open shows members collapsed.
  // Direction anchors on the clicked folder's state: open → collapse all; collapsed → expand all.
  const handleFolderToggle = useCallback((node: HierarchyFolder, recursive: boolean) => {
    if (!recursive) { toggleFolder(node.path); return; }
    const collapsing = !collapsedFolders.has(node.path);
    const paths = folderSubtreePaths(node);
    const flat = getAllEntities();
    const entIds = folderSubtreeRootIds(node).flatMap((id) => subtreeIds(flat, id));
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      for (const p of paths) { if (collapsing) next.add(p); else next.delete(p); }
      return next;
    });
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const id of entIds) { if (collapsing) next.add(id); else next.delete(id); }
      return next;
    });
  }, [collapsedFolders, toggleFolder, setCollapsedFolders]);

  // Membership lookup for EntityNode highlighting (rebuilt only when the set changes).
  const selectedIdSet = useMemo(() => new Set(selectedEntityIds), [selectedEntityIds]);

  // Click selection with modifier support:
  //   plain      → single select (replace)
  //   ⌘/Ctrl     → toggle one in/out of the set
  //   Shift      → contiguous range from the anchor to the clicked row (visible order)
  const handleSelectClick = useCallback((id: number, e: React.MouseEvent) => {
    setSelectedFolderPath(null); // entity selection and folder selection are exclusive
    if (e.metaKey || e.ctrlKey) {
      toggleEntitySelection(id);
      return;
    }
    if (e.shiftKey && selectedId !== null && selectedId !== id) {
      // Contiguous range from the anchor to the clicked row, in visible order.
      const range = rangeBetween(flattenVisibleIds(displayTree, effectiveCollapsed), selectedId, id);
      if (range) { setSelectedEntities(range, id); return; }
    }
    selectEntity(id);
  }, [selectedId, effectiveCollapsed, displayTree, toggleEntitySelection, setSelectedEntities, selectEntity]);

  // ── Reveal the selected entity ──
  // A selection can come from anywhere — a viewport click, undo/redo, an agent's
  // set-selection — and the row that shows it may be collapsed under ancestor entities,
  // tucked inside a collapsed folder, or simply scrolled off. Expanding without scrolling
  // leaves the highlight below the fold, which reads exactly like nothing got selected.
  // So: un-collapse whatever hides the row, then scroll it into view.
  useEffect(() => {
    if (selectedId === null) return;
    const { ancestorIds, folderPaths } = revealTargetsFor(getAllEntities(), selectedId);
    if (ancestorIds.length) {
      setCollapsed(prev => {
        if (!ancestorIds.some(id => prev.has(id))) return prev; // already open — keep identity
        const next = new Set(prev);
        for (const id of ancestorIds) next.delete(id);
        return next;
      });
    }
    if (folderPaths.length) {
      setCollapsedFolders(prev => {
        if (!folderPaths.some(p => prev.has(p))) return prev;
        const next = new Set(prev);
        for (const p of folderPaths) next.delete(p);
        return next;
      });
    }
  }, [selectedId, collapseEpoch, setCollapsedFolders]);

  // Scroll after the expansion above has committed — on the first pass the row may not be
  // mounted yet. `block: 'nearest'` is a no-op when the row is already visible, so clicking
  // a row in the panel never yanks the list around.
  useEffect(() => {
    if (selectedId === null) return;
    const row = listRef.current?.querySelector(`[data-entity-row="${selectedId}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, collapsed, collapsedFolders, displayTree]);

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entity: EntityInfo } | null>(null);
  // Inline rename — id of the entity whose name field is currently editable
  const [renamingId, setRenamingId] = useState<number | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, entity: EntityInfo) => {
    e.preventDefault();
    e.stopPropagation();
    // Preserve an existing multi-selection when right-clicking one of its members
    // (standard tree behavior) — so "New Folder from Selection" / Delete act on the
    // whole selection. Right-clicking OUTSIDE the selection collapses to that entity.
    if (!selectedEntityIds.includes(entity.id)) selectEntity(entity.id);
    setCtxMenu({ x: e.clientX, y: e.clientY, entity });
  }, [selectEntity, selectedEntityIds]);

  /** Raw selection setter — does NOT push a selection undo entry. Passed into
   *  deleteEntitiesWithUndo so the selection change folds into the delete's
   *  single undo entry. */
  const setSelectionRaw = useCallback((ids: number[]) => {
    useEditorStore.setState({
      selectedEntityId: ids.length > 0 ? ids[ids.length - 1] : null,
      selectedEntityIds: ids,
      selectedAsset: null,
    });
  }, []);

  const handleDelete = useCallback((entity: EntityInfo) => {
    if (entity.isResource) return;
    // If the acted entity is part of the current multi-selection, delete the
    // whole selection; otherwise just this one. Drop root/resource ids.
    const resourceIds = new Set(getAllEntities().filter(e => e.isResource).map(e => e.id));
    const ids = (selectedEntityIds.includes(entity.id) ? selectedEntityIds : [entity.id])
      .filter(id => id !== 0 && !resourceIds.has(id));
    deleteEntitiesWithUndo(ids, setSelectionRaw);
  }, [selectedEntityIds, setSelectionRaw]);

  const handleDuplicate = useCallback((entity: EntityInfo) => {
    if (entity.id === 0 || entity.isResource) return;
    duplicateEntity(entity.id, selectEntity);
  }, [selectEntity]);

  const handleRename = useCallback((entity: EntityInfo) => {
    if (entity.id === 0 || entity.isResource) return;
    setRenamingId(entity.id);
  }, []);

  const commitRename = useCallback((id: number, name: string) => {
    setRenamingId(null);
    const eaMeta = getAllTraits().find((t) => t.name === 'EntityAttributes');
    if (eaMeta) writeTraitFieldWithUndo(id, eaMeta, 'name', name);
  }, []);

  const cancelRename = useCallback(() => setRenamingId(null), []);

  // ── Copy / Cut / Paste ──
  // Copy holds a deep snapshot (re-spawnable any number of times); Cut remembers
  // the source id and moves the original on paste (reparent, with its own undo).
  const [entityClipboard, setEntityClipboard] = useState<{ snapshot: EntitySnapshot; op: 'copy' | 'cut'; sourceId: number } | null>(null);

  const handleCopy = useCallback((entity: EntityInfo) => {
    if (entity.id === 0 || entity.isResource) return;
    const snapshot = snapshotEntity(entity.id);
    if (snapshot) setEntityClipboard({ snapshot, op: 'copy', sourceId: entity.id });
  }, []);

  const handleCut = useCallback((entity: EntityInfo) => {
    if (entity.id === 0 || entity.isResource) return;
    const snapshot = snapshotEntity(entity.id);
    if (snapshot) setEntityClipboard({ snapshot, op: 'cut', sourceId: entity.id });
  }, []);

  const handlePaste = useCallback((parentId: number) => {
    if (!entityClipboard) return;
    const { snapshot, op, sourceId } = entityClipboard;
    if (op === 'cut') {
      // Move the original under the new parent. reparentEntity carries its own
      // undo and rejects illegal targets (self / descendant) by returning false.
      reparentEntity(sourceId, parentId);
      setEntityClipboard(null);
      return;
    }
    // copy → spawn a fresh deep copy under the target parent, with a unique
    // sortOrder at the end of that parent's children (so drag-reorder math stays
    // distinct, mirroring duplicateEntity).
    const eaMeta = getAllTraits().find(t => t.name === 'EntityAttributes');
    // Prefab-instance handling, identical to duplicateEntity (prefab F1): pasting an
    // instance ROOT → new linked instance (re-root); pasting a non-root MEMBER →
    // plain ADDED child (strip PrefabInstance).
    const prefabKind = classifyPrefabDuplicate(snapshot);
    // Mint fresh guids for the pasted copy ONCE (stable across undo/redo, and not
    // colliding with the source) — same as duplicateEntity. This also gives the
    // paste a guid-based handle that survives a world rebuild (Play→Stop).
    let pasteSnapshot = regenerateSnapshotGuids(snapshot);
    if (prefabKind === 'member') pasteSnapshot = stripPrefabInstanceFromSnapshot(pasteSnapshot);
    const parentRef = parentId ? entityRef(parentId) : null;
    const spawn = (p: number) => {
      const id = respawnFromSnapshot(pasteSnapshot, p);
      if (eaMeta) {
        const siblings = getAllEntities().filter(e => e.parentId === p && e.id !== id);
        const nextSort = siblings.length ? Math.max(...siblings.map(s => s.sortOrder)) + 1 : 0;
        writeTraitField(id, eaMeta, 'sortOrder', nextSort);
      }
      if (prefabKind === 'root') reRootPrefabInstanceSubtree(id);
      return id;
    };
    let currentId = spawn(parentId);
    let ref = entityRef(currentId);
    selectEntity(currentId);
    pushAction({
      label: 'Paste Entity',
      undo: () => { const id = ref.resolve(); if (id != null) deleteEntity(id); selectEntity(null); },
      redo: () => { currentId = spawn(parentRef?.resolve() ?? parentId); ref = entityRef(currentId); selectEntity(currentId); },
    });
  }, [entityClipboard, selectEntity]);

  // ── Focus (frame in SceneView orbit camera — see SceneView F-key) ──
  const handleFocus = useCallback((entity: EntityInfo) => {
    focusEntityInSceneView(entity.id);
  }, []);

  // ── Toggle active (EntityAttributes.isActive) ──
  const handleToggleActive = useCallback((entity: EntityInfo) => {
    if (entity.id === 0) return;
    const eaMeta = getAllTraits().find(t => t.name === 'EntityAttributes');
    if (!eaMeta) return;
    const data = readTraitData(entity.id, eaMeta);
    const cur = data ? (data.isActive as boolean) : true;
    writeTraitFieldWithUndo(entity.id, eaMeta, 'isActive', !cur);
  }, []);

  // ── Create Prefab from entity (serialize subtree → .prefab.json → tag) ──
  // Shares createPrefabFromEntity with the Assets entity-drop branch (F7) —
  // they differ only in how savePath is chosen (Hierarchy: under a writable
  // root's /prefabs; Assets: the drop-target folder).
  const handleCreatePrefab = useCallback(async (entity: EntityInfo) => {
    if (entity.id === 0 || entity.isResource) return;
    const root = await firstWritableAssetRoot();
    if (!root) { console.error('[Hierarchy] No writable asset root for prefab'); return; }
    const safeName = (entity.name || 'Entity').replace(/[^a-zA-Z0-9_-]/g, '_');
    const savePath = `${root}/prefabs/${safeName}.prefab.json`;
    const result = await createPrefabFromEntity(entity.id, savePath, `Save prefab "${entity.name}"`);
    if (!result) { console.error(`[Hierarchy] Failed to create prefab ${savePath}`); return; }
    console.log(`[Hierarchy] Created prefab: ${savePath}`);
    pushAction(result.action);
  }, []);

  // ── Detach Prefab — sever the prefab link, turning an instance into plain
  //    entities (Unity-style "Unpack Completely"). Detaches the WHOLE subtree
  //    rooted at the instance root (nested instances included). ──
  const handleDetachPrefab = useCallback((entity: EntityInfo) => {
    if (entity.id === 0 || entity.isResource) return;
    const piMeta = getAllTraits().find(t => t.name === 'PrefabInstance');
    if (!piMeta) return;
    // Resolve the instance root from whichever member was clicked.
    const pi = readTraitData(entity.id, piMeta);
    const rootId = (pi?.rootInstanceId as number) || entity.id;
    const snapshot = detachPrefabInstance(rootId);
    if (!snapshot.length) return;
    const name = getAllEntities().find(e => e.id === rootId)?.name ?? entity.name;
    // Resolve the instance root by guid so redo detaches the right entity after a
    // world rebuild (Play→Stop); undo rebuilds from the snapshot.
    const ref = entityRef(rootId);
    pushAction({
      label: `Detach prefab "${name}"`,
      undo: () => reattachPrefabInstance(snapshot),
      redo: () => { const id = ref.resolve(); if (id != null) detachPrefabInstance(id); },
    });
  }, []);

  // Keyboard shortcut: Cmd+Backspace (Mac) / Delete (Windows) to delete selected entity
  const treeRef = useRef(tree);
  treeRef.current = tree;

  // Keep the handler's changing deps in a ref so the document-level keydown
  // listener can be registered ONCE (with `[]`) instead of being torn down and
  // re-added on every selection / clipboard change. (editor-panels F12.)
  const kbdRef = useRef({
    selectedId, selectedEntityIds, setSelectionRaw, selectEntity,
    entityClipboard, handlePaste, handleCopy, handleCut,
  });
  kbdRef.current = {
    selectedId, selectedEntityIds, setSelectionRaw, selectEntity,
    entityClipboard, handlePaste, handleCopy, handleCut,
  };

  useEffect(() => {
    const isMac = navigator.platform.includes('Mac');
    const onKey = (e: KeyboardEvent) => {
      const {
        selectedId, selectedEntityIds, setSelectionRaw, selectEntity,
        entityClipboard, handlePaste, handleCopy, handleCut,
      } = kbdRef.current;
      // Don't intercept when typing in an input field
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
      // This is a document-level listener, so it would otherwise fire while the
      // user is working in another panel (e.g. Cmd+C in Assets would also copy
      // the selected entity). Yield when focus sits inside a DIFFERENT editor
      // panel. Focus on <body> (nothing focused) still runs these shortcuts.
      const focusedPanel = (document.activeElement as HTMLElement | null)?.closest('[data-editor-panel]')?.getAttribute('data-editor-panel');
      if (focusedPanel && focusedPanel !== 'hierarchy') return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      // Cmd/Ctrl+V → paste entity clipboard under the selected entity (or root).
      // Skip when text is highlighted so we don't hijack a real paste.
      if (mod && (e.key === 'v' || e.key === 'V') && entityClipboard) {
        if (window.getSelection()?.toString()) return;
        e.preventDefault();
        handlePaste(selectedId ?? 0);
        return;
      }
      // Cmd/Ctrl+C / Cmd/Ctrl+X → copy / cut the selected entity.
      if (mod && (e.key === 'c' || e.key === 'C' || e.key === 'x' || e.key === 'X')) {
        if (selectedId === null || window.getSelection()?.toString()) return;
        const entity = getAllEntities().find(en => en.id === selectedId);
        if (!entity || entity.id === 0 || entity.isResource) return;
        e.preventDefault();
        if (e.key === 'x' || e.key === 'X') handleCut(entity); else handleCopy(entity);
        return;
      }
      if (selectedId === null) return;
      // F2 → rename selected entity inline
      if (e.key === 'F2') {
        e.preventDefault();
        const entity = getAllEntities().find(e => e.id === selectedId);
        if (entity && entity.id !== 0 && !entity.isResource) setRenamingId(selectedId);
        return;
      }
      // Cmd/Ctrl+D → duplicate selected entity (and its children)
      const isDuplicateKey = (isMac ? e.metaKey : e.ctrlKey) && (e.key === 'd' || e.key === 'D');
      if (isDuplicateKey) {
        e.preventDefault();
        const entity = getAllEntities().find(e => e.id === selectedId);
        if (entity && entity.id !== 0 && !entity.isResource) {
          duplicateEntity(entity.id, selectEntity);
        }
        return;
      }
      const isDeleteKey = isMac ? (e.key === 'Backspace' && e.metaKey) : e.key === 'Delete';
      if (!isDeleteKey) return;
      e.preventDefault();
      const flat = getAllEntities();
      const resourceIds = new Set(flat.filter(en => en.isResource).map(en => en.id));
      // Delete the whole multi-selection (falling back to the primary), minus
      // root/resource ids — one coalesced undo entry.
      const ids = (selectedEntityIds.length > 0 ? selectedEntityIds : (selectedId != null ? [selectedId] : []))
        .filter(id => id !== 0 && !resourceIds.has(id));
      if (ids.length > 0) deleteEntitiesWithUndo(ids, setSelectionRaw);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /** Thin binding wrapper over the extracted createEntityWithUndo action. */
  const createEntityWithUndo = useCallback(
    (label: string, parentId: number, traitSpecs: { name: string; data?: Record<string, any> }[]) =>
      createEntityAction(label, parentId, traitSpecs, selectEntity),
    [selectEntity],
  );

  // The "Create …" trait specs live in entityCreateSpecs.ts so the menus here and
  // the agent `create-entity` op build identical entities. Each handler just maps
  // a builder's { name, specs } onto createEntityWithUndo.
  const handleCreateChild = useCallback((parentId: number) => {
    const { specs } = emptySpecs(parentId);
    createEntityWithUndo('Create Entity', parentId, specs);
  }, [createEntityWithUndo]);

  const handleCreatePrimitive = useCallback((meshName: string, parentId: number) => {
    const { name, specs } = primitiveSpecs(meshName, parentId);
    createEntityWithUndo(`Create ${name}`, parentId, specs);
  }, [createEntityWithUndo]);

  const handleCreate2D = useCallback((shape: string, parentId: number) => {
    const { name, specs } = shape2DSpecs(shape, parentId);
    createEntityWithUndo(`Create ${name}`, parentId, specs);
  }, [createEntityWithUndo]);

  const handleCreateCanvas2D = useCallback((parentId: number) => {
    const { name, specs } = canvas2DSpecs(parentId);
    createEntityWithUndo(`Create ${name}`, parentId, specs);
  }, [createEntityWithUndo]);

  const handleCreateUI = useCallback((preset: UiPreset, parentId: number) => {
    // Anchor-first authoring: every new UI element ships with a centered UIAnchor
    // (Unity-style placement) plus its preset defaults. See uiAuthoring.ts.
    const { name, specs } = uiSpecs(preset, parentId);
    createEntityWithUndo(`Create ${name}`, parentId, specs);
  }, [createEntityWithUndo]);

  const handleCreateCamera = useCallback((parentId: number) => {
    const { specs } = cameraSpecs(parentId);
    createEntityWithUndo('Create Camera', parentId, specs);
  }, [createEntityWithUndo]);

  const handleCreateLight = useCallback((kind: LightKind, parentId: number) => {
    const { name, specs } = lightSpecs(kind, parentId);
    createEntityWithUndo(`Create ${name}`, parentId, specs);
  }, [createEntityWithUndo]);

  const handleCreateParticle = useCallback((parentId: number) => {
    const { specs } = particleSpecs(parentId);
    createEntityWithUndo('Create Particle', parentId, specs);
  }, [createEntityWithUndo]);

  const handleCreateEnvironment = useCallback((parentId: number) => {
    const { specs } = environmentSpecs(parentId);
    createEntityWithUndo('Create HDR Environment', parentId, specs);
  }, [createEntityWithUndo]);

  // The "Create …" group, reused at the root menu (top-level) and nested under
  // a single "Create ▸" submenu when right-clicking an existing entity.
  const createItems = useCallback((parentId: number): ContextMenuItem[] => [
    { label: 'Empty', onClick: () => handleCreateChild(parentId) },
    {
      label: 'Primitive',
      children: PRIMITIVE_NAMES.filter(n => n !== 'box').map(n => ({
        label: n.charAt(0).toUpperCase() + n.slice(1),
        onClick: () => handleCreatePrimitive(n, parentId),
      })),
    },
    {
      label: '2D',
      children: [
        { label: 'Canvas', onClick: () => handleCreateCanvas2D(parentId) },
        { label: 'Square', onClick: () => handleCreate2D('square', parentId) },
        { label: 'Circle', onClick: () => handleCreate2D('circle', parentId) },
        { label: 'Triangle', onClick: () => handleCreate2D('triangle', parentId) },
      ],
    },
    {
      label: 'UI',
      children: [
        { label: 'View', onClick: () => handleCreateUI('view', parentId) },
        { label: 'Text', onClick: () => handleCreateUI('text', parentId) },
        { label: 'Image', onClick: () => handleCreateUI('image', parentId) },
        { label: 'Button', onClick: () => handleCreateUI('button', parentId) },
        { label: 'Input', onClick: () => handleCreateUI('input', parentId) },
        { label: 'Slider', onClick: () => handleCreateUI('slider', parentId) },
      ],
    },
    {
      label: 'Light',
      children: [
        { label: 'Ambient', onClick: () => handleCreateLight('ambient', parentId) },
        { label: 'Directional', onClick: () => handleCreateLight('directional', parentId) },
        { label: 'Point', onClick: () => handleCreateLight('point', parentId) },
        { label: 'Spot', onClick: () => handleCreateLight('spot', parentId) },
      ],
    },
    { label: 'Camera', onClick: () => handleCreateCamera(parentId) },
    { label: 'Particle', onClick: () => handleCreateParticle(parentId) },
    { label: 'HDR Environment', onClick: () => handleCreateEnvironment(parentId) },
  ], [handleCreateChild, handleCreatePrimitive, handleCreate2D, handleCreateCanvas2D, handleCreateUI, handleCreateLight, handleCreateCamera, handleCreateParticle, handleCreateEnvironment]);

  // ── Folder operations (all write EntityAttributes.editorFolder on ROOTS) ──
  const [folderCtx, setFolderCtx] = useState<{ x: number; y: number; path: string; name: string } | null>(null);

  // Selected entities that are ROOTS (eligible to be foldered). Recomputed when the
  // selection or structure changes. Resources / the scene root (id 0) are excluded.
  const rootSelection = useMemo(() => {
    const flat = getAllEntities();
    return selectedEntityIds.filter((id) => {
      const e = flat.find((x) => x.id === id);
      return !!e && e.parentId === 0 && !e.isResource && id !== 0;
    });
    // `tree` in deps: structure changes (reparent) can flip an entity's root-ness.
  }, [selectedEntityIds, tree]);

  const eaMetaFind = () => getAllTraits().find((t) => t.name === 'EntityAttributes');

  /** Move an entity into (or out of, `''`) a folder. A non-root is first reparented
   *  to the scene root — folders only tag roots — then tagged; that's two undo steps.
   *  A root just gets its tag rewritten (one field write). No-op if already there. */
  const moveEntityToFolder = useCallback((entityId: number, folderPath: string) => {
    const flat = getAllEntities();
    const e = flat.find((x) => x.id === entityId);
    if (!e || e.id === 0 || e.isResource) return;
    const eaMeta = eaMetaFind();
    if (!eaMeta) return;
    const target = normalizeFolderPath(folderPath);
    if (e.parentId !== 0) {
      if (!reparentEntity(entityId, 0)) return; // reparent(→root) never clears the tag
      if (target) writeTraitFieldWithUndo(entityId, eaMeta, 'editorFolder', target);
      return;
    }
    if (normalizeFolderPath(e.editorFolder || '') === target) return;
    writeTraitFieldWithUndo(entityId, eaMeta, 'editorFolder', target);
  }, []);

  /** Create a folder under `parentPath` (''= top level) with a fresh, collision-free
   *  name, then drop into inline-rename (Finder-style). If root entities are selected
   *  they're moved into the new folder (one undo entry); otherwise it's an EMPTY folder
   *  remembered in editor-local state until something is dropped in. */
  const createFolder = useCallback((parentPath = '') => {
    const eaMeta = eaMetaFind();
    if (!eaMeta) return;
    const parent = normalizeFolderPath(parentPath);
    const taken = (p: string) => [...usedFolderPaths].some((u) => u === p || u.startsWith(p + '/'));
    const at = (leaf: string) => (parent ? `${parent}/${leaf}` : leaf);
    let name = 'New Folder';
    let path = at(name);
    let n = 2;
    while (taken(path)) { name = `New Folder ${n}`; path = at(name); n++; }
    if (rootSelection.length > 0) {
      writeTraitFieldMultiWithUndo(rootSelection, eaMeta, 'editorFolder', path); // scene-backed
    } else {
      setEmptyFolders((prev) => new Set(prev).add(path)); // rootless marker
    }
    if (parent) setCollapsedFolders((prev) => new Set([...prev].filter((k) => k !== parent))); // reveal
    setSelectedFolderPath(path);
    setRenamingFolderPath(path);
  }, [usedFolderPaths, rootSelection, setCollapsedFolders]);

  /** Rewrite a folder's path PREFIX (oldPath → newPath) across every root in its
   *  subtree as ONE undo entry, with a collision guard + collapsed-state remap.
   *  Shared by rename (change the leaf) and folder-drag (change the parent). */
  const rewriteFolderPath = useCallback((oldPath: string, newPath: string, label: string): boolean => {
    if (!newPath || newPath === oldPath) return false;
    const eaMeta = eaMetaFind();
    if (!eaMeta) return false;
    // Collision: some OTHER folder (outside the moving subtree) already occupies newPath.
    if ([...usedFolderPaths].some((u) =>
      (u === newPath || u.startsWith(newPath + '/')) && !(u === oldPath || u.startsWith(oldPath + '/')))) {
      console.warn(`[Hierarchy] Folder already exists: ${newPath}`); return false;
    }
    const memberIds = getAllEntities()
      .filter((e) => e.parentId === 0 && e.editorFolder && (() => { const f = normalizeFolderPath(e.editorFolder!); return f === oldPath || f.startsWith(oldPath + '/'); })())
      .map((e) => e.id);
    // An empty folder has no tagged roots — the marker set alone carries it, so a
    // rename/move must still succeed by remapping just the markers.
    const hasMarker = [...emptyFolders].some((p) => p === oldPath || p.startsWith(oldPath + '/'));
    if (memberIds.length === 0 && !hasMarker) return false;
    if (memberIds.length > 0) {
      writeTraitFieldPerEntityWithUndo(memberIds, eaMeta, 'editorFolder',
        (old) => newPath + normalizeFolderPath(String(old || '')).slice(oldPath.length),
        label);
    }
    if (hasMarker) setEmptyFolders((prev) => remapPrefix(prev, oldPath, newPath));
    setCollapsedFolders((prev) => remapPrefix(prev, oldPath, newPath));
    if (selectedFolderPath === oldPath) setSelectedFolderPath(newPath);
    return true;
  }, [usedFolderPaths, emptyFolders, selectedFolderPath, setCollapsedFolders]);

  /** Rename a folder = rewrite its leaf segment (parent prefix unchanged). */
  const commitFolderRename = useCallback((oldPath: string, newName: string) => {
    setRenamingFolderPath(null);
    const safe = newName.trim().replace(/[/\\]/g, '_');
    const parts = oldPath.split('/');
    if (!safe || safe === parts[parts.length - 1]) return;
    rewriteFolderPath(oldPath, [...parts.slice(0, -1), safe].join('/'), `Rename folder ${parts[parts.length - 1]}`);
  }, [rewriteFolderPath]);

  /** Move a whole folder subtree under a new parent folder (''= top level) — the
   *  nesting gesture (drag a folder onto another folder, or onto the empty area to
   *  un-nest). Rejects moving a folder into itself or one of its own descendants. */
  const moveFolder = useCallback((srcPath: string, destParent: string) => {
    const src = normalizeFolderPath(srcPath);
    const dest = normalizeFolderPath(destParent);
    if (!src || dest === src || dest.startsWith(src + '/')) return; // no-op / cycle
    const leaf = src.split('/').pop()!;
    rewriteFolderPath(src, dest ? `${dest}/${leaf}` : leaf, `Move folder ${leaf}`);
  }, [rewriteFolderPath]);

  /** Delete a folder = clear the tag on every root in its subtree (they become
   *  ungrouped roots) AND drop any empty-folder markers under it. One undo entry for
   *  the tag clears (marker removal is editor-local state). */
  const deleteFolder = useCallback((path: string) => {
    const eaMeta = eaMetaFind();
    if (!eaMeta) return;
    const memberIds = getAllEntities()
      .filter((e) => e.parentId === 0 && e.editorFolder && (() => { const f = normalizeFolderPath(e.editorFolder!); return f === path || f.startsWith(path + '/'); })())
      .map((e) => e.id);
    if (memberIds.length > 0) writeTraitFieldMultiWithUndo(memberIds, eaMeta, 'editorFolder', '');
    setEmptyFolders((prev) => new Set([...prev].filter((k) => k !== path && !k.startsWith(path + '/'))));
    setCollapsedFolders((prev) => new Set([...prev].filter((k) => k !== path && !k.startsWith(path + '/'))));
  }, [setCollapsedFolders]);

  const ctxMenuItems = useCallback((entity: EntityInfo): ContextMenuItem[] => {
    const parentId = entity.id;
    const pasteItem: ContextMenuItem = {
      label: 'Paste', shortcut: '⌘V', disabled: !entityClipboard,
      onClick: () => handlePaste(parentId),
    };

    // Root (empty-area) menu — Paste + New Folder + the Create group at top level.
    if (entity.id === 0) {
      return [
        pasteItem,
        { label: 'New Folder', onClick: () => createFolder('') },
        { label: '', separator: true },
        ...createItems(0),
      ];
    }

    // Entity menu — actions first, Create nested, Delete last.
    const eaMeta = getAllTraits().find(t => t.name === 'EntityAttributes');
    const attr = eaMeta ? readTraitData(entity.id, eaMeta) : null;
    const isActive = attr ? (attr.isActive as boolean) !== false : true;
    const dis = entity.isResource;
    const isPrefabInstance = entity.traits.includes('PrefabInstance');
    return [
      { label: 'Rename', shortcut: 'F2', onClick: () => handleRename(entity), disabled: dis },
      { label: 'Duplicate', shortcut: '⌘D', onClick: () => handleDuplicate(entity), disabled: dis },
      { label: 'Copy', shortcut: '⌘C', onClick: () => handleCopy(entity), disabled: dis },
      { label: 'Cut', shortcut: '⌘X', onClick: () => handleCut(entity), disabled: dis },
      pasteItem,
      { label: '', separator: true },
      { label: 'Focus', shortcut: 'F', onClick: () => handleFocus(entity) },
      { label: isActive ? 'Deactivate' : 'Activate', onClick: () => handleToggleActive(entity), disabled: dis },
      { label: 'Create Prefab', onClick: () => handleCreatePrefab(entity), disabled: dis },
      ...(isPrefabInstance ? [{ label: 'Detach Prefab', onClick: () => handleDetachPrefab(entity), disabled: dis }] : []),
      { label: '', separator: true },
      { label: 'New Folder', onClick: () => createFolder(''), disabled: dis },
      ...(entity.parentId === 0 && entity.editorFolder ? [{ label: 'Remove from Folder', onClick: () => moveEntityToFolder(entity.id, '') }] : []),
      { label: '', separator: true },
      { label: 'Create', children: createItems(parentId) },
      { label: '', separator: true },
      { label: 'Delete', shortcut: '⌫', onClick: () => handleDelete(entity), danger: true, disabled: dis },
    ];
  }, [createItems, entityClipboard, handlePaste, handleRename, handleDuplicate, handleCopy, handleCut, handleFocus, handleToggleActive, handleCreatePrefab, handleDetachPrefab, handleDelete, createFolder, moveEntityToFolder]);

  // Reparent handler: entity dragged onto another entity or root
  const handleReparent = useCallback((entityId: number, newParentId: number, sortOrder?: number) => {
    reparentEntity(entityId, newParentId, sortOrder);
  }, []);

  // Drop handler: prefab dragged from Assets → instantiate in scene
  const [dropActive, setDropActive] = useState(false);

  const handlePrefabDrop = useCallback(async (e: React.DragEvent, parentId: number = 0) => {
    e.preventDefault();
    setDropActive(false);
    const raw = e.dataTransfer.getData('application/editor-asset');
    if (!raw) return;
    const { type, path } = JSON.parse(raw) as { type: string; path: string; name: string };
    if (type !== 'prefab') return;

    try {
      const res = await fetch(path);
      if (!res.ok) return;
      const prefab: PrefabFile = await res.json();
      // Preload nested children before the sync expand — otherwise a nested (v2)
      // prefab's children are silently dropped.
      const currentId = await instantiatePrefabAsync(prefab, parentId);
      setPrefabSource(currentId, path);
      selectEntity(currentId);
      console.log(`[Hierarchy] Instantiated prefab "${prefab.name}" under parent ${parentId}`);

      pushAction(makePrefabInstantiateAction({
        label: `Instantiate "${prefab.name}"`,
        initialId: currentId,
        respawn: async () => {
          const r = await fetch(path);
          if (!r.ok) return null;
          const p: PrefabFile = await r.json();
          const id = await instantiatePrefabAsync(p, parentId);
          setPrefabSource(id, path);
          selectEntity(id);
          return id;
        },
        remove: (id) => { deleteEntity(id); selectEntity(null); },
      }));
    } catch (err) {
      console.error('[Hierarchy] Drop instantiate failed:', err);
    }
  }, [selectEntity]);

  const handleCreate = () => handleCreateChild(0);

  // Render a run of root entities (top level or under a folder) at `depth`.
  const renderEntityRows = (rootsArr: EntityInfo[], depth: number) => rootsArr.map((entity, i) => (
    <EntityNode
      key={entity.id}
      entity={entity}
      depth={depth}
      selectedId={selectedId}
      selectedIds={selectedIdSet}
      onSelect={handleSelectClick}
      onContextMenu={handleContextMenu}
      onReparent={handleReparent}
      onPrefabDrop={handlePrefabDrop}
      collapsed={effectiveCollapsed}
      onToggle={handleToggle}
      prevSiblingSort={i > 0 ? rootsArr[i - 1].sortOrder : null}
      nextSiblingSort={i < rootsArr.length - 1 ? rootsArr[i + 1].sortOrder : null}
      renamingId={renamingId}
      onCommitRename={commitRename}
      onCancelRename={cancelRename}
    />
  ));

  // Render a folder row + (when open) its subfolders and member roots. While a search
  // is active, folders are force-open so matches inside them stay visible.
  const renderFolder = (node: HierarchyFolder, depth: number): React.ReactNode => {
    const open = isFiltering || !collapsedFolders.has(node.path);
    return (
      <React.Fragment key={`folder:${node.path}`}>
        <HierarchyFolderRow
          node={node}
          depth={depth}
          open={open}
          count={countFolderRoots(node)}
          selected={selectedFolderPath === node.path}
          renaming={renamingFolderPath === node.path}
          onToggle={(recursive) => handleFolderToggle(node, recursive)}
          onSelect={() => { setSelectedFolderPath(node.path); setSelectedEntities([]); }}
          onContextMenu={(e) => setFolderCtx({ x: e.clientX, y: e.clientY, path: node.path, name: node.name })}
          onDropEntity={(id) => moveEntityToFolder(id, node.path)}
          onDropAsset={(e) => handlePrefabDrop(e, 0)}
          onDropFolder={(src) => moveFolder(src, node.path)}
          onCommitRename={(name) => commitFolderRename(node.path, name)}
          onCancelRename={() => setRenamingFolderPath(null)}
        />
        {open && (
          <>
            {node.children.map((c) => renderFolder(c, depth + 1))}
            {renderEntityRows(node.roots, depth + 1)}
          </>
        )}
      </React.Fragment>
    );
  };

  return (
    <div data-editor-panel="hierarchy" style={{ width: '100%', height: '100%', background: '#252536', color: '#ccc', fontFamily: 'monospace', fontSize: '12px', display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar — title · search · type filter · create. Flex-wraps on narrow
          widths so the search field + Type ▾ flow onto a second row (mirrors Assets). */}
      <div style={{ minWidth: 0, minHeight: 32, padding: '4px 8px', borderBottom: '1px solid #333', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <span style={{ fontWeight: 'bold', color: '#f1c40f', fontSize: '13px' }}>Hierarchy</span>
        <TreeSearchInput value={filter} onChange={setFilter} placeholder="Search entities..." uiId="hierarchy.toolbar.search" />
        {availableTypes.length > 1 && (
          <TypeFilterMenu
            types={availableTypes}
            selected={typeFilter}
            onToggle={toggleTypeFilter}
            onClear={() => setTypeFilter(new Set())}
            title="Filter by component type"
            groupBy={(t) => getTraitByName(t)?.componentCategory ?? 'Misc'}
            groupOrder={COMPONENT_CATEGORY_ORDER}
            groupCollapseKey="editor:hierarchy:typeFilterGroups:v1"
            uiId="hierarchy.toolbar.typeFilter"
          />
        )}
        <button
          onClick={() => createFolder(selectedFolderPath ?? '')}
          style={btnStyle}
          title={selectedFolderPath ? `New Folder in "${selectedFolderPath}"` : 'New Folder'}
          data-ui-id="hierarchy.toolbar.createFolder" data-ui-kind="button" data-ui-label="new folder"
        >📁+</button>
        <button onClick={handleCreate} style={btnStyle} title="Create Entity"
          data-ui-id="hierarchy.toolbar.create" data-ui-kind="button" data-ui-label="create entity">+</button>
      </div>

      {/* Entity tree — drop zone for prefabs from Assets + reparent to root */}
      <div
        ref={listRef}
        style={{ flex: 1, overflow: 'auto', padding: '4px 0', outline: dropActive ? '2px dashed #3498db' : 'none' }}
        onClick={(e) => { if (e.target === e.currentTarget) setSelectedFolderPath(null); }}
        onContextMenu={(e) => {
          // Right-click on empty area → root-level create menu
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setCtxMenu({ x: e.clientX, y: e.clientY, entity: { id: 0, name: 'root', traits: [], parentId: 0, sortOrder: 0 } as EntityInfo });
          }
        }}
        onDragOver={(e) => {
          const t = e.dataTransfer.types;
          if (t.includes('application/editor-asset') || t.includes('application/editor-entity') || t.includes('application/editor-folder')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = t.includes('application/editor-asset') ? 'copy' : 'move';
            setDropActive(true);
          }
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(e) => {
          setDropActive(false);
          // Prefab drop from Assets
          if (e.dataTransfer.types.includes('application/editor-asset')) {
            handlePrefabDrop(e);
            return;
          }
          // Folder drop onto empty area → move the folder to the TOP level (un-nest).
          const folderRaw = e.dataTransfer.getData('application/editor-folder');
          if (folderRaw) {
            e.preventDefault();
            moveFolder((JSON.parse(folderRaw) as { path: string }).path, '');
            return;
          }
          // Entity drop onto empty area → top-level UNGROUPED root: reparent to root
          // AND clear any folder tag (drag-out-of-folder gesture).
          const raw = e.dataTransfer.getData('application/editor-entity');
          if (raw) {
            e.preventDefault();
            const { id } = JSON.parse(raw) as { id: number };
            moveEntityToFolder(id, '');
          }
        }}
      >
        {/* Folders first (alphabetical), then ungrouped roots — a scene with no
            editorFolder tags renders exactly as before (folders=[], ungrouped=all). */}
        {folders.map((f) => renderFolder(f, 0))}
        {renderEntityRows(ungrouped, 0)}
        {isFiltering && folders.length === 0 && ungrouped.length === 0 && (
          <div style={{ padding: 12, color: '#555' }}>No entities match.</div>
        )}
      </div>

      {ctxMenu && (
        <ContextMenu
          items={ctxMenuItems(ctxMenu.entity)}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {folderCtx && (
        <ContextMenu
          items={[
            { label: 'New Subfolder', onClick: () => createFolder(folderCtx.path) },
            { label: '', separator: true },
            { label: 'Rename Folder', onClick: () => setRenamingFolderPath(folderCtx.path) },
            { label: 'Delete Folder', onClick: () => deleteFolder(folderCtx.path), danger: true },
          ]}
          x={folderCtx.x}
          y={folderCtx.y}
          onClose={() => setFolderCtx(null)}
        />
      )}

      {/* Footer */}
      <div style={{ padding: '4px 8px', borderTop: '1px solid #333', color: '#555', fontSize: '10px' }}>
        {entityCount} entities
      </div>
    </div>
  );
}

const layerColor: Record<string, string> = { '2d': '#e67e22', '3d': '#2ecc71', 'ui': '#9b59b6' };

const btnStyle: React.CSSProperties = {
  padding: '2px 8px', border: '1px solid #555', borderRadius: '3px',
  background: '#333', color: '#ccc', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold',
};
