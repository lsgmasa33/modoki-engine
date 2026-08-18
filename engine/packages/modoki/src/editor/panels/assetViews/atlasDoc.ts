/** `.atlas.json` read/write helpers for AtlasAssetView — pure, so the round-trip is
 *  unit-testable without mounting the panel.
 *
 *  The panel only EDITS the authored pack fields (members / pageSize / padding /
 *  extrude / maxPages), but the file legitimately carries more than that: a top-level
 *  `texture` block (format / maxSize / mipmaps / wrapS / wrapT / colorspace) decides how
 *  the packed page is actually encoded. Normalizing the file into a typed struct and
 *  writing that struct back DELETED every key the struct did not name — one add-member
 *  click was enough to strip the texture block off disk, silently, with members[]
 *  byte-identical. So the untouched keys are carried through the round-trip verbatim,
 *  in their original order. */

export interface AtlasSourceDoc {
  id?: string;
  version?: number;
  members: string[];
  pageSize: number;
  padding: number;
  extrude: number;
  maxPages?: number;
}

export const DEFAULT_ATLAS_DOC: AtlasSourceDoc = { members: [], pageSize: 1024, padding: 2, extrude: 1 };

/** Normalize the authored fields out of a parsed `.atlas.json`. */
export function parseAtlasDoc(raw: Partial<AtlasSourceDoc> | null | undefined): AtlasSourceDoc {
  const d = raw ?? {};
  return {
    id: d.id, version: d.version,
    members: Array.isArray(d.members) ? d.members.filter((m): m is string => typeof m === 'string') : [],
    pageSize: typeof d.pageSize === 'number' ? d.pageSize : DEFAULT_ATLAS_DOC.pageSize,
    padding: typeof d.padding === 'number' ? d.padding : DEFAULT_ATLAS_DOC.padding,
    extrude: typeof d.extrude === 'number' ? d.extrude : DEFAULT_ATLAS_DOC.extrude,
    ...(typeof d.maxPages === 'number' ? { maxPages: d.maxPages } : {}),
  };
}

/** Serialize the edited struct back over the file we read, so keys the panel does not
 *  model (`texture`, and anything a later format version adds) survive. Spreading `raw`
 *  FIRST also preserves the original key order — a rewrite that reorders keys is a
 *  noisy diff, and this file is committed. Ends with a newline, like every other file
 *  in the repo. */
export function serializeAtlasDoc(raw: Record<string, unknown>, doc: AtlasSourceDoc): string {
  const merged: Record<string, unknown> = { ...raw, ...doc, version: 1 };
  // `maxPages: undefined` means "cleared" — JSON.stringify drops it, which is the intent,
  // but only if the key is present-and-undefined rather than inherited from `raw`.
  if (doc.maxPages === undefined) delete merged.maxPages;
  return JSON.stringify(merged, null, 2) + '\n';
}
