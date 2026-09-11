/**
 * RETRACTED CLAIMS — a fact its owning doc has corrected must not be RESTATED elsewhere (#1014/#1015).
 *
 * `docs/doc-conventions.md` already carries the rule: *a fact lives in ONE doc and everything else
 * links to it.* This guard is what makes the rule enforceable, because the failure it prevents is
 * silent and slow. A fact gets corrected at its source; every copy of the old version stays behind,
 * reads as authoritative, and the next author propagates it further.
 *
 * ## Why a guard and not nine edits
 *
 * #1014 filed ~12 restatements of *"`modoki_capture_viewport` FORCES a render"* — the opposite of
 * what it does, from a 2026-08-18 measurement (three successive captures byte-identical through a
 * real material change, until a camera move re-armed the SceneView's dirty gate). #1015 filed eight
 * of *"FlexLayout mounts only the SELECTED tab"* — false, because `rendered` latches.
 *
 * Both tickets grepped `qa/cases` and `docs`. Computing the real match set repo-wide to seed this
 * registry found **five more**, every one outside that scope:
 *  - two in `demos/**`, which is the **published** set, so the inversion shipped to public repos;
 *  - one in `.agent-memory/**`, which is loaded into future sessions as background context — and it
 *    did not merely restate the falsehood, it ARGUED for it ("both are true of different surfaces"),
 *    explicitly reconciling itself with root `CLAUDE.md`'s correct statement;
 *  - one more QA case, under a directory neither ticket's grep covered.
 *
 * That is the whole argument for this file: **a restated fact spreads into places nobody thinks to
 * search.** A grep run once by the person fixing it cannot be the control.
 *
 * ⚠️ And the recursion is the proof the mechanism is live: **#994's own session read one of these
 * copies, believed it, and wrote four more** — into an agent-facing refusal string and two normative
 * docs — before measuring `gameView.panelMounted: false` alongside a live `game-3d` surface and
 * having to retract.
 *
 * ## How it works, and the one thing that makes it honest
 *
 * `citedBy` is the checked field, and it is deliberately an ALLOWLIST OF FILES rather than a clever
 * attempt to tell "states the claim" from "quotes the claim in order to correct it". Distinguishing
 * those by regex is exactly the kind of guard that goes quietly wrong; naming the files is a
 * deliberate act somebody has to perform. `docCitations.test.ts`'s retired-doc registry uses the
 * same shape for the same reason, and its comment says the same thing: the prose is not the check.
 *
 * Both directions are enforced, so the registry cannot rot:
 *  - a file that matches and is NOT in `citedBy` → RED (a new copy appeared);
 *  - a `citedBy` entry that no longer matches → RED (stale allowance, quietly covering nothing).
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { readScannedSource } from '@modoki/engine/testing';
import path from 'node:path';
import { repoFiles, repoRoot } from '../../scripts/repoCorpus.mjs';
import { hasPrivateTooling } from '../helpers/repoLayout';

// These files are prose and comments, and the claim usually lives in exactly those — so the read
// must NOT strip them. That is what this declaration says, and `readScannedSource` requires a
// reason for it in so many words.
const CLAIMS_LIVE_IN_PROSE = {
  comments: 'include',
  reason: 'a retracted claim lives in prose and in code COMMENTS — stripping them is the one thing '
    + 'that would make this guard scan past every site it exists to find',
} as const;

const RETRACTED_CLAIMS: ReadonlyArray<{
  id: string;
  pattern: RegExp;
  /** Spans matching this are STRIPPED before `pattern` runs — see the comment on the capture
   *  claim's own entry. Optional: a claim whose wording is unique to it needs none. */
  trueOfADifferentSubject?: RegExp;
  owner: string;
  truth: string;
  citedBy: ReadonlyArray<{ file: string; why: string }>;
}> = [
  {
    id: 'capture-viewport-forces-a-render',
    pattern: /forces a render/i,
    // ⚠️ The predicate alone is not the claim — `modoki_render_scene`/`render_sequence` really
    // DO force one, so a bare /forces a render/ reds on a TRUE sentence while telling its author
    // the truth is a retraction, which teaches them to "fix" it back toward the falsehood.
    //
    // The discriminator is the SUBJECT, and it is matched here as a DENYLIST of the subjects that
    // are true rather than an allowlist of the ones that are false. That is the deliberate
    // direction: subject and predicate are routinely paragraphs apart —
    // `qa/cases/sceneview/render-on-demand-geometry-change.md` names `capture_viewport` ~530
    // characters before quoting the stale line — so any proximity rule tight enough to be
    // meaningful drops real sites, and one loose enough to keep them is not scoping anything.
    // A denylist stays small (there are exactly two tools that force a render) and its failure
    // mode is a red on a genuinely ambiguous sentence, which `citedBy` already exists to resolve.
    //
    // It does NOT need to cover "FORCES a *fresh* render" (contracts.ts, render.ts): `pattern`
    // does not match that spelling at all. ⚠️ Which means broadening `pattern` to reach it
    // would make every one of those true notes a stray — broaden the denylist in the same edit.
    //
    // ⚠️ Kept SAME-CLAUSE tight (no `.` and no newline between subject and verb), and
    // forward-only. A loose window exempts the real sites instead: `CLAUDE.md` states the
    // negation and then recommends `modoki_render_scene` two clauses later, and `contracts.ts`
    // has the two tools' notes adjacent — a 160-character window swallowed both.
    trueOfADifferentSubject: /(render_scene|render_sequence)[^.\n]{0,40}?forces a render/gi,
    owner: 'docs/rendering.md § "The measurement protocol"',
    truth: 'modoki_capture_viewport does NOT force a render — it is webContents.capturePage(), a '
      + 'screenshot of whatever the window last drew. Whether a capture can be STALE is a property '
      + 'of the SURFACE (continuous rAF vs render-on-demand), not of the capture call.',
    citedBy: [
      { file: 'docs/rendering.md', why: 'the owner — states the negation, and carries the measurement' },
      { file: 'CLAUDE.md', why: 'states the negation ("NEITHER … forces a render")' },
      { file: 'docs/plans/ad-video-pipeline-plan.md', why: 'states the negation' },
      { file: 'docs/plans/profiler.md', why: 'quotes the false reason in order to correct it (#1014)' },
      { file: 'engine/tools/modoki-mcp/src/contracts.ts', why: 'the tool note quotes what it used to say' },
      { file: 'engine/packages/modoki/tests/runtime/offscreenCaptureSurface.test.ts', why: 'names the claim it exists to disprove' },
      { file: 'qa/cases/sceneview/render-on-demand-geometry-change.md', why: 'quotes the stale line and tells the runner not to believe it' },
      { file: 'docs/doc-conventions.md', why: 'names it as the worked example of a retracted fact, in the rule it broke' },
      { file: '.agent-memory/renderer-module-edits-need-a-relaunch.md', why: 'records that this memory itself used to assert it (#1014)' },
    ],
  },
  {
    id: 'flexlayout-mounts-only-the-selected-tab',
    // The alternation covers both voices and both directions: the two shapes that historically
    // occurred are not the only ones the next author will reach for, and copy N+1 phrased any
    // other way would be invisible. "the selected tab" is itself tab-specific, so this does not
    // need a separate subject clause.
    pattern: /(mounts|renders) only the selected tab|only the selected tab (is|gets) (mounted|rendered)|only the selected tab (mounts|renders)|unselected tabs? (do|does) not (mount|render)|unselected tabs? (are|is) not (mounted|rendered)/i,
    owner: 'docs/editor.md § "Tab mounting LATCHES"',
    truth: 'Mounting LATCHES. flexlayout-react defers only the FIRST render, and setRendered is '
      + 'only ever written true, so the claim holds solely for a tab never OPENED this session. '
      + 'Selection is not sufficient either: a selected tab in a zero-area tabset does not render.',
    citedBy: [
      { file: 'docs/editor.md', why: 'the owner — quotes the claim in order to bound it' },
      { file: 'docs/doc-conventions.md', why: 'names it as the worked example of a retracted fact, in the rule it broke' },
    ],
  },
];

