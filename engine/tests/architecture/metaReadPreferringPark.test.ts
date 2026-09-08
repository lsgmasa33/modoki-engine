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

/** What an exemption owes beyond a reason (#871).
 *
 *  ⚠️ **An exemption from the READ HELPER is not an exemption from the CAS BASELINE, and that
 *  distinction is the whole of #871.** `VideoAssetView`'s reason was true — and is still true —
 *  about WHICH DOCUMENT THE PANEL DISPLAYS, and it was read as vouching for the file generally.
 *  Because its raw fetch dropped `X-Meta-Sha256`, `baselines` never had an entry for any `.mp4`,
 *  `flushPendingMetaFor` passed `undefined` as `ifMatch`, and `ifMatchRefusal` reads an absent
 *  `ifMatch` as *proceed* — so #845 phase 2's precondition was INERT for that whole asset type
 *  while looking present everywhere else.
 *
 *  A prose reason cannot carry that, because a reason that is true of one property reads as
 *  covering all of them. So the cost is DECLARED as a field and CHECKED, not narrated. */
interface Exemption {
  /** Why this file cannot route its read through `readMetaPreferringPark`. */
  reason: string;
  /** `'seeds'` — this file still records the CAS baseline itself, via `noteMetaReadResult`
   *  (asserted below). `'none'` — it establishes no baseline, and `costs` says why that is safe. */
  baseline: 'seeds' | 'none';
  /** What this file's own FAILED read yields (#880) — the second thing the helper does that an
   *  exemption silently drops.
   *
   *  ⚠️ **The same trap as `baseline`, one release later.** `readMetaPreferringPark` returns
   *  `metaReadFallback()` on a non-ok GET: a `{}` tagged so a park or wholesale write built on it
   *  is REFUSED, because the write replaces the sidecar and an id-less document costs the asset
   *  its GUID. A raw reader writing a bare `{}` hands its panel an UNTAGGED fallback, and the
   *  guard is inert for every asset only that file reads — exactly the shape #871 had.
   *
   *  `'tags'` — calls `metaReadFallback()` (asserted below). `'aborts'` — has no fallback at all
   *  because a failed read returns early, which is the stronger position and needs no tag. */
  fallback: 'tags' | 'aborts';
  /** What this file's own SUCCESSFUL read yields (#891) — the third thing the helper does that an
   *  exemption silently drops, and the same trap as `baseline` and `fallback` one release later
   *  again.
   *
   *  `readMetaPreferringPark` stamps what it returns with the path it was read FOR, and
   *  `parkMetaEdit` refuses a document whose stamp is absent or names another path — which is what
   *  stops a panel parking the PREVIOUS asset's document under this one. A raw reader that does not
   *  stamp hands its panel a document the guard cannot tell from one nobody read, so every park for
   *  every asset only that file reads is REFUSED: not a destruction this time, but the human's edits
   *  silently stop landing, which is the same class of silent failure pointing the other way.
   *
   *  `'stamps'` — calls `stampMetaReadPath()` (asserted below). `'never-parks'` — the file calls
   *  `parkMetaEdit` nowhere, so it has nothing to stamp for (also asserted, in both directions). */
  readPath: 'stamps' | 'never-parks';
  /** Required when `baseline` is `'none'`: what the bypass COSTS and why that is acceptable here.
   *  This is the field #871 did not exist to make anyone write. */
  costs?: string;
}

/** Files with a raw `/api/read-meta` fetch that deliberately do NOT go through the helper, each
 *  with a verified reason. Add a name here only with a verified reason, never to silence a
 *  failure — see `liveReloadKinds.test.ts`'s `NOT_LIVE_RELOADABLE` for the same discipline. */
