/** #1880 W7: only the prefab step (`commitPrefabChanges`, `editor/scene/prefabCommit.ts`) writes, parks or seats a prefab.
 *
 *  WHY A CENSUS. The E7 study (#1880) found 18 doors changing prefab documents on two engines, each carrying its own copy
 *  of the invariants, and each review round found another door missing another one (#1872 F2 fixed the mark on one door;
 *  #1877 S1 found the same mark missing on the next). The step states them once. What keeps it the ONLY door is that a
 *  new raw seat, park or write fails here, and its author has to say why it is not the step — or route it through it.
 *
 *  Every production file whose code calls one of the ENTRY_POINTS is listed with EXACTLY the entry points it calls and
 *  why. Both directions fail: an unlisted caller, a listed file that no longer calls, and a listed file that calls an
 *  entry point its row does not name (a second raw seat in an allowlisted file is a new door too). Comments are
 *  stripped, so a docblock naming a function is not a call site.
 *
 *  ⚠️ The census includes `engine/app/` (the watcher lives there), as `prefabSerializeCallSites.test.ts` learned to. */

import { describe, it, expect } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

/** What changes a prefab document, or the caches and park that hold one. `postWriteFile` writes ANY file, so its callers
 *  are listed too: a prefab written through it anywhere but the step is the door the census exists to catch. */
const ENTRY_POINTS = [
  'seatCaches', 'seatEditorPrefabCache', 'primeEditorPrefabCache', 'replaceCachedPrefab', 'invalidatePrefab',
  'evictDeletedPrefabs', 'evictDeletedEditorPrefabs', 'setPrefabCache', 'parkPrefab', 'reparkDirtyAsset', 'postWriteFile',
] as const;
type EntryPoint = (typeof ENTRY_POINTS)[number];

const STEP = 'engine/packages/modoki/src/editor/scene/prefabCommit.ts';

/** rel path → the entry points its code calls, and why it is not (or is) the step. */
const CENSUS: Record<string, { calls: EntryPoint[]; why: string }> = {
  [STEP]: {
    calls: ['seatCaches', 'seatEditorPrefabCache', 'replaceCachedPrefab', 'invalidatePrefab', 'evictDeletedPrefabs', 'evictDeletedEditorPrefabs', 'parkPrefab', 'postWriteFile'],
    why: 'THE STEP (#1880 W). Its three landings: file (postWriteFile, then seatCaches), park (parkPrefab), adopt '
      + '(seatCaches; an unused prefab\'s read keys and its runtime copy; a gone file evicted as the delete evicts). The '
      + 'adopt raises a document\'s localId mark in the CACHES only (hub ruling (A)) — a counter-only raise, not a raw seat',
  },
  'engine/packages/modoki/src/editor/scene/prefabCache.ts': {
    calls: ['seatEditorPrefabCache', 'primeEditorPrefabCache', 'evictDeletedEditorPrefabs', 'setPrefabCache', 'replaceCachedPrefab', 'invalidatePrefab'],
    why: 'DEFINES the editor cache\'s seats (seatEditorPrefabCache for the step, primeEditorPrefabCache for a read-side '
      + 'warm, evictDeletedEditorPrefabs for a delete). '
      + '`setPrefabCache` is a TEST-FIXTURE seam: no production file calls it (the prefab-edit open\'s seed is the step\'s '
      + 'adopt since W4), which this census pins — a production caller would be an unlisted file here',
  },
  'engine/packages/modoki/src/runtime/loaders/meshTemplateCache.ts': {
    calls: ['replaceCachedPrefab', 'invalidatePrefab', 'evictDeletedPrefabs'],
    why: 'DEFINES the runtime prefab cache (replace, evict, a delete\'s eviction) and calls its own evictions inside them',
  },
  'engine/packages/modoki/src/editor/scene/dirtyAssets.ts': {
    calls: ['parkPrefab', 'reparkDirtyAsset'],
    why: 'DEFINES the park (the step parks) and the move repair\'s re-park',
  },
  'engine/packages/modoki/src/editor/panels/assetEditorBindings.ts': {
    calls: ['evictDeletedPrefabs', 'evictDeletedEditorPrefabs', 'reparkDirtyAsset'],
    why: 'the Assets file operations\' cache and park repair (#1880 plan § "Not in the step": D14 rename/move re-keys and '
      + 're-parks, D15 delete evicts). Unity\'s Project-window delete is not undoable either (owner ruling D2)',
  },
  'engine/app/debug/agentBridge.ts': {
    calls: ['invalidatePrefab'],
    why: 'the watcher\'s eviction (1) for a runtime with NO editor installed (a device build), its only refresh, and (2) '
      + 'right before a disk-wins scene RELOAD, which re-reads everything it loads. In the editor every prefab change is '
      + 'the step\'s adopt landing first (#1880 W4); only what it could not rebase over a clean scene reaches the reload',
  },
  'engine/packages/modoki/src/editor/scene/prefabCacheWarm.ts': {
    calls: ['primeEditorPrefabCache'],
    why: 'a READ-side warm (I9): a cold editor key seeded from the loader\'s copy before a scene swap — the document the '
      + 'file was read to hold, never a change to it, and never the runtime copy (its revision bump would respawn every '
      + 'pooled row, #1308)',
  },
  'engine/packages/modoki/src/editor/scene/prefabInstantiate.ts': {
    calls: ['primeEditorPrefabCache'],
    why: 'a READ-side warm: a placement primes the editor key with the document it just read, behind its read token '
      + '(#1752) — the document the file holds, not a change',
  },
  'engine/packages/modoki/src/editor/panels/assetOps.ts': {
    calls: ['primeEditorPrefabCache'],
    why: 'Create Prefab\'s redo re-links to the file the undo LEFT, after reading that it still holds the document (I10), '
      + 'and warms a cold editor key with it (I9) — a read-side warm, not a change',
  },
  'engine/packages/modoki/src/editor/backend/editorBackend.ts': {
    calls: ['postWriteFile'],
    why: 'DEFINES the file-write route call; it writes nothing on its own behalf',
  },
  'engine/packages/modoki/src/editor/scene/createAssetDocument.ts': {
    calls: ['postWriteFile'],
    why: 'writes a NEW non-prefab asset document (a clip, a particle effect, a rig, a scene\'s Save As). It never writes a '
      + 'prefab: a destination the manifest types as another kind is refused (`otherAssetKindAt`), and every prefab '
      + 'create is Create Prefab\'s, through the step',
  },
};

