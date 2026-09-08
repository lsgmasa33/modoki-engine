/** Pure decision logic for the scoped per-project typecheck (#24, #967).
 *
 *  Split out of `typecheck-projects.mjs` for ONE reason. That script derives `repoRoot` from
 *  `import.meta.url` (#944 — a gate must typecheck the same tree whoever spawned it and from
 *  where), and under vitest's transform `import.meta.url` is not a `file:` URL, so importing the
 *  CLI throws `TypeError: The URL must be of scheme file` and the suite collects ZERO tests.
 *  main's own #944 guard never hit this because it COPIES and SPAWNS the script; these predicates
 *  cannot be tested that way, because they are functions rather than a process.
 *
 *  So everything importable and pure lives here and the CLI keeps the wiring. Nothing in this
 *  file may read `import.meta.url`, `process.cwd()` or the filesystem.
 *
 *  ⚠️ **Why the prefix checks below do NOT use `pathIdentity.mjs`'s `isUnderOrSame` (#869).** That
 *  helper asks the same question ("is this path under that directory?") and normally a hand-rolled
 *  answer here would be the eighth copy that guard exists to make loud. Two reasons it is the
 *  wrong tool at this call site, both about scale and purity rather than disagreement:
 *    - it canonicalises through `fs.realpathSync.native` on every call, and this runs once per
 *      line of `tsc --listFiles` output — ~2400 lines per project, 29 projects on a full sweep.
 *    - it is filesystem-touching, and this module is pure so it can be imported under vitest at
 *      all (see above).
 *  The KNOWN BOUND that buys: both sides here come from the same `repoRoot` spelling on the same
 *  machine, so casing and symlinks agree in practice — but a clone reached through a SYMLINK could
 *  make `tsc`'s (realpath'd) output disagree with `proj.dir`'s spelling. That direction is a loud
 *  false RED on every sourced project at once, not a silent green, so it announces itself the
 *  first time anyone hits it. Revisit with a once-per-project canonicalisation in the CLI (not
 *  per line) if it ever does. */
import path from 'node:path';

/** Files that change the scoped-config SHAPE for every project, touched or not. A diff
 *  reaching any of these escalates to a full sweep, because then the thing under test is
 *  the scoping itself rather than one project's imports. */
const MACHINERY_PATHS = [
  'engine/tsconfig.app.json',
  'engine/scripts/scopedTsconfig.mjs',
  'engine/scripts/build-web.mjs',
  'engine/scripts/projectRoots.mjs',
  // ⚠️ THIS FILE, because the scoped `include` array is assembled HERE (see `buildInclude`), not
  // in scopedTsconfig.mjs. Without this entry, editing the shape — dropping `'app'`, adding a
  // package path — is validated against only the 2 projects the branch touched; if the new shape
  // breaks 12 untouched ones, this branch is green and the NEXT clone's unrelated verify goes red.
  // Costs a full sweep on every edit to this script, which is the correct price for that edit.
  'engine/scripts/typecheck-projects.mjs',
  // ...and this file, which now holds MACHINERY_PATHS itself and the coverage predicates.
  'engine/scripts/scopedTypecheckLib.mjs',
];

/** Every path in MACHINERY_PATHS must exist — a stale entry silently stops escalating. Asserted by
 *  typecheckProjectsSelection.test.ts against the real repo rather than here, so a throwaway repo
 *  (which has none of them) still runs. */
export { MACHINERY_PATHS };

/** `tsc --listFiles` emits absolute paths normalised to FORWARD SLASHES on every platform
 *  (TypeScript's own `normalizePath`), while `path.join` gives backslashes on Windows. Comparing
 *  the two directly made every sourced project on the `win` clone report "0 of its own files" —
 *  a guaranteed false RED on a correct tree, pointing at the wrong file. `buildInclude` below
 *  already knew this; the coverage predicate did not. */
function toPosix(p) {
  // Splits on EITHER separator, not `path.sep`. Deliberate: with `path.sep` this function is the
  // identity on macOS/Linux, so the Windows defect it exists to fix would be untestable from the
  // only machines that run the suite — the fix would ship unpinned and re-break silently. This
  // way a Mac can assert the Windows-shaped input directly.
  return p.split(/[\\/]/).join('/');
}

/** How many files of `dirAbs` the compiled program actually contained.
 *
 *  `node_modules`/`dist` are excluded because they are INSTALLED or BUILT, not authored: a
 *  project's own `node_modules/@capacitor/**\/*.d.ts` gets pulled in once one of its real sources
 *  is in the program, and counting them overstates coverage (games/3d-test read 54 against 37
 *  authored files). The number this prints should be the quantity it claims to be. */
export function countProgramFiles(listed, dirAbs) {
  const prefix = `${toPosix(dirAbs)}/`;
  return listed.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(prefix))
    .filter((l) => !l.includes('/node_modules/') && !l.includes('/dist/'))
    .length;
}

/** ⚠️ The OTHER half of the coverage check, and the half that proves the config is SCOPED.
 *
 *  Counting only the project's own files proves inclusion, never exclusion — so `buildInclude`
 *  returning the WIDE shape (`['app', '../games', '../demos']`, a plausible "fix" for a
 *  cross-project resolution error) leaves every project reporting a healthy file count, all
 *  green, with this leg silently reduced to `npm run typecheck` run once per project and #24's
 *  mask fully restored. Measured: that mutation passes 29/29 against the inclusion check alone.
 *
 *  Returns the labels of OTHER projects whose files reached this program. */
export function foreignProjects(listed, projects, self) {
  const found = new Set();
  const lines = listed.split('\n').map((l) => l.trim());
  for (const proj of projects) {
    const label = `${proj.root}/${proj.name}`;
    if (label === self) continue;
    const prefix = `${toPosix(proj.dir)}/`;
    if (lines.some((l) => l.startsWith(prefix))) found.add(label);
  }
  return [...found];
}

/** The ONE sanctioned cross-project import in the repo, so `foreignProjects` does not false-red
 *  on it: `games/chess` reaches into `games/llm-test` (CLAUDE.md § Games must be SELF-CONTAINED,
 *  "one allowlisted exception, pending extraction").
 *
 *  ⚠️ A hand-kept copy of `KNOWN_ESCAPES` in engine/tests/assets/gamePortability.test.ts, and it
 *  is guarded rather than trusted: typecheckProjectsSelection.test.ts derives the project pairs
 *  from that Set and asserts they agree with this map, so adding or extracting an escape reddens
 *  instead of silently widening (or falsely narrowing) this gate. */
export const KNOWN_CROSS_PROJECT = { 'games/chess': ['games/llm-test'] };

/** On failure, `err.stdout` carries the whole `--listFiles` dump ahead of the diagnostics —
 *  ~2400 absolute paths per project, which would bury one real type error inside verify's report.
 *  Diagnostics are relative (`games/x/y.ts(2,35): error TS2304: …`), so dropping absolute-path
 *  lines keeps every error and none of the noise. */
export function stripFileList(text) {
  return text.split('\n').filter((l) => !/^(\/|[A-Za-z]:\/)/.test(l.trim())).join('\n');
}
