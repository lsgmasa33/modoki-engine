/** Editor shell — Unity-like dockable panel layout using FlexLayout */

import './EditorApp.css';
import { backendFetch } from './backend/editorBackend';
import { useRef, useState, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Layout, Model, TabNode, Actions, DockLocation } from 'flexlayout-react';
import type { IJsonModel } from 'flexlayout-react';
import 'flexlayout-react/style/dark.css';

import SceneView from './panels/SceneView';
import Hierarchy from './panels/Hierarchy';
import Inspector from './panels/Inspector';
import Console from './panels/Console';
import Assets from './panels/Assets';
import ParticleEditor from './panels/ParticleEditor';
import AnimationEditor from './panels/AnimationEditor';
import TimelineEditor from './panels/TimelineEditor';
import SpriteAnimEditor from './panels/SpriteAnimEditor';
import SkinEditor from './panels/SkinEditor';
import AIPanel from './panels/AIPanel';
import ApplyPrefabDialog, { RevertPrefabDialog } from './panels/ApplyPrefabDialog';
import ProjectSettingsDialog from './panels/ProjectSettingsDialog';
import BuildSupportDialog from './panels/BuildSupportDialog';
import CleanupAssetsDialog from './panels/CleanupAssetsDialog';
import PanelErrorBoundary from './panels/PanelErrorBoundary';
import { saveAll } from './scene/serialize';
import { enterPlay, pausePlay } from './scene/playMode';
import { getPlayState, setPlayState, onPlayStateChange, getRunMode, canEdit as canEditMode } from '../runtime/systems/playState';
import { savePrefabEdit, isEditingPrefab } from './scene/prefabEdit';
import { useEditorStore } from './store/editorStore';
import { setActionCallback } from './undo/entityActions';
import { pushAction, undo, redo, canUndo, canRedo, undoLabel, redoLabel, subscribeUndo, getUndoVersion } from './undo/undoManager';

import { getGameViewComponent, getCustomPanels, getExtraMenus, getProjectSettings } from './createEditor';
import { dockPanel, toDockLocation } from './panelDock';
import { AUTOSAVE_NAME, isLayoutJson, sanitizeLayoutName, deriveLayoutBaseName } from './utils/layoutNames';

// Wire ECS action callback to editor undo system
setActionCallback(pushAction);

// GameView — injected by createEditor(), or placeholder
const GameViewFallback = () => <div style={{ background: '#1a1a2e', color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}>Game View (not configured)</div>;
const GameView = getGameViewComponent() || GameViewFallback;

// Default layout — Unity-inspired
const defaultLayout: IJsonModel = {
  global: {
    // Each panel tab shows a ✕ that closes (hides) it; re-show from the Window menu.
    tabEnableClose: true,
    tabSetEnableMaximize: true,
    tabSetEnableTabStrip: true,
    splitterSize: 4,
  },
  borders: [],
  layout: {
    type: 'row',
    weight: 100,
    children: [
      {
        type: 'tabset',
        weight: 15,
        children: [
          { type: 'tab', name: 'Hierarchy', component: 'hierarchy' },
        ],
      },
      {
        type: 'row',
        weight: 55,
        children: [
          {
            type: 'tabset',
            weight: 60,
            children: [
              { type: 'tab', name: 'Scene', component: 'scene' },
            ],
          },
          {
            type: 'tabset',
            weight: 40,
            children: [
              { type: 'tab', name: 'Game', component: 'game' },
              { type: 'tab', name: 'Console', component: 'console' },
              { type: 'tab', name: 'Assets', component: 'assets' },
            ],
          },
        ],
      },
      {
        type: 'tabset',
        weight: 30,
        children: [
          { type: 'tab', name: 'Inspector', component: 'inspector' },
        ],
      },
    ],
  },
};

const PANELS: Record<string, React.ComponentType> = {
  scene: SceneView,
  game: GameView,
  hierarchy: Hierarchy,
  inspector: Inspector,
  console: Console,
  assets: Assets,
  'particle-editor': ParticleEditor,
  'animation-editor': AnimationEditor,
  'timeline-editor': TimelineEditor,
  'spriteanim-editor': SpriteAnimEditor,
  'skin-editor': SkinEditor,
  ai: AIPanel,
  // Game-specific panels injected via createEditor()
  ...Object.fromEntries(getCustomPanels().map(p => [p.id, p.component])),
};

// Human-readable labels for the Window menu (built-in name, else custom panel name).
const PANEL_LABELS: Record<string, string> = {
  scene: 'Scene', game: 'Game', hierarchy: 'Hierarchy', inspector: 'Inspector',
  console: 'Console', assets: 'Assets', 'particle-editor': 'Particle Editor', 'animation-editor': 'Animation', 'timeline-editor': 'Timeline', 'spriteanim-editor': 'Sprite Animation', 'skin-editor': '2D Skin', ai: 'AI',
};
const panelLabel = (id: string): string =>
  PANEL_LABELS[id] ?? getCustomPanels().find((p) => p.id === id)?.name ?? id;

// ── Layout persistence ──────────────────────────────────
//
// Layouts are MACHINE-LOCAL editor working state — NOT engine source or project
// data — so they're stored per-project under <project>/.modoki/layouts/ (a
// gitignored dir), served by the backend /api/layout(s) endpoints. This mirrors
// recent-projects.json; it deliberately does NOT use the asset tree (which would
// write layouts into the engine package and commit them).
//
// The working layout also auto-saves to a reserved "autosave" layout so there's
// ALWAYS a durable, loadable recovery point — the user never has to "Save Layout
// As" before they can load a past layout. localStorage is kept only as an offline
// fast-path mirror. The tracked layout NAME (last loaded/saved) persists in
// localStorage so the association survives a reload.

const LAYOUT_KEY = 'editor-layout';            // localStorage working-state mirror
const LAYOUT_NAME_KEY = 'editor-layout-name';  // name of the tracked layout
const AUTODOCK_KEY = 'editor-autodocked-panels'; // openByDefault panel ids already auto-docked once

/** Panel ids this editor has already auto-docked (so an openByDefault panel appears
 *  once, then respects the user closing it). */
function autoDockedPanels(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(AUTODOCK_KEY) || '[]') as string[]); }
  catch { return new Set(); }
}
function markAutoDocked(ids: string[]): void {
  const s = autoDockedPanels();
  for (const id of ids) s.add(id);
  try { localStorage.setItem(AUTODOCK_KEY, JSON.stringify([...s])); } catch { /* storage full/blocked */ }
}

