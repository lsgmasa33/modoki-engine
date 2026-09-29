/** #1868: `getAssetFileOpVersion` — the counter `modoki_dnd`'s commit witness reads for an Assets file drag, which
 *  pushes no undo entry and parks nothing — moves on every move and delete `applyAssetPathMoves` carries, and not on a
 *  call that carries none (a drop that moved nothing). */
import { describe, it, expect } from 'vitest';
import { applyAssetPathMoves, getAssetFileOpVersion } from '../../src/editor/panels/assetEditorBindings';

describe('getAssetFileOpVersion', () => {
  it('bumps for a file move, a folder move and a delete; not for an empty call', () => {
    // Mutation: drop `fileOpVersion++` from `applyAssetPathMoves` — no bump, and a real file drag reads as a no-op.
    const v0 = getAssetFileOpVersion();
    applyAssetPathMoves([{ from: '/assets/a.png', to: '/assets/b/a.png' }]);
    expect(getAssetFileOpVersion()).toBe(v0 + 1);
    applyAssetPathMoves([{ from: '/assets/b', to: '/assets/c', prefix: true }]);
    expect(getAssetFileOpVersion()).toBe(v0 + 2);
    applyAssetPathMoves([{ from: '/assets/c/a.png', to: null }]);
    expect(getAssetFileOpVersion()).toBe(v0 + 3);
    applyAssetPathMoves([]);
    expect(getAssetFileOpVersion()).toBe(v0 + 3);
  });
});
