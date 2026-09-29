/** #1868, owner ruling D2: the Assets panel's FILE operations — delete, rename, move, duplicate, cut/copy-paste, new
 *  folder, folder rename, folder delete, OS-drop import, Import Model — push no undo entry. Their async undo steps were
 *  the class that needed the preconditions, shortfall reports and restore owner (docs/plans/undo-memory-only.md); Unity
 *  does not undo a delete either ("You cannot undo the delete assets action.").
 *
 *  `Assets.tsx` is a `.tsx` and is not mounted (docs/editor.md § Panels), so this is a source scan. Its limit, stated:
 *  it proves the panel NAMES no undo push outside the one gesture that keeps one — the entity drop's Create Prefab,
 *  whose undo is memory-only (#1795) — not that nothing it calls pushes one. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { found } from '@modoki/engine/testing/inOrder';

const ASSETS = path.resolve(__dirname, '../../packages/modoki/src/editor/panels/Assets.tsx');

describe('an Assets file operation leaves no undo entry (#1868, D2)', () => {
  it('Assets.tsx pushes an undo entry only from the entity drop (Create Prefab)', () => {
    // Mutation: put back any `pushAction(…)` in a file-op handler (e.g. handleRename) — the count is 2 and it fails.
    const code = readScannedSource(ASSETS).code;
    const handleDrop = found(code.indexOf('const handleDrop = useCallback('), 'the entity drop handler');
    const handleFilesDrop = found(code.indexOf('const handleFilesDrop = useCallback(', handleDrop), 'the files drop handler after it');
    const pushes = [...code.matchAll(/\bpushAction\(/g)].map((m) => m.index!);
    expect(pushes.length, 'an Assets file operation pushes an undo entry again').toBe(1);
    expect(pushes[0], 'the one push is Create Prefab\'s, inside the entity drop').toBeGreaterThan(handleDrop);
    expect(pushes[0]).toBeLessThan(handleFilesDrop);
  });

  it('every delete gesture asks first: both delete paths call the confirm', () => {
    // Mutation: drop the confirm from `handleDeleteFolder` — one call is left and this fails.
    const code = readScannedSource(ASSETS).code;
    expect([...code.matchAll(/deleteConfirmText\(/g)].length).toBe(2);
    for (const fn of ['const executeDeletion = useCallback(', 'const handleDeleteFolder = useCallback(']) {
      const at = found(code.indexOf(fn), fn);
      const body = code.slice(at, found(code.indexOf('}, [', at), `the end of ${fn}`));
      expect(body, `${fn} trashes without asking`).toMatch(/if \(!await confirmInEditor\(ask\.title, ask\.message, ask\.okLabel\)\) return;[\s\S]*(deleteAssets|trashAssetFile)\(/);
    }
  });
});
