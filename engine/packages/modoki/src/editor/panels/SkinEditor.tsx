/** Skin Editor panel — a dockable authoring surface for `.rig2d.json` assets (2D
 *  sprite-skinning rigs: a deformable mesh + bind-pose bones + per-vertex weights).
 *
 *  Architecture mirrors SpriteAnimEditor/ParticleEditor: the live rig def is the single
 *  source of truth in the editor store, so the GLOBAL undo stack applies edits even when
 *  this panel is unfocused; persistence is a debounced `/api/write-file`, and each edit
 *  re-seeds the shared rig2dCache (setRig2D) so any live SkinnedSprite2D referencing this
 *  asset re-skins next frame (spatial posing stays in the SceneView gizmo).
 *
 *  MVP scope: retarget to a selected/opened rig; show its sprite + bones + mesh stats;
 *  regenerate the mesh (Re-tessellate at a chosen grid density) and recompute weights
 *  (Auto-weight) via the pure rig2d generation core. Bone drawing + weight-paint brush
 *  are follow-ups; bone POSING already lives in the SceneView. */

import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { backendFetch } from '../backend/editorBackend';
import { newGuid, registerAsset, getAssetEntry, resolveGuidToPath, getGuidForPath } from '../../runtime/loaders/assetManifest';
import { deriveGuid } from '../../runtime/loaders/assetRefRules';
import { assetUrl } from '../../runtime/loaders/assetUrl';
import { type Rig2DFile, type Rig2DBone } from '../../runtime/loaders/rig2dCache';
import { generateGridMesh } from '../../runtime/skinning/rig2dTessellate';
import { computeAutoWeights } from '../../runtime/skinning/rig2dAutoWeights';
import { loadSpriteAlphaMask } from './spriteAlphaMask';
import SkinCanvas from './SkinCanvas';
import SkinBoneList from './SkinBoneList';
import { autoRig2D } from '../../runtime/skinning/rig2dBuild';
import { spriteThumbStyle } from './SpritePicker';
import { saveAssetDialog } from '../utils/saveDialog';
import { useDebouncedSave } from './useDebouncedSave';
import { AssetRefField, assetDisplayName } from './AssetRefField';
import { useEditorStore } from '../store/editorStore';
import { makeRigPrefabAsset } from '../scene/skinPrefab';
import { removeBone } from '../../runtime/skinning/rig2dEdit';
import { activePartOf, withActivePart, partsOf, addPart, removePart, movePart, reorderPart, reorderActiveIndex, renamePart, uvToPosAffine, partAngle } from './skinParts';
import { pushAction, undo as gUndo, redo as gRedo, type UndoAction } from '../undo/undoManager';
import { BufferedNumberInput, inputStyle } from './fields';

const AUTOSAVE_MS = 400;

/** Coerce a raw `.rig2d.json` bone list (all fields optional) into concrete bones with
 *  defaults, for the weight solver + display. */
function concreteBones(raw: Rig2DFile['bones']): Rig2DBone[] {
  return (raw ?? []).map((b, i) => ({
    name: typeof b.name === 'string' && b.name ? b.name : `bone${i}`,
    parent: Number.isInteger(b.parent) ? (b.parent as number) : -1,
    x: b.x ?? 0, y: b.y ?? 0, rot: b.rot ?? 0,
  }));
}

/** Derive width/height/pivot in texture space from the current mesh's vertex bounds,
 *  so Re-tessellate can regenerate a grid over the same region without a texture fetch. */
function meshBounds(verts: number[][]): { width: number; height: number; pivotX: number; pivotY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of verts) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  if (!Number.isFinite(minX)) return { width: 64, height: 64, pivotX: 0.5, pivotY: 0.5 };
  const width = maxX - minX || 1, height = maxY - minY || 1;
  return { width, height, pivotX: (0 - minX) / width, pivotY: (0 - minY) / height };
}

/** Bounding-box center of a texture-space vertex list (for placement-preserving ops). */
function centerOf(verts: number[][]): { x: number; y: number } {
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const p of verts) { if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0]; if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1]; }
  if (!Number.isFinite(mnx)) return { x: 0, y: 0 };
  return { x: (mnx + mxx) / 2, y: (mny + mxy) / 2 };
}

