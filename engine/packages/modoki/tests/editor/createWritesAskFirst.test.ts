/** Source-level guard for #1264: an editor create must not mint a guid and write it with a plain
 *  (replacing) write.
 *
 *  That pairing IS the defect. Eight human create paths did exactly it — `newGuid()` then
 *  `writeAssetFile(path, …)` — so an existing asset at `path` was replaced with no question and under
 *  a fresh guid, dangling every ref to it. They now go through `writeNewAssetDocument`, which writes
 *  create-only, asks, and keeps the replaced id. The four editor "New" buttons, Auto-Rig and Save
 *  Scene As live in `.tsx`/`serialize.ts` flows no unit test can mount (docs/editor.md § Panels), so
 *  this is what stops the next "New X" button reintroducing the shape.
 *
 *  Anchored on the WRITE, not on the button: every plain write in the editor is visited, and it is an
 *  offender when the same function also mints a guid. A save of an existing document does not mint,
 *  and a create that mints no longer writes plainly. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { repoFiles } from '../../../../scripts/repoCorpus.mjs';
import { readScannedSource } from '../helpers/sourceScanner';
import { callsTo, enclosingFunction, enclosingNamedFunction, parseSource, ts } from '../helpers/sourceAst';
import { assertExemptionLedger } from '../helpers/exemptionLedger';

const EDITOR = path.resolve(__dirname, '../../src/editor');
const PLAIN_WRITES = ['writeAssetFile', 'postWriteFile'];

function editorSources(dir: string): string[] {
  return repoFiles({ under: dir, match: (rel: string) => /\.tsx?$/.test(rel), floor: 20 }).map(({ abs }: { abs: string }) => abs);
}

/** Every plain write in `sf`, with whether its own function also mints a guid. */
function mintedPlainWrites(sf: ts.SourceFile, file: string) {
  return callsTo(sf, ...PLAIN_WRITES).map((call) => {
    const fn = enclosingFunction(call);
    return {
      item: `${file}::${enclosingNamedFunction(call)?.name ?? '<top>'}`,
      site: file,
      mints: !ts.isSourceFile(fn) && callsTo(fn, 'newGuid').length > 0,
    };
  });
}

describe('an editor create writes through writeNewAssetDocument, never mint-then-plain-write (#1264)', () => {
  it('the reader tells the defect from its fix', () => {
    const probe = (body: string) => mintedPlainWrites(parseSource(body, 'probe.tsx'), 'probe').map((w) => w.mints);
    // The shape every member had.
    expect(probe('const newClip = async () => { const guid = newGuid(); await writeAssetFile(p, body(guid)); };')).toEqual([true]);
    expect(probe('async function f() { const g = newGuid(); await postWriteFile(p, c); }')).toEqual([true]);
    // A save of an existing document mints nothing — not a create.
    expect(probe('async function save() { await writeAssetFile(p, content); }')).toEqual([false]);
    // The fix: the guid is minted INSIDE the primitive, and no plain write remains.
    expect(probe('const newClip = async () => { await writeNewAssetDocument(p, (g) => body(g)); };')).toEqual([]);
    // A mint in a DIFFERENT function does not taint a save beside it.
    expect(probe('function a() { return newGuid(); }\nasync function b() { await writeAssetFile(p, c); }')).toEqual([false]);
  });

  it('no editor function mints a guid and writes it with a plain write', () => {
    const files = editorSources(EDITOR);
    const writes = files.flatMap((abs) => {
      const rel = path.relative(EDITOR, abs);
      return mintedPlainWrites(parseSource(readScannedSource(abs).code, rel), rel);
    });
    expect(writes.length, 'the reader must see the editor\'s plain writes, or the ledger below is vacuous').toBeGreaterThanOrEqual(10);
    assertExemptionLedger({
      label: 'editor functions that mint a guid and write it with a plain write (#1264)',
      population: writes.filter((w) => w.mints).map(({ item, site }) => ({ item, site })),
      exempt: [{
        item: 'scene/prefab.ts::writePrefabFile',
        reason: 'the SAVE choke point for an existing template (Apply-to-Prefab, prefab edit mode, undo restore, the agent create op) — '
          + '`if (!prefab.id) prefab.id = newGuid()` heals a document with no id; it is not minting an identity for a new file. '
          + 'Every caller hands it a prefab whose id was resolved from the existing file (resolveExistingPrefabId / the edited guid).',
      }],
      scanned: writes.length,
      floor: 10,
      fix: 'create the document with writeNewAssetDocument (scene/createAssetDocument.ts): it writes create-only, asks before replacing, and keeps the replaced asset\'s guid',
    });
  });
});
