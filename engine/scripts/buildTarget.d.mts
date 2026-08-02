/** Type sidecar for `buildTarget.mjs` — see that file for the design rationale. Hand-written
 *  because the module is plain JS (build-web.mjs is a Node script that cannot import
 *  TypeScript), but engine/tests/plugins/buildTargetParse.test.ts imports it directly for unit
 *  coverage and is typechecked via engine/tsconfig.test.json. */

/** Valid `--target` values for engine/scripts/build-web.mjs. */
export declare const VALID_TARGETS: readonly ['web', 'native', 'playable'];

export interface ParseBuildTargetOk {
  ok: true;
  target: string;
  childEnv: Record<string, string>;
}

export interface ParseBuildTargetFail {
  ok: false;
  message: string;
}

export declare function parseBuildTarget(
  argv: string[],
  env: Record<string, string | undefined>,
): ParseBuildTargetOk | ParseBuildTargetFail;
