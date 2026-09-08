/**
 * "Was this module RUN, or merely imported?" — the ONE implementation (#910).
 *
 * Sibling of `pathIdentity.mjs`, and deliberately NOT part of it. That module owns *directory*
 * identity ("do these two spellings name the same directory?"); this one owns *module* identity,
 * which is a different question with a different correct answer — `pathIdentityIsShared.test.ts`
 * exempts this idiom by SHAPE for exactly that reason, and calls a `samePath` here a category
 * error. Keeping them apart is what keeps that exemption honest.
 *
 * ## Why a shared module rather than the idiom at each site
 *
 * Because there were TEN copies in FOUR recipes, and most of them were wrong:
 *
 *   | recipe | sites | verdict |
 *   |---|---|---|
 *   | canonicalise both sides, no fold, guarded | `clonePort` | correct — **stays local**, see below |
 *   | `samePath` (canonicalises AND folds) | `editorPorts` | correct; migrated, and see the fold note |
 *   | bare `path.resolve(argv[1]) === fileURLToPath(...)` | `packagedAppPaths`, `seed-quality-tiers` | **BROKEN** — migrated |
 *   | `import.meta.url === \`file://\${argv[1]}\`` | `generate-icons`, `review-icons`, `make-splash-badge`, `stamp-plugin-builds`, `releaseBranch` | **BROKEN** — migrated |
 *   | `import.meta.url === new URL(\`file://\${argv[1]}\`).href` | `migrate-legacy-scenes` | **BROKEN** — migrated |
 *   | `fileURLToPath(import.meta.url) === argv[1]` | `scan-publish-safety` | **BROKEN** — migrated |
 *   | bare `resolve` (again) | `scrub-project-config` | **BROKEN** — migrated |
 *
 * The `file://\${argv[1]}` template is the one `clonePort`'s docblock already warned against by
 * name — *"compare RESOLVED REAL PATHS, never a \`file://\${process.argv[1]}\` template"* — and it
 * was the most common in the repo. It is wrong three ways: it percent-encodes nothing (a path with
 * a space or a `#` never matches), it produces `file://C:/…` rather than `file:///C:/…` on
 * Windows, and it compares an unresolved `argv[1]` against an `import.meta.url` Node has already
 * resolved.
 *
 * ⚠️ **`migrate-legacy-scenes` used `new URL(...)`, and an earlier draft filed it under the raw
 * template and charged it with all three faults** (close-out review). `new URL` DOES
 * percent-encode — measured, `new URL('file:///tmp/x y#z.mjs').href` → `file:///tmp/x%20y#z.mjs` —
 * so only the `#` and the symlink faults applied to it. A table presented as a census has to be
 * one.
 *
 * Every miss is SILENT by construction — declining is what the check does when imported — so a
 * false "no" is exit 0 with no output and nothing run. Measured before the fix:
 * `packagedAppPaths.mjs tmpdir` through a symlinked repo printed nothing, and worse,
 * **`releaseBranch.mjs --claim-label` returned an EMPTY STRING** — the label `/grab-issue` and
 * `/close-out` build a `gh issue edit --add-label` argument out of. `smoke-packaged.sh` reads
 * that same empty stdout from `packagedAppPaths`.
 *
 * The body below is `clonePort.isEntryPoint`'s, promoted — the copy that was already right, which
 * is the same move #869 made with `connectClaude.canonical`.
 *
 * ⚠️ **`clonePort.canonicalHere` is NOT retired, and two earlier drafts of this paragraph said it
 * was** (close-out review) — once as "a fifth copy", once as "an eleventh", neither counted. It is
 * still live at `clonePort.mjs:79` and is CORRECT there: that file may not import the SSOT (below),
 * so a local canonicaliser is the one place this recipe is not a duplicate. Recorded because
 * writing a census in the past tense while its rows are still live is exactly what
 * `pathIdentity.mjs`'s header says hid four sites for two fixes.
 *
 * ⚠️ **`clonePort.mjs` is a deliberate EXCEPTION and must not be migrated.** Its own docblock
 * carries the reason: it may import nothing but `node:` builtins, because `clonePortCli.test.ts`
 * copies that file ALONE into a directory whose name contains a space, and that copy is the
 * apparatus proving the CLI works from such a path. An import of a sibling module makes the copy
 * unrunnable — measured, and #881's first attempt at exactly this reddened that test with
 * `ERR_MODULE_NOT_FOUND`. I repeated that mistake here before reading its docblock. Nine sites
 * share this module; the tenth keeps its own copy, and there is a test pinning that.
 *
 * ## ⚠️ It does NOT case-fold, and that is a decision
 *
 * `editorPorts.invokedDirectly` used `samePath`, which folds on win32/darwin. This does not, for
 * clonePort's stated reason: **both operands name a file that EXISTS by construction** — this
 * module is running, and `argv[1]` is what started it — so `.native` already returns the on-disk
 * casing for each and a fold adds nothing. It also SUBTRACTS a risk: the fold is `#905`'s accepted
 * over-match, under which two files differing only by case compare equal on a case-sensitive
 * volume. Here that would mean running CLI mode when you were imported. So migrating
 * `editorPorts` onto this removes a site from that hazard's blast radius rather than adding one.
 */