// `.md` for prose; `.ts`/`.tsx` because the worst offenders were code comments and agent-facing
// strings — and `.mjs`/`.cjs`/`.js` for the same reason, because `engine/scripts/**` and
// `qa/tools/**` carry exactly that kind of prose and are otherwise the half of "agent-facing
// strings" this guard would not reach. Third-party and build output are not ours to police.
const CORPUS = /\.(md|ts|tsx|mjs|cjs|js)$/;
const SKIP = ['node_modules', 'dist', 'release', '.build', 'ios', 'android', 'worktrees'];

// ⚠️ Non-vacuity is checked PER EXTENSION, not as one total. A single number cannot detect the
// most damaging corpus mutation there is: narrowing CORPUS to `/\.(ts|tsx)$/` blinds this guard
// to every markdown copy of both claims and still leaves ~3,000 files, so a `length > 500`
// assertion passes with the prose half of the corpus gone.
//
// ⚠️ Each floor is PER LAYOUT. This file ships in the public engine snapshot, which drops
// `docs/`, `qa/`, `.agent-memory/`, `games/` and the root scripts — measured there at 86 md /
// 2490 ts / 107 js against 729 / 3117 / 187 in a developer clone, so the clone floors went red
// on the public gate. The snapshot floors still sit far above the ~0 a dropped extension leaves.
const PRIVATE = hasPrivateTooling();
const EXT_FLOORS: ReadonlyArray<{ ext: RegExp; min: number; why: string }> = [
  { ext: /\.md$/, min: PRIVATE ? 600 : 50, why: 'prose — where most restatements live' },
  { ext: /\.(ts|tsx)$/, min: PRIVATE ? 2500 : 2000, why: 'code comments and agent-facing strings' },
  { ext: /\.(mjs|cjs|js)$/, min: PRIVATE ? 150 : 70, why: 'scripts and QA tooling — agent-facing prose too' },
];

