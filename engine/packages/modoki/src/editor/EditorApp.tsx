/** Editor shell — Unity-like dockable panel layout using FlexLayout */

import './EditorApp.css';
import { backendFetch } from './backend/editorBackend';
import { useRef, useState, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Layout, Model, TabNode, Actions, DockLocation } from 'flexlayout-react';
import 'flexlayout-react/style/dark.css';

import { PanelFocusHost } from './input/PanelFocusHost';
import { register } from './input/keymap';
import { useHmrEpoch } from './input/hmrEpoch';
import { installKeymapDispatcher } from './input/dispatcher';
import { setInputGate } from '../runtime/input/inputSources';
import { calibratePresentationScale } from '../runtime/input/presentationScale';
import { forwardZoomWheel } from './input/zoomWheel';
import SceneView from './panels/SceneView';
import Hierarchy from './panels/Hierarchy';
import Inspector from './panels/Inspector';
import Console from './panels/Console';
import Profiler from './panels/Profiler';
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
import FindReferencesDialog from './panels/FindReferencesDialog';
import PublishOtaDialog from './panels/PublishOtaDialog';
import OtaKeysDialog from './panels/OtaKeysDialog';
import PanelErrorBoundary from './panels/PanelErrorBoundary';
import { runSaveAll, toastForSave } from './scene/saveCommand';
import { enterPlay, pausePlay } from './scene/playMode';
import { getPlayState, setPlayState, onPlayStateChange } from '../runtime/core/playState';
import { useEditorStore } from './store/editorStore';
import { setActionCallback } from './undo/entityActions';
import { pushAction, undo, redo, canUndo, canRedo, undoLabel, redoLabel, subscribeUndo, getUndoVersion } from './undo/undoManager';

import { getGameViewComponent, getCustomPanels, getExtraMenus, getExtraMenusVersion, subscribeExtraMenus, getProjectSettings } from './createEditor';
import { dockPanel, toDockLocation } from './panelDock';
import { AUTOSAVE_NAME, isLayoutJson, sanitizeLayoutName, deriveLayoutBaseName } from './utils/layoutNames';
import {
  panelLabel, LAYOUT_NAME_KEY,
  autoDockedPanels, markAutoDocked,
  saveLayout, currentLayoutName,
  writeLayoutJson, writeLayout, downloadLayoutJson, readLayout,
  loadInitialModel, clearStoredLayout, orderLayoutChoices,
} from './utils/layoutStore';

// Wire ECS action callback to editor undo system
setActionCallback(pushAction);

// GameView — injected by createEditor(), or placeholder
const GameViewFallback = () => <div style={{ background: '#1a1a2e', color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}>Game View (not configured)</div>;
const GameView = getGameViewComponent() || GameViewFallback;

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
  profiler: Profiler,
  // Game-specific panels injected via createEditor()
  ...Object.fromEntries(getCustomPanels().map(p => [p.id, p.component])),
};

function resetLayout() {
  clearStoredLayout();
  console.log('[Editor] Layout reset to default');
  // Reload for a clean panel remount (live Three.js/Pixi viewports don't tear
  // down cleanly on an in-place model swap).
  window.location.reload();
}

// ── Menu definitions ────────────────────────────────────

