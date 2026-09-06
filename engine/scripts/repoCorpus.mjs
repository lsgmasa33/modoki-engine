/**
 * The ONE way to enumerate a repo file corpus — repo root plus a filtered file list, both
 * sourced from git rather than a filesystem walk (#799/#771/#805).
 *
 * This is the missing shared half of the pattern `pathPosix.mjs`'s `toPosix` already covers
 * for the OTHER end of the pipeline: `toPosix` normalises a path once it has LEFT `node:path`;
 * this module is for the path BEFORE it ever enters `node:path` at all. The two mistakes it
 * exists to kill were both found live in this repo, not hypothesised:
 *
 * 1. **`execSync` with a shell string, not `execFileSync` with an argv array.** `execSync`
 *    spawns `cmd.exe` on Windows, which does not strip single quotes — a quoted pathspec like
 *    `'*.scene.json'` reaches git literally and matches nothing. MEASURED on this clone:
 *    `git ls-files '*.scene.json'` via `execSync` → 0 files; the same argv unquoted → 69. This
 *    is a live bug in `engine/scripts/migrate-assets.mjs:80` today (Phase 3 fixes it) — kept
 *    here only as the reason every enumerator in this file uses `execFileSync`.
 * 2. **A hand-rolled `readdir` walker drifting from what the repo's own gates consider "the
 *    corpus"** — a blocklist walk misses a directory nobody remembered to list (`show-refs.mjs`
 *    rooted its walk at the wrong directory AND keyed scenes by DIRECTORY name rather than
 *    extension — see Deliverable B of the issue this module was written for). Enumerating
 *    through `git ls-files` instead means the corpus is exactly what the repo's own tracked +
 *    untracked-but-not-ignored view says it is, with no second definition to drift.
 *
 * `repoRoot()` gives the one root; `repoFiles()` gives the one filtered, deduped, git-relative
 * file list. New enumerators should call this rather than writing a seventh `readdir` walker or
 * an eighth `execSync` git call — see `engine/scripts/migrate-anchor-zindex.mjs` and
 * `engine/tests/architecture/docCitations.test.ts` for the two hand-rolled precedents this
 * generalises (both are left as-is; migrating them is Phase 3, deliberately batched separately).
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Cached result of `git rev-parse --show-toplevel`, computed once per process. */
let cachedRoot;

/**
 * The repo root, as an absolute POSIX path.
 *
 * ⚠️ `git rev-parse --show-toplevel` returns forward slashes on THIS machine even though it is
 * Windows (VERIFIED: `E:/Projects/modoki`, not `E:\Projects\modoki`) — git normalises its own
 * output internally. Do NOT run the result through `path.resolve` or `toPosix`: both would be
 * no-ops on the happy path and both invite a future edit to route it through `node:path`, which
 * is exactly the round-trip this module exists to avoid (see `repoFiles`'s `rel`/`abs` note
 * below). Take git's string as-is.
 */
export function repoRoot() {
  if (cachedRoot) return cachedRoot;
  try {
    cachedRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: __dirname,
      encoding: 'utf8',
    }).trim();
  } catch (e) {
    throw new Error(
      `repoCorpus: could not determine the repo root via \`git rev-parse --show-toplevel\` from `
      + `${__dirname} — ${e.message.split('\n')[0]}. This needs git on PATH and a work tree `
      + 'containing this file.',
      { cause: e },
    );
  }
  return cachedRoot;
}

/** Cached raw enumeration, keyed by `includeUntracked` — computed at most once per process PER
 *  KEY; `repoFiles()`'s options are applied fresh on every call against whichever raw list its
 *  `includeUntracked` selects.
 *
 *  ⚠️ This MUST be keyed by the flag, not a single shared cache slot. Two possible git
 *  invocations sharing one cache slot means whichever mode runs first silently wins for every
 *  later caller regardless of what it asked for — exactly this family's failure shape (a wrong
 *  answer with no error), landing inside the fix for it. `repoCorpus.test.ts` calls both orders
 *  across a `vi.resetModules()` specifically to catch a regression here. */
