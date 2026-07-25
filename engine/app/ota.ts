/** Shell-owned OTA update check + blocking-gate state (docs/ota-updates.md, Phase 3a/3b).
 *  Replaces the per-game `runtime/ota.ts` pattern (games/ota-test's own copy, whose header
 *  said "not a pattern other games should copy" — this is that promised replacement):
 *  connection info comes from THIS project's `project.config.json` `ota` block, not a
 *  hardcoded per-game constant, so any project gets a working check just by filling in
 *  that block, no bespoke wiring file needed.
 *
 *  Called from App.tsx BEFORE the scene loads (not from a game's `onSceneReady`, which only
 *  fires after the scene has already rendered) — a blocking gate for `mandatory` releases
 *  needs a pre-scene call site to block from. `checkAppOtaUpdate` resolves `false` when the
 *  caller must NOT proceed to load the scene this launch — see its doc comment. */
import { Capacitor } from '@capacitor/core';
import { checkForUpdate, fetchRelease } from '@modoki/engine/runtime';
import type { OtaProgressEvent } from 'capacitor-modoki-ota';
import projectConfig from 'virtual:modoki-project-config';

/** The owner's Phase 3 decision (docs/plans/mobile-ota-updates-plan.md): a mandatory
 *  release blocks with a progress screen while it downloads, then a dead-end
 *  "restart to continue" screen — never a mid-session hot-swap (that would bypass the
 *  two-boot confirm the native watchdog is built around). `'downloading'` covers BOTH
 *  "we know staging is about to start" (progress may still be null for a beat) and
 *  "ticks are arriving"; `'ready-to-restart'` is terminal for this app launch. */
export type OtaGateState =
  | { phase: 'downloading'; version: string; progress: OtaProgressEvent | null }
  | { phase: 'ready-to-restart'; version: string };

let gateState: OtaGateState | null = null;
type GateListener = (state: OtaGateState | null) => void;
const gateListeners = new Set<GateListener>();

function setGate(state: OtaGateState | null): void {
  gateState = state;
  gateListeners.forEach((l) => l(state));
}

/** Subscribes to the blocking-gate state for the UI (App.tsx). Invoked immediately with
 *  the CURRENT state, then again on every change. Returns an unsubscribe function. */
export function subscribeOtaGate(listener: GateListener): () => void {
  gateListeners.add(listener);
  listener(gateState);
  return () => gateListeners.delete(listener);
}

/** Runs the Phase 3a OTA check. Resolves `true` if the caller should continue booting
 *  normally (nothing to do, a routine/background update, or any error — an OTA check
 *  failing must never block a game that's otherwise fine). Resolves `false` if a
 *  genuinely mandatory update finished staging THIS call — the caller must stop and
 *  never load the scene for the rest of this app launch; `subscribeOtaGate` reports
 *  `'ready-to-restart'` from that point on, and only a manual app restart (native
 *  boot hook re-derives what to serve from state.json) moves things forward. */
export async function checkAppOtaUpdate(): Promise<boolean> {
  const { ota } = projectConfig;
  if (!ota.enabled) return true;
  if (!Capacitor.isNativePlatform()) return true; // no OTA mechanism to hand this to on web

  try {
    const m = await import('capacitor-modoki-ota');
    let armed = false; // true once onWillStage has told us THIS update is mandatory
    const listenerHandle = await m.ModokiOta.addListener('otaProgress', (e) => {
      console.log('[GameShell] OTA progress:', e);
      if (armed) setGate({ phase: 'downloading', version: e.version, progress: e });
    });

    const result = await checkForUpdate({
      baseUrl: ota.baseUrl,
      publicKey: ota.publicKey,
      bundleName: ota.bundleName,
      runningEngineApi: ota.engineApi,
      native: m.ModokiOta,
      onWillStage: (info) => {
        if (!info.mandatory) return;
        armed = true;
        setGate({ phase: 'downloading', version: info.version, progress: null });
      },
    });
    console.log('[GameShell] OTA checkForUpdate result:', result);
    void listenerHandle.remove();

    if (result.outcome === 'staged' && result.mandatory) {
      setGate({ phase: 'ready-to-restart', version: result.version });
      return false;
    }
    setGate(null); // un-arm: either nothing mandatory happened, or staging failed downstream
    return true;
  } catch (e) {
    console.warn('[GameShell] OTA checkForUpdate failed (non-fatal):', e);
    setGate(null);
    return true;
  }
}

/** OTA Phase 4 (docs/ota-subgame-modules.md) — stages any new versions of every
 *  sub-game bundle the release names, so `subgameLoader.ts`'s subsequent `listBundles()`
 *  call sees them. Deliberately does NOT surface `result.mandatory` for a sub-game the
 *  way `checkAppOtaUpdate` does for the shell — a release's `mandatory` flag is meant for
 *  the shell bundle; a sub-game update NEVER blocks boot regardless of that flag, it
 *  just becomes loadable in the background (same as any other routine update). Always
 *  best-effort: never throws, and a failure here must not stop the shell's own boot. */
export async function checkAppSubgameUpdates(): Promise<void> {
  const { ota } = projectConfig;
  if (!ota.enabled) return;
  if (!Capacitor.isNativePlatform()) return; // no OTA mechanism to hand this to on web

  try {
    const released = await fetchRelease({ baseUrl: ota.baseUrl, publicKey: ota.publicKey });
    if (!released.ok) return;

    const m = await import('capacitor-modoki-ota');
    const subgameNames = Object.keys(released.release.bundles).filter((n) => n !== ota.bundleName);
    await Promise.all(subgameNames.map(async (bundleName) => {
      try {
        const result = await checkForUpdate({
          baseUrl: ota.baseUrl,
          publicKey: ota.publicKey,
          bundleName,
          runningEngineApi: ota.engineApi,
          native: m.ModokiOta,
        });
        console.log(`[GameShell] OTA sub-game "${bundleName}" checkForUpdate result:`, result);
      } catch (e) {
        console.warn(`[GameShell] OTA sub-game "${bundleName}" checkForUpdate failed (non-fatal):`, e);
      }
    }));
  } catch (e) {
    console.warn('[GameShell] OTA sub-game update check failed (non-fatal):', e);
  }
}
