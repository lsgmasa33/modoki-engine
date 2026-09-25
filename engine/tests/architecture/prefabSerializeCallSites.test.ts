/** Every production caller of `serializePrefab` is ENUMERATED here, each with the source of the file
 *  guid it writes under — because a caller that forgets to supply one mints a fresh guid over a
 *  prefab that already exists, and every scene whose `PrefabInstance.source` names the old id is
 *  orphaned outright. No error, no repair pass, no mitigation.
 *
 *  WHY A CENSUS AND NOT A PROPERTY. The obvious guard — "every call passes a second argument" — is
 *  wrong in both directions. `assetOps`' Create Prefab deliberately passes `undefined`: it serializes
 *  a DRAFT before the human has chosen a destination, and the kept guid arrives later through
 *  `writeNewAssetDocument`'s `build(guid, kept)` callback. Meanwhile a call that passes
 *  `getGuidForPath(path) || undefined` satisfies the property and is still wrong, because the
 *  manifest has not indexed a freshly scanned file — which is exactly the defect `skinPrefab` carried
 *  (#1468). So the thing worth pinning is not the shape of the argument but that somebody LOOKED: a
 *  new call site fails this test and its author has to add a row saying where its id comes from.
 *
 *  This is the `family/one-entry-point` shape stated from the other end. #1468's survey found five
 *  writers, four of which silently renumbered a live document; two of them — the Assets panel's model
 *  import and the Skin Editor's update — were also minting a fresh FILE guid. Both are fixed, and a
 *  sixth writer arriving unnoticed is the way that comes back.
 *
 *  ⚠️ The census scope deliberately includes `engine/app/`. A scan limited to
 *  `engine/packages/modoki/src` reports five sites and misses `agentEditorOps.ts` — a mistake made
 *  once already while verifying this very table (#1468 design record, the root cause). */

import { describe, it, expect } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

/** rel path → how that call site gets the file guid it writes under. */
const CALL_SITES: Record<string, string> = {
  'engine/packages/modoki/src/editor/scene/prefabEdit.ts':
    'the open edit session\'s own guid (`editingPrefab.guid`), plus preserveLocalIds/preserveNodeGuids from the baseline document',
  'engine/packages/modoki/src/editor/scene/skinPrefab.ts':
    'classifyExistingPrefabId(savePath) — manifest, then the on-disk id; refuses an unreadable file',
  'engine/packages/modoki/src/editor/panels/Assets.tsx':
    'classifyExistingPrefabId(prefabPath) — the model-import path; refuses an unreadable file',
  'engine/packages/modoki/src/editor/panels/assetViews/ModelAssetView.tsx':
    'classifyExistingPrefabId(prefabPath) — the rigged re-import path; the merge then carries node identity',
  'engine/packages/modoki/src/editor/panels/assetOps.ts':
    'DELIBERATELY none: a draft serialized before the destination is chosen. writeNewAssetDocument '
    + 'supplies the kept guid to build(guid, kept). ⚠️ Node identity therefore MINTS on a Replace even '
    + 'when the live tree is an instance of the prefab being replaced — stated rather than hidden. '
    + 'The consequence is bounded and is the one the design chose: a stored key naming an old row '
    + 'DANGLES, where positional renumbering would have repointed it at a different member.',
  'engine/app/editor/agentEditorOps.ts':
    'classifyExistingPrefabId(path) — throws rather than minting, so the agent sees the refusal',
};

function productionSources(): { rel: string; abs: string }[] {
  return repoFiles({ under: 'engine', match: /\.tsx?$/, floor: 500 })
    .filter(({ rel }: { rel: string }) => !/[\\/]tests?[\\/]|\.test\.tsx?$/.test(rel))
    // The module that DEFINES it, and the barrel that re-exports it, call nothing.
    .filter(({ rel }: { rel: string }) => !rel.endsWith('editor/scene/prefab.ts'))
    .filter(({ rel }: { rel: string }) => !rel.endsWith('editor/index.ts'));
}

/** Files whose CODE calls `serializePrefab(` — comments stripped, so a docblock naming it is not a
 *  call site (`commentStripperIsShared.test.ts` owns that entry point). */
function callers(): string[] {
  return productionSources()
    .filter(({ abs }) => readScannedSource(abs).code.includes('serializePrefab('))
    .map(({ rel }: { rel: string }) => rel)
    .sort();
}

describe('every serializePrefab caller says where its file guid comes from (#1468)', () => {
  it('the census matches the code, in both directions', () => {
    const found = callers();
    const declared = Object.keys(CALL_SITES).sort();
    const undeclared = found.filter((f) => !(f in CALL_SITES));
    const stale = declared.filter((f) => !found.includes(f));
    expect(undeclared, 'a new serializePrefab caller — add a row to CALL_SITES saying where its file '
      + 'guid comes from. If the answer is "it mints one", say so and say what that orphans:\n  '
      + undeclared.join('\n  ')).toEqual([]);
    expect(stale, 'CALL_SITES names a file that no longer calls serializePrefab — drop the row:\n  '
      + stale.join('\n  ')).toEqual([]);
  });

  it('the scan sees real callers — otherwise the census above is vacuous', () => {
    // A guard that matches nothing passes forever, and a comment-stripping scan is exactly the kind
    // that can silently start matching nothing (a rename, a re-export, a helper indirection).
    expect(callers().length).toBeGreaterThanOrEqual(5);
  });

  it('every row names a real source of the guid, not an empty string', () => {
    for (const [file, how] of Object.entries(CALL_SITES)) {
      expect(how.length, `${file} has an empty reason`).toBeGreaterThan(20);
    }
  });
});
