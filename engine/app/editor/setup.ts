/** Game editor setup — configures @modoki/engine/editor generically from the
 *  OPEN PROJECT's game (virtual:modoki-games). No game is imported by path: the
 *  editor reads the project's game(s), runs each game's config (for its
 *  scene-callback side effects) + postprocessors + systems + editor bindings,
 *  then builds the editor around the default game's config. Async because those
 *  registrations come through the game's import() loaders — safe, since the
 *  editor route is lazy + Suspense (see App.tsx EditorApp). */

import { createElement } from 'react';
import type React from 'react';
import {
  createEditor, setExtraMenus, useEditorStore, backendFetch, backendEventSource, fetchDeviceList,
  type ExtraMenuItem, type DeviceListReply,
} from '@modoki/engine/editor';
import { GameView } from '@modoki/engine/editor/rendering';
import { PlayerPrefs, selectDefaultBackend, setGameConfig, setPhysicsLayers } from '@modoki/engine/runtime';
import type { GameConfig, EditorPanelDef } from '@modoki/engine/runtime';
import projectConfig from 'virtual:modoki-project-config';
import {
  CAPACITOR_ORIENTATIONS, STATUS_BAR_STYLES, AUDIO_SESSION_CATEGORIES, KEYBOARD_RESIZE_MODES, WEB_DEPLOY_MODES, WEB_SIZE_MODES,
  PLAYABLE_NETWORKS, IOS_CONTENT_MODES, ANDROID_SCHEMES, GPU_BACKENDS, QUALITY_TIERS, TONE_MAPPINGS,
  TEXTURE_TIER_VARIANTS_MODES,
  IOS_EXPORT_METHODS,
} from '../../project-config';
import { loadProjectGames } from '../projectGames';
import { registerAll } from '../ecs/register';
import { DefaultGameUILayer } from '../ui/DefaultGameUILayer';
import { registerEditorAgentOps } from './agentEditorOps';
import {
  iosTargetRows, androidTargetRows, iosTargetSummary, androidTargetSummary, buildRefusal, pickRefusal,
  type DeviceTarget, type DeviceTargetPatch, type TargetRow,
} from './buildTargetMenu';
import { addGameBootFault, describeGameBootFaults } from './gameBootFaults';

// Wrap modoki GameView with game-specific UI layer
function GameViewWithUI() {
  return createElement(GameView, { uiLayer: createElement(DefaultGameUILayer) });
}

/** Minimal config for an empty project (no games) so the editor still mounts. */
const EMPTY_CONFIG: GameConfig = { name: 'Empty Project', sceneSetup: () => {}, initWorld: () => {} };

/** Pair a project-config union constant with its human-readable labels for a
 *  `select` field's options. `Record<T, string>` makes a missing/misspelled
 *  member a compile error — the union constant and the dialog can never drift. */
const labeled = <T extends string>(vals: readonly T[], labels: Record<T, string>) =>
  vals.map((v) => ({ value: v as string, label: labels[v] }));

/** Run one game-provided boot hook, converting a throw into a recorded fault instead of
 *  letting it reject `createGameEditor()` and take the whole editor down with it.
 *  See `./gameBootFaults` for the full rationale. */
async function runGameHook(gameId: string, phase: string, hook?: () => unknown): Promise<void> {
  if (!hook) return;
  try {
    await hook();
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    addGameBootFault({ gameId, phase, message });
    console.error(
      `[editor] game "${gameId}" ${phase}() FAILED — the editor is booting anyway, with this ` +
      `game's registrations INCOMPLETE. Scene entities that rely on its systems/traits will ` +
      `not behave correctly until the error below is fixed and the editor reloads.`,
      err,
    );
  }
}

/** Trigger a build + deploy via the dev server's SSE endpoint */
async function runBuild(platform: 'ios' | 'android' | 'web' | 'playable', variant: 'debug' | 'release' = 'debug') {
  // Refuse a SECOND concurrent build (see `buildRefusal` for what two at once actually do to the
  // project dir). The DOM progress modal does not gate this: under Electron the build items live
  // in the native application menu, which a modal cannot cover.
  const refusal = buildRefusal(useEditorStore.getState().buildStatus);
  if (refusal) { useEditorStore.getState().showToast(refusal, 'warn'); return; }
  // Tool gate: if a native build's required tools aren't installed, OPEN Build Support
  // (where they install with one click / auto-install) instead of starting a build that
  // would just fail at the server preflight. Turns the dead-end into a fix. Web and
  // playable have no native tool to preflight, so they're never gated here (they can
  // still fail on config, which is surfaced by the build itself). Best-effort — on any
  // fetch error we fall through to the build, whose own preflight still guards.
  if (platform !== 'web' && platform !== 'playable') {
    try {
      const status = await backendFetch('/api/toolchain').then((r) => r.json());
      const pf = status?.preflight?.[platform];
      if (pf && pf.ready === false) {
        useEditorStore.getState().openBuildSupport();
        return;
      }
    } catch { /* fall through to the build (its preflight still fails friendly) */ }
  }
  // #370: `variant` is omitted for a debug build so the request stays byte-identical to what every
  // pre-release caller sent — the server's default is `debug` for the same reason.
  const q = variant === 'release' ? `?platform=${platform}&variant=release` : `?platform=${platform}`;
  runStream(`/api/build${q}`, 5, `${platform}${variant === 'release' ? ' release' : ''} build`, 'Starting build...');
}

// ── Build → device target picker (#170) ──────────────────────────────────────────────────────
// The Build menu names the device it will build for, and its submenu switches it. The listing is
// fetched ONCE after boot (two `xcrun` shell-outs — never on the click path, and never blocking
// editor start) plus on the submenu's explicit "Refresh devices"; Electron gives no will-open
// event for an application menu, so there is nothing cheaper to hook.
let deviceList: DeviceListReply | null = null;
let deviceTarget: DeviceTarget = { iosDeviceId: '', iosDevicectlId: '', androidDeviceId: '' };
/** Re-render the Build menu from the state above — installed once the editor exists. */
let republishBuildMenu: (() => void) | null = null;

