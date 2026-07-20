/** NineSliceEditor — Unity-style 9-slice border editor for a UI texture.
 *
 *  Opened from the Texture Inspector (UI type). Shows the source image on a
 *  zoomable/pannable canvas with FOUR draggable guide lines (left/right/top/
 *  bottom insets); persists `border` (source px) into the texture's `.meta.json`
 *  and live-registers the texture's auto whole-image sprite with the new border so
 *  `UINode`'s `border-image` updates without a rescan. Dev-only (editor).
 *
 *  Mirrors SpriteEditor's canvas-in-scroll-viewport (pan = scroll, zoom = canvas
 *  size), minus the slice machinery — here the only editable state is 4 numbers. */

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { backendFetch } from '../backend/editorBackend';
import { useEditorStore } from '../store/editorStore';
import { writeMetaOrWarn } from './assetViews/widgets';
import { BufferedNumberInput } from './fields';
import { registerSprite, isGuid, deriveGuid } from '../../runtime/loaders/assetManifest';
import { markUIDirty } from '../../runtime/ui/uiTreeStore';
import { registerHandleProvider, type InteractionHandle } from '../../runtime/rendering/interactionHandles';

export interface NineSliceBorder { l: number; r: number; t: number; b: number; }

type Edge = 'l' | 'r' | 't' | 'b';
const EDGES: Edge[] = ['l', 'r', 't', 'b'];
const HIT = 6;                 // px (screen) tolerance for grabbing a guide
const DEFAULT_VIEWPORT_W = 640;
const DEFAULT_VIEWPORT_H = 480;
const MAX_CANVAS_PX = 8192;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

