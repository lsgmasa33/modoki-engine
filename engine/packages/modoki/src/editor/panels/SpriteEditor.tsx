/** Sprite Editor — Unity-style sprite slicing for a texture in "multiple" mode.
 *
 *  Opened from the Texture Inspector. Shows the source image on a canvas with
 *  editable slice rects; persists `sprites[]` + `spriteSheet` into the texture's
 *  `.meta.json` and live-registers each slice as a `'sprite'` manifest entry so it
 *  can be referenced from `Renderable2D.sprite`.
 *
 *  Three ways to seed slices: a grid (by count or cell size), auto-detect by alpha
 *  islands, or hand-drawn rects (create / move / resize / pivot / rename / delete).
 *  Dev-only (lives under the editor tree, not shipped). */

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { backendFetch } from '../backend/editorBackend';
import { useOverlay } from '../input/useOverlayEscape';
import { isTextEditable } from '../input/focusScope';
import { register } from '../input/keymap';
import { useHmrEpoch } from '../input/hmrEpoch';
import { useEditorStore } from '../store/editorStore';
import { writeMetaOrWarn } from './assetViews/widgets';
import {
  gridSlices, makeSlice, inferGridFromRects, DEFAULT_PIVOT,
  type SpriteSlice, type SpriteRect,
} from '../../runtime/loaders/spriteSheet';
import {
  registerSprite, unregisterAsset, isGuid,
} from '../../runtime/loaders/assetManifest';
import { markScene2DDirty } from '../../runtime/rendering/Scene2D';
import { registerHandleProvider, clampHandleToOwner, type InteractionHandle } from '../../runtime/rendering/interactionHandles';
import { createCoalescedEdit, type CoalescedEdit } from './coalescedEdit';
import { BufferedNumberInput } from './fields';

type DragMode =
  | { kind: 'none' }
  | { kind: 'create'; startX: number; startY: number }
  | { kind: 'move'; guid: string; offX: number; offY: number }
  | { kind: 'resize'; guid: string; handle: Handle; fixedX: number; fixedY: number };

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const DEFAULT_VIEWPORT_W = 720;
const DEFAULT_VIEWPORT_H = 520;
const MAX_CANVAS_PX = 8192; // browser canvas dimension safety cap
const HANDLE_HIT = 7; // px (screen space) tolerance for grabbing a handle

interface GridOpts {
  mode: 'count' | 'size';
  cols: number; rows: number;
  cellW: number; cellH: number;
  offsetX: number; offsetY: number;
  paddingX: number; paddingY: number;
}
const DEFAULT_GRID: GridOpts = { mode: 'count', cols: 4, rows: 4, cellW: 64, cellH: 64, offsetX: 0, offsetY: 0, paddingX: 0, paddingY: 0 };

/** One undo step: the full editor state (slices + grid controls + alpha threshold),
 *  so undo rolls back parameter changes too, not just the slices. */
interface EditorSnap { sprites: SpriteSlice[]; grid: GridOpts; alpha: number; }

