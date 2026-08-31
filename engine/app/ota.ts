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
import { Capacitor, ExceptionCode } from '@capacitor/core';
import { checkForUpdate, fetchRelease } from '@modoki/engine/runtime';
import type { OtaProgressEvent } from 'capacitor-modoki-ota';
import projectConfig from 'virtual:modoki-project-config';

/**
 * Is this rejection just "this project does not ship that plugin"?
 *
 * ⚠️ **Exists because `console.warn` became a Crashlytics ISSUE** (owner, 2026-08-20). The OTA
 * confirm is best-effort and native-only, and a project without the OTA native plugin rejects it
 * on EVERY launch — observed verbatim on an iPad mini and a Galaxy A23 running `games/court`:
 * `[GameShell] OTA confirmBoot failed (non-fatal)`. Warned about, that becomes the single most
 * frequent issue such a project files, once per session, for a condition its own message calls
 * non-fatal. Logged instead, it stays visible and stops crowding out real crashes.
 *
 * The distinction is NOT a blanket demotion, which is the tempting version and the wrong one: on
 * a project that DOES ship OTA (`games/ota-test`), a failing confirmBoot is exactly the thing
 * worth an alert — it is what the two-boot rollback watchdog keys on. So only the missing-plugin
 * case is quiet.
 *
 * `@capacitor/core` throws `CapacitorException(…, ExceptionCode.Unimplemented)` for a plugin with
 * no implementation on this platform, and both native bridges reject with the same
 * `"UNIMPLEMENTED"` code when a method calls `unimplemented()` — verified in
 * `@capacitor/core/dist/index.cjs.js`, `PluginCall.java` and `CAPPluginCall.swift` rather than
 * assumed, since the two paths are different code.
 */
export function isPluginUnimplemented(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === ExceptionCode.Unimplemented;
}

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
  // A `null` write must never dismiss a mandatory "restart to continue" screen (#437) — that
  // screen is the terminal state for this launch, and clearing it leaves a dead-end shell with
  // no gate and no content.
  //
  // ⚠️ This is DEFENSIVE, and currently unreachable — do not read it as load-bearing. Measured by
  // mutation during #437's close-out: deleting this line fails NO test, because the two guards
  // below already close every path to it. `setGate` has exactly one caller (`setGateIfCurrent`,
  // itself generation-guarded), so a stale call's `null` is dropped on the generation check; and a
  // FRESH call cannot get here either, since `checkAppOtaUpdate` short-circuits on entry once the
  // gate is terminal. It is kept because it is two lines and it protects the one failure that
  // actually hurts (a mandatory screen vanishing) against a FUTURE second caller of `setGate` —
  // not because anything today depends on it.
  if (state === null && gateState?.phase === 'ready-to-restart') return;
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
// #437: the App.tsx boot effect can re-run `checkAppOtaUpdate()` (a `[gameId]` re-run) before an
// in-flight call returns, and that in-flight call is never cancelled — it just keeps writing
// `setGate` from an epoch nobody wants anymore. Same idiom as `loaders/fontLoader.ts` /
// `loaders/timelineCache.ts` / `app/editor/setup.ts`'s `deviceListGeneration`: bump a generation
// per call, and refuse every gate write once a newer call has started.
let otaCheckGeneration = 0;

export async function checkAppOtaUpdate(): Promise<boolean> {
  // `ready-to-restart` is terminal for this app launch (see setGate's backstop and this
  // function's doc comment): once a mandatory update has staged, NOTHING may boot behind that
  // screen. The `[gameId]` boot effect in App.tsx can call this again after the gate is up — a
  // game swap — and without this the second call would find nothing to do, return `true`, and
  // let App.tsx load a scene underneath a gate the user cannot dismiss (#437 review finding 3).
  if (gateState?.phase === 'ready-to-restart') return false;

  const { ota } = projectConfig;
  if (!ota.enabled) return true;
  if (!Capacitor.isNativePlatform()) return true; // no OTA mechanism to hand this to on web

  const myGeneration = ++otaCheckGeneration;
  const setGateIfCurrent = (state: OtaGateState | null): void => {
    if (myGeneration !== otaCheckGeneration) return; // superseded — a newer check owns the gate now
    setGate(state);
  };

  let listenerHandle: { remove: () => Promise<void> } | undefined;
  try {
    const m = await import('capacitor-modoki-ota');
    let armed = false; // true once onWillStage has told us THIS update is mandatory
    listenerHandle = await m.ModokiOta.addListener('otaProgress', (e) => {
      console.log('[GameShell] OTA progress:', e);
      if (armed) setGateIfCurrent({ phase: 'downloading', version: e.version, progress: e });
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
        setGateIfCurrent({ phase: 'downloading', version: info.version, progress: null });
      },
    });
    console.log('[GameShell] OTA checkForUpdate result:', result);

    if (result.outcome === 'staged' && result.mandatory) {
      setGateIfCurrent({ phase: 'ready-to-restart', version: result.version });
      return false;
    }
    setGateIfCurrent(null); // un-arm: either nothing mandatory happened, or staging failed downstream
    return true;
  } catch (e) {
    console.warn('[GameShell] OTA checkForUpdate failed (non-fatal):', e);
    setGateIfCurrent(null);
    return true;
  } finally {
    // The catch above is a routine path, not exceptional — a project without the OTA native
    // plugin rejects `import('capacitor-modoki-ota')` on every launch — so the listener must be
    // removed on that path too, not just after a normal return. `void`-ed: a failure to remove
    // must not mask whatever error is already propagating.
    void listenerHandle?.remove();
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
