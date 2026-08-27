/**
 * Skill files must cite things that actually exist.
 *
 * WHY THIS GUARD EXISTS
 * ---------------------
 * `.claude/skills/<name>/SKILL.md` are runbooks — `/release-version` cuts a signed release,
 * `/close-out` finishes a change. Their whole value is that they can be FOLLOWED, so a citation
 * that points at nothing fails the same way a bad QA case does (see qaCaseReferences.test.ts):
 * it reads perfectly and only wastes the runner's time once they try to act on it. And unlike a
 * doc, nobody re-reads a skill until they are mid-release, which is the worst moment to find out.
 *
 * Both failure shapes below were live when this guard was written (2026-08-20), and neither was
 * catchable by reading:
 *   - `/dev-restart` cited `scripts/stop-dev.sh`; the reorg moved it to `engine/scripts/`.
 *   - `/release-version` cited a `qa/README.md` section titled "Running a case" — which does not
 *     exist under that name (it is "Executing a case — the runner's protocol"). Found by a reviewer
 *     grepping for it, which is exactly the check a machine should be doing.
 *     (Written WITHOUT the `§ "…"` form on purpose: docCitations' rule 4 reads that form as a live
 *     citation wherever it appears, so quoting the dead one verbatim made this comment itself
 *     dangle — it was one of #329's eleven, and the only one that was never a real citation.)
 *
 * Deliberately CONSERVATIVE, for the reason that guard gives: it only inspects paths inside
 * markdown code spans, and only ones carrying a directory separator and a known file extension,
 * because a guard that cries wolf gets disabled.
 *
 * NOTE ON THE OSS SNAPSHOT: `tests/**` ships to the public engine repo, which does not carry
 * `.claude/skills/`. Skip when absent rather than going red on `ci/main`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, hasSkills } from '../helpers/repoLayout';

const toPosix = (p: string) => p.replace(/\\/g, '/');

const SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills');
const HAS_SKILLS = hasSkills();

const skillFiles = (): string[] =>
  !HAS_SKILLS
    ? []
    : readdirSync(SKILLS_DIR)
        .map((d) => join(SKILLS_DIR, d, 'SKILL.md'))
        .filter((f) => existsSync(f));

/** Code spans only — prose may legitimately name a path that no longer exists (a history note). */
const codeSpans = (text: string): string[] => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

const FILE_EXT = /\.(ts|tsx|mjs|cjs|sh|ps1|md|json|yml|yaml)$/;

/** A repo-relative path: has a separator, a known extension, and no glob/placeholder/URL. */
const isRepoPath = (tok: string): boolean =>
  tok.includes('/') &&
  FILE_EXT.test(tok) &&
  !/[*<>${}\s]/.test(tok) &&
  !tok.startsWith('/') &&
  !tok.startsWith('.') &&
  !tok.includes('://') &&
  !tok.startsWith('node_modules');

describe.skipIf(!HAS_SKILLS)('skill references', () => {
  it('every repo-relative path a skill cites exists', () => {
    const dangling: string[] = [];
    for (const file of skillFiles()) {
      const rel = toPosix(file.slice(REPO_ROOT.length + 1));
      for (const tok of new Set(codeSpans(readFileSync(file, 'utf8')).filter(isRepoPath))) {
        if (!existsSync(join(REPO_ROOT, tok))) dangling.push(`${rel} cites missing path: ${tok}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  /**
   * `` `some/doc.md` §"A heading" `` is this repo's citation idiom. It is worth checking because
   * the FILE existing is what makes the citation look verified while the section has been renamed
   * out from under it — the release-version case above.
   */
  it('every §"heading" citation resolves to a heading in the file it names', () => {
    const dangling: string[] = [];
    for (const file of skillFiles()) {
      const rel = toPosix(file.slice(REPO_ROOT.length + 1));
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/`([^`\n]+\.md)`\s*§\s*"([^"\n]+)"/g)) {
        const [, path, heading] = m;
        if (!isRepoPath(path) || !existsSync(join(REPO_ROOT, path))) continue; // covered above
        const headings = [...readFileSync(join(REPO_ROOT, path), 'utf8').matchAll(/^#{1,6}\s+(.*)$/gm)].map(
          (h) => h[1].replace(/`/g, '').trim(),
        );
        if (!headings.some((h) => h.includes(heading.replace(/`/g, '').trim()))) {
          dangling.push(`${rel} cites ${path} §"${heading}" — no such heading`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });
});
