/** Type sidecar for editorPorts.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step.
 *
 *  NOT the same thing as `clonePort.d.mts` (singular): that one HASHES a repo path into a
 *  harness port range (#69, test/smoke lanes outside the human range). This one is the PINNED
 *  human-editor table from docs/clones-and-ports.md § RULE 2 (#349). */

/** Clone directory basename → pinned editor backend port. */
export declare const CLONE_BACKEND_PORTS: Readonly<Record<string, number>>;

/** The integration hub's backend port (5179). */
export declare const HUB_BACKEND_PORT: number;

/** Pinned backend port for the clone at `repoRoot`, or `null` when it is not a known clone. */
export declare function backendPortForClone(repoRoot: string): number | null;

/** Vite dev-server port derived from a backend port: `5173 + (backend - 5179)`. */
export declare function vitePortForBackend(backendPort: number): number;

/** CDP remote-debugging port derived from a backend port: `9222 + (backend - 5179)`. */
export declare function cdpPortForBackend(backendPort: number): number;

/** CDP port for a single-instance launch with no pinned backend (an unknown clone). */
export declare function unpinnedCdpPort(repoRoot: string): number;

/** Backend URL for the clone at `repoRoot`, or `null` when it is not a known clone. */
export declare function backendUrlForClone(repoRoot: string): string | null;
