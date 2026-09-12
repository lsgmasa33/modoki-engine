/** The clone → editor-backend-port table has ONE authored home, and the docs match it (#349).
 *
 *  `engine/scripts/editorPorts.mjs` is that home. Before it, the same five-row table was
 *  copy-pasted into `launch-editor.sh` (as a bare `5179` default), `relaunch-editor.sh` (as a
 *  branch `case`), `package.json` (two hardcoded pins) and `.mcp.json`. Two of those four had
 *  ALREADY drifted by the time anyone looked:
 *
 *    - `relaunch-editor.sh` mapped `work-ai` and `work-ai2` and stopped there, so `work-ai3`
 *      and `work-qa` fell through to the `*)` arm — 5179, the HUB's port. Its own comment said
 *      "Must list EVERY worker branch: an unlisted one falls through to 5179, which is the MAIN
 *      clone's backend port". The comment was right, was read, and did not stop the drift.
 *    - `clonePortHardcoding.test.ts`'s own CLONE_PORTS list stopped at three clones while five
 *      existed, so it could not have caught either.
 *
 *  That is why this is a TEST and not a sixth comment. It asserts two things a comment cannot:
 *  that the docs still say what the code says, and that nobody has re-introduced a literal
 *  hub-port default in a file every clone reads.
 *
 *  Why it matters more than a normal config drift: the backend port is the MCP target. A worker
 *  clone that resolves 5179 while the hub's editor is up does not fail — every `modoki_*` call
 *  SUCCEEDS against the hub's checkout. Measured in `~/.modoki/editor-launches.log`: three
 *  worker-clone launches landed on 5179, one (modoki-qa, 2026-08-25) with a live hub editor. */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { hasPrivateDocs, hasQaSuite } from '../helpers/repoLayout';
import { readScannedSource } from '@modoki/engine/testing';
import {
  CLONE_BACKEND_PORTS,
  HUB_BACKEND_PORT,
  backendPortForClone,
  vitePortForBackend,
  cdpPortForBackend,
  editorCdpPortForBackend,
  backendUrlForClone,
} from '../../scripts/editorPorts.mjs';
import { pathCaseKey } from '../../scripts/pathIdentity.mjs';
import { makeDirLink, cloneRootSpellings } from '../helpers/linkFixture';
import { clonePort, defaultRepoRoot } from '../../scripts/clonePort.mjs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

/** Mirrors `pathIdentity.mjs`'s own platform test. Asked of the module rather than re-derived,
 *  so this file cannot drift from the rule it is pinning. */
const CASE_INSENSITIVE_FS = pathCaseKey('A') === 'a';

const REPO = path.resolve(__dirname, '../../..');
/**
 * A documentation file, read as PROSE (#812).
 *
 * Every read in this guard is a `.md` doc — it compares the port TABLES humans read against the
 * authored table in code, which it imports directly rather than scanning. So there is no code
 * scan here to strip, and Markdown carries no comment syntax a scan could be blinded by.
 */
const readDoc = (rel: string) => readScannedSource(path.join(REPO, rel), {
  comments: 'include',
  reason: 'the assertions are about the port TABLES written in this doc — prose is the subject',
}).raw;
// ⚠️ There is no file-presence gate in this file any more, and the history is worth keeping (#1084).
// Every block below USED to skip on `!hasPrivateTooling()` — `.mcp.json exists` — a PROXY for "this
// is a developer clone". The reason written beside it was false: it claimed the public snapshot
// ships no `engine/scripts/**`, but the manifest is `git ls-files -- engine` with no exclusion under
// `engine/scripts/`, so `editorPorts.mjs`, `launch-editor.sh` and `lib/repo-reap.sh` all DO ship.
// The proxy nevertheless skipped all four blocks on the public 3-OS leg — including on WINDOWS,
// where this file's subject (path spelling, #961) is most likely to differ.
//
// So each block now gates on what it READS, per `helpers/repoLayout.ts`'s own rule and #1071's
// precedent: the three that read only shipped `engine/scripts/**` + `package.json` run everywhere,
// and only the doc-table block gates. Since #1102 that block reads `qa/` as well, so its gate is
// `hasPrivateDocs()` AND `hasQaSuite()` — two predicates because the snapshot drops the two by
// different mechanisms: `docs/clones-and-ports.md` is an explicit exclusion, while `qa/` is simply
// not among the roots `publish-engine-oss.sh` stages.

/** Every `| ~/Projects/<dir> … | <port> |` row of a markdown table, as dir → first port cell.
 *  Both CLAUDE.md § Clones and docs/clones-and-ports.md § RULE 2 use this shape; the port is
 *  the first cell after the directory that is a bare 4-digit number (CLAUDE.md puts the branch
 *  in between, and the doc writes main's as `5179 (default)`). */