export function SpriteEditor({ path, name, onClose }: { path: string; name: string; onClose: () => void }) {
  const hmrEpoch = useHmrEpoch();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null);
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [sprites, setSprites] = useState<SpriteSlice[]>([]);
  // Store-backed, not local `useState`: an agent needs a route to change which slice is
  // selected (`select-sprite-slice`), and `modoki_get_editor_state` needs to be able to report
  // it — a local state is invisible to both (#373). Reset on mount/unmount below so each open
  // of this modal starts fresh, matching the old local-state lifetime.
  const selected = useEditorStore((s) => s.spriteEditorSelection);
  const setSelected = useEditorStore((s) => s.setSpriteEditorSelection);
  useEffect(() => {
    setSelected(null);
    return () => setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [grid, setGrid] = useState<GridOpts>(DEFAULT_GRID);
  const [alphaThreshold, setAlphaThreshold] = useState(8);
  const initialGuidsRef = useRef<Set<string>>(new Set());
  const dragRef = useRef<DragMode>({ kind: 'none' });
  // The canvas is the FULL zoomed image inside a native scroll viewport — so panning
  // is just container scroll (real scrollbars), and zoom only changes the canvas size.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1); // 1 = fit the whole image in the viewport
  const [viewport, setViewport] = useState({ w: DEFAULT_VIEWPORT_W, h: DEFAULT_VIEWPORT_H });
  // Middle/alt drag scrolls the viewport; pendingAnchor re-centers a wheel-zoom on the cursor.
  const panRef = useRef<{ active: boolean; cx: number; cy: number; sl: number; st: number }>({ active: false, cx: 0, cy: 0, sl: 0, st: 0 });
  const pendingAnchorRef = useRef<{ ix: number; iy: number; vx: number; vy: number } | null>(null);
  const refreshAssets = useEditorStore((s) => s.refreshAssets);

  // ── Load the source image + existing slice meta ──
  useEffect(() => {
    const img = new Image();
    img.onload = () => { imgRef.current = img; setImgDims({ w: img.naturalWidth, h: img.naturalHeight }); setZoom(1); };
    img.onerror = () => { console.error('[SpriteEditor] failed to load source image', path); };
    img.src = path;
    return () => { img.onload = null; img.onerror = null; };
  }, [path]);

  // Track the scroll viewport's size so the fit-scale + canvas follow a resized window.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewport({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setViewport({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    backendFetch(`/api/read-meta?path=${encodeURIComponent(path)}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : {}))
      .then((m: Record<string, unknown>) => {
        setMeta(m);
        const existing = Array.isArray(m.sprites) ? (m.sprites as SpriteSlice[]) : [];
        setSprites(existing.map((s) => ({ ...s, rect: { ...s.rect }, pivot: { ...s.pivot } })));
        initialGuidsRef.current = new Set(existing.map((s) => s.guid));
        // Restore the last-used slicing controls (saved alongside the slices). When
        // none were saved (older meta, or slices made by auto-alpha / hand-drawing),
        // reverse-engineer the grid fields from the existing slices so they're
        // meaningful without a manual "recalculate" step.
        if (m.spriteGrid && typeof m.spriteGrid === 'object') {
          setGrid({ ...DEFAULT_GRID, ...(m.spriteGrid as Partial<GridOpts>) });
        } else if (existing.length > 0) {
          const g = inferGridFromRects(existing.map((s) => s.rect));
          if (g) setGrid((prev) => ({ ...prev, ...g }));
        }
        if (typeof m.spriteAlphaThreshold === 'number') setAlphaThreshold(m.spriteAlphaThreshold);
      })
      .catch(() => { /* no meta yet — fresh sheet */ });
    return () => ac.abort();
  }, [path]);

  // ── Canvas view: the canvas IS the full zoomed image (origin 0,0), so pan = scroll.
  // fitScale shows the whole image at zoom 1; scale grows with zoom. Capped so the
  // backing canvas never exceeds the browser's max dimension.
  const fitScale = imgDims ? Math.min(viewport.w / imgDims.w, viewport.h / imgDims.h) : 1;
  const maxZoom = imgDims ? Math.max(1, MAX_CANVAS_PX / (Math.max(imgDims.w, imgDims.h) * fitScale)) : 32;
  const scale = fitScale * clamp(zoom, 1, maxZoom);
  const canvasW = imgDims ? Math.max(1, Math.round(imgDims.w * scale)) : viewport.w;
  const canvasH = imgDims ? Math.max(1, Math.round(imgDims.h * scale)) : viewport.h;
  // Canvas-local coords (relative to the canvas's own top-left, which moves with scroll).
  const imgToScreen = (x: number, y: number) => ({ x: x * scale, y: y * scale });
  const screenToImg = (px: number, py: number) => ({ x: px / scale, y: py / scale });

  // ── Enact: expose the SELECTED sprite's 8 resize handles + pivot as interaction
  // handles (viewport CSS px) so an agent can aim a drag. Reuses the SAME image→canvas
  // math the draw + hit-test use (`handlePos(r,h) * scale`); the canvas has no border,
  // and getBoundingClientRect already reflects scroll, so no clientLeft/Top term (this
  // is a fixed-overlay modal). Live state via a ref → provider registers once. Only the
  // selected real sprite has grab handles drawn, so mirror that (skip the '__preview__'
  // transient + return [] when nothing's selected / image not loaded yet).
  const spriteHandleStateRef = useRef<{ scale: number; sprites: SpriteSlice[]; selected: string | null }>({ scale: 1, sprites: [], selected: null });
  spriteHandleStateRef.current = { scale, sprites, selected };
  useEffect(() => {
    const unreg = registerHandleProvider((): InteractionHandle[] => {
      const canvas = canvasRef.current;
      if (!canvas) return [];
      const st = spriteHandleStateRef.current;
      if (!st.selected || st.selected === '__preview__') return [];
      const s = st.sprites.find((sp) => sp.guid === st.selected);
      if (!s) return [];
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return [];
      const out: InteractionHandle[] = HANDLES.map((h) => {
        const hp = handlePos(s.rect, h);
        // The canvas ELEMENT is `Math.round(imgDims.h * scale)` px tall while this is the
        // unrounded product, so a handle on the sheet's far edge lands up to half a pixel
        // outside its own canvas and Enact refuses it. See `clampHandleToOwner` — the clamp is
        // tolerance-limited on purpose, so a genuinely scrolled-away handle stays refused.
        const p = clampHandleToOwner(rect.left + hp.x * st.scale, rect.top + hp.y * st.scale, rect);
        return {
          id: `sprite:handle:${s.guid}:${h}`,
          kind: 'slice-handle',
          editor: 'sprite',
          x: p.x,
          y: p.y,
          label: `${s.name} ${h}`,
          meta: { guid: s.guid, name: s.name, handle: h, rect: s.rect },
          owner: canvas,
        };
      });
      // Same edge case: a pivot at 1.0 on a slice that reaches the sheet's edge.
      const pv = clampHandleToOwner(
        rect.left + (s.rect.x + s.rect.w * s.pivot.x) * st.scale,
        rect.top + (s.rect.y + s.rect.h * s.pivot.y) * st.scale,
        rect,
      );
      out.push({
        id: `sprite:pivot:${s.guid}`,
        kind: 'slice-pivot',
        editor: 'sprite',
        x: pv.x,
        y: pv.y,
        label: `${s.name} pivot`,
        meta: { guid: s.guid, name: s.name, pivot: s.pivot },
        owner: canvas,
      });
      return out;
    });
    return unreg;
  }, []);

  // Zoom toward a viewport anchor (vx,vy from the scroll container's top-left): keep the
  // image point under it fixed by adjusting scroll AFTER the canvas resizes (layout effect).
  const zoomAt = useCallback((nextZoom: number, vx: number, vy: number) => {
    const el = scrollRef.current;
    if (!imgDims || !el) { setZoom(clamp(nextZoom, 1, maxZoom)); return; }
    const curScale = fitScale * clamp(zoom, 1, maxZoom);
    const ix = (el.scrollLeft + vx) / curScale, iy = (el.scrollTop + vy) / curScale;
    pendingAnchorRef.current = { ix, iy, vx, vy };
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

  const resetView = useCallback(() => { pendingAnchorRef.current = null; setZoom(1); }, []);

  // Native non-passive wheel listener so we can preventDefault (page scroll) while zooming.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomAt(zoom * factor, e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, zoom]);

  // ── Redraw ──
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !imgDims) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasW, canvasH);
    // checker backdrop
    ctx.fillStyle = '#15151f';
    ctx.fillRect(0, 0, canvasW, canvasH);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, canvasW, canvasH);

    for (const s of sprites) {
      const a = imgToScreen(s.rect.x, s.rect.y);
      const w = s.rect.w * scale, h = s.rect.h * scale;
      const isSel = s.guid === selected;
      ctx.lineWidth = isSel ? 2 : 1;
      ctx.strokeStyle = isSel ? '#2ecc71' : '#3498db';
      ctx.strokeRect(a.x + 0.5, a.y + 0.5, w, h);
      // pivot cross
      const pv = imgToScreen(s.rect.x + s.rect.w * s.pivot.x, s.rect.y + s.rect.h * s.pivot.y);
      ctx.strokeStyle = '#e67e22';
      ctx.beginPath();
      ctx.moveTo(pv.x - 4, pv.y); ctx.lineTo(pv.x + 4, pv.y);
      ctx.moveTo(pv.x, pv.y - 4); ctx.lineTo(pv.x, pv.y + 4);
      ctx.stroke();
      if (isSel) {
        ctx.fillStyle = '#2ecc71';
        for (const hd of HANDLES) {
          const hp = handlePos(s.rect, hd);
          const sp = imgToScreen(hp.x, hp.y);
          ctx.fillRect(sp.x - 3, sp.y - 3, 6, 6);
        }
      }
    }
    // imgToScreen is a pure fn of `scale` (already a dep) — recreated each render, so
    // excluding it is intentional (including it would defeat the memo without effect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprites, selected, imgDims, scale, canvasW, canvasH]);

  useEffect(() => { draw(); }, [draw]);

  // ── Slice generators ──
  const applyGrid = () => {
    if (!imgDims) return;
    const opts = grid.mode === 'count'
      ? { imgW: imgDims.w, imgH: imgDims.h, cols: grid.cols, rows: grid.rows, offsetX: grid.offsetX, offsetY: grid.offsetY, paddingX: grid.paddingX, paddingY: grid.paddingY }
      : { imgW: imgDims.w, imgH: imgDims.h, cellW: grid.cellW, cellH: grid.cellH, offsetX: grid.offsetX, offsetY: grid.offsetY, paddingX: grid.paddingX, paddingY: grid.paddingY };
    const next = gridSlices(opts, baseName(name), sprites);
    recordHistory();
    setSprites(next);
    setSelected(next[0]?.guid ?? null);
  };

  const applyAutoAlpha = () => {
    const img = imgRef.current;
    if (!img || !imgDims) return;
    const rects = detectAlphaIslands(img, imgDims.w, imgDims.h, alphaThreshold);
    const base = baseName(name);
    const next = rects.map((rect, i) => makeSliceNamed(`${base}_${i}`, rect));
    recordHistory();
    setSprites(next);
    setSelected(next[0]?.guid ?? null);
  };

  // ── Undo / redo (local to the modal) ──
  // History of FULL editor-state snapshots: the slice array PLUS the grid controls
  // and alpha threshold, so undo rolls back parameter changes (Cols/Off X/…) too,
  // not just the slices they produced. Drag gestures (move/resize/create) record a
  // SINGLE entry per gesture (pre-gesture snapshot, pushed on mouseUp); discrete
  // actions (grid/auto/delete) push before mutating; per-keystroke fields (grid/alpha
  // params, the Selected-sprite numbers) coalesce a run of keystrokes into ONE entry via
  // `paramEditRef` — an idle timer plus a flush from anything else that touches history,
  // never a focus event (#244).
  // `__preview__` is never part of a snapshot.
  const spritesRef = useRef(sprites);
  spritesRef.current = sprites;
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const alphaRef = useRef(alphaThreshold);
  alphaRef.current = alphaThreshold;
  // `selected` now comes from the store (see above) rather than local state, so a functional
  // `setSelected(sel => …)` update can no longer read "the latest value" that way — mirror the
  // sprites/grid/alpha refs above instead.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const pastRef = useRef<EditorSnap[]>([]);
  const futureRef = useRef<EditorSnap[]>([]);
  const gestureStartRef = useRef<EditorSnap | null>(null);
  const paramEditRef = useRef<CoalescedEdit | null>(null);
  const [, setHistVer] = useState(0);
  const cleanSprites = (arr: SpriteSlice[]): SpriteSlice[] =>
    arr.filter((s) => s.guid !== '__preview__').map((s) => ({ ...s, rect: { ...s.rect }, pivot: { ...s.pivot } }));
  const takeSnap = (): EditorSnap => ({
    sprites: cleanSprites(spritesRef.current),
    grid: { ...gridRef.current },
    alpha: alphaRef.current,
  });
  const sameSnap = (a: EditorSnap, b: EditorSnap) => JSON.stringify(a) === JSON.stringify(b);
  // Push `before` as an undo step, dropping redo history. Cap the stack.
  const pushHistory = (before: EditorSnap) => {
    pastRef.current.push(before);
    if (pastRef.current.length > 100) pastRef.current.shift();
    futureRef.current = [];
    setHistVer((v) => v + 1);
  };
  // Per-keystroke fields (grid/alpha params, the Selected-sprite numbers) coalesce into ONE
  // undo step — snapshotted lazily on the first `onChange`, committed on an idle timer or by
  // any other history-touching action. NEVER on focus/blur: those events don't fire in an
  // unfocused window and the step went missing entirely (#244 — see coalescedEdit.ts).
  // Built ONCE (a ref, not per render) and therefore closing over the first render's
  // `takeSnap`/`pushHistory` — which is safe precisely because both read through refs
  // (`spritesRef`/`gridRef`/`alphaRef`/`pastRef`) and `setHistVer` is stable. Rebuilding it
  // per render would instead throw away the open session on every keystroke.
  if (!paramEditRef.current) {
    paramEditRef.current = createCoalescedEdit<EditorSnap>({
      take: () => takeSnap(), same: (a, b) => sameSnap(a, b), push: (before) => pushHistory(before),
    });
  }
  const noteParamEdit = () => paramEditRef.current?.note();
  const flushParamEdit = () => paramEditRef.current?.flush();
  // A pending session must not outlive the modal — its timer would fire into an unmounted tree.
  useEffect(() => () => paramEditRef.current?.cancel(), []);
  // Discrete action: snapshot the current state before mutating it. Closes any open
  // param session first, so the two land as separate undo steps in the order they happened.
  const recordHistory = () => { flushParamEdit(); pushHistory(takeSnap()); };
  const applySnap = (s: EditorSnap) => {
    setSprites(s.sprites.map((x) => ({ ...x, rect: { ...x.rect }, pivot: { ...x.pivot } })));
    setGrid({ ...s.grid });
    setAlphaThreshold(s.alpha);
    setSelected(s.sprites.some((x) => x.guid === selectedRef.current) ? selectedRef.current : null);
  };
  const undo = useCallback(() => {
    // Commit a pending param session BEFORE popping — otherwise the edit the user is
    // undoing was never pushed and this reverts whatever came before it instead (#244).
    paramEditRef.current?.flush();
    if (!pastRef.current.length) return;
    const prev = pastRef.current.pop()!;
    futureRef.current.push(takeSnap());
    applySnap(prev);
    setHistVer((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const redo = useCallback(() => {
    paramEditRef.current?.flush();
    if (!futureRef.current.length) return;
    const next = futureRef.current.pop()!;
    pastRef.current.push(takeSnap());
    applySnap(next);
    setHistVer((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;

  // Set one grid param, coalescing a run of keystrokes into a single undo step.
  const setGridParam = (patch: Partial<GridOpts>) => { noteParamEdit(); setGrid((g) => ({ ...g, ...patch })); };

  // Keyboard: Cmd/Ctrl+Z = undo, +Shift (or Ctrl+Y) = redo. Intercept in the
  // capture phase and ALWAYS stopPropagation while the modal is open, so the
  // editor's GLOBAL undo never fires underneath us — its undo would change the
  // scene selection, swap the Inspector off this texture, and unmount (close)
  // this modal. When focus is in a name/number input we still block the global
  // undo, but skip our own undo + don't preventDefault, so the browser's native
  // text-undo works inside the field.
  // Registered in the OVERLAY scope (focus-scope refactor P6, corrected in P8).
  //
  // The old capture-phase listener encoded TWO separate things, and they must not be
  // collapsed into one condition:
  //   1. ALWAYS stopPropagation — the global scene undo must never run while this modal is
  //      open, in any focus state, because it can change selection, swap the Inspector off
  //      this texture and unmount the modal with unsaved slice edits.
  //   2. preventDefault only OUTSIDE a text field — so the browser's native text-undo still
  //      works while typing in the slice-name / number fields.
  //
  // The first migration expressed (2) as `when`, which silently broke (1): a false `when`
  // YIELDS, so resolution fell through to `app.undo` (app-chord, always eligible) and the
  // scene undo ran underneath the modal — the exact failure the original guarded against.
  // Claiming and preventing are separate decisions, so they are separate fields.
  const overlayId = useOverlay(true, 'sprite-editor');
  useEffect(() => {
    const notTyping = () => !isTextEditable(document.activeElement);
    // No `when`: these ALWAYS claim, denying the chord to the app scope. `run` no-ops while
    // typing, and `preventDefault` stays false there so native text-undo survives.
    const mk = (id: string, keys: string, fn: () => void) =>
      register({
        id, keys, scope: 'overlay', owner: overlayId,
        preventDefault: notTyping,
        run: () => { if (notTyping()) fn(); },
      });
    const offs = [
      mk('spriteEditor.undo', 'mod+z', undo),
      mk('spriteEditor.redo', 'mod+shift+z', redo),
      mk('spriteEditor.redoY', 'mod+y', redo),
    ];
    return () => { for (const off of offs) off(); };
  }, [undo, redo, overlayId, hmrEpoch]);

  // ── Mouse interaction ──
  const onMouseDown = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    const scroll = scrollRef.current;
    if (!canvas || !imgDims) return;
    // Right button (or Alt-modified) = pan by scrolling the viewport, regardless of rect state.
    if ((e.button === 2 || e.altKey) && scroll) {
      e.preventDefault();
      panRef.current = { active: true, cx: e.clientX, cy: e.clientY, sl: scroll.scrollLeft, st: scroll.scrollTop };
      return;
    }
    if (e.button !== 0) return; // only left button edits rects
    // Capture the pre-gesture snapshot so a move/resize/create commits ONE undo
    // step on mouseUp (only if it actually changed anything). Close any open param
    // session first so the gesture doesn't swallow it.
    flushParamEdit();
    gestureStartRef.current = takeSnap();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    // 1) handle of the selected sprite?
    const sel = sprites.find((s) => s.guid === selected);
    if (sel) {
      for (const hd of HANDLES) {
        const hp = imgToScreen(...tuple(handlePos(sel.rect, hd)));
        if (Math.abs(hp.x - px) <= HANDLE_HIT && Math.abs(hp.y - py) <= HANDLE_HIT) {
          const opp = handlePos(sel.rect, opposite(hd));
          dragRef.current = { kind: 'resize', guid: sel.guid, handle: hd, fixedX: opp.x, fixedY: opp.y };
          return;
        }
      }
    }
    // 2) inside an existing rect? (topmost wins → iterate reversed)
    const ip = screenToImg(px, py);
    for (let i = sprites.length - 1; i >= 0; i--) {
      const s = sprites[i];
      if (ip.x >= s.rect.x && ip.x <= s.rect.x + s.rect.w && ip.y >= s.rect.y && ip.y <= s.rect.y + s.rect.h) {
        setSelected(s.guid);
        dragRef.current = { kind: 'move', guid: s.guid, offX: ip.x - s.rect.x, offY: ip.y - s.rect.y };
        return;
      }
    }
    // 3) empty → start a new rect
    setSelected(null);
    dragRef.current = { kind: 'create', startX: clamp(ip.x, 0, imgDims.w), startY: clamp(ip.y, 0, imgDims.h) };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (panRef.current.active) {
      const scroll = scrollRef.current;
      const p = panRef.current;
      if (scroll) { scroll.scrollLeft = p.sl - (e.clientX - p.cx); scroll.scrollTop = p.st - (e.clientY - p.cy); }
      return;
    }
    const drag = dragRef.current;
    if (drag.kind === 'none' || !imgDims) return;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const ip = screenToImg(e.clientX - rect.left, e.clientY - rect.top);
    const ix = clamp(ip.x, 0, imgDims.w), iy = clamp(ip.y, 0, imgDims.h);

    if (drag.kind === 'create') {
      const r = rectFromPoints(drag.startX, drag.startY, ix, iy);
      setSprites((prev) => upsertPreview(prev, '__preview__', r));
      setSelected('__preview__');
    } else if (drag.kind === 'move') {
      setSprites((prev) => prev.map((s) => {
        if (s.guid !== drag.guid) return s;
        const x = clamp(ix - drag.offX, 0, imgDims.w - s.rect.w);
        const y = clamp(iy - drag.offY, 0, imgDims.h - s.rect.h);
        return { ...s, rect: { ...s.rect, x: Math.round(x), y: Math.round(y) } };
      }));
    } else if (drag.kind === 'resize') {
      setSprites((prev) => prev.map((s) => {
        if (s.guid !== drag.guid) return s;
        return { ...s, rect: roundRect(rectFromPoints(drag.fixedX, drag.fixedY, ix, iy)) };
      }));
    }
  };

  const onMouseUp = () => {
    if (panRef.current.active) { panRef.current.active = false; return; }
    const drag = dragRef.current;
    dragRef.current = { kind: 'none' };
    if (drag.kind === 'create') {
      // Was a `setSprites(prev => { …; setSelected(x); return next; })` functional updater that
      // called `setSelected` from INSIDE it. That was safe when `selected` was local `useState`
      // (React tolerates a same-component update queued from an updater); now that `setSelected`
      // writes to the Zustand store — which notifies every subscriber, including OTHER
      // components, synchronously — it's a "setState while rendering a different component"
      // shape. Read the pre-commit sprites from `spritesRef` (kept fresh every render, same as
      // the history refs below) instead, so both setters are called as siblings from this plain
      // event handler, not one nested inside the other's updater.
      // ⚠️ This relies on `spritesRef.current` reflecting the LAST onMouseMove's `setSprites`
      // by the time this (separate, later) browser event runs — the same freshness assumption
      // `takeSnap()` below already makes of `spritesRef`/`gridRef`/`alphaRef` for undo/redo, not
      // a new one introduced here. React flushes a native event's state updates before yielding
      // back to the browser for the next event, so this holds under normal event dispatch; it
      // would NOT hold under a manually-dispatched mousedown+mousemove+mouseup batched into one
      // synchronous call (e.g. some test harnesses) — drive those as separate dispatches.
      const prev = spritesRef.current;
      const pv = prev.find((s) => s.guid === '__preview__');
      const rest = prev.filter((s) => s.guid !== '__preview__');
      if (!pv || pv.rect.w < 3 || pv.rect.h < 3) {
        setSelected(null);
        setSprites(rest);
      } else {
        const slice = makeSliceNamed(`${baseName(name)}_${rest.length}`, roundRect(pv.rect));
        setSelected(slice.guid);
        setSprites([...rest, slice]);
      }
    }
    // Commit one undo step for the whole gesture — but only if it changed the
    // slices (a plain selection click leaves them untouched). Defer the compare so
    // the create-branch's setSprites has applied before we read spritesRef.
    if (drag.kind === 'move' || drag.kind === 'resize' || drag.kind === 'create') {
      const start = gestureStartRef.current;
      gestureStartRef.current = null;
      if (start) {
        requestAnimationFrame(() => {
          if (!sameSnap(start, takeSnap())) pushHistory(start);
        });
      }
    }
  };

  // ── Selected-sprite field edits ──
  const patchSelected = (patch: Partial<SpriteSlice> | { rect?: Partial<SpriteRect>; pivot?: Partial<SpriteSlice['pivot']> }) => {
    // These fields also commit per keystroke, so they coalesce too — an 8-character rename
    // used to push 8 undo steps, and reverting it meant pressing ⌘Z eight times.
    noteParamEdit();
    setSprites((prev) => prev.map((s) => {
      if (s.guid !== selected) return s;
      const p = patch as { name?: string; rect?: Partial<SpriteRect>; pivot?: Partial<SpriteSlice['pivot']> };
      return {
        ...s,
        ...(p.name !== undefined ? { name: p.name } : {}),
        rect: p.rect ? { ...s.rect, ...p.rect } : s.rect,
        pivot: p.pivot ? { ...s.pivot, ...p.pivot } : s.pivot,
      };
    }));
  };

  const deleteSelected = () => {
    if (!selected) return;
    recordHistory();
    setSprites((prev) => prev.filter((s) => s.guid !== selected));
    setSelected(null);
  };

  // ── Persist ──
  const save = async () => {
    if (!imgDims) return;
    const clean = sprites.filter((s) => s.guid !== '__preview__' && s.rect.w > 0 && s.rect.h > 0);
    const textureGuid = typeof meta?.id === 'string' ? meta.id : undefined;
    const nextMeta = {
      ...(meta ?? {}),
      spriteMode: clean.length ? 'multiple' : 'single',
      sprites: clean,
      spriteSheet: { width: imgDims.w, height: imgDims.h },
      // Persist the editor's slicing controls so reopening keeps the last grid /
      // auto-alpha settings (Unity-style sticky import params).
      spriteGrid: grid,
      spriteAlphaThreshold: alphaThreshold,
    };
    if (clean.length === 0) { delete (nextMeta as Record<string, unknown>).sprites; delete (nextMeta as Record<string, unknown>).spriteSheet; }
    // AWAIT before onClose() — same race as the 9-slice editor: the Inspector re-reads this
    // file on close, and an un-awaited POST let that GET win and report the pre-edit slices.
    const persisted = await writeMetaOrWarn(path, nextMeta);
    if (!persisted) {
      // Keep the dialog open on a failed write — see the note in NineSliceEditor.save. A slice set
      // is far more work to re-author than a border, so losing it to a dev-server blip is worse.
      console.error(`[SpriteEditor] save failed for ${path} — the dialog is staying open so the slices are not lost. See the /api/write-meta error above.`);
      return;
    }

    // Live-register the slices so existing references resolve without a rescan, and
    // drop entries for slices that were removed in this session.
    if (textureGuid && isGuid(textureGuid)) {
      for (const s of clean) {
        registerSprite(s.guid, textureGuid, path, {
          texture: textureGuid, name: s.name, rect: s.rect, pivot: s.pivot,
          ...(s.border ? { border: s.border } : {}),
          sheetW: imgDims.w, sheetH: imgDims.h,
        });
      }
    }
    const liveGuids = new Set(clean.map((s) => s.guid));
    for (const g of initialGuidsRef.current) if (!liveGuids.has(g)) unregisterAsset(g);

    // Re-slicing bumps the sprite epoch (in registerSprite); nudge the idle 2D
    // renderer so any on-screen sprite using an edited frame rebuilds immediately.
    markScene2DDirty();
    refreshAssets();
    onClose();
  };

  const selSlice = sprites.find((s) => s.guid === selected && s.guid !== '__preview__') ?? null;

  // The overlay below is deliberately INERT — no `onClick={onClose}`. This dialog holds unsaved
  // work, and a stray click outside it used to close it and discard every edit silently: no
  // confirmation, and no visual difference from a Save, so the scene kept the live preview while
  // the meta and the Inspector still said the old value (owner, 2026-08-18). Cancel and Save are
  // the only exits. Do not "restore" the dismiss here — it is correct for the one-shot pickers
  // (SpritePicker, AddPropertyPicker, BindAnimatorPicker, the layout prompts), where dismissing
  // IS the cancel and there is nothing to lose. Guarded by
  // engine/tests/architecture/modalDismissScope.test.ts.
  return (
    <div style={overlay}>
      <div style={dialog}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ color: '#fff', fontSize: 13, fontWeight: 'bold' }}>Sprite Editor — {name}</div>
          <div style={{ color: '#888', fontSize: 11 }}>{imgDims ? `${imgDims.w}×${imgDims.h}` : '…'} · {sprites.filter(s => s.guid !== '__preview__').length} sprites</div>
        </div>

        <div style={{ display: 'flex', gap: 10, flex: 1, minHeight: 0 }}>
          {/* Canvas + scroll viewport */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
              <button style={zoomBtn} title="Zoom out" onClick={() => zoomAt(zoom / 1.25, viewport.w / 2, viewport.h / 2)}>−</button>
              <button style={zoomBtn} title="Zoom in" onClick={() => zoomAt(zoom * 1.25, viewport.w / 2, viewport.h / 2)}>+</button>
              <button style={zoomBtn} title="Reset to fit" onClick={resetView}>Fit</button>
              <button style={zoomBtn} title="1 image pixel = 1 screen pixel" onClick={() => zoomAt(1 / fitScale, viewport.w / 2, viewport.h / 2)}>1:1</button>
              <span style={{ color: '#888', fontSize: 11, marginLeft: 4 }}>{Math.round(scale * 100)}%</span>
              <button style={{ ...zoomBtn, marginLeft: 10, opacity: canUndo ? 1 : 0.4 }} title="Undo (⌘Z)" disabled={!canUndo} onClick={undo}>↶</button>
              <button style={{ ...zoomBtn, opacity: canRedo ? 1 : 0.4 }} title="Redo (⌘⇧Z)" disabled={!canRedo} onClick={redo}>↷</button>
              <span style={{ color: '#555', fontSize: 10, marginLeft: 'auto' }}>scroll = zoom · right-drag = pan</span>
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

          {/* Right controls */}
          <div style={{ width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
            <Section title="Grid Slice">
              <Row>
                <select value={grid.mode} onChange={(e) => { recordHistory(); setGrid({ ...grid, mode: e.target.value as GridOpts['mode'] }); }} style={inputStyle}>
                  <option value="count">By Cell Count</option>
                  <option value="size">By Cell Size</option>
                </select>
              </Row>
              {grid.mode === 'count' ? (
                <Row><Num label="Cols" v={grid.cols} on={(v) => setGridParam({ cols: v })} onBlur={flushParamEdit} dataUiId="spriteEditor.grid.cols" /><Num label="Rows" v={grid.rows} on={(v) => setGridParam({ rows: v })} onBlur={flushParamEdit} dataUiId="spriteEditor.grid.rows" /></Row>
              ) : (
                <Row><Num label="Cell W" v={grid.cellW} on={(v) => setGridParam({ cellW: v })} onBlur={flushParamEdit} dataUiId="spriteEditor.grid.cellW" /><Num label="Cell H" v={grid.cellH} on={(v) => setGridParam({ cellH: v })} onBlur={flushParamEdit} dataUiId="spriteEditor.grid.cellH" /></Row>
              )}
              <Row><Num label="Off X" v={grid.offsetX} on={(v) => setGridParam({ offsetX: v })} onBlur={flushParamEdit} dataUiId="spriteEditor.grid.offsetX" /><Num label="Off Y" v={grid.offsetY} on={(v) => setGridParam({ offsetY: v })} onBlur={flushParamEdit} dataUiId="spriteEditor.grid.offsetY" /></Row>
              <Row><Num label="Pad X" v={grid.paddingX} on={(v) => setGridParam({ paddingX: v })} onBlur={flushParamEdit} dataUiId="spriteEditor.grid.paddingX" /><Num label="Pad Y" v={grid.paddingY} on={(v) => setGridParam({ paddingY: v })} onBlur={flushParamEdit} dataUiId="spriteEditor.grid.paddingY" /></Row>
              <button style={btn} onClick={applyGrid}>Slice Grid</button>
            </Section>

            <Section title="Auto (by alpha)">
              <Row><Num label="Threshold" v={alphaThreshold} on={(v) => { noteParamEdit(); setAlphaThreshold(v); }} onBlur={flushParamEdit} dataUiId="spriteEditor.auto.threshold" /></Row>
              <button style={btn} onClick={applyAutoAlpha}>Detect Sprites</button>
            </Section>

            <Section title="Selected">
              {selSlice ? (
                <>
                  <Row><input value={selSlice.name} onChange={(e) => patchSelected({ name: e.target.value })} onBlur={flushParamEdit} style={{ ...inputStyle, flex: 1 }} placeholder="name" /></Row>
                  <Row><Num label="X" v={selSlice.rect.x} on={(v) => patchSelected({ rect: { x: v } })} onBlur={flushParamEdit} dataUiId="spriteEditor.selected.x" /><Num label="Y" v={selSlice.rect.y} on={(v) => patchSelected({ rect: { y: v } })} onBlur={flushParamEdit} dataUiId="spriteEditor.selected.y" /></Row>
                  <Row><Num label="W" v={selSlice.rect.w} on={(v) => patchSelected({ rect: { w: v } })} onBlur={flushParamEdit} dataUiId="spriteEditor.selected.w" /><Num label="H" v={selSlice.rect.h} on={(v) => patchSelected({ rect: { h: v } })} onBlur={flushParamEdit} dataUiId="spriteEditor.selected.h" /></Row>
                  <Row><Num label="Pivot X" v={selSlice.pivot.x} step={0.1} on={(v) => patchSelected({ pivot: { x: v } })} onBlur={flushParamEdit} dataUiId="spriteEditor.selected.pivotX" /><Num label="Pivot Y" v={selSlice.pivot.y} step={0.1} on={(v) => patchSelected({ pivot: { y: v } })} onBlur={flushParamEdit} dataUiId="spriteEditor.selected.pivotY" /></Row>
                  <button style={{ ...btn, background: '#7a2727', border: '1px solid #913030' }} onClick={deleteSelected}>Delete Sprite</button>
                </>
              ) : <div style={{ color: '#666', fontSize: 11 }}>Drag on the image to draw a sprite, or slice a grid.</div>}
            </Section>

            {sprites.length > 0 && (
              <Section title="Sprites">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {sprites.filter((s) => s.guid !== '__preview__').map((s) => (
                    <div key={s.guid} onClick={() => setSelected(s.guid)}
                      data-ui-id={`spriteEditor.slice.${s.guid}`} data-ui-kind="row" data-ui-label={s.name}
                      style={{
                        padding: '2px 6px', fontSize: 11, cursor: 'pointer', borderRadius: 2,
                        background: s.guid === selected ? '#2c4' : 'transparent', color: s.guid === selected ? '#000' : '#bbb',
                      }}>{s.name}</div>
                  ))}
                </div>
              </Section>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
          <button data-ui-id="spriteEditor.cancel" style={btn} onClick={onClose}>Cancel</button>
          <button data-ui-id="spriteEditor.save" style={{ ...btn, background: '#2ecc71', border: '1px solid #27ae60', color: '#fff' }} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── helpers ──

export function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/\s+/g, '_').toLowerCase() || 'sprite';
}
function makeSliceNamed(name: string, rect: SpriteRect): SpriteSlice {
  return makeSlice(name, rect, DEFAULT_PIVOT);
}
export function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(v, hi)); }
function tuple(p: { x: number; y: number }): [number, number] { return [p.x, p.y]; }
export function rectFromPoints(x0: number, y0: number, x1: number, y1: number): SpriteRect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}
export function roundRect(r: SpriteRect): SpriteRect {
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)) };
}
export function handlePos(r: SpriteRect, h: Handle): { x: number; y: number } {
  const midX = r.x + r.w / 2, midY = r.y + r.h / 2;
  switch (h) {
    case 'nw': return { x: r.x, y: r.y };
    case 'n': return { x: midX, y: r.y };
    case 'ne': return { x: r.x + r.w, y: r.y };
    case 'e': return { x: r.x + r.w, y: midY };
    case 'se': return { x: r.x + r.w, y: r.y + r.h };
    case 's': return { x: midX, y: r.y + r.h };
    case 'sw': return { x: r.x, y: r.y + r.h };
    case 'w': return { x: r.x, y: midY };
  }
}
export function opposite(h: Handle): Handle {
  const map: Record<Handle, Handle> = { nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' };
  return map[h];
}
export function upsertPreview(prev: SpriteSlice[], guid: string, rect: SpriteRect): SpriteSlice[] {
  const rest = prev.filter((s) => s.guid !== guid);
  return [...rest, { guid, name: 'preview', rect: roundRect(rect), pivot: { ...DEFAULT_PIVOT } }];
}

/** Connected-component (4-neighbour) bounding boxes of opaque regions. Caps work at
 *  a downscaled grid for very large images so the editor stays responsive. */
function detectAlphaIslands(img: HTMLImageElement, w: number, h: number, threshold: number): SpriteRect[] {
  const cap = 1024;
  const scale = Math.min(1, cap / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * scale)), sh = Math.max(1, Math.round(h * scale));
  const cv = document.createElement('canvas');
  cv.width = sw; cv.height = sh;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0, sw, sh);
  const data = ctx.getImageData(0, 0, sw, sh).data;
  const opaque = new Uint8Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) opaque[i] = data[i * 4 + 3] > threshold ? 1 : 0;

  const visited = new Uint8Array(sw * sh);
  const boxes: SpriteRect[] = [];
  const stack: number[] = [];
  for (let i = 0; i < sw * sh; i++) {
    if (!opaque[i] || visited[i]) continue;
    let minX = sw, minY = sh, maxX = 0, maxY = 0;
    stack.length = 0; stack.push(i); visited[i] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % sw, y = (p - x) / sw;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      // 4-neighbour flood, inlined (no per-pixel array allocation — this loop runs
      // up to ~1M times). Horizontal neighbours are guarded against row-wrap; the
      // x/y bounds checks make the index in-range so no extra range test is needed.
      let q: number;
      if (x > 0)      { q = p - 1;  if (!visited[q] && opaque[q]) { visited[q] = 1; stack.push(q); } }
      if (x < sw - 1) { q = p + 1;  if (!visited[q] && opaque[q]) { visited[q] = 1; stack.push(q); } }
      if (y > 0)      { q = p - sw; if (!visited[q] && opaque[q]) { visited[q] = 1; stack.push(q); } }
      if (y < sh - 1) { q = p + sw; if (!visited[q] && opaque[q]) { visited[q] = 1; stack.push(q); } }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (bw < 2 || bh < 2) continue; // drop noise
    // map back to full-res image space
    boxes.push({ x: Math.floor(minX / scale), y: Math.floor(minY / scale), w: Math.ceil(bw / scale), h: Math.ceil(bh / scale) });
  }
  // stable order: top-to-bottom, then left-to-right
  boxes.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return boxes;
}

// ── small styled bits ──
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' };
const dialog: React.CSSProperties = {
  background: '#1e1e30', border: '1px solid #555', borderRadius: 6, padding: 14, fontFamily: 'monospace',
  // Resizable window: drag the bottom-right corner. Flex column so the canvas viewport
  // (flex:1) absorbs the extra space.
  display: 'flex', flexDirection: 'column',
  width: 1000, height: 660, minWidth: 560, minHeight: 440, maxWidth: '95vw', maxHeight: '92vh',
  resize: 'both', overflow: 'hidden',
};
const inputStyle: React.CSSProperties = { background: '#15151f', color: '#ddd', border: '1px solid #444', borderRadius: 3, fontFamily: 'monospace', fontSize: 11, padding: '3px 5px', width: '100%', boxSizing: 'border-box' };
const btn: React.CSSProperties = { background: '#2a2a3a', color: '#ddd', border: '1px solid #444', borderRadius: 3, fontFamily: 'monospace', fontSize: 11, padding: '4px 8px', cursor: 'pointer', width: '100%' };
const zoomBtn: React.CSSProperties = { background: '#2a2a3a', color: '#ddd', border: '1px solid #444', borderRadius: 3, fontFamily: 'monospace', fontSize: 11, padding: '2px 8px', cursor: 'pointer', minWidth: 28 };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ color: '#f1c40f', fontSize: 10, textTransform: 'uppercase', margin: '0 0 4px' }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  );
}
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>{children}</div>;
}
/** A labelled number field. Delegates to the Inspector's `BufferedNumberInput` rather than
 *  carrying its own `<input type="number">`: a number input reports `value === ''` for an
 *  incomplete entry like a lone `-` or a trailing `.`, so the commit-per-keystroke wiring
 *  wiped the sign before a digit could follow and a negative offset / fractional pivot was
 *  not typeable at all. The shared field also carries the #242 echo guard and wheel-stepping.
 *
 *  `onBlur` sits on the LABEL, not the input: React's onBlur is `focusout`, which bubbles,
 *  and BufferedNumberInput owns the input's own focus handlers. It is an EXTRA commit signal
 *  for the click-away path — never the only one, which is what #244 was. */
// dataUiId is REQUIRED (#724 close-out) — findBufferedInputs (chromeTagging.test.ts) sees only
// a literal Buffered-input JSX tag, so an optional prop here would let a new caller of this
// helper go untagged with the suite green. The type checker is the guard now.
function Num({ label, v, on, step, onBlur, dataUiId }: { label: string; v: number; on: (v: number) => void; step?: number; onBlur?: () => void; dataUiId: string }) {
  return (
    <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }} onBlur={onBlur}>
      <span style={{ color: '#888', fontSize: 10 }}>{label}</span>
      <BufferedNumberInput value={v} onChange={on} step={step ?? 1} style={inputStyle} dataUiId={dataUiId} dataUiLabel={label} />
    </label>
  );
}
