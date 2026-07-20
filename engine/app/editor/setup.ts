/** Game editor setup — configures @modoki/engine/editor generically from the
 *  OPEN PROJECT's game (virtual:modoki-games). No game is imported by path: the
 *  editor reads the project's game(s), runs each game's config (for its
 *  scene-callback side effects) + postprocessors + systems + editor bindings,
 *  then builds the editor around the default game's config. Async because those
 *  registrations come through the game's import() loaders — safe, since the
 *  editor route is lazy + Suspense (see App.tsx EditorApp). */

import { createElement } from 'react';
import type React from 'react';
import { createEditor, useEditorStore, backendFetch, backendEventSource } from '@modoki/engine/editor';
import { GameView } from '@modoki/engine/editor/rendering';
import { setGameConfig, setPhysicsLayers } from '@modoki/engine/runtime';
import type { GameConfig, EditorPanelDef } from '@modoki/engine/runtime';
import projectConfig from 'virtual:modoki-project-config';
import { loadProjectGames } from '../projectGames';
import { registerAll } from '../ecs/register';
import { DefaultGameUILayer } from '../ui/DefaultGameUILayer';
import { registerEditorAgentOps } from './agentEditorOps';

// Wrap modoki GameView with game-specific UI layer
function GameViewWithUI() {
  return createElement(GameView, { uiLayer: createElement(DefaultGameUILayer) });
}

/** Minimal config for an empty project (no games) so the editor still mounts. */
const EMPTY_CONFIG: GameConfig = { name: 'Empty Project', sceneSetup: () => {}, initWorld: () => {} };

