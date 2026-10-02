/** Type sidecar for `keyStore.mjs` — see that file for where an OTA key lives and how a legacy one is adopted (#1983). */

export function projectKeyPath(projectRoot: string, name: string): string;

export function ensureKeyDir(projectRoot: string): string;

export function legacyKeyDirs(o: { projectRoot: string; editorRoot?: string | null }): string[];

export function restrictToOwner(file: string): void;

/** A key file read as a keypair, checked to BE one (its private half derives its public half, #1993). */
export function readKeypair(file: string):
  | { ok: true; keypair: { publicKey: string; privateKey: string } }
  | { ok: false; reason: 'unreadable'; error: string }
  | { ok: false; reason: 'no-public-half' }
  | { ok: false; reason: 'not-a-pair'; publicKey: string };

/** The project's own key file (any name) whose pair is `publicKey`'s, or null. */
export function heldKeyFor(projectRoot: string, publicKey: unknown): string | null;

export function adoptLegacyKey(o: {
  projectRoot: string;
  editorRoot?: string | null;
  name: string;
  expectedPublicKey?: unknown;
  /** False when project.config.json could not be read: a same-named legacy key is then refused, never passed over. */
  configReadable: boolean;
  log?: (line: string) => void;
}): { keyPath: string; copiedFrom: string | null; passedOver: { from: string; reason: string }[] };
