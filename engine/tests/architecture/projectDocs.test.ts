/** Guards on a PROJECT's own `CLAUDE.md` — the file loaded on top of the root one whenever an
 *  agent works inside `games/<id>` or `demos/<id>` (#195).
 *
 *  Why these two rules and not a general "is the doc accurate" wish: both catch a defect that is
 *  INVISIBLE to a reader and fatal to an agent.
 *
 *  1. **A cited asset filename that does not exist.** Every Modoki scene file is
 *     `<name>.scene.json`, and the infix is load-bearing — `modoki_load_scene` takes the full
 *     filename. A doc that writes `main.json` reads perfectly to a human and hands an agent a path
 *     that resolves to nothing. This was not a one-off: an audit found it in two projects, and
 *     this rule found it in EIGHT more the audit had already looked at, which is the argument for
 *     a guard over another read-through.
 *
 *  2. **A CLAUDE.md that is still the scaffolder template.** `scaffold-project.mjs` copies
 *     `engine/templates/starter/CLAUDE.md` and substitutes the project name. If nobody then writes
 *     the real thing, the project ships a doc that describes a generic Modoki project and says
 *     nothing true about THIS one — while looking, to every reader and every reviewer, like a
 *     documented project. `demos/video-demo` sat at 4 differing lines against the template while
 *     every genuinely-written file differs by 30+.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { hasPrivateDocs } from '../helpers/repoLayout';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const repoRoot = path.resolve(__dirname, '../../..');
const TEMPLATE = 'engine/templates/starter/CLAUDE.md';

/** Files under `prefix`, enumerated through GIT rather than by walking the filesystem.
 *
 *  Mirrors `docCitations.test.ts`'s `repoFiles()` and exists for the same reason (ba6aae93): a
 *  hand-maintained skip list cannot win against build output, because `release/` was only the
 *  instance that bit — any gitignored directory holding a copy of the tree does the same, and the
 *  failure is MACHINE-DEPENDENT, so it reads as "the merge broke it".
 *
 *  Here the consequence is worse than a false alarm and points the other way. This list builds the
 *  set of filenames considered PRESENT in a project, so a stray gitignored copy does not add a
 *  false offender — it makes a real one DISAPPEAR. A `main.json` inside some project's ignored
 *  build output would vouch for a doc citing `main.json`, and the guard would report green on
 *  precisely the citation it exists to catch, on whichever machine happened to have built.
 *
 *  `includeUntracked: true` (the default) = tracked plus new-untracked, minus everything
 *  `.gitignore` covers. That half keeps a just-added, not-yet-staged asset counted as present, so
 *  adding a scene and documenting it in one go does not trip the rule. */
function gitFilesUnder(prefix: string): string[] {
  return repoFiles({ under: prefix, floor: 0, includeUntracked: true }).map((f) => f.abs);
}

