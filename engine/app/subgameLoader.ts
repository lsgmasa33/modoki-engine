/** OTA Phase 4 (docs/ota-subgame-modules.md) — discovers sub-game bundles already
 *  staged on this device (native `ModokiOta.listBundles()`) and dynamically loads each
 *  one: fetch its `subgame.json`, `ensure()` its declared shared deps in the shell's
 *  registry, load `subgame.js` as a classic `<script>` tag (not `import()` — see
 *  sharedRegistry.ts's header on why an IIFE + script tag sidesteps every WebView
 *  module-scheme/MIME question), verify its engine-API version for EXACT equality
 *  (never `>=` — a sub-game built against a different engine must refuse to load
 *  loudly, not crash mid-scene), merge its asset-manifest fragment, and register it into
 *  `gameRegistry`. Every failure is collected into a VISIBLE list (`subscribeSubgameLoadErrors`)
 *  — never a silent skip. Call `loadStagedSubgames()` once, from `App.tsx`, additively in
 *  the background (see gameRegistry.ts's header for why this is NOT awaited by the
 *  per-game boot effect). */

import { Capacitor } from '@capacitor/core';
import { ENGINE_API_VERSION, loadManifestJson, type AssetManifestFile, type GameDefinition } from '@modoki/engine/runtime';
import projectConfig from 'virtual:modoki-project-config';
import { checkAppSubgameUpdates, isPluginUnimplemented } from './ota';
import { registerDynamicGame, getGames } from './gameRegistry';

export interface SubgameLoadError {
  bundleName: string;
  version: string;
  message: string;
}

const loadErrors: SubgameLoadError[] = [];
type Listener = (errors: readonly SubgameLoadError[]) => void;
const listeners = new Set<Listener>();

function reportError(bundleName: string, version: string, message: string): void {
  console.error(`[GameShell] sub-game "${bundleName}"@${version} refused to load: ${message}`);
  loadErrors.push({ bundleName, version, message });
  listeners.forEach((l) => l(loadErrors));
}

/** Subscribes to the sub-game load-error list for the UI. Invoked immediately with the
 *  CURRENT list, then again on every new error. Returns an unsubscribe function. */
export function subscribeSubgameLoadErrors(listener: Listener): () => void {
  listeners.add(listener);
  listener(loadErrors);
  return () => listeners.delete(listener);
}

interface SubgameManifest {
  schema: number;
  engineApi: number;
  sharedDeps: string[];
  entry: string;
}

interface SubgameModuleExports {
  game?: { id?: string };
  engineApi?: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __MODOKI_SUBGAME__: SubgameModuleExports | undefined;
}

function loadScriptTag(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`script load failed: ${url}`));
    document.head.appendChild(script);
  });
}