describe('a retracted claim is not restated outside its owning doc (#1014/#1015)', () => {
  // ⚠️ THIS FILE is excluded structurally, not via a `citedBy` row. It is definitionally the
  // one place every retracted claim must appear in full — that is what a registry IS — and a
  // citedBy row would be a standing permission that a future edit could lean on without
  // anyone noticing. `corpusProducerIsShared.test.ts` draws the same line for repoCorpus.mjs,
  // its own sanctioned caller, and says so: excluded structurally, not via the ledger.
  const SELF = 'engine/tests/architecture/retractedClaims.test.ts';
  const files = repoFiles({ match: CORPUS, exclude: SKIP, floor: 500 })
    .filter((f: { rel: string }) => f.rel !== SELF);

  it.each(EXT_FLOORS)('the corpus still reaches $ext — a vacuous pass is a failure', ({ ext, min, why }) => {
    const n = files.filter((f: { rel: string }) => ext.test(f.rel)).length;
    expect(n, `only ${n} file(s) match ${ext} (${why}) — the corpus lost a whole extension`)
      .toBeGreaterThan(min);
  });

  it('the self-exclusion points at a file that exists — a drifted path silently stops excluding', () => {
    // If this file is renamed and SELF is not updated, the filter removes nothing, this suite
    // reports ITSELF as a stray on every claim, and the obvious "fix" is to add a citedBy row —
    // which is the standing permission the structural exclusion exists to avoid.
    expect(existsSync(path.join(repoRoot(), SELF)), `SELF is stale: ${SELF}`).toBe(true);
  });

  for (const claim of RETRACTED_CLAIMS) {
    describe(claim.id, () => {
      const allowed = new Set(claim.citedBy.map((c) => c.file));
      const restates = (raw: string) => {
        const text = claim.trueOfADifferentSubject
          ? raw.replace(claim.trueOfADifferentSubject, '')
          : raw;
        return claim.pattern.test(text);
      };
      const hits = files
        .filter((f: { abs: string }) => restates(readScannedSource(f.abs, CLAIMS_LIVE_IN_PROSE).raw))
        .map((f: { rel: string }) => f.rel);

      it('no file outside citedBy restates it', () => {
        const strays = hits.filter((rel) => !allowed.has(rel));
        expect(
          strays,
          `these file(s) restate a RETRACTED claim:\n  ${strays.join('\n  ')}\n\n`
          + `THE TRUTH: ${claim.truth}\n`
          + `It is owned by ${claim.owner} — link there instead of restating it.\n`
          + 'If a file legitimately QUOTES the claim (to correct or disprove it), add it to '
          + `citedBy with the reason.`,
        ).toEqual([]);
      });

      it('every citedBy entry still matches — no stale allowance', () => {
        // A row that stopped matching is an allowance covering nothing, and it would keep
        // "permitting" a file that no longer needs permission — the same rot docCitations'
        // retired-doc registry guards against. Files absent from this checkout are skipped:
        // the public snapshot does not carry qa/ or .agent-memory/.
        // ⚠️ Resolve against the REPO ROOT, never process.cwd(). A bare relative existsSync
        // resolves against the cwd vitest happens to have been launched with; from `engine/`
        // it is false for EVERY row, all of them filter out as "absent from this checkout",
        // and this entire rule goes silently vacuous. Measured: it did.
        const dead = claim.citedBy
          .filter((c) => existsSync(path.join(repoRoot(), c.file)))
          .filter((c) => !hits.includes(c.file))
          .map((c) => `${c.file} (${c.why})`);
        expect(
          dead,
          `citedBy entr(ies) that no longer contain the claim — remove them:\n  ${dead.join('\n  ')}`,
        ).toEqual([]);
      });
    });
  }
});
