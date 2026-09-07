/** Every `.meta.json` GET goes through `readMetaPreferringPark`, or is a declared exemption
 *  (#845 close-out).
 *
 *  WHY. #845 phase 1 parked 18 Inspector field-change sites instead of writing them
 *  immediately — Cmd+S is now the write. But several OTHER call sites still read `.meta.json`
 *  straight off disk and either DECIDE something from it (what postprocessor to show, what to
 *  merge a new edit onto) or WRITE THE WHOLE DOCUMENT BACK (the 9-slice/sprite editors' Save, a
 *  model import's id/generated-file merge) — none of them consulted the pending-park registry, so
 *  a still-parked edit was invisible to them:
 *
 *   1. Human edits 9-slice insets in the Texture Inspector → `updateBorder` PARKS `meta.border`.
 *   2. Human opens the 9-Slice editor. Its load effect GETs `/api/read-meta`, which returns DISK —
 *      without the parked border.
 *   3. Human saves in that editor. It writes the FULL `nextMeta`, built on the stale base → the
 *      parked border is absent from what lands on disk.
 *   4. Cmd+S flushes the park, which overwrites the WHOLE document with the Inspector's older
 *      base → the 9-Slice editor's slices/border are destroyed.
 *
 *  `readMetaPreferringPark` (`scene/pendingMeta.ts`) is the fix — it is now the ONE place a
 *  `.meta.json` GET happens, everywhere but a documented exemption below.
 *
 *  ⚠️ **Deliberately scanning the WHOLE editor tree, not a hand-picked list of "known readers".**
 *  A scope restriction here is a claim that the defect cannot live outside it — this repo has
 *  paid for that assumption before (`docCitations`/`assetRefIntegrity`'s own histories). Widening
 *  the scan costs nothing and the exemption map is where a verified exception belongs, with a
 *  reason attached to it, not a narrower `under`.
 *
 *  Same idiom as `metaMergeNotClobber.test.ts` (the write-side sibling of this guard) and
 *  `liveReloadKinds.test.ts`'s `NOT_LIVE_RELOADABLE`: a source scan (editor `.tsx` carries no
 *  tests of its own — `docs/editor.md` § Panels), comment-stripped via the one shared scanner
 *  (`readScannedSource`) so a `/api/read-meta` MENTIONED in a comment cannot be mistaken for a
 *  real fetch call. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { readScannedSource } from '@modoki/engine/testing';

const SRC = path.resolve(__dirname, '../../packages/modoki/src/editor');
const read = (rel: string) => readScannedSource(path.join(SRC, rel)).code;

/** `repoFiles()`'s own `rel` is repo-root-relative; this file's tables are keyed SRC-relative
 *  (`panels/NineSliceEditor.tsx`) — same prefix-strip convention as `metaMergeNotClobber.test.ts`,
 *  and for the same reason: THROW rather than tolerate a miss, so a drift in the enumeration root
 *  cannot silently stop matching every entry below. */
const EDITOR_PREFIX = 'engine/packages/modoki/src/editor/';
function editorSourceFiles(): string[] {
  return repoFiles({ under: SRC, match: /\.tsx?$/, floor: 150 }).map(({ rel }) => {
    if (!rel.startsWith(EDITOR_PREFIX)) {
      throw new Error(
        `metaReadPreferringPark: ${rel} is not under "${EDITOR_PREFIX}", but \`under\` is SRC — `
        + 'the enumeration root and this prefix strip have drifted apart.',
      );
    }
    return rel.slice(EDITOR_PREFIX.length);
  });
}

/** The ONE file allowed to fetch `/api/read-meta` directly — it defines `readMetaPreferringPark`
 *  and forwards a raw GET only when nothing is parked (`pendingMeta.ts`'s own doc explains why). */
const HELPER_FILE = 'scene/pendingMeta.ts';

/** Files with a raw `/api/read-meta` fetch that deliberately do NOT go through the helper, each
 *  with a verified reason. Add a name here only with a verified reason, never to silence a
 *  failure — see `liveReloadKinds.test.ts`'s `NOT_LIVE_RELOADABLE` for the same discipline. */
const EXEMPT: Record<string, string> = {
  'panels/assetViews/VideoAssetView.tsx':
    'keeps a THIRD piece of state (`applied`) that must reflect DISK, never a still-parked edit — '
    + 'preferring the park there would compare a pending edit against itself and hide the '
    + '"re-import to apply" nudge for an edit that was never actually baked. Verified in the '
    + 'inline #845 comment on `applyMeta`: `applied` is set from the raw disk read while `meta` — '
    + 'what the panel actually shows — separately prefers `peekPendingMeta`, so this file already '
    + 'does the RIGHT thing for both, it just cannot do it through a helper that skips the network '
    + 'call whenever a park exists.',
  'panels/makeTexture2D.ts':
    'flushes this exact path (`flushPendingMetaFor`) immediately before this read, every time, in '
    + 'the same synchronous function body — so by the time it reads, nothing can be parked for it '
    + 'and there is no park left to prefer. It also cannot tolerate `readMetaPreferringPark`\'s '
    + '"non-ok response -> {}" contract: its own inline comment ("A FAILED READ MUST ABORT — it '
    + 'must never fall back to `{}`") requires telling a failed read apart from an empty-but-'
    + 'successful one, which the shared helper does not distinguish.',
};

