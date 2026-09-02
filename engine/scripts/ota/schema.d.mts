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
  /** sha256 of each bundle's CURRENT-version manifest, canonically serialized (Phase 2).
   *  Optional — a release without it is still valid. */
  manifests?: Record<string, string>;
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
  manifests?: Record<string, string>;
}): OtaReleaseUnsigned;
export function signingPayload(release: OtaRelease | OtaReleaseUnsigned): string;
export function manifestHashPayload(manifest: OtaManifest): string;
