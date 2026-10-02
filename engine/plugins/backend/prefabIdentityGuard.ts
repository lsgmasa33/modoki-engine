/** The prefab IDENTITY gate of the backend's raw write routes (#1937 C-A step 6). Its own module, imported by the router
 *  alone: `prefabWriteGuard.ts` is in the Node program `vite.config.ts` compiles (no DOM), and the admission it asks pulls
 *  the runtime's types. */

import { admitPrefabDocument } from '../../packages/modoki/src/runtime/loaders/documentIdentity';
import { frameRepeatRefusal } from '../../packages/modoki/src/runtime/loaders/frameRepeat';
import { isPrefabDocument } from '../../packages/modoki/src/runtime/loaders/prefabDocumentShape';
import { isPrefabPath } from '../prefabWriteGuard';
import { parseJsonText } from '../../scripts/jsonFile.mjs';

/** Why writing `incoming` (a prefab document's text, or the document itself) to `absPath` is refused — asked by
 *  `/api/write-file`, the one raw route a prefab reaches disk by (`/api/asset-write` takes no prefab type): it declares a
 *  localId, nodeGuid or template key twice (#1937 C-A step 6, owner ruling F-D: an agent write that introduces one is
 *  refused with the reason, so it is fixed before anything breaks), or a nested row states a channel in a shape no reader
 *  takes (#1948 F3, `prefab-channel-malformed`). Every seat refuses such a document, and every
 *  instance of it would become a Damaged Prefab placeholder. Null for a non-prefab path, unparseable text (the format
 *  rules own that), or an admissible document — keyless template nodes included: the seats mint their keys.
 *
 *  And a key the document's EXPANSION gives one frame twice (#1933 L5; close-out review #6), asked of the derive walk
 *  over the nested documents `read` serves (the router's `makePrefabResolver`, admitted as the seats read them): two of
 *  this document's lists anchored at members of one nested frame, which admission cannot see since it groups keys by
 *  anchor, or a node added at a nested row whose own document gives that key. The load, placement and a commit refuse
 *  that prefab too. Without `read`, same-document only. ⚠️ Synchronous, like the others here. */
export function classifyPrefabIdentityWrite(absPath: string, incoming: string | object, read?: (guid: string) => unknown): { message: string; reason: 'prefab-identifier-repeated' | 'prefab-channel-malformed' } | null {
  if (!isPrefabPath(absPath)) return null;
  let doc: unknown = incoming;
  if (typeof incoming === 'string') {
    try { doc = parseJsonText(incoming); } catch { return null; }
  }
  // Not a document at all is the format rules' to say (and a create-only write's own reason, #1273), not this gate's.
  if (!isPrefabDocument(doc)) return null;
  const admitted = admitPrefabDocument(doc);
  if ('refusal' in admitted) {
    return { message: `${absPath} was not written: ${admitted.refusal}.`, reason: admitted.malformed ? 'prefab-channel-malformed' : 'prefab-identifier-repeated' };
  }
  const repeat = read ? frameRepeatRefusal(admitted.doc, (g) => read(g) ?? null) : null;
  return repeat ? { message: `${absPath} was not written: ${repeat}.`, reason: 'prefab-identifier-repeated' } : null;
}

/** A prefab document a NODE reader parsed, read as every seat reads it (#1937 C-A step 7, I7): admitted, so a keyless
 *  template node carries the key the editor mints for it, and a guid this side predicts from it is the one the load
 *  derives. A document the seats refuse is `refused` — the remint and the inert-size check pass `undefined` (the load
 *  makes that instance a placeholder, expanding nothing), the validator passes the document as it is, so its template-key
 *  walk still reads it. (The validator reports a repeated template key; a repeated localId or nodeGuid it does not —
 *  close-out review #7, parked.) */
export function admittedPrefab(doc: unknown, refused: 'none' | 'raw'): unknown {
  if (!isPrefabDocument(doc)) return doc;
  const admitted = admitPrefabDocument(doc);
  return 'doc' in admitted ? admitted.doc : refused === 'raw' ? doc : undefined;
}
