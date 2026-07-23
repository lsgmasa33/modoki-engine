/** Editor agent ops — the renderer-side handlers that give an AI agent (or any
 *  tooling) parity with what a human can DO and SEE in the editor.
 *
 *  These are registered into the agent-bridge op registry (engine/app/debug/
 *  agentBridge.ts) at EDITOR startup only — `registerEditorAgentOps()` is called
 *  from `createGameEditor` (the lazy, React.lazy-loaded editor path). That keeps
 *  all `@modoki/engine/editor` imports out of the shipped game web bundle while
 *  making every op work identically in dev (relayed over Vite HMR) and the
 *  packaged DMG (relayed over Electron IPC) — the bridge transport is the same.
 *
 *  Convention: each op returns a JSON-serializable result (the backend forwards
 *  it verbatim). Selection/gizmo writes go through RAW store setState so they do
 *  NOT push selection-undo entries — the agent must not pollute the human's undo
 *  stack just by looking around. Structural edits (create/delete/duplicate/
 *  reparent) DO go through the undoable actions, exactly like the menus, so the
 *  agent's edits are undoable too. */

import { describeEditorCamera, type EditorCameraInfo } from './editorCameraInfo';
import { registerAgentOp as _registerAgentOp, type AgentOpHandler, setSceneReloadSuppressor } from '../debug/agentBridge';
import { performDomDnd, type DomDndParams } from '../debug/domDnd';
import { getHmrStatus } from '../debug/hmrStaleness';
import { handleEval } from '../debug/bridgeHelpers';
import {
  useEditorStore, type SelectedAsset,
  enterPlay, stopPlay, pausePlay,
  undo, redo, canUndo, canRedo, undoLabel, redoLabel, getEditVersion,
  loadScene, saveAll, newScene, getCurrentScenePath, hasUnsavedChanges, isEditingPrefab,
  createEntityWithUndo, duplicateEntity, deleteEntitiesWithUndo, reparentEntity, ensureGuid, type TraitSpec,
  buildEntityCreateSpecs, type CreateEntitySpec,
  getPrefabSource, instantiatePrefabAsync, serializePrefab, writePrefabFile,
  resolveExistingPrefabId, tagEntityTreeAsInstance, detachPrefabInstance,
  getEditorViewportCamera, focusEntityInSceneView,
  upsertKey, findTrack, encodeValue, backendFetch,
  readEditorJournal, clearEditorJournal, withEditorActor, openActorLease, closeActorLease,
  type PrefabFile,
} from '@modoki/engine/editor';
import { tailWithCounts, takeTail, takeHead, tailHint, JOURNAL_TAIL_DEFAULT, EDITOR_JOURNAL_TAIL_DEFAULT } from '../debug/streamSummary';
import {
  getPlayState, setPlayState, getRunMode, isAdvancing, getCurrentFPS, stepOneFrame, getAllEntities, findEntity, findEntityByGuid,
  getAnimationClip, normalizeAnimationClip, validateAssetData, journalEvents,
  getTimeline, normalizeTimeline, getGuidForPath, getAssetType, getPresentationScale,
  type AnimationClipDef, type TrackValueType, type TimelineDef, type TrackDef, type TrackKind,
} from '@modoki/engine/runtime';

// ── Reads ─────────────────────────────────────────────────────────────────

/** The live editor orbit camera pose, or null when no viewport is mounted — enough to
 *  reconstruct framing or feed render-scene's camera override. The projection-aware shaping
 *  (fov for perspective, orthoSize for ortho) is the pure {@link describeEditorCamera}. */
function readEditorCamera(): EditorCameraInfo | null {
  return describeEditorCamera(getEditorViewportCamera());
}

/** HMR staleness, kept OFF the payload when there is nothing to report — an editor that
 *  has had zero updates is by definition not stale. Silence here means "this build is what
 *  booted". (Applies to the packaged editor too: it runs a real Vite dev server, so it has
 *  HMR — see engine/app/debug/hmrStaleness.ts.) */
function hmrFields(): { hmrUpdates?: number; staleGameCode?: true; discardedUnsavedEdits?: true } {
  const h = getHmrStatus();
  const out: { hmrUpdates?: number; staleGameCode?: true; discardedUnsavedEdits?: true } = {};
  if (h.updates > 0) out.hmrUpdates = h.updates;
  if (h.staleGameCode) { out.staleGameCode = true; out.hmrUpdates = h.updates; }
  // Sticky for the life of the page: the human may not have seen the banner, and an agent
  // reading state later still needs to know work was dropped under it.
  if (h.discardedUnsavedEdits) out.discardedUnsavedEdits = true;
  return out;
}

/** The whole editor UI state in one read — the "get all UI state" payload. */
function readEditorState() {
  const s = useEditorStore.getState();
  return {
    scenePath: getCurrentScenePath(),
    // Live-world work not on disk. Anything reading the scene FILE (set_transform,
    // mutate_scene, build) is looking at a DIFFERENT world while this is true. (C7)
    unsavedChanges: hasUnsavedChanges(),
    playState: getPlayState(),
    runMode: getRunMode(),   // 'stopped' | 'scrub' | 'preview' | 'playing' (preview-mode-refactor)
    advancing: isAdvancing(), // false = a frozen frame (Play paused, or a paused preview)
    gizmoMode: s.gizmoMode,
    gizmoSpace: s.gizmoSpace,
    sceneViewMode: s.sceneViewMode,
    // Which panel owns the KEYBOARD ('scene' | 'hierarchy' | 'animation-editor' | …), or null.
    // Readable as DATA on purpose: the focus ring is a CSS box-shadow, so without this the
    // question "which panel would this key go to?" would only be answerable from a screenshot —
    // exactly what docs/debug-tools-mcp.md forbids. (focus-scope refactor P2)
    focusedPanel: s.focusedPanel,
    // HMR staleness. `staleGameCode: true` means game code changed on disk but the editor
    // could NOT reload (unsaved scene work), so this world is running the OLD build —
    // every measurement taken here is suspect until it reloads. `hmrUpdates` is how many
    // hot updates have landed since boot; 0 means "nothing has changed under me". Exposed
    // as DATA because the failure mode is otherwise SILENT — neither a human nor an agent
    // can tell a stale editor from a working one by looking. (docs/editor-hmr.md)
    ...hmrFields(),
    colliderEditMode: s.colliderEditMode,
    fps: Math.round(getCurrentFPS()),
    entityCount: getAllEntities().length,
    selection: {
      entityId: s.selectedEntityId,
      entityIds: s.selectedEntityIds,
      asset: s.selectedAsset,
    },
    camera: readEditorCamera(),
    undo: { canUndo: canUndo(), canRedo: canRedo(), undoLabel: undoLabel(), redoLabel: redoLabel() },
    // Viewport + UI zoom, exposed as DATA so "what's the current zoom / viewport size" has a
    // Percept surface (previously answerable only via a raw CDP eval of window.*). `zoomFactor`
    // is the VS Code–style whole-app UI zoom (getPresentationScale is editor-calibrated to
    // webContents.getZoomFactor); `devicePixelRatio` is the raw backing-store ratio (display
    // scale × zoom). See docs/todo.md (zoom-session MCP gaps).
    viewport: readViewport(),
  };
}