/** Read the ids the next build will use, straight from the same route Project Settings saves to,
 *  so the two can never disagree about what the target is. */
async function loadDeviceTarget(): Promise<void> {
  try {
    const r = await backendFetch('/api/project-settings');
    if (!r.ok) return;
    const j = (await r.json()) as { user?: { device?: Partial<DeviceTarget> } };
    const d = j.user?.device;
    if (d) deviceTarget = { iosDeviceId: d.iosDeviceId ?? '', iosDevicectlId: d.iosDevicectlId ?? '', androidDeviceId: d.androidDeviceId ?? '' };
  } catch { /* backend not up — the menu shows "no device set", which is honest */ }
}

/** Sequence token for the listing fetch. Two refreshes can be in flight (the boot one takes
 *  1.6-2.9s of `xcrun`, and "Refresh devices" is one click), they take VARIABLE time, and without
 *  this the slower-but-older response lands last and overwrites the newer listing — the menu then
 *  shows devices that were correct two seconds ago. Only `deviceList` needs it: `deviceTarget` is
 *  re-read from disk, so a stale one cannot disagree with what the build will use. */
let deviceListGeneration = 0;

async function refreshDeviceTargets(): Promise<void> {
  const generation = ++deviceListGeneration;
  const [list] = await Promise.all([fetchDeviceList(), loadDeviceTarget()]);
  if (generation !== deviceListGeneration) return; // a newer refresh already answered
  deviceList = list;
  republishBuildMenu?.();
}

/** Write a picked device into project.user.json, then BUILD to it. A PARTIAL patch
 *  (`/api/project-settings` deep-merges), so the machine's other per-machine settings — and any
 *  device id typed by hand into a field this menu does not offer — are left exactly as they were.
 *
 *  Picking builds because that is the motion the picker exists for: you open it to put this build
 *  on THAT phone, and a select-then-confirm split makes the common case two trips through a menu.
 *  The build is started only once the write has LANDED — a build against a target that failed to
 *  save would go to the previous device while the menu claimed otherwise. Nothing can stop a build
 *  once it starts (the progress modal only dismisses its own UI), which is why the submenu also
 *  offers a set-without-building route out to Project Settings. */
async function pickDeviceTarget(patch: DeviceTargetPatch, andBuild?: 'ios' | 'android'): Promise<void> {
  const { showToast } = useEditorStore.getState();
  // Refuse while Project Settings is open — see `pickRefusal`: that dialog would write back the
  // device it snapshotted when it opened, silently undoing this pick on its next Save.
  const refusal = pickRefusal(useEditorStore.getState().projectSettingsOpen);
  if (refusal) { showToast(refusal, 'warn'); return; }
  try {
    const r = await backendFetch('/api/project-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { device: patch } }),
    });
    if (!r.ok) {
      // Never leave the menu showing a target that was not written — the next build would go
      // somewhere else entirely, and the ✓ would be the reason nobody noticed.
      const msg = await r.json().then((j: { error?: string }) => j?.error).catch(() => undefined);
      showToast(`Could not set the build target: ${msg || `HTTP ${r.status}`}`, 'warn');
      return;
    }
  } catch (e) {
    showToast(`Could not set the build target: ${e instanceof Error ? e.message : String(e)}`, 'warn');
    return;
  }
  deviceTarget = { ...deviceTarget, ...patch };
  republishBuildMenu?.();
  if (andBuild) void runBuild(andBuild);
}

/** One target row → a menu item. A disabled row is an explanation (nothing attached, adb missing,
 *  the configured device unplugged) and carries no action. */
const targetItem = (row: TargetRow, platform: 'ios' | 'android'): ExtraMenuItem => ({
  label: row.label,
  checked: row.checked,
  ...(row.disabled || !row.patch ? { disabled: true } : { action: () => void pickDeviceTarget(row.patch!, platform) }),
});

/** Scaffold a native target (cap add + deps + config + heal) in one action. */
function runAddNativeTarget(platform: 'ios' | 'android') {
  runStream(`/api/add-native-target?platform=${platform}`, 5, `add ${platform} target`, `Adding ${platform} target...`);
}

/** Drive a build-family SSE endpoint into the BuildProgressModal. Shared by the
 *  build + deploy and the "Add Native Target" actions (same event protocol:
 *  `message` log lines, `step` {step,total}, `status` DONE|FAILED:…|<progress>). */
function runStream(streamPath: string, totalSteps: number, logTag: string, startMessage: string) {
  const { setBuildStatus } = useEditorStore.getState();
  setBuildStatus({ active: true, message: startMessage, step: 0, totalSteps, failed: false });
  console.log(`[Build] ${startMessage} (${logTag})`);

  const es = backendEventSource(streamPath);

  es.addEventListener('step', (e) => {
    const { step, total } = JSON.parse((e as MessageEvent).data) as { step: number; total: number };
    setBuildStatus({ step, totalSteps: total });
  });

  es.addEventListener('status', (e) => {
    const status = JSON.parse((e as MessageEvent).data) as string;
    if (status === 'DONE') {
      // Set step to the FULL count so the modal's `done = step >= totalSteps`
      // becomes true → it shows "Build Complete!" + the OK dismiss button. The
      // step count is platform-dependent (web = 6, ios/android = 5), so a
      // hardcoded value (was `step: 5`) leaves web at 5/6 → done=false → the
      // dialog hangs with no way to close. The server's final sendStep(total,
      // total) already set this; just don't clobber it back down.
      const { totalSteps } = useEditorStore.getState().buildStatus;
      setBuildStatus({ step: totalSteps, message: 'Complete!' });
      console.log(`[Build] ✅ ${logTag} complete!`);
      es.close();
    } else if (status.startsWith('FAILED')) {
      const details = status.slice('FAILED:'.length).trim();
      const failedStep = details.split('\n')[0] || 'unknown step';
      const errorLines = details.split('\n').slice(1).join('\n');
      setBuildStatus({ failed: true, message: `Failed at: ${failedStep}`, errorDetail: errorLines });
      console.error(`[Build] ❌ ${logTag} failed at: ${failedStep}`);
      if (errorLines) console.error(`[Build] Error details:\n${errorLines}`);
      es.close();
    } else {
      setBuildStatus({ message: status });
    }
  });

  // Forward build output to console
  es.addEventListener('message', (e) => {
    const line = JSON.parse((e as MessageEvent).data) as string;
    if (line) console.log(`[Build] ${line}`);
  });

  es.onerror = () => {
    setBuildStatus({ failed: true, message: 'Connection lost' });
    console.error('[Build] Connection lost');
    es.close();
  };
}

