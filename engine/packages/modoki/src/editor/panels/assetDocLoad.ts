/** What an asset-DOCUMENT panel does when its read of the file FAILED — the one decision, shared
 *  (#886/#896).
 *
 *  ## The rule
 *
 *  **A failed read yields NO document.** Not `{}`, not `defaultX()`, not an empty typed shell — the
 *  panel must hold nothing and disable editing, so there is no path by which a document the panel
 *  never read can be written back over the file.
 *
 *  ## Why it has to be a rule rather than five judgement calls
 *
 *  These panels persist through `dirtyAssets` → `/api/asset-write`, and a panel-origin flush sends
 *  `replace: true` — a FULL REPLACE that deliberately skips the route's dropped-field guard. So a
 *  fabricated document is not "a slightly wrong starting point": it is the file's next contents.
 *  Five sites had it, with three different fabrications and two different consequences:
 *
 *   - `AnimationEditor` / `TimelineEditor` substituted `defaultX(newGuid(), name)`. Because that
 *     carries an `id`, the route's identity-preservation branch (`if (!out.id && prevDoc?.id)`)
 *     never fires and the file is replaced by a document wearing a DIFFERENT GUID. The scanner's
 *     heal pass cannot flag it — the document looks complete — so every scene/Animator/Director ref
 *     to the old guid dangles silently. This is the same consequence `scene/metaReadFallback.ts`
 *     records for `modelImport.readMeta`, which is why refusing the WRITE is not enough there
 *     either.
 *   - `MaterialBatchView` (`{}`), `SpriteAnimEditor` (`{ clips: {} }`) and `SkinEditor` (an empty
 *     rig) carry no `id`, so the GUID survives — and every other authored field does not.
 *
 *  ⚠️ **A MISSING file is not a failed read**, and collapsing the two is the other way to get this
 *  wrong. For a genuinely absent file — a brand-new asset, or a stale reference — defaults ARE the
 *  correct content, and refusing there would make it impossible to author the asset at all. That
 *  distinction is the whole reason this returns a verdict instead of a boolean, and it is why
 *  `parseAssetJson`'s `MissingAssetError` exists: Vite answers an unknown path with `200
 *  index.html`, so "absent" and "corrupt" arrive at the same `catch` and are indistinguishable
 *  without it.
 *
 *  ## Not a park-time guard, deliberately
 *
 *  The sidecar (`.meta.json`) registry solves its half of this class with a tag on the document,
 *  refused at the write seams (`scene/metaReadFallback.ts`, #880). That shape is right THERE — 18
 *  spread sites, no single load helper — and wrong here, for two reasons. The fabricated document
 *  does not only reach the registry: `loadAnimationClip` / `loadTimelineDoc` / `loadSkinDef` push it
 *  into the editor store and the live preview *before* any park, so a park-time refusal would let a
 *  human keep editing a fabricated clip and only complain N edits later at Cmd+S. And each of these
 *  panels has exactly ONE load effect, so the failure has a single place to be named.
 *
 *  ## Precedent
 *
 *  This generalises `particleLoadPersist.classifyParticleFetchFailure`, which fixed exactly this on
 *  `.particle.json` alone (#778's mechanism on that document) and was never widened;
 *  `assetViews/atlasPersist.ts` reached the same shape independently for `AtlasAssetView`. Both are
 *  plain `.ts` so the decision is unit-testable without mounting the component (CLAUDE.md §
 *  Panels) — this module keeps that property for all five remaining sites. */

import { assetIsAbsent } from '../../runtime/loaders/assetFetch';

/** What to do when an asset document's fetch/parse threw.
 *
 *  `'missing'` — a genuinely absent file (a brand-new asset, or a stale ref). Defaults ARE the
 *  correct content; load them, mark the saved baseline, carry on.
 *
 *  `'refused'` — anything else: corrupt / truncated / conflict-markered JSON, a dev-server 500, a
 *  network rejection. The caller must NOT substitute a document, NOT mark a saved baseline, and NOT
 *  hand anything to the editor store. It disables editing by having nothing to edit. */
export type AssetDocFetchFailure =
  | { kind: 'missing' }
  | { kind: 'refused'; message: string };

/** Classify the error an asset-document fetch/parse rejected with.
 *
 *  ⚠️ **An ABORT is the caller's to filter out BEFORE calling this** — it is not a failed read, and
 *  this reports it as `'refused'` (it is "not a `MissingAssetError`", which is all this can see).
 *  Every current caller filters it already, with a `cancelled` flag checked at the top of its
 *  `.catch`; a caller that uses an `AbortController` instead must check `signal.aborted` (or
 *  `e.name === 'AbortError'`) first, or merely CHANGING the selected asset would render a refusal
 *  banner for the load it just superseded. Deliberately not a third verdict kind: no caller can
 *  reach it today, and an unreachable branch reads as a guard while guarding nothing.
 *
 *  ⚠️ **`assetIsAbsent`, NOT `isMissingAsset` — and that distinction is load-bearing, not tidiness.**
 *  `MissingAssetError` is thrown for EVERY non-ok status, so `isMissingAsset` is true for a 500 on a
 *  file that exists. Asking it here reopened the exact defect this module closes: a transient 5xx
 *  during a scene load (`plugins/backend/writeResult.ts` answers 500 when `createReadStream` errors
 *  on a file `existsSync` just confirmed — EMFILE under a fan-out, EACCES, EBUSY on Windows) took
 *  the `'missing'` branch, and `AnimationEditor` opened a `defaultAnimationClip(newGuid())` marked
 *  as equal-to-disk. `assetIsAbsent` is true only for a 404/410 or the SPA fallback — the cases
 *  where the file really is not there and defaults really are the correct content.
 *
 *  ⚠️ **A caller that does not go through `parseAssetJson` can never get `'missing'`** — a raw
 *  `r.json()` on Vite's SPA-fallback body rejects with a plain `SyntaxError` and lands in
 *  `'refused'`, which would refuse every brand-new asset. `MaterialBatchView` was exactly that
 *  caller and had to adopt `parseAssetJson` to become classifiable at all. */
export function classifyAssetDocFetchFailure(e: unknown): AssetDocFetchFailure {
  if (assetIsAbsent(e)) return { kind: 'missing' };
  return { kind: 'refused', message: e instanceof Error ? e.message : String(e) };
}