/** CSS viewport size + zoom, read live from the renderer window. Guarded for the
 *  headless/SSR case (no `window`) so this stays safe if ever called off the renderer. */
function readViewport() {
  if (typeof window === 'undefined') return null;
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    zoomFactor: getPresentationScale(),
  };
}

// ── Param shapes ───────────────────────────────────────────────────────────

interface SetSelectionParams { entityId?: number | null; entityIds?: number[]; guid?: string; guids?: string[]; asset?: SelectedAsset | null }
interface CreateEntityParams { spec: CreateEntitySpec; parentId?: number; parentGuid?: string }
interface PrefabParams {
  action: 'instantiate' | 'create' | 'detach';
  /** instantiate: prefab asset path. create: source path to write. */
  path?: string;
  /** instantiate: parent entity id (default root). */
  parentId?: number;
  /** instantiate: parent entity guid (stable; wins over parentId). */
  parentGuid?: string;
  /** create/detach: the entity to make a prefab from / detach. */
  entityId?: number;
  /** create/detach: the entity guid (stable; wins over entityId). */
  entityGuid?: string;
}

/** Raw selection write — no undo entry (the agent shouldn't pollute the human's
 *  undo stack just by selecting). Mirrors deleteEntitiesWithUndo's setState path. */
function setSelectionRaw(entityId: number | null, entityIds: number[]): void {
  useEditorStore.setState({ selectedEntityId: entityId, selectedEntityIds: entityIds, selectedAsset: null });
}

/** Resolve an entity ref to a LIVE numeric id: `guid` wins (stable across hot-reloads), else
 *  the numeric `id` if it still resolves; null when neither does. CLAUDE.md mandates addressing
 *  by guid because runtime ids are REASSIGNED on every scene reload — a recycled id silently
 *  targets the WRONG entity (data loss on delete/reparent), so guid must be accepted everywhere
 *  an id is. `set_transform`/`mutate_scene` already take {id|name|guid}; this brings the live-world
 *  structural ops to parity. (C7 re-audit.) */
function resolveLiveId(ref: { id?: number; guid?: string } | undefined): number | null {
  if (!ref) return null;
  if (ref.guid) { const e = findEntityByGuid(ref.guid); return e ? e.id() : null; }
  if (ref.id != null) return findEntity(ref.id) ? ref.id : null;
  return null;
}

/** Validate that `path` names a real asset of `expected` type before opening an editor on it.
 *  The open-*-editor ops used to mount a panel at ANY string path and return editor state
 *  (success), so a typo'd/wrong-type path silently produced a panel with no handles and no
 *  error — indistinguishable from "not mounted". Now a bad path is an actionable failure. (C7 re-audit.) */
function requireAssetPath(path: string | undefined, expected: string, op: string): void {
  if (typeof path !== 'string' || !path) throw new Error(`${op} requires { path } — the asset's served URL (see modoki_list_assets).`);
  if (!getGuidForPath(path)) throw new Error(`${op}: no asset found at "${path}" — it resolves to no manifest entry (typo, or wrong path). Find it with modoki_list_assets.`);
  const type = getAssetType(path);
  if (type && type !== expected) throw new Error(`${op}: "${path}" is a ${type}, not a ${expected} — this editor only opens ${expected} assets.`);
}

/** Resolve a required entity ref for a structural op, throwing an actionable error when it
 *  doesn't resolve — so a stale guid/id is a visible failure, never a silent wrong-target. */
function requireLiveId(ref: { id?: number; guid?: string } | undefined, op: string): number {
  const id = resolveLiveId(ref);
  if (id == null) {
    const what = ref?.guid ? `guid "${ref.guid}"` : ref?.id != null ? `id ${ref.id}` : 'entity ref';
    throw new Error(`${op}: ${what} matched no live entity — it may be stale (runtime ids are reassigned on every scene reload; prefer addressing by guid). Re-read it with get_scene_state.`);
  }
  return id;
}

// ── Registration ─────────────────────────────────────────────────────────────

let registered = false;

/** Total item count across a timeline's tracks (clips / markers / cues / spans), tolerant of both a
 *  raw partial doc and a normalized one — so timeline-set can compare pre/post normalization and detect
 *  silently-dropped malformed items. Exported for the F12 regression test. (F12) */
export function countTimelineItems(t: Partial<TimelineDef> | undefined): number {
  const tracks = (t?.tracks ?? []) as unknown as Array<Record<string, unknown>>;
  let n = 0;
  for (const tr of tracks) {
    for (const key of ['clips', 'markers', 'cues', 'spans']) {
      const arr = tr[key];
      if (Array.isArray(arr)) n += arr.length;
    }
  }
  return n;
}

