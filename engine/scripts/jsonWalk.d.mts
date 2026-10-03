/** Type sidecar for jsonWalk.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

/** Visit every plain object in a parsed scene / prefab document, at any depth, parents before
 *  children; `at` is a breadcrumb (`root.entities[3].members["/a"].traits`). */
export function walkObjects<T extends object = Record<string, unknown>>(json: unknown, visit: (obj: T, at: string) => void, at?: string): void;
