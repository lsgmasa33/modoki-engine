/** Built-in render-quality control layer — one engine-wide UI action, so a game wires a settings
 *  screen's "Auto / Low / Mid / High" picker DECLARATIVELY (a scene-authored `UIAction` binding)
 *  instead of hand-driving `choosePlayerQualityTier` from its `setup.ts`. Registered once app-wide
 *  by `registerQualityControls`, alongside `registerHapticControls`.
 *
 *  App-tier and event-driven — no per-frame tick, no wall-clock, no randomness — so it never enters
 *  the deterministic headless pipeline.
 *
 *  Actions:
 *   - `quality.set` — set the player's stored tier choice. `'auto'` clears the override and hands
 *                     control back to the project setting + calibration; a real tier
 *                     (`'low'`/`'mid'`/`'high'`) pins it. The one a settings screen uses to give
 *                     the player the escape hatch with zero TS.
 *
 *  ── HOW IT IS AUTHORED, AND WHY IT READS BOTH `params` AND `payload` ──────────────────────
 *  ⚠️ **`UIActionPayload` IS `string | number`, so an OBJECT payload cannot reach a handler from
 *  a scene at all.** A binding authors `params: Record<string, unknown>`, and `ui/bindings.ts`
 *  routes those to `ctx.params`; `ctx.payload` gets the live event value (`$value` from a slider
 *  or picker), falling back to an authored `params.payload` for the schema-less one-value
 *  convention. A handler that reads `payload.tier` therefore receives `undefined` from every
 *  authorable binding and silently does nothing — an action that exists, registers, dispatches
 *  and has no effect. (That shape is live in `hapticControls.ts`, whose `haptics.play` reads
 *  `payload.pattern`; no scene, test or caller in the repo exercises it. See #188's close-out.)
 *
 *  So both authorings work, and both are things a real settings screen wants:
 *
 *      // a button per tier — the typed-argument form the editor renders widgets for
 *      { event:'click', kind:'call', action:'quality.set', params:{ tier:'mid' } }
 *
 *      // one picker driving all four — `$value` arrives as ctx.payload
 *      { event:'change', kind:'call', action:'quality.set', params:{ tier:'$value' } }
 *
 *  `params.tier` is preferred; `payload` is the fallback, so a control that emits its value
 *  directly needs no wrapper param.
 *
 *  Goes through `choosePlayerQualityTier` ONLY — it persists the choice to PlayerPrefs AND applies
 *  it live in one call, and keeping that pairing in one path is deliberate (see its own doc). A
 *  second writer calling `setPlayerQualityTier`/`applyQualityTier` separately could apply without
 *  persisting or vice versa, and the two would drift.
 */

import { registerUIAction } from '../core/actionRegistry';
import { choosePlayerQualityTier } from '../rendering/playerQualityTier';
import { isQualityTier } from '../rendering/qualityTier';

/** What an "Auto" option writes: no override, back to the project setting + calibration. It is a
 *  SETTING and not a tier, which is why `isQualityTier('auto')` is false and it is matched here. */
const AUTO = 'auto';

export function registerQualityControls(): void {
  registerUIAction('quality.set', ({ params, payload }) => {
    const chosen = params?.tier ?? payload;
    if (chosen === AUTO) {
      choosePlayerQualityTier(null);
      return;
    }
    // Through `isQualityTier`, never a hand-written union — see playerQualityTier.ts's header for
    // why a second copy of the valid set is a real bug shape (a newly added tier persists fine and
    // reads back as "no choice"). Also covers a missing/malformed value: authored scene data —
    // validated, never trusted.
    if (!isQualityTier(chosen)) return;
    choosePlayerQualityTier(chosen);
  });
}