export function registerEditorAgentOps(): void {
  // Every op registered here is the AGENT acting (human actions come through the UI,
  // not these ops). Shadow registerAgentOp so any editor-activity events an op emits
  // are tagged source:'agent' — so Claude can tell its own edits from the human's in
  // the editor-journal (Phase 7 review). Reads emit nothing, so wrapping them is inert.
  const registerAgentOp = (name: string, handler: AgentOpHandler): void =>
    _registerAgentOp(name, (params) => withEditorActor('agent', () => handler(params)));
  if (registered) return;
  registered = true;

  // Suppress scene hot-reload while Playing/Paused: a disk edit would reload the
  // live world but Stop reverts to the Play-press snapshot, discarding it. The
  // backend also consults this (via editor-state) to refuse mutate-while-playing.
  setSceneReloadSuppressor(() => {
    const s = getPlayState();
    return s === 'stopped' ? null : `game is ${s} — stop the game (Stop) before editing the scene`;
  });

  // ── State read ──
  registerAgentOp('editor-state', () => readEditorState());

  // Editor-renderer JS eval — the editor twin of device_eval (game-debug MCP). Runs `code`
  // as a function body (so `return x` yields a value) and safe-stringifies the result IN the
  // renderer, so nothing non-cloneable (a DOM node, a fiber, window) has to cross the M→R IPC
  // bridge — a JSON string always does. Unblocks reading/poking live renderer state (a global,
  // window.innerWidth, devicePixelRatio, dispatching a bridge event) without a raw CDP client.
  // Editor-only: this whole module is stripped from shipped game builds.
  registerAgentOp('eval', (params) => handleEval(((params ?? {}) as { code?: string }).code ?? ''));

  // Editor Percept (Phase 7 + V3): the human-activity stream (`!`-prefixed). `merged`
  // also returns the game journal AND a single-axis `timeline` that interleaves both by
  // the shared `cap` capture counter — so Claude reads one ordered story ("pressed Play
  // → set timeScale 0.3 → @match on tick 84 → paused").
  registerAgentOp('editor-journal', (params) => {
    const p = (params ?? {}) as { type?: string; source?: 'human' | 'agent'; since?: number; sinceCap?: number; clear?: boolean; merged?: boolean; limit?: number };
    // `editor` is the editor-only view: filtered by type/source and cursored by the
    // editor-local `since` (a `seq`). `timeline` is the single-axis merged view.
    //
    // Tail + histogram at the OP, not in `readEditorJournal` — the producer stays whole for
    // any in-process reader. The 2,000-event ring runs ~130–253 bytes/event (transform and
    // trait-edit events carry old→new values), so an unbounded read is ~54–126k tokens.
    // Cursor semantics (C7 re-audit): `since`/`sinceCap` are FORWARD cursors, so a CURSORED poll
    // returns the OLDEST events after the cursor (takeHead) + a nextSeq/nextCap to advance
    // contiguously — NOT the newest tail (takeTail), which permanently drops the oldest-after-
    // cursor block when >limit events accrue between polls (they have a lower seq/cap than the
    // returned window, so no forward cursor can ever reach them). The cursor-LESS "what just
    // happened" call keeps the newest tail.
    const histogram = <T>(items: readonly T[], typeOf: (t: T) => string): Record<string, number> => {
      const b: Record<string, number> = {};
      for (const it of items) { const k = typeOf(it); b[k] = (b[k] ?? 0) + 1; }
      return b;
    };
    const editorAll = readEditorJournal({ type: p.type, source: p.source, since: p.since });
    const edCursored = p.since != null;
    const ed = (edCursored ? takeHead : takeTail)(editorAll, p.limit, EDITOR_JOURNAL_TAIL_DEFAULT);
    const result: {
      editor: unknown[]; editorTotal: number; byType: Record<string, number>;
      truncated?: boolean; hint?: string; nextSeq?: number;
      game?: unknown[]; gameTotal?: number; gameByType?: Record<string, number>;
      timeline?: unknown[]; timelineTotal?: number; nextCap?: number;
    } = { editor: ed.items, editorTotal: editorAll.length, byType: histogram(editorAll, (e) => String(e.type ?? '?')) };
    if (ed.truncated) {
      result.truncated = true;
      if (edCursored) {
        const lastSeq = (ed.items[ed.items.length - 1] as { seq?: number } | undefined)?.seq;
        if (lastSeq != null) result.nextSeq = lastSeq;
        result.hint = `Showing the OLDEST ${ed.items.length} of ${editorAll.length} editor events after since=${p.since} (oldest first). Poll again with since=${result.nextSeq} to continue contiguously with no gap; raise limit=N to fetch more per poll.`;
      } else {
        result.hint = tailHint('editor events', ed.items.length, editorAll.length, ', or narrow with type=/source=/since=');
      }
    }
    if (p.merged) {
      const game = journalEvents();
      // `merged` was the worst payload on this surface: BOTH full rings, twice over (the raw
      // `game` array AND the same events again inside `timeline`). A busy Play session is
      // ~582k tokens of `@contact`. Both are tailed; `sinceCap` remains the precise cursor.
      const g = tailWithCounts(game, (e) => String(e.type ?? '?'), { limit: p.limit, defaultLimit: JOURNAL_TAIL_DEFAULT });
      result.game = g.items; // raw game stream (tick-stamped), kept for back-compat
      result.gameTotal = g.total;
      result.gameByType = g.byType;
      // Single axis: BOTH streams windowed by the SAME `sinceCap` cursor (a `cap`),
      // then interleaved by the globally-unique shared cap counter — so incremental
      // polling (pass the last timeline cap as sinceCap) yields a coherent slice, not
      // (a few new editor events) + (the entire game journal). The editor `type`/
      // `source`/`since` filters shape only the `editor` array, NOT the timeline (which
      // is the full correlated story). cap is unique ⇒ no ties ⇒ a total order.
      const capFloor = p.sinceCap ?? -Infinity;
      const edAll = readEditorJournal(); // unfiltered — the timeline shows everything
      const timeline = [
        ...edAll.filter((e) => e.cap > capFloor).map((e) => ({ stream: 'editor' as const, ...e })),
        ...game.filter((e) => (e.cap ?? 0) > capFloor).map((e) => ({ stream: 'game' as const, ...e })),
      ].sort((a, b) => (a.cap ?? 0) - (b.cap ?? 0));
      // Window the interleaved axis: HEAD (oldest-after-cursor) when sinceCap is set so an
      // incremental poll is lossless + contiguous; the newest TAIL for a bare "what just
      // happened" call. Both via the shared helpers (a hand-rolled slice re-created the
      // `slice(-0)` whole-array bug on limit=0, and swallowed a NaN limit too).
      result.timelineTotal = timeline.length;
      const tlCursored = p.sinceCap != null;
      const tl = (tlCursored ? takeHead : takeTail)(timeline, p.limit, EDITOR_JOURNAL_TAIL_DEFAULT);
      result.timeline = tl.items;
      if (tl.truncated) {
        result.truncated = true;
        if (tlCursored) {
          const lastCap = (tl.items[tl.items.length - 1] as { cap?: number } | undefined)?.cap;
          if (lastCap != null) result.nextCap = lastCap;
          result.hint = `Showing the OLDEST ${tl.items.length} of ${timeline.length} timeline events after sinceCap=${p.sinceCap} (oldest first). Poll again with sinceCap=${result.nextCap} to continue contiguously with no gap; raise limit=N for more per poll.`;
        } else {
          result.hint = tailHint('timeline events', tl.items.length, timeline.length, ', or cursor with sinceCap=<last cap>');
        }
      }
    }
    if (p.clear) clearEditorJournal();
    return result;
  });

  // ── HTML5 drag-and-drop (Enact Phase 1) ── synthesize the dragstart→drop
  // sequence the trusted pointer-drag can't emit (Hierarchy reparent, Assets
  // file-move, Skin sprite-onto-part). Renderer-DOM, so dev + DMG both work.
  // ── Actor lease ── the trusted-input seam declaring itself, so injected input is
  // journaled as `agent` instead of masquerading as the human (measured: modoki_tap's
  // !select said source:"human"). Registered as a plain renderer op rather than through
  // the wrapper above, because it MANAGES attribution and must not be attributed itself.
  _registerAgentOp('actor-lease', (params) => {
    const p = (params ?? {}) as { open?: boolean; id?: number; ttlMs?: number };
    if (p.open) return { id: openActorLease('agent', p.ttlMs) };
    if (typeof p.id === 'number') closeActorLease(p.id);
    return { ok: true };
  });

  // `getEditVersion` lets the op distinguish "the target ACCEPTED this payload type" from
  // "the handler actually did something" — measured: a texture dropped on a Hierarchy entity
  // row reported ok:true/accepted:true and made no edit at all.
  registerAgentOp('dom-dnd', (params) => performDomDnd((params ?? {}) as DomDndParams, { editVersion: getEditVersion }));

  // ── Selection ──
  registerAgentOp('set-selection', (params) => {
    const p = (params ?? {}) as SetSelectionParams;
    if (p.asset !== undefined) {
      useEditorStore.setState({ selectedAsset: p.asset, selectedEntityId: null, selectedEntityIds: [] });
      return readEditorState();
    }
    // Resolve every requested ref to a LIVE id (guid wins), keeping only ids that resolve.
    // Selecting a nonexistent/stale id used to "succeed" and echo it back as selected, so a
    // following gizmo / collider-edit / focus silently acted on nothing. Now a fully-unresolved
    // request fails, and a partial one reports what was skipped. No refs at all = clear. (C7 re-audit.)
    const requested: Array<{ id?: number; guid?: string }> = [
      ...(p.guids ?? []).map((guid) => ({ guid })),
      ...(p.guid != null ? [{ guid: p.guid }] : []),
      ...(p.entityIds ?? []).map((id) => ({ id })),
      ...(p.entityId != null ? [{ id: p.entityId }] : []),
    ];
    const resolved: number[] = [];
    const missing: Array<{ id?: number; guid?: string }> = [];
    for (const r of requested) {
      const id = resolveLiveId(r);
      if (id == null) missing.push(r);
      else if (!resolved.includes(id)) resolved.push(id);
    }
    if (requested.length && resolved.length === 0) {
      throw new Error('set-selection: none of the requested entities resolve to a live entity (ids are reassigned on scene reload — prefer guid). Re-read them with get_scene_state.');
    }
    setSelectionRaw(resolved.length ? resolved[resolved.length - 1] : null, resolved);
    const state = readEditorState();
    return missing.length
      ? { ...state, skipped: missing, warning: `${missing.length} requested entity ref(s) matched no live entity and were skipped` }
      : state;
  });

  // ── Gizmo ──
  registerAgentOp('set-gizmo', (params) => {
    const p = (params ?? {}) as { mode?: 'translate' | 'rotate' | 'scale'; space?: 'world' | 'local' };
    const store = useEditorStore.getState();
    if (p.mode) store.setGizmoMode(p.mode);
    if (p.space) store.setGizmoSpace(p.space);
    return readEditorState();
  });

  // ── SceneView mode + collider-edit ── the toolbar's native <select> ('3d'|'ui')
  // and the Collider-edit toggle can't be driven by trusted input (native popup),
  // so expose them as ops. 'ui' mode mounts the 2D overlay where Collider2D vertex
  // editing (and its interaction-handle provider) lives.
  registerAgentOp('set-scene-view-mode', (params) => {
    const p = (params ?? {}) as { mode?: '3d' | 'ui' };
    if (p.mode === '3d' || p.mode === 'ui') useEditorStore.getState().setSceneViewMode(p.mode);
    return readEditorState();
  });
  // Set the KEYBOARD SCOPE — which panel the keymap dispatcher resolves chords against
  // (focus-scope refactor P7). Without this, an agent's only way to steer a keypress was
  // to tap something first and hope the click landed in the right panel; after scoping
  // landed, a bare `w` sent with the wrong panel focused simply does nothing, silently.
  //
  // Deliberately separate from `focus-element` (DOM focus): clicking a Hierarchy ROW moves
  // the keyboard scope but NOT document.activeElement, so the two are genuinely different
  // questions. Returns the resulting scope so the caller can confirm rather than assume.
  registerAgentOp('set-focus-scope', (params) => {
    const p = (params ?? {}) as { panel?: string | null };
    if (p.panel !== undefined) useEditorStore.getState().setFocusedPanel(p.panel);
    return { ok: true, focusedPanel: useEditorStore.getState().focusedPanel };
  });
  registerAgentOp('set-collider-edit', (params) => {
    const p = (params ?? {}) as { on?: boolean };
    if (typeof p.on === 'boolean') useEditorStore.getState().setColliderEditMode(p.on);
    return readEditorState();
  });
  // Open the Particle Editor dock panel on a .particle.json (normally a double-click in
  // Assets). Mounts CurveEditor/GradientEditor, whose interaction-handle providers then
  // register — so the agent can reach the size/opacity curve points + gradient stops.
  registerAgentOp('open-particle-editor', (params) => {
    const p = (params ?? {}) as { path?: string; name?: string };
    requireAssetPath(p.path, 'particle', 'open-particle-editor');
    const name = p.name ?? p.path!.split('/').pop()?.replace(/\.particle\.json$/, '') ?? p.path!;
    useEditorStore.getState().openParticleEditor({ path: p.path!, type: 'particle', name });
    return readEditorState();
  });
  // Open the Sprite slicer / 9-slice modal on a texture (normally the Texture-Inspector
  // buttons). Selects the texture + requests the modal → its handle providers mount.
  registerAgentOp('open-sprite-editor', (params) => {
    const p = (params ?? {}) as { path?: string; name?: string };
    requireAssetPath(p.path, 'texture', 'open-sprite-editor');
    useEditorStore.getState().requestTextureEditor(p.path!, 'sprite', p.name);
    return readEditorState();
  });
  registerAgentOp('open-nine-slice-editor', (params) => {
    const p = (params ?? {}) as { path?: string; name?: string };
    requireAssetPath(p.path, 'texture', 'open-nine-slice-editor');
    useEditorStore.getState().requestTextureEditor(p.path!, 'nineslice', p.name);
    return readEditorState();
  });

  registerAgentOp('focus-entity', (params) => {
    // Accept guid (stable) or id; validate it resolves before claiming success. Report whether a
    // SceneView was actually mounted to frame it — the op used to return {ok:true} for a
    // nonexistent id AND when no viewport was open, so the camera didn't move either way. (C7 re-audit.)
    const p = (params ?? {}) as { id?: number; guid?: string };
    const id = requireLiveId(p, 'focus-entity');
    const framed = focusEntityInSceneView(id);
    if (!framed) return { ok: false, framed: false, reason: 'no SceneView viewport is mounted, so there is nothing to frame the entity in (open/focus the 3D SceneView first).' };
    return { ok: true, framed: true };
  });

  // ── Play control ── matches the GameView transport bar.
  registerAgentOp('play', async () => { await enterPlay(); return readEditorState(); });
  registerAgentOp('resume', async () => { await enterPlay(); return readEditorState(); });
  registerAgentOp('stop', async () => { await stopPlay(); return readEditorState(); });
  registerAgentOp('pause', () => { pausePlay(); return readEditorState(); });
  // Step one frame while Paused: flip to 'playing' around a single synchronous
  // frame, then freeze again (exactly GameView's stepOnce).
  registerAgentOp('step', () => {
    if (getPlayState() !== 'paused') return { ok: false, error: 'step requires paused state', playState: getPlayState() };
    setPlayState('playing');
    stepOneFrame();
    setPlayState('paused');
    return readEditorState();
  });

  // ── Undo / redo ── (async — undo/redo may run async undo closures).
  // `did:false` means the stack was empty. It is REPORTED, not thrown: "nothing to undo" is a
  // legitimate answer, and the state below shows what actually happened. (C7 note: an undo
  // whose target entity was destroyed by a scene hot-reload still pops the entry — see the C7
  // save-state audit in docs/connect-claude-code.md; verify with get_scene_state, not `did`.)
  registerAgentOp('undo', async () => { const did = await undo(); return { did, ...readEditorState() }; });
  registerAgentOp('redo', async () => { const did = await redo(); return { did, ...readEditorState() }; });

  // ── Scene management ──
  // load-scene / new-scene SWAP THE WORLD, so anything created live and not saved is gone —
  // from the world, the file, AND the undo stack (swapHistory rebinds). They used to report
  // {ok:true, entityCount:12}, which looks perfectly healthy while the entity you just made
  // no longer exists anywhere. Refuse by default; `force` discards deliberately. (C7)
  const guardUnsaved = (op: string, force: boolean | undefined) => {
    if (force || !hasUnsavedChanges()) return;
    throw new Error(
      `${op}: the editor has UNSAVED live-world changes (e.g. from create_entity / ` +
      `duplicate_entity / prefab, which do NOT save). ${op} swaps the world, so they would be ` +
      `destroyed — gone from the world, the file, and the undo stack. Run modoki_save_all ` +
      `first, or pass force:true to discard them deliberately.`,
    );
  };
  registerAgentOp('load-scene', async (params) => {
    const { path, force } = (params ?? {}) as { path: string; force?: boolean };
    if (!path) throw new Error('load-scene requires { path }');
    guardUnsaved('load-scene', force);
    const ok = await loadScene(path);
    if (!ok) throw new Error(`load-scene FAILED for ${path} — the scene was not loaded (does the path exist?).`);
    return { ok, ...readEditorState() };
  });
  registerAgentOp('new-scene', (params) => {
    const { force } = (params ?? {}) as { force?: boolean };
    guardUnsaved('new-scene', force);
    newScene();
    setSelectionRaw(null, []);
    return readEditorState();
  });
  // save_all is the tool the whole "create live, then edit the file" story depends on, so it
  // must never claim a write that didn't happen. It used to hardcode {ok:true} over a
  // void saveAll() that swallowed BOTH a user cancel and a failed write — reproducing the
  // exact bug save_all exists to fix, with the fix confirming it had worked. (C7)
  //
  // allowDialog:false is load-bearing: with no path yet (after new_scene) the human path
  // opens a NATIVE Save panel, which is modal and only a human can dismiss — an agent call
  // hung ~60s to a 504 AND blocked every later renderer-bound call until someone clicked
  // Cancel. Take an explicit `path` instead, and say so when we need one.
  registerAgentOp('save-all', async (params) => {
    const { path: savePath } = (params ?? {}) as { path?: string };
    // Prefab-edit mode deliberately NULLS the scene path so a normal save can't target a real
    // file (prefabEdit.ts) — the human paths honour that via isEditingPrefab(). The agent path
    // must too, and MORE so now that it takes an explicit `path`: without this the op would
    // serialize the SYNTHETIC prefab-edit world (the prefab's entities, expanded, plus the
    // throwaway __PrefabEdit* light/HDR scaffolding) straight over a real scene file, then
    // re-point the scene path and clear the dirty flag — reporting {ok:true}. Worse, the
    // needs-path error below actively STEERS an agent into it ("pass an explicit path"), which
    // is exactly what it hits when the human simply happens to be editing a prefab. (C7)
    if (isEditingPrefab()) {
      throw new Error(
        'save-all: the editor is in PREFAB-EDIT mode — its world is a synthetic prefab scene, ' +
        'not a real one, so saving it to a scene path would overwrite that scene with prefab ' +
        'scaffolding. Use the prefab editor\'s own save (Save Prefab), or leave prefab-edit mode first.',
      );
    }
    const r = await saveAll({ path: savePath, allowDialog: false });
    if (r.saved) return { ok: true, scenePath: r.path };
    if (r.reason === 'needs-path') {
      throw new Error(
        'save-all: this scene has no path yet (new_scene never saved), and the Save-As panel ' +
        'needs a human. Pass an explicit path, e.g. save_all { path: "/assets/scenes/my-scene.json" }.',
      );
    }
    if (r.reason === 'playing') {
      throw new Error('save-all: BLOCKED during Play — saving now would bake the runtime world (physics-settled positions, spawned entities) over your authored scene, and Stop would revert the live world anyway. Stop the editor first (modoki_play_control {action:"stop"}).');
    }
    throw new Error(`save-all FAILED (${r.reason}) for ${r.path ?? '(no path)'} — NOTHING was written to disk.`);
  });

  // ── Entity create / duplicate / delete / reparent ── (undoable, like the menus).
  registerAgentOp('create-entity', (params) => {
    const p = (params ?? {}) as CreateEntityParams;
    if (!p.spec) throw new Error('create-entity requires { spec }');
    // parentGuid (stable) wins over parentId; 0 = root stays literal (never resolved). (C7 re-audit.)
    const parentId = p.parentGuid ? requireLiveId({ guid: p.parentGuid }, 'create-entity parent') : (p.parentId ?? 0);
    const { name, specs } = buildEntityCreateSpecs(p.spec, parentId);
    const id = createEntityWithUndo(`Create ${name}`, parentId, specs as TraitSpec[], (i) => setSelectionRaw(i, i != null ? [i] : []));
    // null = nothing was created. Reporting {id:null} as a success let an agent proceed as
    // if the entity existed — say so instead. (C7)
    if (id == null) throw new Error(`create-entity: nothing was created for spec ${JSON.stringify(p.spec)} (parentId ${parentId})`);
    // Return the GUID, not just the live id. CLAUDE.md's rule is "address entities by
    // {guid}, NEVER {id}" — runtime ids are reassigned on every scene hot-reload, and the
    // file's id space is a DIFFERENT namespace (loadSceneFile remaps them), so a stale id
    // can even resolve to the WRONG entity in a scene file. This path already mints a guid
    // internally and threw it away, leaving the one identifier the docs mandate
    // unobtainable from the tool that creates the entity. (C7)
    return { id, name, guid: ensureGuid(id) };
  });
  registerAgentOp('duplicate-entity', (params) => {
    const p = (params ?? {}) as { id?: number; guid?: string };
    const id = requireLiveId(p, 'duplicate-entity'); // guid wins; throws on a stale ref (C7 re-audit)
    const newId = duplicateEntity(id, (i) => setSelectionRaw(i, i != null ? [i] : []));
    if (newId == null) throw new Error(`duplicate-entity: nothing was duplicated for entity ${id} (does it exist?)`); // C7
    return { id: newId, guid: ensureGuid(newId) }; // stable handle — see create-entity (C7)
  });
  registerAgentOp('delete-entities', (params) => {
    // Accept guids (stable) and/or ids, resolving each to a LIVE id. This closes the C7 residual:
    // a numeric id recycled by a hot-reload passed the old findEntity() guard and deleted a
    // DIFFERENT valid entity (data loss reported as success). A guid resolves to the RIGHT entity
    // or fails — so guid callers can no longer hit the wrong subtree. (C7 re-audit.)
    const p = (params ?? {}) as { ids?: number[]; id?: number; guids?: string[]; guid?: string };
    const refs: Array<{ id?: number; guid?: string }> = [
      ...(p.guids ?? []).map((guid) => ({ guid })),
      ...(p.guid != null ? [{ guid: p.guid }] : []),
      ...(p.ids ?? []).map((id) => ({ id })),
      ...(p.id != null ? [{ id: p.id }] : []),
    ];
    if (!refs.length) throw new Error('delete-entities requires { ids } / { id } or { guids } / { guid }');
    const deleted: number[] = [];
    const missing: Array<{ id?: number; guid?: string }> = [];
    for (const r of refs) {
      const id = resolveLiveId(r);
      if (id == null) missing.push(r);
      else if (!deleted.includes(id)) deleted.push(id);
    }
    if (deleted.length === 0) {
      throw new Error('delete-entities: none of the requested entities exist — nothing was deleted. Runtime ids are reassigned on every scene reload; re-read them with get_scene_state, or address entities by guid.');
    }
    deleteEntitiesWithUndo(deleted, (sel) => setSelectionRaw(sel[0] ?? null, sel));
    return { ok: true, deleted, ...(missing.length ? { skipped: missing, warning: `${missing.length} ref(s) matched no live entity and were skipped (ids are reassigned on scene reload — prefer guid)` } : {}) };
  });
  registerAgentOp('reparent-entity', (params) => {
    // guid (stable) wins over id for BOTH the moved entity and the new parent — the reparent is
    // a structural edit where a recycled id would silently move the wrong node. (C7 re-audit.)
    const p = (params ?? {}) as { id?: number; guid?: string; parentId?: number; parentGuid?: string; sortOrder?: number };
    const id = requireLiveId(p, 'reparent-entity');
    const parentId = p.parentGuid ? requireLiveId({ guid: p.parentGuid }, 'reparent-entity parent') : (p.parentId ?? 0);
    const ok = reparentEntity(id, parentId, p.sortOrder);
    // reparentEntity returns false for a no-op OR a rejected move (self-parent, or a cycle) —
    // {ok:false} alone left the agent unable to tell "done nothing" from "refused, and why". (C7)
    if (!ok) {
      throw new Error(`reparent-entity: refused to move ${id} under ${parentId} — the move is illegal (self-parent, or ${parentId} is a descendant of ${id}).`);
    }
    return { ok };
  });

  // ── Prefab ops ──
  registerAgentOp('prefab', async (params) => {
    const p = (params ?? {}) as PrefabParams;
    if (p.action === 'instantiate') {
      if (!p.path) throw new Error('prefab instantiate requires { path }');
      const prefab = await getPrefabSource(p.path);
      if (!prefab) throw new Error(`prefab not found: ${p.path}`);
      const parentId = p.parentGuid ? requireLiveId({ guid: p.parentGuid }, 'prefab instantiate parent') : (p.parentId ?? 0);
      const rootId = await instantiatePrefabAsync(prefab as PrefabFile, parentId);
      setSelectionRaw(rootId, [rootId]);
      return { ok: true, rootId, guid: ensureGuid(rootId) };
    }
    if (p.action === 'create') {
      if ((p.entityId == null && !p.entityGuid) || !p.path) throw new Error('prefab create requires { entityId | entityGuid, path }');
      const entityId = requireLiveId({ id: p.entityId, guid: p.entityGuid }, 'prefab create'); // guid wins (C7 re-audit)
      const existingId = await resolveExistingPrefabId(p.path);
      const prefab = serializePrefab(entityId, existingId);
      if (!prefab) throw new Error(`could not serialize prefab from entity ${entityId}`);
      const ok = await writePrefabFile(p.path, prefab);
      if (ok) tagEntityTreeAsInstance(entityId, p.path);
      return { ok, source: p.path };
    }
    if (p.action === 'detach') {
      if (p.entityId == null && !p.entityGuid) throw new Error('prefab detach requires { entityId | entityGuid }');
      const entityId = requireLiveId({ id: p.entityId, guid: p.entityGuid }, 'prefab detach'); // guid wins (C7 re-audit)
      const snapshot = detachPrefabInstance(entityId);
      // detachPrefabInstance returns [] for a plain (non-instance) entity. Reporting {ok:true,
      // detached:0} let an agent believe it had unpacked a prefab it hadn't — now a hard failure,
      // matching the other structural ops. (C7 re-audit.)
      if (!snapshot.length) {
        throw new Error(`prefab detach: entity ${entityId} is not a prefab instance (nothing to unpack). Only an instantiated prefab can be detached.`);
      }
      return { ok: true, detached: snapshot.length };
    }
    throw new Error(`unknown prefab action '${(p as { action?: string }).action}'`);
  });

  // ── Phase D: particle / animation first-pass editing (Claude scaffolds, human refines) ──

  // Move the animation playhead (scrub) — drives preview + record insertion point.
  registerAgentOp('set-playhead', (params) => {
    const { t } = (params ?? {}) as { t?: number };
    useEditorStore.getState().setPlayhead(Number(t) || 0);
    return { ok: true, playhead: useEditorStore.getState().playheadTime };
  });

  // Replace a particle effect def — applies LIVE (cache) AND persists to disk.
  registerAgentOp('particle-set', async (params) => {
    const { path, def } = (params ?? {}) as { path?: string; def?: unknown };
    if (!path || !def) throw new Error('particle-set requires { path, def }');
    const { errors, warnings } = validateAssetData('particle', def);
    if (errors.length) return { ok: false, errors, warnings };
    useEditorStore.getState().applyParticleDef(path, def as Parameters<ReturnType<typeof useEditorStore.getState>['applyParticleDef']>[1]);
    await persistAsset(path, 'particle', def);
    return { ok: true, warnings };
  });

  // Replace an animation clip — normalize, apply LIVE, persist.
  registerAgentOp('anim-set-clip', async (params) => {
    const { clipPath, clip } = (params ?? {}) as { clipPath?: string; clip?: unknown };
    if (!clipPath || !clip) throw new Error('anim-set-clip requires { clipPath, clip }');
    const norm = normalizeAnimationClip(clip as Partial<AnimationClipDef>);
    useEditorStore.getState().applyAnimationClip(clipPath, norm);
    await persistAsset(clipPath, 'animation', norm);
    return { ok: true, tracks: norm.tracks.length };
  });

  // Add/update one keyframe at a time — the granular "first-pass timing" primitive.
  // Creates the track if absent. Applies LIVE + persists.
  registerAgentOp('anim-add-key', async (params) => {
    const p = (params ?? {}) as { clipPath?: string; path?: string; trait?: string; field?: string; time?: number; value?: unknown; type?: TrackValueType };
    if (!p.clipPath || !p.trait || !p.field || p.time == null) {
      throw new Error('anim-add-key requires { clipPath, trait, field, time, value }');
    }
    let clip = getAnimationClip(p.clipPath) as AnimationClipDef | null;
    if (!clip) {
      const res = await fetch(p.clipPath, { cache: 'no-store' });
      if (!res.ok) throw new Error(`cannot load clip ${p.clipPath}`);
      clip = normalizeAnimationClip(await res.json());
    }
    // Deep-copy tracks/keys so we don't mutate the cached clip in place.
    const next: AnimationClipDef = { ...clip, tracks: clip.tracks.map((t) => ({ ...t, keys: [...t.keys] })) };
    const relPath = p.path ?? '';
    let track = findTrack(next.tracks, relPath, p.trait, p.field);
    if (!track) { track = { path: relPath, trait: p.trait, field: p.field, type: p.type ?? 'number', keys: [] }; next.tracks.push(track); }
    track.keys = upsertKey(track.keys, Number(p.time), encodeValue(track.type, p.value));
    useEditorStore.getState().applyAnimationClip(p.clipPath, next);
    await persistAsset(p.clipPath, 'animation', next);
    return { ok: true, tracks: next.tracks.length, keys: track.keys.length };
  });

  // Replace a whole timeline — normalize, apply LIVE (the panel + runtime cache), persist.
  registerAgentOp('timeline-set', async (params) => {
    const { timelinePath, timeline } = (params ?? {}) as { timelinePath?: string; timeline?: unknown };
    if (!timelinePath || !timeline) throw new Error('timeline-set requires { timelinePath, timeline }');
    const before = countTimelineItems(timeline as Partial<TimelineDef>);
    const norm = normalizeTimeline(timeline as Partial<TimelineDef>);
    const after = countTimelineItems(norm);
    // normalizeTimeline silently DROPS malformed items WITHIN a track (span end<=start, empty clip/
    // action name, missing audio GUID). Counting surviving TRACKS hid that — a set that lost half its
    // items reported {ok:true, tracks:N}. Mirror timeline-add-clip's pre/post guard so a rejected item
    // is a visible failure, and DON'T persist a lossy write. (F12)
    if (after < before) {
      throw new Error(`timeline-set: ${before - after} of ${before} item(s) rejected by normalization (malformed — span end<=start, empty clip/action name, or missing audio clip GUID). Nothing was saved; fix the items and retry.`);
    }
    useEditorStore.getState().applyTimelineDoc(timelinePath, norm);
    await persistAsset(timelinePath, 'timeline', norm);
    return { ok: true, tracks: norm.tracks.length, items: after };
  });

  // Add ONE item (clip / marker / cue / span) to a timeline track (creating the track if absent).
  // Applies LIVE + persists. `item` is the raw per-kind body; normalization drops it if malformed.
  registerAgentOp('timeline-add-clip', async (params) => {
    const p = (params ?? {}) as { timelinePath?: string; trackType?: TrackKind; target?: string; item?: Record<string, unknown> };
    if (!p.timelinePath || !p.trackType || !p.item) {
      throw new Error('timeline-add-clip requires { timelinePath, trackType, item }');
    }
    let def = getTimeline(p.timelinePath) as TimelineDef | null;
    if (!def) {
      const res = await fetch(p.timelinePath, { cache: 'no-store' });
      if (!res.ok) throw new Error(`cannot load timeline ${p.timelinePath}`);
      def = normalizeTimeline(await res.json());
    }
    const target = p.target ?? '';
    const clone = JSON.parse(JSON.stringify(def)) as TimelineDef;
    let track = clone.tracks.find((t) => t.type === p.trackType && (t.target ?? '') === target);
    if (!track) {
      const base = { id: `track-${clone.tracks.length}`, name: p.trackType, target } as const;
      track = (p.trackType === 'animation' ? { ...base, type: 'animation', clips: [] }
        : p.trackType === 'signal' ? { ...base, type: 'signal', markers: [] }
        : p.trackType === 'audio' ? { ...base, type: 'audio', cues: [] }
        : p.trackType === 'control' ? { ...base, type: 'control', clips: [] }
        : { ...base, type: 'activation', spans: [] }) as TrackDef;
      clone.tracks.push(track);
    }
    // Push the item into the track's per-kind array.
    const arrKey = p.trackType === 'animation' || p.trackType === 'control' ? 'clips' : p.trackType === 'signal' ? 'markers' : p.trackType === 'audio' ? 'cues' : 'spans';
    if (track.type === 'animation') track.clips.push(p.item as unknown as (typeof track.clips)[number]);
    else if (track.type === 'signal') track.markers.push(p.item as unknown as (typeof track.markers)[number]);
    else if (track.type === 'audio') track.cues.push(p.item as unknown as (typeof track.cues)[number]);
    else if (track.type === 'control') track.clips.push(p.item as unknown as (typeof track.clips)[number]);
    else track.spans.push(p.item as unknown as (typeof track.spans)[number]);
    const wantCount = (track as unknown as Record<string, unknown[]>)[arrKey].length;
    const norm = normalizeTimeline(clone);
    // normalizeTimeline DROPS malformed items (span end<=start, empty clip/action) — so verify the
    // pushed item actually survived instead of reporting a false success the agent can't detect.
    const normTrack = norm.tracks.find((t) => t.type === p.trackType && (t.target ?? '') === target);
    const gotCount = normTrack ? (normTrack as unknown as Record<string, unknown[]>)[arrKey].length : 0;
    if (gotCount < wantCount) {
      throw new Error('timeline-add-clip: item rejected by normalization — malformed for a ' + p.trackType + ' track (need: animation clip name non-empty · signal action non-empty · audio clip GUID non-empty · activation end > start · control prefab GUID non-empty OR particle:true OR subdirector:true)');
    }
    useEditorStore.getState().applyTimelineDoc(p.timelinePath, norm);
    await persistAsset(p.timelinePath, 'timeline', norm);
    return { ok: true, tracks: norm.tracks.length, items: gotCount };
  });
}