/** Every `games/<id>` / `demos/<id>` that carries its own CLAUDE.md. */
function projects(): string[] {
  const out: string[] = [];
  for (const container of ['games', 'demos']) {
    const dir = path.join(repoRoot, container);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (fs.existsSync(path.join(dir, e.name, 'CLAUDE.md'))) out.push(`${container}/${e.name}`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ Rule 1 */

/** Lookbehind excludes a leading `.`/`-`/`/`, so a generic extension written in prose
 *  (`.mat.json`, `.scene.json`, `.mcp.json`) is not mistaken for a filename. Without it the
 *  rule reports every doc that merely explains the asset naming convention. */
const CITED_JSON = /(?<![A-Za-z0-9_.\-/])[A-Za-z0-9_][A-Za-z0-9_.-]*\.json(?![A-Za-z0-9])/g;

/** Is `<project>/<name>` a path the REPO's tracked `.gitignore` rules ignore?
 *
 *  ⚠️ **Asked with `-v`, filtered to a `.gitignore` source, and that source must be TRACKED (#1140
 *  close-out review, twice).** `check-ignore --no-index` honours every rule it can find: machine-local
 *  `.git/info/exclude` and `core.excludesFile`, and ANY `.gitignore` on disk — including one a
 *  developer created and never committed. Each of those lets a doc citing a missing file pass on
 *  one machine and fail on every other, a fail-open that depends on the checkout. `-v` names the
 *  deciding pattern's source; a `!negation` match means NOT ignored (and still exits 0 under `-v`). */
function isGitIgnored(
  project: string,
  name: string,
  isTracked: (source: string) => boolean = isTrackedInRepo,
  cwd: string = repoRoot,
): boolean {
  const r = spawnSync('git', ['check-ignore', '-v', '--no-index', '--', `${project}/${name}`], {
    cwd, encoding: 'utf8',
  });
  if (r.status === 1) return false;
  if (r.status !== 0) {
    throw new Error(`git check-ignore failed for ${project}/${name}: status=${r.status} ${r.stderr ?? ''}`);
  }
  const source = gitignoreSourceOf(r.stdout);
  return source !== null && isTracked(source);
}

/** The repo's TRACKED `.gitignore` files, through the shared corpus producer (never a raw
 *  `git ls-files` — `corpusProducerIsShared`). Tracked only: an uncommitted `.gitignore` is exactly
 *  the checkout-dependent source `isGitIgnored` must not trust. Lazy, since most citations are
 *  present and never ask. */
let trackedGitignores: Set<string> | undefined;
function isTrackedInRepo(source: string): boolean {
  trackedGitignores ??= new Set(
    repoFiles({ match: (rel: string) => path.posix.basename(rel) === '.gitignore', includeUntracked: false, floor: 1 })
      .map((f: { rel: string }) => f.rel),
  );
  return trackedGitignores.has(source.split(path.sep).join('/'));
}

/** `git check-ignore -v` output → the repo-relative `.gitignore` whose (non-negated) pattern ignored
 *  the path, or null for a machine-local source, an absolute path, or a negation. Line shape:
 *  `<source>:<line>:<pattern>\t<path>`. Pure, so the synthetic pin runs it; tracked-ness is asked
 *  separately by the caller. */
function gitignoreSourceOf(stdout: string): string | null {
  const m = /^(.*?):\d+:(.*?)\t/.exec(stdout.trim());
  if (!m) return null;
  const [, source, pattern] = m;
  if (pattern.startsWith('!')) return null;
  return !path.isAbsolute(source) && path.basename(source) === '.gitignore' ? source : null;
}

/** Rule 1's classifier over one doc's lines: every cited `.json` name that is neither present in
 *  the project nor a path git ignores, with the lines naming it. Pure over its inputs so the
 *  synthetic pin below runs the real thing.
 *
 *  ⚠️ **"Ignored" replaced two hand-kept lists (#1140), and both were measured first.**
 *  - `ABSENT_BY_DESIGN` pardoned two NAMES repo-wide with no staleness check. `project.config.json`
 *    pardoned nothing (every project has one). `project.user.json` pardoned 8 docs, for a reason
 *    that is exactly a property git already records: it is gitignored, so the enumeration below —
 *    which excludes ignored files ON PURPOSE (a stray build copy must not vouch for a citation) —
 *    can never see it on any machine. Asking git answers that for every per-machine file at once,
 *    rather than for the one somebody remembered to list.
 *  - `ABSENT_ON_PURPOSE` checked each row's file was still absent but never that it was still
 *    CITED — and all three rows (forest-camp's `bow.prefab.json` / `White.mat.json`, sling's
 *    `Lvl-000N.json`) pardoned nothing. A doc naming a file to say it is GONE should write it so
 *    it does not read as a live filename; there is no pardon to reach for. */
function citedJsonOffenders(
  lines: readonly string[],
  basenames: readonly string[],
  isIgnored: (name: string) => boolean,
): Map<string, number[]> {
  const present = new Set(basenames);
  // A filename may contain a SPACE (`2D Animation.scene.json`), which the token regex cannot
  // span without swallowing prose. Handle it by BLANKING every real space-containing name out
  // of the line before tokenizing, so what remains is only text the doc did not spell
  // correctly.
  //
  // ⚠️ The obvious alternative — accept a token that is the TAIL of a real name — is what this
  // replaced, and it silently defeated the rule: `Animation.scene.json` is a tail of
  // `2D Animation.scene.json`, so a citation naming a file that does not exist passed clean
  // (measured: 6/6 green with a fabricated `Animation.scene.json` in 3d-test's doc). The
  // relaxation meant to accommodate one file created a false negative on exactly that file.
  // Blanking asks the right question — "did the doc write the real name?" — instead of the
  // weaker "does the doc's text resemble part of one?".
  const spacedNames = basenames.filter((b) => b.includes(' '));
  const blankSpacedNames = (line: string) => spacedNames.reduce(
    (acc, name) => acc.split(name).join(' '),
    line,
  );
  const seen = new Map<string, number[]>();
  const ignored = new Map<string, boolean>();
  lines.forEach((rawLine, i) => {
    for (const m of blankSpacedNames(rawLine).match(CITED_JSON) ?? []) {
      if (present.has(m)) continue;
      if (!ignored.has(m)) ignored.set(m, isIgnored(m));
      if (ignored.get(m)) continue;
      if (!seen.has(m)) seen.set(m, []);
      seen.get(m)!.push(i + 1);
    }
  });
  return seen;
}

describe('project CLAUDE.md cites asset filenames that exist (#195)', () => {
  it('every .json filename named in a project CLAUDE.md exists in that project', () => {
    const offenders: string[] = [];
    for (const project of projects()) {
      const basenames = gitFilesUnder(project).map((f) => path.basename(f));
      // Vacuous-pass floor, per the same reasoning ba6aae93 added to docCitations: this rule
      // reports an offender only when a cited name is MISSING from `basenames`, so an enumeration
      // that returned nothing would make every citation look absent. A broken `git ls-files`
      // (wrong cwd, a flag that stops matching) must fail loudly rather than report green. Every
      // project has at least a CLAUDE.md and a project.config.json.
      expect(basenames.length, `${project}: git enumeration returned no files`).toBeGreaterThan(1);
      const lines = fs.readFileSync(path.join(repoRoot, project, 'CLAUDE.md'), 'utf8').split(/\r?\n/);
      const seen = citedJsonOffenders(lines, basenames, (name) => isGitIgnored(project, name));
      for (const [name, at] of [...seen.entries()].sort()) {
        offenders.push(`${project}/CLAUDE.md — "${name}" (lines ${at.join(', ')})`);
      }
    }

    expect(
      offenders,
      'a project CLAUDE.md names a .json file that does not exist in that project. The usual cause '
        + 'is a scene written without its `.scene` infix (`main.json` for `main.scene.json`) — which '
        + 'reads fine but hands an agent a path modoki_load_scene cannot open. If the file is named '
        + 'to say it is GONE, write it so it does not read as a live filename (no pardon list).',
    ).toEqual([]);
  });

  it('the classifier flags a missing name, and passes present, spaced and gitignored ones', () => {
    // The clean tree has no offenders, so it cannot tell a working classifier from a dead one.
    const lines = [
      'Open main.json first.',                        // missing — the .scene infix dropped
      'Then main.scene.json and 2D Animation.scene.json.',
      'A fabricated Animation.scene.json tail.',      // missing — tail of a spaced name
      'Signing lives in project.user.json.',          // gitignored
      'The .mat.json convention is prose.',           // generic extension, not a name
    ];
    const basenames = ['main.scene.json', '2D Animation.scene.json', 'CLAUDE.md'];
    const seen = citedJsonOffenders(lines, basenames, (n) => n === 'project.user.json');
    expect([...seen.entries()].sort()).toEqual([['Animation.scene.json', [3]], ['main.json', [1]]]);
  });

  it('asks git, and git really ignores the per-machine file (the premise of the classifier)', () => {
    // A hypothetical project path on purpose: `--no-index` answers from the tracked ignore rules
    // alone, so the premise holds on every checkout — including one that ships no project at all,
    // which is why this needs no presence gate.
    expect(isGitIgnored('games/any-project', 'project.user.json')).toBe(true);
    expect(isGitIgnored('games/any-project', 'CLAUDE.md')).toBe(false);
  });

  it('only a repo .gitignore counts — a machine-local exclude, an absolute path or a negation does not', () => {
    expect(gitignoreSourceOf('.gitignore:152:project.user.json\tgames/x/project.user.json\n')).toBe('.gitignore');
    expect(gitignoreSourceOf('games/x/.gitignore:3:*.local.json\tgames/x/a.local.json\n')).toBe('games/x/.gitignore');
    expect(gitignoreSourceOf('.git/info/exclude:7:main.json\tgames/x/main.json\n')).toBeNull();
    expect(gitignoreSourceOf('/Users/me/.config/git/ignore:1:main.json\tgames/x/main.json\n')).toBeNull();
    // `core.excludesFile=~/.gitignore` — git expands it, so basename alone would accept it.
    expect(gitignoreSourceOf('/Users/me/.gitignore:1:main.json\tgames/x/main.json\n')).toBeNull();
    expect(gitignoreSourceOf('.gitignore:9:!keep.json\tgames/x/keep.json\n')).toBeNull();
  });

  it('an UNTRACKED .gitignore pardons nothing, and the same file once tracked does', () => {
    // A throwaway repo, never the real tree: a directory written under games/ mid-suite would be
    // seen by every concurrent corpus scan and by a live editor watching the project roots.
    // Tracked-ness is injected (the real one reads the repo's corpus), so both sides are driven
    // through the same check-ignore call and source filter production uses.
    const dir = makeScratchDir('projectdocs-ignore-');
    try {
      spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
      fs.mkdirSync(path.join(dir, 'games', 'p'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'games', 'p', '.gitignore'), 'phantom.json\n');
      const none = new Set<string>();
      const tracked = new Set(['games/p/.gitignore']);
      expect(isGitIgnored('games/p', 'phantom.json', (s) => none.has(s), dir), 'untracked').toBe(false);
      expect(isGitIgnored('games/p', 'phantom.json', (s) => tracked.has(s), dir), 'tracked').toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the real tracked set holds the root .gitignore (the premise the per-machine file rests on)', () => {
    expect(isTrackedInRepo('.gitignore')).toBe(true);
  });
});

/* ------------------------------------------------------------------ Rule 2 */

/** Lines that must be NEW relative to the template before a project's doc counts as written.
 *
 *  Measured across all 21 project docs (2026-08-11), and the distribution has a cliff rather than
 *  a gradient — which is what makes a threshold honest here rather than arbitrary:
 *
 *      2, 2, 3, 5, 11   │   34, 35, 37, 38, 43, 45, 45, 46, 60, 70, 101, 132, 249, 263, 467, 1015
 *      still the template │ somebody wrote it
 *
 *  15 sits in the empty middle. Note the metric counts only lines the author ADDED, not lines they
 *  deleted from the template — "did somebody write something about THIS project", not "is it
 *  thorough" and not "how far from the template did it travel". */
const MIN_TEMPLATE_DRIFT_LINES = 15;

/** Compare with identifiers masked, so substituting the project name everywhere cannot be
 *  mistaken for having written anything.
 *
 *  ⚠️ `\r` is stripped FIRST, and that is load-bearing rather than tidy. `\r` survives the
 *  identifier mask (it is not in `[A-Za-z0-9_-]`), so a CRLF-saved doc matches NO template line,
 *  drift inflates to the whole file, and a doc that is byte-for-byte the unedited template sails
 *  past the threshold. Measured: converting the starter template to CRLF and dropping it in as a
 *  project's CLAUDE.md passed 6/6 before this. That is a total false negative on the rule's entire
 *  purpose, and it is the Windows-only path class CLAUDE.md warns about — this repo has a `win`
 *  clone, so a project doc re-saved there would ship the stock template silently. */
function maskedLines(file: string): string[] {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/[A-Za-z0-9_-]+/g, 'X'));
}

function driftFromTemplate(projectDoc: string): number {
  const tpl = maskedLines(path.join(repoRoot, TEMPLATE));
  const doc = maskedLines(projectDoc);
  const tplCounts = new Map<string, number>();
  for (const l of tpl) tplCounts.set(l, (tplCounts.get(l) ?? 0) + 1);
  let differing = 0;
  for (const l of doc) {
    const n = tplCounts.get(l) ?? 0;
    if (n > 0) tplCounts.set(l, n - 1);
    else differing += 1;
  }
  return differing;
}

describe('project CLAUDE.md is written, not left as the scaffolder template (#195)', () => {
  it('every project CLAUDE.md differs substantially from engine/templates/starter/CLAUDE.md', () => {
    const offenders = projects()
      .map((p) => ({ p, drift: driftFromTemplate(path.join(repoRoot, p, 'CLAUDE.md')) }))
      .filter((r) => r.drift < MIN_TEMPLATE_DRIFT_LINES)
      .map((r) => `${r.p}/CLAUDE.md — only ${r.drift} line(s) differ from the template`);

    expect(
      offenders,
      'this project ships the scaffolder template with the name substituted. It reads like a '
        + 'documented project and says nothing true about THIS one — describe its scenes, its custom '
        + 'traits/actions and their gotchas, and anything an agent would otherwise have to infer.',
    ).toEqual([]);
  });

  it('the starter template is not itself counted as a project', () => {
    // engine/templates/starter IS the template, so it trivially fails the drift rule. It lives
    // outside games/ and demos/ and so is not enumerated — assert that, rather than leaving the
    // exclusion to the accident of where projects() looks.
    expect(projects()).not.toContain('engine/templates/starter');
  });

  it('the template itself still exists (the rule is vacuous without it)', () => {
    // A guard that silently passes when its reference file moves is worse than no guard: this
    // one would report every project as "written" the moment the template is renamed.
    expect(fs.existsSync(path.join(repoRoot, TEMPLATE)), `${TEMPLATE} is missing`).toBe(true);
  });
});

/* ------------------------------------------------------------------ Rule 3 */

/** The root CLAUDE.md's `games/` and `demos/` tables must enumerate every project, and only real
 *  ones (#195).
 *
 *  The table is how an agent learns what exists — it is read long before anyone runs `ls`. It had
 *  drifted three projects behind the disk (`anim-bug`, `ota-test`, `ota-subgame-test`), and one of
 *  those is the committed OTA device-verification fixture that `docs/ota-updates.md` treats as
 *  load-bearing. Drift in the other direction is just as bad and just as quiet: a project deleted
 *  upstream leaves a row pointing at a directory that is gone.
 *
 *  Rows are matched by the LINK TARGET (`](games/<id>/CLAUDE.md)`), not the label, so renaming a
 *  row's display text cannot fool the check. */
describe('docs/projects.md enumerates every project (#195)', () => {
  it('every games/ and demos/ project has a table row, and every row a project', (ctx) => {
    // The roster MOVED out of root CLAUDE.md into docs/projects.md: it is a catalog, not a rule,
    // and CLAUDE.md is loaded on every turn (see claudeMdBudget.test.ts). The guard follows the
    // fact — what it protects is unchanged, namely that a project on disk is DISCOVERABLE from
    // the docs an agent reads, so a fixture cannot go undocumented the way three once did.
    //
    // The OSS snapshot ships engine/ + build/ + docs/ + a few root configs — but NOT games/, and
    // docs/projects.md is explicitly excluded from it too (publish-engine-oss.sh), because it
    // describes internal projects. So in the snapshot this rule has neither side of its
    // comparison and would ENOENT-crash rather than legitimately pass. Skip explicitly, the way
    // publish-engine-oss.sh reasons about repoLayoutGuard: "this content is absent" is what the
    // snapshot IS, so a rule about that content cannot self-gate there. It still runs on every
    // real clone, which is where the table is edited.
    //
    // Gated on `hasPrivateDocs()`, not on this doc's own existence (#1071): a predicate that reads
    // a different excluded doc means a rename of projects.md lands as a RED read below instead of
    // switching this guard off in every clone.
    if (!hasPrivateDocs()) {
      ctx.skip();
      return;
    }
    const rosterDoc = path.join(repoRoot, 'docs/projects.md');
    const roster = fs.readFileSync(rosterDoc, 'utf8');
    const linked = new Set<string>();
    // Paths are written relative to docs/, i.e. `../games/<id>/CLAUDE.md`.
    for (const m of roster.matchAll(/\]\(\.\.\/(games|demos)\/([A-Za-z0-9._-]+)\/CLAUDE\.md\)/g)) {
      linked.add(`${m[1]}/${m[2]}`);
    }

    const onDisk = projects();
    const missingRow = onDisk.filter((p) => !linked.has(p));
    const missingProject = [...linked].filter((p) => !onDisk.includes(p)).sort();

    expect(
      { missingRow, missingProject },
      'the docs/projects.md roster disagrees with what is on disk. `missingRow` exists but is '
        + 'not listed (an agent will never learn it exists — say plainly if it is a fixture rather '
        + 'than a game); `missingProject` is listed but gone (delete the row).',
    ).toEqual({ missingRow: [], missingProject: [] });
  });
});
