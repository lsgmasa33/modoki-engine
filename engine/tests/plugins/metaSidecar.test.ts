/** meta-sidecar — atomic JSON sidecar writes (tmp + rename). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { readMetaSidecar, writeMetaSidecar } from '../../plugins/meta-sidecar';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

let tmpRoot: string;
let absPath: string;

beforeEach(() => {
  tmpRoot = makeScratchDir('modoki-meta-');
  absPath = path.join(tmpRoot, 'asset.glb');
});
afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

describe('readMetaSidecar', () => {
  it('returns {} when the sidecar does not exist', () => {
    expect(readMetaSidecar(absPath)).toEqual({});
  });

  it('returns {} when the sidecar contains malformed JSON (caller never sees a throw)', () => {
    fs.writeFileSync(absPath + '.meta.json', '{ "id": "broken');
    expect(readMetaSidecar(absPath)).toEqual({});
  });

  it('parses a well-formed sidecar', () => {
    fs.writeFileSync(absPath + '.meta.json', JSON.stringify({ id: 'x', version: 2 }));
    expect(readMetaSidecar(absPath)).toEqual({ id: 'x', version: 2 });
  });
});

describe('writeMetaSidecar — atomic write', () => {
  it('persists the JSON contents at <absPath>.meta.json', () => {
    writeMetaSidecar(absPath, { id: 'guid-1', version: 2 });
    const raw = fs.readFileSync(absPath + '.meta.json', 'utf-8');
    expect(JSON.parse(raw)).toEqual({ id: 'guid-1', version: 2 });
  });

  /** These sidecars are COMMITTED. Without a trailing newline every rewrite shows up as
   *  "\ No newline at end of file" in the diff, and the tree was split 65/198 on it — so
   *  sidecars churned on formatting alone depending on which tool wrote them last. Both
   *  halves must end with exactly one newline. */
  it('ends the file with a trailing newline (committed sidecars must not churn)', () => {
    // `hash` alongside the stats on purpose: a block holding nothing BUT stats is dropped from both
    // halves (#1279), so a stats-only fixture would leave no local file for this to read.
    writeMetaSidecar(absPath, { id: 'guid-1', version: 2, textureCache: { hash: 'h', variantBytes: { webp: 42 } } });
    const committed = fs.readFileSync(absPath + '.meta.json', 'utf-8');
    expect(committed.endsWith('\n')).toBe(true);
    expect(committed.endsWith('\n\n')).toBe(false); // exactly one
    const local = fs.readFileSync(absPath + '.meta.local.json', 'utf-8');
    expect(local.endsWith('\n')).toBe(true);
    expect(local.endsWith('\n\n')).toBe(false);
  });

  it('replaces an existing sidecar (no stale data)', () => {
    fs.writeFileSync(absPath + '.meta.json', JSON.stringify({ id: 'old', version: 1 }));
    writeMetaSidecar(absPath, { id: 'new', version: 2 });
    expect(readMetaSidecar(absPath)).toEqual({ id: 'new', version: 2 });
  });

  it('does not leave the .tmp file on disk after a successful write', () => {
    writeMetaSidecar(absPath, { id: 'x' });
    expect(fs.existsSync(absPath + '.meta.json')).toBe(true);
    expect(fs.existsSync(absPath + '.meta.json.tmp')).toBe(false);
  });

  it('preserves the prior sidecar if the write throws (rename is atomic)', () => {
    // Seed an existing sidecar that must survive a failed write.
    const existing = { id: 'survivor', version: 2 };
    fs.writeFileSync(absPath + '.meta.json', JSON.stringify(existing));

    // Force a write failure by passing a non-serializable value (circular ref).
    const bad: Record<string, unknown> = {};
    bad.self = bad;
    expect(() => writeMetaSidecar(absPath, bad)).toThrow();

    // Original sidecar is untouched — atomic guarantee.
    expect(readMetaSidecar(absPath)).toEqual(existing);
  });

  it('round-trips correctly (write then read returns the same shape)', () => {
    const meta = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      version: 2,
      texture: { format: 'ktx2-uastc', maxSize: 1024 },
      generated: { meshes: ['/m/a.mesh.json'] },
    };
    writeMetaSidecar(absPath, meta);
    expect(readMetaSidecar(absPath)).toEqual(meta);
  });
});