export function NineSliceEditor({ path, name, onClose }: { path: string; name: string; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null);
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [border, setBorder] = useState<NineSliceBorder>({ l: 0, r: 0, t: 0, b: 0 });
  const [edgeScale, setEdgeScale] = useState(1);   // edge render scale (CSS px per source px)
  const [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState({ w: DEFAULT_VIEWPORT_W, h: DEFAULT_VIEWPORT_H });
  const dragRef = useRef<Edge | null>(null);
  const panRef = useRef<{ active: boolean; cx: number; cy: number; sl: number; st: number }>({ active: false, cx: 0, cy: 0, sl: 0, st: 0 });
  const pendingAnchorRef = useRef<{ ix: number; iy: number; vx: number; vy: number } | null>(null);
  const refreshAssets = useEditorStore((s) => s.refreshAssets);

  // ── Load source image + existing border meta ──
  useEffect(() => {
    const img = new Image();
    img.onload = () => { imgRef.current = img; setImgDims({ w: img.naturalWidth, h: img.naturalHeight }); setZoom(1); };
    img.onerror = () => console.error('[NineSliceEditor] failed to load image', path);
    img.src = path;
    return () => { img.onload = null; img.onerror = null; };
  }, [path]);

  useEffect(() => {
    const ac = new AbortController();
    backendFetch(`/api/read-meta?path=${encodeURIComponent(path)}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : {}))
      .then((m: Record<string, unknown>) => {
        setMeta(m);
        const b = m.border as (Partial<NineSliceBorder> & { scale?: number }) | undefined;
        if (b) { setBorder({ l: b.l || 0, r: b.r || 0, t: b.t || 0, b: b.b || 0 }); setEdgeScale(b.scale && b.scale > 0 ? b.scale : 1); }
      })
      .catch(() => { /* fresh — no border yet */ });
    return () => ac.abort();
  }, [path]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewport({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setViewport({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ── View transform (canvas IS the zoomed image; pan = scroll) ──
  const fitScale = imgDims ? Math.min(viewport.w / imgDims.w, viewport.h / imgDims.h) : 1;
  const maxZoom = imgDims ? Math.max(1, MAX_CANVAS_PX / (Math.max(imgDims.w, imgDims.h) * fitScale)) : 32;
  const scale = fitScale * clamp(zoom, 1, maxZoom);
  const canvasW = imgDims ? Math.max(1, Math.round(imgDims.w * scale)) : viewport.w;
  const canvasH = imgDims ? Math.max(1, Math.round(imgDims.h * scale)) : viewport.h;
  const screenToImg = (px: number, py: number) => ({ x: px / scale, y: py / scale });

  const zoomAt = useCallback((nextZoom: number, vx: number, vy: number) => {
    const el = scrollRef.current;
    if (!imgDims || !el) { setZoom(clamp(nextZoom, 1, maxZoom)); return; }
    const curScale = fitScale * clamp(zoom, 1, maxZoom);
    pendingAnchorRef.current = { ix: (el.scrollLeft + vx) / curScale, iy: (el.scrollTop + vy) / curScale, vx, vy };
    setZoom(clamp(nextZoom, 1, maxZoom));
  }, [imgDims, fitScale, zoom, maxZoom]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = pendingAnchorRef.current;
    if (!el || !a) return;
    pendingAnchorRef.current = null;
    el.scrollLeft = a.ix * scale - a.vx;
    el.scrollTop = a.iy * scale - a.vy;
  }, [scale]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, zoom]);

  // Guide positions in IMAGE space (x for l/r, y for t/b).
  const guideImgCoord = useCallback((e: Edge): number => {
    if (!imgDims) return 0;
    switch (e) {
      case 'l': return border.l;
      case 'r': return imgDims.w - border.r;
      case 't': return border.t;
      case 'b': return imgDims.h - border.b;
    }
  }, [border, imgDims]);

  // ── Enact: expose the 4 guide-line grab knobs as interaction handles (viewport CSS
  // px). Reuses the SAME image→canvas math the draw + hit-test use (`guideImgCoord*scale`
  // along the guide axis, mid-canvas on the other). The canvas is 1:1 (no DPR backing)
  // and has no border, and getBoundingClientRect reflects scroll, so no clientLeft/Top
  // term (fixed-overlay modal). Live state via a ref → provider registers once.
  const EDGE_LABEL: Record<Edge, string> = { l: 'Left', r: 'Right', t: 'Top', b: 'Bottom' };
  const nineHandleStateRef = useRef<{ scale: number; border: NineSliceBorder; imgDims: { w: number; h: number } | null }>({ scale: 1, border, imgDims: null });
  nineHandleStateRef.current = { scale, border, imgDims };
  useEffect(() => {
    const unreg = registerHandleProvider((): InteractionHandle[] => {
      const canvas = canvasRef.current;
      if (!canvas) return [];
      const st = nineHandleStateRef.current;
      if (!st.imgDims) return [];
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return [];
      const coordOf = (e: Edge): number =>
        e === 'l' ? st.border.l : e === 'r' ? st.imgDims!.w - st.border.r : e === 't' ? st.border.t : st.imgDims!.h - st.border.b;
      return EDGES.map((e) => {
        const g = coordOf(e) * st.scale;
        const vertical = e === 'l' || e === 'r';
        return {
          id: `nineslice:guide:${e}`,
          kind: 'nineslice-guide',
          editor: 'nineslice',
          x: rect.left + (vertical ? g : rect.width / 2),
          y: rect.top + (vertical ? rect.height / 2 : g),
          label: EDGE_LABEL[e],
          meta: { edge: e, inset: e === 'l' ? st.border.l : e === 'r' ? st.border.r : e === 't' ? st.border.t : st.border.b },
        };
      });
    });
    return unreg;
  }, []);

  // ── Draw ──
  const draw = useCallback(() => {
    const canvas = canvasRef.current, img = imgRef.current;
    if (!canvas || !img || !imgDims) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.fillStyle = '#15151f';
    ctx.fillRect(0, 0, canvasW, canvasH);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, canvasW, canvasH);

    const lx = border.l * scale, rx = (imgDims.w - border.r) * scale;
    const ty = border.t * scale, by = (imgDims.h - border.b) * scale;
    // Dim the 4 corners lightly to show the fixed (non-stretched) regions.
    ctx.fillStyle = 'rgba(46,204,113,0.12)';
    ctx.fillRect(0, 0, lx, ty);                       // NW
    ctx.fillRect(rx, 0, canvasW - rx, ty);            // NE
    ctx.fillRect(0, by, lx, canvasH - by);            // SW
    ctx.fillRect(rx, by, canvasW - rx, canvasH - by); // SE

    ctx.strokeStyle = '#2ecc71';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    for (const x of [lx, rx]) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, canvasH); ctx.stroke(); }
    for (const y of [ty, by]) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(canvasW, y + 0.5); ctx.stroke(); }
    ctx.setLineDash([]);
    // Handle knobs at each guide's midpoint.
    ctx.fillStyle = '#2ecc71';
    const midY = canvasH / 2, midX = canvasW / 2;
    for (const x of [lx, rx]) ctx.fillRect(x - 3, midY - 8, 6, 16);
    for (const y of [ty, by]) ctx.fillRect(midX - 8, y - 3, 16, 6);
  }, [border, imgDims, scale, canvasW, canvasH]);

  useEffect(() => { draw(); }, [draw]);

  // Live preview: re-register the texture's auto whole-image sprite with the current
  // border + edge scale so the scene view (UINode border-image) updates as you drag,
  // before Save persists it to the meta.
  useEffect(() => {
    const texGuid = typeof meta?.id === 'string' ? meta.id : undefined;
    if (!texGuid || !isGuid(texGuid) || !imgDims) return;
    const hasBorder = border.l || border.r || border.t || border.b;
    registerSprite(deriveGuid('sprite:' + texGuid), texGuid, path, {
      texture: texGuid, name, rect: { x: 0, y: 0, w: imgDims.w, h: imgDims.h }, pivot: { x: 0.5, y: 0.5 },
      sheetW: imgDims.w, sheetH: imgDims.h,
      ...(hasBorder ? { border: { ...border, ...(edgeScale !== 1 ? { scale: edgeScale } : {}) } } : {}),
    });
    markUIDirty();
  }, [border, edgeScale, meta, imgDims, path, name]);

  // ── Interaction ──
  const onMouseDown = (e: React.MouseEvent) => {
    const canvas = canvasRef.current, scroll = scrollRef.current;
    if (!canvas || !imgDims) return;
    if ((e.button === 2 || e.altKey) && scroll) {
      e.preventDefault();
      panRef.current = { active: true, cx: e.clientX, cy: e.clientY, sl: scroll.scrollLeft, st: scroll.scrollTop };
      return;
    }
    if (e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    // Grab the nearest guide within HIT px (vertical guides by |x|, horizontal by |y|).
    let best: Edge | null = null, bestDist = HIT + 1;
    for (const edge of EDGES) {
      const gc = guideImgCoord(edge) * scale;
      const d = (edge === 'l' || edge === 'r') ? Math.abs(gc - px) : Math.abs(gc - py);
      if (d < bestDist) { bestDist = d; best = edge; }
    }
    if (best) dragRef.current = best;
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (panRef.current.active) {
      const scroll = scrollRef.current, p = panRef.current;
      if (scroll) { scroll.scrollLeft = p.sl - (e.clientX - p.cx); scroll.scrollTop = p.st - (e.clientY - p.cy); }
      return;
    }
    const edge = dragRef.current;
    if (!edge || !imgDims) return;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const ip = screenToImg(e.clientX - rect.left, e.clientY - rect.top);
    setBorder((prev) => {
      const ix = Math.round(clamp(ip.x, 0, imgDims.w)), iy = Math.round(clamp(ip.y, 0, imgDims.h));
      switch (edge) {
        case 'l': return { ...prev, l: clamp(ix, 0, imgDims.w - prev.r - 1) };
        case 'r': return { ...prev, r: clamp(imgDims.w - ix, 0, imgDims.w - prev.l - 1) };
        case 't': return { ...prev, t: clamp(iy, 0, imgDims.h - prev.b - 1) };
        case 'b': return { ...prev, b: clamp(imgDims.h - iy, 0, imgDims.h - prev.t - 1) };
      }
    });
  };

  const onMouseUp = () => { panRef.current.active = false; dragRef.current = null; };

  const setEdge = (edge: Edge, v: number) => setBorder((prev) => {
    if (!imgDims) return { ...prev, [edge]: Math.max(0, v) };
    const n = Math.max(0, Math.round(v));
    switch (edge) {
      case 'l': return { ...prev, l: clamp(n, 0, imgDims.w - prev.r - 1) };
      case 'r': return { ...prev, r: clamp(n, 0, imgDims.w - prev.l - 1) };
      case 't': return { ...prev, t: clamp(n, 0, imgDims.h - prev.b - 1) };
      case 'b': return { ...prev, b: clamp(n, 0, imgDims.h - prev.t - 1) };
    }
  });

  // ── Persist ──
  const save = () => {
    const hasBorder = border.l || border.r || border.t || border.b;
    const borderOut = { ...border, ...(edgeScale !== 1 ? { scale: edgeScale } : {}) };
    const nextMeta = { ...(meta ?? {}), version: 2, ...(hasBorder ? { border: borderOut } : {}) };
    if (!hasBorder) delete (nextMeta as Record<string, unknown>).border;
    writeMetaOrWarn(path, nextMeta);

    // Live-update the texture's auto whole-image sprite so UINode's border-image
    // reflects the edit without waiting for a rescan.
    const texGuid = typeof meta?.id === 'string' ? meta.id : undefined;
    if (texGuid && isGuid(texGuid) && imgDims) {
      registerSprite(deriveGuid('sprite:' + texGuid), texGuid, path, {
        texture: texGuid, name, rect: { x: 0, y: 0, w: imgDims.w, h: imgDims.h }, pivot: { x: 0.5, y: 0.5 },
        sheetW: imgDims.w, sheetH: imgDims.h,
        ...(hasBorder ? { border: borderOut } : {}),
      });
    }
    markUIDirty();
    refreshAssets();
    onClose();
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ color: '#fff', fontSize: 13, fontWeight: 'bold' }}>9-slice Border — {name}</div>
          <div style={{ color: '#888', fontSize: 11 }}>{imgDims ? `${imgDims.w}×${imgDims.h}` : '…'}</div>
        </div>

        <div style={{ display: 'flex', gap: 10, flex: 1, minHeight: 0 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
              <button style={zoomBtn} title="Zoom out" onClick={() => zoomAt(zoom / 1.25, viewport.w / 2, viewport.h / 2)}>−</button>
              <button style={zoomBtn} title="Zoom in" onClick={() => zoomAt(zoom * 1.25, viewport.w / 2, viewport.h / 2)}>+</button>
              <button style={zoomBtn} title="Fit" onClick={() => setZoom(1)}>Fit</button>
              <span style={{ color: '#888', fontSize: 11, marginLeft: 4 }}>{Math.round(scale * 100)}%</span>
              <span style={{ color: '#555', fontSize: 10, marginLeft: 'auto' }}>drag guides · scroll = zoom · right-drag = pan</span>
            </div>
            <div
              ref={scrollRef}
              onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
              onContextMenu={(e) => e.preventDefault()}
              style={{ flex: 1, minHeight: 0, overflow: 'auto', background: '#15151f', border: '1px solid #444' }}
            >
              <canvas ref={canvasRef} width={canvasW} height={canvasH} style={{ display: 'block', cursor: 'crosshair' }} />
            </div>
          </div>

          <div style={{ width: 150, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ color: '#f1c40f', fontSize: 10, textTransform: 'uppercase' }}>Border (px)</div>
            {EDGES.map((edge) => (
              <label key={edge} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ color: '#888', fontSize: 10 }}>{{ l: 'Left', r: 'Right', t: 'Top', b: 'Bottom' }[edge]}</span>
                <input type="number" min={0} value={border[edge]} onChange={(e) => setEdge(edge, Number(e.target.value) || 0)} style={inputStyle} />
              </label>
            ))}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
              <span style={{ color: '#888', fontSize: 10 }}>Edge scale (px/src px)</span>
              <BufferedNumberInput value={edgeScale} step={0.05}
                onChange={(v) => setEdgeScale(Math.max(0.05, v || 1))} style={inputStyle} />
            </label>
            <div style={{ color: '#666', fontSize: 10, lineHeight: 1.4 }}>Corners stay fixed; edges + center stretch (CSS border-image). Edge scale draws the border at N CSS px per source px (Unity “pixels per unit”).</div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
          <button style={btn} onClick={onClose}>Cancel</button>
          <button style={{ ...btn, background: '#2ecc71', border: '1px solid #27ae60', color: '#fff' }} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' };
const dialog: React.CSSProperties = {
  background: '#1e1e30', border: '1px solid #555', borderRadius: 6, padding: 14, fontFamily: 'monospace',
  display: 'flex', flexDirection: 'column', width: 860, height: 600, minWidth: 520, minHeight: 400,
  maxWidth: '95vw', maxHeight: '92vh', resize: 'both', overflow: 'hidden',
};
const inputStyle: React.CSSProperties = { background: '#15151f', color: '#ddd', border: '1px solid #444', borderRadius: 3, fontFamily: 'monospace', fontSize: 11, padding: '3px 5px', width: '100%', boxSizing: 'border-box' };
const btn: React.CSSProperties = { background: '#2a2a3a', color: '#ddd', border: '1px solid #444', borderRadius: 3, fontFamily: 'monospace', fontSize: 11, padding: '4px 8px', cursor: 'pointer' };
const zoomBtn: React.CSSProperties = { background: '#2a2a3a', color: '#ddd', border: '1px solid #444', borderRadius: 3, fontFamily: 'monospace', fontSize: 11, padding: '2px 8px', cursor: 'pointer', minWidth: 28 };
