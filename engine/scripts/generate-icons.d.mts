/** Types for `generate-icons.mjs`'s testable internals (the module is plain Node so the build
 *  step can run it directly; only the collateral-cleanup logic is imported by tests). */
export declare function collect(dir: string, skipPrefix: string, out?: Map<string, Buffer>): Map<string, Buffer>;
export declare function newFilesOutsideScope(dir: string, skipPrefix: string, snapshot: Map<string, Buffer>): string[];
export declare function restoreSnapshot(snapshot: Map<string, Buffer>, projectRoot: string): { restored: string[]; failed: string[] };