/** Async factory: register every project game (configs for scene-callback side
 *  effects, postprocessors, systems, editor bindings), then build the editor
 *  around the default game's config. Returns a lazy-friendly `{ default }`.
 *  App.tsx calls this behind React.lazy + Suspense. */
export async function createGameEditor(): Promise<{ default: React.ComponentType }> {
  // 0. Load the open project's games at runtime (C4c) — dev editor pulls them
  //    from the project registry over the backend; packaged/web use the baked
  //    virtual module. Replaces the static `virtual:modoki-games` import.
  const { ALL_GAMES } = await loadProjectGames();

  // 1. Load the game's config — running the config module registers its scene
  //    callbacks. One project = one game (#29), so this is just the first
  //    loadable game in the set.
  let defaultConfig: GameConfig | undefined;
  let chosenGameId: string | undefined;
  for (const g of ALL_GAMES) {
    // A failed config used to vanish into `.catch(() => undefined)` and silently degrade the
    // project to EMPTY_CONFIG — the editor would open on the WRONG config with no hint why.
    // Record it like every other game-code fault.
    let cfg: GameConfig | undefined;
    await runGameHook(g.id, 'loadConfig', async () => { cfg = await g.loadConfig(); });
    if (cfg && !defaultConfig) {
      defaultConfig = cfg;
      chosenGameId = g.id;
    }
  }
  defaultConfig ??= EMPTY_CONFIG;

  // 1b. Hydrate PlayerPrefs BEFORE registerSystems/scene load, so a game system that reads
  //     saved progress at spawn sees it — same ordering rationale as `GameShell` in App.tsx.
  //
  //     Why this exists at all: `PlayerPrefs.init` was called ONLY in `GameShell`, and App.tsx
  //     renders `EditorApp` INSTEAD of `GameShell` on the `#/editor` route. So a game played in
  //     the editor never initialised prefs and silently ran on the in-memory default backend —
  //     every save alive until Stop or a reload, nothing on disk. Found from play: Court's level
  //     resume pointed back at level 1 after a Stop/Play, and `localStorage` held ZERO `mk:` keys
  //     while being perfectly writable. The resume code was fine; it was reading an empty box.
  //
  //     ISOLATED namespace (owner's call): editor play must NOT share saved data with a real
  //     build of the same game. Same origin + same namespace would mean playtest experiments
  //     writing into the save a web build reads. `@editor` is a suffix the game's own namespace
  //     can never produce, so the two stores can't collide.
  if (chosenGameId) {
    const prefsInit = await PlayerPrefs.init({
      namespace: `${chosenGameId}@editor`,
      backend: selectDefaultBackend(),
    });
    // `createGameEditor()` runs once per page load (memoized by `React.lazy`), so there is no
    // "previous game" to name at this call site — File → Open Project reloads the page (see
    // CLAUDE.md § Editor Hot Reload), so `PlayerPrefs` was never hydrated for another game in
    // this process. Name the game being opened; that's the whole context this site has.
    if (prefsInit.discardedPending.length > 0) {
      console.error(
        `[EditorApp] PlayerPrefs.init() discarded pending write(s) opening "${chosenGameId}" in the ` +
          `editor: ${prefsInit.discardedPending.join(', ')}`,
      );
    }
  }

  // 2. setGameConfig before registerAll (which reads nameTransform).
  setGameConfig(defaultConfig);

  // 3. Register each game's postprocessors + systems + editor bindings up front
  //    (the editor lists/inspects all games). Sequential = deterministic order.
  //    Also collect any game-registered dockable editor panels — the lazy
  //    editorPanels() loader keeps its (editor-only) module off the game bundle.
  const gamePanels: EditorPanelDef[] = [];
  for (const g of ALL_GAMES) {
    // Each hook is independently guarded: one broken module must not prevent the REST of the
    // project (or the editor itself) from registering. `editorPanels` was already guarded —
    // its three siblings were not, and that asymmetry was the whole bug.
    await runGameHook(g.id, 'registerPostprocessors', () => g.registerPostprocessors?.());
    await runGameHook(g.id, 'registerSystems', () => g.registerSystems?.());
    await runGameHook(g.id, 'registerEditorBindings', () => g.registerEditorBindings?.());
    if (g.editorPanels) {
      await runGameHook(g.id, 'editorPanels', async () => {
        gamePanels.push(...(await g.editorPanels!()));
      });
    }
  }

  // 4. Engine trait registration.
  registerAll();

  // 5. Register editor agent ops into the bridge registry so an AI agent gets
  //    full editor parity (selection, play, undo, scene/prefab/entity actions,
  //    the editor-state read). Editor-only — kept off the game bundle by living
  //    behind this lazy path. Works in dev (Vite HMR relay) AND the packaged DMG
  //    (Electron IPC relay): same agentBridge transport.
  registerEditorAgentOps();

  // Build menu labels reflect the OPEN project (one project = one game): the
  // device builds carry the project's appName, and the web deploy shows its real
  // target derived from build.webBasePath (not a hardcoded "/demo").
  const appName = projectConfig.app.appName || 'app';
  const webBase = (projectConfig.build.webBasePath || '/').replace(/\/+$/, '');
  const webLabel = `Web → modoki-engine.com${webBase}`;

  // Discover the project's scenes for the Scenes tab (value = guid, label = file
  // name). Read server-side from the manifest — resilient to a missing backend.
  let sceneOptions: { value: string; label: string }[] = [];
  try {
    const r = await backendFetch('/api/scenes');
    if (r.ok) {
      const j = (await r.json()) as { scenes?: { path: string; guid?: string }[] };
      sceneOptions = (j.scenes ?? [])
        .filter((s): s is { path: string; guid: string } => typeof s.guid === 'string')
        .map((s) => ({ value: s.guid, label: s.path.split('/').pop() || s.path }));
    }
  } catch { /* backend not up yet — Scenes tab shows the empty hint */ }

  // Discover the machine's Apple signing teams for the iOS Team ID dropdown
  // (value = 10-char Team ID, label = "Name (ID)"). Best-effort; macOS-only.
  let teamOptions: { value: string; label: string }[] = [];
  try {
    const r = await backendFetch('/api/signing-teams');
    if (r.ok) {
      const j = (await r.json()) as { teams?: { id: string; name: string; hasProfile?: boolean }[] };
      teamOptions = (j.teams ?? []).map((t) => ({
        value: t.id,
        label: `${t.name} (${t.id})${t.hasProfile ? '' : ' — cert only'}`,
      }));
    }
  } catch { /* backend not up / not macOS — field stays a free-text box */ }

  // iOS builds require macOS + Xcode — impossible on Windows/Linux (Apple restriction),
  // so gray out the iOS build + add-target menu items off-darwin. This makes the dead-end
  // visible instead of a click that silently bounces into Build Support. It gates on the
  // HOST OS, not on preflight readiness: a Mac that merely hasn't installed Xcode keeps
  // these clickable (runBuild opens Build Support to guide the install). The platform comes
  // from the Electron preload (authoritative); a non-Electron web editor has none, so the
  // items stay enabled there (it can't build native at all — out of scope).
  const electronPlatform = (window as unknown as { __modokiElectron?: { platform?: string } })
    .__modokiElectron?.platform;
  const iosUnavailable = !!electronPlatform && electronPlatform !== 'darwin';

  // The Build menu, rebuilt whenever the device listing or the chosen target changes (#170). The
  // device rows live in a SUBMENU under each native build item, whose own label names the target —
  // so the menu says what it is about to do without being opened.
  const buildMenu = (): ExtraMenuItem[] => {
    // Every actionable row here BUILDS: a device row switches the target first, "Build now" keeps
    // the current one. The one exception is the escape hatch — nothing stops a build once it has
    // started, so there must be a way to change the target that is not also a commitment to run a
    // multi-minute native build. It routes to Project Settings rather than duplicating the device
    // list, because a second copy of the list is where the two would drift apart (and the menu
    // renderers cap nesting at one level on purpose).
    const deviceSubmenu = (rows: TargetRow[], platform: 'ios' | 'android', buildLabel: string): ExtraMenuItem[] => [
      ...rows.map((r) => targetItem(r, platform)),
      { label: '', separator: true },
      { label: buildLabel, action: () => runBuild(platform) },
      { label: 'Set target without building…', action: () => useEditorStore.getState().openProjectSettings() },
      { label: 'Refresh devices', action: () => void refreshDeviceTargets() },
    ];
    return [
      {
        label: iosUnavailable ? `iOS Device — ${appName} (needs macOS)` : `iOS Device — ${appName} → ${iosTargetSummary(deviceList, deviceTarget)}`,
        // NO action on a submenu parent: Electron ignores one, and the in-window bar opens the
        // flyout instead of firing — so an `action` here would be dead code in both renderers
        // while reading as the thing that builds. "Build now" INSIDE the submenu is that item.
        disabled: iosUnavailable,
        submenu: deviceSubmenu(iosTargetRows(deviceList, deviceTarget, electronPlatform), 'ios', `Build now → ${iosTargetSummary(deviceList, deviceTarget)}`),
      },
      {
        label: `Android Device — ${appName} → ${androidTargetSummary(deviceList, deviceTarget)}`,
        submenu: deviceSubmenu(androidTargetRows(deviceList, deviceTarget), 'android', `Build now → ${androidTargetSummary(deviceList, deviceTarget)}`),
      },
      { label: webLabel, action: () => runBuild('web') },
      { label: `Playable Ad — ${appName}`, action: () => runBuild('playable') },
      { label: '', separator: true },
      // Release builds (#370) — deliberately NOT under the device submenus. They target no device
      // at all (an archive for `generic/platform=iOS`; an AAB that installs nowhere), so nesting
      // them under a phone picker would attach a choice that does not apply and imply an install
      // that never happens. The labels name the ARTIFACT, because that is the whole product: the
      // build ends with a file you then upload by hand.
      { label: iosUnavailable ? 'iOS Release (App Store .ipa) — needs macOS' : `iOS Release (App Store .ipa) — ${appName}`, action: () => runBuild('ios', 'release'), disabled: iosUnavailable },
      { label: `Android Release (Play AAB) — ${appName}`, action: () => runBuild('android', 'release') },
      { label: '', separator: true },
      { label: iosUnavailable ? 'Add iOS Target… (needs macOS)' : 'Add iOS Target…', action: () => runAddNativeTarget('ios'), disabled: iosUnavailable },
      { label: 'Add Android Target…', action: () => runAddNativeTarget('android') },
      { label: '', separator: true },
      { label: 'Publish OTA Update…', action: () => useEditorStore.getState().openOtaPublish() },
      { label: 'OTA Keys…', action: () => useEditorStore.getState().openOtaKeys() },
      { label: '', separator: true },
      { label: 'Build Support…', action: () => useEditorStore.getState().openBuildSupport() },
    ];
  };

  const Editor = createEditor({
    config: defaultConfig,
    gameId: chosenGameId,
    gameView: GameViewWithUI,
    panels: gamePanels,
    extraMenus: { Build: buildMenu() },
    projectSettings: {
      tabs: [
        {
          title: 'General',
          groups: [
            {
              title: 'App Identity',
              fields: [
                { key: 'app.appId', label: 'Bundle ID', type: 'text' },
                { key: 'app.appName', label: 'App name', type: 'text' },
                { key: 'app.iconSource', label: 'App icon (source PNG)', type: 'path', pathMode: 'file', committedPath: true, placeholder: 'empty = bundled Modoki icon', help: 'square, ≥1024px; all sizes generated on build' },
                { key: 'app.iconMonochromeSource', label: 'Icon — monochrome (Android)', type: 'path', pathMode: 'file', committedPath: true, placeholder: 'empty = derived from the app icon', help: 'the silhouette a themed-icon launcher tints (Android 13+). The derived version is a fallback: flattening a full-colour PAINTING to one tone usually gives a low-contrast blob, so author this one whenever the icon is artwork rather than a flat mark.' },
                { key: 'app.iconDarkSource', label: 'Icon — dark (iOS 18+)', type: 'path', pathMode: 'file', committedPath: true, placeholder: 'empty = derived from the app icon', help: 'the dark-mode home-screen icon. Derived by flattening onto the dark ground and easing the luminance down.' },
                { key: 'app.iconTintedSource', label: 'Icon — tinted (iOS 18+)', type: 'path', pathMode: 'file', committedPath: true, placeholder: 'empty = derived from the app icon', help: 'GREYSCALE — iOS applies the user\'s tint to its luminance. Derived by greyscaling and normalising; without an entry iOS derives its own, poorly.' },
                { key: 'app.splashSource', label: 'Splash (source PNG)', type: 'path', pathMode: 'file', committedPath: true, placeholder: 'empty = generated from the app icon', help: 'the NATIVE launch screen, shown before the web view boots — not an in-game title card. Ideally a large square (2732²). ⚠️ Both platforms COVER-FILL it, so the edges are always cropped: on a 19.5:9 phone only the central ~45% of the WIDTH survives. Compose the subject inside that column.' },
                { key: 'app.splashDarkSource', label: 'Splash — dark mode', type: 'path', pathMode: 'file', committedPath: true, placeholder: 'empty = reuse the splash above', help: 'fills the iOS -dark slots and the Android drawable-night-* buckets, which before this both held the light art.' },
                { key: 'app.splashTitleSource', label: 'Splash title (transparent PNG)', type: 'path', pathMode: 'file', committedPath: true, placeholder: 'empty = no title overlay', help: 'the game\'s wordmark, composited onto the splash at build time rather than painted into the art — so it is always typeset correctly and stays repositionable without regenerating the artwork.' },
                { key: 'app.splashTitleWidthPct', label: 'Splash title width %', type: 'number', placeholder: '55', help: 'percentage of the splash\'s CROP-SAFE width (not the image\'s), which is what makes one number hold across every device shape.' },
                { key: 'app.splashTitleOffsetPct', label: 'Splash title offset %', type: 'number', placeholder: '-8', help: 'vertical offset from the centre of the crop-safe region, as a percentage of its height. Negative is up. Clamped into the safe region, with a build log line when that happens.' },
                { key: 'app.splashBadge', label: 'Splash: "Made by Modoki Engine"', type: 'checkbox', help: 'composites the small Modoki mark at the bottom of the splash\'s crop-safe region. Off by default — nothing already shipped grows a mark it did not have. The badge picks cream or navy per image by measuring the brightness underneath it.' },
                { key: 'app.version', label: 'Version', type: 'text', placeholder: '1.0', help: 'marketing version, what players see in the store listing — synced into Android versionName + iOS MARKETING_VERSION on open and before every build' },
                { key: 'app.buildNumber', label: 'Build number', type: 'number', placeholder: '1', disabledIf: { key: 'app.buildNumberAuto', is: 'true' }, help: 'BUMP BEFORE EVERY STORE UPLOAD (read-only while Auto is on — uncheck Auto to edit). Both stores refuse a build number they have already seen and do it SILENTLY — Play just reports "this release is empty". Synced into Android versionCode + iOS CURRENT_PROJECT_VERSION on open and before every build (not on save); never lowered — a lower value is reported in the log and ignored.' },
                { key: 'app.buildNumberAuto', label: 'Auto build number', type: 'checkbox', help: 'ON = the build number above is IGNORED; versionCode / CFBundleVersion derive from this repo\'s total git commit count on every open/build — no more hand-bumping per upload. The stored number still acts as a floor; if a store ever demands a jump past it, uncheck Auto, type the higher number, and re-check.' },
              ],
            },
            {
              title: 'Mobile (iOS + Android)',
              fields: [
                { key: 'capacitor.orientation', label: 'Orientation', type: 'select', options: labeled(CAPACITOR_ORIENTATIONS, {
                  auto: 'Auto (portrait + landscape)',
                  portrait: 'Portrait',
                  landscape: 'Landscape',
                }) },
                { key: 'capacitor.statusBarHidden', label: 'Hide status bar (clock/wifi)', type: 'checkbox' },
                { key: 'capacitor.statusBarStyle', label: 'Status bar style', type: 'select', options: labeled(STATUS_BAR_STYLES, {
                  default: 'Default (OS decides)',
                  light: 'Light text (dark bg)',
                  dark: 'Dark text (light bg)',
                }), showIf: { key: 'capacitor.statusBarHidden', in: ['false'] } },
                { key: 'capacitor.audioSessionCategory', label: 'Audio session category (iOS)', type: 'select', options: labeled(AUDIO_SESSION_CATEGORIES, {
                  ambient: 'Ambient — mix with other apps, mute on Ring/Silent switch',
                  playback: 'Playback — mix with other apps, keep playing when silenced',
                }), help: '\'ambient\' (default) lets other apps\' audio (e.g. Apple Music) keep playing alongside ours, and obeys the Ring/Silent switch like a casual game normally should. \'playback\' keeps our audio going even when the ringer is silenced, for a game whose music is the point. No Android equivalent — Chromium owns audio focus there.' },
              ],
            },
            {
              title: 'Capacitor',
              fields: [
                { key: 'capacitor.webDir', label: 'Web dir', type: 'text', placeholder: 'dist' },
                { key: 'capacitor.keyboardResize', label: 'Keyboard resize', type: 'select', options: KEYBOARD_RESIZE_MODES.map((v) => ({ value: v, label: v })) },
              ],
            },
            {
              // ⚠️ Engine Modules lives HERE, not on Graphics, and that was a deliberate audit
              // finding (#403): `build.modules` toggles render3d/render2d/physics2d/physics3d AND
              // video, so filing it under either Graphics or Physics would have been wrong for the
              // other three. What it actually answers is "what ships in the build" — the same
              // question as the two fields below it.
              title: 'Developer',
              fields: [
                { key: 'build.modules', label: 'Engine modules', type: 'module-toggles', help: 'which engine seams ship in the build — Auto detects from the included scenes; Off lets the bundler drop the whole module (smaller playable ads / web builds).' },
                { key: 'build.debugBuild', label: 'Debug build', type: 'checkbox', help: 'Ships the event journal (emit/modoki_journal), the in-game debug menu (F12 / 3-finger tap: stats, world, journal, device IP), and the debug bridge that device_* AI tools connect to — INCLUDING device_eval (arbitrary JS on the device). Turn ON for a QA/playtest/profiling build; leave OFF for release, where the debug menu and the bridge are tree-shaken out entirely (nothing to connect to) and the journal stops recording. Always on in the editor/dev. Rebuild to apply.' },
                { key: 'build.textureTierVariants', label: 'Texture tier variants', type: 'select', options: labeled(TEXTURE_TIER_VARIANTS_MODES, {
                  auto: 'Auto (emit only when delivered over the wire)',
                  always: 'Always (also emit for a plain native package)',
                  never: 'Never (skip even on web)',
                }), help: 'Per-tier LOD texture variants (Rendering → Quality Tiers) ship every size INSIDE the package — a real install-size cost that only pays off when the device fetches just the one it needs. "Auto" emits for a web build or an OTA publish and skips a plain iOS/Android package build; "Always" is the opt-in for a native project whose textures are big enough that the boot-time/GPU-memory win outweighs the install size; a playable build never emits regardless (already clamped to 512px).' },
              ],
            },
          ],
        },
        {
          title: 'Scenes',
          groups: [
            {
              title: '',
              fields: [
                { key: 'content.scenes', label: '', type: 'scene-list', options: sceneOptions },
              ],
            },
          ],
        },
        {
          title: 'Web',
          groups: [
            {
              title: 'Web Deploy',
              fields: [
                { key: 'build.webBasePath', label: 'Web base path', type: 'text', placeholder: '/demo/', help: 'sub-path hosting — applies in every mode' },
                { key: 'build.webDeployMode', label: 'Deploy target', type: 'select', options: labeled(WEB_DEPLOY_MODES, {
                  none: 'None — build to dist/ only',
                  gcs: 'Google Cloud Storage (built-in gcloud)',
                  custom: 'Custom command',
                }) },
                // GCS-only fields
                { key: 'build.webBucket', label: 'Web GCS bucket', type: 'text', placeholder: 'gs://…', showIf: { key: 'build.webDeployMode', in: ['gcs'] } },
                { key: 'build.webCdnUrlMap', label: 'Web CDN url-map', type: 'text', placeholder: 'empty = no CDN', help: 'gcloud compute url-maps invalidate-cdn-cache <name>', showIf: { key: 'build.webDeployMode', in: ['gcs'] } },
                { key: 'build.webCdnBackendBucket', label: 'Web CDN backend-bucket', type: 'text', placeholder: 'empty = no ?v= cache-bust', help: 'whitelists ?v in the CDN cache key + marks glb/ktx2/webp immutable', showIf: { key: 'build.webDeployMode', in: ['gcs'] } },
                // Per-machine (project.user.json — not committed): where the gcloud CLI lives. A
                // Finder-launched packaged editor has a minimal PATH without the Cloud SDK.
                { key: 'user.sdk.gcloudPath', label: 'gcloud path override', type: 'path', pathMode: 'file', placeholder: 'empty = auto-detect (Homebrew / Cloud SDK / login shell)', help: 'the gcloud binary (or its bin dir); set this if the deploy reports "gcloud not found"', showIf: { key: 'build.webDeployMode', in: ['gcs'] } },
                // Custom-only field
                { key: 'build.webDeployCommand', label: 'Custom deploy command', type: 'text', placeholder: 'e.g. rsync -a {dist}/ host:/var/www', help: 'runs after build; {dist} {base}', showIf: { key: 'build.webDeployMode', in: ['custom'] } },
              ],
            },
            {
              title: 'Screen / Canvas Size',
              fields: [
                { key: 'rendering.web.sizeMode', label: 'Size mode', type: 'select', options: labeled(WEB_SIZE_MODES, {
                  free: 'Free — fill window (responsive)',
                  fixed: 'Fixed — render at W×H, letterbox',
                  max: 'Max — fill but clamp buffer to W×H',
                }) },
                { key: 'rendering.web.width', label: 'Width', type: 'number', placeholder: '1280', showIf: { key: 'rendering.web.sizeMode', in: ['fixed', 'max'] } },
                { key: 'rendering.web.height', label: 'Height', type: 'number', placeholder: '720', showIf: { key: 'rendering.web.sizeMode', in: ['fixed', 'max'] } },
              ],
            },
            {
              title: 'Playable Ad',
              fields: [
                { key: 'build.playableClickUrl', label: 'CTA click URL', type: 'text', placeholder: 'https://apps.apple.com/…  (empty = CTA inert)', help: 'the Install/CTA tap opens this via mraid.open in an ad container; the network usually overrides the destination but needs a URL to fire' },
                { key: 'build.playableNetwork', label: 'Ad network', type: 'select', options: labeled(PLAYABLE_NETWORKS, {
                  applovin: 'AppLovin MAX',
                  unity: 'Unity Ads',
                  ironsource: 'ironSource',
                  facebook: 'Meta / Facebook',
                  mintegral: 'Mintegral',
                  generic: 'Generic (MRAID)',
                }), help: 'targeted MRAID/CTA conventions (Build → Playable Ad output)' },
                { key: 'build.playableMaxBytes', label: 'Max size (bytes)', type: 'number', placeholder: '5242880', help: 'build fails if the single HTML exceeds this — AppLovin caps at 5 MB' },
              ],
            },
          ],
        },
        {
          title: 'iOS',
          groups: [
            {
              title: 'Signing',
              fields: [
                { key: 'build.appleTeamId', label: 'Apple Team ID', type: 'combo', options: teamOptions, placeholder: 'e.g. ABCDE12345', help: 'pick a team found on this Mac (or type an ID) — synced into iOS DEVELOPMENT_TEAM on every iOS build' },
                { key: 'build.iosMinVersion', label: 'Minimum iOS version', type: 'text', placeholder: '16.4', help: 'the ONE floor — sets both the JS bundle target and the native IPHONEOS_DEPLOYMENT_TARGET. Below 15.4 needs polyfills (structuredClone / Array.at / Object.hasOwn land in 15.4), not just a smaller number' },
                { key: 'build.iosExportMethod', label: 'Release export method', type: 'select', options: labeled(IOS_EXPORT_METHODS, {
                  'app-store-connect': 'App Store Connect (the shipping path)',
                  'app-store': 'App Store (pre-Xcode-15.3 spelling)',
                  'ad-hoc': 'Ad Hoc (registered devices only)',
                  development: 'Development (registered devices only)',
                  enterprise: 'Enterprise (in-house distribution)',
                }), help: 'Used ONLY by Build → iOS Release: the `method` in the generated exportOptions.plist. Ad Hoc / Development produce an .ipa you can install on registered devices to test the RELEASE-signed build before it goes near a store — which is the only way to exercise the release signing certificate. Ignored by a debug device build.' },
              ],
            },
            {
              title: 'This Machine (project.user.json — not committed)',
              fields: [
                { key: 'user.device.iosDeviceId', label: 'iOS device UDID', type: 'text', help: "Required for an iOS build — xcodebuild -destination 'id=…'" },
                // Optional on purpose: devicectl is CoreDevice-only (iOS 17+), so a legacy
                // device has no id to put here and the build hands off to Xcode instead.
                // Saying so here keeps this panel agreeing with the build's own preflight.
                { key: 'user.device.iosDevicectlId', label: 'iOS devicectl id', type: 'text', help: 'Optional (iOS 17+ only) — enables hands-free install/launch. Empty ⇒ the build opens Xcode for ⌘R. xcrun devicectl --device …' },
              ],
            },
            {
              title: 'Capacitor (iOS)',
              fields: [
                { key: 'capacitor.iosContentMode', label: 'Content mode', type: 'select', options: IOS_CONTENT_MODES.map((v) => ({ value: v, label: v })) },
              ],
            },
          ],
        },
        {
          title: 'Android',
          groups: [
            {
              title: 'Build',
              fields: [
                { key: 'build.androidMinSdk', label: 'Minimum Android SDK', type: 'number', placeholder: '31', help: 'API level, not the marketing version — 31 = Android 12. Synced into android/variables.gradle minSdkVersion on open. Capacitor scaffolds 24, so without this the floor drifts per-project.' },
              ],
            },
            {
              title: 'This Machine (project.user.json — not committed)',
              fields: [
                { key: 'user.device.androidDeviceId', label: 'Android serial', type: 'text', placeholder: 'empty = default adb device' },
                { key: 'user.sdk.javaHome', label: 'JAVA_HOME override', type: 'path', pathMode: 'folder', placeholder: 'empty = auto-detect (brew → java_home -v 21)' },
                { key: 'user.sdk.androidHome', label: 'ANDROID_HOME override', type: 'path', pathMode: 'folder', placeholder: 'empty = auto-detect' },
              ],
            },
            {
              // #370. Lives under "this machine" for the passwords' sake, but the KEY it points at
              // is emphatically not per-machine: Play matches an AAB against the key the app was
              // enrolled with, so a second machine must copy the same .jks rather than make its own.
              // That is the opposite of the debug key, and the reason this group says so in its title.
              title: 'Android release signing (project.user.json — not committed)',
              fields: [
                { key: 'user.keystore.storeFile', label: 'Upload keystore (.jks)', type: 'path', pathMode: 'file', placeholder: '~/.modoki/keystores/<appId>-upload.jks', help: 'The Play UPLOAD key — ONE key across every machine, kept OUTSIDE the repo. Create one with: keytool -genkeypair -v -keystore ~/.modoki/keystores/<appId>-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000. Empty ⇒ Build → Android Release refuses (an unsigned AAB builds fine and is then rejected at upload).' },
                { key: 'user.keystore.keyAlias', label: 'Key alias', type: 'text', placeholder: 'upload' },
                { key: 'user.keystore.storePassword', label: 'Keystore password', type: 'password' },
                { key: 'user.keystore.keyPassword', label: 'Key password', type: 'password', help: 'Often the same as the keystore password — keytool sets both unless you asked for different ones.' },
              ],
            },
            {
              title: 'Capacitor (Android)',
              fields: [
                { key: 'capacitor.androidScheme', label: 'URL scheme', type: 'select', options: ANDROID_SCHEMES.map((v) => ({ value: v, label: v })) },
                { key: 'capacitor.allowMixedContent', label: 'Allow mixed content', type: 'checkbox' },
              ],
            },
          ],
        },
        {
          // ⚠️ SPLIT FROM "Rendering & Physics" (#403). One tab held four unrelated groups and the
          // tier matrix, which is the single longest surface in this dialog; physics shared it for
          // no reason beyond both being "engine-ish". Engine Modules moved to General — see the
          // note there for why neither half of this split was a correct home for it.
          title: 'Graphics',
          groups: [
            {
              title: 'Three.js (3D)',
              fields: [
                { key: 'rendering.three.backend', label: 'GPU backend', type: 'select', options: GPU_BACKENDS.map((v) => ({ value: v, label: v })), help: 'auto = detect, prefer WebGPU' },
                // ⚠️ Pinning a tier this project has NOT authored (in the matrix below) does NOTHING:
                // every tier resolves to the project's default until a config exists for it
                // (resolveTierOverrides falls back to the default, never invents clamping). Filtering
                // this dropdown to the authored tiers needs dynamic (data-dependent) select options,
                // which the schema still cannot express — tracked, not half-built here.
                { key: 'rendering.three.qualityTier', label: 'Quality tier (pin)', type: 'select', options: QUALITY_TIERS.map((v) => ({ value: v, label: v })), help: "auto = measure the device and pick among the tiers this project authored in the matrix below. Pinning 'mid'/'low' does NOTHING unless that tier column has been added — an unauthored tier resolves the Default column. Takes effect on the next renderer bring-up — use the debug menu Device tab to preview it live" },
                { key: 'rendering.three.toneMapping', label: 'Tone mapping', type: 'select', options: TONE_MAPPINGS.map((v) => ({ value: v, label: v })) },
                { key: 'rendering.three.exposure', label: 'Exposure', type: 'number', placeholder: '1' },
              ],
            },
            {
              title: 'PixiJS (2D)',
              fields: [
                { key: 'rendering.pixi.backend', label: 'GPU backend', type: 'select', options: GPU_BACKENDS.map((v) => ({ value: v, label: v })), help: 'auto = detect, prefer WebGPU' },
                // `resolution` is a PIN and is deliberately NOT in the tier matrix — a tier may not
                // overrule a pin (capping one would make the pin a lie), so it has no Default/Mid/Low
                // row and stays a plain field here.
                { key: 'rendering.pixi.resolution', label: 'Resolution', type: 'number', placeholder: '0 = auto (devicePixelRatio)' },
              ],
            },
            {
              // ⚠️ EVERY OTHER RENDERER FIELD IS IN HERE, not in the two groups above (#403).
              // `pixelRatioCap`, `antialias`, `shadows`, `targetFps` and the two `pixi` twins used
              // to sit in those groups AND again inside each tier card — the same setting authored
              // in two places, with nothing saying they were the same setting. They now appear
              // exactly once, in this matrix's Default column.
              title: 'Quality Tiers',
              fields: [
                { key: 'rendering', label: '', type: 'quality-tiers', help: 'Default is what every device gets. Add Mid / Low to degrade on top of it for weaker hardware — each seeded from the engine\'s measured behaviour. No tiers added = one config = the boot probe never runs.' },
              ],
            },
          ],
        },
        {
          title: 'Physics',
          groups: [
            {
              title: '2D Physics',
              fields: [
                { key: 'physics', label: '', type: 'physics-layers', help: '2D collision layers + matrix (Collider2D.physicsLayer picks one). Gravity is authored per-scene on the Physics2D trait.' },
              ],
            },
          ],
        },
        {
          title: 'OTA',
          groups: [
            {
              title: 'OTA Updates',
              fields: [
                { key: 'ota.enabled', label: 'Enabled', type: 'checkbox', help: 'the shell checks for + applies OTA updates at boot. Off = no network call, no dynamic import of the OTA plugin.' },
                { key: 'ota.baseUrl', label: 'Base URL', type: 'text', placeholder: 'https://storage.googleapis.com/<bucket>/<prefix>', help: 'what the CLIENT fetches from — no trailing slash' },
                { key: 'ota.bundleName', label: 'Bundle name', type: 'text', placeholder: 'shell', help: "this build's own bundle — 'shell' for the main app; a sub-game id for a Phase 4 sub-game" },
                { key: 'ota.engineApi', label: 'Engine API version', type: 'number', help: 'stamped from ENGINE_API_VERSION — do not hand-edit to "fix" a rejected update' },
                { key: 'ota.publicKey', label: 'Public key', type: 'readonly-text', placeholder: 'empty — generate a key via Build → OTA Keys…', help: 'derived from build/ota-keys/<name>.json, never hand-typed (Build → OTA Keys…)' },
              ],
            },
          ],
        },
      ],
      load: () => backendFetch('/api/project-settings').then((r) => r.json()),
      save: (values) =>
        backendFetch('/api/project-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(values),
        }).then(async (r) => {
          // Apply physics layers live so the editor reflects matrix/name edits without
          // a reload — colliders rebuild next tick (resolved bits are in their signature).
          if (r.ok && values.physics) setPhysicsLayers(values.physics as Parameters<typeof setPhysicsLayers>[0]);
          // The dialog can edit the same `user.device` ids the Build menu shows (#170) — re-read
          // them so the menu's label and ✓ can't contradict the dialog the user just saved.
          if (r.ok && values.user) void refreshDeviceTargets();
          if (r.ok) return true;
          // Surface the server's reason. The route refuses a save for things the user
          // can fix (an unsafe build field, a config file that no longer parses), and
          // dropping the message left the dialog just not closing, with no explanation.
          const msg = await r.json().then((j: { error?: string }) => j?.error).catch(() => undefined);
          return msg || `Save failed (${r.status})`;
        }),
      pickPath: async (mode) => {
        try {
          const r = await backendFetch('/api/pick-path', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode, prompt: mode === 'file' ? 'Choose a file' : 'Choose a folder' }),
          });
          if (!r.ok) return null;
          const j = (await r.json()) as { path?: string };
          return j.path ?? null;
        } catch {
          return null;
        }
      },
    },
  });

  // Build menu ↔ device listing (#170). Installed AFTER createEditor (nothing can render a menu
  // before the editor exists) and deliberately NOT awaited: the iOS half is two `xcrun` shell-outs
  // at ~1.6-2.9s uncached, and the editor must not wait on a phone probe to boot. The menu is
  // correct-but-uninformed until this lands, then re-renders itself.
  republishBuildMenu = () => setExtraMenus({ Build: buildMenu() });
  void refreshDeviceTargets();

  // The editor booted, but this project's game code did not. Say so ON SCREEN — a console
  // line is not enough when the consequence (systems missing, entities inert) looks exactly
  // like a scene-authoring mistake. The banner sits above the editor rather than replacing
  // it, because the editor is still fully usable and is where the fix gets made.
  const bootFaultSummary = describeGameBootFaults();
  if (!bootFaultSummary) return { default: Editor };
  console.error(`[editor] project booted DEGRADED — ${bootFaultSummary}`);
  const Degraded: React.ComponentType = () => createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', height: '100vh' } },
    createElement(
      'div',
      {
        'data-game-boot-fault': '',
        style: {
          background: '#7f1d1d', color: '#fee2e2', padding: '8px 14px', fontSize: 13,
          fontFamily: 'system-ui, sans-serif', borderBottom: '1px solid #ef4444', flex: '0 0 auto',
        },
      },
      `Game code failed to load — this project is running DEGRADED (its systems are not registered). ${bootFaultSummary}`,
    ),
    createElement('div', { style: { flex: '1 1 auto', minHeight: 0 } }, createElement(Editor)),
  );
  return { default: Degraded };
}
