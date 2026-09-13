/** Type sidecar for `publishPreflight.mjs` — see that file for the design rationale (#827). */

export type OtaPublishRefusal =
  | 'no-ota-block'
  | 'not-enabled'
  | 'bad-version'
  | 'bad-name'
  | 'bad-key-name'
  | 'bad-bucket'
  | 'bad-project-bundle-name'
  | 'bad-project-subgames'
  | 'bad-project-retain-versions'
  | 'ambiguous-bundle'
  | 'unknown-bundle'
  | 'key-missing'
  | 'key-unparseable'
  | 'no-key-public-half'
  | 'project-public-key-empty'
  | 'mismatch';

export const OTA_PUBLISH_REFUSALS: readonly OtaPublishRefusal[];

export type OtaPublishTarget = { kind: 'shell' } | { kind: 'subgame'; id: string };

export function otaPublishTarget(
  name: string,
  ota: { bundleName: string; subgames: readonly string[] },
): OtaPublishTarget | null;

export function otaPublishPreflight(o: {
  ota: unknown;
  name: string | null | undefined;
  version: string | null | undefined;
  keyName: string | null | undefined;
  bucket: string | null | undefined;
  repoRoot: string;
}):
  | {
    ok: true;
    target: OtaPublishTarget;
    keypair: { publicKey: string; privateKey: string };
    keyPath: string;
    bundleName: string;
    subgames: string[];
    retainVersions: number;
    name: string;
    version: string;
    keyName: string;
    bucket: string;
  }
  | {
    ok: false;
    refusal: OtaPublishRefusal;
    bundleName?: string;
    subgames?: string[];
    keyPath?: string;
    keyPublicKey?: string | null;
  };

/** The raw `ota` block of `<projectRoot>/project.config.json`, read the same way for both entry points. */
export function readRawOtaBlock(projectRoot: string):
  | { ok: true; file: string; ota: unknown }
  | { ok: false; file: string; reason: 'missing' | 'unparseable'; error?: string };
