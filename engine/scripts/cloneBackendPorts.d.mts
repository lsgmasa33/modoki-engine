/** Type sidecar for cloneBackendPorts.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step.
 *  `editorPorts.d.mts` declares the same three names, because `editorPorts.mjs` re-exports them. */

/** Clone directory basename → pinned editor backend port. */
export declare const CLONE_BACKEND_PORTS: Readonly<Record<string, number>>;

/** Pinned backend port for the clone at `repoRoot`, or `null` when it is not a known clone. */
export declare function backendPortForClone(repoRoot: string): number | null;

/** Backend URL for the clone at `repoRoot`, or `null` when it is not a known clone. */
export declare function backendUrlForClone(repoRoot: string): string | null;
