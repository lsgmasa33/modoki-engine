/**
 * ⚠️ **No test may grow a private comment stripper — there is ONE scanner (#419).**
 *
 * The rule this enforces is in `docs/verify-and-ci.md` § "Source-scanning guards", and without
 * this file it was a rule with no enforcement in a repo whose whole thesis is enforcement. That is
 * not a hypothetical gap: **twelve** guards independently grew the same broken stripper, and when
 * the first sweep migrated them it missed sixteen more, in a repo where the defect had already
 * been found and fixed twice (#411, #418) without anyone noticing the copies.
 *
 * The banned shape is the one they all had:
 *
 *     .replace(BLOCK_LAZY, '')      then some line-comment removal
 *
 * where `BLOCK_LAZY` is a lazy `/*`…`*` + `/` regex. A `/*` sequence written inside a **line**
 * comment opens a phantom block that runs to the next real terminator, and everything between is
 * DELETED. Every guard using it is a forbidden-pattern guard, so deleting source LOWERS the
 * offender count — it fails silent and GREEN, the only direction that matters. Measured: that
 * shape hid 82 lines of `Scene3D.tsx`, including 22 imports, from the determinism guard.
 *
 * ⚠️ **This guard strips its own input with the shared scanner**, so a file that DISCUSSES the
 * broken regex in prose (several of them do — it is the scar they carry) is not an offender.
 * Which also makes it a live user of the thing it is protecting.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertScanIsSane, readScannedSource } from '@modoki/engine/testing';
import { REPO_ROOT } from '../helpers/repoLayout';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

/**
 * The lazy block-comment regex, as it is written in source. This exact substring is the defect.
 *
 * ⚠️ **Assembled from two halves rather than written out, and that is not obfuscation.** This
 * guard strips comments but KEEPS string contents — deliberately, since a stripper hides in code,
 * not in prose. So spelling the banned shape as one literal makes this file its own first
 * offender, which is exactly what happened on its first run. Splitting it is the honest fix:
 * allowlisting itself would have put a hole in the one file that must not have one.
 */
const BLOCK_LAZY = String.raw`\/\*[\s\S]` + String.raw`*?\*\/`;