import { fileURLToPath } from 'node:url';
import { canonicalPath } from './pathIdentity.mjs';

/**
 * Is the module identified by `moduleUrl` the one Node was told to run?
 *
 * Pass `import.meta.url` from the calling module:
 *
 *     if (isEntryPoint(import.meta.url)) { …CLI… }
 *
 * ⚠️ **The try/catch is load-bearing — do not "simplify" it away.** `fileURLToPath` throws on a
 * non-`file:` `import.meta.url` (a bundler shim, a custom loader). This runs at MODULE LOAD, so an
 * unguarded throw stops the module being IMPORTED at all, rather than merely declining CLI mode.
 * Declining is always the safe answer; throwing is not.
 *
 * ⚠️ An earlier draft named "`editorPorts.mjs`, `playwright.config.ts` and
 * `migrate-legacy-scenes.mjs`" as the importers at risk. That list is `clonePort.mjs`'s, where it
 * is true, transplanted verbatim into the one file where it is not: `playwright.config.ts` reaches
 * `clonePort` (which keeps its LOCAL copy) and never this module. The guard is still load-bearing;
 * the blast radius named for it was not checked.
 *
 * ⚠️ **`canonicalPath` is correct here even though `pathIdentityIsShared.test.ts` bans comparing
 * two of its results.** That ban exists because `canonicalPath` falls back to `path.resolve` for a
 * path that does NOT exist, so two spellings of a missing path compare unequal (#892). Both
 * operands here exist by construction, so the fallback is unreachable and the ban's rationale does
 * not apply — which is why the guard exempts this idiom by shape.
 */
export function isEntryPoint(moduleUrl) {
  // No `argv[1]` at all: `node --eval`, or an embedder that never set one. Not a CLI invocation.
  //
  // ⚠️ **Redundant for the OUTCOME, kept deliberately — mutation-verified as such.** Deleting this
  // line leaves every test green: `canonicalPath(undefined)` reaches `path.resolve(undefined)`,
  // which throws a TypeError that the catch below turns into the same `false`. It stays because
  // relying on a TypeError from a builtin to express "there is no CLI argument" is implicit and
  // fragile — a future `path.resolve` that coerced instead of throwing would silently compare
  // against the cwd. Do not "simplify" it away on the grounds that the tests do not notice.
  if (!process.argv[1]) return false;
  try {
    return canonicalPath(fileURLToPath(moduleUrl)) === canonicalPath(process.argv[1]);
  } catch {
    return false;
  }
}

/* ⚠️ ONE known site is deliberately NOT migrated, beyond clonePort: `games/court/tools/levelAudio.mjs`
 * uses `import.meta.url === pathToFileURL(process.argv[1]).href`, which encodes correctly but is
 * still symlink-broken. A game may not import from `engine/` — `gamePortability.test.ts` enforces
 * it, because a game is copied OUT of this repo and the relative path would not resolve there. So
 * it keeps its own check by necessity, not oversight. Its blast radius is one game tool, not a
 * gate. */