/** Persist an asset edit through the validated host route (warn-but-write).
 *
 *  THROWS when the write was rejected. It used to `await backendFetch(...)` and discard the
 *  Response — and backendFetch does NOT throw on 4xx/5xx (callsites own their handling; this
 *  one owned none). So every rejection was invisible: a 403 'path outside allowed
 *  directories' (easy to hit — the GUID-only-refs convention encourages passing a guid where
 *  a URL is wanted), a 400 with validation errors, a 500. The ops apply the change LIVE
 *  first, so the viewport visibly updated and the tool returned ok:true while NOTHING reached
 *  disk — the edit then vanished at the next reload. Throwing surfaces the backend's own
 *  actionable message, which was being thrown away. (C7) */
async function persistAsset(path: string, type: 'material' | 'particle' | 'animation' | 'timeline', data: unknown): Promise<void> {
  const res = await backendFetch('/api/asset-write', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, type, data }),
  });
  type WriteReply = { ok?: unknown; error?: unknown; errors?: unknown };
  let body: WriteReply | null = null;
  try { body = (await res.json()) as WriteReply; } catch { /* non-JSON body */ }
  const errors = Array.isArray(body?.errors) ? (body.errors as unknown[]).join('; ') : '';
  if (!res.ok || body?.ok === false || errors) {
    const why = errors || (typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`);
    throw new Error(`saving ${type} '${path}' FAILED: ${why} — the live world was updated but NOTHING was written to disk, so this edit is lost on the next reload.`);
  }
}
