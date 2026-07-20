/** Skin editing canvas — the texture-space authoring surface for a 2D rig (Unity
 *  SkinningEditor style). Renders the open rig's sprite + deformable mesh + bind-pose
 *  bones and lets you select + drag bone joints, editing the .rig2d.json bind pose.
 *  Phase 1: render + select + move a joint. Draw/add/delete/reparent follow. */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useEditorStore } from '../store/editorStore';
import { activePartOf, withActivePart, partCount, uvToPosAffine } from './skinParts';
import { getAssetEntry, resolveGuidToPath } from '../../runtime/loaders/assetManifest';
import { assetUrl } from '../../runtime/loaders/assetUrl';
import { deriveBindMatrices, invert2D, identity2D, apply2D, mul2D, type BindBone, type Mat2D } from '../../runtime/skinning/rig2dMath';
import { registerHandleProvider, type InteractionHandle } from '../../runtime/rendering/interactionHandles';
import { paintWeights } from '../../runtime/skinning/rig2dWeightPaint';
import { addBone } from '../../runtime/skinning/rig2dEdit';
import { drawGizmo2D, hitTestGizmo2D, applyGizmoDrag2D, type GizmoHandle } from './Gizmo2D';
import { pushAction } from '../undo/undoManager';
import { type Rig2DFile } from '../../runtime/loaders/rig2dCache';

const HEIGHT = 300;
// Weight heatmap: true zero stays black, but ANY nonzero weight is lifted to at least this gray
// (0..255) so tiny influences — which still deform the mesh — are visibly distinct from zero.
const WEIGHT_FLOOR = 70;
/** weight (0..1) → gray (0..255): 0 → black; else FLOOR..255 with a low-end gamma boost. */
function weightGray(w: number): number {
  const wc = w < 0 ? 0 : w > 1 ? 1 : w;
  if (wc <= 1e-4) return 0;
  return Math.round(WEIGHT_FLOOR + (255 - WEIGHT_FLOOR) * Math.pow(wc, 0.6));
}

type NamedBone = BindBone & { name: string };
type Pose = Record<number, { x: number; y: number; rot: number }>;
function coerceBones(raw: Rig2DFile['bones']): NamedBone[] {
  return (raw ?? []).map((b, i) => ({
    name: typeof b.name === 'string' && b.name ? b.name : `bone${i}`,
    parent: Number.isInteger(b.parent) ? (b.parent as number) : -1,
    x: b.x ?? 0, y: b.y ?? 0, rot: b.rot ?? 0,
  }));
}

/** Per-bone skinning matrices for a transient test pose. These depend ONLY on
 *  (bones, pose) — identical for every part — so compute them ONCE per draw/stroke and
 *  reuse across all parts, rather than re-deriving inside deformMesh per part. Returns
 *  null for an empty pose (bind pose → deformMesh passes verts through). */
function computeSkinMats(bones: NamedBone[], pose: Pose): Mat2D[] | null {
  if (!bones.length || !Object.keys(pose).length) return null;
  const posed = bones.map((b, i) => (pose[i] ? { ...b, x: pose[i].x, y: pose[i].y, rot: pose[i].rot } : b));
  const posedLocal = deriveBindMatrices(posed).rootLocal;
  const invBind = deriveBindMatrices(bones).invBind;
  return posedLocal.map((m, i) => mul2D(m, invBind[i]));
}

/** Linear-blend-skin bind verts by the precomputed per-bone `skin` matrices (from
 *  {@link computeSkinMats}). `skin === null` → bind pose, verts returned unchanged. */
function deformMesh(bindVerts: number[][], skin: Mat2D[] | null, si: number[], sw: number[]): number[][] {
  if (!skin) return bindVerts;
  const o = new Float32Array(2);
  const out: number[][] = new Array(bindVerts.length);
  for (let v = 0; v < bindVerts.length; v++) {
    let x = 0, y = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw[v * 4 + k] ?? 0; if (w <= 0) continue;
      const m = skin[si[v * 4 + k] ?? 0]; if (!m) continue;
      apply2D(m, bindVerts[v][0], bindVerts[v][1], o, 0);
      x += w * o[0]; y += w * o[1];
    }
    out[v] = [x, y];
  }
  return out;
}

/** Bone rig-origin positions under a test pose (for drawing joints + paint fallback). */
function posedOrigins(bones: NamedBone[], pose: Pose): { x: number; y: number }[] {
  if (!bones.length) return [];
  const posed = Object.keys(pose).length ? bones.map((b, i) => (pose[i] ? { ...b, x: pose[i].x, y: pose[i].y, rot: pose[i].rot } : b)) : bones;
  return deriveBindMatrices(posed).rootLocal.map((m) => ({ x: m.e, y: m.f }));
}

/** Bounding-box center of a texture-space vertex list — the part's "position" (its mesh
 *  carries no explicit origin, so the AABB center is what the Parts-mode gizmo + inspector
 *  read/write). Returns null for an empty mesh. */
function centerOfVerts(verts: number[][]): { x: number; y: number } | null {
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const p of verts) { if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0]; if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1]; }
  if (!Number.isFinite(mnx)) return null;
  return { x: (mnx + mxx) / 2, y: (mny + mxy) / 2 };
}

type DrawPart = { index: number; view: ReturnType<typeof activePartOf>; active: boolean; order: number };
/** Parts to draw in the canvas: every part NOT hidden in the editor-local preview set,
 *  plus the ACTIVE part (always shown, highlighted) even when hidden — you can't author a
 *  part you can't see. Preview visibility is editor-only and does NOT read the asset's
 *  runtime `visible` field, so the canvas never mirrors (or affects) scene/game render.
 *  `order` is the part's draw order (lower = behind), mirrored from the asset so the preview
 *  stacks parts exactly like the runtime (Scene2D sets each mesh's zIndex = order). */
function visiblePartViews(def: Rig2DFile | null | undefined, activePart: number, previewHidden: number[]): DrawPart[] {
  const n = partCount(def);
  const out: DrawPart[] = [];
  for (let i = 0; i < n; i++) {
    const active = i === activePart;
    if (!previewHidden.includes(i) || active) out.push({ index: i, view: activePartOf(def, i), active, order: def?.parts?.[i]?.order ?? i });
  }
  return out;
}