import MenuBar, { type BarMenuItem } from './components/MenuBar';
import { buildMenuSpec } from './menuSpec';

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
  const hmrEpoch = useHmrEpoch();
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

  // ── Publish the open-panel set for the AGENT surface (#301) ──
  // Same walk as isPanelVisible, but collected once and pushed into the store, because
  // `set-focus-scope` runs outside React and has no way to reach the FlexLayout model.
  // Without it that op stored ANY string it was handed and echoed it back, so the
  // `/api/input/key` guard comparing the echo to the input could never fire: a miscased
  // `{panel:"Game"}` reported ok:true while the input gate stayed shut, and every following
  // press reached nothing.
  //
  // ⚠️ Called SYNCHRONOUSLY from the two points where the model can change — never from a
  // `useEffect`. An effect keyed on `layoutVersion` publishes one React commit LATE, and
  // `set-focus-scope` reads the store with a plain `getState()`, so an agent call landing in
  // that window would be answered from the pre-change list: the human closes a tab, the agent
  // focuses it, and the op reports ok for a panel that is already gone. That is the very
  // failure #301 closes, reopened through a timing gap.
  const publishOpenPanels = useCallback((model: Model) => {
    const ids: string[] = [];
    model.visitNodes((node) => {
      if (node.getType() === 'tab') {
        const id = (node as TabNode).getComponent();
        if (id) ids.push(id);
      }
    });
    useEditorStore.getState().setOpenPanels(ids);
  }, []);

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
      publishOpenPanels(m);
      setLayoutName(currentLayoutName()); // may have been cleared if the layout was missing
      setReady(true);
    });
    return () => { alive = false; };
    // publishOpenPanels is a stable useCallback([]) — listed so the mount effect does not
    // silently close over a stale one if that ever gains dependencies.
  }, [publishOpenPanels]);

  // Show a (possibly hidden) panel from the Window menu: focus its tab if it's
  // already open, else dock it back into the Scene tabset (or the first tabset).
  const showPanel = useCallback((id: string) => {
    const model = modelRef.current;
    if (!model) return;
    const loc = getCustomPanels().find((p) => p.id === id)?.dockLocation;
    dockPanel(model, id, panelLabel(id, getCustomPanels()), toDockLocation(loc));
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

  // App-scope shortcuts, now declared in the keymap registry and run by the single
  // dispatcher (focus-scope refactor P3) instead of this file owning a window keydown.
  // All three are `app-chord`: they fire from ANY panel and inside text fields.
  //
  // The play/prefab/run-mode guards deliberately live INSIDE run(), not in a when().
  // A false when() YIELDS the chord (no preventDefault → the Electron menu accelerator
  // fires instead, per plan A.8), which would swallow the explanatory toast the user
  // needs. These commands always CLAIM their chord and then explain themselves.
  useEffect(() => {
    const offs = [
      register({
        id: 'app.saveAll',
        keys: 'mod+s',
        scope: 'app-chord',
        menu: { path: 'File/Save All' },
        run: () => {
          // ⚠️ NO run-mode early return here any more (#259). Saving used to be refused outright
          // unless fully STOPPED, because the live world holds preview state (a pose, a
          // control-spawned prefab) that must not be baked into an authored SCENE. That reasoning
          // covers the scene and nothing else: a `.particle.json` / `.anim.json` the panel owns is
          // authored data in every run mode, and now that the panels park instead of autosaving,
          // refusing here would leave an Animation-Editor user in scrub mode with no way to save
          // the clip they just edited. `saveScene` still refuses the SCENE (it owns that guard);
          // the parked asset docs flush regardless, and the toast says which half happened.
          //
          // ⚠️ AWAIT it and report what happened. Both branches once fired a green toast
          // unconditionally, without awaiting — so a refused save (prefab root not found, a
          // cancelled Save-As, a failed write) told the human their work was safe when nothing had
          // been written. That is the C7 class, and `toastForSave` is where it stays fixed for
          // BOTH entry points at once.
          void runSaveAll().then((o) => {
            const { text, kind } = toastForSave(o);
            if (kind !== 'success') console.warn(`[Editor] ${text}`);
            useEditorStore.getState().showToast(text, kind);
          });
        },
      }),
      register({
        id: 'app.playPause',
        keys: 'mod+p',
        scope: 'app-chord',
        run: () => {
          // Toggles the GameView between Play and Pause. app-chord so it fires regardless of
          // which panel has focus AND while the game is running (the game samples plain keys,
          // so it ignores a meta-chord — no conflict, no double-handling). Reads the LIVE play
          // state: Stopped → enter Play (snapshots the authored world), Playing → Pause,
          // Paused → resume — via the same enterPlay/pausePlay the toolbar buttons use.
          if (getPlayState() === 'playing') pausePlay();
          else void enterPlay();
        },
      }),
      // Undo/redo edit the AUTHORED scene; during Play/Pause the live world is a throwaway
      // snapshot that reverts on Stop, so undoing then would rewrite history against temporary
      // state. Disabled until Stopped — same rule as Save above.
      register({
        id: 'app.undo',
        keys: 'mod+z',
        scope: 'app-chord',
        menu: { path: 'Edit/Undo' },
        run: () => {
          if (getPlayState() !== 'stopped') {
            useEditorStore.getState().showToast('Stop the game to undo — disabled during Play.', 'warn');
            return;
          }
          void undo();
        },
      }),
      register({
        id: 'app.redo',
        keys: 'mod+shift+z',
        scope: 'app-chord',
        menu: { path: 'Edit/Redo' },
        run: () => {
          if (getPlayState() !== 'stopped') {
            useEditorStore.getState().showToast('Stop the game to undo — disabled during Play.', 'warn');
            return;
          }
          void redo();
        },
      }),
    ];
    const offDispatch = installKeymapDispatcher();

    // Focus scoping for the RUNNING GAME (plan P5.1). While an editor panel other than
    // the GameView owns the keyboard, input must not reach the game — otherwise typing
    // WASD in the Hierarchy latches the character's movement keys, and a gamepad drives
    // the game while you edit the Inspector (gamepadSource polls with no guard at all).
    //
    // The policy lives HERE, in the editor. The mechanism lives in the runtime's source
    // registry, because keyboardSource ships inside every game and must never know what
    // a "panel" is. A shipped game never installs a gate.
    //
    // null focus (nothing engaged yet) deliberately does NOT suppress: pressing Play and
    // immediately using WASD has to work without first clicking the GameView.
    setInputGate(() => {
      const p = useEditorStore.getState().focusedPanel;
      return p !== null && p !== 'game';
    });

    return () => {
      setInputGate(null);
      offDispatch();
      for (const off of offs) off();
    };
    // See input/hmrEpoch.ts — 0 in production, so this stays a mount-once effect there.
  }, [hmrEpoch]);

  // Auto-save layout on changes (debounced)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onModelChange = useCallback((model: Model, action?: { type: string; data?: Record<string, unknown> }) => {
    // Refresh the Window menu's visibility checkmarks immediately (a panel was
    // closed/added/moved); the actual save stays debounced below.
    setLayoutVersion((v) => v + 1);
    // Republish the agent-facing open-panel set in the SAME synchronous turn as the change
    // that caused it — see publishOpenPanels for why this cannot be deferred to an effect.
    publishOpenPanels(model);

    // ── Focus follows tab selection (focus-scope refactor P3.0) ──
    // FlexLayout's tab BUTTONS live outside PanelFocusHost, so clicking a tab to bring a
    // panel forward would otherwise leave focus wherever it was — and once keys are
    // scoped, that reads as "the editor ignored me". Driven off the model ACTION rather
    // than the accidental behaviour observed in P2 (where a re-render during pointerdown
    // let the compat mousedown hit-test into the newly-mounted panel — a race, not a rule).
    if (action?.type === 'FlexLayout_SelectTab') {
      const tabId = action.data?.tabNode as string | undefined;
      const node = tabId ? model.getNodeById(tabId) : undefined;
      const component = node instanceof TabNode ? node.getComponent() : undefined;
      if (component) useEditorStore.getState().setFocusedPanel(component);
    }

    // ── Clear focus when the focused panel goes away ──
    // Otherwise focusedPanel names a panel that no longer exists. It degrades safely
    // (that panel's bindings unregistered on unmount, so resolve() yields), but the
    // state would be a lie — and get_editor_state reports it to agents as truth.
    const focused = useEditorStore.getState().focusedPanel;
    if (focused) {
      let stillOpen = false;
      model.visitNodes((n) => {
        if (n instanceof TabNode && n.getComponent() === focused) stillOpen = true;
      });
      if (!stillOpen) useEditorStore.getState().setFocusedPanel(null);
    }

    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const m = modelRef.current;
      if (!m) return;
      saveLayout(m);
      // Also persist a durable "last session" layout so Load Layout always has a
      // recovery point — no "Save Layout As" required first.
      void writeLayout(AUTOSAVE_NAME, m);
    }, 1000);
  }, [publishOpenPanels]);

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
      if (target) model.doAction(Actions.addNode({ type: 'tab', name: panelLabel('skin-editor', getCustomPanels()), component: 'skin-editor' }, target, DockLocation.CENTER, -1, true));
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
    dockPanel(model, id, panelLabel(id, getCustomPanels()), toDockLocation(loc));
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
      return (
        <PanelFocusHost id={component}>
          <PanelErrorBoundary label={label}><Console node={node} /></PanelErrorBoundary>
        </PanelFocusHost>
      );
    }
    // Resolve custom (game-registered) panels LIVE, not just from the PANELS snapshot:
    // PANELS is captured at module-eval, which can race ahead of the async editorPanels()
    // registration, leaving a saved layout's custom tab showing "Unknown panel".
    const Panel = component
      ? (PANELS[component] ?? getCustomPanels().find((p) => p.id === component)?.component ?? null)
      : null;
    if (!Panel) return <div>Unknown panel: {component}</div>;
    return (
      <PanelFocusHost id={component!}>
        <PanelErrorBoundary label={label}><Panel /></PanelErrorBoundary>
      </PanelFocusHost>
    );
  }, []);

  const model = modelRef.current;

  // Reactive undo/redo state for the Edit menu — bumps only when the stacks
  // actually change, so the menu memo below doesn't recompute every render. (F3)
  const undoVersion = useSyncExternalStore(subscribeUndo, getUndoVersion, getUndoVersion);
  // Reactive play state so the Edit menu's Undo/Redo enabled state recomputes on
  // Play/Stop transitions (undo is disabled while Playing — see the Cmd+Z guard).
  const playState = useSyncExternalStore(onPlayStateChange, getPlayState, getPlayState);
  const canEdit = playState === 'stopped';
  // Host-owned menus (Build) can be REPLACED after boot — the device pickers are filled from an
  // async listing that must not block editor start. Bump → rebuild the tree AND re-push the
  // Electron spec, or the OS menu keeps the boot-time labels forever.
  const extraMenusVersion = useSyncExternalStore(subscribeExtraMenus, getExtraMenusVersion, getExtraMenusVersion);

  // Build the menu tree + its serializable Electron spec ONCE per relevant input
  // change (layout name, undo/redo state) instead of on every render. Recomputing
  // unconditionally re-stringified the whole menuSpec and fired an IPC
  // `menu-structure` send on most renders (toasts, import progress, nonces). (F3)
  const { menus, menuSpecJson, menuActionMap } = useMemo(() => {
    void undoVersion; // dep: undo labels/enabled are read via canUndo()/undoLabel() below
    void extraMenusVersion; // dep: getExtraMenus() below is a module registry, read imperatively
    const menus: Record<string, BarMenuItem[]> = {
    File: [
      // New Scene → Assets panel context menu (Create Scene), so it makes a scene
      // FILE. Save Scene As → rename the scene in the Assets window. Both dropped here.
      { label: 'Save All', shortcut: 'Cmd+S', action: () => {
        // ⚠️ This is the NATIVE File-menu twin of the `app.saveAll` keymap handler above, reachable
        // without the shortcut, and it must report the same thing. It did not: the prefab branch
        // was fire-and-forget with no toast at all, so a refused prefab save (root not found,
        // prefab evicted from the editor cache, write rejected) told the user nothing. The keymap
        // handler was fixed first and this duplicate 360 lines away was missed — the exact hazard
        // of having two entry points for one command. Both now call ONE command that returns ONE
        // message (scene/saveCommand.ts), so they cannot disagree again.
        void runSaveAll().then((o) => {
          const { text, kind } = toastForSave(o);
          if (kind !== 'success') console.warn(`[Editor] ${text}`);
          useEditorStore.getState().showToast(text, kind);
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
      label: panelLabel(id, getCustomPanels()),
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
    // Spec + action map are built together by `menuSpec.ts` — they must agree on ids, and the id
    // scheme is load-bearing enough to be unit-tested (see `menuItemId` for why an id carries its
    // label, not just its position).
    const { menuSpec, menuActionMap } = buildMenuSpec(menus);
    return { menus, menuSpecJson: JSON.stringify(menuSpec), menuActionMap };
  }, [layoutName, undoVersion, extraMenusVersion, canEdit, handleSaveLayout, handleSaveLayoutAs, showPanel, isPanelVisible, layoutVersion]);

  // Keep the click-relay's action map current with the latest memoized spec.
  menuActionRef.current = menuActionMap;
  // Push the spec whenever it changes (dynamic labels/enabled, e.g. Undo state).
  useEffect(() => {
    if (electronBridge) electronBridge.send('menu-structure', JSON.parse(menuSpecJson));
  }, [menuSpecJson]);
  // Register the click relay once.
  useEffect(() => {
    if (!electronBridge) return;
    return electronBridge.on('menu-action', (id) => {
      const action = menuActionRef.current[id as string];
      // A miss means the click came from a menu that has since been rebuilt (see the id scheme
      // above) — doing nothing is correct, but it must not be SILENT: to the user their click
      // simply did not work, and this line is the only evidence of why.
      if (!action) { console.warn(`[editor] ignoring a menu click for "${id}" — the menu was rebuilt since it was opened; reopen it and click again`); return; }
      action();
    });
  }, []);
  // Cmd/Ctrl+wheel → whole-app UI zoom (VS Code–style). Forward the intent to main,
  // which owns the webContents zoom (clamp + persist). Capture phase + non-passive so
  // preventDefault sticks and this beats the panel wheel handlers (SceneView camera
  // dolly, sprite/skin canvases) — they fire on a PLAIN wheel and never test ctrl/meta,
  // so a modified wheel is unambiguously ours. No-op in the web editor (browser zooms
  // natively). A macOS trackpad pinch also surfaces as wheel+ctrlKey → pinch-to-zoom too.
  useEffect(() => {
    if (!electronBridge) return;
    const onWheel = (e: WheelEvent) => { forwardZoomWheel(e, electronBridge); };
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => window.removeEventListener('wheel', onWheel, { capture: true });
  }, []);
  // Keep game input presentation-invariant under editor UI zoom: main pushes the authoritative
  // page-zoom factor (on mount + every zoom change), and the engine calibrates its input scale
  // so a game's pixel-based feel (e.g. sling's pull) doesn't drift with zoom. See presentationScale.ts.
  useEffect(() => {
    if (!electronBridge) return;
    return electronBridge.on('zoom-factor', (f) => { if (typeof f === 'number') calibratePresentationScale(f); });
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
      <SceneLoadModal />
      <BuildProgressModal />
      <ToastNotice />
      <ApplyPrefabDialog />
      <RevertPrefabDialog />
      <ProjectSettingsDialog />
      <CleanupAssetsDialog />
      <FindReferencesDialog />
      <BuildSupportDialog />
      <PublishOtaDialog />
      <OtaKeysDialog />
      {showLoad && <LoadLayoutModal onClose={() => setShowLoad(false)} />}
      {showSaveAs && <SaveLayoutAsModal initial={currentLayoutName() || 'default'} onSave={saveLayoutAs} onExport={(name) => { const m = modelRef.current; if (m) downloadLayoutJson(name, m.toJson()); }} onClose={() => setShowSaveAs(false)} />}
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
      // pointerEvents MUST stay 'none': document.elementFromPoint ignores pointer-events:none,
      // so 'auto' would make this an occluder for its whole 3500ms no-click-to-dismiss life —
      // and a covered aim is a REFUSAL, blocking recovery from the very error the toast reports.
      // Selectable error text needs hover-to-persist or a copy button, not this flip (#627).
      maxWidth: '70vw', boxShadow: '0 4px 16px rgba(0,0,0,0.4)', pointerEvents: 'none',
    }}>
      {toast.message}
    </div>
  );
}

// ── Save Layout As Modal ────────────────────────────────
// In-app name prompt (window.prompt() is unsupported in the Electron renderer).

function SaveLayoutAsModal({ initial, onSave, onExport, onClose }: { initial: string; onSave: (name: string) => void; onExport: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.select(); }, []);
  const commit = () => { const n = name.trim(); if (n) onSave(n); };
  const exportToFile = () => { const n = name.trim(); if (n) onExport(n); };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#1e1e30', border: '1px solid #555', borderRadius: 6, padding: '16px 20px', minWidth: 300, fontFamily: 'monospace' }}>
        <div style={{ color: '#fff', fontSize: 13, marginBottom: 12 }}>Save Layout As</div>
        <input
          data-ui-id="layout.saveAs.name"
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
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 12 }}>
          <button data-ui-id="layout.saveAs.export" onClick={exportToFile} title="Download the current layout as a portable .layout.json file (doesn't save it in the project)" style={{ padding: '4px 16px', border: '1px solid #555', borderRadius: 3, background: '#2a2a40', color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11 }}>Export to file…</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button data-ui-id="layout.saveAs.cancel" onClick={onClose} style={{ padding: '4px 16px', border: '1px solid #555', borderRadius: 3, background: '#2a2a40', color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11 }}>Cancel</button>
            <button data-ui-id="layout.saveAs.save" onClick={commit} style={{ padding: '4px 16px', border: '1px solid #3a6', borderRadius: 3, background: '#244', color: '#cfc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11 }}>Save</button>
          </div>
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
      // Pin the auto-saved "last session" to the top with a friendly label; the rest
      // are named layouts (Save Layout As) sorted alphabetically. The rule itself is
      // in layoutStore so it can be tested without mounting this dialog.
      .then((m: { layouts: string[] }) => setLayouts(orderLayoutChoices(m.layouts ?? [])))
      .catch(() => setLayouts([]));
  }, []);

  const load = (name: string) => {
    localStorage.setItem(LAYOUT_NAME_KEY, name);
    window.location.reload(); // reload applies the layout via loadInitialModel (clean panel remount)
  };

  // Download a saved layout as a portable .layout.json — the export counterpart
  // to "Load from file…" below.
  const exportLayout = async (name: string) => {
    const json = await readLayout(name);
    if (!json) { console.error(`[Editor] Failed to read "${name}" for export`); return; }
    downloadLayoutJson(name, json);
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
              <div key={l.name} style={{ display: 'flex', gap: 4 }}>
                <button data-ui-id={`layout.load.${l.name}`} onClick={() => load(l.name)} style={{
                  flex: 1, textAlign: 'left', padding: '6px 10px', border: '1px solid #444', borderRadius: 3,
                  background: '#2a2a40', color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12,
                }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#3a3a5c')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '#2a2a40')}
                >{l.label}</button>
                <button data-ui-id={`layout.export.${l.name}`} onClick={() => exportLayout(l.name)} title="Export to file…" style={{
                  padding: '6px 10px', border: '1px solid #444', borderRadius: 3,
                  background: '#2a2a40', color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12,
                }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#3a3a5c')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = '#2a2a40')}
                >⭳</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 12 }}>
          <button data-ui-id="layout.load.fromFile" onClick={loadFromFile} style={{
            padding: '4px 16px', border: '1px solid #555', borderRadius: 3,
            background: '#2a2a40', color: '#ccc', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11,
          }}>Load from file…</button>
          <button data-ui-id="layout.load.cancel" onClick={onClose} style={{
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

// ── Scene Load Modal ────────────────────────────────────
// Shown while a scene loads — but only after a ~400ms delay, so warm-cache loads
// (the normal case, sub-100ms) never flash it. On a COLD asset cache the load
// bakes textures/models/HDR on demand and can run several seconds; the bar tracks
// resources acquired (loaded/total), each completion being one finished bake.

const SCENE_LOAD_MODAL_DELAY_MS = 400;

function SceneLoadModal() {
  const { active, loaded, total } = useEditorStore((s) => s.sceneLoadStatus);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) { setVisible(false); return; }
    // Arm the delay on load start; if the load finishes first (warm cache), the
    // cleanup cancels the timer and the modal never appears.
    const t = setTimeout(() => setVisible(true), SCENE_LOAD_MODAL_DELAY_MS);
    return () => clearTimeout(t);
  }, [active]);

  if (!active || !visible) return null;
  // `total` is 0 during the pre-count discovery phase (prefab/timeline walk) —
  // show an indeterminate bar until the first onProgress reports the count.
  const determinate = total > 0;
  const pct = determinate ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#1e1e30', border: '1px solid #555', borderRadius: 6,
        padding: '20px 32px', minWidth: 320, maxWidth: 480, textAlign: 'center', fontFamily: 'monospace',
      }}>
        <div style={{ color: '#fff', fontSize: 13, marginBottom: 8 }}>Preparing assets…</div>
        <div style={{ color: '#888', fontSize: 11, marginBottom: 10 }}>
          {determinate ? `Loading assets ${loaded} / ${total}` : 'Reading scene…'}
        </div>
        <div style={{ height: 6, background: '#333', borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
          {determinate ? (
            <div style={{
              height: '100%', width: `${pct}%`, background: '#3498db', borderRadius: 3,
              transition: 'width 0.2s ease',
            }} />
          ) : (
            <div style={{
              height: '100%', width: '40%', background: '#3498db', borderRadius: 3,
              animation: 'importProgress 1.5s ease-in-out infinite',
            }} />
          )}
        </div>
        <div style={{ color: '#666', fontSize: 10 }}>First load bakes textures &amp; models — this can take a moment.</div>
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
