/** Type sidecar for entryPoint.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** Is the module identified by `moduleUrl` the one Node was told to run, rather than one it
 *  imported? Pass `import.meta.url`. Canonicalises both sides (so a symlinked, `subst`ed or
 *  8.3-shortened repo still matches) and does NOT case-fold — both operands exist by
 *  construction, so `.native` has already normalised their casing (#910).
 *
 *  Returns `false` rather than throwing when there is no `argv[1]` (`node --eval`) or when
 *  `moduleUrl` is not a `file:` URL — this runs at module load, where a throw would break the
 *  IMPORT rather than decline CLI mode. */
export declare function isEntryPoint(moduleUrl: string): boolean;