async function loadOneSubgame(bundle: { name: string; version: string; path: string }): Promise<void> {
  const baseUrl = Capacitor.convertFileSrc(bundle.path).replace(/\/$/, '');

  let manifest: SubgameManifest;
  try {
    const res = await fetch(`${baseUrl}/subgame.json`);
    if (!res.ok) { reportError(bundle.name, bundle.version, `subgame.json fetch failed (${res.status})`); return; }
    manifest = await res.json();
  } catch (e) {
    reportError(bundle.name, bundle.version, `subgame.json fetch threw: ${e}`);
    return;
  }

  // Belt-and-suspenders check #1: the build-stamped manifest field. Checked BEFORE
  // evaluating the bundle at all — no reason to even load a script we already know is
  // incompatible.
  if (manifest.engineApi !== ENGINE_API_VERSION) {
    reportError(bundle.name, bundle.version, `engineApi mismatch: manifest declares ${manifest.engineApi}, running ${ENGINE_API_VERSION}`);
    return;
  }

  const shared = globalThis.__MODOKI_SHARED__;
  if (!shared) {
    reportError(bundle.name, bundle.version, 'globalThis.__MODOKI_SHARED__ is not initialized (sharedRegistry.ts did not run)');
    return;
  }
  try {
    await shared.ensure(manifest.sharedDeps ?? []);
  } catch (e) {
    reportError(bundle.name, bundle.version, `shared dependency load failed: ${e}`);
    return;
  }

  try {
    await loadScriptTag(`${baseUrl}/${manifest.entry}`);
  } catch (e) {
    reportError(bundle.name, bundle.version, `${e}`);
    return;
  }

  // Belt-and-suspenders check #2: the module's OWN static export, set by the exact same
  // build that produced subgame.json but read from a DIFFERENT artifact — catches a
  // hand-edited/corrupted subgame.json that "fixed" check #1 without rebuilding.
  const mod = globalThis.__MODOKI_SUBGAME__ as SubgameModuleExports | undefined;
  globalThis.__MODOKI_SUBGAME__ = undefined; // consumed — the next bundle's script must not silently read a stale value if it fails before assigning its own
  if (!mod || mod.engineApi !== ENGINE_API_VERSION) {
    reportError(bundle.name, bundle.version, `module engineApi mismatch or missing: got ${mod?.engineApi}, running ${ENGINE_API_VERSION}`);
    return;
  }
  if (!mod.game || typeof mod.game.id !== 'string' || !mod.game.id) {
    reportError(bundle.name, bundle.version, 'loaded module has no valid game.id');
    return;
  }

  // GameConfig.scenePath is a root-relative build-output literal (Vite `?url`
  // import, e.g. "/assets/main-<hash>.json") — correct only when fetched against
  // THIS sub-game's own staged origin, not the shell's. Wrap loadConfig so every
  // config this sub-game ever produces carries that origin; App.tsx's scene-boot
  // resolution reads it back off assetBaseUrl. See config.ts's field doc.
  const game = mod.game as GameDefinition;
  const originalLoadConfig = game.loadConfig;
  game.loadConfig = async () => ({ ...(await originalLoadConfig()), assetBaseUrl: baseUrl });

  // Probe the collision BEFORE merging the manifest below. `registerDynamicGame` is still the
  // authoritative claim (it runs after the merge), but by then the fragment has already been
  // merged — and `registerAsset` is last-write-wins on a GUID, so a bundle that is about to be
  // REFUSED for a duplicate id would first repoint the baked game's every asset path at this
  // bundle's staged root, with no un-merge. See docs/ota-subgame-modules.md §3.
  if (getGames().some((g) => g.id === game.id)) {
    reportError(bundle.name, bundle.version, `gameId collision: "${game.id}" is already registered`);
    return;
  }

  // Merge this sub-game's own asset-manifest fragment, path-prefixed so its GUIDs
  // resolve against ITS OWN staged root rather than colliding with the shell's assets.
  // Done BEFORE registerDynamicGame: registration is what makes App.tsx's findGame see
  // this game as bootable, so the manifest must already be merged by then — otherwise a
  // boot landing in the window between registration and this fetch resolving would
  // resolve every asset against the SHELL's manifest instead (missing textures/audio).
  // Fatal, not a warn-and-continue: vite-asset-scanner.ts writes assets.manifest.json
  // unconditionally on every build, so a missing/unparseable manifest here means a
  // genuinely broken bundle, not a legitimate "this sub-game has no assets" case.
  try {
    const manifestRes = await fetch(`${baseUrl}/assets.manifest.json`);
    if (!manifestRes.ok) {
      reportError(bundle.name, bundle.version, `assets.manifest.json fetch failed (${manifestRes.status})`);
      return;
    }
    const fragment: AssetManifestFile = await manifestRes.json();
    loadManifestJson(fragment, { pathPrefix: baseUrl });
  } catch (e) {
    reportError(bundle.name, bundle.version, `assets.manifest.json fetch/parse threw: ${e}`);
    return;
  }

  // Authoritative claim. The probe above is sufficient, not just narrowing: sub-games load
  // sequentially in one memoized pass (loadStagedSubgames()'s `for` loop awaits each
  // loadOneSubgame() in turn, and this is the only production caller of registerDynamicGame),
  // so nothing can register between the probe and this call — a same-id bundle is always
  // caught by the probe, never by a race with the loser's manifest already merged.
  const registered = registerDynamicGame(game);
  if (!registered) {
    reportError(bundle.name, bundle.version, `gameId collision: "${mod.game.id}" is already registered`);
    return;
  }

  // Promote pending → active for this bundle. Deliberately a SINGLE confirmBoot call,
  // not the shell's two-separate-launches ritual — see the native listBundles() doc
  // comment (definitions.ts) for why that distinction is safe here: a broken sub-game
  // fails the checks above, never the app's own cold boot.
  try {
    const m = await import('capacitor-modoki-ota');
    await m.ModokiOta.confirmBoot({ name: bundle.name });
  } catch (e) {
    // Same distinction as the shell's own confirmBoot — see `isPluginUnimplemented`.
    if (isPluginUnimplemented(e)) {
      console.log(`[GameShell] no OTA plugin — sub-game "${bundle.name}" confirmBoot skipped`);
    } else {
      console.warn(`[GameShell] sub-game "${bundle.name}" confirmBoot failed (non-fatal):`, e);
    }
  }
}

