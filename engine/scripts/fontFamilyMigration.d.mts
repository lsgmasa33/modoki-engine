/** Type sidecar for fontFamilyMigration.mjs — see engine/tests/architecture/mjsTypeSidecars.test.ts.
 *  The export SET here is guarded against the implementation; keep them in step. */

export interface FontFamilyMigration {
  /** Something in the document was rewritten. */
  dirty: boolean;
  /** How many `UIElement.fontFamily` values were rewritten. */
  refs: number;
  /** Each family the index did not know, once per occurrence. */
  unmatched: string[];
}

/** Rewrite, in place, every `UIElement.fontFamily` naming a family `index` knows (family → font
 *  asset GUID), at any depth, and retype the `resources[]` entry of each family it migrated. */
export function migrateFontFamilies(json: unknown, index: ReadonlyMap<string, string>): FontFamilyMigration;
