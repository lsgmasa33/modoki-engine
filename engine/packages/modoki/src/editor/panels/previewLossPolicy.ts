/** previewLossPolicy — the ONE loss policy shared by every editor preview surface (#795):
 *  `ShaderPreview.tsx`, `previewScene.ts` (Mesh/Material previews), `ModelPreview.tsx`, and
 *  `ParticleEditor.tsx`.
 *
 *  Detection is uniform (`runtime/rendering/rendererLossHandling.ts`); policy is not — a game
 *  viewport rebuilds in place because staying blank mid-play is unacceptable, but these panels
 *  are cheap to reopen and rebuild-in-place would put this decision inside `canvas2DPool.ts`,
 *  where issue #801 is a pending, separate design change to that recovery machinery.
 *
 *  So the policy here is: **log loudly, then tear the surface down** so reopening the panel is a
 *  clean rebuild rather than trying to resuscitate a half-dead renderer. Per `CLAUDE.md` § Editor
 *  Panels, this lives in a plain `.ts` module beside the panels so it is unit-testable without
 *  mounting any of them in jsdom. */

import type { RendererLossEvent, RendererLossHandlers } from '../../runtime/rendering/rendererLossHandling';

/** Shared by every caller whose actual recovery path is "close and reopen the Inspector", not the
 *  DEFAULT hint's "reopen the panel" — `previewScene.ts` (its own `PreviewSceneHandle` finding 2)
 *  and `ModelPreview.tsx` (finding 6, third adversarial review of #795) both live inside
 *  `Inspector.tsx` mounted with no `key`, so reselecting a different Mesh/Material/model asset
 *  re-populates the SAME instance in place rather than unmounting it. Exported so
 *  `modelPreviewLoss.ts`'s own user-facing message can single-source this exact phrase instead of
 *  carrying a second, driftable copy. */
export const REOPEN_INSPECTOR_HINT = 'close and reopen the Inspector to rebuild it';

export interface PreviewLossPolicyOptions {
  /** Surface name for the log line, e.g. 'ShaderPreview', 'ModelPreview'. */
  label: string;
  /** This panel's OWN existing teardown path — never a new one. Called at most once; guarded so
   *  a throw inside it can never escape into the context-loss event handler. */
  teardown: () => void;
  /** How the user actually recovers THIS surface, appended to the log line. Defaults to "reopen
   *  the panel to rebuild it" — accurate for a panel whose mount effect keys on the thing the user
   *  reselects, so picking a different asset tears the old scene down and builds a fresh one
   *  (ShaderPreview keys its mount effect on `path`; ParticleEditor's containing panel is closed
   *  and reopened per asset). `previewScene.ts`'s caller (`Preview3DShell`, embedded in the
   *  Mesh/Material Inspector) and `ModelPreview.tsx` (embedded in the Model Inspector) do NOT fit
   *  that shape — reselecting a different asset re-populates the SAME handle/instance in place, so
   *  both override this with `REOPEN_INSPECTOR_HINT` above (finding 2, then finding 6, adversarial
   *  review of #795 — the first pass fixed only `previewScene.ts` and left `ModelPreview.tsx`
   *  mis-described as fitting the default). */
  recoverHint?: string;
}

/** Build the `{ describe, onLost }` pair for a preview panel. `isStale` is the CALLER's to supply
 *  (each panel already tracks its own disposed/serial/superseded state) — this module only knows
 *  what to do once a loss is confirmed live. */
export function makePreviewLossPolicy({ label, teardown, recoverHint = 'reopen the panel to rebuild it' }: PreviewLossPolicyOptions): Pick<RendererLossHandlers, 'describe' | 'onLost'> {
  let handled = false;
  return {
    describe: (e: RendererLossEvent) =>
      `[${label}] ${e.api} context/device LOST${e.reason ? ` (reason: ${e.reason})` : ''} — this ` +
      `preview will stay BLANK. Tearing it down; ${recoverHint}.`,
    onLost: () => {
      // A `webglcontextlost` + a later `device.lost` resolution on the SAME surface, or two
      // detach halves both firing, must not run teardown twice.
      if (handled) return;
      handled = true;
      try {
        teardown();
      } catch (err) {
        console.error(`[${label}] teardown after a lost context/device itself failed`, err);
      }
    },
  };
}