describe('writeMetaSidecar — committed / machine-local byte-stat split', () => {
  const metaWithStats = () => ({
    id: 'g', version: 2,
    modelCache: { hash: 'h1', lodPaths: ['/a.processed.glb'], lodDistances: [0], triCounts: [150775], lodBytes: [3628528] },
    textureCache: { hash: 'h2', variants: ['uastc'], width: 512, height: 512, variantBytes: { uastc: 223651 } },
    fontCache: { hash: 'h3', atlasWidth: 2048, glyphCount: 95, bytes: 627701 },
  });

  it('keeps structural fields committed but peels byte-stats (and modelCache.hash) into <asset>.meta.local.json', () => {
    writeMetaSidecar(absPath, metaWithStats());
    const committed = JSON.parse(fs.readFileSync(absPath + '.meta.json', 'utf-8'));
    // structural fields stay in the committed sidecar…
    expect(committed.modelCache.lodDistances).toEqual([0]);
    expect(committed.textureCache.variants).toEqual(['uastc']);
    expect(committed.fontCache.glyphCount).toBe(95);
    // …other blocks' hashes stay committed (source bytes + settings + in-repo encoder version — reproducible)…
    expect(committed.textureCache.hash).toBe('h2');
    expect(committed.fontCache.hash).toBe('h3');
    // …byte-size stats do NOT…
    expect(committed.modelCache).not.toHaveProperty('lodBytes');
    expect(committed.modelCache).not.toHaveProperty('triCounts');
    expect(committed.textureCache).not.toHaveProperty('variantBytes');
    expect(committed.fontCache).not.toHaveProperty('bytes');
    // …and modelCache.hash does NOT (#127 — machine-dependent by construction).
    expect(committed.modelCache).not.toHaveProperty('hash');
    // The stats (and the model hash) live in the gitignored local sidecar.
    const local = JSON.parse(fs.readFileSync(absPath + '.meta.local.json', 'utf-8'));
    expect(local).toEqual({
      modelCache: { hash: 'h1', triCounts: [150775], lodBytes: [3628528] },
      textureCache: { variantBytes: { uastc: 223651 } },
      fontCache: { bytes: 627701 },
    });
  });

  it('peels audioCache.durationSec, and ONLY it, out of the audio block (#1289)', () => {
    // durationSec is not derived from (source bytes + settings) like the rest of the block — it is
    // ffprobe's MEASUREMENT of the file ffmpeg just produced, so it moves when either binary does.
    // Measured 2026-09-16: 4 of games/wordweave's 26 clips encode to different bytes under
    // ffmpeg-static 6.0 vs Homebrew ffmpeg 8.1.1, and the two ffprobe builds on that Mac disagree
    // about duration on ALL 26.
    writeMetaSidecar(absPath, {
      id: 'g',
      audioCache: { hash: 'h4', ext: 'mp3', durationSec: 0.182857, channels: 1, sampleRate: 22050, bytes: 2527 },
    });
    const committed = JSON.parse(fs.readFileSync(absPath + '.meta.json', 'utf-8'));
    // The accept side, and it is the half that matters: channels/sampleRate stay reviewable in git,
    // so a peel that took the whole block would satisfy a bare not.toHaveProperty and be wrong.
    // ⚠️ Not because the settings always force them — that reason is false for 3 of the 29 migrated
    // sidecars (`demos/forest-camp`'s clips set `forceMono: false` and no `sampleRate`, so
    // buildFfmpegArgs passes neither `-ac` nor `-ar` and both values are pure ffprobe readings of
    // the source). They stay committed because their value follows the source deterministically and
    // no divergence has ever been observed in them — not because they cannot be measurements.
    expect(committed.audioCache).toEqual({ hash: 'h4', ext: 'mp3', channels: 1, sampleRate: 22050 });
    expect(JSON.parse(fs.readFileSync(absPath + '.meta.local.json', 'utf-8'))).toEqual({
      audioCache: { durationSec: 0.182857, bytes: 2527 },
    });
  });

  it('merges durationSec back on read, so the Audio inspector still shows a duration', () => {
    // Its one consumer is AudioAssetView's inspector row — `AudioManifestBlock` bakes
    // loadType/format/ext and no duration — so "peeled" has to differ from "dropped" HERE or the
    // fix silently removes a field the editor displays.
    fs.writeFileSync(absPath + '.meta.json', JSON.stringify({
      id: 'g', version: 2, audioCache: { hash: 'h4', ext: 'mp3', channels: 1, sampleRate: 22050 },
    }));
    fs.writeFileSync(absPath + '.meta.local.json', JSON.stringify({
      audioCache: { durationSec: 0.182857, bytes: 2527 },
    }));
    expect(readMetaSidecar(absPath).audioCache).toEqual({
      hash: 'h4', ext: 'mp3', channels: 1, sampleRate: 22050, durationSec: 0.182857, bytes: 2527,
    });
  });

  it('readMetaSidecar merges the local byte-stats back (inspector sees live sizes)', () => {
    const meta = metaWithStats();
    writeMetaSidecar(absPath, meta);
    expect(readMetaSidecar(absPath)).toEqual(meta);
  });

  it('local byte-stats WIN over a stale committed value', () => {
    // Simulate a sidecar committed on another host (bytes=627701) + this host's local stat.
    fs.writeFileSync(absPath + '.meta.json', JSON.stringify({ id: 'g', fontCache: { hash: 'h3', bytes: 627701 } }));
    fs.writeFileSync(absPath + '.meta.local.json', JSON.stringify({ fontCache: { bytes: 623901 } }));
    expect((readMetaSidecar(absPath).fontCache as { bytes: number }).bytes).toBe(623901);
  });

  it('drops a stale local sidecar when the new write has no byte-stats', () => {
    writeMetaSidecar(absPath, metaWithStats());
    expect(fs.existsSync(absPath + '.meta.local.json')).toBe(true);
    writeMetaSidecar(absPath, { id: 'g', version: 2 }); // settings-only, no cache blocks
    expect(fs.existsSync(absPath + '.meta.local.json')).toBe(false);
  });
});

