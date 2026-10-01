/** Type sidecar for `keyStore.mjs` — see that file for where an OTA key lives and how a legacy one is adopted (#1983). */

export function projectKeyPath(projectRoot: string, name: string): string;

export function ensureKeyDir(projectRoot: string): string;

export function legacyKeyDirs(o: { projectRoot: string; editorRoot?: string | null }): string[];

export function restrictToOwner(file: string): void;

export function adoptLegacyKey(o: {
  projectRoot: string;
  editorRoot?: string | null;
  name: string;
  expectedPublicKey?: unknown;
  /** False when project.config.json could not be read: a same-named legacy key is then refused, never passed over. */
  configReadable: boolean;
  log?: (line: string) => void;
}): { keyPath: string; copiedFrom: string | null; passedOver: { from: string; reason: string }[] };
