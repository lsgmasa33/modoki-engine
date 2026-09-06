/** Guard: a documented CLI build recipe never hand-rolls its own toolchain lookup (#159).
 *
 *  WHY THIS IS A DOC GUARD RATHER THAN A UNIT TEST.
 *
 *  The editor resolves `JAVA_HOME`/`ANDROID_HOME` through `engine/toolchain`'s version-strict
 *  `detect()`, provisioned-install-first. `docs/build.md` told CLI users to run
 *  `JAVA_HOME=$(/usr/libexec/java_home -v 21)` instead — a SECOND, looser probe, which is exactly
 *  the divergence that module's own comment says it was consolidated to remove ("the SINGLE
 *  candidate list — it replaces the two previously divergent Android-SDK probes").
 *
 *  It failed in the worst available way: `java_home -v 21` does not error when no SYSTEM JDK 21 is
 *  registered — it returns the newest JDK it knows. Measured on a Mac carrying a provisioned
 *  Temurin 21, it answered **25.0.3**, and Gradle then died with `Unsupported class file major
 *  version 69`, which reads as an AGP problem rather than a wrong-Java one. No test could see this,
 *  because the defect lived in prose that nothing executes.
 *
 *  Hence a guard over the DOCS: a recipe is code that humans run, and this is the only place that
 *  can fail on the day a brew path or a `java_home` probe is pasted back in. Prose ABOUT the
 *  problem is fine and must stay allowed — the point is that no ```bash block tells you to do it.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hasPrivateTooling } from '../helpers/repoLayout';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

/** A Markdown doc, read as PROSE — the doc TEXT is the subject of these assertions, and
 *  Markdown carries no comment syntax a scan could be blinded by (#812). */
const DOC_AS_PROSE = {
  comments: 'include',
  reason: 'Markdown — the doc text IS the subject, so there is nothing to see past',
} as const;

const REPO = path.resolve(__dirname, '../../..');
const DOCS = path.join(REPO, 'docs');

/** Docs that MUST carry the corrected recipe (asserted by name, so a rename is loud). */
const RECIPE_DOCS = ['build.md', 'native-and-sdks.md'];

/** ── WHY THIS SCANS EVERY MARKDOWN FILE ───────────────────────────────────────────────────
 *  The first version of this guard enumerated `RECIPE_DOCS` and scanned only those two — which
 *  is the SAME narrow-lookup shape as the bug it guards, and it failed the same way. A close-out
 *  sweep found the identical `java_home -v 21` recipe alive in three more runnable places the
 *  two-file list could not see: the repo `README.md`, and the `/deploy-android` + `/deploy-all`
 *  slash commands — the last two being commands an agent EXECUTES, i.e. the worst possible place
 *  for it. So the guard discovers files instead of listing them.
 *
 *  Skipped, deliberately: point-in-time records. A plan or a memory note saying "we ran
 *  `java_home -v 21` and it worked" is a true historical statement, not an instruction, and
 *  rewriting history to satisfy a guard is how records stop being trustworthy. */
/*  ── AND WHY IT ASKS GIT, RATHER THAN WALKING THE DISK ──────────────────────────────────────
 *  The walk version read GENERATED, gitignored output: `site/docs/reference/` is a build
 *  artifact `site/sync-reference.mjs` re-derives from `docs/` on every site build. A stale copy
 *  predating the #159 fix sat there, and the guard failed on a doc nobody can correct — editing
 *  it is overwritten on the next build, and CI (a fresh clone, artifact absent) passed anyway.
 *  So it was red locally, green remotely, and pointed at the wrong file in both cases.
 *
 *  Tracked-only fixes all three: the artifact is invisible, the SOURCE it derives from is
 *  scanned, and local + CI now see the same file set. It also makes the SKIP_DIRS list
 *  unnecessary — `node_modules`/`dist`/`Pods` are ignored, so git never offers them. */
const SKIP_PATHS = [
  /^docs\/(plans|reviews)\//,   // point-in-time trackers
  /^\.agent-memory\//,          // agent memory — a record of what happened
  /(^|\/)PLAN\.md$/,            // per-game historical plans
  /^scripts\/oss\//,            // curated public overlay, reviewed on its own terms
];

/** Floored well under the 528 measured today (698 total `.md` files, minus SKIP_PATHS) — only a
 *  broken enumeration or a `match` that stops matching can turn this red, never ordinary doc
 *  churn. This file previously carried NO non-vacuity check at all beyond the named-file
 *  membership assertions below; `repoFiles()`'s `floor` is required, so this is new coverage,
 *  not merely a migration. */
function allMarkdown(): string[] {
  return repoFiles({
    match: (rel: string) => rel.endsWith('.md') && !SKIP_PATHS.some((re) => re.test(rel)),
    // ⚠️ Floored under the PUBLIC OSS SNAPSHOT's count (86 markdown files, measured by assembling
    // a real stage), not this clone's 528. `engine/tests/**` ships, and
    // `scripts/publish-engine-oss.sh` is INCLUDE-ONLY — `git ls-files -- engine build docs` plus a
    // handful of named root files — so the snapshot has no `games/`, `qa/`, `.agent-memory/`,
    // `layouts/` or `scripts/`, and `docs/` minus seven private files. A floor of 200 (this
    // clone's number, scaled down) went red on the public gate; the mental model "snapshot = repo
    // minus games/" is what produced it and is wrong.
    floor: 50,
  }).map(({ rel }) => rel);
}

/** Patterns that must never appear INSIDE a fenced command block in those docs, with the reason
 *  each is wrong — reported verbatim on failure, so a future reader gets the argument and not
 *  just a rule. */