/**
 * #1279 — the gitignored local sidecar must not decide what a build SHIPS.
 *
 * Every conversion site tests a cache block's mere EXISTENCE to mean "this asset has been through
 * the converter" (`vite-asset-scanner.ts`: `if (!hasCache) { shipSource(); continue; }`, plus the
 * manifest's texture/audio/video/font/env baking). The merge used to create the block when only
 * the local file had one — so a `{"audioCache":{"bytes":1236743}}` left behind by an earlier
 * import made THIS machine convert while a fresh clone or CI, which cannot have that file, shipped
 * the source verbatim. Same commit, different shipped bytes, and nothing reporting it.
 *
 * Observed on `games/wordweave` during #921: with `audioCache` stripped from all 26 committed
 * sidecars and both caches deleted, the native build still logged `converted 26 audio clip(s)`.
 */
describe('readMetaSidecar — the committed sidecar decides which cache blocks EXIST (#1279)', () => {
  const committedWithout = () => fs.writeFileSync(
    absPath + '.meta.json', JSON.stringify({ id: 'g', version: 2, audio: { format: 'mp3' } }),
  );
  const localStatsOnly = () => fs.writeFileSync(
    absPath + '.meta.local.json', JSON.stringify({ audioCache: { bytes: 1236743 } }),
  );

  it('does not create a block the committed sidecar lacks', () => {
    committedWithout();
    localStatsOnly();
    // The load-bearing assertion is `audioCache` being ABSENT, not merely empty: `!!meta.audioCache`
    // is the test the build makes, and `{}` passes it exactly as a real block does.
    expect(readMetaSidecar(absPath)).not.toHaveProperty('audioCache');
  });

  it('reports the same blocks with the local file present and with it deleted', () => {
    // The invariant in the build's own terms: whether this host has ever imported the asset cannot
    // change the convert-vs-ship answer. A fresh clone is the "deleted" case, by construction.
    committedWithout();
    localStatsOnly();
    const withLocal = Object.keys(readMetaSidecar(absPath));
    fs.rmSync(absPath + '.meta.local.json');
    expect(withLocal).toEqual(Object.keys(readMetaSidecar(absPath)));
  });

  // Every block `meta-sidecar.ts` peels, not just the one the bug was caught on. Without this the
  // fix could have been written for `audioCache` alone and the suite would not have noticed — the
  // review's own mutation (`block === 'audioCache' ? meta[block] : (meta[block] ??= {})`) left
  // #1279 fully intact for the other five and every sidecar test stayed green.
  const ALL_BLOCKS = ['textureCache', 'modelCache', 'fontCache', 'audioCache', 'environmentCache', 'atlasCache'];
  for (const block of ALL_BLOCKS) {
    it(`does not create ${block} either — the fix is per-seam, not per-kind`, () => {
      fs.writeFileSync(absPath + '.meta.json', JSON.stringify({ id: 'g', version: 2 }));
      fs.writeFileSync(absPath + '.meta.local.json', JSON.stringify({ [block]: { bytes: 4096 } }));
      expect(readMetaSidecar(absPath)).not.toHaveProperty(block);
    });
  }

  it('merges into modelCache too — whose local half carries the peeled HASH, not just stats', () => {
    // modelCache is the one block with a structural local key (#127), so "the committed sidecar
    // decides which blocks exist" has to hold for a block whose local half is load-bearing.
    fs.writeFileSync(absPath + '.meta.json', JSON.stringify({
      id: 'g', version: 2, modelCache: { processedPath: '/a.processed.glb', lodPaths: ['/a.processed.glb'] },
    }));
    fs.writeFileSync(absPath + '.meta.local.json', JSON.stringify({ modelCache: { hash: 'h1', lodBytes: [128] } }));
    expect(readMetaSidecar(absPath).modelCache).toEqual({
      processedPath: '/a.processed.glb', lodPaths: ['/a.processed.glb'], hash: 'h1', lodBytes: [128],
    });
  });

  it('a non-object committed block is left alone, and the blocks AFTER it still merge', () => {
    // The `typeof target !== 'object'` half. It reads as belt-and-braces, and is not: narrowing the
    // guard to `if (!(block in meta)) continue` passes every other test here, then THROWS on this
    // input (a property assignment onto `null`) into `readMetaSidecar`'s catch — which silently
    // abandons the merge for every block later in CACHE_BLOCKS. `environmentCache` follows
    // `audioCache` in that order, so its stats are what prove the loop survived.
    fs.writeFileSync(absPath + '.meta.json', JSON.stringify({
      id: 'g', version: 2, audioCache: null, environmentCache: { hash: 'h' },
    }));
    fs.writeFileSync(absPath + '.meta.local.json', JSON.stringify({
      audioCache: { bytes: 1 }, environmentCache: { bytes: 2 },
    }));
    const meta = readMetaSidecar(absPath);
    expect(meta.audioCache).toBeNull();
    expect(meta.environmentCache).toEqual({ hash: 'h', bytes: 2 });
  });

  it('a write that peels a block EMPTY commits no block at all', () => {
    // The same lie in the committed half (#1279 review, F1): `"audioCache": {}` passes `!!` on every
    // machine, so the build would convert a clip nobody imported — CI included, where ffmpeg's
    // absence then fails the strict gate. No reimport handler can write one (each carries a `hash`,
    // or processedPath/lodPaths for models); a wholesale `/api/write-meta` payload can.
    writeMetaSidecar(absPath, { id: 'g', audioCache: { bytes: 1236743 } });
    const committed = JSON.parse(fs.readFileSync(absPath + '.meta.json', 'utf-8'));
    expect(committed).not.toHaveProperty('audioCache');
    // …and the stats go with it: with no committed block to merge into they are unreadable.
    expect(fs.existsSync(absPath + '.meta.local.json')).toBe(false);
  });

  it('still merges the stats INTO a block the committed sidecar has', () => {
    // The accept side — without it the fix could be "never merge anything" and this suite would
    // not notice, which would silently undo #127's `modelCache.hash` peel and every live byte-size
    // the inspector shows.
    fs.writeFileSync(absPath + '.meta.json', JSON.stringify({
      id: 'g', version: 2, audioCache: { hash: 'h', ext: 'mp3' },
    }));
    localStatsOnly();
    expect(readMetaSidecar(absPath).audioCache).toEqual({ hash: 'h', ext: 'mp3', bytes: 1236743 });
  });
});