/** Load an image's natural pixel dimensions (for auto-rig from a whole texture). */
function loadImageDims(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

type SpriteDomain = {
  width: number; height: number; pivotX: number; pivotY: number;
  url?: string; rect?: { x: number; y: number; w: number; h: number };
};

/** Resolve the tessellation DOMAIN (pixel size + pivot + image URL/atlas rect) for a
 *  sprite GUID. Prefers the sprite's true region so grid UVs (0..1) map correctly and
 *  alpha sampling reads the right pixels; falls back to the current mesh bounds when no
 *  sprite is set. All rigs today use a centered (0.5) pivot, matching autoRig2D. */
async function resolveSpriteDomain(spriteGuid: string | undefined, fallbackVerts: number[][]): Promise<SpriteDomain> {
  if (spriteGuid) {
    const sp = getAssetEntry(spriteGuid)?.sprite;
    if (sp?.rect && sp.rect.w > 0) {
      const texPath = resolveGuidToPath(sp.texture);
      const url = texPath ? assetUrl(texPath) : undefined;
      return { width: sp.rect.w, height: sp.rect.h, pivotX: 0.5, pivotY: 0.5, url, rect: { ...sp.rect } };
    }
    const path = resolveGuidToPath(spriteGuid);
    if (path) {
      const url = assetUrl(path);
      const dims = await loadImageDims(url);
      if (dims) return { width: dims.width, height: dims.height, pivotX: 0.5, pivotY: 0.5, url };
    }
  }
  const b = meshBounds(fallbackVerts);
  return { width: b.width, height: b.height, pivotX: b.pivotX, pivotY: b.pivotY };
}

export default function SkinEditor() {
  const asset = useEditorStore((s) => s.editingSkinAsset);
  const nonce = useEditorStore((s) => s.skinEditNonce);
  const def = useEditorStore((s) => s.editingSkinDef);
  const activePart = useEditorStore((s) => s.activeSkinPart);
  const previewHidden = useEditorStore((s) => s.skinPreviewHidden);
  const skinMode = useEditorStore((s) => s.skinMode);
  const paintMode = skinMode === 'weights';
  const skinBoneTool = useEditorStore((s) => s.skinBoneTool);   // rig sub-tool (select/add)
  const skinWeightTool = useEditorStore((s) => s.skinWeightTool); // weights sub-tool (paint/pose)
  const skinHideTexture = useEditorStore((s) => s.skinHideTexture); // weights: hide sprite, show heatmap only
  const skinPaint = useEditorStore((s) => s.skinPaint);          // brush radius/strength/mode
  const selectedAsset = useEditorStore((s) => s.selectedAsset);
  const savedMarkRef = useRef<((d: Rig2DFile) => void) | null>(null);
  const [saveMsg, setSaveMsg] = useState('');
  // Which part row is being renamed inline (double-click). Electron has no window.prompt,
  // so part rename is an in-place input (mirrors the bone-rename field).
  const [editingPart, setEditingPart] = useState<number | null>(null);
  // Which Parts row a sprite is being dragged over (for the drop highlight).
  const [dropOverPart, setDropOverPart] = useState<number | null>(null);
  // Drag-reorder of the Parts list: the row being dragged + the row it's hovering over
  // (insertion target). Distinct from `dropOverPart` (that's a sprite-asset drop).
  const [dragPart, setDragPart] = useState<number | null>(null);
  const [reorderOverPart, setReorderOverPart] = useState<number | null>(null);
  // Aspect-ratio lock for the part Size fields: when on, editing w or h scales both axes
  // uniformly (keeps the part's proportions). On by default — the common case.
  const [sizeLocked, setSizeLocked] = useState(true);
  const [cols, setCols] = useState(4);
  const [rows, setRows] = useState(8);
  // Alpha-cull ("drop vertex by alpha"): trim fully-transparent grid cells so the mesh
  // hugs the opaque shape. threshold = min alpha (0..255) counted as opaque.
  const [trimAlpha, setTrimAlpha] = useState(true);
  const [alphaThreshold, setAlphaThreshold] = useState(8);
  // Auto-weight params. awRadius 0 = auto (derive from mesh bounds); falloff shapes the
  // bounded radial curve (low = soft/broad, high = tight/rigid).
  const [awRadius, setAwRadius] = useState(0);
  const [awFalloff, setAwFalloff] = useState(2);
  const [selBone, setSelBone] = useState(-1); // shared bone selection (canvas ↔ tree ↔ inspector)
  useEffect(() => { setSelBone(-1); setEditingPart(null); }, [asset?.path]); // reset when the rig changes
  // Transient test pose (paint mode): bone index → local override, previews the deform
  // without writing to the rig. Cleared on rig change AND whenever paint mode toggles.
  const [testPose, setTestPose] = useState<Record<number, { x: number; y: number; rot: number }>>({});
  useEffect(() => { setTestPose({}); }, [asset?.path, paintMode]);

  // Retarget on selection: if the panel is EMPTY and a .rig2d asset gets selected,
  // open it — parity with the Animation/Particle editors (which follow selection), and
  // it means the panel is reachable without a double-click (e.g. from tooling). Guarded
  // to "nothing open yet" so a stray selection never hijacks an in-progress rig edit.
  useEffect(() => {
    if (asset) return;
    if (selectedAsset?.type === 'rig2d') useEditorStore.getState().openSkinEditor(selectedAsset);
  }, [selectedAsset, asset]);

  // ── Load the rig def when the open target changes ──
  useEffect(() => {
    if (!asset) return;
    let cancelled = false;
    const existing = useEditorStore.getState().editingSkinDef;
    if (existing) { savedMarkRef.current?.(existing); return; } // bare re-mount — keep unsaved edits
    const { loadSkinDef } = useEditorStore.getState();
    fetch(asset.path)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((json: Rig2DFile) => {
        if (cancelled) return;
        if (!json.id) { json.id = newGuid(); }
        registerAsset(json.id!, asset.path, 'rig2d');
        savedMarkRef.current?.(json);
        loadSkinDef(json);
      })
      .catch((e) => { if (cancelled) return; console.warn('[SkinEditor] load failed', e); const fb: Rig2DFile = { bones: [], mesh: { verts: [], uvs: [], tris: [] }, skinIndices: [], skinWeights: [] }; savedMarkRef.current?.(fb); loadSkinDef(fb); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset?.path, nonce]);

  // ── Edit → global-undo commit (one step per discrete op) ──
  const commit = useCallback((next: Rig2DFile, label: string) => {
    const store = useEditorStore.getState();
    const before = store.editingSkinDef;
    const path = store.editingSkinAsset?.path;
    if (!before || !path) return;
    const a: UndoAction = {
      label: `rig2d ${label}`,
      undo: () => useEditorStore.getState().applySkinDef(path, before),
      redo: () => useEditorStore.getState().applySkinDef(path, next),
    };
    pushAction(a);
    store.applySkinDef(path, next);
  }, []);

  // ── Rig operations (pure generation core) ──
  const reTessellate = useCallback(async () => {
    const s = useEditorStore.getState(); const d = s.editingSkinDef;
    if (!d) return;
    const ap = activePartOf(d, s.activeSkinPart);
    const dom = await resolveSpriteDomain(ap.sprite, ap.mesh?.verts ?? []);
    let isInside: ((u: number, v: number) => boolean) | undefined;
    if (trimAlpha && dom.url) {
      const mask = await loadSpriteAlphaMask(dom.url, { threshold: alphaThreshold, rect: dom.rect });
      isInside = mask?.isInside;
    }
    const mesh = generateGridMesh({ width: dom.width, height: dom.height, cols, rows, pivotX: dom.pivotX, pivotY: dom.pivotY, isInside });
    if (!mesh.verts.length) { setSaveMsg('Trim too aggressive — no cells kept'); return; }
    // Placement-preserving: a fresh grid is pivot-centered on the sprite (origin), but an
    // imported multi-part rig carries each part's offset in its mesh verts. Re-center the
    // new grid onto the part's CURRENT position so Re-tessellate doesn't collapse it to origin.
    const prev = ap.mesh?.verts ?? [];
    if (prev.length) {
      const oc = centerOf(prev), nc = centerOf(mesh.verts);
      const dx = oc.x - nc.x, dy = oc.y - nc.y;
      if (dx || dy) mesh.verts = mesh.verts.map((v) => [v[0] + dx, v[1] + dy]);
    }
    const radius = awRadius > 0 ? awRadius : Math.max(dom.width, dom.height) * 0.6;
    const { skinIndices, skinWeights } = computeAutoWeights(mesh.verts, concreteBones(d.bones), { radius, falloff: awFalloff });
    commit(withActivePart(d, s.activeSkinPart, { mesh, skinIndices, skinWeights }), `tessellate ${cols}×${rows}`);
  }, [cols, rows, awRadius, awFalloff, trimAlpha, alphaThreshold, commit]);

  const reWeight = useCallback(() => {
    const s = useEditorStore.getState(); const d = s.editingSkinDef;
    const ap = activePartOf(d, s.activeSkinPart);
    if (!d || !ap.mesh?.verts?.length) return;
    const b = meshBounds(ap.mesh.verts);
    const radius = awRadius > 0 ? awRadius : Math.max(b.width, b.height) * 0.6;
    const { skinIndices, skinWeights } = computeAutoWeights(ap.mesh.verts, concreteBones(d.bones), { radius, falloff: awFalloff });
    commit(withActivePart(d, s.activeSkinPart, { skinIndices, skinWeights }), 'auto-weight');
  }, [awRadius, awFalloff, commit]);

  // Toolbar one-click: auto-place a bone chain + tessellate + auto-weight the ACTIVE part
  // from its sprite. Regenerates the SHARED skeleton, so it confirms when bones exist.
  const autoRigActive = useCallback(async () => {
    const s = useEditorStore.getState(); const d = s.editingSkinDef;
    if (!d) return;
    if (s.activeSkinPart < 0) { setSaveMsg('No part selected'); return; }
    const ap = activePartOf(d, s.activeSkinPart);
    if (!ap.sprite) { setSaveMsg('Active part has no sprite'); return; }
    if (d.bones?.length && !window.confirm('Auto-rig regenerates the whole skeleton + this part’s mesh + weights. Continue?')) return;
    const dom = await resolveSpriteDomain(ap.sprite, ap.mesh?.verts ?? []);
    let isInside: ((u: number, v: number) => boolean) | undefined;
    if (trimAlpha && dom.url) { const mask = await loadSpriteAlphaMask(dom.url, { threshold: alphaThreshold, rect: dom.rect }); isInside = mask?.isInside; }
    const rig = autoRig2D({ sprite: ap.sprite, width: dom.width, height: dom.height, isInside });
    const next = withActivePart({ ...d, bones: rig.bones }, s.activeSkinPart, { mesh: rig.mesh, skinIndices: rig.skinIndices, skinWeights: rig.skinWeights });
    commit(next, 'auto-rig');
  }, [trimAlpha, alphaThreshold, commit]);

  // Assign a sprite to a specific part (defaults to the active one). A part with no
  // geometry yet gets a default grid mesh (+ auto-weights) generated over the new sprite so
  // it renders immediately — the expected "add part → pick/drop sprite → it shows up" flow.
  // If the part already has a mesh (or the sprite was cleared), just swap the ref.
  const assignSpriteToPart = useCallback(async (sprite: string, partIndex: number) => {
    const s = useEditorStore.getState(); const d = s.editingSkinDef;
    if (!d) return;
    const ap = activePartOf(d, partIndex);
    const hasMesh = (ap.mesh?.verts?.length ?? 0) > 0;
    if (!sprite || hasMesh) { commit(withActivePart(d, partIndex, { sprite }), 'sprite'); return; }
    const dom = await resolveSpriteDomain(sprite, []);
    let isInside: ((u: number, v: number) => boolean) | undefined;
    if (trimAlpha && dom.url) { const mask = await loadSpriteAlphaMask(dom.url, { threshold: alphaThreshold, rect: dom.rect }); isInside = mask?.isInside; }
    const mesh = generateGridMesh({ width: dom.width, height: dom.height, cols, rows, pivotX: dom.pivotX, pivotY: dom.pivotY, isInside });
    if (!mesh.verts.length) { commit(withActivePart(d, partIndex, { sprite }), 'sprite'); return; } // trim killed every cell → just set the ref
    const radius = awRadius > 0 ? awRadius : Math.max(dom.width, dom.height) * 0.6;
    const { skinIndices, skinWeights } = computeAutoWeights(mesh.verts, concreteBones(d.bones), { radius, falloff: awFalloff });
    commit(withActivePart(d, partIndex, { sprite, mesh, skinIndices, skinWeights }), 'sprite + mesh');
  }, [commit, cols, rows, awRadius, awFalloff, trimAlpha, alphaThreshold]);

  // The active-part variant used by the inspector's sprite ref field.
  const setSprite = useCallback((sprite: string) => assignSpriteToPart(sprite, useEditorStore.getState().activeSkinPart), [assignSpriteToPart]);

  // Resolve an Assets-panel drop to sprite GUID(s) (native HTML5 drop — the same mechanism the
  // Hierarchy uses for prefab drops). A multi-selection arrives as 'application/editor-asset-paths'
  // (all selected paths, any view mode); a single drag also carries 'application/editor-asset'
  // {type,path,name,guid}. Keep only image assets and resolve each to a GUID (refs must be GUIDs).
  const resolveDroppedSprites = useCallback((e: React.DragEvent): string[] => {
    const isImage = (p: string, type?: string) => type === 'sprite' || type === 'texture' || /\.(png|jpe?g|webp)$/i.test(p);
    // A part.sprite ref must be a SPRITE guid, never a raw texture guid — a dropped texture
    // resolves to its derived whole-image sprite (matches SpritePicker's "whole" button); an
    // explicit sprite slice passes through unchanged. (assetRefIntegrity guards this invariant.)
    const toSpriteGuid = (guid: string): string => (getAssetEntry(guid)?.type === 'texture' ? deriveGuid('sprite:' + guid) : guid);
    const pathsRaw = e.dataTransfer.getData('application/editor-asset-paths');
    if (pathsRaw) {
      try {
        const paths = (JSON.parse(pathsRaw) as string[]).filter((p) => isImage(p));
        if (paths.length > 1) return paths.map((p) => getGuidForPath(p)).filter((g): g is string => !!g).map(toSpriteGuid);
      } catch { /* fall through to the single payload */ }
    }
    const raw = e.dataTransfer.getData('application/editor-asset');
    if (!raw) return [];
    const { path, guid, type } = JSON.parse(raw) as { path: string; guid?: string; type?: string };
    if (!isImage(path, type)) return [];
    const resolved = guid || getGuidForPath(path);
    if (!resolved) { console.warn(`[SkinEditor] "${path}" has no GUID yet — refresh the Assets panel and drop again.`); return []; }
    return [toSpriteGuid(resolved)];
  }, []);

  // Append a new part per sprite (each named after its asset, auto-tessellated). Sequential so
  // each addPart reads the freshly-committed def and lands at a correct index.
  const addPartsForSprites = useCallback(async (guids: string[]) => {
    for (const guid of guids) {
      const cur = useEditorStore.getState().editingSkinDef;
      if (!cur) break;
      const { def: next, index } = addPart(cur);
      const nice = assetDisplayName(resolveGuidToPath(guid) ?? '');
      commit(nice ? renamePart(next, index, nice) : next, 'add part');
      useEditorStore.getState().setActiveSkinPart(index);
      await assignSpriteToPart(guid, index).catch((err) => console.error('[SkinEditor] assign failed', err));
    }
  }, [assignSpriteToPart, commit]);

  // Drop onto an existing part row → set that part's art (single), or append parts (multi).
  const onPartDrop = useCallback((e: React.DragEvent, partIndex: number) => {
    e.preventDefault(); e.stopPropagation();
    const sprites = resolveDroppedSprites(e);
    if (sprites.length === 0) return;
    if (sprites.length === 1) {
      useEditorStore.getState().setActiveSkinPart(partIndex);
      void assignSpriteToPart(sprites[0], partIndex).catch((err) => console.error('[SkinEditor] assign failed', err));
    } else {
      void addPartsForSprites(sprites);
    }
  }, [assignSpriteToPart, resolveDroppedSprites, addPartsForSprites]);

  // Drop onto the list's empty space → append a new part per dropped sprite.
  const onListDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const sprites = resolveDroppedSprites(e);
    if (sprites.length) void addPartsForSprites(sprites);
  }, [resolveDroppedSprites, addPartsForSprites]);

  // Move the active part to a target center coordinate (the Position inspector). The part
  // has no explicit origin — its position is its mesh AABB center — so this translates the
  // whole mesh so the center lands on `value` along one axis. Mirrors the canvas Parts gizmo.
  const setPartCenter = useCallback((axis: 'x' | 'y', value: number) => {
    const s = useEditorStore.getState(); const d = s.editingSkinDef;
    if (!d) return;
    const ap = activePartOf(d, s.activeSkinPart);
    const vs = ap.mesh?.verts ?? [];
    if (!vs.length) return;
    const c = centerOf(vs);
    const dx = axis === 'x' ? value - c.x : 0, dy = axis === 'y' ? value - c.y : 0;
    if (!dx && !dy) return;
    commit(withActivePart(d, s.activeSkinPart, { mesh: { ...ap.mesh, verts: vs.map((v) => [v[0] + dx, v[1] + dy]) } }), 'move part');
  }, [commit]);

  // Set the active part's absolute rotation (degrees) — rotates the mesh about its center
  // by the delta from its current angle (read from the UV→vert affine). Mirrors the gizmo.
  const setPartRotation = useCallback((deg: number) => {
    const s = useEditorStore.getState(); const d = s.editingSkinDef;
    if (!d) return;
    const ap = activePartOf(d, s.activeSkinPart);
    const vs = ap.mesh?.verts ?? [];
    const cur = partAngle(vs, ap.mesh?.uvs ?? [], ap.mesh?.tris ?? []);
    if (!vs.length || cur == null) return;
    const delta = deg * Math.PI / 180 - cur;
    if (Math.abs(delta) < 1e-6) return;
    const c = centerOf(vs), cs = Math.cos(delta), sn = Math.sin(delta);
    const newVerts = vs.map((v) => { const dx = v[0] - c.x, dy = v[1] - c.y; return [c.x + cs * dx - sn * dy, c.y + sn * dx + cs * dy]; });
    commit(withActivePart(d, s.activeSkinPart, { mesh: { ...ap.mesh, verts: newVerts } }), 'rotate part');
  }, [commit]);

  // Set the active part's size (px) along one axis, scaling the mesh about its center. The
  // factor is value / current-axis-length (from the UV→vert affine). `uniform` (aspect lock)
  // scales BOTH axes by that factor — a pure uniform scale, rotation-invariant. Otherwise
  // only the chosen LOCAL axis scales (preserving rotation via the part's own frame).
  const setPartSize = useCallback((axis: 'x' | 'y', value: number, uniform: boolean) => {
    const s = useEditorStore.getState(); const d = s.editingSkinDef;
    if (!d) return;
    const ap = activePartOf(d, s.activeSkinPart);
    const vs = ap.mesh?.verts ?? [];
    const aff = uvToPosAffine(vs, ap.mesh?.uvs ?? [], ap.mesh?.tris ?? []);
    if (!vs.length || !aff || value < 0.001) return;
    const curLen = axis === 'x' ? Math.hypot(aff.m00, aff.m10) : Math.hypot(aff.m01, aff.m11);
    if (curLen < 1e-6) return;
    const f = value / curLen;
    if (Math.abs(f - 1) < 1e-6) return;
    const c = centerOf(vs);
    let newVerts: number[][];
    if (uniform) {
      newVerts = vs.map((v) => [c.x + f * (v[0] - c.x), c.y + f * (v[1] - c.y)]);
    } else {
      const theta = Math.atan2(aff.m10, aff.m00), cs = Math.cos(theta), sn = Math.sin(theta);
      const fx = axis === 'x' ? f : 1, fy = axis === 'y' ? f : 1;
      newVerts = vs.map((v) => {
        const dx = v[0] - c.x, dy = v[1] - c.y;
        const lx = (dx * cs + dy * sn) * fx, ly = (-dx * sn + dy * cs) * fy; // into local frame, scale
        return [c.x + lx * cs - ly * sn, c.y + lx * sn + ly * cs];           // back to world
      });
    }
    commit(withActivePart(d, s.activeSkinPart, { mesh: { ...ap.mesh, verts: newVerts } }), 'scale part');
  }, [commit]);

  // Edit the SELECTED bone's transform field (shared inspector, Rig/Weights modes). Rig →
  // bind pose (undoable); Weights → transient test pose (preview, no undo). `rot` in radians.
  const setBoneField = useCallback((field: 'x' | 'y' | 'rot', v: number) => {
    if (paintMode) {
      setTestPose((prev) => {
        const b = useEditorStore.getState().editingSkinDef?.bones?.[selBone];
        const base = prev[selBone] ?? { x: b?.x ?? 0, y: b?.y ?? 0, rot: b?.rot ?? 0 };
        return { ...prev, [selBone]: { ...base, [field]: v } };
      });
      return;
    }
    const cur = useEditorStore.getState().editingSkinDef;
    if (!cur?.bones || (cur.bones[selBone] as Record<string, unknown> | undefined)?.[field] === v) return;
    commit({ ...cur, bones: cur.bones.map((b, k) => (k === selBone ? { ...b, [field]: v } : b)) }, `bone ${field}`);
  }, [paintMode, selBone, commit]);

  // Delete the SELECTED bone (Rig tool-row Del button). Undoable.
  const deleteBone = useCallback(() => {
    if (selBone < 0) return;
    const cur = useEditorStore.getState().editingSkinDef;
    if (cur) { commit(removeBone(cur, selBone), 'delete bone'); setSelBone(-1); }
  }, [selBone, commit]);

  // Rename the SELECTED bone (unified inspector name field). Undoable.
  const setBoneName = useCallback((name: string) => {
    const n = name.trim();
    const cur = useEditorStore.getState().editingSkinDef;
    if (!n || !cur?.bones || cur.bones[selBone]?.name === n) return;
    commit({ ...cur, bones: cur.bones.map((b, i) => (i === selBone ? { ...b, name: n } : b)) }, 'rename bone');
  }, [selBone, commit]);

  // Structural part edits (undoable). partAction commits a pre-built next def.
  const partAction = useCallback((next: Rig2DFile, label: string) => { if (useEditorStore.getState().editingSkinDef) commit(next, label); }, [commit]);
  // Drag-reorder: move part `from` → `to` (one undo), keeping the same logical part active.
  const reorderParts = useCallback((from: number, to: number) => {
    const d = useEditorStore.getState().editingSkinDef;
    if (!d || from === to) return;
    partAction(reorderPart(d, from, to), 'reorder part');
    const active = useEditorStore.getState().activeSkinPart;
    const na = reorderActiveIndex(active, from, to);
    if (na !== active) useEditorStore.getState().setActiveSkinPart(na);
  }, [partAction]);
  const addPartAction = useCallback(() => {
    const d = useEditorStore.getState().editingSkinDef;
    if (!d) return;
    const { def: next, index } = addPart(d);
    commit(next, 'add part');
    useEditorStore.getState().setActiveSkinPart(index);
  }, [commit]);

  // Create a new empty .rig2d.json via the native Save dialog, then open it.
  const newRig = useCallback(async () => {
    const path = await saveAssetDialog({ defaultName: 'New Rig.rig2d.json', ext: '.rig2d.json', prompt: 'Create Rig2D' });
    if (!path) return;
    const guid = newGuid();
    const doc: Rig2DFile = { id: guid, sprite: '', bones: [{ name: 'root', parent: -1, x: 0, y: 0, rot: 0 }], mesh: { verts: [], uvs: [], tris: [] }, skinIndices: [], skinWeights: [] };
    const ok = await backendFetch('/api/write-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, content: JSON.stringify(doc, null, 2) }) }).then((r) => r.ok).catch(() => false);
    if (!ok) return;
    registerAsset(guid, path, 'rig2d');
    const name = (path.split('/').pop() || 'Rig').replace(/\.rig2d\.json$/i, '');
    useEditorStore.getState().openSkinEditor({ path, type: 'rig2d', name });
  }, []);

  // One-click: generate a rig (mesh + default bones + weights) from the SELECTED
  // texture/sprite, save it beside the sprite, and open it. Path is auto-derived (no
  // dialog) — the whole point is a fast on-ramp; rename later if needed.
  const autoRigSelected = useCallback(async () => {
    const sel = useEditorStore.getState().selectedAsset;
    if (!sel) return;
    const guid = getGuidForPath(sel.path);
    if (!guid) return;
    let dims: { width: number; height: number } | null = null;
    let maskUrl = assetUrl(sel.path);
    let rect: { x: number; y: number; w: number; h: number } | undefined;
    const entry = getAssetEntry(guid);
    if (entry?.sprite?.rect && entry.sprite.rect.w > 0) {
      dims = { width: entry.sprite.rect.w, height: entry.sprite.rect.h };
      rect = { ...entry.sprite.rect };
      const texPath = resolveGuidToPath(entry.sprite.texture);
      if (texPath) maskUrl = assetUrl(texPath);
    } else dims = await loadImageDims(maskUrl);
    if (!dims || dims.width < 1 || dims.height < 1) { console.warn('[SkinEditor] could not read sprite dimensions for', sel.path); return; }
    let isInside: ((u: number, v: number) => boolean) | undefined;
    if (trimAlpha) {
      const mask = await loadSpriteAlphaMask(maskUrl, { threshold: alphaThreshold, rect });
      isInside = mask?.isInside;
    }
    const rigGuid = newGuid();
    const rig = autoRig2D({ id: rigGuid, sprite: guid, width: dims.width, height: dims.height, isInside });
    const rigPath = sel.path.replace(/\.(png|jpe?g|webp|gif)$/i, '') + '.rig2d.json';
    const ok = await backendFetch('/api/write-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: rigPath, content: JSON.stringify(rig, null, 2) }) }).then((r) => r.ok).catch(() => false);
    if (!ok) return;
    registerAsset(rigGuid, rigPath, 'rig2d');
    const name = (rigPath.split('/').pop() || 'Rig').replace(/\.rig2d\.json$/i, '');
    useEditorStore.getState().openSkinEditor({ path: rigPath, type: 'rig2d', name });
  }, [trimAlpha, alphaThreshold]);

  // Generate a reusable .prefab.json (SkinnedSprite2D + Bone2D chain referencing this
  // rig) beside the rig, then drag it into scenes as a linked instance (prefab drag-drop
  // is free). No scene entities are created here — the prefab is the placeable "character".
  const makePrefab = useCallback(async () => {
    const store = useEditorStore.getState();
    const d = store.editingSkinDef;
    const path = store.editingSkinAsset?.path;
    if (!d || !path) return;
    const rootName = (store.editingSkinAsset?.name || 'Skinned').replace(/\.rig2d$/i, '');
    const savePath = path.replace(/\.rig2d\.json$/i, '.prefab.json');
    const isUpdate = !!getGuidForPath(savePath);
    setSaveMsg(isUpdate ? 'Updating prefab…' : 'Making prefab…');
    const result = await makeRigPrefabAsset(path, d, savePath, rootName);
    setSaveMsg(!result ? 'Prefab failed'
      : result.updated ? 'Prefab updated ✓ — placed instances refreshed'
      : 'Prefab created ✓ — drag it from Assets into a Canvas2D');
  }, []);

  // ── Debounced auto-save (watches the store def → covers edits + undo/redo) ──
  const writeDef = useCallback((d: Rig2DFile): Promise<boolean> => {
    const path = asset?.path;
    if (!path) return Promise.resolve(false);
    setSaveMsg('Saving…');
    return backendFetch('/api/write-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content: JSON.stringify(d, null, 2) }),
    }).then((res) => { setSaveMsg(res.ok ? 'Saved ✓' : `Save failed (${res.status})`); return res.ok; })
      .catch((e) => { console.error('[SkinEditor] auto-save failed', e); setSaveMsg('Save failed'); return false; });
  }, [asset?.path]);
  const { markSaved } = useDebouncedSave(def, writeDef, AUTOSAVE_MS);
  savedMarkRef.current = markSaved;

  const bones = concreteBones(def?.bones);
  const parts = partsOf(def);
  // Master checkbox state (canvas-preview visibility, editor-only — NOT the runtime
  // `visible` field): checked when every part is shown, indeterminate when mixed.
  const hiddenCount = parts.reduce((n, _p, i) => n + (previewHidden.includes(i) ? 1 : 0), 0);
  const allPartsVisible = parts.length > 0 && hiddenCount === 0;
  const somePartsHidden = hiddenCount > 0 && hiddenCount < parts.length;
  const ap = activePartOf(def, activePart);
  // Does a prefab already exist for this rig? → the button becomes "Update" (preserves
  // the prefab GUID so placed instances stay linked). Re-evaluated each render (saveMsg
  // state change after a create/update re-renders, flipping the label).
  const prefabExists = !!asset && !!getGuidForPath(asset.path.replace(/\.rig2d\.json$/i, '.prefab.json'));
  const verts = ap.mesh?.verts ?? [];
  const tris = ap.mesh?.tris ?? [];
  // meshBounds is an O(verts) scan feeding ONLY the Weights-mode auto-weight radius slider —
  // skip it in Parts/Rig mode (where it was computed-but-unused every render).
  let awRadiusMax = 16;
  if (paintMode) {
    const awBnds = meshBounds(verts);
    awRadiusMax = Math.max(16, Math.ceil(Math.hypot(awBnds.width, awBnds.height)));
  }

  // Selected-bone Name + (test-pose) + Transform — shared by the Rig and Weights inspectors.
  const renderBoneInspector = (emptyMsg: string) => {
    if (selBone < 0 || selBone >= bones.length) return <div style={inspectorEmpty}>{emptyMsg}</div>;
    const b = bones[selBone];
    const posed = paintMode && testPose[selBone] ? { ...b, ...testPose[selBone] } : b;
    const poseActive = paintMode && Object.keys(testPose).length > 0;
    return (
      <>
        <div style={inspectorHeadStyle}>
          <span style={{ ...inspectorKind, color: paintMode ? '#7a9c5a' : '#5a7a9a' }}>{paintMode ? 'Bone · pose' : 'Bone'}</span>
          <input key={`b${selBone}`} defaultValue={b.name} onBlur={(e) => setBoneName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { e.currentTarget.value = b.name; e.currentTarget.blur(); } }}
            style={nameInputStyle} />
        </div>
        {poseActive && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ color: '#9c6', fontSize: 10 }}>Test pose{testPose[selBone] ? ' *' : ''} (preview)</span>
            <button onClick={() => setTestPose(() => ({}))} title="Reset the test pose to bind" style={{ background: '#2a2a40', color: '#bbb', border: '1px solid #444', borderRadius: 3, padding: '1px 6px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 10 }}>reset</button>
          </div>
        )}
        <div style={{ ...inspectorBox, border: `1px solid ${paintMode ? '#3a5a2a' : '#2a2a3a'}` }}>
          <div style={inspectorTitle}><span>Transform</span>
            <InfoDot tip="The selected bone's transform. In Rig mode this edits the bind pose (undoable); in Weights mode it's a transient TEST pose to preview the deform (not saved)." /></div>
          <div style={trowStyle}><span style={{ ...lbl, width: 26 }}>pos</span>
            <span style={lbl}>x</span><BufferedNumberInput value={posed.x} step={1} onChange={(v) => setBoneField('x', v)} style={{ ...inputStyle, width: 50 }} />
            <span style={lbl}>y</span><BufferedNumberInput value={posed.y} step={1} onChange={(v) => setBoneField('y', v)} style={{ ...inputStyle, width: 50 }} /></div>
          <div style={{ ...trowStyle, marginBottom: 0 }}><span style={{ ...lbl, width: 26 }}>rot°</span>
            <BufferedNumberInput value={+(posed.rot * 180 / Math.PI).toFixed(2)} step={1} onChange={(v) => setBoneField('rot', v * Math.PI / 180)} style={{ ...inputStyle, width: 50 }} /></div>
        </div>
      </>
    );
  };

  // Auto-weight tool box (Weights inspector) — binds the active part's mesh to the bones.
  const autoWeightBox = (
    <div style={inspectorBox}>
      <div style={inspectorTitle}><span>Auto-weight</span>
        <InfoDot tip="Binds each mesh vertex to its nearest bones. radius = how far a bone's pull reaches (auto = from mesh size); falloff = how sharply it fades. Run it for a baseline, then refine with the brush." /></div>
      {bones.length === 0 ? <div style={{ color: '#777', fontSize: 10, marginBottom: 4 }}>No bones yet — add bones in Rig mode.</div> : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}><span style={{ ...lbl, width: 40 }}>radius</span>
            <input type="range" min={0} max={awRadiusMax} step={2} value={awRadius} onChange={(e) => setAwRadius(+e.target.value)} style={{ flex: 1, minWidth: 0, accentColor: '#4a9eff' }} />
            <span style={{ color: '#999', width: 30, textAlign: 'right', fontSize: 10 }}>{awRadius > 0 ? Math.round(awRadius) : 'auto'}</span></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}><span style={{ ...lbl, width: 40 }}>falloff</span>
            <input type="range" min={0.5} max={4} step={0.1} value={awFalloff} onChange={(e) => setAwFalloff(+e.target.value)} style={{ flex: 1, minWidth: 0, accentColor: '#4a9eff' }} />
            <span style={{ color: '#999', width: 30, textAlign: 'right', fontSize: 10 }}>{awFalloff.toFixed(1)}</span></div>
        </>
      )}
      <button onClick={reWeight} disabled={!verts.length || !bones.length} title="Recompute per-vertex weights for the current mesh + bones" style={{ ...btn, width: '100%', marginTop: 2, opacity: (!verts.length || !bones.length) ? 0.5 : 1 }}>Auto-weight</button>
    </div>
  );

  if (!asset || !def) {
    const spriteSel = selectedAsset && (selectedAsset.type === 'texture' || selectedAsset.type === 'sprite') ? selectedAsset : null;
    return (
      <div style={panelStyle}>
        <div style={{ margin: 'auto', textAlign: 'center', color: '#555' }}>
          {spriteSel && (
            <div style={{ marginBottom: 16 }}>
              <button onClick={autoRigSelected} style={{ ...btn, padding: '7px 16px', background: '#20361f', borderColor: '#3a7a44', color: '#cfe' }}>⚙ Auto-rig “{spriteSel.name}”</button>
              <div style={{ fontSize: 10, color: '#666', marginTop: 5 }}>generate a mesh + bones + weights from this sprite</div>
            </div>
          )}
          <div>Double-click a .rig2d.json in Assets to edit its rig,</div>
          <div style={{ marginTop: 6 }}>or</div>
          <button onClick={newRig} style={{ ...btn, marginTop: 8, padding: '6px 14px' }}>+ New Rig</button>
        </div>
      </div>
    );
  }

  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexShrink: 0 }}>
        <button onClick={() => useEditorStore.getState().closeSkinEditor()} title="Close rig (back to the picker)" style={{ ...btn, padding: '1px 7px' }}>✕</button>
        <span style={{ fontWeight: 'bold', color: '#ddd', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{asset.name}</span>
        <span style={{ fontSize: 10, color: saveMsg.includes('fail') ? '#e74c3c' : '#2ecc71' }}>{saveMsg || 'Auto-save'}</span>
      </div>

      {/* Toolbar: one-click auto-rig + undo/redo. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexShrink: 0 }}>
        <button onClick={autoRigActive} title="One click: auto-place a bone chain + tessellate + auto-weight the active part from its sprite" style={{ ...btn, background: '#20361f', borderColor: '#3a7a44', color: '#cfe' }}>⚙ Auto-rig</button>
        <div style={{ flex: 1 }} />
        <button onClick={() => gUndo()} title="Undo (⌘Z)" style={btn}>↶</button>
        <button onClick={() => gRedo()} title="Redo (⇧⌘Z)" style={btn}>↷</button>
      </div>

      {/* Top row — two columns: Parts group (part list) | Bones group (bone list). */}
      <div style={{ display: 'flex', gap: 8, height: 180, flexShrink: 0, marginBottom: 6 }}>
        {/* ── Parts group ── */}
        <div style={groupColStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', minWidth: 0 }} title={allPartsVisible ? 'Hide all parts in the canvas preview' : 'Show all parts in the canvas preview'}>
              <input type="checkbox" checked={allPartsVisible} ref={(el) => { if (el) el.indeterminate = somePartsHidden; }}
                onChange={() => useEditorStore.getState().setSkinPreviewHidden(allPartsVisible ? parts.map((_, i) => i) : [])}
                style={{ accentColor: '#4a9eff', cursor: 'pointer' }} />
              <span style={sectionLabel}>Parts ({parts.length})</span>
              <InfoDot tip="Each part is a sprite + its own mesh; all parts share one skeleton. Click a part to make it active (mesh/weights ops target it). The checkbox hides a part in THIS canvas only — it never affects the game or scene view." />
            </label>
            <button onClick={addPartAction} title="Add a new empty part" style={{ ...btn, padding: '0px 7px', fontSize: 12 }}>＋</button>
          </div>
          <div style={{ ...columnListStyle, outline: dropOverPart === -1 ? '2px solid #3498db' : 'none' }}
            onDragOver={(e) => {
              const t = e.dataTransfer.types;
              if (t.includes('application/skin-part')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (reorderOverPart !== parts.length - 1) setReorderOverPart(parts.length - 1); }
              else if (t.includes('application/editor-asset')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (dropOverPart !== -1) setDropOverPart(-1); }
            }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { setDropOverPart(null); setReorderOverPart(null); } }}
            onDrop={(e) => {
              if (e.dataTransfer.types.includes('application/skin-part')) {
                e.preventDefault();
                const from = +e.dataTransfer.getData('application/skin-part');
                setDragPart(null); setReorderOverPart(null);
                if (!Number.isNaN(from)) reorderParts(from, parts.length - 1);
                return;
              }
              setDropOverPart(null); onListDrop(e);
            }}
            title="Drag a part to reorder · drop a sprite from Assets into empty space to add a new part">
            {parts.map((p, i) => (
              <div key={i} onClick={() => useEditorStore.getState().setActiveSkinPart(i)}
                title="Drag to reorder · drop a sprite from Assets to set this part's source art"
                draggable={editingPart !== i}
                onDragStart={(e) => { e.dataTransfer.setData('application/skin-part', String(i)); e.dataTransfer.effectAllowed = 'move'; setDragPart(i); }}
                onDragEnd={() => { setDragPart(null); setReorderOverPart(null); }}
                onDragOver={(e) => {
                  const t = e.dataTransfer.types;
                  if (t.includes('application/skin-part')) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; if (reorderOverPart !== i) setReorderOverPart(i); }
                  else if (t.includes('application/editor-asset')) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; if (dropOverPart !== i) setDropOverPart(i); }
                }}
                onDrop={(e) => {
                  if (e.dataTransfer.types.includes('application/skin-part')) {
                    e.preventDefault(); e.stopPropagation();
                    const from = +e.dataTransfer.getData('application/skin-part');
                    setDragPart(null); setReorderOverPart(null);
                    // The indicator is a TOP border on row i ("insert before row i"). For a
                    // downward drag (from < i) removing `from` shifts row i down by one, so the
                    // final slot is i-1; upward drags land at i directly.
                    if (!Number.isNaN(from)) reorderParts(from, from < i ? i - 1 : i);
                    return;
                  }
                  setDropOverPart(null); onPartDrop(e, i);
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '1px 3px', cursor: 'pointer', outline: i === dropOverPart ? '2px solid #3498db' : 'none', boxShadow: reorderOverPart === i && dragPart !== null && dragPart !== i ? 'inset 0 2px 0 #2ecc71' : 'none', opacity: dragPart === i ? 0.4 : 1, background: i === activePart ? '#20303f' : 'transparent' }}>
                <input type="checkbox" checked={!previewHidden.includes(i)} onClick={(e) => e.stopPropagation()}
                  onChange={(e) => { e.stopPropagation(); useEditorStore.getState().toggleSkinPreviewPart(i); }}
                  title={previewHidden.includes(i) ? 'Show in canvas preview' : 'Hide in canvas preview'} style={{ accentColor: '#4a9eff', cursor: 'pointer', margin: '0 2px' }} />
                {editingPart === i ? (
                  <input autoFocus defaultValue={p.name} onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== p.name) partAction(renamePart(def!, i, n), 'rename part'); setEditingPart(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { e.currentTarget.value = p.name; e.currentTarget.blur(); } }}
                    style={{ flex: 1, minWidth: 0, background: '#0e0e16', color: '#ccc', border: '1px solid #3a6a8a', borderRadius: 3, padding: '1px 4px', fontFamily: 'monospace', fontSize: 11 }} />
                ) : (
                  <span onDoubleClick={(e) => { e.stopPropagation(); setEditingPart(i); }}
                    style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: i === activePart ? '#cde' : (previewHidden.includes(i) ? '#666' : '#bbb') }} title={`${p.name} — double-click to rename`}>{p.name}</span>
                )}
                <button onClick={(e) => { e.stopPropagation(); partAction(movePart(def!, i, -1), 'move part'); }} title="Move back" disabled={i === 0} style={{ ...eyeBtn, opacity: i === 0 ? 0.3 : 1 }}>↑</button>
                <button onClick={(e) => { e.stopPropagation(); partAction(movePart(def!, i, 1), 'move part'); }} title="Move front" disabled={i === parts.length - 1} style={{ ...eyeBtn, opacity: i === parts.length - 1 ? 0.3 : 1 }}>↓</button>
                <button onClick={(e) => { e.stopPropagation(); if (parts.length > 1) { partAction(removePart(def!, i), 'remove part'); const na = i < activePart ? activePart - 1 : activePart; useEditorStore.getState().setActiveSkinPart(Math.min(na, parts.length - 2)); } }} title="Remove part" disabled={parts.length <= 1} style={{ ...eyeBtn, color: '#c66', opacity: parts.length <= 1 ? 0.3 : 1 }}>✕</button>
              </div>
            ))}
          </div>
        </div>

        {/* ── Bones group ── */}
        <div style={groupColStyle}>
          <div style={{ ...sectionLabel, margin: 0, flexShrink: 0 }}>Bones ({bones.length})</div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <SkinBoneList selBone={selBone} setSelBone={setSelBone} />
          </div>
        </div>
      </div>
      {/* Mode selector — full-width row (Parts / Rig / Weights). */}
      <div style={modeRowStyle}>
        <button onClick={() => useEditorStore.getState().setSkinMode('parts')} style={mbtn(skinMode === 'parts')} title="Parts — drag to reposition the active part's mesh">✥ Parts</button>
        <button onClick={() => useEditorStore.getState().setSkinMode('rig')} style={mbtn(skinMode === 'rig')} title="Rig — add / select / move / rotate bones">🦴 Rig</button>
        <button onClick={() => useEditorStore.getState().setSkinMode('weights')} style={mbtn(skinMode === 'weights')} title="Weights — paint the selected bone's per-vertex influence">🖌 Weights</button>
      </div>

      {/* Tool parameters — full-width row; contents depend on the active mode. */}
      <div style={toolRowStyle}>
        {skinMode === 'parts' && (
          <span style={{ fontSize: 10, color: '#8ab4d8', lineHeight: 1.3 }}>Drag the active part’s mesh on the canvas to reposition it — pick the active part in the Parts list.</span>
        )}
        {skinMode === 'rig' && (
          <>
            <button onClick={() => useEditorStore.getState().setSkinBoneTool('select')} style={tbtn(skinBoneTool === 'select')} title="Select / move + rotate joints (gizmo)">Select</button>
            <button onClick={() => useEditorStore.getState().setSkinBoneTool('add')} style={tbtn(skinBoneTool === 'add')} title="Click to add a bone — chains as a child of the selected one">＋ Bone</button>
            <button onClick={deleteBone} disabled={selBone < 0} style={{ ...tbtn(false), opacity: selBone < 0 ? 0.5 : 1 }} title="Delete the selected bone">Del</button>
          </>
        )}
        {skinMode === 'weights' && (
          <>
            <button onClick={() => useEditorStore.getState().setSkinWeightTool('paint')} style={tbtn(skinWeightTool === 'paint')} title="Brush — paint the selected bone's weights (B)">🖌 Paint</button>
            <button onClick={() => useEditorStore.getState().setSkinWeightTool('transform')} style={tbtn(skinWeightTool === 'transform')} title="Test-pose the bone to preview the deform — does not change the rig (W)">✥ Pose</button>
            <button onClick={() => useEditorStore.getState().setSkinHideTexture(!skinHideTexture)} style={tbtn(skinHideTexture)} title="Hide the sprite — show only the weight heatmap (grayscale)">{skinHideTexture ? '◼ Weights only' : '◻ Weights only'}</button>
            {skinWeightTool === 'paint' && (
              <>
                <label style={ovRow}><span style={ovLbl}>size</span>
                  <input type="range" min={1} max={256} step={1} value={skinPaint.radius} onChange={(e) => useEditorStore.getState().setSkinPaint({ radius: +e.target.value })} style={ovRange} />
                  <span style={ovVal}>{Math.round(skinPaint.radius)}</span></label>
                <label style={ovRow}><span style={ovLbl} title={skinPaint.brush === 'set' ? 'target weight' : 'brush strength'}>{skinPaint.brush === 'set' ? 'wt' : 'str'}</span>
                  <input type="range" min={0} max={1} step={0.01} value={skinPaint.strength} onChange={(e) => useEditorStore.getState().setSkinPaint({ strength: +e.target.value })} style={ovRange} />
                  <span style={ovVal}>{skinPaint.strength.toFixed(2)}</span></label>
                <div style={{ display: 'flex', gap: 3 }}>
                  {(([['add', 'Add', '#20361f', '#3a7a44'], ['subtract', 'Sub', '#3a2020', '#7a3a3a'], ['set', 'Set', '#1f2c3a', '#3a6a8a']]) as [('add' | 'subtract' | 'set'), string, string, string][]).map(([m, label, bg, bd]) => (
                    <button key={m} onClick={() => useEditorStore.getState().setSkinPaint({ brush: m })} style={{ ...tbtn(false), background: skinPaint.brush === m ? bg : '#2a2a40', border: `1px solid ${skinPaint.brush === m ? bd : '#444'}` }}>{label}</button>
                  ))}
                </div>
              </>
            )}
            {skinWeightTool === 'transform' && (
              <>
                <button onClick={() => setTestPose({})} disabled={Object.keys(testPose).length === 0} style={{ ...tbtn(false), opacity: Object.keys(testPose).length === 0 ? 0.5 : 1 }} title="Clear the test pose — snap all bones back to bind">↺ Reset pose</button>
                <span style={{ fontSize: 10, color: '#d8b45a', lineHeight: 1.3 }}><b>Preview only</b> — poses to test the deform; doesn’t move the bone or change the rig.</span>
              </>
            )}
          </>
        )}
      </div>

      {/* Canvas | inspector — two columns. The inspector is UNIFIED: in Parts mode it edits
          the active part (pos / rot / size); in Rig/Weights it edits the selected bone
          (pos / rot — no size). The mode selector + tool params are the two rows above. */}
      <div style={{ display: 'flex', gap: 8, flexShrink: 0, marginBottom: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SkinCanvas selBone={selBone} setSelBone={setSelBone} testPose={testPose} setTestPose={setTestPose} />
        </div>
        <div style={{ width: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {skinMode === 'parts' ? (activePart < 0 ? <div style={inspectorEmpty}>No part selected — click a part in the canvas or list</div> : (() => {
            const partName = parts[activePart]?.name ?? '';
            const hasMesh = verts.length > 0;
            const c = hasMesh ? centerOf(verts) : { x: 0, y: 0 };
            const aff = hasMesh ? uvToPosAffine(verts, ap.mesh?.uvs ?? [], ap.mesh?.tris ?? []) : null;
            const rotDeg = aff ? +(Math.atan2(aff.m10, aff.m00) * 180 / Math.PI).toFixed(2) : 0;
            const wPx = aff ? +Math.hypot(aff.m00, aff.m10).toFixed(1) : 0;
            const hPx = aff ? +Math.hypot(aff.m01, aff.m11).toFixed(1) : 0;
            return (
              <>
                {/* Name (generalized — part) */}
                <div style={inspectorHeadStyle}>
                  <span style={inspectorKind}>Part</span>
                  <input key={`p${activePart}`} defaultValue={partName}
                    onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== partName) partAction(renamePart(def!, activePart, n), 'rename part'); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { e.currentTarget.value = partName; e.currentTarget.blur(); } }}
                    style={nameInputStyle} />
                </div>
                {/* Source art */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <RigSpriteThumb guid={ap.sprite ?? ''} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ ...sectionLabel, margin: '0 0 2px' }}>Source art</div>
                    <AssetRefField label="" value={ap.sprite ?? ''} onChange={setSprite} accept={['sprite']} placeholder="pick (▦) or drop a sprite" />
                  </div>
                </div>
                {/* Transform (needs a mesh) */}
                {hasMesh ? (
                  <div style={inspectorBox}>
                    <div style={inspectorTitle}><span>Transform</span>
                      <InfoDot tip="The active part's placement — baked into the mesh verts (a part has no transform node). Position = mesh center; Rotation + Size read from the UV→vertex map. Edit here or with the canvas Parts gizmo. Size is width/height in px." /></div>
                    <div style={trowStyle}><span style={{ ...lbl, width: 26 }}>pos</span>
                      <span style={lbl}>x</span><BufferedNumberInput value={+c.x.toFixed(1)} step={1} onChange={(v) => setPartCenter('x', v)} style={{ ...inputStyle, width: 50 }} />
                      <span style={lbl}>y</span><BufferedNumberInput value={+c.y.toFixed(1)} step={1} onChange={(v) => setPartCenter('y', v)} style={{ ...inputStyle, width: 50 }} /></div>
                    <div style={trowStyle}><span style={{ ...lbl, width: 26 }}>rot°</span>
                      <BufferedNumberInput value={rotDeg} step={1} onChange={(v) => setPartRotation(v)} readOnly={!aff} style={{ ...inputStyle, width: 50, opacity: aff ? 1 : 0.5 }} /></div>
                    <div style={{ ...trowStyle, marginBottom: 0 }}><span style={{ ...lbl, width: 26 }}>size</span>
                      <span style={lbl}>w</span><BufferedNumberInput value={wPx} step={1} onChange={(v) => setPartSize('x', v, sizeLocked)} readOnly={!aff} style={{ ...inputStyle, width: 50, opacity: aff ? 1 : 0.5 }} />
                      <span style={lbl}>h</span><BufferedNumberInput value={hPx} step={1} onChange={(v) => setPartSize('y', v, sizeLocked)} readOnly={!aff} style={{ ...inputStyle, width: 50, opacity: aff ? 1 : 0.5 }} />
                      <button onClick={() => setSizeLocked((l) => !l)} title={sizeLocked ? 'Aspect ratio locked — w/h scale together. Click to unlock.' : 'Aspect ratio unlocked — w/h scale independently. Click to lock.'}
                        style={{ ...eyeBtn, color: sizeLocked ? '#4a9eff' : '#777', fontSize: 12 }}>{sizeLocked ? '🔒' : '🔓'}</button></div>
                  </div>
                ) : (
                  <div style={inspectorEmpty}>Pick a sprite above — it builds the mesh.</div>
                )}
                {/* Tessellate tool (Parts mode) — generate/regenerate the deformable grid. */}
                <div style={inspectorBox}>
                  <div style={inspectorTitle}><span>Mesh · {verts.length}v · {Math.floor(tris.length / 3)}t</span>
                    <InfoDot tip="The deformable grid over the sprite. cols×rows = density (more bends smoother, costs more CPU). Re-tessellate keeps the part where it sits. Trim to alpha drops fully-transparent cells so the mesh hugs the opaque shape." /></div>
                  <div style={trowStyle}><span style={{ ...lbl, width: 26 }}>cols</span>
                    <BufferedNumberInput value={cols} step={1} onChange={(v) => setCols(Math.max(1, Math.min(24, Math.round(v))))} style={{ ...inputStyle, width: 44 }} />
                    <span style={{ ...lbl, marginLeft: 4 }}>rows</span><BufferedNumberInput value={rows} step={1} onChange={(v) => setRows(Math.max(1, Math.min(24, Math.round(v))))} style={{ ...inputStyle, width: 44 }} /></div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: '#aaa', fontSize: 11, marginBottom: trimAlpha ? 3 : 4 }}>
                    <input type="checkbox" checked={trimAlpha} onChange={(e) => setTrimAlpha(e.target.checked)} style={{ accentColor: '#4a9eff' }} /> Trim to alpha</label>
                  {trimAlpha && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}><span style={lbl}>α</span>
                      <input type="range" min={0} max={128} step={1} value={alphaThreshold} onChange={(e) => setAlphaThreshold(+e.target.value)} style={{ flex: 1, minWidth: 0, accentColor: '#4a9eff' }} />
                      <span style={{ color: '#999', width: 22, textAlign: 'right', fontSize: 10 }}>{alphaThreshold}</span></div>
                  )}
                  <button onClick={reTessellate} disabled={!ap.sprite} title="Regenerate the deformable grid mesh + weights (keeps the part's current position)" style={{ ...btn, width: '100%', opacity: ap.sprite ? 1 : 0.5 }}>Re-tessellate</button>
                </div>
              </>
            );
          })()) : skinMode === 'weights' ? (
            <>
              {renderBoneInspector('Select a bone to pose or paint.')}
              {autoWeightBox}
            </>
          ) : (
            renderBoneInspector('Select a bone.')
          )}
        </div>
      </div>

      {/* Export folds into a collapsible section (tessellate + auto-weight moved to the
          mode-based inspector column). */}
      <div style={stepBodyStyle}>
        {/* ── Export: prefab (collapsible) ── */}
        <Section title="Export">
          <div style={{ color: '#aaa', fontSize: 11, marginBottom: 8, lineHeight: 1.5 }}>{parts.length} part{parts.length === 1 ? '' : 's'} · {bones.length} bones · {verts.length} verts</div>
          <button onClick={makePrefab} disabled={!bones.length}
            title={prefabExists
              ? 'Update the existing .prefab.json in place — its GUID is preserved, so instances already placed in scenes stay linked and refresh'
              : 'Generate a reusable .prefab.json (SkinnedSprite2D + Bone2D) from this rig — then drag it from Assets into a Canvas2D'}
            style={{ ...btn, width: '100%', padding: '7px', background: '#20303f', borderColor: '#3a6a8a', color: '#cde', opacity: bones.length ? 1 : 0.5 }}>{prefabExists ? '↻ Update Prefab' : '＋ Make Prefab'}</button>
          <div style={{ marginTop: 8, color: '#666', fontSize: 10, lineHeight: 1.5 }}>{prefabExists ? 'Updates the prefab in place — placed instances stay linked and refresh.' : 'Creates a placeable prefab. Drag it from Assets into a Canvas2D.'}</div>
        </Section>
      </div>
    </div>
  );
}

