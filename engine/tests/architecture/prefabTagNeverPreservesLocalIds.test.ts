/** A module must not both PRESERVE localIds and TAG a live tree as an instance — the two feed the
 *  one numbering procedure (`planPrefabRows`) DIFFERENT inputs, and the tagging side cannot pass a
 *  preserve map.
 *
 *  WHY THIS IS A GUARD AND NOT A COMMENT: #1278 was exactly this defect in its crudest form — the
 *  numbering existed twice, so the live `PrefabInstance.localId` values addressed different rows
 *  than the file just written, and the next save wrote overrides under an id denoting a different
 *  member. Nothing errored. The fix collapsed the two into `planPrefabRows`, which removes the
 *  duplication but NOT the ability to call it with mismatched arguments.
 *
 *  Today the property holds by accident of who calls what: the only `preserveLocalIds` caller is
 *  `prefabEdit.ts`'s `savePrefabEdit`, which never tags, and the only `tagEntityTreeAsInstance`
 *  callers (`assetOps.ts`, `agentEditorOps.ts`) never preserve. A plausible future feature —
 *  prefab-edit "save and relink the open instance" — would put both in one module and silently
 *  reintroduce #1278, because a preserved file numbering and a positional tag numbering diverge
 *  exactly when a member was deleted earlier and left a gap.
 *
 *  If you are here because this test failed: you cannot fix it by passing the preserve map to the
 *  tagging call, because `tagEntityTreeAsInstance` recomputes its plan on the other side of an
 *  await (see its docblock). Thread the SAME plan to both, or keep the two concerns in separate
 *  modules. */

import { describe, it, expect } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const PRESERVE = 'preserveLocalIds';
const TAG = 'tagEntityTreeAsInstance';

/** Every editor source file, minus tests, the module that DEFINES the numbering (it legitimately
 *  names both) and the barrel (it re-exports, calls nothing). The floor is the corpus guard: a
 *  scan that silently matches nothing would make every assertion below vacuous. */
function editorSources(): { rel: string; abs: string }[] {
  return repoFiles({ under: 'engine', match: /\.tsx?$/, floor: 500 })
    .filter(({ rel }: { rel: string }) => !/[\\/]tests?[\\/]|\.test\.tsx?$/.test(rel))
    .filter(({ rel }: { rel: string }) => !rel.endsWith('editor/scene/prefab.ts'))
    .filter(({ rel }: { rel: string }) => !rel.endsWith('editor/index.ts'));
}

/** Source files whose CODE mentions a symbol.
 *
 *  Through `readScannedSource`, the shared entry point `commentStripperIsShared.test.ts` exists to
 *  enforce, so a comment naming both symbols cannot fail this guard.
 *
 *  ⚠️ Honest scope: no file in the CURRENT corpus is saved by the strip — `tagEntityTreeAsInstance`'s
 *  own docblock does name `preserveLocalIds`, but it lives in `editor/scene/prefab.ts`, which
 *  `editorSources()` excludes anyway, and reverting to a raw read leaves both tests green today.
 *  This is the convention, not a live save. */
function filesMentioning(symbol: string): string[] {
  return editorSources()
    .filter(({ abs }) => readScannedSource(abs).code.includes(symbol))
    .map(({ rel }) => rel);
}

describe('prefab localId numbering — one procedure, one set of inputs (#1278)', () => {
  it('no module both preserves localIds and tags a tree as an instance', () => {
    const preservers = new Set(filesMentioning(PRESERVE));
    const taggers = new Set(filesMentioning(TAG));
    const both = [...preservers].filter((f) => taggers.has(f));
    expect(both, `these modules do both, which lets the file numbering and the live tagging diverge:\n  ${both.join('\n  ')}`).toEqual([]);
  });

  it('the scan actually sees both symbols — otherwise the assertion above is vacuous', () => {
    // A guard that matches nothing passes forever. Pin that each side has real callers, so a
    // rename that silently empties one set fails here instead of going quiet.
    expect(filesMentioning(PRESERVE).length).toBeGreaterThan(0);
    expect(filesMentioning(TAG).length).toBeGreaterThan(0);
  });
});