const cachedRawFilesByMode = new Map();

/**
 * Enumerate every file in the repo matching the given tracking mode, deduped and filtered to
 * files that still exist on disk. Returns `rel` (git-relative, POSIX, unquoted) strings.
 *
 * @param {boolean} includeUntracked `true` (the common case) also includes untracked-but-not-
 *   ignored files (`--others --exclude-standard`); `false` restricts to what git's index already
 *   holds (`--cached` only).
 */
function rawRepoFiles(includeUntracked) {
  const cached = cachedRawFilesByMode.get(includeUntracked);
  if (cached) return cached;
  const root = repoRoot();

  // `execFileSync` with an argv array, never `execSync` with a shell string — see the module
  // doc-block's point 1. `-z` is mandatory: without it, git C-quotes and octal-escapes any path
  // containing non-ASCII bytes (e.g. `"games/.../\320\222....mesh.json"`), which would then fail
  // every downstream comparison against a real filename. VERIFIED — this repo has 18 such
  // tracked paths today (Cyrillic mesh filenames under
  // `games/3d-test/runtime/assets/models/tropical-island/meshes/`). Latent rather than live: they
  // are all `.mesh.json` and no current non-`-z` enumerator filters `.json` over `games/`, but a
  // non-ASCII `.ts` under `games/` would be silently skipped by one that did.
  const args = includeUntracked
    ? ['ls-files', '--cached', '--others', '--exclude-standard', '-z']
    : ['ls-files', '--cached', '-z'];
  let listed;
  try {
    listed = execFileSync(
      'git',
      args,
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ).split('\0').filter(Boolean);
  } catch (e) {
    // A THROW (git missing, or `root` is not a work tree) is a different failure than "git ran
    // and listed nothing" below — an empty-result check can never catch a throw, so it needs its
    // own catch here rather than falling through to the zero-length check.
    throw new Error(
      `repoCorpus: could not enumerate files through \`git ls-files\` in ${root} — `
      + `${e.message.split('\n')[0]}. This needs git on PATH and a work tree at the repo root.`,
      { cause: e },
    );
  }

  // git ran but listed ZERO files at all — always fatal, regardless of the caller's `floor`. This
  // repo always has tracked files, so an empty listing means the enumeration itself is broken
  // (wrong cwd, a bare repo, an index that was never populated), not a clean/empty corpus.
  if (listed.length === 0) {
    throw new Error(
      `repoCorpus: \`git ls-files\` listed 0 files in ${root} at all — this repo always has `
      + 'tracked files, so an empty listing means the enumeration itself is broken, not a clean '
      + 'corpus.',
    );
  }

  // Dedupe #1: `--cached` emits an UNMERGED path once per merge stage (1/2/3), so a conflicted
  // file would otherwise appear more than once. Dedupe on the raw string first.
  const deduped = [...new Set(listed)];

  // Dedupe #2: case-FOLDED, because two index entries differing only in case
  // (`Games/x.json` vs `games/x.json`) are the SAME physical file on every clone's
  // case-insensitive filesystem (macOS, Windows) even though they are distinct strings here.
  // Both reasons are lifted from `migrate-anchor-zindex.mjs`'s `repoSceneAndPrefabFiles`.
  const seen = new Set();
  const rels = [];
  for (const rel of deduped) {
    const key = rel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rels.push(rel);
  }

  // Keep only paths that are REGULAR FILES right now. Two distinct things are dropped here, and
  // the second is not obvious:
  //
  //   1. A tracked file can be deleted mid-rebase; reading it later would throw for a reason
  //      unrelated to the caller.
  //   2. `--others` reports a NESTED GIT CHECKOUT as a single DIRECTORY entry (with a trailing
  //      slash) rather than descending into it — git will not walk another repo's work tree. An
  //      `existsSync` check passes such an entry happily, and the consumer then gets EISDIR from
  //      `readFileSync`. This is not hypothetical: `.claude/worktrees/<id>/` is exactly that, so
  //      it appears whenever a subagent launched with `isolation: 'worktree'` is running — i.e.
  //      during the fan-out workflow CLAUDE.md recommends. VERIFIED with a nested `git init`:
  //      `repoFiles()` returned `.claude/probe-wt/` as an entry before this filter.
  //
  // `statSync` costs no more than the `existsSync` it replaces (both stat once) and is
  // authoritative about which of the two it is.
  const files = rels.filter((rel) => {
    try {
      return statSync(path.join(root, rel)).isFile();
    } catch {
      return false;
    }
  });
  cachedRawFilesByMode.set(includeUntracked, files);
  return files;
}

