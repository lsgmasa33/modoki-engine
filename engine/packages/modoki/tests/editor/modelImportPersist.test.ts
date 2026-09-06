/** `modelImport.ts`'s read-before-write classification (`modelImportPersist.ts`), unit-tested
 *  without the import pipeline (CLAUDE.md § Panels). This is the regression guard for #784 phase
 *  C2b item 3: a read failure of ANY kind must not collapse to "genuinely absent" — a corrupt or
 *  too-new `.mesh.json`/`.mat.json` must be distinguished from a first-time import, or a fresh
 *  GUID gets minted over content that is still on disk and every reference to it dangles. */

import { describe, it, expect } from 'vitest';
import { classifyExistingAssetFetchFailure, classifyExistingAssetJson } from '../../src/editor/scene/modelImportPersist';
import { MissingAssetError } from '../../src/runtime/loaders/assetFetch';

describe('classifyExistingAssetFetchFailure', () => {
  it('treats a MissingAssetError as absent — a first-time import, minting a fresh guid is correct', () => {
    expect(classifyExistingAssetFetchFailure(new MissingAssetError('404 for meshes/wall.mesh.json'))).toEqual({ kind: 'absent' });
  });

  it('treats a real parse failure as abort — must NOT be treated as absent', () => {
    // The #778/#784 mechanism restated: a plain Error (truncated or conflict-markered JSON) is
    // not a 404. Collapsing this into "absent" is exactly the regression this guards — the
    // caller would mint a fresh guid over a file that is still there, dangling every reference.
    const v = classifyExistingAssetFetchFailure(new Error('meshes/wall.mesh.json is not valid JSON: Unexpected token <'));
    expect(v.kind).toBe('abort');
    expect((v as { reason: string }).reason).toContain('not valid JSON');
  });
});

describe('classifyExistingAssetJson', () => {
  it('is ok at or below the current format version', () => {
    expect(classifyExistingAssetJson({ version: 1 }, 1)).toEqual({ kind: 'ok' });
  });

  it('is ok for a versionless (legacy/absent) document', () => {
    expect(classifyExistingAssetJson({ id: 'x' }, 1)).toEqual({ kind: 'ok' });
  });

  it('aborts on a too-new document — the write must not stamp over it', () => {
    const v = classifyExistingAssetJson({ version: 2 }, 1);
    expect(v.kind).toBe('abort');
    expect((v as { reason: string }).reason).toContain('2');
  });

  it('aborts on an unreadable (non-numeric) version field', () => {
    const v = classifyExistingAssetJson({ version: 'two' }, 1);
    expect(v.kind).toBe('abort');
  });

  it('aborts on a non-object body', () => {
    expect(classifyExistingAssetJson(null, 1).kind).toBe('abort');
    expect(classifyExistingAssetJson([1, 2, 3], 1).kind).toBe('abort');
  });
});