/** `true` if `code` (already comment-stripped) fetches `/api/read-meta` directly.
 *
 *  A plain substring test, not an anchored-quote regex like `metaMergeNotClobber.test.ts`'s
 *  `/api/write-meta` sibling: that route takes no query string, so every real call is the bare
 *  literal `'/api/write-meta'`. This one ALWAYS carries `?path=...`, built either as a template
 *  literal (`` `/api/read-meta?path=${…}` ``) or string concatenation — an anchored-quote regex
 *  would never match either shape, which is exactly the false-negative direction that makes a
 *  forbidden-pattern guard useless. */
function hasRawReadMetaFetch(code: string): boolean {
  return code.includes('/api/read-meta');
}

describe('.meta.json reads prefer the pending park (#845 close-out)', () => {
  it('editorSourceFiles enumerates a real, non-trivial corpus (sanity: the scan works)', () => {
    expect(editorSourceFiles().length).toBeGreaterThan(150);
  });

  it('every raw /api/read-meta fetch is the helper file or a declared exemption', () => {
    const offenders = editorSourceFiles()
      .filter((rel) => rel !== HELPER_FILE && !(rel in EXEMPT))
      .filter((rel) => hasRawReadMetaFetch(read(rel)));
    expect(
      offenders,
      [
        'These files fetch /api/read-meta directly instead of through readMetaPreferringPark',
        '(scene/pendingMeta.ts), so a still-parked edit for the same path is invisible to them —',
        'either the decision they make from it, or the full document they write back, silently',
        'reverts to the pre-edit disk state the moment a park exists for the same path. Route the',
        'read through readMetaPreferringPark, or add a verified exemption to EXEMPT above.',
        '',
        ...offenders,
      ].join('\n'),
    ).toEqual([]);
  });

  it('the helper file really does carry the one raw fetch — the premise this rule rests on', () => {
    // A guard whose "forbidden" side is vacuous because its own reference case was never real
    // proves nothing — same lesson as metaMergeNotClobber's "the server really does REPLACE" check.
    expect(hasRawReadMetaFetch(read(HELPER_FILE))).toBe(true);
  });

  it('every exemption still has a raw fetch to exempt — a stale exemption hides nothing', () => {
    const stale = Object.keys(EXEMPT).filter((rel) => !hasRawReadMetaFetch(read(rel)));
    expect(
      stale,
      'These exemptions no longer have a raw /api/read-meta fetch — either the file was already '
      + 'migrated to the helper (drop the entry) or this points at the wrong file.',
    ).toEqual([]);
  });

  it('every exemption is a real file this scan actually enumerates', () => {
    // Catches a typo'd or moved exemption path silently exempting nothing while still reading as
    // "handled" above (the filter `!(rel in EXEMPT)` only skips paths that MATCH — a wrong path in
    // EXEMPT protects a file that was never at risk and leaves the real one unexamined).
    const known = new Set(editorSourceFiles());
    const unknownExemptions = Object.keys(EXEMPT).filter((rel) => !known.has(rel));
    expect(unknownExemptions).toEqual([]);
  });

  // ⚠️ Both directions matter — a guard proving it REJECTS a raw fetch never proves it ACCEPTS the
  // helper (the same lesson `metaMergeNotClobber.test.ts`'s "detector detects" block draws for the
  // write side). The corpus checks above only ever show a MIGRATED file has nothing left to flag,
  // which a detector that flags EVERYTHING would also show — so the synthetic snippets below pin
  // the detector's actual behaviour on both sides directly.
  it('the detector REJECTS a raw fetch, in both quote styles', () => {
    expect(hasRawReadMetaFetch('backendFetch(`/api/read-meta?path=${x}`)')).toBe(true);
    expect(hasRawReadMetaFetch("backendFetch('/api/read-meta?path=' + x)")).toBe(true);
    expect(hasRawReadMetaFetch('fetch("/api/read-meta?path=" + x)')).toBe(true);
  });

  it('the detector ACCEPTS the helper — and a file that merely mentions the route in prose', () => {
    expect(hasRawReadMetaFetch('readMetaPreferringPark(path)')).toBe(false);
    expect(hasRawReadMetaFetch('const { meta } = await readMetaPreferringPark(path, { signal });')).toBe(false);
    // A file that only ever calls the helper has no raw-fetch STRING left in its code at all —
    // this is what a migrated call site actually looks like, not a hand-picked negative example.
    expect(hasRawReadMetaFetch('void backendFetch(\'/api/write-meta\', { method: \'POST\' });')).toBe(false);
  });

  it('a real migrated write-back site (NineSliceEditor) has no raw fetch left', () => {
    expect(hasRawReadMetaFetch(read('panels/NineSliceEditor.tsx'))).toBe(false);
  });

  it('a real migrated write-back site (SpriteEditor) has no raw fetch left', () => {
    expect(hasRawReadMetaFetch(read('panels/SpriteEditor.tsx'))).toBe(false);
  });

  it('a real migrated decision site (Inspector.tsx AssetInspector) has no raw fetch left', () => {
    expect(hasRawReadMetaFetch(read('panels/Inspector.tsx'))).toBe(false);
  });
});