let subgamesLoadPromise: Promise<void> | null = null;

/** Discovers + loads every staged sub-game bundle this device has. Memoized like
 *  `ensureManifestLoaded()` — measured: `App.tsx`'s effect that calls this legitimately
 *  fires more than once in a real session (App-level effects aren't immune to the same
 *  "runs again" pattern `GameShell`'s per-gameId boot effect already documents), and a
 *  second full pass re-runs `checkForUpdate` → `activate()` for a bundle already staged
 *  this session — `activate()` correctly-and-intentionally clears that bundle's
 *  `confirmedBoots` progress every time it's called (re-activating always resets confirm
 *  progress), so an unguarded re-entry here permanently loses the first pass's boot
 *  confirmation. Memoizing so the real work runs exactly once per app session, regardless
 *  of how many times a boot-path effect calls it, fixes this at the source rather than
 *  chasing why the caller re-fires. Best-effort: a failure loading ONE sub-game is
 *  reported via `subscribeSubgameLoadErrors` and does not stop the others from loading,
 *  and any failure here must never affect the shell's own boot (the shell doesn't depend
 *  on any sub-game to function). */
export function loadStagedSubgames(): Promise<void> {
  if (subgamesLoadPromise) return subgamesLoadPromise;
  subgamesLoadPromise = (async () => {
    const { ota } = projectConfig;
    if (!ota.enabled) return;
    if (!Capacitor.isNativePlatform()) return; // no OTA mechanism (and no staged bundles) on web

    try {
      await checkAppSubgameUpdates();
      const m = await import('capacitor-modoki-ota');
      const { bundles } = await m.ModokiOta.listBundles();
      const subgameBundles = bundles.filter((b) => b.name !== ota.bundleName);
      // Sequential, NOT Promise.all: loadOneSubgame's belt-and-suspenders check #2 reads
      // globalThis.__MODOKI_SUBGAME__, a SINGLE global slot every sub-game's IIFE writes.
      // Loading two bundles concurrently races two <script> tags against that one slot —
      // whichever finishes downloading second can clobber (or be clobbered by) the other's
      // read, misattributing one sub-game's module to another's bundle name/version. A
      // dynamically-injected <script> executes as soon as ITS download completes, not in
      // insertion order, so this can't be fixed by just awaiting appendChild in a loop
      // without also awaiting the full loadOneSubgame (including the read+clear of the
      // global) before starting the next bundle's script tag.
      for (const b of subgameBundles) {
        await loadOneSubgame(b);
      }
    } catch (e) {
      console.warn('[GameShell] loadStagedSubgames failed (non-fatal):', e);
    }
  })();
  return subgamesLoadPromise;
}
