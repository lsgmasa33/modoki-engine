/** Type sidecar for jsonFile.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** `text` without a leading U+FEFF. */
export declare function stripBom(text: string): string;

/** `JSON.parse` of text read from a file, BOM stripped first. */
export declare function parseJsonText(text: string): any;

/** Read and parse a JSON file; throws when it is missing or does not parse. */
export declare function readJsonFile(file: string | number): any;

export type JsonFileRead =
  | { ok: true; value: any }
  | { ok: false; reason: 'absent' | 'unreadable' | 'unparsable'; error: unknown };

/** Read and parse a JSON file, telling a missing file from an unreadable or unparsable one. */
export declare function tryReadJsonFile(file: string | number): JsonFileRead;
