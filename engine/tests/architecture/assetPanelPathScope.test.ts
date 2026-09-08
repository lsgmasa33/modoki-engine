/** The single-asset Inspector is REMOUNTED when the selection moves to another asset
 *  (#891 member 2, #897).
 *
 *  WHY. `<AssetInspector asset={selectedAsset} />` with no `key` is one React instance reused
 *  across an asset switch, so every child keeps the PREVIOUS asset's state while `path` is already
 *  the new one: `meta` / `data` still hold asset A's document, `metaRef`/`metaLoaded` still
 *  describe A's read, and — because none of these views has a loading gate that a non-null FOREIGN
 *  document can trip — every control renders enabled and populated with A's values under B's name.
 *  An edit in that window parked A's document, `id` included, under B's path: two assets claiming
 *  one GUID, which #891's own thread calls strictly worse than the id-less write.
 *
 *  ⚠️ This is the DISPLAY half of a pair, and it is not the guard. `parkMetaEdit`'s read-path stamp
 *  (`scene/metaReadFallback.ts` § READ_FOR_PATH) is what stops any of it reaching disk; a `key`
 *  alone would convert the foreign document into an id-less one (#890) — the same destruction,
 *  harder to notice. Neither half is sufficient, which is why both are pinned.
 *
 *  ⚠️ What this test CANNOT prove: that React actually remounts on a changing `key`. That is
 *  React's own contract, and asserting it here would mean mounting a panel in jsdom, which
 *  `docs/editor.md` § Panels rules out (it asserts the mock). What it pins is the one line a
 *  refactor deletes without noticing — the same idiom, and the same limits, as
 *  `metaReadPreferringPark.test.ts` next door. */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';

const SRC = path.resolve(__dirname, '../../packages/modoki/src/editor');
const read = (rel: string) => readScannedSource(path.join(SRC, rel)).code;

/** `true` if `code` (already comment-stripped) renders `<AssetInspector>` with a `key` taken from
 *  the selected asset's PATH.
 *
 *  Comment-stripped is load-bearing here rather than incidental: the render site carries a long
 *  ⚠️ block that names `key={selectedAsset.path}` in prose, so a scan of the raw file would match
 *  its own explanation and stay green with the real prop deleted. Same trap
 *  `metaReadPreferringPark.test.ts`'s detectors document, reached from the other direction. */
function remountsAssetInspectorPerPath(code: string): boolean {
  return /<AssetInspector\s[^>]*key=\{[^}]*\.path\}/.test(code);
}

/** `true` if `code` renders `<AssetBatchInspector>` with a key built from the selected PATHS.
 *
 *  The batch branch has the same window for a different reason: each batch view gates its controls
 *  on `loaded`, which `loadAll` sets false — but in an EFFECT, so for one render after the
 *  selection changes `loaded` is still true from the previous one while the `metas`/`mats` map
 *  still holds the previous paths. `\.path` is not enough to look for here: the key is built by
 *  mapping the assets, so the shape is a `join`/`map` expression rather than a member read. */
function remountsBatchInspectorPerSelection(code: string): boolean {
  return /<AssetBatchInspector\s[^>]*key=\{[^}]*\.path[^}]*\}/.test(code);
}

describe('the asset Inspector is scoped to one asset path (#891/#897)', () => {
  it('renders <AssetInspector> with a key derived from the asset path', () => {
    expect(
      remountsAssetInspectorPerPath(read('panels/Inspector.tsx')),
      'Without a path key React reuses the instance across an asset switch, so every asset view '
      + "keeps the PREVIOUS asset's document while `path` is already the new one — and parks it "
      + 'under the new path on the next edit (#891 member 2, #897).',
    ).toBe(true);
  });

  it('renders <AssetBatchInspector> with a key built from the selected paths', () => {
    expect(
      remountsBatchInspectorPerSelection(read('panels/Inspector.tsx')),
      'Without it, the one render between a selection change and `loadAll`\'s effect shows the '
      + 'PREVIOUS selection\'s values with every control live — and Texture/Model batch park '
      + '`{ ...(metas[p] ?? {}) }` for paths they have not read.',
    ).toBe(true);
  });

  it('the batch detector needs a real key prop too', () => {
    expect(remountsBatchInspectorPerSelection(
      '<AssetBatchInspector key={selectedAssets.map((a) => a.path).join(\' \')} assets={s} />')).toBe(true);
    expect(remountsBatchInspectorPerSelection('<AssetBatchInspector assets={selectedAssets} />')).toBe(false);
    expect(remountsBatchInspectorPerSelection('<AssetBatchInspector key={assets.length} assets={s} />')).toBe(false);
  });

  /** ⚠️ The detector's own controls, both directions. A regex that matched everything would make
   *  the rule above vacuously green, and one that matched nothing would make it impossible to
   *  satisfy — the failure mode `metaReadPreferringPark.test.ts` paid for twice. */
  it('the detector needs a real key prop, not a mention of one', () => {
    expect(remountsAssetInspectorPerPath('<AssetInspector key={selectedAsset.path} asset={a} />')).toBe(true);
    expect(remountsAssetInspectorPerPath('<AssetInspector asset={a} key={a.path} />')).toBe(true);
    expect(remountsAssetInspectorPerPath('<AssetInspector asset={selectedAsset} />')).toBe(false);
    expect(remountsAssetInspectorPerPath('<AssetInspector key={selectedAsset.type} asset={a} />')).toBe(false);
    // The prose form the ⚠️ block above is written in — what a raw (un-stripped) scan would match.
    expect(remountsAssetInspectorPerPath('key={selectedAsset.path} on <AssetInspector>')).toBe(false);
  });

  /** The premise the rule rests on: there really is exactly one `<AssetInspector>` render site to
   *  key. If a second one appears, this rule is checking one of two and the other is unguarded —
   *  the scope-restriction trap, one file over. */
  it('there is exactly one render site for each, so neither rule is checking one of two', () => {
    const code = read('panels/Inspector.tsx');
    expect((code.match(/<AssetInspector\s/g) ?? []).length).toBe(1);
    expect((code.match(/<AssetBatchInspector\s/g) ?? []).length).toBe(1);
  });
});
