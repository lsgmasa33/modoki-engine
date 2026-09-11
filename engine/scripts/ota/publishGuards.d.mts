/** Type sidecar for `publishGuards.mjs` — see that file for the design rationale.
 *  Hand-written because the module is plain JS, following the sibling `.d.mts` convention
 *  established by `schema.d.mts`/`signing.d.mts`. */

export function otaSigningKeyRefusal(
  keyPublicKey: string | null | undefined,
  projectPublicKey: string | null | undefined,
): 'no-key-public-half' | 'project-public-key-empty' | 'mismatch' | null;

export function otaBundleDistKindRefusal(o: {
  bundleName: string;
  projectBundleName: string;
  distIsSubgameModule: boolean;
}): 'subgame-name-with-shell-dist' | 'shell-name-with-subgame-dist' | null;

export function otaSubgameEngineApi(o: {
  stamped: unknown;
  requested: number | undefined;
  shellEngineApi: unknown;
}):
  | { engineApi: number; refusal?: undefined }
  | { refusal: 'stamped-invalid' | 'flag-mismatch' | 'shell-mismatch'; engineApi?: undefined };

export const OTA_DEFAULT_ENGINE_API: number;

export const OTA_DEFAULT_BUNDLE_NAME: string;
