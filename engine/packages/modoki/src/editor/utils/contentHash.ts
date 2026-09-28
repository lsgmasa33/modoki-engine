/** SHA-256 of the UTF-8 encoding of a string, hex-encoded lowercase (#469).
 *
 *  This is the CLIENT half of the `ifMatch` precondition on `POST /api/asset-write`
 *  (`editorBackendRouter.ts`), threaded by `atlasPersist.ts`, and on `POST /api/write-file`,
 *  threaded by every prefab write (`commitPrefabWrite`, #1664/#1692). The server hashes the raw file bytes with Node's
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

/** The sha256 of a file's BYTES in the route's own terms: `ifMatchRefusal` (editorBackendRouter.ts) hashes what is on
 *  disk with a leading UTF-8 BOM stripped, so this strips one too — or a file that starts with `EF BB BF` (a `.mtl`, a
 *  `.csv`, any text a Windows tool saved) gets a precondition no route hash can ever meet (#1679 close-out review). */
export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(body));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The `ifMatch` for a file a caller wrote with `/api/write-file`'s `content`/`encoding` pair (#1679): the hash of the
 *  BYTES that pair puts on disk — for `'base64'` the decoded binary, not the base64 text — in `sha256OfBytes`' terms.
 *  Hashing the text would match nothing the route ever sees, and every guarded undo of an import would refuse. */
export async function sha256OfWritten(content: string, encoding?: 'base64'): Promise<string> {
  if (encoding !== 'base64') return sha256OfBytes(new TextEncoder().encode(content));
  const bin = atob(content);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return sha256OfBytes(bytes);
}