/** Trigger a build + deploy via the dev server's SSE endpoint */
async function runBuild(platform: 'ios' | 'android' | 'web' | 'playable') {
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
  runStream(`/api/build?platform=${platform}`, 5, `${platform} build`, 'Starting build...');
}

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
    const cfg = await g.loadConfig().catch(() => undefined);
    if (cfg && !defaultConfig) {
      defaultConfig = cfg;
      chosenGameId = g.id;
    }
  }
  defaultConfig ??= EMPTY_CONFIG;

  // 2. setGameConfig before registerAll (which reads nameTransform).
  setGameConfig(defaultConfig);

  // 3. Register each game's postprocessors + systems + editor bindings up front
  //    (the editor lists/inspects all games). Sequential = deterministic order.
  //    Also collect any game-registered dockable editor panels — the lazy
  //    editorPanels() loader keeps its (editor-only) module off the game bundle.
  const gamePanels: EditorPanelDef[] = [];
  for (const g of ALL_GAMES) {
    await g.registerPostprocessors?.();
    await g.registerSystems?.();
    await g.registerEditorBindings?.();
    if (g.editorPanels) {
      try {
        gamePanels.push(...(await g.editorPanels()));
      } catch (err) {
        console.error(`[editor] game "${g.id}" editorPanels() failed:`, err);
      }
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

  const Editor = createEditor({
    config: defaultConfig,
    gameId: chosenGameId,
    gameView: GameViewWithUI,
    panels: gamePanels,
    extraMenus: {
      Build: [
        { label: iosUnavailable ? `iOS Device — ${appName} (needs macOS)` : `iOS Device — ${appName}`, action: () => runBuild('ios'), disabled: iosUnavailable },
        { label: `Android Device — ${appName}`, action: () => runBuild('android') },
        { label: webLabel, action: () => runBuild('web') },
        { label: `Playable Ad — ${appName}`, action: () => runBuild('playable') },
        { label: '', separator: true },
        { label: iosUnavailable ? 'Add iOS Target… (needs macOS)' : 'Add iOS Target…', action: () => runAddNativeTarget('ios'), disabled: iosUnavailable },
        { label: 'Add Android Target…', action: () => runAddNativeTarget('android') },
        { label: '', separator: true },
        { label: 'Build Support…', action: () => useEditorStore.getState().openBuildSupport() },
      ],
    },
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
                { key: 'app.iconSource', label: 'App icon (source PNG)', type: 'path', pathMode: 'file', placeholder: 'empty = bundled Modoki icon', help: 'square, ≥1024px; all sizes generated on build' },
              ],
            },
            {
              title: 'Mobile (iOS + Android)',
              fields: [
                { key: 'capacitor.orientation', label: 'Orientation', type: 'select', options: [
                  { value: 'auto', label: 'Auto (portrait + landscape)' },
                  { value: 'portrait', label: 'Portrait' },
                  { value: 'landscape', label: 'Landscape' },
                ] },
                { key: 'capacitor.statusBarHidden', label: 'Hide status bar (clock/wifi)', type: 'checkbox' },
                { key: 'capacitor.statusBarStyle', label: 'Status bar style', type: 'select', options: [
                  { value: 'default', label: 'Default (OS decides)' },
                  { value: 'light', label: 'Light text (dark bg)' },
                  { value: 'dark', label: 'Dark text (light bg)' },
                ], showIf: { key: 'capacitor.statusBarHidden', in: ['false'] } },
              ],
            },
            {
              title: 'Capacitor',
              fields: [
                { key: 'capacitor.webDir', label: 'Web dir', type: 'text', placeholder: 'dist' },
                { key: 'capacitor.keyboardResize', label: 'Keyboard resize', type: 'select', options: ['none', 'native', 'body', 'ionic'].map((v) => ({ value: v, label: v })) },
              ],
            },
            {
              title: 'Developer',
              fields: [
                { key: 'build.enableDebugMenu', label: 'Ship the in-game debug menu', type: 'checkbox', help: 'F12 / 3-finger tap opens it in the built game (stats, world, journal, device IP). Always on in the editor; off = tree-shaken out of the build. Rebuild to apply.' },
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
                { key: 'build.webDeployMode', label: 'Deploy target', type: 'select', options: [
                  { value: 'none', label: 'None — build to dist/ only' },
                  { value: 'gcs', label: 'Google Cloud Storage (built-in gcloud)' },
                  { value: 'custom', label: 'Custom command' },
                ] },
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
                { key: 'rendering.web.sizeMode', label: 'Size mode', type: 'select', options: [
                  { value: 'free', label: 'Free — fill window (responsive)' },
                  { value: 'fixed', label: 'Fixed — render at W×H, letterbox' },
                  { value: 'max', label: 'Max — fill but clamp buffer to W×H' },
                ] },
                { key: 'rendering.web.width', label: 'Width', type: 'number', placeholder: '1280', showIf: { key: 'rendering.web.sizeMode', in: ['fixed', 'max'] } },
                { key: 'rendering.web.height', label: 'Height', type: 'number', placeholder: '720', showIf: { key: 'rendering.web.sizeMode', in: ['fixed', 'max'] } },
              ],
            },
            {
              title: 'Playable Ad',
              fields: [
                { key: 'build.playableClickUrl', label: 'CTA click URL', type: 'text', placeholder: 'https://apps.apple.com/…  (empty = CTA inert)', help: 'the Install/CTA tap opens this via mraid.open in an ad container; the network usually overrides the destination but needs a URL to fire' },
                { key: 'build.playableNetwork', label: 'Ad network', type: 'select', options: [
                  { value: 'applovin', label: 'AppLovin MAX' },
                  { value: 'unity', label: 'Unity Ads' },
                  { value: 'ironsource', label: 'ironSource' },
                  { value: 'facebook', label: 'Meta / Facebook' },
                  { value: 'mintegral', label: 'Mintegral' },
                  { value: 'generic', label: 'Generic (MRAID)' },
                ], help: 'targeted MRAID/CTA conventions (Build → Playable Ad output)' },
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
                { key: 'build.appleTeamId', label: 'Apple Team ID', type: 'combo', options: teamOptions, placeholder: 'e.g. KQ6FQ2BS8H', help: 'pick a team found on this Mac (or type an ID) — synced into iOS DEVELOPMENT_TEAM on every iOS build' },
              ],
            },
            {
              title: 'This Machine (project.user.json — not committed)',
              fields: [
                { key: 'user.device.iosDeviceId', label: 'iOS device UDID', type: 'text', help: "xcodebuild -destination 'id=…'" },
                { key: 'user.device.iosDevicectlId', label: 'iOS devicectl id', type: 'text', help: 'xcrun devicectl --device …' },
              ],
            },
            {
              title: 'Capacitor (iOS)',
              fields: [
                { key: 'capacitor.iosContentMode', label: 'Content mode', type: 'select', options: ['mobile', 'desktop', 'recommended'].map((v) => ({ value: v, label: v })) },
              ],
            },
          ],
        },
        {
          title: 'Android',
          groups: [
            {
              title: 'This Machine (project.user.json — not committed)',
              fields: [
                { key: 'user.device.androidDeviceId', label: 'Android serial', type: 'text', placeholder: 'empty = default adb device' },
                { key: 'user.sdk.javaHome', label: 'JAVA_HOME override', type: 'path', pathMode: 'folder', placeholder: 'empty = auto-detect (brew → java_home -v 21)' },
                { key: 'user.sdk.androidHome', label: 'ANDROID_HOME override', type: 'path', pathMode: 'folder', placeholder: 'empty = auto-detect' },
              ],
            },
            {
              title: 'Capacitor (Android)',
              fields: [
                { key: 'capacitor.androidScheme', label: 'URL scheme', type: 'select', options: ['http', 'https'].map((v) => ({ value: v, label: v })) },
                { key: 'capacitor.allowMixedContent', label: 'Allow mixed content', type: 'checkbox' },
              ],
            },
          ],
        },
        {
          title: 'Rendering & Physics',
          groups: [
            {
              title: 'Engine Modules',
              fields: [
                { key: 'build.modules', label: '', type: 'module-toggles', help: 'which engine seams ship in the build — Auto detects from the included scenes; Off lets the bundler drop the whole module (smaller playable ads / web builds).' },
              ],
            },
            {
              title: 'Frame Loop',
              fields: [
                { key: 'rendering.targetFps', label: 'Target FPS', type: 'number', placeholder: '0 = uncapped (display refresh)', help: 'throttles the rAF loop to save battery/heat' },
              ],
            },
            {
              title: 'Three.js (3D)',
              fields: [
                { key: 'rendering.three.backend', label: 'GPU backend', type: 'select', options: ['auto', 'webgpu', 'webgl'].map((v) => ({ value: v, label: v })), help: 'auto = detect, prefer WebGPU' },
                { key: 'rendering.three.antialias', label: 'Antialias', type: 'checkbox' },
                { key: 'rendering.three.shadows', label: 'Shadows', type: 'checkbox' },
                { key: 'rendering.three.pixelRatioCap', label: 'Pixel-ratio cap', type: 'number', placeholder: '2' },
                { key: 'rendering.three.toneMapping', label: 'Tone mapping', type: 'select', options: ['ACESFilmic', 'AgX', 'Neutral', 'Linear', 'None'].map((v) => ({ value: v, label: v })) },
                { key: 'rendering.three.exposure', label: 'Exposure', type: 'number', placeholder: '1' },
              ],
            },
            {
              title: 'PixiJS (2D)',
              fields: [
                { key: 'rendering.pixi.backend', label: 'GPU backend', type: 'select', options: ['auto', 'webgpu', 'webgl'].map((v) => ({ value: v, label: v })), help: 'auto = detect, prefer WebGPU' },
                { key: 'rendering.pixi.antialias', label: 'Antialias', type: 'checkbox' },
                { key: 'rendering.pixi.resolution', label: 'Resolution', type: 'number', placeholder: '0 = auto (devicePixelRatio)' },
              ],
            },
            {
              title: '2D Physics',
              fields: [
                { key: 'physics', label: '', type: 'physics-layers', help: '2D collision layers + matrix (Collider2D.physicsLayer picks one). Gravity is authored per-scene on the Physics2D trait.' },
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
        }).then((r) => {
          // Apply physics layers live so the editor reflects matrix/name edits without
          // a reload — colliders rebuild next tick (resolved bits are in their signature).
          if (r.ok && values.physics) setPhysicsLayers(values.physics as Parameters<typeof setPhysicsLayers>[0]);
          return r.ok;
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

  return { default: Editor };
}
