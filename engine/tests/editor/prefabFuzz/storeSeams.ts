/** The store's seams for the #2009 checks (`shadow.ts`; #2001, design § 6, § 10.5): the real `InstanceStore`, and which of
 *  its records no check compares. The harness checks that the store covers every live stored root, and P1 and P5 compare
 *  each record it does not skip.
 *
 *  From S4 to #2001 S8b these seams also gave I25 the old capture of each instance (`parse(captureInstanceEntry(live))`)
 *  and translated the rules' side where that capture could not state it (rule 3's kept records, G2, #1942, #1829, #1931).
 *  I25 went with the capture's last reader; so did the translations. */

import { getCurrentWorld, getTraitByName } from '@modoki/engine/runtime';
import { storedInstances } from '../../../packages/modoki/src/runtime/prefab/instanceStore';
import { editorPrefabReader } from '../../../packages/modoki/src/editor/instance/instanceSync';
import { allStoredRoots, guidOfEntity, outermostStoredRoot } from '../../../packages/modoki/src/editor/instance/instanceKeys';
import type { ShadowSeams } from './shadow';
import { getCachedPrefabSync } from '../../../packages/modoki/src/editor/scene/prefabCache';
import { findEntityById } from '../../../packages/modoki/src/runtime/core/ecs/world';
import { unresolvedRefOf } from '../../../packages/modoki/src/runtime/core/unresolvedPrefabRef';

/** The live stored root whose guid is `rootGuid`, or undefined. */
function liveRootOf(rootGuid: string): number | undefined {
  return allStoredRoots().find((id) => guidOfEntity(id) === rootGuid);
}

export const storeSeams: ShadowSeams = {
  records: () => [...storedInstances(getCurrentWorld()).values()].map((s) => s.record),
  skip(rec) {
    // A prefab the reader cannot give (a placeholder's): the record holds its file's legacy channels verbatim (format
    // rule: a record that cannot be named is held), and nothing projects it.
    if (!('doc' in editorPrefabReader(rec.source))) return 'its prefab is unresolved';
    // A prefab trashed in this world (its frame kept live, #1862), this instance's or its outermost instance's: the
    // runtime cache still names it, but the save writes the tree from its frame record.
    if (!getCachedPrefabSync(rec.source)) return 'its prefab is trashed (the save keeps its frame, #1862)';
    const id = liveRootOf(rec.rootGuid);
    const top = id !== undefined ? outermostStoredRoot(id) || id : undefined;
    const topEnt = top !== undefined ? findEntityById(top) : undefined;
    const topSource = topEnt && !unresolvedRefOf(topEnt as never) ? (topEnt.get(getTraitByName('PrefabInstance')!.trait) as { source?: string } | undefined)?.source : undefined;
    if (topSource && !getCachedPrefabSync(topSource)) return 'its outermost instance\'s prefab is trashed (the save keeps that frame, #1862)';
    // …or a frame BETWEEN them (an instance nested in a trashed prefab's frame, hunt seed 8110).
    const pi = getTraitByName('PrefabInstance')!;
    for (let a = id !== undefined ? findEntityById(id) : undefined, n = 0; a && n < 1024; n++) {
      const ea = a.get(getTraitByName('EntityAttributes')!.trait) as { parentId?: number } | undefined;
      const src = !unresolvedRefOf(a as never) ? (a.get(pi.trait) as { source?: string } | undefined)?.source : undefined;
      if (src && !getCachedPrefabSync(src)) return 'an enclosing frame\'s prefab is trashed (the save keeps that frame, #1862)';
      a = ea?.parentId ? findEntityById(ea.parentId) : undefined;
    }
    return undefined;
  },
};