/** A collapsible control section — used for the heavier operations (tessellate / weights /
 *  export) so the always-visible Parts + Bones lists + canvas stay in view. Defaults open. */
function Section({ title, tip, children }: { title: string; tip?: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ flexShrink: 0, borderTop: '1px solid #23232f', marginTop: 6, paddingTop: 4 }}>
      <div onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}>
        <span style={{ color: '#889', fontSize: 9, width: 12 }}>{open ? '▾' : '▸'}</span>
        <span style={sectionLabel}>{title}</span>
        {tip && <InfoDot tip={tip} />}
      </div>
      {open && <div style={{ paddingTop: 4 }}>{children}</div>}
    </div>
  );
}

/** A hoverable ⓘ hint bubble for a non-obvious control. */
function InfoDot({ tip }: { tip: string }) {
  return <span title={tip} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 13, height: 13, borderRadius: 7, border: '1px solid #4a5a6a', color: '#8ab4d8', fontSize: 9, fontStyle: 'italic', cursor: 'help', marginLeft: 5, flexShrink: 0, userSelect: 'none' }}>i</span>;
}

/** A small thumbnail of the rig part's source sprite/texture. Handles both a SLICED
 *  sprite (crop the frame out of its sheet) and a WHOLE-IMAGE texture ref (show the full
 *  image, contained) — the parts of a multi-part rig are usually whole-image PNGs, which
 *  otherwise rendered as an empty black box. */
