/** ⚠️ **An asset editor that PARKS its document must classify a failed read before substituting
 *  anything for it (#886/#896) — and the population is DERIVED from the parking marker, not
 *  hand-listed.**
 *
 *  All five of these editors used to build a document out of thin air on ANY load failure and seed
 *  it as the SAVED baseline: `defaultAnimationClip(newGuid(), name)`, `defaultTimeline(newGuid(),
 *  name)`, `{ clips: {} }`, an empty rig, `defaultParticleEffect()`. The first edit then parked a
 *  full-replace write of that fabrication over the authored file — panel-origin flushes send
 *  `replace: true`, which is exactly the flag that skips `/api/asset-write`'s dropped-field guard.
 *
 *  Two consequences, and the worse one is silent: a fabrication carrying a FRESH guid
 *  (Animation/Timeline) defeats the route's id-preservation branch (`!out.id && prevDoc?.id`), so
 *  the file is replaced by a document wearing a DIFFERENT id — which the scanner's heal pass cannot
 *  flag, because the document looks complete, and every scene reference to the old guid dangles.
 *  The id-less fabrications keep the guid and erase every other field instead.
 *
 *  ⚠️ **The distinction is the whole point, so the guard is "classified", not "never substitutes".**
 *  A genuinely MISSING file is not a failed read: defaults ARE the correct content for a brand-new
 *  asset or a stale ref, and refusing there would make the asset unauthorable. `parseAssetJson`
 *  separates the two (Vite answers an unknown path with `200 index.html`, so both arrive at the
 *  same `.catch`), and `assetDocLoad.classifyAssetDocFetchFailure` is what reads that apart.
 *
 *  ⚠️ **Why a source scan and not a render test.** `docs/editor.md` § Panels: editor `.tsx` is not
 *  mounted in jsdom, because that asserts the mock rather than the panel. The limit, stated rather
 *  than implied: **this proves the classifier is CALLED, not that both of its branches are handled
 *  correctly.** A panel that classified and then substituted defaults on `'refused'` anyway would
 *  pass here. The verdict's own behaviour — and, crucially, that the MISSING side still loads
 *  defaults — is covered in `packages/modoki/tests/editor/assetDocLoad.test.ts`; the batch view's
 *  exclusion/write halves in `tests/editor/materialBatchLoad.test.ts`.
 *
 *  ⚠️ **A second assertion was written and REMOVED, and it is worth knowing why.** "No parking
 *  editor may fabricate a document with a freshly-minted guid" is the sharpest half of this defect
 *  — a minted id defeats the route's preservation branch and the heal pass cannot flag the result.
 *  It is also unscannable: `default*(newGuid())` is exactly what the MISSING branch legitimately
 *  does (a brand-new clip needs an id), and a regex cannot tell that branch from the any-failure
 *  one. The guard went red on `AnimationEditor`/`TimelineEditor` for their CORRECT lines, which
 *  means the cheapest way to satisfy it would have been deleting them and making a new clip
 *  unauthorable — a guard that pushes the fix the wrong way. That property is tested where it can
 *  be tested honestly (the verdict's two branches, in `assetDocLoad.test.ts`) rather than
 *  approximated here.
 *
 *  The list is derived from `useParkedAssetDoc(` — the hook that makes a panel a parking asset
 *  editor in the first place — so a SIXTH editor is covered the day it is written rather than the
 *  day someone remembers this file. Same derivation lesson as `assetViewReadsParkedDoc.test.ts`. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const PANELS = 'engine/packages/modoki/src/editor/panels';

/** Every panel that parks an asset DOCUMENT — i.e. calls `useParkedAssetDoc`. */
function parkingEditors(): Array<{ rel: string; code: string }> {
  const out: Array<{ rel: string; code: string }> = [];
  for (const { abs, rel } of repoFiles({ under: PANELS, match: /\.tsx$/, floor: 3 })) {
    if (rel.includes('.test.')) continue;
    const code = readScannedSource(abs).code;
    if (/\buseParkedAssetDoc\s*\(/.test(code)) out.push({ rel, code });
  }
  return out;
}

/** The classifiers that read a failed asset-document read apart from an absent file.
 *  `classifyParticleFetchFailure` is an ALIAS of the shared one (`particleLoadPersist.ts` re-exports
 *  it), not a second implementation — asserted in `assetDocLoad.test.ts`, so accepting both names
 *  here is not accepting two behaviours. */
const CLASSIFIER = /\b(classifyAssetDocFetchFailure|classifyParticleFetchFailure)\s*\(/;

describe('every parking asset editor classifies a failed read (#886/#896)', () => {
  it('finds the parking editors by their marker, not by a list', () => {
    // Non-vacuity with a NAMED expectation: an empty scan would make the real assertion below pass
    // having examined nothing. FIVE measured 2026-09-07. `MaterialBatchView` and the other
    // `assetViews/**` panels are deliberately absent — they hold their document in local state and
    // park through `persistAssetEdit` rather than this hook, and the batch view's own half of this
    // fix is unit-tested directly (`materialBatchLoad.test.ts`) rather than scanned.
    expect(parkingEditors().map((e) => path.basename(e.rel)).sort()).toEqual([
      'AnimationEditor.tsx', 'ParticleEditor.tsx', 'SkinEditor.tsx',
      'SpriteAnimEditor.tsx', 'TimelineEditor.tsx',
    ]);
  });

  it('each one routes its load failure through the shared classifier', () => {
    const missing = parkingEditors().filter((e) => !CLASSIFIER.test(e.code)).map((e) => e.rel);

    expect(missing, [
      'These panels PARK an asset document but never classify a failed read, so their load',
      'effect will substitute a fabricated document for a file it could not read, seed it as the',
      'SAVED baseline, and let the first edit park a `replace: true` write of that fabrication',
      'over the authored file. If the fabrication carries a freshly-minted guid, the file also',
      'loses its identity in a way the scanner cannot heal.',
      '',
      'Fix: in the load `.catch`, `const failure = classifyAssetDocFetchFailure(e);` — substitute',
      "defaults ONLY for `failure.kind === 'missing'` (a brand-new asset or a stale ref), and",
      'otherwise hold NO document, so the editing surface stays unmounted and nothing can park.',
      'See `editor/panels/assetDocLoad.ts` for why this is a verdict rather than a boolean.',
      '',
      ...missing,
    ].join('\n')).toEqual([]);
  });
});
