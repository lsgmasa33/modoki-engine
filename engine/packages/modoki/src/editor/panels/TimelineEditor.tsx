/** Timeline Editor panel — a Unity-Timeline-style sequencer surface for `.timeline.json` assets.
 *  Top: transport + duration/fps/loop + a compact inspector for the selected clip/marker. Left:
 *  the track lane list (type/target/mute). Right: the clip track body (bars + marker diamonds +
 *  scrub playhead). Retargets to the selected Director; scrubbing poses the bound subtree live.
 *
 *  Architecture mirrors AnimationEditor: the live timeline doc is the single source of truth in the
 *  editor store, so the GLOBAL undo stack applies edits even when this panel is unfocused. Edits
 *  coalesce per group; persistence is a debounced validated /api/asset-write. */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { backendFetch } from '../backend/editorBackend';
import { useEditorStore } from '../store/editorStore';
import { register } from '../input/keymap';
import { useHmrEpoch } from '../input/hmrEpoch';
import { getCurrentWorld, onWorldSwap } from '../../runtime/ecs/world';
import { resolveDirectorRootForTimeline } from './openAssetInEditor';
import { fireDirtyListeners, findEntity } from '../../runtime/ecs/entityUtils';
import { Director } from '../../runtime/traits/Director';
import { newGuid, registerAsset, getAllAssets } from '../../runtime/loaders/assetManifest';
import { getUIActionNames } from '../../runtime/ui/actionRegistry';
import { advanceClipTime } from '../../runtime/animation/sampleClip';
import { previewTimelineAt, previewTimelineStep, previewControlAt, clearPreviewControls } from '../../runtime/systems/timelineSystem';
import {
  beginTimelinePreviewSession, endTimelinePreviewSession, hasTimelinePreviewSession, setTimelinePreviewActive,
} from '../scene/timelinePreview';
import { enterScrubMode, enterPreviewMode, exitPreviewMode } from '../scene/playMode';
import { getRunMode, isAdvancing, onRunModeChange } from '../../runtime/systems/playState';
import {
  defaultTimeline, normalizeTimeline,
  type TimelineDef, type TrackDef, type TrackKind,
} from '../../runtime/timeline/types';
import { useDebouncedSave } from './useDebouncedSave';
import { pushAction, peekUndo, isExecutingUndoRedo, type UndoAction } from '../undo/undoManager';
import { shouldCoalesce } from '../animation/undoCoalesce';
import { DEFAULT_VIEWPORT, type Viewport } from './animation/timelineMath';
import TrackLaneList from './timeline/TrackLaneList';
import ClipTrackView from './timeline/ClipTrackView';
import ItemInspector from './timeline/ItemInspector';
import { withAddedItem, withMovedItem, withUpdatedItem, withDeletedItem, itemCount, type TrackItemPatch } from './timeline/itemEdit';

const COALESCE_MS = 500;
const AUTOSAVE_MS = 400;
const TRACK_LIST_W = 190;
const INSPECTOR_W = 232; // default; user-resizable (persisted) — see inspectorW state
const INSPECTOR_MIN_W = 180;
const INSPECTOR_MAX_W = 620;
type TLAction = UndoAction & { _after: TimelineDef };

/** A fresh empty track of the given kind, with a minted id. */
function newTrack(kind: TrackKind): TrackDef {
  const base = { id: newGuid(), name: kind, target: '' };
  switch (kind) {
    case 'animation': return { ...base, type: 'animation', clips: [] };
    case 'signal': return { ...base, type: 'signal', markers: [] };
    case 'audio': return { ...base, type: 'audio', cues: [] };
    case 'activation': return { ...base, type: 'activation', spans: [] };
    case 'control': return { ...base, type: 'control', clips: [] };
  }
}

const inputStyle: React.CSSProperties = { width: 60, background: '#191919', border: '1px solid #333', color: '#cfcfd6', fontSize: 11, padding: '2px 4px', borderRadius: 2 };
const btn: React.CSSProperties = { fontSize: 11, background: '#2a2a31', border: '1px solid #3a3a42', color: '#cfcfd6', borderRadius: 3, padding: '3px 8px', cursor: 'pointer' };

