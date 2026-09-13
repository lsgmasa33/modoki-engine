/** Type sidecar for `pruneBundle.mjs` — see that file for the design rationale (#836).
 *  The export SET here is guarded against the implementation; keep them in step. */

export interface GcloudResult { ok: boolean; stdout: string; stderr: string }

export interface PrunePlan {
  keep: string[];
  remove: string[];
  incomplete: string[];
  unknownAge: string[];
  recent: string[];
}

export const PRUNE_GRACE_MS: number;
export function runGcloud(args: string[]): GcloudResult;
export function parseVersionPrefixes(stdout: string, bundlePrefix: string): string[];
export function parseManifestListing(jsonText: string, bundlePrefix: string): Map<string, number | null>;
export function planPrune(o: {
  versions: string[];
  created: Map<string, number | null>;
  pointer: string | undefined;
  keep: number;
  now: number;
  graceMs?: number;
}): PrunePlan;
export function pruneBundleVersions(o: {
  bucket: string;
  name: string;
  keep: number;
  dryRun?: boolean;
  gcloud?: (args: string[]) => GcloudResult;
  maxAttempts?: number;
  now?: number;
  graceMs?: number;
}):
  | { ok: true; plan: PrunePlan; removed: string[]; error?: undefined }
  | { ok: false; error: string; plan?: PrunePlan; removed: string[] };