function saveLayout(model: Model) {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(model.toJson()));
}

function loadLayout(): IJsonModel | null {
  const json = localStorage.getItem(LAYOUT_KEY);
  if (!json) return null;
  try { return JSON.parse(json); }
  catch { return null; }
}

function currentLayoutName(): string | null {
  return localStorage.getItem(LAYOUT_NAME_KEY);
}

/** Write raw layout JSON to <project>/.modoki/layouts/<name>.layout.json. */
async function writeLayoutJson(name: string, content: unknown): Promise<boolean> {
  try {
    const res = await backendFetch('/api/layout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content }),
    });
    return res.ok;
  } catch { return false; }
}

/** Write a layout to <project>/.modoki/layouts/<name>.layout.json. */
function writeLayout(name: string, model: Model): Promise<boolean> {
  return writeLayoutJson(name, model.toJson());
}


/** Read a saved layout by name, or null if it doesn't exist / fetch failed. */
async function readLayout(name: string): Promise<IJsonModel | null> {
  try {
    const res = await backendFetch(`/api/layout?name=${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Build a Model from stored JSON, or null if missing/malformed — so a corrupt or
 *  stale-format saved layout falls back to the next candidate instead of crashing
 *  the editor on mount (Model.fromJson throws on bad input). Self-heals: the bad
 *  entry is overwritten by the next autosave. */
function toModel(json: unknown): Model | null {
  if (!json) return null;
  try {
    const m = Model.fromJson(json as IJsonModel);
    normalizeTabTitles(m);
    return m;
  }
  catch (e) { console.warn('[Editor] ignoring invalid saved layout (falling back):', e); return null; }
}

/** Retitle built-in editor tabs to their current PANEL_LABELS value. Tab names are
 *  derived purely from the component (tabs aren't user-renamable), so a persisted
 *  layout can carry a stale title after a panel is renamed (e.g. Skin → 2D Skin).
 *  Only touches known built-ins, leaving custom-panel tabs alone. */
function normalizeTabTitles(model: Model): void {
  model.visitNodes((node) => {
    if (!(node instanceof TabNode)) return;
    const component = node.getComponent();
    const label = component ? PANEL_LABELS[component] : undefined;
    if (label && node.getName() !== label) {
      model.doAction(Actions.updateNodeAttributes(node.getId(), { name: label }));
    }
  });
}

/** Build the initial layout model: prefer the tracked layout, then the
 *  auto-saved last session, then the localStorage mirror, then the default.
 *  `fromDefault` is true only when nothing was restored — the "first load" signal
 *  that gates openByDefault custom-panel auto-docking (so a panel the user later
 *  closes stays closed on reload). */
async function loadInitialModel(): Promise<{ model: Model; fromDefault: boolean }> {
  const tracked = currentLayoutName();
  if (tracked) {
    const m = toModel(await readLayout(tracked));
    if (m) return { model: m, fromDefault: false };
    localStorage.removeItem(LAYOUT_NAME_KEY); // layout is gone/invalid — drop the stale reference
  }
  const autosaved = toModel(await readLayout(AUTOSAVE_NAME));
  if (autosaved) return { model: autosaved, fromDefault: false };
  const mirror = toModel(loadLayout());
  if (mirror) return { model: mirror, fromDefault: false };
  return { model: Model.fromJson(defaultLayout), fromDefault: true };
}

function resetLayout() {
  localStorage.removeItem(LAYOUT_KEY);
  localStorage.removeItem(LAYOUT_NAME_KEY);
  console.log('[Editor] Layout reset to default');
  // Reload for a clean panel remount (live Three.js/Pixi viewports don't tear
  // down cleanly on an in-place model swap).
  window.location.reload();
}

// ── Menu definitions ────────────────────────────────────

import MenuBar, { type BarMenuItem } from './components/MenuBar';

// ── Main Editor ─────────────────────────────────────────

interface ElectronMenuBridge {
  send(event: string, data: unknown): void;
  on(event: string, cb: (data: unknown) => void): () => void;
}
/** Under Electron the OS-level menu replaces the in-window menu bar; the renderer
 *  pushes its menu structure to main and dispatches clicks relayed back by id.
 *  `null` in the web editor (no Electron bridge), where the in-window bar stays. */
const electronBridge: ElectronMenuBridge | null =
  (typeof window !== 'undefined'
    ? (window as unknown as { __modokiElectron?: { bridge?: ElectronMenuBridge } }).__modokiElectron
    : undefined)?.bridge ?? null;

export default function EditorApp() {
  const modelRef = useRef<Model | null>(null);
  // Latest id → action map for OS-menu clicks (kept in a ref so the once-registered
  // IPC listener always calls the current action).
  const menuActionRef = useRef<Record<string, () => void>>({});
  const [ready, setReady] = useState(false);
  const [layoutName, setLayoutName] = useState<string | null>(() => currentLayoutName());
  const [showLoad, setShowLoad] = useState(false);
  const [showSaveAs, setShowSaveAs] = useState(false);
  // Bumped on every layout change so the Window menu's per-panel visibility
  // (✓ shown / hidden) recomputes when a panel is closed or re-shown.
  const [layoutVersion, setLayoutVersion] = useState(0);

  // Build the initial model (tracked layout → autosave → localStorage → default).
  useEffect(() => {
    let alive = true; // guard against setState after unmount (fast remount / StrictMode)
    loadInitialModel().then(({ model: m, fromDefault }) => {
      if (!alive) return;
      // Force per-tab close buttons on, even for layouts saved before this was the
      // default (the global is baked into each saved layout JSON).
      m.doAction(Actions.updateModelAttributes({ tabEnableClose: true }));
      // Dock any game panel flagged openByDefault — but only the FIRST time this editor
      // ever sees that panel id (tracked in localStorage), OR on a fresh default layout.
      // So a newly-added openByDefault panel appears once even over an existing layout,
      // yet a panel the user then closes stays closed on later loads.
      const docked = autoDockedPanels();
      const newlyDocked: string[] = [];
      for (const p of getCustomPanels()) {
        if (p.openByDefault && (fromDefault || !docked.has(p.id))) {
          dockPanel(m, p.id, p.name, toDockLocation(p.dockLocation));
          newlyDocked.push(p.id);
        }
      }
      if (newlyDocked.length) markAutoDocked(newlyDocked);
      modelRef.current = m;
      setLayoutName(currentLayoutName()); // may have been cleared if the layout was missing
      setReady(true);
    });
    return () => { alive = false; };
  }, []);

  // Show a (possibly hidden) panel from the Window menu: focus its tab if it's
  // already open, else dock it back into the Scene tabset (or the first tabset).
  const showPanel = useCallback((id: string) => {
    const model = modelRef.current;
    if (!model) return;
    const loc = getCustomPanels().find((p) => p.id === id)?.dockLocation;
    dockPanel(model, id, panelLabel(id), toDockLocation(loc));
  }, []);

  // Whether a panel currently has an open tab (drives the Window-menu checkmark).
  // Stable identity (reads the model ref); freshness comes from `layoutVersion` in
  // the menu memo's deps, which re-runs this on every layout change.
  const isPanelVisible = useCallback((id: string): boolean => {
    const model = modelRef.current;
    if (!model) return false;
    let visible = false;
    model.visitNodes((node) => {
      if (node.getType() === 'tab' && (node as TabNode).getComponent() === id) visible = true;
    });
    return visible;
  }, []);

  // Save Layout — write the current layout to the tracked layout (and mirror to
  // localStorage). Falls back to localStorage-only when no layout is tracked.
  const handleSaveLayout = useCallback(async () => {
    const model = modelRef.current;
    if (!model) return;
    saveLayout(model);
    const name = currentLayoutName();
    if (name) {
      const ok = await writeLayout(name, model);
      console.log(ok ? `[Editor] Layout saved → ${name}` : `[Editor] Failed to write "${name}" — saved to localStorage only`);
    } else {
      console.log('[Editor] Layout saved (localStorage — use "Save Layout As..." to name it)');
    }
  }, []);

  // Save Layout As — open the naming modal (window.prompt() throws in Electron, so
  // we use an in-app modal that works in both the Electron and web editors).
  const handleSaveLayoutAs = useCallback(() => setShowSaveAs(true), []);

  // Commit a "Save Layout As": write under <project>/.modoki/layouts/ and track it.
  const saveLayoutAs = useCallback(async (rawName: string) => {
    const model = modelRef.current;
    if (!model) return;
    const name = sanitizeLayoutName(rawName);
    if (!name) return; // empty or the reserved 'autosave' name → reject
    if (!(await writeLayout(name, model))) { console.error(`[Editor] Failed to save layout → ${name}`); return; }
    localStorage.setItem(LAYOUT_NAME_KEY, name);
    saveLayout(model);
    setLayoutName(name);
    setShowSaveAs(false);
    console.log(`[Editor] Layout saved → ${name}`);
  }, []);

  // The editor always opens in edit mode (the runtime defaults to 'playing' for
  // the shipped game). loadScene re-asserts this on every scene load.
  useEffect(() => { setPlayState('stopped'); }, []);

  // Build-Support onboarding (packaged editor only). Open Build Support on launch ONLY
  // when a necessary tool is still missing — NOT unconditionally on first launch. So a
  // user whose core/asset tools are already installed is never nagged (the dialog stays
  // out of the way once setup is done). Fires when:
  //   • toolchainDir non-null → the PACKAGED app only. Dev editors return null here
  //     (no provisioning surface), so `npm run dev` never pops this.
  //   • the user hasn't opted out via the dialog's "Don't show automatically" box
  //     (localStorage 'modoki.buildSupportDismissed').
  //   • a NECESSARY installable tool is missing. "Necessary" EXCLUDES the opt-in MOBILE
  //     build modules (Java/Android SDK for Android, Xcode/CocoaPods for iOS) — those
  //     install on demand when the user actually targets Android/iOS (runBuild opens this
  //     dialog for them). What remains is the cross-platform asset toolchain
  //     (glTF-Transform, gltfpack, ffmpeg, ffprobe), which auto-installs while the dialog
  //     is open — so on a fresh install it opens once, installs them, then stops on its own.
  // Best-effort: any fetch/parse failure is swallowed so it can't block editor load.
  const openBuildSupport = useEditorStore((s) => s.openBuildSupport);
  useEffect(() => {
    if (localStorage.getItem('modoki.buildSupportDismissed')) return;
    let alive = true;
    // Only the mobile build modules are opt-in — they must NOT trigger the auto-open
    // nag (installed on demand when the user actually targets Android/iOS). Everything
    // else auto-installs, so a missing non-mobile tool SHOULD open the dialog.
    const OPTIONAL_TOOLS = new Set(['java', 'android-sdk', 'xcodebuild', 'cocoapods']);
    backendFetch('/api/toolchain')
      .then((r) => r.json())
      .then((j: { toolchainDir?: string | null; tools?: { id: string; present: boolean; installable: boolean }[] }) => {
        if (!alive || !j.toolchainDir) return; // dev editor (null) — nothing to onboard
        const necessaryMissing = (j.tools ?? []).some(
          (t) => t.installable && !t.present && !OPTIONAL_TOOLS.has(t.id),
        );
        if (necessaryMissing) openBuildSupport();
      })
      .catch(() => { /* toolchain status is best-effort; never fail the editor over it */ });
    return () => { alive = false; };
  }, [openBuildSupport]);

  // Cmd+S → Save All
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        // Saving is disabled unless fully STOPPED — while playing/previewing/scrubbing the live
        // world holds mutated/temporary state (a preview pose, a control-spawned prefab). Persisting
        // it would bake preview state into the scene. Stop/exit preview first to save authored data.
        // (saveScene() also refuses on its own — this is the friendly early message; see Phase 2.)
        if (!canEditMode()) {
          const m = getRunMode();
          const msg = m === 'scrub' || m === 'preview'
            ? `Exit timeline ${m} to save — Cmd+S is disabled while previewing (poses revert on exit).`
            : 'Stop the game to save — Cmd+S is disabled during Play (live changes revert on Stop).';
          console.warn(`[Editor] ${msg}`);
          useEditorStore.getState().showToast(msg, 'warn');
          return;
        }
        if (isEditingPrefab()) { savePrefabEdit(); useEditorStore.getState().showToast('Prefab saved', 'success'); }
        // Report what actually happened. This showed a green "Scene saved" unconditionally —
        // not even awaiting saveAll — so a Save-As CANCEL or a failed write (project moved,
        // disk full, permissions) told the HUMAN their work was safe when it was not. (C7)
        else {
          void saveAll().then((r) => {
            const t = useEditorStore.getState().showToast;
            if (r.saved) t('Scene saved', 'success');
            else if (r.reason === 'cancelled') t('Save cancelled — nothing written', 'info');
            else t(`Save FAILED (${r.reason}) — nothing written to disk`, 'warn');
          });
        }
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P')) {
        // Cmd/Ctrl+P toggles the GameView between Play and Pause. A window-level DOM
        // handler + modifier chord: it fires regardless of which panel has focus AND
        // while the game is running (the game samples plain keys, so it ignores a
        // meta-chord — no conflict, no double-handling). Reads the LIVE play state:
        // Stopped → enter Play (snapshots the authored world), Playing → Pause,
        // Paused → resume — via the same enterPlay/pausePlay the toolbar buttons use.
        e.preventDefault();
        if (getPlayState() === 'playing') pausePlay();
        else void enterPlay();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        // Undo/redo edit the AUTHORED scene; during Play/Pause the live world is a
        // throwaway snapshot that reverts on Stop, so undoing then would rewrite
        // history against temporary state. Disabled until Stopped — same rule as
        // Cmd+S above.
        if (getPlayState() !== 'stopped') {
          useEditorStore.getState().showToast('Stop the game to undo — disabled during Play.', 'warn');
          return;
        }
        if (e.shiftKey) redo();
        else undo();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Auto-save layout on changes (debounced)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onModelChange = useCallback(() => {
    // Refresh the Window menu's visibility checkmarks immediately (a panel was
    // closed/added/moved); the actual save stays debounced below.
    setLayoutVersion((v) => v + 1);
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const m = modelRef.current;
      if (!m) return;
      saveLayout(m);
      // Also persist a durable "last session" layout so Load Layout always has a
      // recovery point — no "Save Layout As" required first.
      void writeLayout(AUTOSAVE_NAME, m);
    }, 1000);
  }, []);

  // Opening a .particle.json surfaces the Particle Editor: select its tab if it
  // already exists, else dock a new tab next to the Scene viewport.
  const editingParticle = useEditorStore((s) => s.editingParticleAsset);
  const particleNonce = useEditorStore((s) => s.particleEditNonce);
  useEffect(() => {
    if (!editingParticle) return;
    const model = modelRef.current;
    if (!model) return;
    let tabId: string | null = null;
    let sceneTabsetId: string | null = null;
    let firstTabsetId: string | null = null;
    model.visitNodes((node) => {
      const type = node.getType();
      if (type === 'tab' && (node as TabNode).getComponent() === 'particle-editor') tabId = node.getId();
      if (type === 'tabset') {
        if (!firstTabsetId) firstTabsetId = node.getId();
        const kids = (node as unknown as { getChildren?: () => { getComponent?: () => string }[] }).getChildren?.() ?? [];
        if (kids.some((c) => c.getComponent?.() === 'scene')) sceneTabsetId = node.getId();
      }
    });
    if (tabId) model.doAction(Actions.selectTab(tabId));
    else {
      const target = sceneTabsetId ?? firstTabsetId;
      if (target) model.doAction(Actions.addNode({ type: 'tab', name: 'Particle Editor', component: 'particle-editor' }, target, DockLocation.CENTER, -1, true));
    }
    // Key on the particle's stable path (+ explicit `particleNonce`), not the
    // `editingParticle` object identity — we only re-dock the tab when the open
    // asset actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingParticle?.path, particleNonce]);

  // A texture-editor request (Sprite slicer / 9-slice, incl. the headless
  // open-sprite-editor / open-nine-slice-editor ops) opens a modal that lives inside
  // TextureAssetView — which only mounts when the Inspector tab is ACTIVE. So bring the
  // Inspector tab to front when a request comes in, else a request while another tab
  // (e.g. Particle Editor) is front never mounts the view and the modal never opens.
  const textureEditorReq = useEditorStore((s) => s.textureEditorRequest);
  useEffect(() => {
    if (!textureEditorReq) return;
    const model = modelRef.current;
    if (!model) return;
    let tabId: string | null = null;
    model.visitNodes((node) => {
      if (node.getType() === 'tab' && (node as TabNode).getComponent() === 'inspector') tabId = node.getId();
    });
    if (tabId) model.doAction(Actions.selectTab(tabId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textureEditorReq?.nonce]);

  // Opening a .spriteanim.json surfaces the SpriteAnim Editor: select its tab if it
  // already exists, else dock a new tab next to the Scene viewport (mirrors particle).
  const editingSpriteAnim = useEditorStore((s) => s.editingSpriteAnimAsset);
  const spriteAnimNonce = useEditorStore((s) => s.spriteAnimEditNonce);
  useEffect(() => {
    if (!editingSpriteAnim) return;
    const model = modelRef.current;
    if (!model) return;
    let tabId: string | null = null;
    let sceneTabsetId: string | null = null;
    let firstTabsetId: string | null = null;
    model.visitNodes((node) => {
      const type = node.getType();
      if (type === 'tab' && (node as TabNode).getComponent() === 'spriteanim-editor') tabId = node.getId();
      if (type === 'tabset') {
        if (!firstTabsetId) firstTabsetId = node.getId();
        const kids = (node as unknown as { getChildren?: () => { getComponent?: () => string }[] }).getChildren?.() ?? [];
        if (kids.some((c) => c.getComponent?.() === 'scene')) sceneTabsetId = node.getId();
      }
    });
    if (tabId) model.doAction(Actions.selectTab(tabId));
    else {
      const target = sceneTabsetId ?? firstTabsetId;
      if (target) model.doAction(Actions.addNode({ type: 'tab', name: 'Sprite Animation', component: 'spriteanim-editor' }, target, DockLocation.CENTER, -1, true));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingSpriteAnim?.path, spriteAnimNonce]);

  // Opening a .rig2d.json surfaces the Skin Editor (mirrors spriteanim above).
  const editingSkin = useEditorStore((s) => s.editingSkinAsset);
  const skinNonce = useEditorStore((s) => s.skinEditNonce);
  useEffect(() => {
    if (!editingSkin) return;
    const model = modelRef.current;
    if (!model) return;
    let tabId: string | null = null;
    let sceneTabsetId: string | null = null;
    let firstTabsetId: string | null = null;
    model.visitNodes((node) => {
      const type = node.getType();
      if (type === 'tab' && (node as TabNode).getComponent() === 'skin-editor') tabId = node.getId();
      if (type === 'tabset') {
        if (!firstTabsetId) firstTabsetId = node.getId();
        const kids = (node as unknown as { getChildren?: () => { getComponent?: () => string }[] }).getChildren?.() ?? [];
        if (kids.some((c) => c.getComponent?.() === 'scene')) sceneTabsetId = node.getId();
      }
    });
    if (tabId) model.doAction(Actions.selectTab(tabId));
    else {
      const target = sceneTabsetId ?? firstTabsetId;
      if (target) model.doAction(Actions.addNode({ type: 'tab', name: panelLabel('skin-editor'), component: 'skin-editor' }, target, DockLocation.CENTER, -1, true));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingSkin?.path, skinNonce]);

  // Auto-dock the Animation Editor at the BOTTOM of the Scene tabset when a clip opens
  // (Unity's Animation window lives along the bottom). Mirrors the particle effect above.
  const editingAnimation = useEditorStore((s) => s.editingAnimationAsset);
  const animationNonce = useEditorStore((s) => s.animationEditNonce);
  useEffect(() => {
    if (!editingAnimation) return;
    const model = modelRef.current;
    if (!model) return;
    let tabId: string | null = null;
    let sceneTabsetId: string | null = null;
    let firstTabsetId: string | null = null;
    model.visitNodes((node) => {
      const type = node.getType();
      if (type === 'tab' && (node as TabNode).getComponent() === 'animation-editor') tabId = node.getId();
      if (type === 'tabset') {
        if (!firstTabsetId) firstTabsetId = node.getId();
        const kids = (node as unknown as { getChildren?: () => { getComponent?: () => string }[] }).getChildren?.() ?? [];
        if (kids.some((c) => c.getComponent?.() === 'scene')) sceneTabsetId = node.getId();
      }
    });
    if (tabId) model.doAction(Actions.selectTab(tabId));
    else {
      const target = sceneTabsetId ?? firstTabsetId;
      if (target) model.doAction(Actions.addNode({ type: 'tab', name: 'Animation', component: 'animation-editor' }, target, DockLocation.BOTTOM, -1, true));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingAnimation?.path, animationNonce]);

  // Generic open-panel channel: a store openPanel(id) request (e.g. the Inspector's
  // asset-ref "Open" button for a game panel) docks or focuses that panel's tab.
  const panelOpenRequest = useEditorStore((s) => s.panelOpenRequest);
  useEffect(() => {
    if (!panelOpenRequest) return;
    const model = modelRef.current;
    if (!model) return;
    const { id } = panelOpenRequest;
    const loc = getCustomPanels().find((p) => p.id === id)?.dockLocation;
    dockPanel(model, id, panelLabel(id), toDockLocation(loc));
    // Key on the nonce so a repeat open of the same panel re-focuses it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpenRequest?.nonce]);

  // Auto-dock the Timeline panel bottom of the scene tabset when a .timeline.json opens
  // (mirrors the Animation auto-dock above — Unity's Timeline also lives along the bottom).
  const editingTimeline = useEditorStore((s) => s.editingTimelineAsset);
  const timelineNonce = useEditorStore((s) => s.timelineEditNonce);
  useEffect(() => {
    if (!editingTimeline) return;
    const model = modelRef.current;
    if (!model) return;
    let tabId: string | null = null;
    let sceneTabsetId: string | null = null;
    let firstTabsetId: string | null = null;
    model.visitNodes((node) => {
      const type = node.getType();
      if (type === 'tab' && (node as TabNode).getComponent() === 'timeline-editor') tabId = node.getId();
      if (type === 'tabset') {
        if (!firstTabsetId) firstTabsetId = node.getId();
        const kids = (node as unknown as { getChildren?: () => { getComponent?: () => string }[] }).getChildren?.() ?? [];
        if (kids.some((c) => c.getComponent?.() === 'scene')) sceneTabsetId = node.getId();
      }
    });
    if (tabId) model.doAction(Actions.selectTab(tabId));
    else {
      const target = sceneTabsetId ?? firstTabsetId;
      if (target) model.doAction(Actions.addNode({ type: 'tab', name: 'Timeline', component: 'timeline-editor' }, target, DockLocation.BOTTOM, -1, true));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingTimeline?.path, timelineNonce]);

  const factory = useCallback((node: TabNode) => {
    const component = node.getComponent();
    const label = node.getName();
    // Console reads/writes its level filter from the node config (persisted in layout).
    if (component === 'console') {
      return <PanelErrorBoundary label={label}><Console node={node} /></PanelErrorBoundary>;
    }
    // Resolve custom (game-registered) panels LIVE, not just from the PANELS snapshot:
    // PANELS is captured at module-eval, which can race ahead of the async editorPanels()
    // registration, leaving a saved layout's custom tab showing "Unknown panel".
    const Panel = component
      ? (PANELS[component] ?? getCustomPanels().find((p) => p.id === component)?.component ?? null)
      : null;
    return Panel
      ? <PanelErrorBoundary label={label}><Panel /></PanelErrorBoundary>
      : <div>Unknown panel: {component}</div>;
  }, []);

  const model = modelRef.current;

  // Reactive undo/redo state for the Edit menu — bumps only when the stacks
  // actually change, so the menu memo below doesn't recompute every render. (F3)
  const undoVersion = useSyncExternalStore(subscribeUndo, getUndoVersion, getUndoVersion);
  // Reactive play state so the Edit menu's Undo/Redo enabled state recomputes on
  // Play/Stop transitions (undo is disabled while Playing — see the Cmd+Z guard).
  const playState = useSyncExternalStore(onPlayStateChange, getPlayState, getPlayState);
  const canEdit = playState === 'stopped';

  // Build the menu tree + its serializable Electron spec ONCE per relevant input
  // change (layout name, undo/redo state) instead of on every render. Recomputing
  // unconditionally re-stringified the whole menuSpec and fired an IPC
  // `menu-structure` send on most renders (toasts, import progress, nonces). (F3)
  const { menus, menuSpecJson, menuActionMap } = useMemo(() => {
    void undoVersion; // dep: undo labels/enabled are read via canUndo()/undoLabel() below
    const menus: Record<string, BarMenuItem[]> = {
    File: [
      // New Scene → Assets panel context menu (Create Scene), so it makes a scene
      // FILE. Save Scene As → rename the scene in the Assets window. Both dropped here.
      { label: 'Save All', shortcut: 'Cmd+S', action: () => {
        if (isEditingPrefab()) { savePrefabEdit(); return; }
        void saveAll().then((r) => { // never claim a save that didn't land (C7)
          const t = useEditorStore.getState().showToast;
          if (r.saved) t('Scene saved', 'success');
          else if (r.reason !== 'cancelled') t(`Save FAILED (${r.reason}) — nothing written to disk`, 'warn');
        });
      } },
    ],
    Edit: [
      { label: canUndo() ? `Undo ${undoLabel()}` : 'Undo', shortcut: 'Cmd+Z', disabled: !canEdit || !canUndo(), action: undo },
      { label: canRedo() ? `Redo ${redoLabel()}` : 'Redo', shortcut: 'Cmd+Shift+Z', disabled: !canEdit || !canRedo(), action: redo },
    ],
    Assets: [
      { label: 'Clean Up Unused Assets…', action: () => useEditorStore.getState().openCleanupAssets() },
    ],
    View: [
      { label: layoutName ? `Save Layout (${layoutName})` : 'Save Layout', action: handleSaveLayout },
      { label: 'Save Layout As...', action: handleSaveLayoutAs },
      { label: 'Load Layout...', action: () => setShowLoad(true) },
      { label: '', separator: true },
      { label: 'Reset Layout', action: () => resetLayout() },
    ],
    ...getExtraMenus(),
    // Window stays last (before Help) per the conventional menu-bar order. A ✓
    // marks panels currently open; closing a panel's tab (its ✕) hides it, and
    // picking it here brings it back.
    Window: Object.keys(PANELS).map((id) => ({
      label: panelLabel(id),
      checked: isPanelVisible(id),
      action: () => showPanel(id),
    })),
  };

    // Project Settings — only when the host registered a schema (see createEditor).
    if (getProjectSettings()) {
      menus.File.push(
        { label: '', separator: true },
        { label: 'Project Settings…', action: () => useEditorStore.getState().openProjectSettings() },
      );
    }

    // Under Electron, mirror `menus` into the OS-level application menu instead of
    // the in-window bar: build a serializable spec (no functions cross IPC) + an
    // id → action map, push the spec to main, and dispatch clicks relayed back.
    const menuActionMap: Record<string, () => void> = {};
    const menuSpec = {
      menus: Object.entries(menus).map(([name, items]) => ({
        name,
        items: items.map((it, i) => {
          if (it.separator) return { separator: true };
          const id = `${name}#${i}`;
          if (it.action) menuActionMap[id] = it.action;
          return { id, label: it.label, shortcut: it.shortcut, disabled: it.disabled, checked: it.checked };
        }),
      })),
    };
    return { menus, menuSpecJson: JSON.stringify(menuSpec), menuActionMap };
  }, [layoutName, undoVersion, canEdit, handleSaveLayout, handleSaveLayoutAs, showPanel, isPanelVisible, layoutVersion]);

  // Keep the click-relay's action map current with the latest memoized spec.
  menuActionRef.current = menuActionMap;
  // Push the spec whenever it changes (dynamic labels/enabled, e.g. Undo state).
  useEffect(() => {
    if (electronBridge) electronBridge.send('menu-structure', JSON.parse(menuSpecJson));
  }, [menuSpecJson]);
  // Register the click relay once.
  useEffect(() => {
    if (!electronBridge) return;
    return electronBridge.on('menu-action', (id) => { menuActionRef.current[id as string]?.(); });
  }, []);
  // New Project (Electron): main asks the freshly-opened project to show Project
  // Settings so the user can fill in identity/build info right after creation.
  useEffect(() => {
    if (!electronBridge) return;
    return electronBridge.on('open-project-settings', () => useEditorStore.getState().openProjectSettings());
  }, []);

  if (!ready || !model) {
    return (
      <div style={{ width: '100vw', height: '100vh', background: '#1a1a2e', color: '#666', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace', fontSize: 13 }}>
        Loading editor…
      </div>
    );
  }

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#1a1a2e', display: 'flex', flexDirection: 'column' }}>
      {/* Web editor only — under Electron the OS-level menu replaces this bar. */}
      {!electronBridge && (
        <div style={{ height: 28, background: '#1a1a2e', borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', padding: '0 4px', flexShrink: 0, fontFamily: 'monospace', fontSize: '12px' }}>
          <MenuBar menus={menus} title="Modoki" />
        </div>
      )}
      <div style={{ flex: 1, position: 'relative' }}>
        <Layout
          model={model}
          factory={factory}
          onModelChange={onModelChange}
        />
      </div>
      <ImportProgressModal />
      <BuildProgressModal />
      <ToastNotice />
      <ApplyPrefabDialog />
      <RevertPrefabDialog />
      <ProjectSettingsDialog />
      <CleanupAssetsDialog />
      <BuildSupportDialog />
      {showLoad && <LoadLayoutModal onClose={() => setShowLoad(false)} />}
      {showSaveAs && <SaveLayoutAsModal initial={currentLayoutName() || 'default'} onSave={saveLayoutAs} onClose={() => setShowSaveAs(false)} />}
    </div>
  );
}

// ── Toast Notice ────────────────────────────────────────
// Transient bottom-center banner for save success / blocked-save warnings.

function ToastNotice() {
  const toast = useEditorStore((s) => s.toast);
  if (!toast) return null;
  const tint = toast.kind === 'warn'
    ? { bg: '#3a2d12', border: '#7a5a1a', fg: '#ffd479' }
    : toast.kind === 'success'
      ? { bg: '#13301c', border: '#2e6b3f', fg: '#7ee2a0' }
      : { bg: '#1e1e30', border: '#555', fg: '#ddd' };
  return (
    <div style={{
      position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 10000,
      background: tint.bg, border: `1px solid ${tint.border}`, color: tint.fg,
      padding: '8px 16px', borderRadius: 6, fontFamily: 'monospace', fontSize: 12,
      maxWidth: '70vw', boxShadow: '0 4px 16px rgba(0,0,0,0.4)', pointerEvents: 'none',
    }}>
      {toast.message}
    </div>
  );
}

// ── Save Layout As Modal ────────────────────────────────
// In-app name prompt (window.prompt() is unsupported in the Electron renderer).

function SaveLayoutAsModal({ initial, onSave, onClose }: { initial: string; onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.select(); }, []);
  const commit = () => { const n = name.trim(); if (n) onSave(n); };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#1e1e30', border: '1px solid #555', borderRadius: 6, padding: '16px 20px', minWidth: 300, fontFamily: 'monospace' }}>
        <div style={{ color: '#fff', fontSize: 13, marginBottom: 12 }}>Save Layout As</div>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') onClose(); }}
          placeholder="layout name"
          autoFocus
          style={{
            width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 3,
            border: '1px solid #444', background: '#11111c', color: '#eee', fontFamily: 'monospace', fontSize: 12,
          }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onClose} style={{ padding: '4px 16px', border: '1px solid #555', borderRadius: 3, background: '#2a2a40', color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11 }}>Cancel</button>
          <button onClick={commit} style={{ padding: '4px 16px', border: '1px solid #3a6', borderRadius: 3, background: '#244', color: '#cfc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11 }}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Load Layout Modal ───────────────────────────────────

function LoadLayoutModal({ onClose }: { onClose: () => void }) {
  // `name` is the layout id (used to load); `label` is what's shown.
  const [layouts, setLayouts] = useState<{ name: string; label: string }[] | null>(null);

  useEffect(() => {
    backendFetch('/api/layouts')
      .then((r) => r.json())
      .then((m: { layouts: string[] }) => {
        const names = m.layouts ?? [];
        // Pin the auto-saved "last session" to the top with a friendly label; the
        // rest are named layouts (Save Layout As) sorted alphabetically.
        const autosave = names.filter((n) => n === AUTOSAVE_NAME).map((n) => ({ name: n, label: 'Last session (auto-saved)' }));
        const named = names.filter((n) => n !== AUTOSAVE_NAME).sort((a, b) => a.localeCompare(b)).map((n) => ({ name: n, label: n }));
        setLayouts([...autosave, ...named]);
      })
      .catch(() => setLayouts([]));
  }, []);

  const load = (name: string) => {
    localStorage.setItem(LAYOUT_NAME_KEY, name);
    window.location.reload(); // reload applies the layout via loadInitialModel (clean panel remount)
  };

  // Load an arbitrary .layout.json from anywhere on disk (file picker works in
  // both Electron and web). The file is imported into the project under its base
  // name, tracked, and applied — so it also shows up in the list afterward.
  const loadFromFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        if (!isLayoutJson(parsed)) { console.error('[Editor] Not a valid layout file (missing "layout")'); return; }
        const name = deriveLayoutBaseName(file.name);
        if (!(await writeLayoutJson(name, parsed))) { console.error('[Editor] Failed to import layout'); return; }
        load(name);
      } catch (e) {
        console.error('[Editor] Failed to read layout file:', e);
      }
    };
    input.click();
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#1e1e30', border: '1px solid #555', borderRadius: 6, padding: '16px 20px', minWidth: 280, maxWidth: 360, fontFamily: 'monospace' }}>
        <div style={{ color: '#fff', fontSize: 13, marginBottom: 12 }}>Load Layout</div>
        {layouts === null ? (
          <div style={{ color: '#888', fontSize: 12 }}>Loading…</div>
        ) : layouts.length === 0 ? (
          <div style={{ color: '#888', fontSize: 12 }}>No saved layouts yet. Rearrange a panel (auto-saves a "Last session"), or use "Save Layout As..." to name one.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
            {layouts.map((l) => (
              <button key={l.name} onClick={() => load(l.name)} style={{
                textAlign: 'left', padding: '6px 10px', border: '1px solid #444', borderRadius: 3,
                background: '#2a2a40', color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12,
              }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#3a3a5c')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '#2a2a40')}
              >{l.label}</button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 12 }}>
          <button onClick={loadFromFile} style={{
            padding: '4px 16px', border: '1px solid #555', borderRadius: 3,
            background: '#2a2a40', color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11,
          }}>Load from file…</button>
          <button onClick={onClose} style={{
            padding: '4px 16px', border: '1px solid #555', borderRadius: 3,
            background: '#2a2a40', color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11,
          }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── Import Progress Modal ───────────────────────────────

function ImportProgressModal() {
  const { active, message, step, totalSteps, failed } = useEditorStore((s) => s.importStatus);
  const dismiss = () => useEditorStore.getState().setImportStatus(false);
  if (!active) return null;
  const determinate = totalSteps > 0;
  const pct = determinate ? Math.min(100, Math.round((step / totalSteps) * 100)) : 0;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#1e1e30', border: '1px solid #555', borderRadius: 6,
        padding: '20px 32px', minWidth: 320, maxWidth: 560, textAlign: 'center', fontFamily: 'monospace',
      }}>
        {failed ? (
          // Import threw (e.g. unsupported source format) — show the reason +
          // an OK button instead of leaving the modal spinning or the error as
          // an unhandled rejection.
          <>
            <div style={{ color: '#e74c3c', fontSize: 13, marginBottom: 8 }}>Import Failed</div>
            <div style={{ color: '#ccc', fontSize: 11, marginBottom: 12, whiteSpace: 'pre-wrap' }}>{message}</div>
            <button onClick={dismiss} style={{
              padding: '4px 16px', border: '1px solid #555', borderRadius: 3,
              background: '#2a2a40', color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11,
            }}>
              OK
            </button>
          </>
        ) : (
          <>
            <div style={{
              color: '#fff', fontSize: 13, marginBottom: 8,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{message || 'Importing model...'}</div>
            {determinate && (
              <div style={{ color: '#888', fontSize: 11, marginBottom: 10 }}>
                {step} / {totalSteps}
              </div>
            )}
            <div style={{ height: 4, background: '#333', borderRadius: 2, overflow: 'hidden' }}>
              {determinate ? (
                <div style={{
                  height: '100%', width: `${pct}%`, background: '#2ecc71', borderRadius: 2,
                  transition: 'width 0.2s ease',
                }} />
              ) : (
                <div style={{
                  height: '100%', width: '40%', background: '#2ecc71', borderRadius: 2,
                  animation: 'importProgress 1.5s ease-in-out infinite',
                }} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Build Progress Modal ───────────────────────────────

function BuildProgressModal() {
  const { active, message, step, totalSteps, failed, errorDetail } = useEditorStore((s) => s.buildStatus);
  const dismiss = () => useEditorStore.getState().setBuildStatus({ active: false, failed: false, step: 0, errorDetail: undefined });
  const [copied, setCopied] = useState(false);
  const copyError = async () => {
    if (!errorDetail) return;
    try {
      await navigator.clipboard.writeText(errorDetail);
    } catch {
      // Fallback for contexts where the async clipboard API is blocked.
      const ta = document.createElement('textarea');
      ta.value = errorDetail;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!active) return null;
  const pct = totalSteps > 0 ? Math.round((step / totalSteps) * 100) : 0;
  const done = step >= totalSteps && !failed;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#1e1e30', border: '1px solid #555', borderRadius: 6,
        padding: '20px 32px', minWidth: 320, textAlign: 'center', fontFamily: 'monospace',
      }}>
        <div style={{ color: '#fff', fontSize: 13, marginBottom: 8 }}>
          {failed ? 'Build Failed' : done ? 'Build Complete!' : 'Building...'}
        </div>
        <div style={{ color: '#888', fontSize: 11, marginBottom: 12 }}>{message}</div>
        <div style={{ height: 6, background: '#333', borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
          <div style={{
            height: '100%',
            width: done ? '100%' : `${pct}%`,
            background: failed ? '#e74c3c' : done ? '#2ecc71' : '#3498db',
            borderRadius: 3,
            transition: 'width 0.3s ease',
          }} />
        </div>
        <div style={{ color: '#666', fontSize: 10 }}>
          {failed ? (errorDetail ? 'Error output below (also in Console)' : 'Check Console for details') : done ? '' : `Step ${step} / ${totalSteps}`}
        </div>
        {failed && errorDetail && (
          <pre style={{
            marginTop: 10, textAlign: 'left', maxWidth: 560, maxHeight: 220, overflow: 'auto',
            background: '#120d12', border: '1px solid #5a2a2a', borderRadius: 4, padding: '8px 10px',
            color: '#f0a0a0', fontSize: 10, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            // The editor sets `user-select: none` app-wide (App.css) for a native
            // feel; re-enable selection here so the error can be selected/copied.
            userSelect: 'text', WebkitUserSelect: 'text', cursor: 'text',
          }}>{errorDetail}</pre>
        )}
        {(done || failed) && (
          <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center' }}>
            {failed && errorDetail && (
              <button onClick={copyError} style={{
                padding: '4px 16px', border: '1px solid #555', borderRadius: 3,
                background: copied ? '#264a2e' : '#2a2a40', color: copied ? '#7ee29a' : '#ccc',
                cursor: 'pointer', fontFamily: 'monospace', fontSize: 11,
              }}>
                {copied ? '✓ Copied' : 'Copy error'}
              </button>
            )}
            <button onClick={dismiss} style={{
              padding: '4px 16px', border: '1px solid #555', borderRadius: 3,
              background: '#2a2a40', color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11,
            }}>
              OK
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
