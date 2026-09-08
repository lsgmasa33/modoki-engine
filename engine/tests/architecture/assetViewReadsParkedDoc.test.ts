/** ⚠️ **An asset view that parks its edits must ask the registry before it fetches the file
 *  (#831) — and the population is DERIVED from the parking marker, not hand-listed.**
 *
 *  Since #831 an Inspector asset edit is PARKED, not written, so between the edit and Cmd+S the
 *  file on disk still holds the pre-edit document. A view whose load effect fetches that file
 *  unconditionally re-seeds the panel — and, through `useAssetViewRefresher`, the live cache —
 *  with the OLD doc while the registry still holds the newer one. The panel then shows a document
 *  that disagrees with what Cmd+S would write, which `pendingAssetDoc`'s own docblock calls the
 *  worst of the three available states.
 *
 *  This is not hypothetical and it is not new: it has been filed three times against the panels
 *  that parked BEFORE these views did — `QA-CTX-0008` (a timeline edit erased by opening the
 *  editor on it), `EhE6JQkHRYttDGeGmtPK`, and `1MCF9DFktot8hXsgBuWp`. `pendingAssetDoc` exists
 *  precisely to be asked first. Adding four more parking surfaces without it would have
 *  reintroduced the same bug on four more panels.
 *
 *  ⚠️ **Why a source scan and not a render test.** `docs/editor.md` § Panels: editor `.tsx` does
 *  not get mounted in jsdom, because that asserts the mock rather than the panel. The DECISION
 *  being guarded is one line in a load effect, so a scan is what can see it. The limit, stated
 *  rather than implied: this proves the call is PRESENT, not that it is correctly ordered before
 *  the fetch. `pendingAssetDoc`'s own behaviour is covered in `tests/editor/pendingAssetDoc.test.ts`.
 *
 *  The view list is derived from the `persistAssetEdit(` marker — the thing that makes a view a
 *  parking surface in the first place — so a FIFTH view is covered the day it is written, rather
 *  than the day someone remembers to add it here. That is #830's whole lesson, applied forward. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const VIEWS = 'engine/packages/modoki/src/editor/panels/assetViews';

/** Every asset view that parks an edit — i.e. calls `persistAssetEdit`. */
function parkingViews(): Array<{ rel: string; code: string }> {
  const out: Array<{ rel: string; code: string }> = [];
  for (const { abs, rel } of repoFiles({ under: VIEWS, match: /\.tsx?$/, floor: 3 })) {
    if (rel.includes('.test.')) continue;
    const code = readScannedSource(abs).code;
    // The DEFINITION lives in persist.ts and is not itself a view.
    if (rel.endsWith('/persist.ts')) continue;
    if (/\bpersistAssetEdit\s*\(/.test(code)) out.push({ rel, code });
  }
  return out;
}

describe('every parking asset view reads the parked doc before the file (#831)', () => {
  it('finds the parking views by their marker, not by a list', () => {
    const views = parkingViews().map((v) => path.basename(v.rel)).sort();
    // Non-vacuity with a NAMED expectation: an empty scan would make the real assertion below pass
    // having examined nothing. FIVE measured 2026-09-07. Atlas joined the day it stopped writing
    // through its own compare-and-swap queue — and it joined this list by itself, because the
    // population is derived from the marker rather than written down here, which is the whole
    // point. `SceneAssetView` is still absent: it mutates one FIELD through /api/scene-mutate
    // rather than writing a document, so `persistAssetEdit` is not its route.
    expect(views).toEqual([
      'AnimSetAssetView.tsx', 'AtlasAssetView.tsx', 'MaterialAssetView.tsx',
      'MaterialBatchView.tsx', 'ShaderAssetView.tsx',
    ]);
  });

  it('each one consults pendingAssetDoc', () => {
    const missing = parkingViews()
      .filter((v) => !/\bpendingAssetDoc\s*\(/.test(v.code))
      .map((v) => v.rel);

    expect(missing, [
      'These asset views PARK their edits but never ask `pendingAssetDoc` for a pending one, so',
      'their load effect will fetch the file and show the PRE-edit document while the registry',
      'still holds the newer one — and Cmd+S will then write a value the human can no longer see.',
      'Filed three times already against the panels that parked first (QA-CTX-0008 and two more).',
      '',
      'Fix: in the load effect, `const parked = pendingAssetDoc(path, <type>); if (parked) { ... }`',
      'BEFORE the fetch. Do not weaken this guard — the fetch fallback is still correct when',
      'nothing is pending.',
      '',
      ...missing,
    ].join('\n')).toEqual([]);
  });
});

/** Every asset view whose props destructure a PLURAL `paths` (a multi-path/batch view) AND that
 *  parks edits through `persistAssetEdit` in the first place. That second filter matters:
 *  `TextureBatchView` also takes a `paths` prop but writes its `.meta.json` directly
 *  (`writeMetaOrWarn`), never going through `persistAssetEdit`/either refresher hook at all — a
 *  different persistence mechanism entirely, outside what this guard (and #843) is about. */
function multiPathViews(): Array<{ rel: string; code: string }> {
  const parking = new Set(parkingViews().map((v) => v.rel));
  const out: Array<{ rel: string; code: string }> = [];
  for (const { abs, rel } of repoFiles({ under: VIEWS, match: /\.tsx?$/, floor: 3 })) {
    if (rel.includes('.test.')) continue;
    if (rel.endsWith('/persist.ts')) continue;
    if (!parking.has(rel)) continue;
    const code = readScannedSource(abs).code;
    if (/\{\s*paths\s*\}\s*:/.test(code) || /paths:\s*string\[\]/.test(code)) out.push({ rel, code });
  }
  return out;
}

/** ⚠️ **A multi-path asset view must register a live refresher for EVERY path it shows, not one
 *  of them (#843).** `MaterialBatchView` used to register `useAssetViewRefresher(paths[0] ?? '',
 *  () => loadAll())` — a single subscription that re-loaded the WHOLE panel. That raced
 *  `persistAssetEdit`'s parking loop over the batch: the loop's synchronous setter call for the
 *  registered path fired `loadAll` mid-loop, which re-fetched every OTHER path in the batch before
 *  its own `persistAssetEdit` call had parked it — so those still-unparked paths read
 *  `pendingAssetDoc` as null, fell through to `fetch`, and re-seeded the panel (and the live cache)
 *  from the PRE-edit disk document, silently dropping the edit the human had just made and seen
 *  applied. The fix is `useAssetViewRefreshers(paths, ...)` — one registration per path, each a
 *  pure per-path merge, so a parked-but-not-yet-refreshed sibling is never re-read.
 *
 *  ⚠️ **What this proves and what it doesn't.** This is a source scan (panels are never mounted in
 *  jsdom — `docs/editor.md` § Panels), so it can only see WHICH hook a view calls, not that the
 *  call is wired correctly at runtime. `engine/tests/editor/materialBatchParkedEdits.test.ts` pins
 *  the HOOK's own per-path merge behaviour directly. Neither test alone covers #843: this one pins
 *  which hook the PANEL calls; that one pins what the hook DOES once called — reverting the panel's
 *  wiring to the single-path hook leaves the hook test green, and a hook regression leaves this
 *  scan green, so both are needed. */
describe('every multi-path asset view refreshes every path it shows (#843)', () => {
  it('finds the multi-path views by their `paths` prop, not by a list', () => {
    const views = multiPathViews().map((v) => path.basename(v.rel)).sort();
    // Non-vacuity with a NAMED expectation, same reasoning as the parking-views check above: an
    // empty scan would make the real assertions below pass having examined nothing.
    expect(views).toEqual(['MaterialBatchView.tsx']);
  });

  it('each one calls the plural refresher, not the singular one', () => {
    const missingPlural = multiPathViews()
      .filter((v) => !/\buseAssetViewRefreshers\s*\(/.test(v.code))
      .map((v) => v.rel);
    const usesSingular = multiPathViews()
      .filter((v) => /\buseAssetViewRefresher\s*\(/.test(v.code))
      .map((v) => v.rel);

    expect(missingPlural, [
      'These multi-path asset views never call `useAssetViewRefreshers` (the per-path plural hook),',
      'so nothing keeps every path in the batch in sync with a live edit.',
      '',
      ...missingPlural,
    ].join('\n')).toEqual([]);

    expect(usesSingular, [
      'A multi-path asset view calls `useAssetViewRefresher` (the SINGULAR hook) — registering a',
      'refresher for only ONE of its N paths. Concretely this was `useAssetViewRefresher(paths[0]',
      "?? '', () => loadAll())`: registering for one path means persistAssetEdit's synchronous",
      "setter call fires while its own parking loop over the OTHER paths is still running, so those",
      'not-yet-parked paths read `pendingAssetDoc` as null, fall through to `fetch`, and re-seed the',
      'panel from the PRE-edit disk document — silently dropping the edit the human just made and',
      'saw applied (#843). Use `useAssetViewRefreshers(paths, (p, updated) => ...)` instead — one',
      'registration per path, each a pure per-path merge.',
      '',
      ...usesSingular,
    ].join('\n')).toEqual([]);
  });
});