const productionSources = (): { rel: string; abs: string }[] =>
  repoFiles({ under: 'engine', match: /\.tsx?$/, floor: 500 })
    .filter(({ rel }: { rel: string }) => !/[\\/]tests?[\\/]|\.test\.tsx?$|[\\/]testing[\\/]|[\\/]dist[\\/]/.test(rel))
    // The barrel re-exports; it calls nothing.
    .filter(({ rel }: { rel: string }) => !/editor[\\/]index\.ts$/.test(rel));

/** rel path → the entry points its comment-stripped code calls (a definition `function x(` counts: the definer is listed). */
function census(): Map<string, EntryPoint[]> {
  const out = new Map<string, EntryPoint[]>();
  for (const { rel, abs } of productionSources()) {
    const { code } = readScannedSource(abs);
    const calls = ENTRY_POINTS.filter((e) => new RegExp(`\\b${e}\\(`).test(code));
    if (calls.length) out.set(rel.replace(/\\/g, '/'), calls);
  }
  return out;
}

describe('only the prefab step writes, parks or seats a prefab (#1880 W7)', () => {
  it('the census matches the code, file by file and entry point by entry point', () => {
    const found = census();
    const undeclared = [...found.keys()].filter((f) => !(f in CENSUS));
    const stale = Object.keys(CENSUS).filter((f) => !found.has(f));
    expect(undeclared, 'a new file writes, parks or seats a prefab outside the step (`commitPrefabChanges`). Route it '
      + 'through the step — or, if it is not a change to a prefab document, add a CENSUS row saying why:\n  '
      + undeclared.map((f) => `${f}: ${found.get(f)!.join(', ')}`).join('\n  ')).toEqual([]);
    expect(stale, 'CENSUS names a file that no longer calls any entry point — drop the row:\n  ' + stale.join('\n  ')).toEqual([]);
    for (const [file, row] of Object.entries(CENSUS)) {
      expect([...(found.get(file) ?? [])].sort(), `${file}: its calls changed — a new one is a new door; say why, or route it through the step`)
        .toEqual([...row.calls].sort());
    }
  });

  // A renamed import (`import { replaceCachedPrefab as seat }`) would call an entry point by another name, which the
  // `\bname(` scan cannot see. Nothing renames one; that is pinned rather than assumed.
  it('no production file imports an entry point under another name', () => {
    const aliased: string[] = [];
    for (const { rel, abs } of productionSources()) {
      const { code } = readScannedSource(abs);
      // `import { e as x }`, and a dynamic import's destructure rename `const { e: x } = await import(…)` — the idiom the
      // step's lazy imports use.
      for (const e of ENTRY_POINTS) if (new RegExp(`\\b${e}\\s+as\\s+\\w|[{,]\\s*${e}\\s*:\\s*\\w`).test(code)) aliased.push(`${rel}: ${e}`);
    }
    expect(aliased).toEqual([]);
  });

  it('the scan sees real callers — otherwise the census above is vacuous', () => {
    const found = census();
    expect(found.get(STEP)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(found.size).toBeGreaterThanOrEqual(6);
  });

  it('every row says why', () => {
    for (const [file, row] of Object.entries(CENSUS)) expect(row.why.length, `${file} has no reason`).toBeGreaterThan(40);
  });
});