const BANNED: { re: RegExp; why: string }[] = [
  {
    re: /java_home\s+-v/,
    why: '`/usr/libexec/java_home -v 21` returns the NEWEST JDK when none matches (measured: 25.0.3 '
      + 'on a box with a provisioned Temurin 21), so it silently selects the wrong Java. Use '
      + '`eval "$(node engine/scripts/print-toolchain-env.mjs)"`.',
  },
  {
    re: /(JAVA_HOME|ANDROID_HOME|ANDROID_SDK_ROOT)\s*=\s*["']?\/opt\/homebrew/,
    why: 'a hardcoded Homebrew toolchain path bypasses the provisioned SDK the editor builds with, '
      + 'so the CLI produces an artifact from a different toolchain. Use '
      + '`eval "$(node engine/scripts/print-toolchain-env.mjs)"`.',
  },
];

/** Fenced code blocks only. Prose explaining WHY `java_home` is wrong must stay legal — this guard
 *  exists to stop the instruction, not the explanation.
 *
 *  Pairs EVERY fence (any language tag, or none), then keeps only the shell-like ones. The
 *  earlier version's regex required the language tag itself to be `bash|sh|shell|console`, so a
 *  single ` ```ts ` or ` ```js ` fence anywhere in the file failed to match as an opener and
 *  desynced every fence pairing AFTER it — the next *closing* triple-backtick was read as the next
 *  *opening* one, silently merging long, unrelated stretches of prose into one bogus "code block".
 *  That stayed invisible for a long time because no BANNED text happened to fall inside the
 *  resulting mismatched span; it surfaced only once ordinary prose containing `JAVA_HOME=/opt/
 *  homebrew...` (as an inline code span, not a shell instruction) landed inside one. */
function commandBlocks(md: string): string[] {
  const SHELL_TAGS = new Set(['', 'bash', 'sh', 'shell', 'console']);
  return [...md.matchAll(/```(\w*)\n([\s\S]*?)```/g)]
    .filter((m) => SHELL_TAGS.has(m[1]))
    .map((m) => m[2]);
}

describe('CLI build recipes resolve the toolchain the way the editor does (#159)', () => {
  it('no tracked markdown tells you to hand-roll a toolchain probe in a command block', () => {
    const offences: string[] = [];
    for (const file of allMarkdown()) {
      const md = readScannedSource(path.join(REPO, file), DOC_AS_PROSE).raw;
      for (const block of commandBlocks(md)) {
        for (const line of block.split('\n')) {
          for (const { re, why } of BANNED) {
            if (re.test(line)) offences.push(`${file}: ${line.trim()}\n    → ${why}`);
          }
        }
      }
    }
    expect(offences, `\n${offences.join('\n')}\n`).toEqual([]);
  });

  it('the sweep actually reaches the places the two-file version missed', () => {
    // Pins the coverage itself: a future `SKIP_PATHS` entry that quietly excluded the slash
    // commands would turn the guard above green while re-opening the exact hole it was widened
    // to close. Named files, so the failure says WHICH surface stopped being watched.
    const seen = new Set(allMarkdown());
    for (const f of ['README.md', 'docs/build.md', 'docs/native-and-sdks.md']) {
      expect(seen, `${f} is no longer scanned`).toContain(f);
    }

    // The slash commands are PRIVATE agent tooling — `publish-engine-oss.sh`'s manifest ships
    // `engine build docs` + root configs, so `.claude/` is absent from the public snapshot while
    // THIS test file ships. Asserting them unconditionally therefore fails on the public gate for
    // a file the snapshot is never supposed to contain, which is what it did on `ci/main`.
    // Gated on the shared predicate rather than a local existsSync, per repoLayout's own rule.
    if (hasPrivateTooling()) {
      for (const f of [
        '.claude/skills/deploy-android/SKILL.md',
        '.claude/skills/deploy-all/SKILL.md',
        '.claude/skills/deploy-ios/SKILL.md',
      ]) expect(seen, `${f} is no longer scanned`).toContain(f);
    }

    // …and never generated output. `site/docs/reference/` is gitignored and re-derived from
    // `docs/` by `site/sync-reference.mjs`, so a stale copy there is not a doc anyone can fix.
    // Vacuously true on a clone that has never built the site — the point is that a box which
    // HAS built it agrees with CI rather than failing on an artifact.
    expect([...seen].filter((f) => f.startsWith('site/docs/reference/'))).toEqual([]);
  });

  it('the script the recipes point at exists and is executable by node', () => {
    // A recipe pointing at a script that has been renamed away is the same class of failure as the
    // one above — a doc that reads authoritative and does not work.
    const script = path.resolve(__dirname, '../../scripts/print-toolchain-env.mjs');
    expect(fs.existsSync(script)).toBe(true);
    const src = readScannedSource(script).code;
    // It must DELEGATE. If this file ever grows its own candidate list it becomes the third probe.
    expect(src).toContain("'engine', 'toolchain', 'index.ts'");
    expect(src).toMatch(/detect\(['"]java['"]\)/);
    expect(src).toMatch(/detect\(['"]android-sdk['"]\)/);
  });

  it('every recipe doc that mentions the script spells it the same way', () => {
    const invocation = 'node engine/scripts/print-toolchain-env.mjs';
    for (const file of RECIPE_DOCS) {
      const md = readScannedSource(path.join(DOCS, file), DOC_AS_PROSE).raw;
      if (!md.includes('print-toolchain-env')) continue;
      expect(md, `${file} names the script but not the runnable form`).toContain(invocation);
    }
  });
});
