/** Type sidecar for `releaseBranch.mjs` — see that file for the design rationale.
 *  Hand-written for the same reason as `pathIdentity.d.mts`: the module is plain JS because the
 *  shell publisher invokes it as a CLI and cannot import TypeScript, but a test imports it and is
 *  typechecked. */

/** A release version split into its three numeric components, or why it is not one.
 *  `'not-semver-triple'` covers everything that is not exactly `X.Y.Z` — a prerelease
 *  (`0.7.0-rc.1`), build metadata, a `v` prefix, or junk. */
export type ReleaseVersion =
  | { ok: true; major: string; minor: string; patch: string }
  | { ok: false; reason: 'not-semver-triple' };

/** Which precondition failed, or `'ok'`. `'bad-version'` — not a semver core `X.Y.Z`; `'detached'` —
 *  no branch checked out; `'wrong-branch'` — on a branch other than the derived one; `'branch-version-skew'` — on a release
 *  branch for a DIFFERENT version, i.e. the gap between cutting it and bumping `package.json`; `'dirty'` —
 *  tracked files differ from HEAD; `'untracked-overlay'` — untracked files under `oss/`, which DO
 *  ship via the overlay's unfiltered rsync; `'version-mismatch'` — an explicit `--version` disagrees
 *  with `package.json`.
 *
 *  Checked in this order — `bad-version`, `detached`, `branch-version-skew`, `wrong-branch`,
 *  `dirty`, `untracked-overlay`, `version-mismatch` — so a dirty tree on the wrong branch reports
 *  the branch. (An earlier version of this list said "ordered as checked" while listing
 *  `wrong-branch` before the skew case, which the code checks first.) */
export type ReleaseStateCode =
  | 'ok'
  | 'bad-version'
  | 'detached'
  | 'wrong-branch'
  | 'branch-version-skew'
  | 'dirty'
  | 'untracked-overlay'
  | 'version-mismatch';

/** The verdict shape. An object, and callers branch on `.ok` — never on the verdict's truthiness,
 *  since both an object and a message string are always truthy. */
export interface ReleaseStateVerdict {
  ok: boolean;
  code: ReleaseStateCode;
  /** Human-facing, multi-line, and names BOTH what was expected and what was found. */
  message: string;
}

/** `'0.7.0'` → `'release_0_7_0'`; `null` when the version is not a plain `X.Y.Z`.
 *  Underscores rather than `release/0.7.0` because `release/v*` is already this repo's annotated-tag
 *  namespace — see the `.mjs`. */
export declare function releaseBranchFor(version: string): string | null;

/** Parse a release version, or report why it is not one. */
export declare function parseReleaseVersion(version: string): ReleaseVersion;

/** The preconditions for publishing a release snapshot, as one verdict.
 *  `branch` is `git branch --show-current` output — the empty string when HEAD is detached.
 *  `dirty` means TRACKED files differ from HEAD (staged or unstaged).
 *
 *  ⚠️ Untracked files are not `dirty` — EXCEPT under `oss/`, which is what `untrackedOverlay`
 *  carries. An earlier version of this docblock said untracked files are never dirty "because the
 *  publisher's manifest is `git ls-files`". That is true of the manifest copy and FALSE of the
 *  overlay step, which rsyncs the `oss/.github/` DIRECTORY with no filter. */
export declare function checkReleaseState(state: {
  version: string;
  branch: string;
  dirty: boolean;
  /** Untracked files exist under `oss/`. Unlike untracked files elsewhere, these DO ship — the
   *  overlay step is a directory-wide rsync with no manifest filter. */
  untrackedOverlay?: boolean;
  /** `package.json`'s version, when the caller knows it, so an explicit `--version` that disagrees
   *  with the tree it publishes is refused. Omitted means "not checked", not "differs". */
  manifestVersion?: string;
}): ReleaseStateVerdict;

/** The `wip/*` claim label for a branch — `docs/task-claiming.md`'s branch→label mapping as code.
 *  Identity for the six clone branches; **`release_*` → `wip/main`**, because a release branch is
 *  the hub wearing a different hat rather than a seventh clone. `null` when no branch is checked
 *  out, so a caller cannot paste a bogus label. See the `.mjs` for the #39 scar it prevents. */
export declare function claimLabelFor(branch: string): string | null;
