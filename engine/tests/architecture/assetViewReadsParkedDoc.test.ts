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
    // having examined nothing. Four measured 2026-09-07 — Atlas and Scene are deliberately absent
    // (Atlas writes through its own compare-and-swap queue, Scene through /api/scene-mutate), which
    // is the correction this issue's own body needed.
    expect(views).toEqual([
      'AnimSetAssetView.tsx', 'MaterialAssetView.tsx', 'MaterialBatchView.tsx', 'ShaderAssetView.tsx',
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
