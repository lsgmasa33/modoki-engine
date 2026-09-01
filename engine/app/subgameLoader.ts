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

/** What a refusal proves about the BUNDLE, not how bad it is — see the native
 *  `reportBundleLoadFailure` doc (definitions.ts) and `OtaLoadFailure` (OtaCore.swift).
 *  `null` is success. Every early return in `loadOneSubgame` picks one of these, and the
 *  choice is load-bearing: `'fatal'` quarantines the version permanently on this device,
 *  `'notEvidence'` must not even cost it an attempt. */
type LoadDisposition = 'fatal' | 'transient' | 'notEvidence';

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

/** Loads one specific version of one bundle. Returns `null` on success, or the disposition
 *  of the refusal — the CALLER decides what to do with that, because only the caller knows
 *  whether this was the attempt or the fallback. Deliberately does NOT call `confirmBoot`
 *  itself any more (#553): a confirm must be attributable to the version that loaded, and
 *  this function is called for the fallback version too, which must never be confirmed. */
async function loadOneSubgame(bundle: { name: string; version: string; path: string }): Promise<LoadDisposition | null> {
  const baseUrl = Capacitor.convertFileSrc(bundle.path).replace(/\/$/, '');

  // ⚠️ The fetch REJECTING and the response being non-ok are different evidence, and collapsing
  // them into one catch charged a transport hiccup as a permanent quarantine. A missing file
  // returns a clean 404 through Capacitor's local scheme (device-verified) — that is content.
  // A rejection is a WebView-loader `TypeError`, which says nothing about the bytes, and
  // `rejected` survives `resetForNewBinary`, so getting this wrong blocks a GOOD version on that
  // device with no un-quarantine path anywhere in the codebase. (That justification is about a
  // PENDING version — an active one is never quarantined at all; see OtaCore.loadFailed.)
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/subgame.json`);
  } catch (e) {
    reportError(bundle.name, bundle.version, `subgame.json fetch threw: ${e}`);
    return 'transient';
  }
  if (!res.ok) { reportError(bundle.name, bundle.version, `subgame.json fetch failed (${res.status})`); return 'fatal'; }
  let manifest: SubgameManifest;
  try {
    manifest = await res.json();
  } catch (e) {
    reportError(bundle.name, bundle.version, `subgame.json parse threw: ${e}`);
    return 'fatal';
  }

  // Belt-and-suspenders check #1: the build-stamped manifest field. Checked BEFORE
  // evaluating the bundle at all — no reason to even load a script we already know is
  // incompatible.
  if (manifest.engineApi !== ENGINE_API_VERSION) {
    // 'notEvidence', NOT 'fatal': this bundle is fine, it just does not match THIS engine.
    // Quarantining it would outlive the app binary (`rejected` survives resetForNewBinary)
    // and permanently block a version the next engine upgrade would run perfectly.
    reportError(bundle.name, bundle.version, `engineApi mismatch: manifest declares ${manifest.engineApi}, running ${ENGINE_API_VERSION}`);
    return 'notEvidence';
  }

  const shared = globalThis.__MODOKI_SHARED__;
  if (!shared) {
    // A shell bug, not a bundle defect — no version deserves an attempt for this.
    reportError(bundle.name, bundle.version, 'globalThis.__MODOKI_SHARED__ is not initialized (sharedRegistry.ts did not run)');
    return 'notEvidence';
  }
  try {
    await shared.ensure(manifest.sharedDeps ?? []);
  } catch (e) {
    // The one genuinely retryable failure in here: `ensure()` fetches, and a fetch can fail
    // for reasons that are gone by the next launch.
    reportError(bundle.name, bundle.version, `shared dependency load failed: ${e}`);
    return 'transient';
  }

  try {
    await loadScriptTag(`${baseUrl}/${manifest.entry}`);
  } catch (e) {
    reportError(bundle.name, bundle.version, `${e}`);
    return 'fatal';
  }

  // Belt-and-suspenders check #2: the module's OWN static export, set by the exact same
  // build that produced subgame.json but read from a DIFFERENT artifact — catches a
  // hand-edited/corrupted subgame.json that "fixed" check #1 without rebuilding.
  const mod = globalThis.__MODOKI_SUBGAME__ as SubgameModuleExports | undefined;
  globalThis.__MODOKI_SUBGAME__ = undefined; // consumed — the next bundle's script must not silently read a stale value if it fails before assigning its own
  // ⚠️ These two used to share one branch, and they are opposite claims. A `<script>` whose code
  // THROWS at evaluation fires `load`, not `error` — so `loadScriptTag` above resolves and we
  // arrive here with the global unassigned. `!mod` therefore means the bundle crashed on
  // evaluation, which is the most likely real breakage there is and is squarely `fatal`.
  // Classifying it `notEvidence` refunded the attempt, so `bootAttempts` never passed 1,
  // `boot()`'s exhaustion revert could never fire, and `checkForUpdate` short-circuits
  // `up-to-date` on a still-pending version — a crashing bundle was refused on every launch
  // forever, never reverted and never quarantined. That is the exact state #553 exists to
  // remove, surviving inside its own fix.
  if (!mod) {
    // 'transient', deliberately — and the ONLY thing that matters here is that it is not
    // 'notEvidence', which refunded the attempt so nothing could ever escalate (the defect this
    // branch was split out to fix). Between the two escalating options, `transient` is right
    // because this evidence is AMBIGUOUS: `subgameBuild.ts` puts the global assignment at the
    // very end of the module graph, so ANY module-scope throw lands here — including ones that
    // are facts about the DEVICE rather than the bytes (an `AudioContext` constructed at import,
    // a `navigator.gpu` probe, a blocked `localStorage`). Quarantine is permanent and survives
    // `resetForNewBinary`, so charging one of those `fatal` would block a good bundle that a
    // later WebView fix would run perfectly. `transient` still reaches revert + quarantine after
    // `maxAttempts`, so a genuinely crashing bundle is caught anyway — three launches later,
    // during which the fallback serves and the player loses nothing. #550's fail-fast is not in
    // tension: that was about a MISSING manifest, which is unambiguous; this is not.
    reportError(bundle.name, bundle.version, 'module did not assign globalThis.__MODOKI_SUBGAME__ — its script threw at evaluation, or it is not a sub-game bundle');
    return 'transient';
  }
  if (mod.engineApi !== ENGINE_API_VERSION) {
    reportError(bundle.name, bundle.version, `module engineApi mismatch: got ${mod.engineApi}, running ${ENGINE_API_VERSION}`);
    return 'notEvidence'; // same reasoning as the manifest engineApi check above
  }
  if (!mod.game || typeof mod.game.id !== 'string' || !mod.game.id) {
    reportError(bundle.name, bundle.version, 'loaded module has no valid game.id');
    return 'fatal';
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
    // 'notEvidence': a collision is a fact about this SHELL's current registry, not about
    // the bundle's bytes — a shell update that renames the baked game resolves it.
    reportError(bundle.name, bundle.version, `gameId collision: "${game.id}" is already registered`);
    return 'notEvidence';
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
  let manifestRes: Response;
  try {
    manifestRes = await fetch(`${baseUrl}/assets.manifest.json`);
  } catch (e) {
    // Transport, not content — see the subgame.json fetch above for why this must not quarantine.
    reportError(bundle.name, bundle.version, `assets.manifest.json fetch threw: ${e}`);
    return 'transient';
  }
  if (!manifestRes.ok) {
    reportError(bundle.name, bundle.version, `assets.manifest.json fetch failed (${manifestRes.status})`);
    return 'fatal';
  }
  try {
    const fragment: AssetManifestFile = await manifestRes.json();
    loadManifestJson(fragment, { pathPrefix: baseUrl });
  } catch (e) {
    // Unparseable, or a merge that threw: the published bytes are broken. This is #540's case
    // and the one device-verified as fatal.
    reportError(bundle.name, bundle.version, `assets.manifest.json parse threw: ${e}`);
    return 'fatal';
  }

  // Authoritative claim. The probe above is sufficient, not just narrowing: sub-games load
  // sequentially in one memoized pass (loadStagedSubgames()'s `for` loop awaits each
  // loadOneSubgame() in turn, and this is the only production caller of registerDynamicGame),
  // so nothing can register between the probe and this call — a same-id bundle is always
  // caught by the probe, never by a race with the loser's manifest already merged.
  // ⚠️ Unreachable today — this evaluates the same predicate over the same list as the probe
  // above, and the loop is sequential. Kept, but note WHY it matters that it is dead: it is the
  // only refusal that can occur AFTER `loadManifestJson` merged, so "a refused bundle never
  // leaves a half-merged manifest behind for the fallback to inherit" is true by accident, not
  // by design. Adding any new check between the merge and this return breaks that silently.
  const registered = registerDynamicGame(game);
  if (!registered) {
    reportError(bundle.name, bundle.version, `gameId collision: "${mod.game.id}" is already registered`);
    return 'notEvidence';
  }

  return null; // loaded and registered — the CALLER decides whether this earns a confirm
}

let subgamesLoadPromise: Promise<void> | null = null;

/** Records a refused load with native so the watchdog can act on it, and returns the version
 *  to fall back to this launch (or `null` for "nothing loadable"). Best-effort: a project
 *  without the OTA plugin has no watchdog to tell, and that must not break anything. */
async function reportFailureToWatchdog(
  m: typeof import('capacitor-modoki-ota'),
  name: string,
  version: string,
  disposition: LoadDisposition,
): Promise<{ version: string; path: string } | null> {
  try {
    const fallback = await m.ModokiOta.reportBundleLoadFailure({ name, version, disposition });
    if (fallback.target !== 'version') return null;
    return { version: fallback.version, path: fallback.path };
  } catch (e) {
    if (isPluginUnimplemented(e)) {
      console.log(`[GameShell] no OTA plugin — sub-game "${name}" failure not recorded`);
    } else {
      console.warn(`[GameShell] sub-game "${name}" reportBundleLoadFailure failed (non-fatal):`, e);
    }
    return null;
  }
}

/** Loads one bundle NAME: asks the watchdog which version to run, runs it, and confirms it
 *  only if it actually loaded (#553).
 *
 *  The shape here is the whole fix, so it is worth stating plainly. The old code asked
 *  `listBundles()` what to load, which prefers `active` over `pending` — so on an UPDATE it
 *  handed back the OLD version, that old version loaded fine, and the unconditional
 *  `confirmBoot` that followed credited the NEW one. Two launches of that and a bundle that
 *  had never once executed was promoted to `active`, where nothing could demote it. Now:
 *
 *   1. `beginBundleLoad` picks the version (pending first) and counts the attempt UP FRONT,
 *      so a bundle that kills the page still burns one and is reverted after `maxAttempts`.
 *   2. On success, `confirmBoot` NAMES that version — a confirm can no longer be credited to
 *      a version that did not run, even if some future caller reorders things.
 *   3. On failure, the watchdog is told what the refusal proves and answers with the version
 *      to fall back to, which is loaded but ⚠️ NEVER confirmed — confirming the version being
 *      replaced is the original defect. */
async function loadBundleByName(
  m: typeof import('capacitor-modoki-ota'),
  name: string,
  discovered: { name: string; version: string; path: string },
): Promise<void> {
  // ⚠️ Forward compatibility, and it is not hypothetical. The shell's JS is delivered OVER THE
  // AIR; the native plugin ships in the APP BINARY. So this exact code can be running on a
  // device whose binary predates `beginBundleLoad` — a new shell bundle on an un-updated app.
  // Left to the outer catch, one UNIMPLEMENTED rejection would abort the whole loop and NO
  // sub-game would load at all on those devices, silently.
  //
  // Degrade to what the old binary can do — load whatever `listBundles` discovered — but
  // deliberately WITHOUT confirming it. `listBundles` prefers `active`, so we cannot attribute
  // the load to the pending version, and confirming an unattributable load is #553 itself.
  // Promotion simply waits for the binary update, which is the safe direction.
  let target: Awaited<ReturnType<typeof m.ModokiOta.beginBundleLoad>>;
  try {
    target = await m.ModokiOta.beginBundleLoad({ name });
  } catch (e) {
    if (!isPluginUnimplemented(e)) throw e;
    console.log(`[GameShell] native OTA plugin predates beginBundleLoad — sub-game "${name}" loads unconfirmed`);
    await loadOneSubgame(discovered);
    return;
  }
  if (target.target !== 'version') return; // nothing staged, or the watchdog just reverted it away

  const disposition = await loadOneSubgame({ name, version: target.version, path: target.path });
  if (disposition === null) {
    try {
      await m.ModokiOta.confirmBoot({ name, version: target.version });
    } catch (e) {
      // Same distinction as the shell's own confirmBoot — see `isPluginUnimplemented`.
      if (isPluginUnimplemented(e)) {
        console.log(`[GameShell] no OTA plugin — sub-game "${name}" confirmBoot skipped`);
      } else {
        console.warn(`[GameShell] sub-game "${name}" confirmBoot failed (non-fatal):`, e);
      }
    }
    return;
  }

  const fallback = await reportFailureToWatchdog(m, name, target.version, disposition);
  if (!fallback || fallback.version === target.version) return;

  // One retry, never more: the fallback is `active`, which by construction has already
  // loaded successfully `requiredConfirms` times, so a second fallback would just be the
  // same version again. Its own failure is still reported — that is how a promoted-then-
  // broken version gets cleared — but the answer is not acted on.
  const fallbackDisposition = await loadOneSubgame({ name, version: fallback.version, path: fallback.path });
  if (fallbackDisposition !== null) {
    await reportFailureToWatchdog(m, name, fallback.version, fallbackDisposition);
  }
}

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
      // ⚠️ `listBundles` is used for DISCOVERY ONLY — which bundle names have content on
      // disk. It prefers `active` over `pending`, so its `version`/`path` are the wrong
      // ones to load; `beginBundleLoad` inside `loadBundleByName` decides that (#553).
      const { bundles } = await m.ModokiOta.listBundles();
      const discovered = bundles.filter((b) => b.name !== ota.bundleName);
      // Sequential, NOT Promise.all: loadOneSubgame's belt-and-suspenders check #2 reads
      // globalThis.__MODOKI_SUBGAME__, a SINGLE global slot every sub-game's IIFE writes.
      // Loading two bundles concurrently races two <script> tags against that one slot —
      // whichever finishes downloading second can clobber (or be clobbered by) the other's
      // read, misattributing one sub-game's module to another's bundle name/version. A
      // dynamically-injected <script> executes as soon as ITS download completes, not in
      // insertion order, so this can't be fixed by just awaiting appendChild in a loop
      // without also awaiting the full loadOneSubgame (including the read+clear of the
      // global) before starting the next bundle's script tag. The fallback retry inside
      // loadBundleByName loads a second script for the same name, and is awaited for the
      // same reason.
      for (const b of discovered) {
        await loadBundleByName(m, b.name, b);
      }
    } catch (e) {
      console.warn('[GameShell] loadStagedSubgames failed (non-fatal):', e);
    }
  })();
  return subgamesLoadPromise;
}
