/** Pure layout-name helpers, factored out of EditorApp so they're unit-testable
 *  without dragging in the whole editor (FlexLayout, panels, Three.js). Used by
 *  the Save-Layout-As + import-from-file flows. */

import type { IJsonModel } from 'flexlayout-react';

/** Reserved name for the auto-saved "last session" recovery point. The user can
 *  never overwrite it via Save As / import — it's owned by the autosave loop. */
export const AUTOSAVE_NAME = 'autosave';

/** A flexlayout model JSON must have a top-level `layout` node. */
export function isLayoutJson(v: unknown): v is IJsonModel {
  return !!v && typeof v === 'object' && 'layout' in (v as object);
}

/** Sanitize a user-typed layout name for use as a filename stem: trim, replace
 *  any run of non-`[\w-]` with a single `-`, strip leading/trailing dashes. The
 *  reserved AUTOSAVE_NAME and the empty string yield '' (caller rejects). */
export function sanitizeLayoutName(raw: string): string {
  const name = raw.trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '');
  return name === AUTOSAVE_NAME ? '' : name;
}

/** Derive a layout name from an imported file's base name: strip the
 *  `.layout.json`/`.json` extension, sanitize like sanitizeLayoutName, and fall
 *  back to 'imported' for an empty or reserved result. */
export function deriveLayoutBaseName(fileName: string): string {
  const base = fileName.replace(/\.layout\.json$|\.json$/i, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'imported';
  return base === AUTOSAVE_NAME ? 'imported' : base;
}

/** Sanitize a layout name for use as an EXPORT filename stem — unlike
 *  `sanitizeLayoutName`, this does NOT reject the reserved AUTOSAVE_NAME (a
 *  downloaded file is not a write into the project's named-layout store, so
 *  "autosave.layout.json" is a perfectly valid filename). */
export function sanitizeExportFileName(raw: string): string {
  return raw.trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'layout';
}
