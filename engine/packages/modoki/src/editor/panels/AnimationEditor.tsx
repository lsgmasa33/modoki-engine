/** Animation Editor panel — a Unity-style keyframe timeline for `.anim.json` clips.
 *  Top: transport / record / frame / clip name / samples. Left: animated-property list
 *  with Add Property. Right: Dopesheet timeline (diamonds). Editing a trait field while
 *  recording keys the clip at the playhead; scrubbing poses the bound entities live.
 *
 *  Architecture mirrors ParticleEditor: the live clip is the single source of truth in
 *  the editor store, so the GLOBAL undo stack applies edits even when this panel is
 *  unfocused. Edits coalesce per group; persistence is a debounced /api/write-file. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { backendFetch } from '../backend/editorBackend';
import { useEditorStore } from '../store/editorStore';
import { getCurrentWorld } from '../../runtime/ecs/world';
import { findEntity, getAllEntities, getStructureVersion, fireDirtyListeners } from '../../runtime/ecs/entityUtils';
import { getTraitByName } from '../../runtime/ecs/traitRegistry';
import { newGuid, registerAsset, getGuidForPath, resolveRef } from '../../runtime/loaders/assetManifest';
import {
  applyClipAtTime, advanceClipTime,
} from '../../runtime/animation/sampleClip';
import { applyClipDeform } from '../../runtime/systems/deform2DSystem';
import { beginDeform2DFrame } from '../../runtime/systems/deform2DBuffers';
import {
  defaultAnimationClip, normalizeAnimationClip,
  type AnimationClipDef, type AnimationTrack, type TrackValueType,
} from '../../runtime/animation/types';
import { useDebouncedSave } from './useDebouncedSave';
import { pushAction, peekUndo, isExecutingUndoRedo, undo as gUndo, redo as gRedo, type UndoAction } from '../undo/undoManager';
import {
  setRecordHook, relativeEntityPath, encodeValue, upsertKey, findTrack, moveKeysInTime,
  trackKey, groupSelection, selRefsFromIds, resolveKeySelection, nextKeyTime,
  remapSelectionAfterRemoval, reorderPermutation, remapSelectionAfterReorder, remapSelectionAfterDelete,
} from '../animation/recording';
import { extractKeyBlock, planPaste, applyBreakUnify, applyValueNudge, planAddedTracks, type KeyClipboard } from '../animation/clipEdits';
import { shouldCoalesce } from '../animation/undoCoalesce';
import { getAnimEntityIndex, resolvePathToEntityId } from '../animation/entityIndex';
import { applyTangentMode, evalTrackValue, type TangentMode } from '../../runtime/animation/curveEval';
import { getPath } from '../../runtime/animation/pathValue';
import type { Keyframe } from '../../runtime/animation/types';
import AnimationToolbar from './animation/AnimationToolbar';
import TrackList from './animation/TrackList';
import DopesheetView from './animation/DopesheetView';
import CurvesView from './animation/CurvesView';
import AddPropertyPicker, { type PropertyCandidate } from './animation/AddPropertyPicker';
import { clampKeyTime, frameToTime, snapToFrame, timeToFrame, DEFAULT_VIEWPORT, type Viewport } from './animation/timelineMath';
import { saveAssetDialog } from '../utils/saveDialog';
import { enterScrubMode, exitPreviewMode } from '../scene/playMode';

const COALESCE_MS = 500;
const AUTOSAVE_MS = 400;
const TRACK_LIST_MIN_W = 140;
const TRACK_LIST_MAX_W = 560;
/** Minimum gap (in frames) between a copied block and its paste, for tiny/single
 *  selections that have little or no span of their own. */
const PASTE_MIN_GAP_FRAMES = 5;
/** Extra breathing room (frames) added on top of the block-width gap. */
const PASTE_GAP_MARGIN_FRAMES = 8;
type ClipAction = UndoAction & { _after: AnimationClipDef };