/**
 * The repo's file corpus, filtered per the given options.
 *
 * @param {object} options
 * @param {string | string[]} [options.under] Repo-relative POSIX prefix(es) — a file matches if
 *   `rel === under` or `rel` starts with `under + '/'`. Compared case-insensitively, segment by
 *   segment (a git index holding `Games/` against a worktree holding `games/` must still match —
 *   same reasoning as `engine/tests/assets/anchorZIndexMigrated.test.ts:69-77`'s `sceneFiles`).
 * @param {RegExp | ((rel: string) => boolean)} [options.match] Tested against `rel`.
 * @param {Iterable<string>} [options.exclude] Path SEGMENT names to drop — a file is dropped if
 *   any of its `rel` segments is in this set. No default value: the shared default set (ignoring
 *   `node_modules`, `.git`, build output, …) is deliberately deferred to Phase 3, when the real
 *   consumers arrive, rather than guessed at now — note that `build/` IS tracked in this repo (5
 *   files), so the obvious "exclude build output" guess would silently drop real content.
 * @param {number} options.floor Required. Throws if the final matched count is below it.
 *
 *   ⚠️ **`floor: 0` is a legitimate and common answer, and it is not a way of opting out.** It
 *   throws, so at MODULE scope it fails vitest COLLECTION rather than skipping the file — which is
 *   wrong for the many guards here that must tolerate a checkout shipping no `games/` (the public
 *   OSS snapshot excludes it) or no native projects. Those pass `floor: 0` and keep the real
 *   non-vacuity pin in a `skipIf`-gated test, where it can be skipped honestly instead of
 *   exploding; `engine/tests/assets/prefabInertSize.test.ts` is the worked example. A non-zero
 *   `floor` is right when the call sits INSIDE a test body, or when the corpus genuinely cannot be
 *   empty on any checkout. The parameter is required either way so that the author has to answer
 *   the question — "how few files means my enumeration is broken rather than my repo is clean?" —
 *   not so that every call site carries a number.
 * @param {boolean} [options.includeUntracked=true] `true` (default, unchanged behaviour) also
 *   enumerates untracked-but-not-ignored files (`--others --exclude-standard`) — a file just
 *   written and not yet staged is exactly when a guard is most useful (the same reasoning
 *   `docCitations.test.ts`'s own `repoFiles()` comment gives). Pass `false` to restrict to what
 *   git's index already holds (`--cached` only) when the guard's subject is genuinely "what is
 *   COMMITTED" rather than "the current state of the tree" — every call site that does must say
 *   why in a comment.
 * @returns {Array<{ rel: string, abs: string }>} Sorted by `rel`.
 */
/**
 * Normalise one `under` entry to a lower-cased, repo-relative, POSIX prefix.
 *
 * ⚠️ **Accepting an ABSOLUTE path here is the whole point, not a convenience.** Callers routinely
 * hold an absolute directory (from `discoverProjects()`, `findAssetRoots()`, a `__dirname` join),
 * and before this accepted one, all eight of them wrote
 * `under: path.relative(ROOT, dir).split(path.sep).join('/')` — reintroducing, as boilerplate at
 * every call site, the exact `node:path` round-trip this module exists to delete. Each was
 * correct, but only because each remembered the `.split(path.sep).join('/')`; dropping it is a
 * one-token edit that breaks matching on Windows ONLY, silently, which is instance 1-8 of the
 * class in docs/windows.md § Paths. Neither rule in `corpusProducerIsShared.test.ts` can see that
 * shape, so the API absorbing it is the only thing that makes it unreachable.
 */
