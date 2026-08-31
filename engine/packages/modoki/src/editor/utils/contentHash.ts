/** SHA-256 of the UTF-8 encoding of a string, hex-encoded lowercase (#469).
 *
 *  This is the CLIENT half of the `ifMatch` precondition on `POST /api/write-file`
 *  (`editorBackendRouter.ts`): the server hashes the raw file bytes with Node's
 *  `crypto.createHash('sha256')`, and both sides must agree on the same bytes for the
 *  same content, or every conditional write reports a spurious conflict. Kept here —
 *  not inlined in one panel — so any future conditional-write caller hashes the same
 *  way as the one that motivated it (`atlasPersist.ts`). Also used by `modelImport.ts`
 *  for content-addressed extracted-texture filenames (#490 review finding 4 — that was a
 *  byte-identical local copy until it was folded into this one). Pinned against Node's
 *  own hash in `tests/editor/contentHash.test.ts`. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