/** A `.replace(...)` whose pattern matches `//` — the other half of a hand-rolled stripper. */
const LINE_STRIP = /\.replace\(\s*\/[^/\n]*\\\/\\\/[^/\n]*\/[a-z]*\s*,/;

/**
 * Files allowed to contain the banned shape, each for a stated reason.
 *
 * ⚠️ Keep this SMALL and keep the reasons real. An entry here is a file that can silently delete
 * the code it inspects; "it was easier" is not a reason.
 */
const ALLOW = new Map<string, string>([
  [
    'engine/packages/modoki/tests/helpers/sourceScanner.test.ts',
    'defines `brokenRegexStrip` deliberately, as the thing it pins the shared scanner against — '
    + 'the one place the broken shape must exist so its failure can be asserted',
  ],
]);

/** Test roots that own source-scanning guards, git-enumerated (#771/#799) rather than a
 *  hand-rolled recursive walk. A root that is absent (the public OSS checkout has no `games/`)
 *  contributes nothing rather than failing — `repoFiles()`'s `under` list needs no existence
 *  check of its own, unlike the old walker's per-root `fs.existsSync`.
 *
 *  A test file counts only under `engine/tests/`, `engine/packages/modoki/tests/`, or a project's
 *  own DIRECT `tests/` folder (`games/<id>/tests/**`, `demos/<id>/tests/**`) — the same scope the
 *  old walker's root list enumerated, not every `.test.tsx?` anywhere under `games/`/`demos/`. */
function testFiles(): string[] {
  return repoFiles({
    under: ['engine/tests', 'engine/packages/modoki/tests', 'games', 'demos'],
    match: (rel) => {
      const isTestFile = /\.test\.tsx?$/.test(rel) || /(^|\/)sourceScanner\.ts$/.test(rel);
      if (!isTestFile) return false;
      if (rel.startsWith('engine/tests/') || rel.startsWith('engine/packages/modoki/tests/')) return true;
      return /^(games|demos)\/[^/]+\/tests\//.test(rel);
    },
    floor: 0,
  }).map(({ abs }) => abs);
}

describe('there is ONE comment scanner, and tests import it (#419)', () => {
  const files = testFiles().map((abs) => {
    // Reads through the shared reader like everything else — this file is a live user of the thing
    // it protects, and exempting itself would put the hole in the one place that must not have one.
    const { raw, code } = readScannedSource(abs);
    return { rel: path.relative(REPO_ROOT, abs).replace(/\\/g, '/'), raw, code };
  });

  it('scans a non-empty set of test files across engine AND project suites', () => {
    // Without this the whole guard is a cheerful no-op the day a root stops matching.
    expect(files.length, 'the walk found no test files').toBeGreaterThan(200);
    expect(files.some((f) => f.rel.startsWith('engine/tests/')), 'engine/tests not reached').toBe(true);
    expect(
      files.some((f) => f.rel.startsWith('engine/packages/modoki/tests/')),
      'the package suite not reached',
    ).toBe(true);
  });

  it('the comment strip is length- and line-exact (a regex stripper would not be)', () => {
    for (const f of files) assertScanIsSane(f.raw, f.code, f.rel);
  });

  it('no test file hand-rolls a block-comment stripper', () => {
    const offenders = files
      .filter((f) => !ALLOW.has(f.rel))
      .filter((f) => f.code.includes(BLOCK_LAZY))
      .map((f) => f.rel);
    expect(
      offenders,
      'these files strip block comments with a lazy regex, which DELETES code whenever a `/*` '
      + 'appears inside a line comment — and a forbidden-pattern guard reads the deletion as a '
      + `PASS. Import { stripComments } from '@modoki/engine/testing' instead (#419):\n`
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('no test file hand-rolls a line-comment stripper', () => {
    const offenders = files
      .filter((f) => !ALLOW.has(f.rel))
      .filter((f) => LINE_STRIP.test(f.code))
      .map((f) => f.rel);
    expect(
      offenders,
      'these files strip line comments with a private regex. Even where it does not delete, a '
      + 'second stripper is a second thing to fix — that multiplicity is what let one copy be '
      + `fixed twice while eleven carried the original bug. Use '@modoki/engine/testing' (#419):\n`
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('every allowlist entry still exists and still needs to be there', () => {
    // A stale allowlist is a hole nobody is looking at.
    for (const [rel, reason] of ALLOW) {
      const f = files.find((x) => x.rel === rel);
      expect(f, `allowlisted file ${rel} no longer exists — drop the entry`).toBeDefined();
      expect(
        f!.code.includes(BLOCK_LAZY) || LINE_STRIP.test(f!.code),
        `${rel} no longer hand-rolls a stripper — drop the allowlist entry (${reason})`,
      ).toBe(true);
    }
  });
});

/**
 * ⚠️ **The other half: a guard that never strips at all (#812).**
 *
 * The rules above ban a hand-rolled stripper, which is the #419 defect. They are blind to the
 * commoner one — a guard that reads `fs.readFileSync(…, 'utf8')` and matches the RAW text, so a
 * comment is indistinguishable from code. That fails open in both directions: a forbidden-pattern
 * guard goes green because prose HID the offender, and a required-pattern guard goes green because
 * prose SATISFIED the match, leaving the real call site free to be deleted.
 *
 * ⚠️ **Its twin is `corpusProducerIsShared.test.ts` (#799/#771/#805), and a guard needs BOTH.**
 * That one enforces the shared way to decide WHICH files are in a corpus; this one enforces the
 * shared way to READ each of them. They landed independently on two clones and are complementary,
 * not competing: enumerate with `repoFiles()`, read with `readScannedSource()`. A guard with only
 * the first can still be satisfied by a comment; a guard with only the second can still be blind
 * to half the corpus.
 *
 * ⚠️ **Scoped to `engine/tests/architecture/**` deliberately, and the scope is doing real work.**
 * A census of all 1,234 test files found 113 with a raw utf8 read, but the overwhelming majority
 * read a fixture the test itself just WROTE, where there is nothing to strip and no defect —
 * inside THIS directory it is 55 of 59. The class is "a guard scanning the repo's own source", and
 * this directory is where those live. A read elsewhere is not caught here — a deliberate
 * false-negative rather than a 55-entry allowlist, which would be the same hole one level up. The
 * 27 real guards in the other test roots are tracked in #816.
 *
 * The shape below therefore matches a read whose PATH is built from a repo-root token, which is
 * what separates "scan `engine/app/ecs/registerTraits.ts`" from "read back my own tmp fixture".
 */
const ARCH_DIR = 'engine/tests/architecture/';

/**
 * Every `readFileSync(…, 'utf8')` call, as source text.
 *
 * ⚠️ **Two steps, not one regex, and the one-regex version was WRONG.** An attempt to require the
 * repo-root token inside the call in a single pattern could not match `readFileSync(path.join(
 * repoRoot, 'engine/…'), 'utf8')` at all: a paren-balancing alternation has to consume
 * `path.join(…)` whole, which swallows the very token it then looks for. It reported zero
 * offenders against thirteen known ones — the silent-green direction, in the guard written to stop
 * exactly that.
 */
const READ_CALL =
  /\bread(?:FileSync|File)\([\s\S]{0,300}?(?:['"]utf-?8['"]\s*\)|encoding\s*:\s*['"]utf-?8['"][\s\S]{0,40}?\)|\)\s*\.\s*toString\(\))/g;

/**
 * A path built from a repo-root token — what separates scanning the repo's own source from
 * reading back a tmp fixture the test itself just wrote.
 *
 * ⚠️ **This is a PARTIAL rule and the gap is known, not accidental.** It sees the read expression
 * only, so `readFileSync(file, 'utf8')` where `file` came from a walk of the repo is NOT caught —
 * whether the path is repo-rooted is a dataflow question, and this is a regex. `docCitations` and
 * `editorStoreActionsReachable` are both written that way (harmlessly: they scan prose ON PURPOSE),
 * and so were several of the guards #812 enumerated, which had to be found by reading rather than
 * by this rule.
 *
 * Kept anyway, because the alternative is worse in the direction that matters: widening it to every
 * utf8 read in this directory means allowlisting ~57 files that legitimately read their own
 * fixtures, and a 55-entry allowlist is the same fail-open hole one level up. What this rule buys
 * is that the COMMON shape cannot come back silently. It is not a proof that the class is closed.
 */
const REPO_ROOTED =
  /ROOT\b|[Rr]epoRoot|\bREPO\b|[A-Z][A-Z_]*_DIR\b|__dirname|['"](?:engine|games|demos|docs|qa)\//;

/**
 * Reads that are NOT this defect, and must not be reported as it.
 *
 * ⚠️ **All three were found by running the rule, not by predicting them** — the first version
 * reported fifteen files, every one of them correct code. A guard that cries wolf on correct code
 * gets its allowlist grown until it means nothing, which is how the thing it guards comes back.
 *
 * - `JSON.parse(readFileSync(…))` — parsed as DATA, never pattern-matched. Not a source scan.
 * - `stripComments(readFileSync(…))` — already stripped by hand at the call site. Routing it
 *   through the reader is tidier, but it is not fail-open, so it is not this guard's business.
 * - a `.md` path — Markdown has no code/comment distinction for a scan to be defeated by, and the
 *   guards reading it (`skillReferences`, `qaCaseReferences`' case bodies, `docCitations`) are
 *   scanning prose because prose is the subject.
 */
const WRAPPED_BEFORE = [
  // ⚠️ `\s*(?:[\w$]+\s*\.\s*)?$`, not `$`. Both wrappers are routinely written with the read on
  // the NEXT line, and the read itself is usually `fs.readFileSync` — so the text between the
  // wrapper and the match is a newline, indentation AND a `fs.` qualifier. Requiring adjacency made
  // this exclusion match almost nothing, and the rule reported fifteen correct files as offenders.
  /JSON\s*\.\s*parse\s*\(\s*(?:[\w$]+\s*\.\s*)?$/,
  /strip(?:Comments|CommentsAndStrings)\s*\(\s*(?:[\w$]+\s*\.\s*)?$/,
];

/**
 * The same two wrappers applied to the read's RESULT a line or two later, which is how most of
 * these are actually written:
 *
 *     const raw = readFileSync(join(repoRoot, rel), 'utf8');
 *     const cfg = JSON.parse(raw);
 *
 * ⚠️ A deliberate false NEGATIVE: a read followed by an unrelated `JSON.parse` within the window
 * is excused. That is the conservative direction for a rule whose false POSITIVES are what get its
 * allowlist grown until it means nothing.
 */
const WRAPPED_AFTER = /\b(?:JSON\s*\.\s*parse|strip(?:Comments|CommentsAndStrings)|assertScanIsSane)\s*\(/;

/** `.md` names a file with no comment syntax these guards can be blinded by. */
const MARKDOWN_READ = /\.md['"]|\bMD\b|markdown/i;

/**
 * The raw reads of repo source in one file, as matched text (empty when the file is clean).
 *
 * `before` is the text immediately preceding the read, which is where a `JSON.parse(` or
 * `stripComments(` wrapper sits.
 */
const rawSourceReads = (code: string): string[] =>
  [...code.matchAll(READ_CALL)]
    .filter((m) => REPO_ROOTED.test(m[0]))
    .filter((m) => !MARKDOWN_READ.test(m[0]))
    .filter((m) => {
      const before = code.slice(Math.max(0, m.index - 40), m.index);
      if (WRAPPED_BEFORE.some((re) => re.test(before))) return false;
      // 400, not 150: the wrapper often sits past a blanked comment or a multi-line type
      // annotation, and at 150 two correct files were still reported.
      const after = code.slice(m.index + m[0].length, m.index + m[0].length + 400);
      return !WRAPPED_AFTER.test(after);
    })
    .map((m) => m[0]);

/**
 * Files allowed to read repo source raw, each for a stated reason.
 *
 * ⚠️ **Empty, and worth keeping that way.** Every guard this rule REPORTS was migrated in #812
 * rather than allowlisted, so an entry here is a NEW hole, not inherited debt.
 *
 * ⚠️ "Every guard this rule reports" is not the same as "every guard that scans repo source", and
 * an earlier version of this note claimed the latter — which was false. The rule's reach is bounded
 * by `REPO_ROOTED` below; the guards it cannot see are neither migrated nor allowlisted, they are
 * simply invisible to it. #816 tracks the ones in the other test roots.
 */
const RAW_READ_ALLOW = new Map<string, string>([]);

describe('an architecture guard reads source through the shared reader (#812)', () => {
  // ⚠️ **`.ts` as well as `.test.ts`, because a source-scanning HELPER is not a test.**
  // `moduleGraph.ts` reads all 541 runtime files and feeds two frozen baselines, and it carried
  // the phantom-edge defect this change fixed — yet a `.test.ts`-only walk never looked at it.
  //
  // ⚠️ Widening the walk does NOT make that particular revert catchable, and saying so matters:
  // its read is `readFileSync(file, 'utf8')` over a walk variable, which `REPO_ROOTED` cannot see
  // (the dataflow limit below). Reverting it is caught by a bespoke assertion in
  // `moduleGraphCommentEdges.test.ts`, not by this rule. What the widening buys is the NEXT
  // helper, whose read is repo-rooted — previously that file was not even enumerated.
  const archFiles = fs.readdirSync(path.join(REPO_ROOT, ARCH_DIR), { recursive: true })
    .map((n) => String(n).replace(/\\/g, '/'))
    .filter((n) => n.endsWith('.ts') || n.endsWith('.tsx'))
    .map((n) => `${ARCH_DIR}${n}`)
    .map((rel) => ({ rel, code: readScannedSource(path.join(REPO_ROOT, rel)).code }));

  it('reaches a non-empty set of architecture guards', () => {
    // Without this the rule below is a cheerful no-op the day the path prefix changes.
    expect(archFiles.length, 'the walk found no architecture guards').toBeGreaterThan(50);
  });

  it('THE DETECTOR FIRES: it recognises a repo-source read and ignores a tmp fixture', () => {
    // ⚠️ Not decoration. The first version of this rule was structurally unable to match a read
    // wrapped in a `path.join(...)` — a paren-balancing alternation has to consume the join whole,
    // which swallows the very token it then looks for — and it reported ZERO offenders against
    // twenty-one real ones. Green, in the guard whose entire subject is being wrongly green.
    //
    // ⚠️ The fixtures are spelled in HALVES for the same reason `BLOCK_LAZY` above is: this scan
    // keeps string CONTENT, so writing the banned read out in one literal makes this file its own
    // offender. It did, on the first run. Allowlisting itself would put the hole in the one file
    // that must not have one.
    const READ = 'read' + 'FileSync(';
    const fires = (s: string): number => rawSourceReads(s).length;
    expect(fires(`const s = fs.${READ}path.join(repoRoot, 'engine/x.ts'), 'utf8');`)).toBe(1);
    expect(fires(`const s = ${READ}join(REPO_ROOT, rel), 'utf8');`)).toBe(1);
    // Repo-rooted on purpose: with a bare `p` this would return 0 for the wrong reason (no
    // root token) and prove nothing about the spelling it claims to cover.
    expect(fires(`const s = fs.${READ}join(REPO_ROOT, rel), 'utf-8');`), 'the hyphenated spelling')
      .toBe(1);
    expect(fires(`const s = fs.${READ}join(dir, 'fixture.ts'), 'utf8');`),
      'a fixture the test itself wrote is not a source scan').toBe(0);

    // ⚠️ **The spellings, because a pattern that only covers the shape its author wrote is not a
    // rule.** Review found three ordinary ones evading the first version — the eighteenth guard is
    // as likely to be written any of these ways as the canonical one.
    const READFILE = 'read' + 'File(';
    expect(fires(`const s = fs.${READ}path.join(REPO_ROOT, 'engine/x.ts'), { encoding: 'utf8' });`),
      'the options-object encoding').toBe(1);
    expect(fires(`const s = await fs.promises.${READFILE}path.join(REPO_ROOT, 'engine/x.ts'), 'utf8');`),
      'the promises API').toBe(1);
    expect(fires(`const s = fs.${READ}path.join(REPO_ROOT, 'engine/x.ts')).toString();`),
      'no encoding argument, decoded after the fact').toBe(1);

    // ⚠️ `\bROOT\b` could not match inside `ENGINE_ROOT` — `_` is a word character — which hid
    // `ssrLoaderDefines`, a real unmigrated source scan, from both this rule and #816's census.
    expect(fires(`const s = fs.${READ}path.join(ENGINE_ROOT, file), 'utf8');`),
      'a *_ROOT constant is still a repo root').toBe(1);
  });

  it('THE RULE IS WIRED: a planted offender is reported', () => {
    // ⚠️ Found by mutation: replacing the filter below with `() => false` left all nine tests in
    // this file GREEN. The detector had its own positive control, but nothing checked that the
    // offender RULE still used it — so the rule could be neutered silently, which is precisely the
    // failure this whole file exists to prevent, one level up.
    const READ = 'read' + 'FileSync(';
    const planted = { rel: 'engine/tests/architecture/__planted.test.ts',
      code: `const s = fs.${READ}path.join(REPO_ROOT, 'engine/x.ts'), 'utf8');\nexpect(s).toMatch(/x/);` };
    const reported = [...archFiles, planted]
      .filter((f) => !RAW_READ_ALLOW.has(f.rel))
      .filter((f) => rawSourceReads(f.code).length > 0)
      .map((f) => f.rel);
    expect(reported, 'the offender rule no longer reports a file that plainly matches the shape')
      .toContain(planted.rel);
  });

  it('no architecture guard matches a pattern against unstripped repo source', () => {
    const offenders = archFiles
      .filter((f) => !RAW_READ_ALLOW.has(f.rel))
      .filter((f) => rawSourceReads(f.code).length > 0)
      .map((f) => f.rel);
    expect(
      offenders,
      'these guards read repo source with fs.readFileSync and match the RAW text, so a comment '
      + 'can hide an offender from them or satisfy an assertion on its own — both silent, both '
      + `green. Read through readScannedSource from '@modoki/engine/testing' instead; it strips by `
      + 'extension and runs assertScanIsSane. A guard that means to scan PROSE says so with '
      + `{ comments: 'include', reason } (#812):\n`
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('every raw-read allowlist entry still exists and still needs to be there', () => {
    for (const [rel, reason] of RAW_READ_ALLOW) {
      const f = archFiles.find((x) => x.rel === rel);
      expect(f, `allowlisted file ${rel} no longer exists — drop the entry`).toBeDefined();
      expect(
        rawSourceReads(f!.code).length > 0,
        `${rel} no longer reads raw source — drop the allowlist entry (${reason})`,
      ).toBe(true);
    }
  });
});
