/** Type sidecar for livePackagedEditor.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** One row of the process table: the EXECUTABLE path and the full argv, joined by pid. */
export interface ProcessRow {
  pid: number;
  /** The executable path. The only thing `isPackagedExecutable` is allowed to read. */
  exe: string;
  /** The full command line. Trusted ONLY to carry `--user-data-dir`, and only for a row already
   *  established to be a packaged editor — reading argv to decide *whether* it is one is #1037. */
  command: string;
}

export interface BlockingEditor extends ProcessRow {
  /** The user-data dir that placed this process inside one of the candidates. */
  userData: string;
}

export interface BlockingEditorOptions {
  productName: string;
  candidates: readonly string[];
  defaultUserData: string;
  platform?: string;
  /** Paths a live packaged editor holds regardless of its `--user-data-dir` because they are keyed
   *  on the BUNDLE ID. Resolve them against the REAL home (`os.userInfo().homedir`, which ignores
   *  `$HOME`) so a sandboxed run's redirected candidates cannot match. */
  sharedStatePaths?: readonly string[];
  /** Roots under which a bundle is a STAGED copy (a packaged smoke), not this machine's install.
   *  A flagless in-bundle helper below one of these is attributed there, not to our userData. */
  stagingRoots?: readonly string[];
}

/** Every plausible reading of `--user-data-dir`, most specific first — PLURAL because `ps` renders
 *  argv space-joined, so an unquoted value containing spaces cannot be told from a value followed
 *  by more arguments, and the macOS default contains two spaces. Blocking on ANY reading fails
 *  CLOSED; picking one fails open, which deletes a live app's state.
 *
 *  `[]` means "use the platform default" — absent, valueless, or empty — never "no state". */
export declare function userDataDirCandidatesFromCommand(command: string | null | undefined): string[];

/** Does this EXECUTABLE path belong to the packaged app? Anchored to `<name>.app/Contents/` on
 *  posix and to the exact `<name>.exe` leaf on win32, so a dev editor's `Electron.app` cannot
 *  match and neither can a process that merely mentions the path. */
export declare function isPackagedExecutable(
  exePath: string | null | undefined,
  productName: string,
  platform?: string,
): boolean;

/** The pure decision: which of these processes block a wipe of these candidates? */
export declare function blockingEditors(
  rows: readonly ProcessRow[] | null | undefined,
  opts: BlockingEditorOptions,
): BlockingEditor[];

/** The paths a live INSTALLED editor holds regardless of its `--user-data-dir` — bundle-id-keyed
 *  on darwin, product-name-keyed on win32. ⚠️ Resolved against the REAL home (`os.userInfo()`,
 *  which ignores `$HOME`), which is what keeps a sandboxed run — whose candidates move with `$HOME`
 *  — unable to match them. Returns `[]` rather than throwing when the uid has no passwd entry. */
export declare function sharedStatePaths(appId: string, productName: string, platform?: string): string[];

/** Roots under which a packaged bundle is a STAGED copy (a smoke) rather than an install. */
export declare function stagingRoots(): string[];

/** Enumerate every process. ⚠️ Returns `null` when the enumeration FAILED — not `[]`, which would
 *  read as "nothing is running" and let a delete proceed under a live app. */
export declare function listProcesses(platform?: string): ProcessRow[] | null;

/** `listProcesses` + `blockingEditors` — the question the CLI actually asks.
 *  ⚠️ `null` means the process table could not be read; the caller must refuse, not proceed. */
export declare function findBlockingEditors(opts: BlockingEditorOptions): BlockingEditor[] | null;
