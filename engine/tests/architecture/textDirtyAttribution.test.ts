/** Guard: `getTextDirtyVersion` stays called WITH a font GUID at both layout-hash call sites
 *  (#696).
 *
 *  `getTextDirtyVersion(fontId)` exists so a dynamic font's glyph generation only invalidates
 *  laid-out text that uses THAT font — omit the argument and it degrades to the un-attributed
 *  global counter, and a single new glyph anywhere rebuilds every Text2D/Text3D mesh in the
 *  scene (the exact per-frame full-rebuild cost #696 was written to remove). `textDirty.test.ts`
 *  pins the counter's OWN behaviour (attributed vs global), but nothing there notices if a call
 *  site stops passing `t.font` — reverting either site to the no-arg form leaves that test green
 *  while the attribution silently stops mattering. Deliberately a source grep, in the style of
 *  `videoTextureTeardownReachable.test.ts` (a wiring/reachability question a unit test on the
 *  callee cannot see) and `reapScoping.test.ts` (comment-safe scanning via the shared scanner). */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const renderingDir = path.resolve(repoRoot, 'packages/modoki/src/runtime/rendering');

const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** `rel` here is `repoFiles()`'s own output — git-relative, POSIX, unquoted — never
 *  round-tripped through `path.relative`/`sep` (that round-trip, via a local `toPosix()` call,
 *  was instance 3 of the class docs/windows.md § Paths records, #798). `endsWith` still finds
 *  the definition site regardless of the repo-root-relative prefix `repoFiles()` returns.
 *
 *  ⚠️ These two are shared by the scan AND by the non-vacuity pin at the bottom of the file ON
 *  PURPOSE. A pin that re-derives the path itself would keep passing when the scan's own
 *  enumeration is reverted, which makes it a test of `repoFiles()` rather than of this guard. */
const isDefinitionSite = (rel: string) => rel.endsWith('text/textDirty.ts');

/** The one place the definition-site exemption is applied. The caller sweep consumes `callers`
 *  and the non-vacuity pin consumes both halves, so the sweep cannot go back to computing its
 *  own path without visibly deleting this call — which is the only way the pin can be left
 *  asserting something the sweep no longer does. Sharing `renderingFiles()` alone was NOT
 *  enough once: reverting just the loop to an inline `path.relative(...).endsWith('text/…')`
 *  reintroduced #798 with all four tests still green. Via the shared corpus producer
 *  (#799/#771/#805 Phase 4); floored well under the 111 measured today. */
function renderingFiles(): { all: { file: string; rel: string }[]; callers: { file: string; rel: string }[] } {
  const all = repoFiles({ under: renderingDir, match: /\.tsx?$/, floor: 60 })
    .map(({ abs, rel }) => ({ file: abs, rel }));
  return { all, callers: all.filter((t) => !isDefinitionSite(t.rel)) };
}

// The two layout-hash sites that must attribute their dirty check to the entity's OWN font.
const attributedSites: [label: string, rel: string][] = [
  ['Scene2D.tsx (2D text layout hash)', 'packages/modoki/src/runtime/rendering/Scene2D.tsx'],
  ['scene3DSync.ts (3D text layout hash)', 'packages/modoki/src/runtime/rendering/scene3DSync.ts'],
];

describe('getTextDirtyVersion stays attributed by font at both layout-hash sites (#696)', () => {
  it.each(attributedSites)('%s calls getTextDirtyVersion(t.font), not the no-arg form', (_label, rel) => {
    const raw = read(rel);
    const src = stripComments(raw);
    assertScanIsSane(raw, src, rel);

    expect(src, `${rel}: expected a getTextDirtyVersion(t.font) call in the layout hash`)
      .toMatch(/getTextDirtyVersion\(\s*t\.font\s*\)/);
    // A no-arg call anywhere in the file (there should be exactly zero — the file has no other
    // legitimate caller) would silently fall back to the un-attributed global counter.
    expect(src, `${rel}: found a no-argument getTextDirtyVersion() call — this reverts #696's ` +
      'per-font attribution and makes one new glyph anywhere rebuild every Text2D/Text3D mesh')
      .not.toMatch(/getTextDirtyVersion\(\s*\)/);
  });

  it('no other file under runtime/rendering calls getTextDirtyVersion() with no argument', () => {
    for (const { file, rel } of renderingFiles().callers) {
      const raw = fs.readFileSync(file, 'utf8');
      const src = stripComments(raw);
      assertScanIsSane(raw, src, rel);
      expect(src, `${rel}: found a no-argument getTextDirtyVersion() call — pass the font GUID ` +
        '(#696) so an unrelated font\'s glyph generation does not force a rebuild here')
        .not.toMatch(/getTextDirtyVersion\(\s*\)/);
    }
  });

  // Non-vacuity pin (#798, docs/windows.md § Paths "the loud failure is the lucky one"): the
  // exemption above is keyed on a forward-slash literal compared against `rel`. Before the
  // #798 fix (a hand-rolled `path.relative()` + `toPosix()`) that comparison was silently false
  // on Windows, so the definition site fell through into the assertion meant for CALLERS only —
  // a broken guard that says nothing, rather than failing loudly. Migrating onto `repoFiles()`
  // (#799/#771/#805 Phase 4) removes the hazard at the source — `rel` is git's own POSIX output,
  // never round-tripped through `path.relative`/`sep` — but the pin stays: it is what would catch
  // a FUTURE regression back to a hand-rolled, separator-sensitive comparison.
  //
  // It pins the sweep, not itself: both halves come from `renderingFiles()`, the single place the
  // exemption is applied, so the sweep cannot compute its own path without deleting that call.
  // The definition site is located by BASENAME — deliberately not by `isDefinitionSite`, which
  // would make the assertion a tautology restating the predicate that selected it.
  // On POSIX it passes either way — expected, and not a reason to weaken it.
  it('the exemption for the definition site is load-bearing (reachable AND applied)', () => {
    const { all, callers } = renderingFiles();
    const defSite = all.find((t) => path.basename(t.file) === 'textDirty.ts');
    expect(defSite, 'the sweep over runtime/rendering must reach text/textDirty.ts at all')
      .toBeDefined();
    // The one that fires on a broken separator, and its message prints the offending path.
    expect(callers.some((t) => t.file === defSite!.file),
      `the definition site must be EXCLUDED from the caller sweep, but its path did not match ` +
      `the exemption — got "${defSite!.rel}" (a backslash here means the git-relative POSIX rel ` +
      'was lost somewhere in renderingFiles(); see docs/windows.md § Paths)')
      .toBe(false);
  });
});
