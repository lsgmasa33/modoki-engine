/** ⚠️ **A view that parks a `.meta.json` edit for a SELECTION must exclude the members the
 *  registry would refuse — and the population is DERIVED from the batch-park marker, not
 *  hand-listed** (#903).
 *
 *  `parkMetaEdit` refuses a document built on a failed read or stamped for another path, because
 *  `/api/write-meta` replaces the sidecar wholesale and such a document has no `id` (or the wrong
 *  one) — the scanner's heal pass then mints a fresh GUID and dangles every reference to the asset.
 *  The refusal is correct. What was wrong is that a batch loop could not see it: `parkMetaEdit`
 *  returned `void`, and both views set their local map for every selected path regardless. So the
 *  control showed an edit for an unknown subset of the selection that Cmd+S would never write.
 *
 *  The repair is a data shape — a member that cannot be parked is ABSENT from the view's map — so
 *  what this guard checks is that a batch view **routes its selection through the shared decision**
 *  rather than iterating `paths` and parking each one itself.
 *
 *  ⚠️ **Why a source scan and not a render test.** `docs/editor.md` § Panels: editor `.tsx` is not
 *  mounted in jsdom, because that asserts the mock rather than the panel. The limit, stated rather
 *  than implied: **this proves the view delegates, not that the delegation is correct.** The
 *  decision's own behaviour — exclusion, the accept side, and the write plan honouring absence —
 *  is covered in `packages/modoki/tests/editor/metaBatchLoad.test.ts`.
 *
 *  ⚠️ **One limit found by mutation-checking this file, stated rather than left for the next
 *  reader to discover.** Neutering the banner in place — `const banner = unreadable.length > 0 ?`
 *  → `const banner = false ?` — keeps every assertion here GREEN, because the JSX is still in the
 *  source text. A scan sees tokens, not reachability. DELETING the banner does go red, which is
 *  the careless-fix shape this guards against; a deliberate dead ternary is not, and nothing here
 *  can catch it.
 *
 *  ⚠️ **The derivation is the point, and it is what the sibling guards learned the hard way.**
 *  #896's history is three rounds of fixing four of five sites and leaving the fifth; #886's fix
 *  was applied to `MaterialBatchView` alone and this class survived on the meta side for it. A
 *  hand-listed pair here would be the same mistake a third time. Derived from the marker, a THIRD
 *  batch view is covered the day it is written. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const VIEWS = 'engine/packages/modoki/src/editor/panels/assetViews';

/** A view is a META BATCH view when it parks import settings across a `paths`/`assets` selection.
 *  The marker is the shared planner: a view that does its own `for (const p of paths)` park loop
 *  is precisely the shape this guard exists to reject, so it must NOT be part of the derivation —
 *  a corpus defined by "does the right thing" is a corpus that cannot fail. Deriving from the
 *  batch-ness instead: a `paths`/`assets` array prop plus a park of import settings. */
function metaBatchViews(): Array<{ rel: string; code: string }> {
  const out: Array<{ rel: string; code: string }> = [];
  for (const { abs, rel } of repoFiles({ under: VIEWS, match: /\.tsx$/, floor: 3 })) {
    if (rel.includes('.test.')) continue;
    const code = readScannedSource(abs).code;
    // Takes a SELECTION (a `paths: string[]` or `assets: SelectedAsset[]` prop) …
    if (!/\{\s*(paths|assets)\s*\}\s*:\s*\{\s*(paths|assets)\s*:/.test(code)) continue;
    // … and deals in `.meta.json` import settings.
    if (!/\b(parkMetaEdit|parkPlannedMetaEdits|readMetaPreferringPark|loadMetaBatch)\b/.test(code)) continue;
    out.push({ rel, code });
  }
  return out;
}

describe('every meta BATCH view excludes members it cannot park (#903)', () => {
  it('finds the batch views by their marker, not by a list', () => {
    const views = metaBatchViews().map((v) => path.basename(v.rel)).sort();
    // Non-vacuity with a NAMED expectation: an empty scan would make the real assertion below pass
    // for the wrong reason. This list is allowed to GROW — a new batch view is expected to appear
    // here and then be held to the rule — but it must never be empty.
    expect(views).toEqual(['ModelBatchView.tsx', 'TextureBatchView.tsx']);
  });

  it('routes the selection through the shared load decision', () => {
    for (const { rel, code } of metaBatchViews()) {
      expect(/\bloadMetaBatch\s*\(/.test(code), `${rel} must load its selection through loadMetaBatch — a per-path read that substitutes a fallback document puts an unparkable member back in the map`).toBe(true);
    }
  });

  it('plans its writes through the shared planner instead of looping the selection itself', () => {
    for (const { rel, code } of metaBatchViews()) {
      expect(/\bplanMetaBatchWrite\s*\(/.test(code), `${rel} must plan batch edits through planMetaBatchWrite — that is what skips an excluded member`).toBe(true);
      // ⚠️ The defect's literal shape: a bare `parkMetaEdit` inside the view. Parking now goes
      // through `parkPlannedMetaEdits`, which only ever sees the planner's output.
      expect(/\bparkMetaEdit\s*\(/.test(code), `${rel} must not call parkMetaEdit directly — a batch parks its PLAN (parkPlannedMetaEdits), so a member the loader excluded cannot be reached`).toBe(false);
    }
  });

  it('tells the human which members were excluded, on screen and not only to the console', () => {
    for (const { rel, code } of metaBatchViews()) {
      // A refusal that reaches only `console.error` is indistinguishable from a broken control —
      // the owner's ruling on #890/#891, and the reason #903 is a defect rather than a log gap.
      // ⚠️ `<AssetLoadRefusedBanner`, not the bare name: a bare-name regex matches the file's own
      // IMPORT, so deleting the JSX and leaving the import unused would keep this green. Same trap
      // as a called-symbol guard that forgets the paren.
      expect(/<AssetLoadRefusedBanner\b/.test(code), `${rel} must RENDER the shared AssetLoadRefusedBanner naming the excluded members — importing it is not rendering it`).toBe(true);
      expect(/\bunreadable\.map\s*\(/.test(code), `${rel} must name each excluded member in the banner, not merely count them`).toBe(true);
      expect(/\bsetUnreadable\s*\(/.test(code), `${rel} must hold the loader's excluded list in state so the banner can name them`).toBe(true);
    }
  });
});
