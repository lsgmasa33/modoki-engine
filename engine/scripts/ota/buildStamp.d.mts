/** Type sidecar for `buildStamp.mjs` — see that file for the design rationale (#906).
 *  The export SET here is guarded against the implementation; keep them in step. */

export interface BuildStamp {
  commit: string | null;
  dirty: boolean | null;
}

export interface OtaManifestBuild {
  commit: string | null;
  dirty: boolean | null;
  forced: boolean;
}

export const BUILD_STAMP_FILENAME: string;
export function isCommitSha(value: unknown): boolean;
export function readHeadCommit(dir: string): string | null;
export const PROVENANCE_PATHSPEC: readonly string[];
export function readGitProvenance(dir: string): BuildStamp;
export function settleBuildStamp(start: BuildStamp, endCommit: string | null): BuildStamp;
export function writeBuildStamp(distDir: string, stamp: BuildStamp): void;
export function otaBuildProvenance(o: { stampText: string | null; allowUnclean: boolean }):
  | { build: OtaManifestBuild; refusal?: undefined }
  | { refusal: 'no-stamp' | 'bad-stamp' | 'unknown-tree' | 'dirty'; build?: undefined };
