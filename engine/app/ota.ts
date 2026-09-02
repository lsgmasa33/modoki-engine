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
import { createSupersessionToken } from '@modoki/engine/runtime/core/liveness';
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
// `setGate` from an attempt nobody wants anymore. Start a new attempt per call, and refuse every
// gate write once a newer call has started — the same shape as `app/editor/setup.ts`'s
// `deviceListEpoch`. ⚠️ NOT the same as `loaders/fontLoader.ts` / `loaders/timelineCache.ts`,
// which this comment used to claim: those are `createTeardownToken` — they bump when the cache is
// CLEARED, not when a new attempt starts, so an outstanding load survives a newer one there and
// loses here. The two read alike and answer different questions; see docs/async-lifetime.md.
const otaCheckEpoch = createSupersessionToken();

export async function checkAppOtaUpdate(): Promise<boolean> {
  // `ready-to-restart` is terminal for this app launch (see setGate's backstop and this
  // function's doc comment): once a mandatory update has staged, NOTHING may boot behind that
  // screen. The `[gameId]` boot effect in App.tsx can call this again after the gate is up — a
  // game swap — and without this the second call would find nothing to do, return `true`, and
  // let App.tsx load a scene underneath a gate the user cannot dismiss (#437 review finding 3).
  if (gateState?.phase === 'ready-to-restart') return false;

  const { ota } = projectConfig;
  // Gated on `enabled`, NOT on `ota.publicKey` — which defaults to `''`. That is the shape #510
  // was (a guard on a different field than the one being used), and it is safe here only because
  // `publicKey` never crosses the native bridge: it is consumed by `verifyReleaseSignature` in
  // `runtime/ota/otaClient.ts` (JS — NOT the `capacitor-modoki-ota` plugin, which only handles the
  // `native:` side), which returns false on a blank key instead of throwing, so the outcome is a
  // `signature-invalid` refusal. `vite-asset-scanner.ts` also checks it at build time. If this key
  // ever starts being passed to a plugin call, it needs its own guard.
  if (!ota.enabled) return true;
  if (!Capacitor.isNativePlatform()) return true; // no OTA mechanism to hand this to on web

  const stillLive = otaCheckEpoch.begin();
  const setGateIfCurrent = (state: OtaGateState | null): void => {
    if (!stillLive()) return; // superseded — a newer check owns the gate now
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

    // #509: a mandatory update this call did NOT stage, because a CONCURRENT call already staged it,
    // is still a mandatory update this launch must not boot past. `pending` is durable native state;
    // `outcome` is a fact about this call. Asking the per-call question to answer the durable one is
    // what let a game-swap re-check tear the gate down and boot behind it.
    const mandatoryHold =
      (result.outcome === 'staged' || result.outcome === 'pending-restart') && result.mandatory;
    if (mandatoryHold) {
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

/** Whether this launch's "fully booted" signal is evidence about the version that is PENDING
 *  — and if so, which version, so the confirm can NAME it.
 *
 *  ⚠️ Pure and separately tested because the answer is not "always yes", which is what
 *  `App.tsx` assumed. Found by #553's close-out sweep: `checkAppOtaUpdate()` runs BEFORE this
 *  signal in the same boot effect, and for a ROUTINE (non-mandatory) update it stages and
 *  `activate()`s the new version mid-launch — setting `pending` to a version that is NOT the
 *  one rendering. An unconditional confirm then credits vNew with a successful boot of vOld,
 *  so vNew reached `active` after ONE boot of itself instead of the two `requiredConfirms`
 *  exists to demand ("a single rendered frame is not proof against a bundle that crashes later
 *  in a gameplay path" — OtaCore.swift). A MANDATORY update is unaffected: the gate returns
 *  early and this signal never fires.
 *
 *  `bootAttempts` is the discriminator, and it is the same one `otaClient.ts`'s
 *  `alreadyServed` check already relies on and documents: `activate()` clears it when staging,
 *  and the native boot hook increments it when it SERVES the pending bundle, before the WebView
 *  loads. So `> 0` means we are running the pending version right now.
 *
 *  Exported for tests — `App.tsx` is a `.tsx` and the DECISION belongs in a plain `.ts` module
 *  beside it (docs/editor.md § Panels). */
export function decideShellConfirm(stateJSON: string, bundleName: string):
  | { confirm: true; version?: string }
  | { confirm: false; reason: string } {
  let state: { pending?: Record<string, string>; bootAttempts?: Record<string, number> } | null;
  try {
    state = stateJSON && stateJSON !== 'null' ? JSON.parse(stateJSON) : null;
  } catch {
    // Unparseable state is the native side's problem, not ours; confirm unversioned and let
    // OtaCore's own corrupt-state contract decide (it treats it exactly like "no state").
    return { confirm: true };
  }
  const pending = state?.pending?.[bundleName];
  // Nothing staged: the confirm is a documented no-op. Kept rather than skipped so a project
  // with no pending version still exercises the same call path (and the same logging).
  if (!pending) return { confirm: true };
  if ((state?.bootAttempts?.[bundleName] ?? 0) > 0) return { confirm: true, version: pending };
  return { confirm: false, reason: `pending ${pending} has not been served yet — this boot is the previous version` };
}

/** Runs the shell's boot confirm, naming the version when this launch can attribute it.
 *  Best-effort and native-only, exactly as the inline version in `App.tsx` was. */
export async function confirmShellBoot(): Promise<void> {
  const { ota } = projectConfig;
  try {
    const m = await import('capacitor-modoki-ota');
    const { stateJSON } = await m.ModokiOta.getState();
    const decision = decideShellConfirm(stateJSON, ota.bundleName);
    if (!decision.confirm) {
      console.log(`[GameShell] OTA confirmBoot skipped — ${decision.reason}`);
      return;
    }
    await m.ModokiOta.confirmBoot({ name: ota.bundleName, ...(decision.version ? { version: decision.version } : {}) });
  } catch (e) {
    // A project without the OTA native plugin rejects this on EVERY launch, so a warn here
    // files a Crashlytics issue per session for a non-event. A real confirmBoot failure still
    // warns — on a project that ships OTA it is what the rollback watchdog keys on.
    if (isPluginUnimplemented(e)) console.log('[GameShell] no OTA plugin on this platform — confirmBoot skipped');
    else console.warn('[GameShell] OTA confirmBoot failed (non-fatal):', e);
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