function RigSpriteThumb({ guid }: { guid: string }) {
  const sp = guid ? getAssetEntry(guid)?.sprite : undefined;
  const box: React.CSSProperties = { width: 40, height: 40, border: '1px solid #333', background: '#0e0e16', flexShrink: 0 };
  if (sp && sp.rect.w > 0 && sp.rect.h > 0) {
    const url = sp.texture ? assetUrl(resolveGuidToPath(sp.texture) ?? '') : undefined;
    return <div style={spriteThumbStyle(url, sp.rect, sp.sheetW, sp.sheetH, { w: 40, h: 40 })} />;
  }
  const path = guid ? resolveGuidToPath(guid) : undefined;
  if (path) {
    return <div style={{ ...box, backgroundImage: `url("${assetUrl(path)}")`, backgroundSize: 'contain', backgroundRepeat: 'no-repeat', backgroundPosition: 'center', imageRendering: 'pixelated' }} />;
  }
  return <div style={box} />;
}

const panelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#1a1a2e', fontFamily: 'monospace', fontSize: 12, color: '#ccc', padding: 10, overflowY: 'auto', boxSizing: 'border-box' };
// The per-step body grows to consume leftover vertical space (so the bone tree / parts
// list fill a tall dock instead of leaving dead space at the bottom).
const stepBodyStyle: React.CSSProperties = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' };
// A top-row group column (Parts / Bones) — header on top, its list fills the rest.
const groupColStyle: React.CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' };
// A scrollable list that fills its group column's remaining height.
const columnListStyle: React.CSSProperties = { flex: 1, minHeight: 0, overflowY: 'auto', border: '1px solid #2a2a3a', borderRadius: 4, background: '#141420' };
// Unified transform inspector (right of the canvas) — bone (pos/rot) or part (pos/rot/size).
const inspectorBox: React.CSSProperties = { padding: '6px 7px', border: '1px solid #2a2a3a', borderRadius: 4, background: '#141420' };
const inspectorTitle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, marginBottom: 5, fontSize: 10, color: '#888', minWidth: 0 };
const inspectorEmpty: React.CSSProperties = { padding: '12px 7px', border: '1px dashed #2a2a3a', borderRadius: 4, color: '#666', fontSize: 11, textAlign: 'center' };
const trowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 };
// Full-width toolbar rows above the canvas|inspector area: mode selector + tool params.
const modeRowStyle: React.CSSProperties = { display: 'flex', gap: 4, flexShrink: 0, marginBottom: 4 };
const toolRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minHeight: 28, flexShrink: 0, marginBottom: 6, padding: '4px 6px', background: '#141420', border: '1px solid #2a2a3a', borderRadius: 4 };
// Mode buttons (louder than sub-tools) + sub-tool buttons + brush slider bits.
const mbtn = (active: boolean): React.CSSProperties => ({ flex: 1, background: active ? '#2a4560' : '#191926', color: active ? '#dfeaff' : '#9aa', border: `1px solid ${active ? '#4a7ba8' : '#2a2a3a'}`, borderRadius: 3, padding: '4px 6px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12, fontWeight: active ? 'bold' : 'normal' });
const tbtn = (active: boolean): React.CSSProperties => ({ background: active ? '#20303f' : '#2a2a40', color: active ? '#cde' : '#ccc', border: `1px solid ${active ? '#3a6a8a' : '#444'}`, borderRadius: 3, padding: '2px 7px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11 });
const ovRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5 };
const ovLbl: React.CSSProperties = { color: '#888', fontSize: 10, width: 22 };
const ovVal: React.CSSProperties = { color: '#999', fontSize: 10, width: 26, textAlign: 'right' };
const ovRange: React.CSSProperties = { width: 96, accentColor: '#4a9eff' };
// Generalized name header (part or bone) at the top of the inspector.
const inspectorHeadStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 };
const inspectorKind: React.CSSProperties = { fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5, color: '#5a7a9a', flexShrink: 0 };
const nameInputStyle: React.CSSProperties = { flex: 1, minWidth: 0, background: '#0e0e16', color: '#ddd', border: '1px solid #333', borderRadius: 3, padding: '3px 6px', fontFamily: 'monospace', fontSize: 12 };
const sectionLabel: React.CSSProperties = { fontSize: 11, color: '#888', margin: '6px 0 3px' };
const lbl: React.CSSProperties = { color: '#888', fontSize: 11 };
const btn: React.CSSProperties = { background: '#2a2a40', color: '#ccc', border: '1px solid #444', borderRadius: 3, padding: '3px 9px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12 };
const eyeBtn: React.CSSProperties = { background: 'transparent', color: '#999', border: 'none', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11, padding: '0 3px', lineHeight: '18px' };
