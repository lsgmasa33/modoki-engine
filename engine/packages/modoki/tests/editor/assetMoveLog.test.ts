/** #1868: where an asset recorded at a path is now, after the Assets moves and deletes made SINCE it was recorded. */
import { describe, it, expect, beforeEach } from 'vitest';
import { recordAssetMoves, currentAssetPath, assetMoveMark, clearAssetMoveLog } from '../../src/editor/utils/assetMoveLog';

beforeEach(() => clearAssetMoveLog());

describe('currentAssetPath', () => {
  it('is the path itself when nothing moved it', () => {
    const mark = assetMoveMark();
    recordAssetMoves([{ from: '/a/other.json', to: '/a/else.json' }]);
    expect(currentAssetPath('/a/x.json', mark)).toBe('/a/x.json');
  });
  it('follows a rename, then a folder move, in order', () => {
    // Mutation: stop at the first matching move — the folder move is missed and this reads /a/y.json.
    const mark = assetMoveMark();
    recordAssetMoves([{ from: '/a/x.json', to: '/a/y.json' }]);
    recordAssetMoves([{ from: '/a', to: '/b', prefix: true }]);
    expect(currentAssetPath('/a/x.json', mark)).toBe('/b/y.json');
  });
  it('is null once the asset, or a folder above it, was deleted', () => {
    const mark = assetMoveMark();
    recordAssetMoves([{ from: '/a', to: null, prefix: true }]);
    expect(currentAssetPath('/a/x.json', mark)).toBeNull();
    expect(currentAssetPath('/ab/x.json', mark)).toBe('/ab/x.json'); // a segment boundary, not a string prefix
  });
  it('ignores the moves made BEFORE the record: a new asset at a renamed-away path is not the renamed one', () => {
    // Mutation: replay the whole log (drop `.slice(mark)`) — the new /a/x.json resolves to /a/y.json.
    recordAssetMoves([{ from: '/a/x.json', to: '/a/y.json' }]);
    const mark = assetMoveMark(); // a new /a/x.json is created and edited here
    expect(currentAssetPath('/a/x.json', mark)).toBe('/a/x.json');
    recordAssetMoves([{ from: '/a/x.json', to: null }]);
    expect(currentAssetPath('/a/x.json', mark)).toBeNull();
  });
  it('a DELETE before the record does not make a new asset at that path read as deleted', () => {
    // Delete "New Particle", create another (it takes the freed name), edit it: its undo must not refuse "deleted since".
    recordAssetMoves([{ from: '/a/p.json', to: null }]);
    expect(currentAssetPath('/a/p.json', assetMoveMark())).toBe('/a/p.json');
  });
});