function toUnderPrefix(u, root) {
  // ⚠️ Normalise a trailing `/` and a leading `./` away FIRST. Without this,
  // `under: 'games/'` becomes the prefix `games/` and the caller's filter then tests
  // `rel.startsWith('games//')` — which matches nothing, and `repoFiles` returns `[]` with no
  // error. A silently empty corpus is precisely the failure this module exists to remove, so
  // letting one in through its own front door on a trailing slash would be the joke writing
  // itself. No current call site does it; that is what "latent" means, not "impossible".
  let s = u.split(/[\\/]/).join('/');
  if (s.startsWith('./')) s = s.slice(2);
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);

  // A repo-relative POSIX prefix is already the target shape — the common literal case.
  if (!path.isAbsolute(s)) return s.toLowerCase();
  u = s;

  const abs = u.split(/[\\/]/).join('/').toLowerCase();
  const base = root.toLowerCase();
  if (abs === base) return '';
  if (abs.startsWith(`${base}/`)) return abs.slice(base.length + 1);
  throw new Error(
    `repoCorpus.repoFiles: \`under\` was an absolute path outside the repo — ${u} is not under `
    + `${root}. Pass a repo-relative POSIX prefix, or a path inside the work tree.`,
  );
}

export function repoFiles(options) {
  const { under, match, exclude, floor, includeUntracked = true } = options ?? {};
  if (typeof floor !== 'number') {
    throw new Error('repoCorpus.repoFiles: `floor` is required (pass the minimum expected count).');
  }

  const root = repoRoot();
  const all = rawRepoFiles(includeUntracked);
  const totalEnumerated = all.length;

  const underList = under == null ? undefined
    : (Array.isArray(under) ? under : [under]).map((u) => toUnderPrefix(u, root));
  const excludeSet = exclude == null ? undefined : new Set(exclude);

  let result = all;

  if (underList) {
    result = result.filter((rel) => {
      const relLower = rel.toLowerCase();
      // `''` is the repo root itself (`under: repoRoot()`), which every path is under. Without
      // this case the prefix test below would compare against `'/'` and match NOTHING — a filter
      // that silently empties the corpus, which is the failure this module exists to prevent.
      return underList.some((u) => u === '' || relLower === u || relLower.startsWith(`${u}/`));
    });
  }

  if (excludeSet) {
    result = result.filter((rel) => !rel.split('/').some((seg) => excludeSet.has(seg)));
  }

  if (match) {
    // ⚠️ A `g`- or `y`-flagged RegExp makes `.test()` STATEFUL — it advances `lastIndex` on a hit
    // and resumes from there on the next call, so used as a filter predicate it returns
    // alternating true/false and silently drops half the corpus. That is this module's own failure
    // shape (a wrong answer with no error), arriving through its front door, so it is normalised
    // here rather than left to each caller: `g`/`y` are meaningless for a one-shot predicate, so
    // stripping them changes no intended behaviour. Rebuilt rather than mutated because a caller's
    // RegExp literal may be shared or frozen.
    const test = typeof match === 'function'
      ? match
      : (() => {
        const flags = match.flags.replace(/[gy]/g, '');
        const re = flags === match.flags ? match : new RegExp(match.source, flags);
        return (rel) => re.test(rel);
      })();
    result = result.filter(test);
  }

  if (result.length < floor) {
    throw new Error(
      `repoCorpus.repoFiles: matched ${result.length} file(s), below the required floor of `
      + `${floor} (${totalEnumerated} total enumerated before filtering).`,
    );
  }

  // `rel` is git's own output, verbatim — POSIX, unquoted — and must never be round-tripped
  // through `node:path` (that round-trip, via `path.relative`, is the exact hazard this module
  // exists to kill; see the module doc-block). Joining TO an absolute path is safe and is the
  // only direction `node:path` is used here.
  return result
    .map((rel) => ({ rel, abs: path.join(root, rel) }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}