export default function AnimationEditor() {
  const asset = useEditorStore((s) => s.editingAnimationAsset);
  const nonce = useEditorStore((s) => s.animationEditNonce);
  const clip = useEditorStore((s) => s.editingAnimationClip);
  const rootId = useEditorStore((s) => s.animatorRootEntityId);
  const playhead = useEditorStore((s) => s.playheadTime);
  const recording = useEditorStore((s) => s.isRecording);
  const playing = useEditorStore((s) => s.isPreviewPlaying);
  const selectedEntityId = useEditorStore((s) => s.selectedEntityId);

  // While recording, warn up-front if the selected entity isn't under this clip's
  // Animator root — editing it then can't be keyed (the record hook drops it).
  // Memoized + reads the cached index, so it doesn't rebuild an entity map every
  // render (incl. 60fps preview re-renders); recomputes on structure change.
  const structureVersion = getStructureVersion();
  const selectedOutsideRoot = useMemo(() => {
    if (!recording || rootId == null || selectedEntityId == null) return null;
    const { byId } = getAnimEntityIndex();
    if (relativeEntityPath(rootId, selectedEntityId, byId) !== null) return null;
    return { who: byId.get(selectedEntityId)?.name ?? `#${selectedEntityId}`, root: byId.get(rootId)?.name ?? `#${rootId}` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, rootId, selectedEntityId, structureVersion]);

  const [saveMsg, setSaveMsg] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(null);
  // Multi-track selection (indices). `selectedTrack` stays the "primary" (drives the
  // curve focus + single-key inspector); `selectedTracks` adds shift/cmd multi-pick
  // so several properties can be deleted at once and shown together in the graph.
  const [selectedTracks, setSelectedTracks] = useState<Set<number>>(new Set());
  // Multi-key selection: a Set of "ti:ki" ids. A ref mirrors it so the pointer
  // handlers (which run between renders during a drag) read the latest selection
  // synchronously. Always mutate both via setSel.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const selectedKeysRef = useRef<Set<string>>(selectedKeys);
  const setSel = useCallback((s: Set<string>) => { selectedKeysRef.current = s; setSelectedKeys(s); }, []);
  const [viewMode, setViewMode] = useState<'dopesheet' | 'curves'>('dopesheet');
  // Shared horizontal timeline viewport (zoom + pan), used by BOTH the Dopesheet
  // and Curves views so switching views keeps the same zoom. Wheel zooms toward the
  // cursor; right-drag pans (SceneView convention). Reset via Home / 0.
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEWPORT);
  // Resizable property-list width (drag the divider between the list and the timeline).
  // Persisted so it survives reloads.
  const [trackListW, setTrackListW] = useState<number>(() => {
    try { const v = Number(localStorage.getItem('modoki.anim.trackListW')); if (v >= TRACK_LIST_MIN_W && v <= TRACK_LIST_MAX_W) return v; } catch { /* no localStorage */ }
    return 220;
  });
  const trackListWRef = useRef(trackListW); trackListWRef.current = trackListW;
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const r = resizeRef.current; if (!r) return;
      setTrackListW(Math.max(TRACK_LIST_MIN_W, Math.min(TRACK_LIST_MAX_W, r.startW + (e.clientX - r.startX))));
    };
    const up = () => {
      if (!resizeRef.current) return;
      resizeRef.current = null;
      document.body.style.userSelect = '';
      try { localStorage.setItem('modoki.anim.trackListW', String(Math.round(trackListWRef.current))); } catch { /* ignore */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, []);
  const startResize = useCallback((e: React.PointerEvent) => {
    resizeRef.current = { startX: e.clientX, startW: trackListWRef.current };
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }, []);
  // Frozen snapshot for an in-progress group time-drag (see dragSelectedKeys).
  const dragBaseRef = useRef<{ clip: AnimationClipDef; sel: { ti: number; t0: number }[]; grabT0: number; lastDelta: number } | null>(null);

  // Keyframe clipboard (Cmd/Ctrl+C → V). Copied keys are stored per source track
  // (matched back on paste by path|trait|field) with times made relative to the
  // earliest copied key. Paste duplicates the block right AFTER the original
  // (starting one frame past `srcEnd`), stepping forward until no pasted key
  // collides with an existing key. `span` = block length; `srcEnd` = absolute time
  // of the last copied key.
  const clipboardRef = useRef<KeyClipboard | null>(null);
  // Reactive mirror of "clipboard has content" so the Paste button can enable.
  const [hasClipboard, setHasClipboard] = useState(false);

  const lastGroup = useRef<string | undefined>(undefined);
  const lastTime = useRef(0);
  const lastAction = useRef<ClipAction | null>(null);
  const savedMarkRef = useRef<((c: AnimationClipDef) => void) | null>(null);
  // Shortcuts act while the pointer is over the panel OR after you've clicked into it
  // (until you click another panel) — so e.g. selecting a key then moving the mouse to
  // the viewport doesn't make Cmd+Delete silently miss. `activeRef` is the last-clicked
  // state; `rootRef` scopes the containment test.
  const hoverRef = useRef(false);
  const activeRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // ── Auto-bind the Animator root when none is set ──
  // Binding is normally computed when the clip is opened (Assets double-click).
  // But a clip can end up open with no root — opened before its Animator existed,
  // or carried across a reload. Recover by searching the live world for the
  // Animator whose `clip` references this open clip, so authoring "just works"
  // without forcing a reopen. Re-runs on clip change and on edit nonce (covers
  // adding the Animator after the clip was already open).
  useEffect(() => {
    if (rootId != null || !asset) return;
    const animMeta = getTraitByName('Animator');
    if (!animMeta) return;
    const guid = getGuidForPath(asset.path);
    for (const e of getAllEntities()) {
      if (!e.traits.includes('Animator')) continue;
      const data = findEntity(e.id)?.get(animMeta.trait) as Record<string, unknown> | undefined;
      const ref = data?.clip as string | undefined;
      if (ref && (ref === guid || resolveRef(ref) === asset.path)) {
        useEditorStore.getState().setAnimatorRoot(e.id);
        break;
      }
    }
  }, [rootId, asset, nonce]);

  // ── Pose the bound entities at a given time (shared runtime sampler) ──
  const pose = useCallback((c: AnimationClipDef | null, t: number) => {
    if (!c || rootId == null) return;
    try {
      // applyClipAtTime writes trait values via bulk entity.set (bypassing
      // writeTraitField), so nothing marks the viewport/Inspector dirty. Signal
      // it ourselves — same as a gizmo drag — or the SceneView won't redraw and
      // preview playback looks frozen.
      const w = getCurrentWorld();
      // New deform epoch, then pose scalar tracks + deform channels — so a scrubbed
      // clip previews cloth/cape deformation exactly as it plays at runtime. (No-op
      // fast path for scalar-only clips.)
      beginDeform2DFrame();
      const applied = applyClipAtTime(w, rootId, c, t) + applyClipDeform(w, rootId, c, t);
      if (applied > 0) fireDirtyListeners();
    } catch (e) {
      // Most failures here are transient: a scene swap can leave `rootId` pointing at a
      // not-yet-resolvable entity for a frame. Don't crash the preview rAF — but DON'T
      // blanket-swallow either, or a genuine sampler regression manifests as a silently
      // frozen preview with no diagnostic. Log at debug so it's visible when looked for.
      console.debug('[AnimationEditor] pose failed (world not ready or sampler error)', e);
    }
  }, [rootId]);

  // ── Load the clip when the open target changes ──
  useEffect(() => {
    exitPreviewMode('animation'); // opening/switching a clip returns the global run-mode to stopped (drops a prior scrub)
    lastAction.current = null;
    lastGroup.current = undefined;
    setSel(new Set());
    setSelectedTracks(new Set());
    setViewport(DEFAULT_VIEWPORT);
    if (!asset) return;
    let cancelled = false;
    const existing = useEditorStore.getState().editingAnimationClip;
    if (existing) { savedMarkRef.current?.(existing); return; } // keep unsaved edits on re-mount
    const { loadAnimationClip } = useEditorStore.getState();
    fetch(asset.path)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((json) => {
        if (cancelled) return;
        const loaded = normalizeAnimationClip(json);
        if (!loaded.id) { loaded.id = newGuid(); registerAsset(loaded.id, asset.path, 'animation'); savedMarkRef.current?.(normalizeAnimationClip(json)); }
        else { registerAsset(loaded.id, asset.path, 'animation'); savedMarkRef.current?.(loaded); }
        loadAnimationClip(loaded);
      })
      .catch((e) => { if (cancelled) return; console.warn('[AnimationEditor] load failed, using default', e); const fb = defaultAnimationClip(newGuid(), asset.name); savedMarkRef.current?.(fb); loadAnimationClip(fb); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset?.path, nonce]);

  // ── Coalesced commit → global undo + applyAnimationClip + live pose ──
  const commit = useCallback((updater: (c: AnimationClipDef) => AnimationClipDef, group: string) => {
    const store = useEditorStore.getState();
    const cur = store.editingAnimationClip;
    const path = store.editingAnimationAsset?.path;
    if (!cur || !path) return;
    const next = updater(cur);
    if (next === cur) return;
    const now = performance.now();
    const act = lastAction.current;
    const coalesce = shouldCoalesce({
      hasLastAction: !!act, group, lastGroup: lastGroup.current, now, lastTime: lastTime.current,
      coalesceMs: COALESCE_MS, isTopOfUndoStack: peekUndo() === act, isExecutingUndoRedo: isExecutingUndoRedo(),
    });
    lastGroup.current = group;
    lastTime.current = now;
    if (coalesce && act) {
      act._after = next;
    } else {
      const before = cur;
      const a: ClipAction = {
        _after: next,
        label: `animation ${group.split(':')[0]}`,
        undo: () => { useEditorStore.getState().applyAnimationClip(path, before); poseLatest(before); },
        redo: () => { useEditorStore.getState().applyAnimationClip(path, a._after); poseLatest(a._after); },
      };
      pushAction(a);
      lastAction.current = a;
    }
    store.applyAnimationClip(path, next);
    pose(next, useEditorStore.getState().playheadTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pose]);

  // Pose helper that reads the current playhead (used by undo/redo closures).
  const poseLatest = useCallback((c: AnimationClipDef) => pose(c, useEditorStore.getState().playheadTime), [pose]);

  // Replace a single track's keys immutably.
  const mutateTrack = useCallback((trackIdx: number, fn: (t: AnimationTrack) => AnimationTrack, group: string) => {
    commit((c) => ({ ...c, tracks: c.tracks.map((t, i) => (i === trackIdx ? fn(t) : t)) }), group);
  }, [commit]);

  // ── Scrub / transport ──
  const scrub = useCallback((t: number) => {
    const cur = useEditorStore.getState().editingAnimationClip;
    const clamped = Math.max(0, Math.min(cur?.duration ?? t, t));
    useEditorStore.getState().setPlayhead(clamped);
    useEditorStore.getState().setPreviewPlaying(false);
    enterScrubMode('animation'); // clip scrub is a silent pose — carry the global run-mode (shared with the Timeline panel)
    pose(cur, clamped);
  }, [pose]);

  const stepFrame = useCallback((dir: 1 | -1) => {
    const cur = useEditorStore.getState().editingAnimationClip;
    const fr = cur?.frameRate ?? 60;
    const f = timeToFrame(useEditorStore.getState().playheadTime, fr) + dir;
    scrub(frameToTime(Math.max(0, f), fr));
  }, [scrub]);

  // Jump the playhead to the previous/next keyframe across all tracks.
  const jumpKey = useCallback((dir: 1 | -1) => {
    const cur = useEditorStore.getState().editingAnimationClip;
    if (!cur) return;
    const target = nextKeyTime(cur.tracks, useEditorStore.getState().playheadTime, dir);
    if (target !== undefined) scrub(target);
  }, [scrub]);

  // ── Preview playback loop ──
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const cur = useEditorStore.getState().editingAnimationClip;
      if (!cur) return;
      const t = advanceClipTime(useEditorStore.getState().playheadTime, dt, cur.duration, cur.loop);
      useEditorStore.getState().setPlayhead(t);
      pose(cur, t);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, pose]);

  // Panel gone → return the global run-mode to stopped (drops a scrub this panel left set). Empty
  // deps → runs only on real unmount. No-op during Play (exitPreviewMode guards it).
  useEffect(() => () => { exitPreviewMode('animation'); }, []);

  // ── Record hook: a field edit keys the clip at the playhead ──
  useEffect(() => {
    if (!recording) { setRecordHook(null); return; }
    setRecordHook((entityId, traitName, field, value) => {
      const store = useEditorStore.getState();
      const cur = store.editingAnimationClip;
      const root = store.animatorRootEntityId;
      if (!cur || root == null) return;
      const { byId } = getAnimEntityIndex();
      const path = relativeEntityPath(root, entityId, byId);
      if (path === null) {
        // Edited entity isn't under this clip's Animator root, so the clip can't
        // key it. Silently dropping the edit makes recording look broken — tell
        // the user why and how to fix it.
        const who = byId.get(entityId)?.name ?? `#${entityId}`;
        const rootName = byId.get(root)?.name ?? `#${root}`;
        console.warn(`[AnimationEditor] "${who}" is not under the Animator root "${rootName}" — edit not recorded. Move it under the Animator entity, or give it its own Animator, to animate it.`);
        setSaveMsg(`⚠ "${who}" isn't under "${rootName}" — not keyed`);
        return;
      }
      const existing = findTrack(cur.tracks, path, traitName, field);
      const type: TrackValueType = existing?.type ?? fieldTrackType(traitName, field);
      const v = encodeValue(type, value, fieldEnumOptions(traitName, field));
      const t = snapToFrame(store.playheadTime, cur.frameRate);
      // One gesture-scoped group (not per-field) so a free-move gizmo that writes
      // several fields (x/y/z) in immediate succession COALESCES into a single undo
      // entry instead of one per field. Per-field groups never coalesced because each
      // field's group differed from the one just before it. (A7)
      if (existing) {
        const idx = cur.tracks.indexOf(existing);
        mutateTrack(idx, (tr) => ({ ...tr, keys: upsertKey(tr.keys, t, v) }), 'record');
      } else {
        commit((c) => ({ ...c, tracks: [...c.tracks, { path, trait: traitName, field, type, keys: upsertKey([], t, v) }] }), 'record');
      }
    });
    return () => setRecordHook(null);
  }, [recording, commit, mutateTrack]);

  // ── Add Property (one or many) ──
  // The picker can select several fields and add them in a single commit (one undo).
  const addProperties = useCallback((cs: PropertyCandidate[]) => {
    setShowPicker(false);
    const store = useEditorStore.getState();
    const cur = store.editingAnimationClip;
    if (!cur || cs.length === 0) return;
    const t = snapToFrame(store.playheadTime, cur.frameRate);
    // Seed each new track with the entity's current value at the playhead (so the
    // track is visible and the pose is unchanged); dedup handled by planAddedTracks.
    const added = planAddedTracks(cur.tracks, cs, t, (c) => {
      const meta = getTraitByName(c.trait);
      const ent = findEntity(c.entityId);
      if (meta && ent) { const data = ent.get(meta.trait) as Record<string, unknown> | undefined; const raw = c.field.includes('.') ? getPath(data, c.field) : data?.[c.field]; return encodeValue(c.type, raw, fieldEnumOptions(c.trait, c.field)); }
      return 0;
    });
    if (added.length === 0) return;
    commit((cl) => ({ ...cl, tracks: [...cl.tracks, ...added] }), `add:${added.map((a) => a.field).join(',')}`);
  }, [commit]);

  // ── Toolbar / timeline callbacks ──
  const rename = useCallback((name: string) => commit((c) => ({ ...c, name }), 'name'), [commit]);
  const setFrameRate = useCallback((fps: number) => commit((c) => ({ ...c, frameRate: fps }), 'frameRate'), [commit]);
  const setDuration = useCallback((d: number) => commit((c) => ({ ...c, duration: d }), 'duration'), [commit]);
  const toggleLoop = useCallback(() => commit((c) => ({ ...c, loop: !c.loop }), 'loop'), [commit]);
  // Remap "ti:ki" key-selection ids after tracks are removed: drop ids on a removed
  // track, shift the rest down by how many removed tracks preceded them.
  const remapKeysAfterRemoval = useCallback((removed: Set<number>) => {
    setSel(remapSelectionAfterRemoval(selectedKeysRef.current, removed));
  }, [setSel]);

  // Select a track row: plain click = single; shift/cmd = toggle in the multi-set.
  // Selecting a property also selects the entity it animates in the Hierarchy (resolve
  // the track's path from the Animator root), so the gizmo/inspector follow the property
  // — no separate "select entity" button needed.
  const selectTrackAt = useCallback((i: number, additive: boolean) => {
    if (additive) {
      setSelectedTracks((prev) => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; });
      setSelectedTrack(i);
    } else {
      setSelectedTracks(new Set([i]));
      setSelectedTrack(i);
    }
    const cur = useEditorStore.getState().editingAnimationClip;
    const root = useEditorStore.getState().animatorRootEntityId;
    const tr = cur?.tracks[i];
    if (tr && root != null) {
      const entId = resolvePathToEntityId(getAnimEntityIndex(), root, tr.path);
      if (entId != null) useEditorStore.getState().selectEntity(entId);
    }
  }, []);

  const removeTrackIndices = useCallback((idx: Set<number>) => {
    if (!idx.size) return;
    commit((c) => ({ ...c, tracks: c.tracks.filter((_, k) => !idx.has(k)) }), `remove:${[...idx].join(',')}`);
    remapKeysAfterRemoval(idx);
    setSelectedTrack(null);
    setSelectedTracks(new Set());
  }, [commit, remapKeysAfterRemoval]);

  const removeTrack = useCallback((i: number) => removeTrackIndices(new Set([i])), [removeTrackIndices]);

  // Delete every selected property (multi-track) in one undo step.
  const removeSelectedTracks = useCallback(() => {
    const set = selectedTracks.size ? selectedTracks : (selectedTrack != null ? new Set([selectedTrack]) : new Set<number>());
    removeTrackIndices(set);
  }, [selectedTracks, selectedTrack, removeTrackIndices]);

  // Reorder tracks (drag-and-drop in the property list): move `from` → `to`,
  // remapping the primary/multi track selection and the key-selection ids to the
  // new indices so nothing jumps to a different property.
  const moveTrack = useCallback((from: number, to: number) => {
    if (from === to) return;
    const cur = useEditorStore.getState().editingAnimationClip;
    if (!cur || from < 0 || from >= cur.tracks.length) return;
    const clampedTo = Math.max(0, Math.min(cur.tracks.length - 1, to));
    if (from === clampedTo) return;
    const oldToNew = reorderPermutation(cur.tracks.length, from, clampedTo);
    // Rebuild tracks in the new order (invert oldToNew → newOrder[newIdx] = oldIdx).
    const newOrder: number[] = [];
    oldToNew.forEach((newIdx, oldIdx) => { newOrder[newIdx] = oldIdx; });
    commit((c) => ({ ...c, tracks: newOrder.map((oi) => c.tracks[oi]) }), `reorder:${from}->${clampedTo}`);
    // Remap all three selection channels through the permutation.
    setSel(remapSelectionAfterReorder(selectedKeysRef.current, oldToNew));
    setSelectedTracks((prev) => new Set([...prev].map((i) => oldToNew.get(i) ?? i)));
    setSelectedTrack((p) => (p == null ? p : oldToNew.get(p) ?? p));
  }, [commit, setSel]);
  const deleteKey = useCallback((ti: number, ki: number) => {
    mutateTrack(ti, (tr) => ({ ...tr, keys: tr.keys.filter((_, i) => i !== ki) }), `delkey:${ti}:${ki}`);
    setSel(remapSelectionAfterDelete(selectedKeysRef.current, ti, ki));
  }, [mutateTrack, setSel]);

  // Delete every selected key in one undo step (Delete/Backspace).
  const deleteSelectedKeys = useCallback(() => {
    const sel = selectedKeysRef.current;
    if (!sel.size) return;
    const byTrack = groupSelection(sel);
    commit((c) => ({ ...c, tracks: c.tracks.map((tr, ti) => { const ks = byTrack.get(ti); return ks ? { ...tr, keys: tr.keys.filter((_, ki) => !ks.has(ki)) } : tr; }) }), 'delkeys');
    setSel(new Set());
  }, [commit, setSel]);

  // Pointer-down on a key: update the multi-selection (shift/cmd toggles; plain
  // click on an unselected key selects only it, on a selected key keeps the group
  // so it can be dragged) and snapshot a frozen base for the group time-drag.
  // Returns true when more than one key ends up selected (caller picks group vs
  // single-key behavior). The grabbed key (ti,ki) anchors the drag delta.
  const keyMouseDown = useCallback((ti: number, ki: number, additive: boolean): boolean => {
    const id = `${ti}:${ki}`;
    const next = resolveKeySelection(selectedKeysRef.current, id, additive);
    setSel(next);
    setSelectedTrack(ti);
    const clip = useEditorStore.getState().editingAnimationClip;
    if (clip) {
      dragBaseRef.current = { clip, sel: selRefsFromIds(next, clip.tracks), grabT0: clip.tracks[ti]?.keys[ki]?.t ?? 0, lastDelta: NaN };
    }
    return next.size > 1;
  }, [setSel]);

  // Drag the selected group in time. `targetTime` is where the grabbed key should
  // land; every selected key shifts by the same frame-snapped delta. Rebuilt each
  // move from the frozen base (indices into it stay valid despite re-sorting), and
  // the global delta is clamped so the group stays within [0, duration], keeping
  // relative spacing. Selection ids are remapped to the keys' new sorted indices.
  const dragSelectedKeys = useCallback((targetTime: number) => {
    const base = dragBaseRef.current;
    if (!base || !base.sel.length) return;
    const { tracks, selected, delta } = moveKeysInTime(base.clip.tracks, base.sel, base.grabT0, targetTime, base.clip.frameRate, base.clip.duration);
    if (delta === base.lastDelta) return; // same frame → nothing to recommit
    base.lastDelta = delta;
    commit(() => ({ ...base.clip, tracks }), 'movekeys');
    setSel(new Set(selected));
  }, [commit, setSel]);

  const endKeyDrag = useCallback(() => { dragBaseRef.current = null; }, []);

  // Marquee box select from a view. `additive` (shift) unions with the current set.
  const marqueeSelect = useCallback((ids: string[], additive: boolean) => {
    setSel(additive ? new Set([...selectedKeysRef.current, ...ids]) : new Set(ids));
  }, [setSel]);
  // Curves view: merge a patch into one key (time clamped between neighbors so the
  // dragged index stays stable — no resort mid-drag).
  const editKey = useCallback((ti: number, ki: number, patch: Partial<Keyframe>) => mutateTrack(ti, (tr) => {
    const keys = tr.keys.map((kk, i) => {
      if (i !== ki) return kk;
      const merged = { ...kk, ...patch };
      // Clamp to the clip duration too (default max is +Infinity), so the numeric
      // frame field can't push the last key past the end where it's unreachable in
      // preview — consistent with the Curves key drag. (A4)
      if (patch.t !== undefined) merged.t = clampKeyTime(tr.keys, ki, merged.t, useEditorStore.getState().editingAnimationClip?.duration ?? Number.POSITIVE_INFINITY);
      return merged;
    });
    return { ...tr, keys };
  }, `editkey:${ti}:${ki}`), [mutateTrack]);
  const setTangentMode = useCallback((ti: number, ki: number, mode: TangentMode) => mutateTrack(ti, (tr) => {
    const keys = tr.keys.map((k) => ({ ...k }));
    applyTangentMode(keys, ki, mode);
    return { ...tr, keys };
  }, `tangent:${ti}:${ki}`), [mutateTrack]);

  // Group the current key selection as track-index → key-index set (shared by the
  // break/copy/nudge-value multi-key ops below).
  const selectionByTrack = useCallback((): Map<number, Set<number>> => groupSelection(selectedKeysRef.current), []);

  // ── Break / unify tangents on the selected keys (B, or the toolbar button) ──
  // Toggles: if ANY selected key is still unified, break them all; otherwise unify
  // (mirror the out-tangent to the in-tangent). Surfaces the existing per-key
  // right-click "Free (broken)" as a multi-key, discoverable action.
  const toggleBreakSelected = useCallback(() => {
    const byTrack = selectionByTrack();
    if (!byTrack.size) return;
    commit((c) => ({ ...c, tracks: applyBreakUnify(c.tracks, byTrack) }), 'break-tangents');
  }, [commit, selectionByTrack]);

  // ── Copy / paste keyframes (Cmd/Ctrl+C → V) ──
  const copyKeys = useCallback(() => {
    const byTrack = selectionByTrack();
    const cur = useEditorStore.getState().editingAnimationClip;
    if (!cur || !byTrack.size) return;
    const cb = extractKeyBlock(cur, byTrack);
    if (!cb) return;
    clipboardRef.current = cb;
    setHasClipboard(true);
    const n = [...byTrack.values()].reduce((s, kis) => s + kis.size, 0);
    setSaveMsg(`Copied ${n} key${n > 1 ? 's' : ''}`);
  }, [selectionByTrack]);

  const pasteKeys = useCallback(() => {
    const cb = clipboardRef.current;
    const cur = useEditorStore.getState().editingAnimationClip;
    if (!cb || !cur) return;
    const plan = planPaste(cur, cb, { minGapFrames: PASTE_MIN_GAP_FRAMES, gapMarginFrames: PASTE_GAP_MARGIN_FRAMES });
    commit((c) => ({ ...c, duration: Math.max(c.duration, plan.duration), tracks: plan.tracks }), 'paste');
    setSel(new Set(plan.selection));
    setSaveMsg(`Pasted ${cb.tracks.reduce((s, t) => s + t.keys.length, 0)} key(s) after original`);
  }, [commit, setSel]);

  // ── Duplicate the selected keys in one step (Cmd/Ctrl+D + toolbar button) ──
  // Like copy→paste but without touching the clipboard (Cmd+D shouldn't clobber your
  // copy buffer). Places the copy after the original with the same collision-avoiding
  // placement as paste; one undo; the duplicates end up selected.
  const duplicateSelectedKeys = useCallback(() => {
    const cur = useEditorStore.getState().editingAnimationClip;
    const byTrack = selectionByTrack();
    if (!cur || !byTrack.size) return;
    const cb = extractKeyBlock(cur, byTrack);
    if (!cb) return;
    const plan = planPaste(cur, cb, { minGapFrames: PASTE_MIN_GAP_FRAMES, gapMarginFrames: PASTE_GAP_MARGIN_FRAMES });
    commit((c) => ({ ...c, duration: Math.max(c.duration, plan.duration), tracks: plan.tracks }), 'duplicate');
    setSel(new Set(plan.selection));
    setSaveMsg(`Duplicated ${cb.tracks.reduce((s, t) => s + t.keys.length, 0)} key(s)`);
  }, [commit, selectionByTrack, setSel]);

  // ── Keyboard nudge of the selected keys (arrows) ──
  const nudgeSelectedKeys = useCallback((frames: number) => {
    const cur = useEditorStore.getState().editingAnimationClip;
    if (!cur || !selectedKeysRef.current.size) return;
    const sel = selRefsFromIds(selectedKeysRef.current, cur.tracks);
    if (!sel.length) return;
    const dt = frames / (cur.frameRate || 60);
    const { tracks, selected } = moveKeysInTime(cur.tracks, sel, 0, dt, cur.frameRate, cur.duration);
    commit(() => ({ ...cur, tracks }), 'nudge');
    setSel(new Set(selected));
  }, [commit, setSel]);

  const nudgeValueSelected = useCallback((dv: number) => {
    const byTrack = selectionByTrack();
    if (!byTrack.size) return;
    commit((c) => ({ ...c, tracks: applyValueNudge(c.tracks, byTrack, dv) }), 'nudge-value');
  }, [commit, selectionByTrack]);
  // Read a track's CURRENT value off the bound entity (captures a manual move
  // done in the viewport/Inspector). Returns null when the entity/trait can't be
  // resolved, so callers can fall back to a curve-sampled value.
  const liveTrackValue = useCallback((tr: AnimationTrack): number | null => {
    const root = useEditorStore.getState().animatorRootEntityId;
    if (root == null) return null;
    const meta = getTraitByName(tr.trait);
    const entId = resolvePathToEntityId(getAnimEntityIndex(), root, tr.path);
    if (!meta || entId == null) return null;
    const data = findEntity(entId)?.get(meta.trait) as Record<string, unknown> | undefined;
    if (!data) return null;
    const raw = tr.field.includes('.') ? getPath(data, tr.field) : data[tr.field];
    return encodeValue(tr.type, raw, fieldEnumOptions(tr.trait, tr.field));
  }, []);

  // Double-click-add-key: prefer the bound entity's live value so keying after a
  // manual move captures it (matches ◆+ addKeyAll), not the curve-sampled value
  // (which would re-pose the object back and discard the move). `value` is the
  // DopesheetView curve sample, used only as a fallback when unbound.
  const addKey = useCallback((ti: number, t: number, value: number) => mutateTrack(ti, (tr) => ({ ...tr, keys: upsertKey(tr.keys, snapToFrame(t, useEditorStore.getState().editingAnimationClip?.frameRate ?? 60), liveTrackValue(tr) ?? value) }), `addkey:${ti}`), [mutateTrack, liveTrackValue]);

  // Add a key at the playhead for every track (toolbar ◆+).
  const addKeyAll = useCallback(() => {
    const cur = useEditorStore.getState().editingAnimationClip;
    if (!cur || rootId == null) return;
    const t = snapToFrame(useEditorStore.getState().playheadTime, cur.frameRate);
    commit((c) => ({
      ...c,
      // Sample the bound entity's current value (so a manual key captures the live pose).
      tracks: c.tracks.map((tr) => ({ ...tr, keys: upsertKey(tr.keys, t, liveTrackValue(tr) ?? (tr.keys.length ? tr.keys[tr.keys.length - 1].v : 0)) })),
    }), 'addkey-all');
  }, [commit, rootId, liveTrackValue]);

  // ── Selected-key numeric editing (value + frame fields in the property column) ──
  // The value/frame fields edit a single key, so they act only when exactly one
  // key is selected (multi-select shows a count instead).
  // Memoized (deps: selectedKeys) so it — and the setKeyValue/setKeyFrame/selKeyInfo
  // that derive from it — keep a stable identity across playhead-only re-renders,
  // letting the React.memo'd children skip re-render during preview playback. (B2)
  const primaryKey = useMemo(() => {
    if (selectedKeys.size !== 1) return null;
    const [ti, ki] = [...selectedKeys][0].split(':').map(Number);
    return { ti, ki };
  }, [selectedKeys]);
  const setKeyValue = useCallback((v: number) => { if (primaryKey) editKey(primaryKey.ti, primaryKey.ki, { v }); }, [editKey, primaryKey]);
  const setKeyFrame = useCallback((frame: number) => {
    if (!primaryKey) return;
    const fr = useEditorStore.getState().editingAnimationClip?.frameRate ?? 60;
    editKey(primaryKey.ti, primaryKey.ki, { t: frameToTime(Math.max(0, Math.round(frame)), fr) });
  }, [editKey, primaryKey]);

  // ── Selected-PROPERTY value editing (shown when no key is selected) ──
  // Edit the selected track's value at the playhead: upsertKey updates the key
  // there, or adds one if none exists — so typing a value keys the property (like
  // Unity's animation window). One key op ⇒ one undo; commit re-poses the scene.
  const setPropValue = useCallback((v: number) => {
    const cur = useEditorStore.getState().editingAnimationClip;
    if (!cur || selectedTrack == null) return;
    const t = snapToFrame(useEditorStore.getState().playheadTime, cur.frameRate);
    mutateTrack(selectedTrack, (tr) => ({ ...tr, keys: upsertKey(tr.keys, t, v) }), `setval:${selectedTrack}`);
  }, [mutateTrack, selectedTrack]);

  // Track which panel was last clicked: this panel is "active" while a pointerdown lands
  // inside it, and yields the moment one lands elsewhere (so other panels keep Delete/dup).
  useEffect(() => {
    const onDown = (e: PointerEvent) => { activeRef.current = !!rootRef.current?.contains(e.target as Node); };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, []);

  // ── Keyboard shortcuts (scoped to the engaged panel; never steals input keys) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hoverRef.current && !activeRef.current) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (!useEditorStore.getState().editingAnimationClip) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); copyKeys(); }
      else if (mod && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); pasteKeys(); }
      else if (e.key === ',' && !e.altKey) { e.preventDefault(); stepFrame(-1); }
      else if (e.key === '.' && !e.altKey) { e.preventDefault(); stepFrame(1); }
      else if (e.key === ',' && e.altKey) { e.preventDefault(); jumpKey(-1); }
      else if (e.key === '.' && e.altKey) { e.preventDefault(); jumpKey(1); }
      // Arrow keys — context-dependent: nudge the selected keys by a frame when keys
      // are selected, else scrub the playhead. Shift = ×10. Up/Down nudge the key
      // value (curve editing).
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        const step = e.shiftKey ? 10 : 1;
        if (selectedKeysRef.current.size) nudgeSelectedKeys(dir * step);
        else { const s = useEditorStore.getState(); const fr = s.editingAnimationClip?.frameRate ?? 60; const f = timeToFrame(s.playheadTime, fr) + dir * step; scrub(frameToTime(Math.max(0, f), fr)); }
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && selectedKeysRef.current.size) {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        nudgeValueSelected(dir * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1));
      } else if (e.code === 'Space') { e.preventDefault(); const s = useEditorStore.getState(); s.setPreviewPlaying(!s.isPreviewPlaying); }
      else if (e.key === 'k' || e.key === 'K') { e.preventDefault(); addKeyAll(); }
      else if ((e.key === 'b' || e.key === 'B') && selectedKeysRef.current.size) { e.preventDefault(); toggleBreakSelected(); }
      else if ((e.key === 'Home' || e.key === '0')) { e.preventDefault(); setViewport(DEFAULT_VIEWPORT); }
      else if ((e.key === 'Delete' || e.key === 'Backspace')) {
        // Only claim Delete when we actually have something to delete — otherwise yield
        // (don't preventDefault) so an entity/track Delete in another context still works.
        if (selectedKeysRef.current.size) { e.preventDefault(); deleteSelectedKeys(); }
        else if (selectedTracks.size || selectedTrack != null) { e.preventDefault(); removeSelectedTracks(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [stepFrame, jumpKey, addKeyAll, deleteSelectedKeys, scrub, copyKeys, pasteKeys, nudgeSelectedKeys, nudgeValueSelected, toggleBreakSelected, removeSelectedTracks, selectedTracks, selectedTrack]);

  // Cmd/Ctrl+D → duplicate the selected keys. Cmd+D is ALSO owned by the Hierarchy
  // (entity dup) + Assets (asset dup) as document keydowns, so we CANNOT make it an
  // Electron menu accelerator (that would swallow it globally — the Cmd+C/V trap).
  // Instead: a CAPTURE-phase listener that runs before their bubble-phase handlers and
  // CLAIMS the key (preventDefault + stopImmediatePropagation) only when the pointer is
  // over this panel AND keys are selected — otherwise it yields so entity/asset dup
  // still works. Mirrors how each panel owns Cmd+D in its own context.
  useEffect(() => {
    const onKeyCapture = (e: KeyboardEvent) => {
      if (!hoverRef.current && !activeRef.current) return;
      if (!((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D'))) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (!useEditorStore.getState().editingAnimationClip || !selectedKeysRef.current.size) return; // yield → entity/asset dup
      e.preventDefault();
      e.stopImmediatePropagation();
      duplicateSelectedKeys();
    };
    document.addEventListener('keydown', onKeyCapture, true); // capture: beat the bubble-phase panel listeners
    return () => document.removeEventListener('keydown', onKeyCapture, true);
  }, [duplicateSelectedKeys]);

  // ── Debounced auto-save ──
  const writeClip = useCallback((c: AnimationClipDef): Promise<boolean> => {
    const path = asset?.path;
    if (!path) return Promise.resolve(false);
    setSaveMsg('Saving…');
    return backendFetch('/api/write-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content: JSON.stringify(c, null, 2) }),
    }).then((res) => { setSaveMsg(res.ok ? 'Saved ✓' : `Save failed (${res.status})`); return res.ok; })
      .catch((e) => { console.error('[AnimationEditor] auto-save failed', e); setSaveMsg('Save failed'); return false; });
  }, [asset?.path]);
  const { markSaved } = useDebouncedSave(clip, writeClip, AUTOSAVE_MS);
  savedMarkRef.current = markSaved;

  const existingKeys = useMemo(
    () => (clip ? new Set(clip.tracks.map(trackKey)) : new Set<string>()),
    [clip],
  );

  // Resolve the selected key to its live value/frame for the property-column fields.
  // Returns null if the selection is stale (track/key removed) so the field hides.
  // Memoized (deps clip+primaryKey) so TrackList's `selKey` prop is stable across
  // playhead-only re-renders (B2).
  const selKeyInfo = useMemo(() => {
    if (!clip || !primaryKey) return null;
    const tr = clip.tracks[primaryKey.ti];
    const k = tr?.keys[primaryKey.ki];
    if (!tr || !k) return null;
    return {
      type: tr.type, value: k.v, frame: timeToFrame(k.t, clip.frameRate),
      label: `${tr.trait}.${tr.field}`,
      options: tr.type === 'enum' ? fieldEnumOptions(tr.trait, tr.field) : undefined,
    };
  }, [clip, primaryKey]);

  // Value of the SELECTED PROPERTY at the playhead — shown (and editable) when no key
  // is selected, so a property always displays its current value. Show the CLIP's
  // sampled value at the playhead (the animated value at the current time — matches the
  // curve/pose regardless of whether the entity is live-posed right now); fall back to
  // the bound entity's live value only for an empty track (no keys to sample). Depends
  // on `playhead` so it tracks the scrub; null unless exactly one track is selected with
  // no key selected. (B2: re-renders TrackList on scrub only while a property is selected.)
  const propValInfo = useMemo(() => {
    if (!clip || selectedTrack == null || selectedKeys.size > 0) return null;
    const tr = clip.tracks[selectedTrack];
    if (!tr) return null;
    // Type-aware sample: color lerps per-channel, boolean/enum step. `evalTrack`
    // (numeric-only) would show a garbage swatch / half-checked box / fractional
    // enum for non-number tracks and commit that wrong value as a key.
    const v = tr.keys.length ? evalTrackValue(tr, playhead) : (liveTrackValue(tr) ?? 0);
    return {
      type: tr.type, value: v, frame: timeToFrame(playhead, clip.frameRate),
      label: `${tr.trait}.${tr.field}`,
      options: tr.type === 'enum' ? fieldEnumOptions(tr.trait, tr.field) : undefined,
    };
  }, [clip, selectedTrack, selectedKeys, playhead, liveTrackValue]);

  // Create a new clip via the native Save dialog, bind to the selected Animator if any.
  const newClip = useCallback(async () => {
    const path = await saveAssetDialog({ defaultName: 'New Animation.anim.json', ext: '.anim.json', prompt: 'Create Animation Clip' });
    if (!path) return;
    const guid = newGuid();
    const name = (path.split('/').pop() || 'Clip').replace(/\.anim\.json$/i, '');
    const ok = await backendFetch('/api/write-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, content: JSON.stringify(defaultAnimationClip(guid, name), null, 2) }) }).then((r) => r.ok).catch(() => false);
    if (!ok) return;
    registerAsset(guid, path, 'animation');
    const sel = useEditorStore.getState().selectedEntityId;
    const animMeta = getTraitByName('Animator');
    const ent = sel != null ? findEntity(sel) : null;
    const rootId = ent && animMeta && ent.has(animMeta.trait) ? sel : null;
    useEditorStore.getState().openAnimationEditor({ path, type: 'animation', name }, rootId);
  }, []);

  if (!asset) {
    return (
      <div style={{ ...wrap, alignItems: 'center', justifyContent: 'center', gap: 12, flexDirection: 'column', color: '#556' }}>
        <div>Double-click a .anim.json in Assets to edit (select its Animator entity first to bind).</div>
        <button title="Create a new .anim.json clip (binds to the selected Animator entity)" onClick={newClip} style={{ background: '#2a2a40', color: '#cdd', border: '1px solid #444', borderRadius: 4, padding: '6px 14px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12 }}>+ New Animation</button>
      </div>
    );
  }

  return (
    <div ref={rootRef} style={wrap} onPointerEnter={() => { hoverRef.current = true; }} onPointerLeave={() => { hoverRef.current = false; }}>
      {clip && (
        <AnimationToolbar
          clipName={clip.name} onRename={rename}
          frameRate={clip.frameRate} onSetFrameRate={setFrameRate}
          duration={clip.duration} onSetDuration={setDuration}
          loop={clip.loop} onToggleLoop={toggleLoop}
          playing={playing} onTogglePlay={() => useEditorStore.getState().setPreviewPlaying(!playing)}
          onStop={() => scrub(0)}
          recording={recording} onToggleRecord={() => useEditorStore.getState().setRecording(!recording)}
          playhead={playhead} onScrub={scrub}
          onPrevFrame={() => stepFrame(-1)} onNextFrame={() => stepFrame(1)}
          onAddKey={addKeyAll}
          onBreakTangents={toggleBreakSelected} canBreakTangents={selectedKeys.size > 0}
          onCopyKeys={copyKeys} canCopyKeys={selectedKeys.size > 0}
          onPasteKeys={pasteKeys} canPasteKeys={hasClipboard}
          onDuplicateKeys={duplicateSelectedKeys} canDuplicateKeys={selectedKeys.size > 0}
          onUndo={() => gUndo()} onRedo={() => gRedo()}
          saveMsg={saveMsg}
        />
      )}
      {rootId == null && (
        <div style={{ padding: 6, fontSize: 11, color: '#e0a030', background: '#2a2418', borderBottom: '1px solid #333' }}>
          No Animator bound. Select an entity with an Animator component and reopen this clip to author tracks.
        </div>
      )}
      {selectedOutsideRoot && (
        <div style={{ padding: 6, fontSize: 11, color: '#e0a030', background: '#2a2418', borderBottom: '1px solid #333' }}>
          ⚠ “{selectedOutsideRoot.who}” isn’t under the Animator “{selectedOutsideRoot.root}” — edits to it won’t record. Animate a descendant of “{selectedOutsideRoot.root}”, or give “{selectedOutsideRoot.who}” its own Animator.
        </div>
      )}
      {clip && (
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <TrackList
            tracks={clip.tracks}
            width={trackListW}
            selected={selectedTrack}
            selectedTracks={selectedTracks}
            onSelect={selectTrackAt}
            onRemove={removeTrack}
            onReorder={moveTrack}
            onAddProperty={() => setShowPicker(true)}
            viewMode={viewMode}
            onSetViewMode={setViewMode}
            selKey={selKeyInfo}
            selCount={selectedKeys.size}
            onSetKeyValue={setKeyValue}
            onSetKeyFrame={setKeyFrame}
            propVal={propValInfo}
            onSetPropValue={setPropValue}
          />
          {/* Draggable divider between the property list and the timeline. */}
          <div
            onPointerDown={startResize}
            style={{ width: 5, flexShrink: 0, cursor: 'col-resize', background: '#333', alignSelf: 'stretch' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#4a4a6a'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#333'; }}
          />
          {viewMode === 'dopesheet' ? (
            <DopesheetView
              tracks={clip.tracks}
              duration={clip.duration}
              frameRate={clip.frameRate}
              selectedTrack={selectedTrack}
              selectedKeys={selectedKeys}
              viewport={viewport}
              onViewport={setViewport}
              onKeyMouseDown={keyMouseDown}
              onDragSelectedKeys={dragSelectedKeys}
              onEndKeyDrag={endKeyDrag}
              onMarqueeSelect={marqueeSelect}
              onScrub={scrub}
              onDeleteKey={deleteKey}
              onAddKey={addKey}
            />
          ) : (
            <CurvesView
              tracks={clip.tracks}
              duration={clip.duration}
              frameRate={clip.frameRate}
              selectedTrack={selectedTrack}
              selectedTracks={selectedTracks}
              selectedKeys={selectedKeys}
              viewport={viewport}
              onViewport={setViewport}
              onKeyMouseDown={keyMouseDown}
              onDragSelectedKeys={dragSelectedKeys}
              onEndKeyDrag={endKeyDrag}
              onMarqueeSelect={marqueeSelect}
              onScrub={scrub}
              onEditKey={editKey}
              onDeleteKey={deleteKey}
              onAddKey={addKey}
              onSetTangentMode={setTangentMode}
            />
          )}
        </div>
      )}
      {showPicker && rootId != null && (
        <AddPropertyPicker rootId={rootId} existing={existingKeys} onAdd={addProperties} onClose={() => setShowPicker(false)} />
      )}
    </div>
  );
}

/** Track value type from a trait field hint (fallback for a not-yet-tracked field). */
function fieldTrackType(traitName: string, field: string): TrackValueType {
  const hint = getTraitByName(traitName)?.fields[field];
  if (hint?.type === 'color') return 'color';
  if (hint?.type === 'boolean') return 'boolean';
  if (hint?.type === 'enum' && hint.options?.length) return 'enum';
  return 'number';
}

/** Static option list for an enum field (used to encode string→index and to
 *  render the selected-key dropdown). Undefined for non-enum / dynamic enums. */
function fieldEnumOptions(traitName: string, field: string): string[] | undefined {
  const hint = getTraitByName(traitName)?.fields[field];
  return hint?.type === 'enum' ? hint.options : undefined;
}

const wrap: React.CSSProperties = { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#14141d', fontFamily: 'monospace', fontSize: 12, color: '#ccc' };
