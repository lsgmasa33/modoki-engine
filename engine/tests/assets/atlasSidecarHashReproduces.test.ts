/** The `atlasCache` row of the #161 sweep (`metaSidecarChurn.test.ts`), which named atlases as a
 *  known gap: `atlasHashKey` is keyed on member sprites resolved through the PROJECT'S asset
 *  index, not on the sidecar's own source, so it cannot be recomputed from one file.
 *
 *  Closed by driving the real gate instead of recomputing the key: every committed atlas goes
 *  through `packAtlasAsset` against its project's real asset index, with the page cache reported
 *  warm and the encoder rigged to throw. A committed hash that still reproduces returns the
 *  committed block untouched. A stale one, such as a key change that forgot to re-key the
 *  committed sidecars (#2065 changed the key and re-keyed three), reaches the encoder and fails
 *  here. Otherwise every clone re-packs on its first build and rewrites a committed file.
 *
 *  Only the cache CHECK is faked (`cacheHit` → true): the page bytes are per-machine, gitignored
 *  state, while the hash is the committed fact under test. */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { hasInternalGames } from '../helpers/repoLayout';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

vi.mock('../../plugins/texture-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../plugins/texture-cache')>()),
  cacheHit: () => true,
}));
vi.mock('../../plugins/texture-convert', () => ({
  convertTexture: async (o: { sourceUrlPath: string }) => { throw new Error(`REPACK ATTEMPTED for ${o.sourceUrlPath}`); },
}));

const { packAtlasAsset } = await import('../../plugins/reimport-atlas');
const { findAssetRoots, scanAllAssets, resolveAssetPath } = await import('../../plugins/vite-asset-scanner');

const REPO = path.resolve(__dirname, '../../..');

describe('every committed atlasCache hash reproduces through the real pack gate (#161 sweep, #2065)', () => {
  const sidecars = repoFiles({ match: /\.atlas\.json\.meta\.json$/, floor: 0, includeUntracked: false })
    .map((f: { rel: string }) => f.rel)
    .filter((rel: string) => /^(games|demos)\/[^/]+\//.test(rel));

  it('the work-list is not empty where the internal games ship', () => {
    if (hasInternalGames()) expect(sidecars.length).toBeGreaterThan(0);
  });

  // The public snapshot ships no games/, so no atlases: skip rather than hand it.each an empty table.
  (sidecars.length ? it.each(sidecars) : it.skip.each(['(no committed atlas in this layout)']))('%s', async (rel) => {
    const sidecarAbs = path.join(REPO, rel);
    const before = fs.readFileSync(sidecarAbs, 'utf8');
    const committed = (JSON.parse(before) as { atlasCache?: { hash?: string } }).atlasCache;
    if (!committed?.hash) return; // never packed: nothing committed to reproduce
    const srcAbs = sidecarAbs.replace(/\.meta\.json$/, '');
    const projectRoot = path.join(REPO, rel.split('/').slice(0, 2).join('/'));
    const roots = findAssetRoots(projectRoot);
    const assets = scanAllAssets(roots);
    const id = (JSON.parse(fs.readFileSync(srcAbs, 'utf8')) as { id: string }).id;
    const entry = assets.find((a) => a.type === 'atlas' && a.guid === id);
    expect(entry, `${rel}: atlas ${id} not in its project's asset index`).toBeTruthy();

    const block = await packAtlasAsset(entry!.path, srcAbs, {
      projectRoot,
      resolveAssetPath: (p) => resolveAssetPath(p, roots),
      listAssets: () => assets,
    });
    expect(block.hash).toBe(committed.hash);
    expect(fs.readFileSync(sidecarAbs, 'utf8')).toBe(before); // nothing rewritten
  });
});