export default function TimelineEditor() {
  const hmrEpoch = useHmrEpoch();
  const asset = useEditorStore((s) => s.editingTimelineAsset);
  const nonce = useEditorStore((s) => s.timelineEditNonce);
  const doc = useEditorStore((s) => s.editingTimelineDoc);
  const rootId = useEditorStore((s) => s.directorRootEntityId);
  const playhead = useEditorStore((s) => s.playheadTime);
  const playing = useEditorStore((s) => s.isPreviewPlaying);
  // Reactive run-mode for the transport (status text + Exit-Preview button visibility). scrub and
  // preview are the two states of the preview-session envelope; stopped = editing.
  const runMode = useSyncExternalStore(onRunModeChange, getRunMode);
  const advancing = useSyncExternalStore(onRunModeChange, isAdvancing);
  const inPreview = runMode === 'scrub' || runMode === 'preview';

  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEWPORT);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(null);
  const [selectedItem, setSelectedItem] = useState<number | null>(null);
  const [saveMsg, setSaveMsg] = useState('');

  // Resizable right-side inspector dock (persisted across reloads). The divider sits to the LEFT of
  // the dock, so dragging it left WIDENS the inspector (startW grows as clientX decreases).
  const [inspectorW, setInspectorW] = useState<number>(() => {
    try { const v = Number(localStorage.getItem('modoki.timeline.inspectorW')); if (v >= INSPECTOR_MIN_W && v <= INSPECTOR_MAX_W) return v; } catch { /* no localStorage */ }
    return INSPECTOR_W;
  });
  const inspectorWRef = useRef(inspectorW); inspectorWRef.current = inspectorW;
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const r = resizeRef.current; if (!r) return;
      setInspectorW(Math.max(INSPECTOR_MIN_W, Math.min(INSPECTOR_MAX_W, r.startW + (r.startX - e.clientX))));
    };
    const up = () => {
      if (!resizeRef.current) return;
      resizeRef.current = null;
      document.body.style.userSelect = '';
      try { localStorage.setItem('modoki.timeline.inspectorW', String(Math.round(inspectorWRef.current))); } catch { /* ignore */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, []);
  const startInspectorResize = useCallback((e: React.PointerEvent) => {
    resizeRef.current = { startX: e.clientX, startW: inspectorWRef.current };
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }, []);

  const lastAction = useRef<TLAction | null>(null);
  const lastGroup = useRef<string | undefined>(undefined);
  const lastTime = useRef(0);
  const savedMarkRef = useRef<((d: TimelineDef) => void) | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The live preview loop's rAF id, held in a ref so scrub()/exit can stop the loop + close the audio/
  // dispatch gates SYNCHRONOUSLY. Relying on the preview effect's cleanup alone lets one already-
  // scheduled tick fire (React defers the cleanup), advancing the playhead past the grab point (C7).
  const previewRafRef = useRef(0);
  const stopPreviewLoop = useCallback(() => {
    cancelAnimationFrame(previewRafRef.current);
    previewRafRef.current = 0;
    setTimelinePreviewActive(false); // close audio + dispatch gates now, not after the deferred cleanup
  }, []);

  // ── Pose the bound subtree at time t (state + keyframe sample), then repaint. ──
  const pose = useCallback((d: TimelineDef | null, t: number) => {
    if (!d || rootId == null) return;
    try {
      previewTimelineAt(getCurrentWorld(), rootId, d, t);
      previewControlAt(getCurrentWorld(), rootId, d, t); // control-track prefab presence (span containment)
      fireDirtyListeners();
    } catch (e) {
      console.debug('[TimelineEditor] pose failed (world not ready)', e);
    }
  }, [rootId]);
  const poseLatest = useCallback((d: TimelineDef) => pose(d, useEditorStore.getState().playheadTime), [pose]);

  // ── Load the doc when the open target changes ──
  useEffect(() => {
    // A preview session from a PREVIOUS target still held (previewed → closed / switched asset
    // without scrubbing) — revert its world mutations before (re)loading. The reload leaves
    // asset.path/nonce unchanged, so it doesn't re-trigger this effect. On first open no session
    // is held, so this is a no-op.
    clearPreviewControls(); // drop any control-prefab a scrub of the PREVIOUS timeline left spawned
    if (hasTimelinePreviewSession()) void endTimelinePreviewSession({ restore: true });
    exitPreviewMode('timeline'); // opening/switching a timeline returns to stopped (any prior scrub/preview ended above)
    lastAction.current = null;
    lastGroup.current = undefined;
    setSelectedTrack(null);
    setSelectedItem(null);
    setViewport(DEFAULT_VIEWPORT);
    if (!asset) return;
    let cancelled = false;
    const existing = useEditorStore.getState().editingTimelineDoc;
    if (existing) { savedMarkRef.current?.(existing); return; } // keep unsaved edits on re-mount
    const { loadTimelineDoc } = useEditorStore.getState();
    fetch(asset.path)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((json) => {
        if (cancelled) return;
        const loaded = normalizeTimeline(json);
        if (!loaded.id) loaded.id = newGuid();
        registerAsset(loaded.id, asset.path, 'timeline');
        savedMarkRef.current?.(loaded);
        loadTimelineDoc(loaded);
      })
      .catch((e) => { if (cancelled) return; console.warn('[TimelineEditor] load failed, using default', e); const fb = defaultTimeline(newGuid(), asset.name); savedMarkRef.current?.(fb); loadTimelineDoc(fb); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset?.path, nonce]);

  // ── Coalesced commit → global undo + applyTimelineDoc + live pose ──
  const commit = useCallback((updater: (d: TimelineDef) => TimelineDef, group: string) => {
    const store = useEditorStore.getState();
    const cur = store.editingTimelineDoc;
    const path = store.editingTimelineAsset?.path;
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
      const a: TLAction = {
        _after: next,
        label: `timeline ${group.split(':')[0]}`,
        undo: () => { useEditorStore.getState().applyTimelineDoc(path, before); poseLatest(before); },
        redo: () => { useEditorStore.getState().applyTimelineDoc(path, a._after); poseLatest(a._after); },
      };
      pushAction(a);
      lastAction.current = a;
    }
    store.applyTimelineDoc(path, next);
    pose(next, useEditorStore.getState().playheadTime);
  }, [pose, poseLatest]);

  const mutateTrack = useCallback((i: number, fn: (t: TrackDef) => TrackDef, group: string) => {
    commit((d) => ({ ...d, tracks: d.tracks.map((t, j) => (j === i ? fn(t) : t)) }), group);
  }, [commit]);

  // Stable handlers so the memo'd ClipTrackView / TrackLaneList don't re-render every preview
  // frame (TimelineEditor itself re-renders ~60fps during playback via the playhead subscription).
  const onMoveItem = useCallback((ti: number, ii: number, t: number) => mutateTrack(ti, (tr) => withMovedItem(tr, ii, t), `move:${ti}:${ii}`), [mutateTrack]);
  const onSetTarget = useCallback((i: number, target: string) => mutateTrack(i, (t) => ({ ...t, target }), `target:${i}`), [mutateTrack]);
  const onToggleMute = useCallback((i: number) => mutateTrack(i, (t) => ({ ...t, muted: !t.muted }), `mute:${i}`), [mutateTrack]);
  const onRemoveTrack = useCallback((i: number) => { commit((d) => ({ ...d, tracks: d.tracks.filter((_, j) => j !== i) }), 'remove-track'); setSelectedTrack(null); setSelectedItem(null); }, [commit]);
  const onAddTrack = useCallback((kind: TrackKind) => commit((d) => ({ ...d, tracks: [...d.tracks, newTrack(kind)] }), 'add-track'), [commit]);

  // ── Selection (lane click clears the item; item click / drag selects both) ──
  const selectTrack = useCallback((i: number) => { setSelectedTrack(i); setSelectedItem(null); }, []);
  const selectItem = useCallback((ti: number, ii: number) => { setSelectedTrack(ti); setSelectedItem(ii); }, []);

  // ── Selected-item value editing (Phase 4 inspector) ──
  const onEditItem = useCallback((patch: TrackItemPatch, field: string) => {
    if (selectedTrack == null || selectedItem == null) return;
    mutateTrack(selectedTrack, (tr) => withUpdatedItem(tr, selectedItem, patch), `edititem:${selectedTrack}:${selectedItem}:${field}`);
  }, [mutateTrack, selectedTrack, selectedItem]);
  // Add an item at time t (appended → selected for immediate editing). Shared by the toolbar
  // "+ item @ playhead" button and ClipTrackView's double-click-empty-lane-to-add.
  const addItemAt = useCallback((ti: number, t: number) => {
    const cur = useEditorStore.getState().editingTimelineDoc?.tracks[ti];
    const appendedIdx = cur ? itemCount(cur) : 0;
    mutateTrack(ti, (tr) => withAddedItem(tr, t), 'add-item');
    setSelectedTrack(ti);
    setSelectedItem(appendedIdx);
  }, [mutateTrack]);
  const onAddItem = useCallback(() => { if (selectedTrack != null) addItemAt(selectedTrack, useEditorStore.getState().playheadTime); }, [addItemAt, selectedTrack]);

  // Delete an item, remapping the current selection (deleting BEFORE the selected item shifts it
  // down; deleting the selected item clears it). Shared by the inspector button, double-click-an-
  // item-to-delete, and the Delete/Backspace key — matching the Animation editor's conventions.
  const deleteItemAt = useCallback((ti: number, ii: number) => {
    mutateTrack(ti, (tr) => withDeletedItem(tr, ii), 'delete-item');
    setSelectedItem((prev) => {
      if (selectedTrack !== ti || prev == null) return prev;
      if (prev === ii) return null;
      return prev > ii ? prev - 1 : prev;
    });
  }, [mutateTrack, selectedTrack]);
  const onDeleteItem = useCallback(() => { if (selectedTrack != null && selectedItem != null) deleteItemAt(selectedTrack, selectedItem); }, [deleteItemAt, selectedTrack, selectedItem]);

  // Value-picker sources, rebuilt when the open target changes (nonce is a manual invalidation
  // key — the getters read module state the linter can't see). Audio cues pick a GUID from the
  // project's audio assets; signal markers autocomplete registered action names.
  const pickers = useMemo(
    () => ({
      audioAssets: getAllAssets().filter((a) => a.type === 'audio').map((a) => ({ guid: a.guid, label: a.path.split('/').pop() ?? a.guid })),
      prefabAssets: getAllAssets().filter((a) => a.type === 'prefab').map((a) => ({ guid: a.guid, label: a.path.split('/').pop() ?? a.guid })),
      actionNames: getUIActionNames(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nonce],
  );

  // ── Delete / Backspace removes the selected item (Animation-editor convention). Scoped to the
  // engaged panel (hovered or last-clicked-inside) and yields when a text field is focused or
  // nothing is selected, so it never steals Delete from an input or another panel. ──
  useEffect(() => {
    // Scoped to `timeline-editor` by the keymap (focus-scope refactor P5) — was a document
    // keydown gated on hoverRef||activeRef, so a stray pointer move changed who claimed
    // Delete. when() preserves the original yield: with no doc open or nothing selected the
    // chord is left unclaimed, so Hierarchy's entity-delete still works.
    const canDelete = () =>
      !!useEditorStore.getState().editingTimelineDoc && selectedTrack != null && selectedItem != null;
    const del = () => { if (selectedTrack != null && selectedItem != null) deleteItemAt(selectedTrack, selectedItem); };
    const offs = [
      register({ id: 'timeline.deleteItem', keys: 'Delete', scope: 'timeline-editor', when: canDelete, run: del }),
      register({ id: 'timeline.deleteItemBack', keys: 'Backspace', scope: 'timeline-editor', when: canDelete, run: del }),
    ];
    return () => { for (const off of offs) off(); };
  }, [deleteItemAt, selectedTrack, selectedItem, hmrEpoch]);

  // ── Scrub / transport ──
  // A scrub is a silent pose inside the PREVIEW SESSION envelope (Phase 3): the session snapshots
  // the authored world so Exit / teardown can revert the pose (mandatory now — a plain drag-scrub
  // used to hold no session and leak its pose). Pose at the scrub time; a spawned control prefab
  // tags Transient off the 'scrub' mode set here.
  const poseAt = useCallback((tt: number) => {
    const d = useEditorStore.getState().editingTimelineDoc;
    const rid = useEditorStore.getState().directorRootEntityId; // fresh — may have just rebound on a revert reload
    if (d && rid != null) { previewTimelineAt(getCurrentWorld(), rid, d, tt); previewControlAt(getCurrentWorld(), rid, d, tt); fireDirtyListeners(); }
  }, []);
  const scrub = useCallback((t: number) => {
    const store = useEditorStore.getState();
    const cur = store.editingTimelineDoc;
    const clamped = Math.max(0, Math.min(cur?.duration ?? t, t));
    const wasPlaying = store.isPreviewPlaying;
    if (wasPlaying) stopPreviewLoop(); // stop the loop + close gates NOW so no queued tick advances past the grab (C7)
    store.setPlayhead(clamped);
    store.setPreviewPlaying(false);
    enterScrubMode('timeline');
    if (wasPlaying && hasTimelinePreviewSession()) {
      // Was playing forward, now grabbing the playhead → revert the forward run to authored (you
      // can't un-run a sim), rebind the Director (ids change on reload), REOPEN the envelope's
      // session for the ongoing scrub, then pose at the target time.
      const path = store.editingTimelineAsset?.path;
      void endTimelinePreviewSession({ restore: true, rebind: () => (path ? resolveDirectorRootForTimeline(path) : null) })
        .then((newRoot) => { if (newRoot != null) useEditorStore.getState().setDirectorRoot(newRoot); return beginTimelinePreviewSession(); })
        .then(() => poseAt(clamped));
    } else if (!hasTimelinePreviewSession()) {
      // First scrub of the envelope (from stopped): snapshot the AUTHORED world BEFORE posing, so
      // Exit / asset-switch / unmount can revert the pose. (Mandatory scrub session — Phase 3.)
      void beginTimelinePreviewSession().then(() => poseAt(clamped));
    } else {
      poseAt(clamped); // continuing a scrub within the envelope — just repose
    }
  }, [poseAt, stopPreviewLoop]);

  // ── Exit the preview envelope: revert to the authored snapshot (discards scrub poses + forward-
  //    preview mutations + control spawns), rebind, and return to stopped. The explicit way out of
  //    preview mode (option #2), and the real fix for the scrub save-wedge. ──
  const exitPreview = useCallback(() => {
    const store = useEditorStore.getState();
    stopPreviewLoop(); // stop the loop + close gates synchronously (C7)
    store.setPreviewPlaying(false);
    clearPreviewControls();
    const path = store.editingTimelineAsset?.path;
    void endTimelinePreviewSession({ restore: true, rebind: () => (path ? resolveDirectorRootForTimeline(path) : null) }).then((newRoot) => {
      if (newRoot != null) useEditorStore.getState().setDirectorRoot(newRoot);
    });
    exitPreviewMode('timeline');
  }, [stopPreviewLoop]);

  // ── Preview playback loop ──
  // ── ▶ Preview: a real FORWARD playthrough — poses (keyframe + skeletal seek + activation) AND
  //    fires signals/audio/OnSequence via previewTimelineStep, with the sim otherwise stopped. The
  //    session snapshots the authored world (once, kept across Pause) and the active flag opens the
  //    audio/dispatch gates only while advancing; scrub/⏮/unmount revert. ──
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let cancelled = false;
    void (async () => {
      await beginTimelinePreviewSession(); // snapshot authored world (idempotent across pause/resume)
      if (cancelled) return;
      setTimelinePreviewActive(true);      // open audio + action-dispatch gates
      enterPreviewMode(true, 'timeline');  // carry the run-mode signal (gates still read the active flag until Phase 4)
      const tick = () => {
        raf = requestAnimationFrame(tick);
        previewRafRef.current = raf; // keep the ref live so scrub()/exit can cancel synchronously (C7)
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        const store = useEditorStore.getState();
        const cur = store.editingTimelineDoc;
        if (!cur || rootId == null) return;
        const prevT = store.playheadTime;
        const t = advanceClipTime(prevT, dt, cur.duration, false);
        store.setPlayhead(t);
        const justEnded = t >= cur.duration && prevT < cur.duration;
        // justStarted only when playing from the very beginning → fires sequence-start + any t=0 marker.
        previewTimelineStep(getCurrentWorld(), rootId, cur, prevT, t, { justStarted: prevT <= 0, justEnded });
        fireDirtyListeners();
        if (t >= cur.duration) useEditorStore.getState().setPreviewPlaying(false); // stop at the end (non-looping)
      };
      raf = requestAnimationFrame(tick);
      previewRafRef.current = raf;
    })();
    // Pause/stop/unmount clears the active flag (silences audio, blocks dispatch) but KEEPS the
    // session snapshot — restore happens on scrub/⏮/unmount, so a Pause holds the mutated frame.
    // Loop stopped: pause holds a FROZEN preview frame (session still held) → preview+!advancing;
    // a real teardown (unmount/world-swap/asset-switch) runs its own exit effect → stopped.
    // Guard (review L1): a scrub()/⏮ during preview flips `playing` off AND synchronously sets mode
    // 'scrub' BEFORE this cleanup runs — only freeze if we're still the live preview, else we'd
    // clobber the just-set scrub back to 'preview'.
    return () => {
      cancelled = true; cancelAnimationFrame(raf); previewRafRef.current = 0; setTimelinePreviewActive(false);
      if (getRunMode() === 'preview') enterPreviewMode(false, 'timeline');
    };
  }, [playing, rootId]);

  // ── Follow the live Director during real Play (Game view) ──
  // In Play mode the pipeline advances the bound Director; mirror its `time` onto the ruler playhead
  // each frame so the panel SHOWS where the cutscene is. Read-only — Play owns the clock, we only
  // reflect it (scrub/preview drive the playhead themselves, so this is gated to real advancing Play).
  useEffect(() => {
    if (!(runMode === 'playing' && advancing)) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const rid = useEditorStore.getState().directorRootEntityId;
      if (rid == null) return;
      const dir = findEntity(rid)?.get(Director) as { time?: number } | undefined;
      if (dir && typeof dir.time === 'number') useEditorStore.getState().setPlayhead(dir.time);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [runMode, advancing]);

  // Restore the authored world if the panel unmounts mid-preview (tab closed while paused/ended,
  // leaving preview-mutated camera/text). Empty deps → runs only on real unmount. Also destroy any
  // control-track prefab a scrub left spawned (span-containment presence) so it never lingers into
  // the authored world / a save — a session restore reloads and would drop them anyway, but a plain
  // drag-scrub holds no session, so clear them explicitly.
  useEffect(() => () => {
    clearPreviewControls();
    if (hasTimelinePreviewSession()) {
      const path = useEditorStore.getState().editingTimelineAsset?.path;
      void endTimelinePreviewSession({ restore: true, rebind: () => (path ? resolveDirectorRootForTimeline(path) : null) });
    }
    exitPreviewMode('timeline'); // panel gone → return the global run-mode to stopped
  }, []);

  // A scene load / hot-reload swaps the world out from under the panel. Two things must happen:
  //  1. Tear down any live preview loop — it's keyed on store fields (not the world), so it wouldn't
  //     otherwise stop; ABANDON the snapshot without restoring (its entity ids belong to the old
  //     world; the preview's own restore reload swaps too but has already cleared the session).
  //  2. RE-RESOLVE the bound Director root. Its runtime id is reassigned on every swap, so the
  //     cached `directorRootEntityId` (set once when the timeline was opened) goes stale/dead and
  //     BOTH scrub-pose and ▶ Preview then silently no-op (pose()/the preview loop bail on a null
  //     root). Re-resolving here against the freshly-loaded scene keeps them working after any
  //     scene load, hot-reload, or the mutate that triggers one. Cleanup unsubscribes on unmount.
  useEffect(() => onWorldSwap(() => {
    const st = useEditorStore.getState();
    if (st.isPreviewPlaying || hasTimelinePreviewSession()) {
      st.setPreviewPlaying(false);
      void endTimelinePreviewSession({ restore: false });
    }
    exitPreviewMode('timeline'); // world swapped out from under the panel → drop back to stopped
    const asset = st.editingTimelineAsset;
    if (asset) st.setDirectorRoot(resolveDirectorRootForTimeline(asset.path));
  }), []);

  // ── Debounced validated save ──
  const writeDoc = useCallback((d: TimelineDef): Promise<boolean> => {
    const path = asset?.path;
    if (!path) return Promise.resolve(false);
    setSaveMsg('Saving…');
    return backendFetch('/api/asset-write', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, type: 'timeline', data: d }),
    }).then((res) => { setSaveMsg(res.ok ? 'Saved ✓' : `Save failed (${res.status})`); return res.ok; })
      .catch((e) => { setSaveMsg('Save failed'); console.warn('[TimelineEditor] save failed', e); return false; });
  }, [asset?.path]);
  const { markSaved } = useDebouncedSave(doc, writeDoc, AUTOSAVE_MS);
  savedMarkRef.current = markSaved;

  if (!asset) return <div style={{ padding: 12, color: '#8a8a96', fontSize: 12 }}>No timeline open. Double-click a <code>.timeline.json</code> in Assets, or open a Director&apos;s timeline.</div>;
  if (!doc) return <div style={{ padding: 12, color: '#8a8a96', fontSize: 12 }}>Loading timeline…</div>;

  const sel = selectedTrack != null ? doc.tracks[selectedTrack] : null;

  return (
    <div ref={rootRef}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#1b1b1f', color: '#cfcfd6', fontSize: 12 }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderBottom: '1px solid #2f2f37', flexWrap: 'wrap' }}>
        <button data-ui-id="timeline.transport.play" style={btn} onClick={() => {
          const s = useEditorStore.getState();
          // No Director in the CURRENT scene references this timeline → nothing to drive. Warn rather
          // than silently no-op (common when the timeline stays open after switching scenes).
          if (!playing && rootId == null) { s.showToast('This scene has no Director bound to this timeline — nothing to preview. Open the scene that uses it (or add a Director whose timeline is this one).', 'warn'); return; }
          if (!playing && s.playheadTime >= (doc?.duration ?? 0)) s.setPlayhead(0);
          s.setPreviewPlaying(!playing);
        }}>{playing ? '⏸ Pause' : '▶ Play'}</button>
        <button data-ui-id="timeline.transport.rewind" style={btn} onClick={() => scrub(0)}>⏮</button>
        {/* Explicit way OUT of the preview envelope — reverts to authored (shown only while in preview). */}
        {inPreview && (
          <button data-ui-id="timeline.transport.exit" style={{ ...btn, borderColor: '#e0a05b', color: '#e0a05b' }} onClick={exitPreview}
            title="Leave preview and revert the scene to its authored state">⏹ Exit Preview</button>
        )}
        <span style={{ color: '#8a8a96' }}>t {playhead.toFixed(2)}s</span>
        <span style={{ width: 1, height: 16, background: '#3a3a42' }} />
        <label style={{ color: '#8a8a96' }}>dur <input style={inputStyle} type="number" min={0} step={0.1} value={doc.duration}
          onChange={(e) => commit((d) => ({ ...d, duration: Math.max(0, Number(e.target.value) || 0) }), 'duration')} /></label>
        <label style={{ color: '#8a8a96' }}>fps <input style={{ ...inputStyle, width: 44 }} type="number" min={1} step={1} value={doc.frameRate}
          onChange={(e) => commit((d) => ({ ...d, frameRate: Math.max(1, Number(e.target.value) || 30) }), 'fps')} /></label>
        {/* Run-mode-aware status: Editing / ● Preview playing|paused / ▶ Playing (Game) — the
            playhead follows the live Director during real Play. */}
        <span data-ui-id="timeline.status" data-bound={rootId == null ? 'false' : 'true'} data-runmode={runMode}
          style={{ marginLeft: 'auto', color: rootId == null ? '#b07f5b' : (inPreview || runMode === 'playing') ? '#7bd88f' : '#6a6a76', fontSize: 11 }}>
          {rootId == null
            ? '⚠ no Director bound — scrub won’t pose'
            : inPreview
              ? `● Preview ${runMode === 'preview' && advancing ? 'playing' : 'paused'}`
              : runMode === 'playing'
                ? (advancing ? '▶ Playing (Game)' : '⏸ Play paused')
                : 'Editing'}{saveMsg ? ` · ${saveMsg}` : ''}
        </span>
      </div>

      {/* Body: lanes + track view + right-side inspector dock */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <TrackLaneList
          doc={doc} width={TRACK_LIST_W} selectedTrack={selectedTrack}
          onSelectTrack={selectTrack}
          onSetTarget={onSetTarget}
          onToggleMute={onToggleMute}
          onRemoveTrack={onRemoveTrack}
          onAddTrack={onAddTrack}
        />
        <ClipTrackView
          doc={doc} viewport={viewport} onViewport={setViewport}
          onScrub={scrub}
          onMoveItem={onMoveItem}
          selectedTrack={selectedTrack} onSelectTrack={selectTrack}
          selectedItem={selectedItem} onSelectItem={selectItem}
          onAddItemAt={addItemAt} onDeleteItem={deleteItemAt}
        />

        {/* Draggable divider — resize the inspector dock (drag left to widen). */}
        <div
          data-ui-id="timeline.inspector.resize"
          onPointerDown={startInspectorResize}
          style={{ width: 5, flexShrink: 0, cursor: 'col-resize', background: '#2f2f37', alignSelf: 'stretch' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#4a4a6a'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = '#2f2f37'; }}
        />

        {/* Right dock (always visible): selected-track header + add-item, then the item inspector. */}
        <div style={{ width: inspectorW, flexShrink: 0, borderLeft: '1px solid #2f2f37', background: '#1d1d21', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '5px 8px', borderBottom: '1px solid #2f2f37', fontSize: 10, color: '#8a8a96', textTransform: 'uppercase', letterSpacing: 0.4 }}>Inspector</div>
          {sel ? (
            <>
              <div style={{ padding: '6px 8px', borderBottom: '1px solid #26262c', color: '#8a8a96', fontSize: 11 }}>
                <div><b style={{ color: '#cfcfd6' }}>{sel.type}</b> “{sel.name}” · {itemCount(sel)} item(s)</div>
                <button style={{ ...btn, marginTop: 5 }} onClick={onAddItem}>+ item @ playhead</button>
              </div>
              {selectedItem != null && selectedItem < itemCount(sel) ? (
                <ItemInspector
                  key={`${selectedTrack}:${selectedItem}`}
                  track={sel} itemIdx={selectedItem}
                  audioAssets={pickers.audioAssets} prefabAssets={pickers.prefabAssets} actionNames={pickers.actionNames}
                  onEdit={onEditItem} onDelete={onDeleteItem}
                />
              ) : (
                <div style={{ padding: 8, color: '#6a6a76', fontSize: 11, lineHeight: 1.5 }}>
                  Click a clip/marker to edit its values.<br />Double-click an empty spot to add one; double-click an item (or press <b>Delete</b>) to remove it.
                </div>
              )}
            </>
          ) : (
            <div style={{ padding: 8, color: '#6a6a76', fontSize: 11, lineHeight: 1.5 }}>
              Select a track (left) to add or edit its items.<br />Add a new track with the <b>+animation / +signal / +audio / +activation</b> buttons at the bottom-left.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
