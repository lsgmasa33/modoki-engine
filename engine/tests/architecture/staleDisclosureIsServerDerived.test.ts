/** A dialog that shows an unsaved-work caveat must RENDER the server's disclosure, not re-derive
 *  it client-side (#972 P4).
 *
 *  ## Why this is a rule and not a preference
 *
 *  Routes that compute an answer from files on DISK carry a mandatory disclosure when the editor
 *  holds unsaved work (#889): `staleInputDisclosure` in `editorBackendRouter.ts` builds
 *  `staleInputs` + `staleInputsNote` from the `resolve-unsaved` probe — the one place with a
 *  type-level exhaustiveness check over `keyof UnsavedCauses`, so it names EVERY kind of unsaved
 *  work and cannot be short by one.
 *
 *  `FindReferencesDialog` ignored that field and grew its own banner from `unsavedChangeCauses()`,
 *  gated on `sceneDirty || dirtyAssetPaths.length > 0`. Two causes of five. A user holding only a
 *  parked import-settings edit, a pending baseScene ref, or a dirty non-primary scene got **no
 *  banner at all** — in the one feature whose entire purpose is not lying about what references
 *  what, and whose wrong answer ("unreferenced") is the input to a DELETE.
 *
 *  A client-side hand-list is also the weaker answer even when complete: it is a second
 *  computation of a fact the response already carries, so the two can disagree about the same
 *  scan. The server's note is derived from the probe that computed the very result being shown.
 *
 *  ## What this guard can and cannot see
 *
 *  A source scan, because these are `.tsx` and do not get mounted (docs/editor.md § Panels). It
 *  proves the file does not NAME the client-side enumerator and does render the server's field. It
 *  cannot prove the banner is legible, or that the note says something true — `unsavedGateCoverage`
 *  covers the route side, and the live editor covers the pixels.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';

const PANELS = path.resolve(__dirname, '../../packages/modoki/src/editor/panels');

/** Dialogs that display a result computed from disk by a route carrying the #889 disclosure. */
const DISCLOSING_DIALOGS = ['FindReferencesDialog.tsx', 'CleanupAssetsDialog.tsx'] as const;

describe('stale-input disclosure is rendered from the RESPONSE, never re-derived client-side', () => {
  for (const file of DISCLOSING_DIALOGS) {
    it(`${file} renders staleInputsNote and does not enumerate causes itself`, () => {
      const code = readScannedSource(path.join(PANELS, file)).code;
      // Non-vacuity: a scan of a file that moved or emptied must not pass silently.
      expect(code.length, `${file} is empty or unreadable — this guard has no subject`).toBeGreaterThan(500);
      expect(code, `${file} does not render the server's disclosure`).toContain('staleInputsNote');

      // ⚠️ `unsavedChangeCauses` is the CLIENT-side enumerator. Calling it here means building a
      // second, hand-maintained idea of what unsaved work exists — which is exactly the defect:
      // it was two of five for as long as nobody counted.
      expect(code, `${file} calls unsavedChangeCauses() — build the caveat from the response's `
        + 'staleInputsNote instead, which is derived from the probe that computed the result')
        .not.toContain('unsavedChangeCauses');
    });
  }

  it('the boolean drift check is allowed — it asks a different question', () => {
    // `hasUnsavedChanges()` is fine and deliberate: "has anything appeared SINCE this scan" is not
    // answerable from a response computed before it. What must not come back is the per-cause
    // enumeration, so this test states the line rather than leaving the ban looking broader than
    // it is — a guard nobody understands gets worked around.
    const code = readScannedSource(path.join(PANELS, 'FindReferencesDialog.tsx')).code;
    expect(code).toContain('hasUnsavedChanges');
    expect(code).toContain('find-references-drift');
  });
});
