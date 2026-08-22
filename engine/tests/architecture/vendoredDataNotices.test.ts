/** Vendored third-party DATA must carry a hand-written notice — nothing else will produce one.
 *
 *  ⚠️ **THE AUTOMATED LICENSE LISTING STRUCTURALLY CANNOT COVER THIS.** `oss/THIRD-PARTY-NOTICES.md`
 *  says the authoritative list is generated from the installed `node_modules` at publish time. That
 *  is true for dependencies and useless for data we COPIED OUT of a package we do not depend on:
 *  the GPU table's source is not in `package.json`, so no license scanner will ever mention it, and
 *  the omission would look exactly like a package that simply has no notice requirement. CC BY 4.0
 *  in particular requires three things — credit, a link to the licence, and a statement that
 *  changes were made — and all three are prose that only a human puts there.
 *
 *  So the notice is hand-written, and this is what keeps it honest. The failure it prevents is the
 *  repo's most common shape — a mechanism that is real but unreachable — applied to a legal
 *  obligation rather than to code: an Apache-2.0 public snapshot shipping third-party material with
 *  its required attribution silently absent.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');

/** The notices file lives at `oss/THIRD-PARTY-NOTICES.md` HERE and at the repo ROOT in the public
 *  snapshot — `publish-engine-oss.sh` overlays the `oss/` directory onto the root, so the private
 *  path does not exist there. Resolve both rather than skipping in the snapshot: the snapshot is
 *  the Apache-2.0 artifact the attribution obligation actually attaches to, so switching the guard
 *  off exactly there would drop it where it matters most. */
const NOTICES = [join(REPO, 'oss/THIRD-PARTY-NOTICES.md'), join(REPO, 'THIRD-PARTY-NOTICES.md')]
  .find(existsSync) ?? join(REPO, 'oss/THIRD-PARTY-NOTICES.md');

/** The attribution EXACTLY as it was put to Kishonti Ltd and approved by them (email, 2026-08-12:
 *  *"You are free to use the data and thanks for the reference"*).
 *
 *  ⚠️ **This is approved wording, not our prose.** Rewording it — even to fix a line break, tighten
 *  it, or drop the CompuBench half we do not use — would ship an attribution the rights holder never
 *  saw. It is asserted against BOTH copies: the notices file and the header of the generated table,
 *  so the credit travels with the data rather than living only in a file nobody opens. */
const APPROVED_ATTRIBUTION =
  'GPU performance data derived from GFXBench and CompuBench toplist results, '
  + '(c) 2005-2025 Kishonti Ltd, licensed under CC BY 4.0 '
  + '(https://creativecommons.org/licenses/by/4.0/). Values were aggregated and '
  + 'modified from the published results.';

/** Strip comment furniture and collapse whitespace, so the same sentence matches whether it is
 *  wrapped in a Markdown block or a JSDoc header. Compares the WORDS, not the layout. */
const flatten = (text: string): string =>
  text.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ').trim();

/** Every file in the tree that is COPIED third-party data rather than our own work, with the
 *  fact about its source that its notice must state. Add a row when you vendor something. */
const VENDORED = [
  {
    file: 'engine/packages/modoki/src/runtime/rendering/gpuBenchmarks.ts',
    /** Must appear verbatim in the notice — these ARE the licence's conditions, not a summary. */
    mustMention: [
      'Kishonti',                                      // who measured it
      '© 2005–2025 Kishonti Ltd',                      // the copyright line CC BY requires
      'https://creativecommons.org/licenses/by/4.0/',  // CC BY requires a LINK to the licence
      'Changes were made',                             // ...and a statement that we changed it
    ],
  },
] as const;

describe('vendored data carries a third-party notice', () => {
  it('the notices file exists and is non-trivial', () => {
    // Non-vacuity: every assertion below would pass trivially against a missing or empty file.
    expect(existsSync(NOTICES), NOTICES).toBe(true);
    expect(readFileSync(NOTICES, 'utf8').length).toBeGreaterThan(500);
  });

  it('the guard is watching at least one real file', () => {
    // If a refactor moved or renamed a vendored file, this list would silently describe nothing
    // and every check below would be vacuous.
    expect(VENDORED.length).toBeGreaterThan(0);
    for (const v of VENDORED) {
      expect(existsSync(join(REPO, v.file)), `${v.file} — vendored file listed but not on disk`)
        .toBe(true);
    }
  });

  it('the APPROVED attribution appears verbatim in the notices AND in the generated table', () => {
    // Two copies on purpose: the notice is the legal record, the header is what a reader of the
    // data actually sees. A guard on only one of them lets the other rot.
    const wanted = flatten(APPROVED_ATTRIBUTION);
    for (const where of [NOTICES, join(REPO, VENDORED[0].file)]) {
      expect(flatten(readFileSync(where, 'utf8')), `approved attribution missing from ${where}`)
        .toContain(wanted);
    }
  });

  it.each(VENDORED.map((v) => [v.file, v] as const))(
    '%s is named in the notices, with its licence text',
    (file, v) => {
      const notices = readFileSync(NOTICES, 'utf8');
      // By PATH, so a reader of the notice can find the file, and so moving the file without
      // updating the notice fails here rather than at publish time.
      expect(notices, `${file} is not named in oss/THIRD-PARTY-NOTICES.md`).toContain(file);
      for (const phrase of v.mustMention) {
        expect(notices, `notice for ${file} is missing: ${phrase}`).toContain(phrase);
      }
    },
  );
});
