/**
 * Built-in IAP control layer — engine-wide UI actions, so a game wires a store button and the
 * mandatory Restore control DECLARATIVELY (a scene-authored `UIAction` binding) instead of
 * hand-driving the service from its `setup.ts`.
 *
 * ⚠️ **Registered BY THE GAME, not app-wide** — unlike `registerAudioControls` /
 * `registerHapticControls`, which `engine/app/ecs/register.ts` calls once at bootstrap. That
 * difference is deliberate: audio and haptics are engine capabilities every game has, whereas the
 * native store is an **opt-in dependency** (a game that does not list `capacitor-modoki-iap` ships
 * no StoreKit and no Play Billing at all), so registering `iap.buy` app-wide would advertise a
 * dispatchable action that can never work in most projects.
 *
 * Consequence to know: once any game calls this, the actions stay registered for the rest of the
 * process, including after a swap to a non-IAP game. That is harmless — both handlers route through
 * `activeCfg()`, which is `null` after `resetIap()` and journals a warning instead of doing
 * anything, so no money can move — but it is why there is no `unregisterIapControls`.
 *
 * (This header previously claimed app-wide parity with audio/haptics, which was simply not what the
 * code did. Recorded rather than quietly corrected, because the mismatch is the kind of thing that
 * later gets "fixed" in the wrong direction.)
 *
 * Actions:
 *  - `iap.buy`     — start a purchase (payload `{ product }`). No default: unlike a haptic, there
 *                    is no sensible "the obvious one" to fall back to, and guessing would charge
 *                    real money for a typo.
 *  - `iap.restore` — re-derive entitlements and recover anything unfinished. **App Store review
 *                    requires a visible control that does this**, so it ships as a first-class
 *                    action rather than something each game reimplements.
 *
 * ── Fire-and-forget, and why the UI must not await a result ────────────────────
 * Both handlers `void` their promise. A purchase can take a minute (the platform sheet, Face ID, a
 * parent approving Ask-to-Buy), and a UI action that blocked for that would freeze the frame. The
 * outcome reaches the game the same way every other engine event does — the journal, plus the
 * entitlement/balance reads the UI binds to. That also means a purchase interrupted by a crash
 * needs no special UI handling: the next launch's `reconcile()` grants it and the same bindings
 * update.
 *
 * App-tier and event-driven — no per-frame tick, no wall-clock, no randomness — so it never enters
 * the deterministic headless pipeline.
 */

import { registerUIAction } from '../core/actionRegistry';
import { purchase, restorePurchases } from '../iap/purchaseService';

export function registerIapControls(): void {
  registerUIAction('iap.buy', ({ payload, params }) => {
    // Accepts BOTH shapes on purpose. A product id is a single value, so the scalar form is the
    // natural UIAction convention (and the only one an agent `dispatch_action` can send); the
    // object form is what a scene binding that carries several fields will use. Supporting only
    // the object form made the action undispatchable from the MCP surface — found live, not in a
    // unit test, because a unit test would have called it whichever way the code already expected.
    const fromScalar = typeof payload === 'string' ? payload : '';
    const fromObject = (payload ?? {}) as { product?: unknown };
    const fromParams = (params ?? {}) as { product?: unknown };
    const product = fromScalar
      || (typeof fromObject.product === 'string' ? fromObject.product : '')
      || (typeof fromParams.product === 'string' ? fromParams.product : '');

    // Authored scene data — validated, never trusted. Refusing loudly beats charging for whatever
    // `String(undefined)` resolves to.
    if (!product) {
      console.error('[iap] `iap.buy` needs a product id — either the bare string payload '
        + '"<store product id>" or { product: "<store product id>" }. Ignoring.');
      return;
    }
    void purchase(product);
  });

  registerUIAction('iap.restore', () => {
    void restorePurchases();
  });
}