export default function SkinCanvas({ selBone, setSelBone, testPose = {}, setTestPose }: { selBone: number; setSelBone: (i: number) => void; testPose?: Pose; setTestPose?: (u: (p: Pose) => Pose) => void }) {
  const def = useEditorStore((s) => s.editingSkinDef);
  const nonce = useEditorStore((s) => s.skinEditNonce);
  const activePart = useEditorStore((s) => s.activeSkinPart);
  const previewHidden = useEditorStore((s) => s.skinPreviewHidden); // canvas-preview-only hidden parts
  const skinMode = useEditorStore((s) => s.skinMode); // 'parts' | 'rig' | 'weights'
  const paintMode = skinMode === 'weights'; // weight-paint mode (heatmap + brush + test-pose)
  const hideTexture = useEditorStore((s) => s.skinHideTexture); // Weights: show only the heatmap
  const weightsOnly = paintMode && hideTexture; // suppress sprite backdrops → grayscale only
  const paintRadius = useEditorStore((s) => s.skinPaint.radius); // brush cursor size (draw)
  // The active part's mesh + weights (v2 multi-part → parts[activePart]; v1 → top-level).
  const part = useMemo(() => activePartOf(def, activePart), [def, activePart]);
  // Per-bone skinning matrices for the current display pose — computed ONCE and shared by
  // every part's deform (draw + paint), instead of re-derived per part inside deformMesh.
  const displaySkinMats = useMemo(() => computeSkinMats(coerceBones(def?.bones), paintMode ? testPose : {}), [def, testPose, paintMode]);
  // Deformed mesh + bone origins under the transient test pose (paint mode); identical to
  // bind when the pose is empty. Shared by the render (heatmap/wireframe/joints) + painting.
  const displayVerts = useMemo(() => deformMesh(part.mesh?.verts ?? [], displaySkinMats, part.skinIndices ?? [], part.skinWeights ?? []), [part, displaySkinMats]);
  const displayOrigin = useMemo(() => posedOrigins(coerceBones(def?.bones), paintMode ? testPose : {}), [def, testPose, paintMode]);
  // Content-bounds AABB over ALL parts' BIND verts + bind bone origins — the auto-fit frame.
  // Purely `def`-derived (bind pose), so it's invariant under pan/zoom/hover/selBone/testPose;
  // memoize it so those interactive redraws don't re-walk every vertex of every part.
  const contentBounds = useMemo(() => {
    let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
    const grow = (x: number, y: number) => { if (x < mnX) mnX = x; if (x > mxX) mxX = x; if (y < mnY) mnY = y; if (y > mxY) mxY = y; };
    for (let i = 0; i < partCount(def); i++) for (const p of activePartOf(def, i).mesh?.verts ?? []) grow(p[0], p[1]);
    const bb = coerceBones(def?.bones);
    if (bb.length) for (const m of deriveBindMatrices(bb).rootLocal) grow(m.e, m.f);
    if (!Number.isFinite(mnX)) return { mnX: -32, mnY: -32, mxX: 32, mxY: 32 };
    return { mnX, mnY, mxX, mxY };
  }, [def]);
  // Root-local matrices in the display frame (posed in paint mode) — for the gizmo's
  // world rotation + parent conversion.
  const gizmoLocal = useMemo(() => {
    const bb = coerceBones(def?.bones);
    const posed = paintMode && Object.keys(testPose).length ? bb.map((b, i) => (testPose[i] ? { ...b, x: testPose[i].x, y: testPose[i].y, rot: testPose[i].rot } : b)) : bb;
    return bb.length ? deriveBindMatrices(posed).rootLocal : [];
  }, [def, testPose, paintMode]);
  const worldRz = (i: number) => { const m = gizmoLocal[i]; return m ? Math.atan2(m.b, m.a) : 0; };
  const toCanvas = (x: number, y: number): [number, number] => { const { scale, ox, oy } = viewRef.current; return [x * scale + ox, y * scale + oy]; };
  const canvasToTex = (px: number, py: number) => { const { scale, ox, oy } = viewRef.current; return { x: (px - ox) / scale, y: (py - oy) / scale }; };

  // Live-apply a bone transform patch: bind pose in bone edit, transient test pose in paint.
  const applyBoneTransform = useCallback((patch: { x?: number; y?: number; rot?: number }) => {
    if (paintMode) {
      setTestPose?.((prev) => {
        const b = coerceBones(useEditorStore.getState().editingSkinDef?.bones)[selBone];
        const base = prev[selBone] ?? { x: b?.x ?? 0, y: b?.y ?? 0, rot: b?.rot ?? 0 };
        return { ...prev, [selBone]: { ...base, ...patch } };
      });
      return;
    }
    const store = useEditorStore.getState();
    const cur = store.editingSkinDef; const path = store.editingSkinAsset?.path;
    if (!cur?.bones || !path) return;
    store.applySkinDef(path, { ...cur, bones: cur.bones.map((b, i) => (i === selBone ? { ...b, ...patch } : b)) });
  }, [paintMode, selBone, setTestPose]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Sprite textures keyed by resolved texture path — parts sharing a sheet load once.
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const [imgReady, setImgReady] = useState(0);
  // Rig-mode sub-tool (select/add). Now in the store so the toolbar (SkinEditor) drives it
  // and the canvas reads it here. Part-placement is skinMode==='parts'; painting 'weights'.
  const tool = useEditorStore((s) => s.skinBoneTool);
  // texture-space → canvas: cx = tx*scale + ox
  const viewRef = useRef({ scale: 1, ox: 0, oy: 0 });
  // User zoom (wheel) + pan (right-drag), applied ON TOP of the auto-fit. Reset per rig.
  const viewUserRef = useRef({ zoom: 1, panX: 0, panY: 0 });
  const fitRef = useRef({ fitScale: 1, centerX: 0, centerY: 0, cw: 0, ch: 0 });
  // Freeze the auto-fit (scale + center) while dragging a part, so moving its verts doesn't
  // re-fit/zoom the whole view — which read as the part resizing AND drifted the drag delta.
  const frozenFitRef = useRef<{ fitScale: number; centerX: number; centerY: number } | null>(null);
  const panDragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  // Move-part drag: offset the active part's WHOLE mesh (reposition the sprite). Holds
  // the pre-drag snapshot (one undo) + the original verts (absolute-delta, no drift).
  const movePartRef = useRef<{ startX: number; startY: number; origVerts: number[][]; before: Rig2DFile } | null>(null);
  useEffect(() => { viewUserRef.current = { zoom: 1, panX: 0, panY: 0 }; }, [nonce]);
  // active weight-paint stroke (pre-stroke snapshot for a single undo) + brush cursor.
  const paintRef = useRef<{ before: Rig2DFile } | null>(null);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  // Weights sub-tool (brush vs test-pose) — from the store; reset to brush on entering Weights.
  const paintSubTool = useEditorStore((s) => s.skinWeightTool);
  useEffect(() => { useEditorStore.getState().setSkinWeightTool('paint'); }, [paintMode]);
  // Keyboard: B = brush, W = transform (move/rotate) — only while paint mode is active.
  useEffect(() => {
    if (!paintMode) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'b' || e.key === 'B') useEditorStore.getState().setSkinWeightTool('paint');
      else if (e.key === 'w' || e.key === 'W') useEditorStore.getState().setSkinWeightTool('transform');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paintMode]);
  // Active gizmo drag (translate/rotate a bone — bind pose in bone edit, test pose in paint).
  const gizmoRef = useRef<{ handle: GizmoHandle; startPx: number; startPy: number; centerPx: [number, number]; worldRz: number; parentWorldRz: number; before: Rig2DFile | null } | null>(null);
  // Parts-mode translate gizmo drag: axis-constrained move of the active part's whole mesh
  // (origVerts + origCenter snapshot → absolute delta, no drift). Free-drag on the mesh is
  // the movePartRef path; this is the handle-constrained path.
  const partGizmoRef = useRef<{ handle: GizmoHandle; startPx: number; startPy: number; centerPx: [number, number]; origVerts: number[][]; origCenter: { x: number; y: number }; before: Rig2DFile } | null>(null);
  const hoverHandleRef = useRef<GizmoHandle | null>(null);
  const showGizmo = selBone >= 0 && ((skinMode === 'rig' && tool === 'select') || (paintMode && paintSubTool === 'transform'));
  // Parts mode draws a translate gizmo at the active part's center (mesh present). None when
  // no part is selected (activePart < 0).
  const partGizmoCenter = skinMode === 'parts' && activePart >= 0 ? centerOfVerts(part.mesh?.verts ?? []) : null;

  // ── Enact Phase 2: bone-joint handles ── expose each bone joint (posed in Weights
  //    mode, bind otherwise) as a viewport-CSS-px point so the agent can query + drag
  //    it (modoki_handles / modoki_drag_handle). Bone joints are the drag target in
  //    Rig + Weights modes; Parts mode uses the part gizmo, so we skip joints there.
  //    Live state via a ref (provider registers once, reads current each query); the
  //    texture→CSS transform reuses viewRef (the same {scale,ox,oy} `toCanvas` uses).
  const skinHandleStateRef = useRef<{ bones: ReturnType<typeof coerceBones>; origin: { x: number; y: number }[]; skinMode: string; tool: string }>({ bones: [], origin: [], skinMode: 'rig', tool: 'select' });
  skinHandleStateRef.current = { bones: coerceBones(def?.bones), origin: displayOrigin, skinMode, tool };
  useEffect(() => {
    const unreg = registerHandleProvider((): InteractionHandle[] => {
      const canvas = canvasRef.current;
      if (!canvas) return [];
      const st = skinHandleStateRef.current;
      if (st.skinMode === 'parts' || !st.bones.length || st.origin.length !== st.bones.length) return [];
      const { scale, ox, oy } = viewRef.current; // valid after the first draw()
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return [];
      // draw()'s ox/oy are content-box relative (cw = clientWidth, excludes border) and
      // the pointer handlers hit-test via offsetX/Y (also content-box), but rect.left/top
      // are the OUTER border-box edge. Add clientLeft/clientTop (= border width) so a
      // reported handle lands exactly on the drawn joint / the offsetX hit-test.
      const bl = canvas.clientLeft, bt = canvas.clientTop;
      return st.bones.map((b, i) => ({
        id: `skin:bone:${i}`,
        kind: 'bone-joint',
        editor: 'skin',
        x: rect.left + bl + (st.origin[i].x * scale + ox), // texture → canvas CSS px → client
        y: rect.top + bt + (st.origin[i].y * scale + oy),
        label: b.name,
        meta: { boneIndex: i, name: b.name, parent: b.parent, skinMode: st.skinMode, boneTool: st.tool },
      }));
    });
    return unreg;
  }, []);

  // Resolve a part's sprite GUID → its texture path (a sliced sprite draws from its parent
  // sheet; a whole-image ref is its own texture).
  const texPathOf = useCallback((spriteGuid: string | undefined): string | undefined => {
    if (!spriteGuid) return undefined;
    const sp = getAssetEntry(spriteGuid)?.sprite;
    const texGuid = sp?.texture ?? spriteGuid;
    return texGuid ? resolveGuidToPath(texGuid) : undefined;
  }, []);

  // Evict the sprite-texture cache when switching to a DIFFERENT rig asset (not on every
  // edit — `def` gets a new identity per edit but the images are unchanged). Keyed on the
  // asset PATH so the map doesn't grow unbounded across rig switches. Declared before the
  // loader effect so a switch clears first, then the loader repopulates for the new rig.
  const skinAssetPath = useEditorStore((s) => s.editingSkinAsset?.path);
  useEffect(() => { imagesRef.current.clear(); setImgReady(0); }, [skinAssetPath]);

  // Load every drawn part's sprite texture as a faint backdrop so you rig against the art.
  useEffect(() => {
    const parts = def?.parts?.length ? def.parts : [{ sprite: def?.sprite }];
    let cancelled = false;
    for (const p of parts) {
      const texPath = texPathOf(p?.sprite ?? '');
      if (!texPath || imagesRef.current.has(texPath)) continue;
      const img = new Image();
      img.onload = () => { if (!cancelled) { imagesRef.current.set(texPath, img); setImgReady((n) => n + 1); } };
      img.onerror = () => {};
      img.src = assetUrl(texPath);
    }
    return () => { cancelled = true; };
  }, [def, texPathOf]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth || 300, ch = canvas.clientHeight || HEIGHT;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#12121c';
    ctx.fillRect(0, 0, cw, ch);

    const bones = coerceBones(def?.bones);
    const { rootLocal } = bones.length ? deriveBindMatrices(bones) : { rootLocal: [] };
    const origin = rootLocal.map((m) => ({ x: m.e, y: m.f }));

    // Every visible part as assembled context + always the active part (highlighted).
    const drawParts = visiblePartViews(def, activePart, previewHidden);
    // Deformed verts for a part: the active part reuses the shared memo; context parts
    // deform under the same display pose so the whole character poses together.
    const vertsOf = (dp: DrawPart): number[][] => dp.active
      ? displayVerts
      : deformMesh(dp.view.mesh?.verts ?? [], displaySkinMats, dp.view.skinIndices ?? [], dp.view.skinWeights ?? []);
    const imgOf = (dp: DrawPart): HTMLImageElement | null => { const tp = texPathOf(dp.view.sprite ?? ''); return tp ? imagesRef.current.get(tp) ?? null : null; };

    // Content bounds over ALL parts' verts + bone joints (NOT just the drawn/visible ones), so
    // the view frames the whole assembled character AND stays put when parts are checked/
    // unchecked in the list. Memoized on `def` (see contentBounds) — a pan/zoom/hover redraw
    // must not re-walk every vertex.
    const { mnX, mnY, mxX, mxY } = contentBounds;
    const contentW = (mxX - mnX) || 64, contentH = (mxY - mnY) || 64;
    const pad = 24;
    // Auto-fit, then apply the user's wheel-zoom + right-drag pan on top.
    let fitScale = Math.min((cw - pad * 2) / contentW, (ch - pad * 2) / contentH);
    let centerX = (mnX + mxX) / 2, centerY = (mnY + mxY) / 2;
    // While a part is being dragged, hold the fit frozen (see frozenFitRef) so the moving
    // verts don't re-fit the view under the cursor.
    if (frozenFitRef.current) { fitScale = frozenFitRef.current.fitScale; centerX = frozenFitRef.current.centerX; centerY = frozenFitRef.current.centerY; }
    fitRef.current = { fitScale, centerX, centerY, cw, ch };
    const { zoom, panX, panY } = viewUserRef.current;
    const scale = fitScale * zoom;
    const ox = cw / 2 - centerX * scale + panX;
    const oy = ch / 2 - centerY * scale + panY;
    viewRef.current = { scale, ox, oy };
    const toC = (x: number, y: number): [number, number] => [x * scale + ox, y * scale + oy];

    // Draw in the part's true draw order (order asc → lower behind), matching the runtime
    // (Scene2D zIndex = order). Only in Weights mode do we float the active part on top, so
    // its paint heatmap stays visible; Parts/Rig preview the real stacking so reordering the
    // list visibly changes what's in front.
    const ordered = [...drawParts].sort((a, b) =>
      paintMode && a.active !== b.active ? Number(a.active) - Number(b.active) : a.order - b.order);
    for (const dp of ordered) {
      const dverts = vertsOf(dp);
      const bindVerts = dp.view.mesh?.verts ?? [];
      const tris = dp.view.mesh?.tris ?? [];
      const uvs = dp.view.mesh?.uvs ?? [];
      if (!bindVerts.length) continue;

      // Sprite backdrop (full opacity, so parts occlude exactly like the runtime and the draw
      // order reads true). Preferred path: an affine blit derived from the mesh's UV→vert map,
      // so the art follows the mesh's rotation/scale/deform during authoring. Fallback (no UVs
      // / degenerate tri): the old axis-aligned AABB blit. A sliced sprite draws its atlas
      // sub-rect; a whole-image ref draws the full texture.
      const img = weightsOnly ? null : imgOf(dp);
      if (img) {
        const sp = dp.view.sprite ? getAssetEntry(dp.view.sprite)?.sprite : undefined;
        const sx = sp ? sp.rect.x : 0, sy = sp ? sp.rect.y : 0;
        const sw = sp ? sp.rect.w : img.naturalWidth, sh = sp ? sp.rect.h : img.naturalHeight;
        const aff = uvToPosAffine(dverts, uvs, tris);
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.imageSmoothingEnabled = true;
        if (aff && sw > 0 && sh > 0) {
          // imgPx → canvas: a = ∂canvasX/∂imgX etc. (UV 0..1 spans the sprite rect).
          const a = scale * aff.m00 / sw, c = scale * aff.m01 / sh;
          const b = scale * aff.m10 / sw, d = scale * aff.m11 / sh;
          const e = -a * sx - c * sy + scale * aff.tx + ox;
          const f = -b * sx - d * sy + scale * aff.ty + oy;
          ctx.transform(a, b, c, d, e, f); // composes over the base dpr transform
          ctx.drawImage(img, sx, sy, sw, sh, sx, sy, sw, sh);
        } else {
          let vmnX = Infinity, vmnY = Infinity, vmxX = -Infinity, vmxY = -Infinity;
          for (const p of bindVerts) { if (p[0] < vmnX) vmnX = p[0]; if (p[0] > vmxX) vmxX = p[0]; if (p[1] < vmnY) vmnY = p[1]; if (p[1] > vmxY) vmxY = p[1]; }
          let umn = 0, vmn = 0, umx = 1, vmx = 1;
          if (uvs.length === bindVerts.length) {
            umn = vmn = Infinity; umx = vmx = -Infinity;
            for (const uv of uvs) { if (uv[0] < umn) umn = uv[0]; if (uv[0] > umx) umx = uv[0]; if (uv[1] < vmn) vmn = uv[1]; if (uv[1] > vmx) vmx = uv[1]; }
          }
          const [dx0, dy0] = toC(vmnX, vmnY), [dx1, dy1] = toC(vmxX, vmxY);
          ctx.drawImage(img, sx + umn * sw, sy + vmn * sh, (umx - umn) * sw, (vmx - vmn) * sh, dx0, dy0, dx1 - dx0, dy1 - dy0);
        }
        ctx.restore();
      }

      // Weight heatmap for EVERY part (not just the active one): fill each triangle by the
      // SELECTED bone's weight, grayscale (white = full influence → black = none). Selecting a
      // bone thus shows its influence across the whole character. When the sprite is shown
      // (texture on) the heatmap is a translucent overlay and 0-weight triangles are skipped so
      // uninfluenced parts keep their art; in Weights-only mode it's opaque + full (0 = black).
      if (paintMode && selBone >= 0 && tris.length) {
        const sw = dp.view.skinWeights ?? [], si = dp.view.skinIndices ?? [];
        const wOf = (v: number) => { let s = 0; for (let k = 0; k < 4; k++) if (si[v * 4 + k] === selBone) s += sw[v * 4 + k] ?? 0; return s; };
        ctx.save();
        ctx.globalAlpha = weightsOnly ? 1 : 0.55;
        for (let t = 0; t + 2 < tris.length; t += 3) {
          const a = dverts[tris[t]], b = dverts[tris[t + 1]], c = dverts[tris[t + 2]];
          if (!a || !b || !c) continue;
          const w = (wOf(tris[t]) + wOf(tris[t + 1]) + wOf(tris[t + 2])) / 3;
          if (!weightsOnly && w <= 0) continue; // over the art: leave uninfluenced tris as texture
          const g = weightGray(w); // 0 → black; any nonzero → visible gray (small weights still deform)
          ctx.fillStyle = `rgb(${g},${g},${g})`;
          const [ax, ay] = toC(a[0], a[1]), [bx, by] = toC(b[0], b[1]), [cx3, cy3] = toC(c[0], c[1]);
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx3, cy3); ctx.closePath(); ctx.fill();
        }
        ctx.restore();
      }

      // Mesh wireframe (active brighter than context).
      if (tris.length) {
        ctx.strokeStyle = dp.active ? 'rgba(46,255,166,0.35)' : 'rgba(46,255,166,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let t = 0; t + 2 < tris.length; t += 3) {
          const a = dverts[tris[t]], b = dverts[tris[t + 1]], c = dverts[tris[t + 2]];
          if (!a || !b || !c) continue;
          const [ax, ay] = toC(a[0], a[1]), [bx, by] = toC(b[0], b[1]), [cx2, cy2] = toC(c[0], c[1]);
          ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx2, cy2); ctx.closePath();
        }
        ctx.stroke();
      }
    }

    // Selection outline: the ACTIVE part's mesh silhouette (boundary edges — edges used by a
    // single triangle), drawn on top of the now-opaque sprites so the current selection reads
    // clearly even when other parts stack in front of it. A dark halo under a bright core
    // keeps it visible on any art.
    {
      const selTris = activePart >= 0 ? part.mesh?.tris ?? [] : [];
      if (selTris.length && displayVerts.length) {
        const edgeUse = new Map<string, number>();
        const key = (i: number, j: number) => (i < j ? `${i},${j}` : `${j},${i}`);
        for (let t = 0; t + 2 < selTris.length; t += 3) {
          const tri = [selTris[t], selTris[t + 1], selTris[t + 2]];
          for (let k = 0; k < 3; k++) { const e = key(tri[k], tri[(k + 1) % 3]); edgeUse.set(e, (edgeUse.get(e) ?? 0) + 1); }
        }
        const strokeOutline = () => {
          ctx.beginPath();
          for (const [e, n] of edgeUse) {
            if (n !== 1) continue; // interior edges (used twice) are not on the silhouette
            const [i, j] = e.split(',').map(Number);
            const p0 = displayVerts[i], p1 = displayVerts[j];
            if (!p0 || !p1) continue;
            const [x0, y0] = toC(p0[0], p0[1]), [x1, y1] = toC(p1[0], p1[1]);
            ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
          }
          ctx.stroke();
        };
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(10,10,20,0.9)'; ctx.lineWidth = 4; strokeOutline(); // halo
        ctx.strokeStyle = '#ff9d2e'; ctx.lineWidth = 2; strokeOutline();            // core
      }
    }

    // Bones: parent→child bone lines, then joint handles on top (posed in paint mode).
    const drawOrigin = displayOrigin.length === bones.length ? displayOrigin : origin;
    ctx.lineWidth = 2;
    for (let i = 0; i < bones.length; i++) {
      const p = bones[i].parent;
      if (p < 0 || !drawOrigin[p]) continue;
      const [x0, y0] = toC(drawOrigin[p].x, drawOrigin[p].y), [x1, y1] = toC(drawOrigin[i].x, drawOrigin[i].y);
      ctx.strokeStyle = 'rgba(240,200,80,0.7)';
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    for (let i = 0; i < bones.length; i++) {
      const [jx, jy] = toC(drawOrigin[i].x, drawOrigin[i].y);
      const sel = i === selBone;
      ctx.beginPath();
      ctx.arc(jx, jy, sel ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = sel ? '#4a9eff' : '#f1c40f';
      ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#12121c'; ctx.stroke();
    }

    // Brush cursor (paint mode, Paint sub-tool).
    if (paintMode && paintSubTool === 'paint' && cursorRef.current) {
      const [cxp, cyp] = toC(cursorRef.current.x, cursorRef.current.y);
      ctx.beginPath(); ctx.arc(cxp, cyp, paintRadius * scale, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5; ctx.stroke();
    }

    // Transform gizmo (bone-edit Select tool / paint Transform sub-tool).
    if (showGizmo && gizmoLocal[selBone] && displayOrigin[selBone]) {
      const [gx, gy] = toC(displayOrigin[selBone].x, displayOrigin[selBone].y);
      const wrz = worldRz(selBone);
      drawGizmo2D(ctx, gx, gy, wrz, 1, 1, 0, 0, 'translate', 'local', hoverHandleRef.current, 1);
      drawGizmo2D(ctx, gx, gy, wrz, 1, 1, 0, 0, 'rotate', 'local', hoverHandleRef.current, 1);
    }

    // Parts-mode translate + rotate gizmo at the active part's center (world-aligned).
    if (skinMode === 'parts') {
      // During a rotate drag, pin the gizmo to the fixed pivot (rotating a non-square shape
      // shifts its AABB center, which would wobble the gizmo). Translate/idle track the center.
      const pg = partGizmoRef.current;
      const c = (pg && pg.handle === 'rotate') ? pg.origCenter : centerOfVerts(displayVerts);
      if (c) {
        const [gx, gy] = toC(c.x, c.y);
        drawGizmo2D(ctx, gx, gy, 0, 1, 1, 0, 0, 'translate', 'world', hoverHandleRef.current, 1);
        drawGizmo2D(ctx, gx, gy, 0, 1, 1, 0, 0, 'rotate', 'world', hoverHandleRef.current, 1);
      }
    }
  }, [def, activePart, previewHidden, selBone, testPose, paintMode, paintSubTool, paintRadius, displayVerts, displaySkinMats, displayOrigin, contentBounds, showGizmo, gizmoLocal, skinMode, weightsOnly, texPathOf]);

  // Latest draw() kept in a ref so the mount-only subscriptions below (ResizeObserver,
  // non-passive wheel) don't tear down + re-subscribe on every draw-identity change.
  const drawRef = useRef(draw);
  useEffect(() => { drawRef.current = draw; });

  useEffect(() => { draw(); }, [draw, nonce, imgReady]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => drawRef.current());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Mouse-wheel zoom, centered on the cursor (native non-passive listener so we can
  // preventDefault the page scroll). Adjusts the pan so the texture point under the
  // cursor stays fixed as the zoom changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const { scale, ox, oy } = viewRef.current;
      const tx = (px - ox) / scale, ty = (py - oy) / scale; // texture point under cursor
      const zoom = Math.max(0.2, Math.min(8, viewUserRef.current.zoom * Math.exp(-e.deltaY * 0.0015)));
      viewUserRef.current.zoom = zoom;
      const { fitScale, centerX, centerY, cw, ch } = fitRef.current;
      const s2 = fitScale * zoom;
      viewUserRef.current.panX = px - cw / 2 + s2 * (centerX - tx);
      viewUserRef.current.panY = py - ch / 2 + s2 * (centerY - ty);
      drawRef.current();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  // Pointer → texture space.
  const toTex = (e: React.PointerEvent): { x: number; y: number } => {
    const { scale, ox, oy } = viewRef.current;
    return { x: (e.nativeEvent.offsetX - ox) / scale, y: (e.nativeEvent.offsetY - oy) / scale };
  };

  const hitJoint = useCallback((tx: number, ty: number): number => {
    const { scale } = viewRef.current;
    const grab = 9 / (scale || 1); // ~9px in texture units
    let best = -1, bestD = grab * grab;
    for (let i = 0; i < displayOrigin.length; i++) {
      const dx = tx - displayOrigin[i].x, dy = ty - displayOrigin[i].y, dd = dx * dx + dy * dy;
      if (dd <= bestD) { bestD = dd; best = i; }
    }
    return best;
  }, [displayOrigin]);

  // Part pick (Parts mode): the TOPMOST drawn part whose mesh triangles contain the point,
  // or −1 for empty space. Iterates in true draw order (order asc) and keeps the last match,
  // so a click resolves to whichever part is stacked on top — matching what you see.
  // Bind verts (Parts mode never poses), so the pick matches the drawn mesh exactly.
  const hitPart = useCallback((tx: number, ty: number): number => {
    const inTri = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean => {
      const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (d === 0) return false;
      const s = ((tx - ax) * (cy - ay) - (cx - ax) * (ty - ay)) / d;
      const t = ((bx - ax) * (ty - ay) - (tx - ax) * (by - ay)) / d;
      return s >= 0 && t >= 0 && s + t <= 1;
    };
    const parts = visiblePartViews(def, activePart, previewHidden)
      .sort((a, b) => a.order - b.order); // z-order: draw order asc, so the last match is on top
    let hit = -1;
    for (const dp of parts) {
      const verts = dp.view.mesh?.verts ?? [], tris = dp.view.mesh?.tris ?? [];
      for (let i = 0; i + 2 < tris.length; i += 3) {
        const a = verts[tris[i]], b = verts[tris[i + 1]], c = verts[tris[i + 2]];
        if (a && b && c && inTri(a[0], a[1], b[0], b[1], c[0], c[1])) { hit = dp.index; break; }
      }
    }
    return hit;
  }, [def, activePart, previewHidden]);

  // Apply a whole-def change as one undo entry (add/delete/rename), like the panel commit.
  const commitDef = useCallback((next: Rig2DFile, label: string) => {
    const store = useEditorStore.getState();
    const before = store.editingSkinDef;
    const path = store.editingSkinAsset?.path;
    if (!before || !path) return;
    pushAction({ label: `rig2d ${label}`, undo: () => useEditorStore.getState().applySkinDef(path, before), redo: () => useEditorStore.getState().applySkinDef(path, next) });
    store.applySkinDef(path, next);
  }, []);

  // Texture-space point → a bone's LOCAL translation under `parent` (−1 = root).
  const localUnder = (parent: number, bones: BindBone[], tx: number, ty: number): [number, number] => {
    const { rootLocal } = bones.length ? deriveBindMatrices(bones) : { rootLocal: [] };
    const pInv = parent >= 0 && rootLocal[parent] ? invert2D(rootLocal[parent]) : identity2D();
    const out = new Float32Array(2); apply2D(pInv, tx, ty, out, 0);
    return [out[0], out[1]];
  };

  // Paint the selected bone's weight at a texture-space point across every CHECKED part — the
  // parts-list checkboxes act as a paint mask (unchecked/hidden parts are protected, matching
  // "paint what you see"). The brush isn't bound to the active part, so a stroke near a joint
  // blends both visible parts that meet there. Each part is painted against its own DISPLAYED
  // (posed) verts so the brush hits what you see.
  const paintAt = useCallback((tx: number, ty: number, subtract: boolean) => {
    const store = useEditorStore.getState();
    const cur = store.editingSkinDef;
    const path = store.editingSkinAsset?.path;
    if (!cur || !path || selBone < 0) return;
    const sp = store.skinPaint;
    const hidden = store.skinPreviewHidden; // parts-list checkbox = paint mask
    const bb = coerceBones(cur.bones);
    const bonePositions = displayOrigin.map((o) => [o.x, o.y] as [number, number]);
    // Skinning matrices depend only on (bones, pose) — compute once, reuse for every part.
    const skinMats = computeSkinMats(bb, paintMode ? testPose : {});
    let next = cur;
    for (let i = 0; i < partCount(cur); i++) {
      if (hidden.includes(i)) continue; // unchecked in the parts list → masked out of painting
      const view = activePartOf(next, i);
      const verts = view.mesh?.verts;
      if (!verts?.length) continue;
      const dverts = deformMesh(verts, skinMats, view.skinIndices ?? [], view.skinWeights ?? []);
      const result = paintWeights({
        verts: dverts, skinIndices: view.skinIndices ?? [], skinWeights: view.skinWeights ?? [],
        boneIndex: selBone, center: [tx, ty], radius: sp.radius, strength: sp.strength,
        falloff: 'smooth', mode: subtract ? 'subtract' : sp.brush, bonePositions,
      });
      next = withActivePart(next, i, { skinIndices: result.skinIndices, skinWeights: result.skinWeights });
    }
    if (next !== cur) store.applySkinDef(path, next);
  }, [selBone, displayOrigin, paintMode, testPose]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const { x, y } = toTex(e);
    const px = e.nativeEvent.offsetX, py = e.nativeEvent.offsetY;
    // 0. Right (or middle) button → pan the view; never edits the rig.
    if (e.button === 2 || e.button === 1) {
      panDragRef.current = { startX: px, startY: py, panX: viewUserRef.current.panX, panY: viewUserRef.current.panY };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    // 0.5 Parts mode: select-by-click then reposition. A hit on the ACTIVE part's translate/
    // rotate gizmo handle → axis-constrained drag. Otherwise pick the topmost part under the
    // cursor: a part becomes active (click-to-select) and free-drags; EMPTY space clears the
    // selection (activePart = -1, none).
    if (skinMode === 'parts') {
      const store = useEditorStore.getState();
      const cur = store.editingSkinDef;
      const active = store.activeSkinPart;
      // Grab the active part's gizmo handle first (it extends past the mesh).
      const c = partGizmoCenter;
      const handle = c
        ? (hitTestGizmo2D(px, py, ...toCanvas(c.x, c.y), 0, 1, 1, 0, 0, 'rotate', 'world', 1)
          ?? hitTestGizmo2D(px, py, ...toCanvas(c.x, c.y), 0, 1, 1, 0, 0, 'translate', 'world', 1))
        : null;
      if (c && handle) {
        const av = activePartOf(cur, active).mesh?.verts;
        if (cur && av?.length) {
          partGizmoRef.current = { handle, startPx: px, startPy: py, centerPx: toCanvas(c.x, c.y), origVerts: av.map((v) => [v[0], v[1]]), origCenter: c, before: cur };
          frozenFitRef.current = { fitScale: fitRef.current.fitScale, centerX: fitRef.current.centerX, centerY: fitRef.current.centerY };
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }
        return;
      }
      // Click-to-select: pick the topmost part under the cursor. Empty space (−1) clears the
      // selection and does NOT drag.
      const picked = hitPart(x, y);
      if (picked < 0) { if (active >= 0) store.setActiveSkinPart(-1); return; }
      if (picked !== active) store.setActiveSkinPart(picked);
      const verts = activePartOf(cur, picked).mesh?.verts;
      if (cur && verts?.length) {
        movePartRef.current = { startX: x, startY: y, origVerts: verts.map((v) => [v[0], v[1]]), before: cur };
        // Freeze the current fit so the view stays put as the part's verts move.
        frozenFitRef.current = { fitScale: fitRef.current.fitScale, centerX: fitRef.current.centerX, centerY: fitRef.current.centerY };
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }
      return;
    }
    // 1. Gizmo (bone-edit Select tool, or paint Transform sub-tool): move/rotate the bone.
    if (showGizmo && gizmoLocal[selBone]) {
      const [cx, cy] = toCanvas(displayOrigin[selBone].x, displayOrigin[selBone].y);
      const wrz = worldRz(selBone);
      const h = hitTestGizmo2D(px, py, cx, cy, wrz, 1, 1, 0, 0, 'rotate', 'local', 1)
        ?? hitTestGizmo2D(px, py, cx, cy, wrz, 1, 1, 0, 0, 'translate', 'local', 1);
      if (h) {
        const parent = coerceBones(useEditorStore.getState().editingSkinDef?.bones)[selBone]?.parent ?? -1;
        gizmoRef.current = { handle: h, startPx: px, startPy: py, centerPx: [cx, cy], worldRz: wrz, parentWorldRz: parent >= 0 ? worldRz(parent) : 0, before: paintMode ? null : (useEditorStore.getState().editingSkinDef ?? null) };
        (e.target as Element).setPointerCapture?.(e.pointerId);
        return;
      }
      setSelBone(hitJoint(x, y)); // off-handle: reselect another joint, or empty → deselect (-1)
      return;
    }
    // 2. Paint brush (paint mode, Paint sub-tool).
    if (paintMode) {
      const hit = hitJoint(x, y);
      if (hit >= 0) { setSelBone(hit); return; }
      if (selBone < 0) return;
      const before = useEditorStore.getState().editingSkinDef;
      if (before) { paintRef.current = { before }; (e.target as Element).setPointerCapture?.(e.pointerId); cursorRef.current = { x, y }; paintAt(x, y, e.altKey); }
      return;
    }
    // 3. Add tool.
    if (tool === 'add') {
      const cur = useEditorStore.getState().editingSkinDef;
      if (!cur) return;
      const bones = coerceBones(cur.bones);
      const parent = selBone >= 0 && selBone < bones.length ? selBone : -1;
      const [lx, ly] = localUnder(parent, bones, x, y);
      const { def: nd, index } = addBone(cur, parent, lx, ly);
      commitDef(nd, 'add bone');
      setSelBone(index); // chain: the next click adds a child of this new bone
      return;
    }
    // 4. Select tool with nothing selected → pick a bone (the gizmo appears on it).
    const hit = hitJoint(x, y);
    setSelBone(hit);
  }, [showGizmo, gizmoLocal, displayOrigin, paintMode, skinMode, partGizmoCenter, tool, selBone, hitJoint, hitPart, commitDef, paintAt]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const pan = panDragRef.current;
    if (pan) {
      viewUserRef.current.panX = pan.panX + (e.nativeEvent.offsetX - pan.startX);
      viewUserRef.current.panY = pan.panY + (e.nativeEvent.offsetY - pan.startY);
      draw();
      return;
    }
    const mp = movePartRef.current;
    if (mp) {
      const { x, y } = toTex(e);
      const dx = x - mp.startX, dy = y - mp.startY;
      const store = useEditorStore.getState();
      const cur = store.editingSkinDef; const path = store.editingSkinAsset?.path;
      if (!cur || !path) return;
      const ap = activePartOf(cur, store.activeSkinPart);
      const newVerts = mp.origVerts.map((v) => [v[0] + dx, v[1] + dy]);
      store.applySkinDef(path, withActivePart(cur, store.activeSkinPart, { mesh: { ...ap.mesh, verts: newVerts } }));
      return;
    }
    const pg = partGizmoRef.current;
    if (pg) {
      const px = e.nativeEvent.offsetX, py = e.nativeEvent.offsetY;
      const start = { x: pg.centerPx[0], y: pg.centerPx[1], rz: 0, sx: 1, sy: 1 };
      const res = applyGizmoDrag2D(pg.handle, px, py, pg.startPx, pg.startPy, start, { x: pg.centerPx[0], y: pg.centerPx[1] }, 'world');
      const store = useEditorStore.getState();
      const cur = store.editingSkinDef; const path = store.editingSkinAsset?.path;
      if (!cur || !path) return;
      const ap = activePartOf(cur, store.activeSkinPart);
      const { x: cx, y: cy } = pg.origCenter;
      let newVerts: number[][];
      if (res.rz !== undefined) {
        // Rotate the whole mesh about its center (start.rz=0 → res.rz is the drag delta).
        // Same matrix convention as deriveBindMatrices, so it follows the ring like a bone.
        const cs = Math.cos(res.rz), sn = Math.sin(res.rz);
        newVerts = pg.origVerts.map((v) => { const dx = v[0] - cx, dy = v[1] - cy; return [cx + cs * dx - sn * dy, cy + sn * dx + cs * dy]; });
      } else {
        // Translate (axis-constrained): res gives the new center in canvas px.
        const tex = canvasToTex(res.x ?? pg.centerPx[0], res.y ?? pg.centerPx[1]);
        const dx = tex.x - cx, dy = tex.y - cy;
        newVerts = pg.origVerts.map((v) => [v[0] + dx, v[1] + dy]);
      }
      store.applySkinDef(path, withActivePart(cur, store.activeSkinPart, { mesh: { ...ap.mesh, verts: newVerts } }));
      return;
    }
    const g = gizmoRef.current;
    if (g) {
      const px = e.nativeEvent.offsetX, py = e.nativeEvent.offsetY;
      const start = { x: g.centerPx[0], y: g.centerPx[1], rz: g.worldRz, sx: 1, sy: 1 };
      const res = applyGizmoDrag2D(g.handle, px, py, g.startPx, g.startPy, start, { x: g.centerPx[0], y: g.centerPx[1] }, 'local');
      if (res.x !== undefined || res.y !== undefined) {
        const tex = canvasToTex(res.x ?? g.centerPx[0], res.y ?? g.centerPx[1]);
        const cur = coerceBones(useEditorStore.getState().editingSkinDef?.bones);
        const parent = cur[selBone]?.parent ?? -1;
        const frame = paintMode && Object.keys(testPose).length ? cur.map((b, i) => (testPose[i] ? { ...b, x: testPose[i].x, y: testPose[i].y, rot: testPose[i].rot } : b)) : cur;
        const { rootLocal } = deriveBindMatrices(frame);
        const pInv = parent >= 0 && rootLocal[parent] ? invert2D(rootLocal[parent]) : identity2D();
        const out = new Float32Array(2); apply2D(pInv, tex.x, tex.y, out, 0);
        applyBoneTransform({ x: out[0], y: out[1] });
      }
      if (res.rz !== undefined) applyBoneTransform({ rot: res.rz - g.parentWorldRz });
      return;
    }
    // Gizmo hover highlight.
    if (showGizmo && gizmoLocal[selBone]) {
      const [cx, cy] = toCanvas(displayOrigin[selBone].x, displayOrigin[selBone].y);
      const wrz = worldRz(selBone);
      const px = e.nativeEvent.offsetX, py = e.nativeEvent.offsetY;
      const h = hitTestGizmo2D(px, py, cx, cy, wrz, 1, 1, 0, 0, 'rotate', 'local', 1) ?? hitTestGizmo2D(px, py, cx, cy, wrz, 1, 1, 0, 0, 'translate', 'local', 1);
      if (h !== hoverHandleRef.current) { hoverHandleRef.current = h; draw(); }
      if (paintMode) return; // in paint Transform, no brush cursor
    }
    // Parts-mode gizmo hover highlight (rotate ring takes precedence over the axes).
    if (skinMode === 'parts' && partGizmoCenter) {
      const [cx, cy] = toCanvas(partGizmoCenter.x, partGizmoCenter.y);
      const px = e.nativeEvent.offsetX, py = e.nativeEvent.offsetY;
      const h = hitTestGizmo2D(px, py, cx, cy, 0, 1, 1, 0, 0, 'rotate', 'world', 1) ?? hitTestGizmo2D(px, py, cx, cy, 0, 1, 1, 0, 0, 'translate', 'world', 1);
      if (h !== hoverHandleRef.current) { hoverHandleRef.current = h; draw(); }
    }
    if (paintMode && paintSubTool === 'paint') {
      const { x, y } = toTex(e);
      cursorRef.current = { x, y };
      if (paintRef.current) paintAt(x, y, e.altKey);
      draw(); // redraw heatmap + brush cursor
    }
  }, [paintMode, paintSubTool, showGizmo, gizmoLocal, displayOrigin, skinMode, partGizmoCenter, testPose, selBone, paintAt, draw, applyBoneTransform]);

  const onPointerUp = useCallback(() => {
    if (panDragRef.current) { panDragRef.current = null; return; }
    const mp = movePartRef.current;
    if (mp) {
      movePartRef.current = null;
      frozenFitRef.current = null; // release the frozen fit → re-fit to the new layout
      draw();
      const store = useEditorStore.getState();
      const path = store.editingSkinAsset?.path, after = store.editingSkinDef, before = mp.before;
      if (path && after && after !== before) {
        pushAction({ label: 'rig2d move part', undo: () => useEditorStore.getState().applySkinDef(path, before), redo: () => useEditorStore.getState().applySkinDef(path, after) });
      }
      return;
    }
    const pg = partGizmoRef.current;
    if (pg) {
      partGizmoRef.current = null;
      frozenFitRef.current = null;
      draw();
      const store = useEditorStore.getState();
      const path = store.editingSkinAsset?.path, after = store.editingSkinDef, before = pg.before;
      if (path && after && after !== before) {
        const label = pg.handle === 'rotate' ? 'rig2d rotate part' : 'rig2d move part';
        pushAction({ label, undo: () => useEditorStore.getState().applySkinDef(path, before), redo: () => useEditorStore.getState().applySkinDef(path, after) });
      }
      return;
    }
    const g = gizmoRef.current;
    if (g) {
      gizmoRef.current = null;
      if (g.before) { // bone edit → one undo for the whole gizmo drag
        const store = useEditorStore.getState();
        const path = store.editingSkinAsset?.path, after = store.editingSkinDef, before = g.before;
        if (path && after && after !== before) {
          pushAction({ label: 'rig2d transform bone', undo: () => useEditorStore.getState().applySkinDef(path, before), redo: () => useEditorStore.getState().applySkinDef(path, after) });
        }
      }
      return;
    }
    if (paintRef.current) {
      const before = paintRef.current.before;
      paintRef.current = null;
      const store = useEditorStore.getState();
      const path = store.editingSkinAsset?.path, after = store.editingSkinDef;
      if (path && after && after !== before) {
        pushAction({ label: 'rig2d paint weights', undo: () => useEditorStore.getState().applySkinDef(path, before), redo: () => useEditorStore.getState().applySkinDef(path, after) });
      }
    }
  }, [draw]);

  if (!def) return null;
  const bones = coerceBones(def.bones);
  const cursor = showGizmo ? 'default' : skinMode === 'parts' ? 'move' : paintMode ? (paintSubTool === 'paint' ? 'none' : 'default') : tool === 'add' ? 'copy' : 'crosshair';
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ position: 'relative' }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: HEIGHT, display: 'block', borderRadius: 4, border: '1px solid #2a2a3a', cursor, touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => { cursorRef.current = null; onPointerUp(); draw(); }}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
      <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>
        {skinMode === 'parts'
          ? 'Parts — click a part to select · drag its mesh to reposition the sprite'
          : paintMode
            ? selBone >= 0 ? `Paint ${bones[selBone]?.name} — drag on the mesh (⌥ subtract) · checked parts only` : 'Click a joint to pick the bone to paint'
            : tool === 'add'
              ? `Add — click to place a bone${selBone >= 0 ? ` (child of ${bones[selBone]?.name})` : ' (root)'}`
              : bones.length ? `${bones.length} bones — drag a joint to move${selBone >= 0 ? ` · ${bones[selBone]?.name ?? selBone}` : ''}` : 'No bones — ＋ Bone, or Auto-rig'}
        <span style={{ color: '#555' }}> · wheel zoom · right-drag pan</span>
      </div>
    </div>
  );
}