function portsFromMarkdownTable(src: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of src.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const dir = /~\/Projects\/([A-Za-z0-9._-]+)/.exec(line)?.[1];
    if (!dir) continue;
    const cells = line.split('|').map((c) => c.trim());
    const dirCell = cells.findIndex((c) => c.includes(`~/Projects/${dir}`));
    for (const cell of cells.slice(dirCell + 1)) {
      const m = /^(\d{4})\b/.exec(cell.replace(/`/g, ''));
      if (m) {
        out[dir] = Number(m[1]);
        break;
      }
    }
  }
  return out;
}

describe('editorPorts.mjs is the one home for the clone → backend port table (#349)', () => {
  it('resolves each known clone directory to its pinned port', () => {
    expect(backendPortForClone('/Users/someone/Projects/modoki')).toBe(5179);
    expect(backendPortForClone('/Users/someone/Projects/modoki-ai')).toBe(5180);
    expect(backendPortForClone('/Users/someone/Projects/modoki-ai2')).toBe(5181);
    expect(backendPortForClone('/Users/someone/Projects/modoki-ai3')).toBe(5182);
    expect(backendPortForClone('/Users/someone/Projects/modoki-qa')).toBe(5183);
  });

  it('resolves an UNKNOWN clone to null (auto ports), never to a pinned lane', () => {
    // The whole bug in one assertion. Any non-null fallback here is correct on exactly one
    // clone and silently wrong on the rest — and `bugfix-qa` in the launch log proves scratch
    // clones are a real thing people make, so refusing outright would be wrong too.
    expect(backendPortForClone('/Users/someone/Projects/bugfix-qa')).toBeNull();
    expect(backendPortForClone('/tmp/throwaway')).toBeNull();
    expect(backendUrlForClone('/tmp/throwaway')).toBeNull();
  });

  it('does not resolve on a PREFIX or SUFFIX of a known clone name', () => {
    // `basename` equality, not `startsWith` — `modoki-ai-scratch` is somebody's scratch clone,
    // not work-ai's lane, and a sloppy match would hand it a live sibling's MCP target.
    expect(backendPortForClone('/Users/someone/Projects/modoki-ai-scratch')).toBeNull();
    expect(backendPortForClone('/Users/someone/Projects/my-modoki')).toBeNull();
    expect(backendPortForClone('/Users/someone/Projects/modoki-ai4')).toBeNull();
  });

  it('ignores a trailing separator, so a caller passing `${REPO}/` is not silently unknown', () => {
    expect(backendPortForClone('/Users/someone/Projects/modoki-ai/')).toBe(5180);
  });

  it('no two clone names fold to one case key (#881)', () => {
    // The fallback map in `editorPorts.mjs` is a `Map` keyed by `pathCaseKey`, so two table names
    // differing only in case would collapse and silently drop a clone onto auto ports.
    //
    // ⚠️ This lives HERE and not as a module-load `throw` in the source, which is what #881 first
    // wrote. That throw fired only on case-INSENSITIVE platforms — so the Linux CI leg would stay
    // green on the exact edit that broke every Mac clone — and it would take down `modoki-mcp`,
    // which imports that module, instead of degrading one clone. This assertion fires on every
    // platform, at the moment the table is edited, with no blast radius.
    const folded = new Set(Object.keys(CLONE_BACKEND_PORTS).map((n) => pathCaseKey(n)));
    expect(folded.size).toBe(Object.keys(CLONE_BACKEND_PORTS).length);
    // Non-vacuity: the check must be capable of failing. Two names that DO collide must collapse.
    expect(new Set(['modoki-qa', 'MODOKI-QA'].map((n) => pathCaseKey(n))).size)
      .toBe(CASE_INSENSITIVE_FS ? 1 : 2);
  });

  /** #881 — the anchor. A case-flipped clone directory found NO pinned port and fell through to
   *  auto ports, which is #349 wearing a different cause: the editor comes up somewhere no sibling
   *  expects and every `MODOKI_BACKEND` aimed at this clone drives a different one.
   *
   *  ⚠️ Two independent halves, and each needs its own case because either alone leaves the bug:
   *  `canonicalPath` repairs the spelling only where the directory EXISTS (`.native` throws
   *  otherwise), and `pathCaseKey` carries every path that does not. The second is not
   *  hypothetical — the scaffolder asks for a port before the directory is created. */
  describe('a case-flipped clone directory still finds its pinned port (#881)', () => {
    it('folds a name whose directory does NOT exist — the half realpath cannot reach', () => {
      // No stat can succeed here, so this passes only via `pathCaseKey`.
      expect(existsSync('/nonexistent-for-tests/MODOKI-QA')).toBe(false);
      expect(backendPortForClone('/nonexistent-for-tests/MODOKI-QA'))
        .toBe(CASE_INSENSITIVE_FS ? 5183 : null);
      expect(backendPortForClone('/nonexistent-for-tests/Modoki-AI2'))
        .toBe(CASE_INSENSITIVE_FS ? 5181 : null);
    });

    it('resolves a real directory reached by a case-flipped spelling', () => {
      // On a case-insensitive volume the flipped spelling opens the SAME directory, so `.native`
      // hands back the on-disk name and the exact lookup hits without needing the fold at all.
      const base = mkdtempSync(path.join(tmpdir(), 'modoki-ports-'));
      try {
        const real = path.join(base, 'modoki-ai3');
        mkdirSync(real);
        expect(backendPortForClone(real)).toBe(5182);
        const flipped = path.join(base, 'MODOKI-AI3');
        expect(backendPortForClone(flipped)).toBe(CASE_INSENSITIVE_FS ? 5182 : null);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('resolves a clone reached through a SYMLINK — the half the case-fold cannot reach', (ctx) => {
      // ⚠️ This case exists because the other two do NOT discriminate `canonicalPath` from a bare
      // `path.resolve` on a case-insensitive volume: the fold alone already carries them, so
      // reverting the canonicalisation leaves them green. Here the link's own basename is not a
      // clone name in any casing, so only resolving the link finds the port. It is the closest a
      // non-Windows machine can get to the `subst`/junction cases that motivated `.native`.
      const base = mkdtempSync(path.join(tmpdir(), 'modoki-ports-'));
      try {
        const real = path.join(base, 'modoki-qa');
        mkdirSync(real);
        const link = path.join(base, 'some-other-name');
        try {
          makeDirLink(real, link);
        } catch {
          // SKIP loudly, never a silent `return` — this is the only case that discriminates
          // `canonicalPath` from `path.resolve`, so a quiet pass here is a vacuous green on
          // exactly the platform (#881 is a Windows defect) where it would matter most.
          ctx.skip('cannot create a directory symlink here (needs a privilege this machine lacks)');
          return;
        }
        expect(backendPortForClone(link)).toBe(5183);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('still refuses an unknown clone whatever its case — the fold must not widen the table', () => {
      // The accept side above is only half the claim. A fold that made every directory match
      // something would be a worse bug than the one being fixed.
      expect(backendPortForClone('/nonexistent-for-tests/MY-MODOKI')).toBeNull();
      expect(backendPortForClone('/nonexistent-for-tests/MODOKI-AI4')).toBeNull();
      expect(backendPortForClone('/nonexistent-for-tests/MODOKI-AI-SCRATCH')).toBeNull();
    });
  });

  it('derives Vite and CDP from the backend port the way the launcher does', () => {
    // Mirrors launch-editor.sh's DERIVED_VITE / DERIVED arithmetic. Duplicated there in bash
    // (it cannot import this), so pin the formula on both sides of the seam.
    expect(vitePortForBackend(HUB_BACKEND_PORT)).toBe(5173);
    expect(cdpPortForBackend(HUB_BACKEND_PORT)).toBe(9222);
    expect(vitePortForBackend(5183)).toBe(5177);
    expect(cdpPortForBackend(5183)).toBe(9226);
  });

  it('assigns every clone a DISTINCT port — the entire point of the table', () => {
    const ports = Object.values(CLONE_BACKEND_PORTS);
    expect(new Set(ports).size).toBe(ports.length);
  });
});

/** #961 — WHICH SPELLING the launcher hands the port derivations.
 *
 *  ⚠️ **The pinned table was never at risk, and this suite already proves it**: "resolves a clone
 *  reached through a SYMLINK" above pins `backendPortForClone(<link named something else>)` at
 *  5183. That is the exact case #961 was filed as blocked on, and it has passed since #881. The
 *  issue's stated risk — that exporting a physical `$REPO` would drop a symlinked clone onto auto
 *  ports — is refuted by that test, not merely by argument.
 *
 *  What #961 actually fixes is the HASHED lane, and in the opposite direction from the fear:
 *  `clonePort.mjs` hashes `repoRoot` raw, while its own `defaultRepoRoot()` is already physical
 *  (Node realpaths `import.meta.url`). So a launcher passing bash's LOGICAL `pwd` disagreed with
 *  every other caller of the same hash. */
describe('launch-editor.sh hands the port derivation the PHYSICAL spelling (#961)', () => {
  const LAUNCHER = path.join(REPO, 'engine/scripts/launch-editor.sh');
  const REAP_LIB = path.join(REPO, 'engine/scripts/lib/repo-reap.sh');

  it('builds its reap patterns from the LOGICAL root, so reap_alt_pattern can derive the other spelling', () => {
    // ⚠️ The case the first version of #961 got WRONG, and the reason this is an INTEGRATION
    // assertion rather than another `toMatch` on the source: `reap_alt_pattern`'s precondition is
    // `case "$1" in "${MODOKI_REAP_ROOT}"/*)`, so a pattern built from the PHYSICAL $REPO fails
    // the prefix test against a logical registered root, prints nothing, and the second reap is
    // silently skipped. An editor still running with the logical spelling in its argv then
    // survives the pre-launch sweep, keeps the pinned backend port, and the launch times out.
    // A source-shape guard cannot see that — both spellings are `$REPO`-ish strings — so this
    // drives the real helper with the launcher's own operand pair.
    const { code: src } = readScannedSource(LAUNCHER);
    const patterns = [...src.matchAll(/kill_repo_process "([^"]+)"/g)].map((m) => m[1]);
    expect(patterns.length, 'no kill_repo_process patterns found — fix the parser, not the test')
      .toBeGreaterThan(0);

    const base = mkdtempSync(path.join(tmpdir(), 'modoki-reap-'));
    try {
      const real = path.join(base, 'clone');
      mkdirSync(real);
      const link = path.join(base, 'other-name');
      try { makeDirLink(real, link); } catch { return; }   // no privilege: the case below is moot
      const { logical, physical } = cloneRootSpellings(link);
      if (logical === physical) return;                    // nothing to derive on this host

      for (const pat of patterns) {
        // Substitute the launcher's own variables the way the shell would.
        const built = pat.replace('$REPO_LOGICAL', logical).replace('$REPO', physical);
        const alt = execFileSync('bash', ['-c',
          `. ${JSON.stringify(REAP_LIB)}\nreap_repo_register_roots "$1" "$2"\nreap_alt_pattern "$3"`,
          '_', logical, physical, built], { encoding: 'utf8' });
        expect(alt, `'${pat}' yields no alternate spelling — the second reap is dead for it`)
          .not.toBe('');
        expect(alt).not.toBe(built);                       // and it is genuinely the OTHER one
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('derives $REPO with `pwd -P`, not bash\'s logical `pwd`', () => {
    const { code: src } = readScannedSource(LAUNCHER);
    // The assignment itself, not merely "the file mentions pwd -P somewhere".
    expect(src).toMatch(/^REPO="\$\(cd "\$\(dirname "\$0"\)\/\.\.\/\.\." && pwd -P\)"$/m);
    expect(src).toMatch(/^REPO_LOGICAL="\$\(cd "\$\(dirname "\$0"\)\/\.\.\/\.\." && pwd\)"$/m);
    // ⚠️ Order matters and is invisible at the call: reap_repo_register_roots takes
    // (logical, physical). Passing them the wrong way round still "registers two roots" and
    // silently inverts which spelling the alternate reap builds.
    expect(src).toMatch(/reap_repo_register_roots "\$REPO_LOGICAL" "\$REPO"/);
    // The old variable must be gone, not merely unused — a stale `$REPO_PHYS` under `set -u`
    // would abort the launch, and under a future edit would silently re-register the pair wrong.
    expect(src).not.toMatch(/REPO_PHYS/);
  });

  /** The port the LAUNCHER really lands on for a given `$REPO`, driven through the seam production
   *  actually uses: `launch-editor.sh` hands the string to `node` as an ARGV TOKEN, and on Windows
   *  MSYS rewrites the drive in transit (`/e/Projects/modoki` → `E:/Projects/modoki`).
   *
   *  ⚠️ Hashing bash's string in-process — which this case did until the `win` clone ran it —
   *  skips that rewrite and asks a question the launcher never asks. It agreed with the product on
   *  macOS, where the two spellings are byte-identical, and disagreed with it on Windows for a
   *  reason that had nothing to do with the property under test. Re-typing the product's own
   *  normalisation here instead would be worse still: the test would assert its own copy of the
   *  fix, and `clonePort` could lose it and stay green. */
  const launchedPortFor = (bashRoot: string): number => Number(execFileSync(
    'bash',
    ['-c', 'node "$1/engine/scripts/editorPorts.mjs" cdp-unpinned "$1"', '_', bashRoot],
    { encoding: 'utf8' },
  ).trim());

  it('makes the launcher AGREE with clonePort.defaultRepoRoot() through a symlinked clone', (ctx) => {
    // The behavioural half. `cloneRootSpellings` runs the same `pwd` / `pwd -P` pair the shell
    // scripts do, so this drives the real derivation rather than a re-typed copy of it.
    // ⚠️ Draw the fixture until the two spellings hash DIFFERENTLY. `clonePort` is a hash mod 40,
    // so a random `mkdtemp` path collides with any given slot about 1 run in 40 — and a colliding
    // fixture makes the real assertion below pass under the revert-to-logical-`pwd` mutation, i.e.
    // a SILENT 2.5% false green. (The first fix for that swapped the flake for exactly this,
    // by moving the control onto unrelated literals: it stopped going red for nothing and stopped
    // being able to fail.) Bounded, and a loop that ran out would fail loudly rather than skip.
    let base = '', link = '', logical = '', physical = '';
    let drew = 0;
    for (; drew < 12; drew++) {
      base = mkdtempSync(path.join(tmpdir(), 'modoki-961-'));
      link = path.join(base, 'a-different-name');
      try { makeDirLink(REPO, link); }
      catch { rmSync(base, { recursive: true, force: true }); ctx.skip('cannot create a directory symlink here'); return; }
      ({ logical, physical } = cloneRootSpellings(link));
      if (logical !== physical && launchedPortFor(logical) !== launchedPortFor(physical)) break;
      rmSync(base, { recursive: true, force: true });
    }
    expect(drew, 'could not draw a fixture whose two spellings hash apart — investigate, do not skip')
      .toBeLessThan(12);
    try {
      expect(logical).not.toBe(physical);        // the fixture is doing its job

      // ⚠️ Run the launcher's OWN assignment, lifted from the file, with `$0` bound to the linked
      // path — rather than re-typing `pwd -P` here. A test that retypes the expression asserts its
      // own copy: reverting the script to logical `pwd` would leave it green, which is exactly
      // what happened to the first draft of this case.
      const repoLine = readScannedSource(LAUNCHER).code.split('\n').find((l) => l.startsWith('REPO='));
      expect(repoLine, 'no REPO= assignment found in launch-editor.sh').toBeTruthy();
      const asLaunched = execFileSync('bash',
        ['-c', `${repoLine}\nprintf %s "$REPO"`, path.join(link, 'engine/scripts/launch-editor.sh')],
        { encoding: 'utf8' });
      expect(asLaunched).toBe(physical);

      const canonical = clonePort(defaultRepoRoot(), 9240, 40);
      // What the launcher passes NOW: physical → the same port every other caller derives.
      expect(launchedPortFor(asLaunched)).toBe(canonical);
      expect(launchedPortFor(physical)).toBe(canonical);

      // The control, on the FIXTURE's own two spellings — which the loop above guaranteed hash
      // apart, so this is deterministic rather than a 1-in-40 coin flip in either direction.
      //
      // ⚠️ It does NOT do what its previous comment claimed. It said this line is "what makes the
      // assertion above able to FAIL", and that credit belongs to `expect(asLaunched).toBe(physical)`
      // above: revert the launcher to logical `pwd` and THAT goes red first, before any port is
      // derived. Given the draw loop's exit condition, this line is very nearly tautological. It is
      // kept because it states the property in the units the bug was measured in — a port — and a
      // future edit that makes the two spellings converge (resolving symlinks, say) reddens here.
      expect(launchedPortFor(logical)).not.toBe(canonical);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// Gated on what it READS: `CLAUDE.md` is not in the snapshot manifest, and `docs/clones-and-ports.md`
// is a private doc since #907 — so the snapshot carries neither, whatever `.mcp.json` says.
/** Strip fenced code blocks. A doc TEACHING the row shape shows a counter-example, and #1102 added
 *  exactly that prose to `qa/knowledge.md` § 1 and `docs/clones-and-ports.md` § RULE 2 — so the
 *  next author to illustrate a WRONG table would have turned this guard red with a message telling
 *  them to fix a table that is deliberately wrong and is not a copy of anything. */
function withoutFencedBlocks(src: string): string {
  return src.replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, '');
}

/**
 * The clone directories a markdown TEXT maps to ports in a table. Pure, so it can be tested
 * against fixtures — `layoutConditionalTestLedger.test.ts`'s header states the reason: "a detector
 * with no fixtures of its own is how the first version missed three spellings (#1071)". The
 * corpus-reading wrapper below has no fixtures by construction.
 */
export function clonePortDirsIn(src: string): Set<string> {
  // ⚠️ Port-SHAPED, deliberately not "one of the ports we know" — caught by mutating the guard,
  // not by writing it. The first version matched a row only if it ALREADY carried a correct port,
  // which made the detector blind to precisely the copy that matters: a doc tabling
  // `~/Projects/modoki-qa | 5199` was invisible, so a table handing a human the WRONG lane escaped
  // while one that agreed with the code was policed — an inversion of #349's whole point.
  // 5xxx/9xxx are the two families this table uses, which stops a four-digit YEAR reading as a port.
  const portish = (line: string) => /(^|[^0-9.])(5\d{3}|9\d{3})\b/.test(line);

  // ⚠️ The clone must be the row's KEY CELL, not merely somewhere in the line. `modoki` appears
  // mid-sentence in plenty of table cells — `docs/reviews/2026-07-30-mcp-tool-audit.md:18` has
  // `engine/packages/modoki test | 443 files · 5389 passed`, a clone name and a 5xxx number in one
  // row that is not a port table at all. Keying on the cell excludes it without a ledger entry.
  // Backticks, bold and a trailing `(main)` / `(work-ai)` parenthetical are all stripped, and both
  // the bare name and the `~/Projects/` spelling count — a copy written EITHER way must be seen,
  // because catching the bare-name shape is what makes the parser-mismatch assertion possible.
  const isKeyCell = (cell: string, dir: string) => {
    const t = cell.replace(/[`*]/g, '').replace(/\([^)]*\)/g, '').trim();
    return t === dir || t === `~/Projects/${dir}`;
  };

  const dirs = new Set<string>();
  for (const line of withoutFencedBlocks(src).split('\n')) {
    if (!line.trimStart().startsWith('|') || !portish(line)) continue;
    const cells = line.split('|');
    for (const dir of Object.keys(CLONE_BACKEND_PORTS)) {
      if (cells.some((c) => isKeyCell(c, dir))) dirs.add(dir);
    }
  }
  return dirs;
}

function docsWithClonePortTable(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  // Through `repoFiles()`, never a direct `git ls-files` — `corpusProducerIsShared.test.ts`. Its
  // mandatory `floor` is the corpus-level non-vacuity check: an enumeration that silently returned
  // nothing would make every assertion below pass over an empty set, so the producer refuses.
  for (const { rel } of repoFiles({ match: /\.md$/, floor: 400 })) {
    // No existsSync guard: a path the corpus producer hands back that cannot be READ is its
    // problem, and skipping it here would be one more silent way for this guard to cover less
    // than it claims — the defect the whole change is about.
    //
    // ⚠️ ONE clone is enough. The threshold was 2, on the reasoning that a copy is caught at its
    // second row — but a SINGLE-clone table is the likeliest next copy (a per-game CLAUDE.md, a
    // runbook noting "this clone's lane"), and at 2 one measured escape was a row reading
    // `| ~/Projects/modoki-qa | 5177 | 5183 |` — backend and Vite swapped, i.e. a human handed the
    // Vite port as their MCP target, passing every assertion. The key-cell rule above is what makes
    // 1 affordable: measured over the 758-file corpus, threshold 1 returns these same three files
    // and nothing else.
    const dirs = clonePortDirsIn(readDoc(rel));
    if (dirs.size >= 1) found.set(rel, dirs);
  }
  return found;
}

/** Fixtures for the DETECTOR itself. `docsWithClonePortTable()` reads the corpus, so it has no
 *  fixtures by construction — and a detector with none is how a first version misses a spelling
 *  (`layoutConditionalTestLedger.test.ts`, #1071). Every case below is a shape that has actually
 *  been argued about, not an invented one. */
describe('clonePortDirsIn — the detector, against fixtures (#1102)', () => {
  it('reads the `~/Projects/<dir>` shape CLAUDE.md and clones-and-ports.md use', () => {
    expect([...clonePortDirsIn('| `~/Projects/modoki-qa` (work-qa) | 5183 | 5177 |')])
      .toEqual(['modoki-qa']);
  });

  it('reads the BARE clone-name shape too — the one the parser cannot key on', () => {
    // Detecting this is what makes the parser-mismatch assertion possible: the detector sees the
    // row, the parser reads nothing from it, and the difference is the error message.
    expect([...clonePortDirsIn('| `modoki-ai2` | 5181 | 5175 | 9324 |')]).toEqual(['modoki-ai2']);
  });

  it('catches a ONE-clone table — the likeliest next copy', () => {
    // At the old threshold of 2 this exact row passed everything, with backend and Vite swapped,
    // i.e. a human handed the Vite port as their MCP target.
    expect([...clonePortDirsIn('| ~/Projects/modoki-qa | 5177 | 5183 | 9226 |')])
      .toEqual(['modoki-qa']);
  });

  it('does NOT read a clone name that is merely inside a cell', () => {
    // docs/reviews/2026-07-30-mcp-tool-audit.md:18 — a clone name and a 5xxx number in one table
    // row that is not a port table. Excluded by the key-cell rule, with no ledger entry.
    expect([...clonePortDirsIn('| `npm --prefix engine/packages/modoki test` | 443 files · 5389 passed |')])
      .toEqual([]);
  });

  it('does NOT read a FENCED counter-example', () => {
    // #1102 added prose to two docs teaching this row shape, so the next author illustrating a
    // WRONG one would otherwise turn the guard red, told to fix a table that is wrong on purpose.
    const doc = ['Do not write it like this:', '', '```markdown', '| `modoki-qa` | **5183** |',
      '```', '', 'Write it with the path instead.'].join('\n');
    expect([...clonePortDirsIn(doc)]).toEqual([]);
  });

  it('does NOT read prose, only table rows', () => {
    // enact.md, a memory file and a review doc each name three clones with ports in running text.
    // They are examples, not copies; ledgering them would rebuild the hand list this replaced.
    expect([...clonePortDirsIn('The hub is on ~/Projects/modoki at 5179, work-ai at 5180.')])
      .toEqual([]);
  });

  it('does not confuse `modoki` with `modoki-ai2` — prefix, not token', () => {
    expect([...clonePortDirsIn('| `~/Projects/modoki-ai2` | 5181 |')]).toEqual(['modoki-ai2']);
  });

  it('ignores a row with a clone but no port-shaped number', () => {
    // clones-and-ports.md's OTHER table (Directory / Branch / Role) has no port column, and a
    // four-digit YEAR must not read as one.
    expect([...clonePortDirsIn('| `~/Projects/modoki-qa` | work-qa | Engine + QA |')]).toEqual([]);
    expect([...clonePortDirsIn('| `~/Projects/modoki-qa` | added 2026 | notes |')]).toEqual([]);
  });
});

describe.skipIf(!hasPrivateDocs())('the docs still say what the table says', () => {
  // The drift this catches is not cosmetic: a human reads the doc table to decide what to pass
  // to MODOKI_BACKEND_PORT, so a doc that disagrees with the code hands them a sibling's lane.
  //
  // Gated on what it READS (#1071). ⚠️ The DESCRIBE gates only on `hasPrivateDocs()`, and the one
  // assertion that needs `qa/` carries its own `it.skipIf(!hasQaSuite())`. An earlier version put
  // `|| !hasQaSuite()` on the describe, which was a real regression and measured as one: with
  // `qa/README.md` moved aside, flipping CLAUDE.md's modoki-qa row to 5999 left the suite fully
  // GREEN — a missing `qa/` silently retired the CLAUDE.md and clones-and-ports port guards, which
  // have nothing to do with `qa/`. Not exotic either: `qa/` relocating is a live possibility (the
  // Testboard is already its own repo).
  //
  // Both predicates are SHARED, from `helpers/repoLayout` — not a local `existsSync`. The first
  // version probed `qa/knowledge.md` by hand and `layoutConditionalTestLedger.test.ts` caught it,
  // correctly: a raw probe on the file the guard READS lets a rename switch the guard off instead
  // of turning it red.
  it('every doc that TABLES clone ports is parseable, and agrees with the code (#1102)', () => {
    const docs = docsWithClonePortTable();
    // Non-vacuity, as a NAMED-FILE floor rather than a count — `cliToolchainRecipes.test.ts`'s
    // idiom ("<file> is no longer scanned"), because a bare `>= 3` cannot say WHICH copy stopped
    // being seen, and it misfires on a copy that is legitimately retired (which the new prose in
    // docs/clones-and-ports.md § RULE 2 actively encourages: "link here" rather than copy).
    // Existence-filtered so the floor shrinks honestly on a checkout without `qa/` instead of
    // demanding a file that is not there.
    for (const known of ['CLAUDE.md', 'docs/clones-and-ports.md', 'qa/knowledge.md']) {
      if (!existsSync(path.join(REPO, known))) continue;
      expect(
        [...docs.keys()],
        `${known} carries a clone → port table and the detector no longer sees it. Fix the `
        + 'detector rather than deleting this line — if that table was deliberately retired, '
        + 'remove it from this list in the same commit.',
      ).toContain(known);
    }

    for (const [doc, dirs] of docs) {
      const documented = portsFromMarkdownTable(readDoc(doc));
      // Per-file floor, and it SIZES ITSELF: every clone the detector saw in a table row must be
      // one the parser could actually read. A fixed `>= 5` would be wrong for a doc that
      // legitimately tables two clones, and — worse — says nothing about the rows it missed.
      expect(
        new Set(Object.keys(documented)),
        `${doc} — the detector found clone → port table rows for [${[...dirs].sort().join(', ')}] `
        + `but the parser could only read [${Object.keys(documented).sort().join(', ')}]. Every `
        + 'row needs a `~/Projects/<dir>` cell and an UNBOLDED 4-digit port cell after it '
        + '(`**5183**` does not begin with a digit). Fix the table or teach '
        + '`portsFromMarkdownTable` the new shape — do not delete this assertion.',
      ).toEqual(dirs);

      for (const [dir, port] of Object.entries(documented)) {
        expect(
          CLONE_BACKEND_PORTS[dir],
          `${doc} documents clone '${dir}' but editorPorts.mjs does not know it — add it to `
          + 'CLONE_BACKEND_PORTS, or that clone gets AUTO ports and no stable MCP target.',
        ).toBeDefined();
        expect(
          port,
          `${doc} puts '${dir}' on ${port}; editorPorts.mjs says ${CLONE_BACKEND_PORTS[dir]}. `
          + 'The code wins — a doc that disagrees hands a human a sibling clone\'s lane.',
        ).toBe(CLONE_BACKEND_PORTS[dir]);
      }
    }
  });

  it('docs/clones-and-ports.md § RULE 2 also agrees on the derived Vite and CDP columns', () => {
    const src = readDoc('docs/clones-and-ports.md');
    let checked = 0;
    for (const line of src.split('\n')) {
      const dir = /~\/Projects\/([A-Za-z0-9._-]+)/.exec(line)?.[1];
      if (!dir || !(dir in CLONE_BACKEND_PORTS)) continue;
      const nums = [...line.matchAll(/\b(\d{4})\b/g)].map((m) => Number(m[1]));
      // backend, vite, cdp — in column order. Later cells hold the example launch command,
      // which repeats the backend port; the first three are the columns.
      const [backend, vite, cdp] = nums;
      if (backend !== CLONE_BACKEND_PORTS[dir]) continue; // a non-RULE-2 table; the test above owns it
      expect({ dir, vite, cdp }).toEqual({
        dir,
        vite: vitePortForBackend(backend),
        cdp: cdpPortForBackend(backend),
      });
      checked++;
    }
    // Without this the test is one `continue` away from vacuous: drop the `~/Projects/` prefix
    // from the table and it checks nothing and passes. It survives today only because the test
    // above would catch that same edit — a guard that depends on a sibling guard to not be
    // hollow is the shape of guard this whole file exists to replace.
    expect(checked, 'parsed no RULE 2 rows to check — fix the parser, do not delete the test')
      .toBe(Object.keys(CLONE_BACKEND_PORTS).length);
  });

  /** The twin of the test above, for the OTHER CDP series — and the two genuinely differ, which
   *  is why this is a second explicit test rather than a column added to the derived sweep.
   *
   *  `docs/clones-and-ports.md` § RULE 2 documents `cdpPortForBackend` (922x, the derivation
   *  `launch-editor.sh` falls back to). `qa/knowledge.md` § 1 documents the 932x OVERRIDE the
   *  `editor-*` shell functions actually set, because a QA runner needs the port the editor is on,
   *  not the one it would have chosen. Both docs are correct; a single generic column assertion
   *  would have to call one of them wrong. */
  it.skipIf(!hasQaSuite())('qa/knowledge.md § 1 agrees on Vite and on the 932x CDP OVERRIDE (#1102)', () => {
    const src = readDoc('qa/knowledge.md');
    let checked = 0;
    for (const line of src.split('\n')) {
      const dir = /~\/Projects\/([A-Za-z0-9._-]+)/.exec(line)?.[1];
      if (!dir || !(dir in CLONE_BACKEND_PORTS)) continue;
      const nums = [...line.matchAll(/\b(\d{4})\b/g)].map((m) => Number(m[1]));
      const [backend, vite, cdp] = nums;
      if (backend !== CLONE_BACKEND_PORTS[dir]) continue;
      expect({ dir, vite, cdp }).toEqual({
        dir,
        vite: vitePortForBackend(backend),
        // ⚠️ NOT `cdpPortForBackend`. On modoki-qa that returns 9226 and this table says 9326 —
        // the shell override, which is what actually binds. See `editorCdpPortForBackend`.
        cdp: editorCdpPortForBackend(backend),
      });
      checked++;
    }
    expect(checked, 'parsed no § 1 rows to check — fix the parser, do not delete the test')
      .toBe(Object.keys(CLONE_BACKEND_PORTS).length);
  });
});

describe('no shared script re-introduces a hardcoded hub-port default', () => {
  /** Files every clone runs, which USED to bake in a port. Listed explicitly (not globbed) so
   *  that deleting one from this list is a visible act rather than a silent loss of coverage. */
  const SHARED = [
    'engine/scripts/launch-editor.sh',
    'engine/scripts/relaunch-editor.sh',
    // test-packaged.sh is the one that bites twice: it never had its own default (the pin
    // arrived as a literal prefix on two npm scripts), and main.ts's sticky-then-scan starts
    // at 5179 — so an unpinned packaged launch lands on the hub's port. It also sits in
    // NEITHER of the older guard's lists, so nothing but this line covers it.
    'engine/scripts/test-packaged.sh',
    'engine/scripts/resave-scenes.sh',
    'engine/scripts/resave-prefabs.sh',
    'engine/scripts/migrate-legacy-scenes.mjs',
    'package.json',
  ];

  /** A port used as a DEFAULT or a PIN — `${VAR:-5179}`, `PORT=5179`, `:-http://…:5179`.
   *  Deliberately not "any occurrence of 5179": these files legitimately explain the hazard in
   *  prose, and the arithmetic `5173 + (backend − 5179)` in launch-editor.sh is the derivation
   *  itself, not a default. Comment lines are stripped before matching for the same reason. */
  //  The `["']?` is not decoration: this repo's dominant bash style QUOTES the value, and the
  //  change that introduced this guard writes `PORT="${MODOKI_BACKEND_PORT:-$(…)}"`. Without it
  //  the guard matched `PORT=5179` but sailed straight past `PORT="5179"` — i.e. it would have
  //  missed the regression written in the same style as the fix.
  const DEFAULTED_PORT = /(?::-|=|:)\s*["']?(?:http:\/\/(?:127\.0\.0\.1|localhost):)?(517[3-9]|518[0-3]|922[2-6])\b/;

  for (const rel of SHARED) {
    it(`${rel} derives its backend port instead of defaulting to one`, () => {
      if (!existsSync(path.join(REPO, rel))) return;
      // Dual language (`.sh` vs `.mjs` vs `.json`) — the shared scanner (#419/#812) picks the
      // right stripper by extension, so no hand-rolled per-language branch is needed here.
      const code = readScannedSource(path.join(REPO, rel)).code;
      const hit = DEFAULTED_PORT.exec(code);
      expect(
        hit?.[0] ?? null,
        `${rel} defaults or pins a per-clone port (${hit?.[1]}). That value is correct on exactly `
        + 'one clone and SILENTLY wrong on the other four — an MCP session then drives a sibling '
        + "checkout and every call succeeds. Derive it from editorPorts.mjs instead "
        + '(`$(node "$REPO/engine/scripts/editorPorts.mjs" backend)` from bash, or import '
        + '`backendPortForClone` / `backendUrlForClone` from Node).',
      ).toBeNull();
    });
  }

  it('the shared-script list still names files that exist', () => {
    // A renamed script would otherwise drop out of the guard silently — the failure mode this
    // whole file exists to prevent, applied to the guard itself.
    expect(SHARED.filter((rel) => !existsSync(path.join(REPO, rel)))).toEqual([]);
  });
});
