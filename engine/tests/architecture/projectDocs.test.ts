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

const repoRoot = path.resolve(__dirname, '../../..');
const TEMPLATE = 'engine/templates/starter/CLAUDE.md';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'ios', 'android', 'Pods', 'ads', '.cache', 'build', '.modoki',
]);

function walk(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 10) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else out.push(p);
  }
  return out;
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

/** Filenames that are ABSENT BY DESIGN in some checkouts, so their absence proves nothing.
 *
 *  This exists because the rule ran green here and red in the OSS snapshot: `project.user.json`
 *  is gitignored (it holds per-machine signing + device values), so it is present on a machine
 *  that has built to hardware and missing everywhere else — including CI and the public snapshot.
 *  A doc that mentions it is documenting a real file the reader is expected to create. Keying the
 *  rule on "is it on disk right now" therefore asks a question whose answer depends on the
 *  checkout, which is the one thing a guard must never do. */
const ABSENT_BY_DESIGN = new Set([
  'project.user.json',   // gitignored per-machine config (signing, device ids)
  'project.config.json', // present in every project, but named generically in prose too
]);

/** `.json` filenames a project's doc names on purpose despite their absence. Scoped to the
 *  project, because "this file is gone" is a fact about one doc's sentence, not about the name. */
const ABSENT_ON_PURPOSE: ReadonlyArray<{ project: string; file: string; reason: string }> = [
  {
    project: 'demos/forest-camp',
    file: 'bow.prefab.json',
    reason: 'named in the write-up of what was DELETED when the baked bow replaced the prefab one',
  },
  {
    project: 'demos/forest-camp',
    file: 'White.mat.json',
    reason: 'same sentence — the unique material deleted with the bow prefab',
  },
  {
    project: 'games/sling',
    file: 'Lvl-000N.json',
    reason: 'a filename PATTERN standing for the level series, not a file',
  },
];

describe('project CLAUDE.md cites asset filenames that exist (#195)', () => {
  it('every .json filename named in a project CLAUDE.md exists in that project', () => {
    // Lookbehind excludes a leading `.`/`-`/`/`, so a generic extension written in prose
    // (`.mat.json`, `.scene.json`, `.mcp.json`) is not mistaken for a filename. Without it the
    // rule reports every doc that merely explains the asset naming convention.
    const RE = /(?<![A-Za-z0-9_.\-/])[A-Za-z0-9_][A-Za-z0-9_.-]*\.json(?![A-Za-z0-9])/g;

    const offenders: string[] = [];
    for (const project of projects()) {
      const exempt = new Set(
        ABSENT_ON_PURPOSE.filter((e) => e.project === project).map((e) => e.file),
      );
      const basenames = walk(path.join(repoRoot, project)).map((f) => path.basename(f));
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
      const doc = path.join(repoRoot, project, 'CLAUDE.md');
      const lines = fs.readFileSync(doc, 'utf8').split(/\r?\n/);
      const seen = new Map<string, number[]>();
      lines.forEach((rawLine, i) => {
        const line = blankSpacedNames(rawLine);
        for (const m of line.match(RE) ?? []) {
          if (present.has(m) || exempt.has(m)) continue;
          if (ABSENT_BY_DESIGN.has(m)) continue;
          if (!seen.has(m)) seen.set(m, []);
          seen.get(m)!.push(i + 1);
        }
      });
      for (const [name, at] of [...seen.entries()].sort()) {
        offenders.push(`${project}/CLAUDE.md — "${name}" (lines ${at.join(', ')})`);
      }
    }

    expect(
      offenders,
      'a project CLAUDE.md names a .json file that does not exist in that project. The usual cause '
        + 'is a scene written without its `.scene` infix (`main.json` for `main.scene.json`) — which '
        + 'reads fine but hands an agent a path modoki_load_scene cannot open. If the file is named '
        + 'to say it is GONE, add it to ABSENT_ON_PURPOSE with a reason.',
    ).toEqual([]);
  });

  it('every ABSENT_ON_PURPOSE entry names a file that is still absent', () => {
    const stale = ABSENT_ON_PURPOSE.filter((e) => {
      const present = new Set(walk(path.join(repoRoot, e.project)).map((f) => path.basename(f)));
      return present.has(e.file);
    }).map((e) => `${e.project}: ${e.file} — now exists; drop this entry (${e.reason})`);
    expect(stale, 'ABSENT_ON_PURPOSE has entries that are no longer needed').toEqual([]);
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
describe('root CLAUDE.md enumerates every project (#195)', () => {
  it('every games/ and demos/ project has a table row, and every row a project', (ctx) => {
    // The OSS snapshot ships engine/ + build/ + docs/ + a few root configs — NOT the root
    // CLAUDE.md and NOT games/. So in the snapshot this rule has neither side of its comparison
    // and would ENOENT-crash rather than legitimately pass. Skip explicitly, the way
    // publish-engine-oss.sh reasons about repoLayoutGuard: "this content is absent" is what the
    // snapshot IS, so a rule about that content cannot self-gate there. It still runs on every
    // real clone, which is where the table is edited.
    const rootDoc = path.join(repoRoot, 'CLAUDE.md');
    if (!fs.existsSync(rootDoc)) {
      ctx.skip();
      return;
    }
    const root = fs.readFileSync(rootDoc, 'utf8');
    const linked = new Set<string>();
    for (const m of root.matchAll(/\]\((games|demos)\/([A-Za-z0-9._-]+)\/CLAUDE\.md\)/g)) {
      linked.add(`${m[1]}/${m[2]}`);
    }

    const onDisk = projects();
    const missingRow = onDisk.filter((p) => !linked.has(p));
    const missingProject = [...linked].filter((p) => !onDisk.includes(p)).sort();

    expect(
      { missingRow, missingProject },
      'the root CLAUDE.md project tables disagree with what is on disk. `missingRow` exists but is '
        + 'not listed (an agent will never learn it exists — say plainly if it is a fixture rather '
        + 'than a game); `missingProject` is listed but gone (delete the row).',
    ).toEqual({ missingRow: [], missingProject: [] });
  });
});