const EXEMPT: Record<string, Exemption> = {
  'panels/assetViews/VideoAssetView.tsx': {
    baseline: 'seeds',
    fallback: 'tags',
    readPath: 'stamps',
    reason:
    'keeps a THIRD piece of state (`applied`) that must reflect DISK, never a still-parked edit — '
    + 'preferring the park there would compare a pending edit against itself and hide the '
    + '"re-import to apply" nudge for an edit that was never actually baked. Verified in the '
    + 'inline #845 comment on `applyMeta`: `applied` is set from the raw disk read while `meta` — '
    + 'what the panel actually shows — separately prefers `peekPendingMeta`, so this file already '
    + 'does the RIGHT thing for both, it just cannot do it through a helper that skips the network '
    + 'call whenever a park exists. '
    + '\u26a0\ufe0f #871: that reason is about which DOCUMENT this panel displays and about nothing '
    + 'else — it is NOT an exemption from the CAS baseline, which this file dropped for every '
    + '.mp4 until it called `noteMetaReadResult` on the same raw response.',
  },
  'panels/makeTexture2D.ts': {
    baseline: 'none',
    fallback: 'aborts',
    readPath: 'never-parks',
    costs:
    'establishes no baseline, and does not need one: it flushes this path, reads, and writes '
    + 'UNCONDITIONALLY in one synchronous body, and `writeMetaConditional`\'s own docblock names an '
    + 'unconditional write as "the right default for the eight explicit-action writers" — the '
    + 'human asked for the write and it is built from a read moments earlier. Seeding here would '
    + 'be actively WRONG: the write below, and then `/api/reimport`, both replace the sidecar, so '
    + 'a baseline taken from the pre-write read would be stale the moment it was recorded. What '
    + 'this file owes instead is #874 — it writes through `writeMetaWholesale`, which forgets the '
    + 'baseline on success, so a Texture Inspector mounted on the same path does not 409 '
    + 'against a hash this code replaced.',
    reason:
    'flushes this exact path (`flushPendingMetaFor`) immediately before this read, every time, in '
    + 'the same synchronous function body — so by the time it reads, nothing can be parked for it '
    + 'and there is no park left to prefer. It also cannot tolerate `readMetaPreferringPark`\'s '
    + '"non-ok response -> {}" contract: its own inline comment ("A FAILED READ MUST ABORT — it '
    + 'must never fall back to `{}`") requires telling a failed read apart from an empty-but-'
    + 'successful one, which the shared helper does not distinguish.',
  },
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

/** `true` if `code` (already comment-stripped) CALLS `noteMetaReadResult` (#871).
 *
 *  \u26a0\ufe0f The trailing `(` is the whole point, and it was learned the hard way: a bare
 *  `.includes('noteMetaReadResult')` also matches the `import` statement, so the `'seeds'` rule
 *  stayed green with the call deleted — vacuous for exactly the regression it guards. Unlike
 *  `hasRawReadMetaFetch` above, where a mention and a use cannot be told apart by shape, here they
 *  can: an import names the symbol bare, a call follows it with a paren. */
function callsReadResultRecorder(code: string): boolean {
  return /\bnoteMetaReadResult\s*\(/.test(code);
}

/** `true` if `code` (already comment-stripped) CALLS `metaReadFallback` (#880).
 *
 *  Same paren rule, and for the same reason `callsReadResultRecorder` documents above: an import
 *  names the symbol bare and would make the `'tags'` rule vacuous with the call deleted. Written
 *  this way from the start BECAUSE that lesson is already on the record one function up — the
 *  cheapest kind of scar to reuse. */
function callsMetaReadFallback(code: string): boolean {
  return /\bmetaReadFallback\s*\(/.test(code);
}

/** `true` if `code` (already comment-stripped) CALLS `stampMetaReadPath` (#891).
 *
 *  Same paren rule as the two detectors above, for the third time and the same reason — an import
 *  names the symbol bare, and a detector that matched it would make the `'stamps'` rule vacuous
 *  with the call deleted. */
function callsReadPathStamper(code: string): boolean {
  return /\bstampMetaReadPath\s*\(/.test(code);
}

/** `true` if `code` (already comment-stripped) CALLS `parkMetaEdit` — i.e. this file has documents
 *  that a missing stamp would get refused. Same paren rule again. */
function callsParkMetaEdit(code: string): boolean {
  return /\bparkMetaEdit\s*\(/.test(code);
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

  /** #871 — the assertion the prose reason could not make.
   *
   *  `VideoAssetView`'s exemption reason was true about which document the panel DISPLAYS and was
   *  read as vouching for the file generally, so the CAS baseline went unrecorded for the whole
   *  `.mp4` type: `flushPendingMetaFor` passed `undefined` as `ifMatch` and `ifMatchRefusal` reads
   *  an absent `ifMatch` as *proceed*. A guard that silently does not run — which is why the issue
   *  carries `family/fail-open-guard`.
   *
   *  ⚠️ Both directions, deliberately. A `'seeds'` entry that stopped seeding is the regression
   *  this exists to catch; a `'none'` entry that quietly started is a declaration that has gone
   *  stale, and a stale declaration is what let the first one through. */
  it("a 'seeds' exemption really does record the baseline, and a 'none' one really does not", () => {
    const wrong: string[] = [];
    for (const [rel, ex] of Object.entries(EXEMPT)) {
      const seeds = callsReadResultRecorder(read(rel));
      if (ex.baseline === 'seeds' && !seeds) {
        wrong.push(`${rel}: declared 'seeds' but never calls noteMetaReadResult — the #845 `
          + 'ifMatch precondition is INERT for every asset only this file reads.');
      }
      if (ex.baseline === 'none' && seeds) {
        wrong.push(`${rel}: declared 'none' but DOES call noteMetaReadResult — update the entry `
          + 'to \'seeds\' and drop `costs`, or the declaration is lying about what this file does.');
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  /** A `'none'` entry is a claim that losing the baseline is SAFE HERE, and that claim has to be
   *  written down — the whole lesson of #871 is that the unstated half is the one that bites. An
   *  empty `costs` would make the field ceremony. */
  it("every 'none' exemption states what the bypass costs", () => {
    const undeclared = Object.entries(EXEMPT)
      .filter(([, ex]) => ex.baseline === 'none' && (ex.costs ?? '').trim().length < 40)
      .map(([rel]) => rel);
    expect(
      undeclared,
      'These exemptions establish no CAS baseline and do not say why that is safe. An exemption '
      + 'from readMetaPreferringPark is NOT an exemption from the baseline (#871) — say what is '
      + 'given up and why this file can afford it.',
    ).toEqual([]);
  });

  /** #880 — the `baseline` rule's twin, for the other thing an exemption drops silently.
   *
   *  A raw reader's bare `{}` is an UNTAGGED fallback, so `parkMetaEdit` and `writeMetaWholesale`
   *  cannot tell it from a document the panel genuinely read — and the GUID-destruction guard is
   *  inert for every asset only that file reads. That is the #871 shape exactly, which is why the
   *  cost is declared and checked rather than narrated.
   *
   *  ⚠️ Both directions, same as `baseline`. A `'tags'` entry that stopped tagging is the
   *  regression; an `'aborts'` entry that quietly started tagging means its early return is gone
   *  and the declaration has gone stale — and a stale declaration is what let #871 through. */
  it("a 'tags' exemption really does tag its fallback, and an 'aborts' one has none to tag", () => {
    const wrong: string[] = [];
    for (const [rel, ex] of Object.entries(EXEMPT)) {
      const tags = callsMetaReadFallback(read(rel));
      if (ex.fallback === 'tags' && !tags) {
        wrong.push(`${rel}: declared 'tags' but never calls metaReadFallback — its failed read `
          + 'hands the panel an untagged {}, so the #880 refusal is INERT for every asset only '
          + 'this file reads, and an id-less write costs those assets their GUID.');
      }
      if (ex.fallback === 'aborts' && tags) {
        wrong.push(`${rel}: declared 'aborts' but DOES call metaReadFallback — if this file now `
          + "has a fallback instead of an early return, change the entry to 'tags'; if it has "
          + 'both, the early return is the one that should stay.');
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  /** The positive control for the `'aborts'` half, which is otherwise a claim about ABSENCE — and
   *  absence is what a vacuous guard also looks like. `makeTexture2D` declares that it needs no
   *  tag because a failed read returns early; pin that the early return is really there, so
   *  deleting it turns the declaration red instead of leaving it quietly false. */
  it("the 'aborts' exemption really does return early on a failed read", () => {
    // Deliberately shape-based, not text-based: an `if` whose condition negates some response's
    // `.ok` and whose body reaches `return false`. That survives renaming the variable or adding
    // another disjunct (it currently reads `!metaRes || !metaRes.ok`), and still goes red if the
    // early return itself is deleted — which is the only thing this is asserting.
    expect(read('panels/makeTexture2D.ts')).toMatch(/if\s*\([^)]*!\s*\w+\.ok[^)]*\)\s*\{[\s\S]{0,400}?return\s+false/);
  });

  /** The detector's own positive control. If `noteMetaReadResult` is ever renamed, the substring
   *  test above silently stops matching and BOTH checks go vacuously green — the `'seeds'` half
   *  reads as "nobody seeds" and the `'none'` half as "nobody wrongly seeds". Pin the name against
   *  the module that defines it. */
  it('the baseline seeder this rule names actually exists', () => {
    const helper = read(HELPER_FILE);
    expect(helper).toContain('export function noteMetaReadResult');
  });

  /** Same control for the #880 half — a rename would make `callsMetaReadFallback` match nothing
   *  and both directions of the `fallback` rule go vacuously green.
   *
   *  ⚠️ The DEFINITION lives in its own leaf module, not in the read helper: `pendingMeta.ts`
   *  imports the write endpoint (`assetViews/widgets.tsx`), so the endpoint could not import the
   *  predicate back without a cycle. Assert the definition where it is and the USE where it
   *  matters — checking only `pendingMeta.ts` would pass on the re-export while the helper had
   *  stopped tagging. */
  it('the tagged fallback this rule names actually exists, and the helper uses it', () => {
    const FALLBACK_FILE = 'scene/metaReadFallback.ts';
    expect(read(FALLBACK_FILE)).toContain('export function metaReadFallback');
    // ...and the blessed reader really is the reference case the exemptions are measured against:
    // if the helper itself stopped tagging, every 'tags' exemption would be guarding a hole.
    expect(callsMetaReadFallback(read(HELPER_FILE))).toBe(true);
  });

  /** \u26a0\ufe0f The detector must see a CALL, not a mention — and this is not hypothetical
   *  tidiness. Written first as a plain `.includes('noteMetaReadResult')`, the rule above passed
   *  with `VideoAssetView`'s call DELETED, because the file still names the symbol in its
   *  `import`. The guard was vacuous for the single regression it exists to catch, and only
   *  mutation-testing it showed that. Same family as `metaMergeNotClobber`'s extractor and
   *  `hasRawReadMetaFetch` above: pin the detector's behaviour on BOTH sides directly rather than
   *  inferring it from a corpus that happens to be clean. */
  it('the seeder detector matches a CALL and not an import mention', () => {
    expect(callsReadResultRecorder('noteMetaReadResult(path, r);')).toBe(true);
    expect(callsReadResultRecorder('  noteMetaReadResult (path, r);')).toBe(true);
    expect(callsReadResultRecorder("import { parkMetaEdit, noteMetaReadResult } from '../x';")).toBe(false);
    expect(callsReadResultRecorder('import {\n  noteMetaReadResult,\n} from "../x";')).toBe(false);
    expect(callsReadResultRecorder('const f = noteMetaReadResult;')).toBe(false);
  });

  it('the fallback detector matches a CALL and not an import mention', () => {
    expect(callsMetaReadFallback('return r.ok ? r.json() : metaReadFallback();')).toBe(true);
    expect(callsMetaReadFallback('  metaReadFallback ();')).toBe(true);
    expect(callsMetaReadFallback("import { parkMetaEdit, metaReadFallback } from '../x';")).toBe(false);
    expect(callsMetaReadFallback('import {\n  metaReadFallback,\n} from "../x";')).toBe(false);
    expect(callsMetaReadFallback('const f = metaReadFallback;')).toBe(false);
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

  /** #891 — the `fallback` rule's twin, for the third thing an exemption drops silently.
   *
   *  ⚠️ Both directions, same as the two above. A `'stamps'` entry that stopped stamping means every
   *  park for that asset type is silently refused; a `'never-parks'` entry that started parking is a
   *  declaration gone stale — and a stale declaration is what let #871 through in the first place. */
  it("a 'stamps' exemption really does stamp its read, and a 'never-parks' one really does not park", () => {
    const wrong: string[] = [];
    for (const [rel, ex] of Object.entries(EXEMPT)) {
      const code = read(rel);
      if (ex.readPath === 'stamps' && !callsReadPathStamper(code)) {
        wrong.push(`${rel}: declared 'stamps' but never calls stampMetaReadPath — parkMetaEdit `
          + 'cannot tell its document from one nobody read, so every park for every asset only '
          + 'this file reads is REFUSED and the human\'s edits stop landing.');
      }
      if (ex.readPath === 'never-parks' && callsParkMetaEdit(code)) {
        wrong.push(`${rel}: declared 'never-parks' but DOES call parkMetaEdit — it now needs to `
          + "stamp its read; change the entry to 'stamps' and add the call.");
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  /** The reference case the `'stamps'` rule is measured against: if the blessed reader itself
   *  stopped stamping, every exemption would be guarding a hole — the same control the tagged
   *  fallback gets one test up. */
  it('the read-path stamp this rule names actually exists, and the helper uses it', () => {
    const FALLBACK_FILE = 'scene/metaReadFallback.ts';
    expect(read(FALLBACK_FILE)).toContain('export function stampMetaReadPath');
    expect(callsReadPathStamper(read(HELPER_FILE))).toBe(true);
  });

  it('the stamp detector matches a CALL and not an import mention', () => {
    expect(callsReadPathStamper('return stampMetaReadPath(m, path);')).toBe(true);
    expect(callsReadPathStamper('  stampMetaReadPath (m, path);')).toBe(true);
    expect(callsReadPathStamper("import { parkMetaEdit, stampMetaReadPath } from '../x';")).toBe(false);
    expect(callsReadPathStamper('import {\n  stampMetaReadPath,\n} from "../x";')).toBe(false);
    expect(callsReadPathStamper('const f = stampMetaReadPath;')).toBe(false);
  });

  it('the park detector matches a CALL and not an import mention', () => {
    expect(callsParkMetaEdit('parkMetaEdit(path, updatedMeta);')).toBe(true);
    expect(callsParkMetaEdit("import { parkMetaEdit, metaReadFallback } from '../x';")).toBe(false);
  });
});
