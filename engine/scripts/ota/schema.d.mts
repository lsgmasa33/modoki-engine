export const SCHEMA_VERSION: number;

export interface OtaFileEntry {
  hash: string;
  size: number;
}

export interface OtaManifest {
  schema: number;
  name: string;
  version: string;
  engineApi: number;
  files: Record<string, OtaFileEntry>;
  /** The whole-bundle zip the native OTA client downloads directly (Phase 1). Optional —
   *  a Phase 0 manifest without it is still valid. */
  bundleZip?: OtaFileEntry;
}

export interface OtaRelease {
  schema: number;
  bundles: Record<string, string>;
  mandatory: boolean;
  minEngineApi: number;
  sig: string;
}

export type OtaReleaseUnsigned = Omit<OtaRelease, 'sig'>;

export function validateManifest(manifest: unknown): string[];
export function validateRelease(release: unknown): string[];
export function createManifest(args: {
  name: string;
  version: string;
  engineApi: number;
  files: Record<string, OtaFileEntry>;
  bundleZip?: OtaFileEntry;
}): OtaManifest;
export function createRelease(args: {
  bundles: Record<string, string>;
  mandatory: boolean;
  minEngineApi: number;
}): OtaReleaseUnsigned;
export function signingPayload(release: OtaRelease | OtaReleaseUnsigned): string;
