/**
 * Guard against #127: a committed `.meta.json` sidecar must never carry
 * `modelCache.hash`. That hash is machine-dependent BY CONSTRUCTION — both
 * `hashKey` (plugins/model-cache.ts) and `riggedHash` (plugins/rigged-model-
 * optimize.ts) mix in local gltfpack/gltf-transform/meshopt CLI versions, and
 * `riggedHash` additionally encodes whether `toktx` exists at all (a manual,
 * per-machine install). Four clones therefore never converge on one value —
 * each rewrites it back on its own next build, and commit 471ca0cf's entire
 * GLB-sidecar diff was 7 `"hash"` lines and nothing else.
 *
 * `plugins/meta-sidecar.ts` now peels `modelCache.hash` into the gitignored
 * `<asset>.meta.local.json` sibling (see its module doc for the full committed
 * vs machine-local split). This test asserts that peel actually holds across
 * every TRACKED sidecar in the repo — the regression that reopens #127 is a
 * committed `.meta.json` that (re)gained the key, e.g. from a tool that writes
 * the sidecar without going through `writeMetaSidecar`.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { hashKey } from '../../plugins/texture-cache';
import { resolveTextureSettings, type TextureType, type TextureImportSettings } from '../../packages/modoki/src/runtime/loaders/textureSettings';
import { hashKey as fontHashKey } from '../../plugins/font-cache';
import { audioHashKey } from '../../plugins/audio-cache';
import { envHashKey } from '../../plugins/env-cache';
import { resolveFontSettings } from '../../packages/modoki/src/runtime/core/fontSettings';
import { resolveEnvSettings } from '../../packages/modoki/src/runtime/core/environmentSettings';
import { resolveAudioSettings } from '../../packages/modoki/src/runtime/loaders/audioSettings';
import { hasInternalGames } from '../helpers/repoLayout';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

/**
 * The non-emptiness floors below are claims about the PRIVATE repo's population, not about the
 * guard's logic — every one of the 211 texture / 3 audio / 3 environment records they were sized
 * against lives under `games/**`, which the public snapshot does not ship. The STALENESS assertion
 * is the actual guard and stays unconditional: a stale sidecar in `engine/` or a shipped demo must
 * still go red on the public gate.
 *
 * Measured in the assembled snapshot (`npm run verify:publish`): 2 texture sidecars carrying no
 * `textureCache` block at all, 1 font (with a hash), 0 audio, 1 environment (no block) — so
 * `> 50`/`> 0` failed there on three of the four kinds while this tree was green. `npm run verify`
 * cannot see that class; only the hub's publish gate can.
 */
const INTERNAL_GAMES = hasInternalGames();

/** Every `.meta.json` tracked by git, repo-root-relative. `-z` is required —
 *  without it git quotes/escapes non-ASCII paths (e.g. the tropical-island
 *  Cyrillic texture names) and they fail to open as literal strings. */
function trackedMetaSidecars(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '*.meta.json'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
  });
  return out.split('\0').filter(Boolean);
}

describe('committed .meta.json sidecars never carry modelCache.hash (#127)', () => {
  it('has no tracked sidecar with modelCache.hash', () => {
    const offenders: string[] = [];
    for (const rel of trackedMetaSidecars()) {
      const abs = path.join(PROJECT_ROOT, rel);
      let json: unknown;
      try {
        json = JSON.parse(fs.readFileSync(abs, 'utf-8'));
      } catch {
        continue; // unparsable — not this guard's concern
      }
      if (!json || typeof json !== 'object') continue;
      const modelCache = (json as Record<string, unknown>).modelCache;
      if (modelCache && typeof modelCache === 'object' && 'hash' in modelCache) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      offenders.length > 0
        ? `${offenders.length} committed sidecar(s) carry modelCache.hash (#127 — machine-dependent, ` +
          `churns between clones): ${offenders.join(', ')}\nRun: node engine/scripts/migrate-meta-sidecars.mjs`
        : undefined,
    ).toEqual([]);
  });
});

/**
 * #161 — the OPPOSITE case to the guard above, and the contrast is the whole point.
 *
 * `modelCache.hash` is machine-dependent by construction, so it is peeled out of the committed
 * sidecar entirely. `textureCache.hash` is NOT: `hashKey` is
 * `sha256(source bytes ‖ stableSettings ‖ ENCODER_VERSION)` — no paths, no timestamps, no tool
 * version. It is therefore a genuine cross-machine claim, and committing it is correct. Its
 * presence is also load-bearing rather than merely informational: `vite-asset-scanner.ts` uses it
 * to decide a conversion EXISTS at all, and without it the manifest bakes no texture settings and
 * the runtime falls back to a source PNG the production build drops.
 *
 * The failure it actually had was staleness, not impurity. A `maxSize` reduction pass over
 * `games/sling` left all 25 of its texture sidecars recording an artifact the pipeline had stopped
 * producing — one claiming 2048²/12 mips under a `maxSize: 512` settings block sitting three lines
 * above it. Nothing caught it, because the record is only ever consulted as a cache KEY: a wrong
 * one costs a re-encode, not a failure. It surfaced as tree churn — opening the project served the
 * textures, missed the cache on the stale hash, auto-baked, and rewrote the sidecars — which is the
 * worst way for it to surface. A tree that is dirty before you have typed anything is what makes
 * `git diff -- games/ demos/` (the manual stand-in for #18's declined pre-commit hook) stop being a
 * signal, and a genuine stray edit then rides along unnoticed.
 *
 * Because the hash is pure, this guard is EXACT rather than heuristic: it recomputes each committed
 * hash from committed inputs. That also subsumes the dimension contradiction — a record cannot be
 * stale in its `width`/`mipLevels` while its hash still reproduces. It deliberately imports
 * `hashKey`/`resolveTextureSettings` instead of reimplementing them, so an encoder-version bump or
 * a new setting in the key cannot leave the guard checking a formula the pipeline no longer uses.
 */
describe('committed textureCache.hash reproduces from committed inputs (#161)', () => {
  it('every tracked texture sidecar records the artifact its own settings produce', () => {
    const stale: string[] = [];
    let checked = 0;
    for (const rel of trackedMetaSidecars()) {
      if (!/\.(png|jpg|jpeg|webp)\.meta\.json$/i.test(rel)) continue;
      const abs = path.join(PROJECT_ROOT, rel);
      let json: Record<string, unknown>;
      try { json = JSON.parse(fs.readFileSync(abs, 'utf-8')) as Record<string, unknown>; }
      catch { continue; }
      const committed = (json.textureCache as { hash?: string } | undefined)?.hash;
      if (typeof committed !== 'string') continue;   // never imported — nothing to reproduce
      const src = abs.replace(/\.meta\.json$/, '');
      // A sidecar whose source is untracked (e.g. a large PNG kept out of git) cannot be checked
      // here and must not fail the guard — the claim is about sidecars we can actually verify.
      if (!fs.existsSync(src)) continue;
      const settings: TextureImportSettings = resolveTextureSettings(
        json as { type?: TextureType; texture?: Partial<TextureImportSettings> },
      );
      const recomputed = hashKey(fs.readFileSync(src), settings);
      checked++;
      if (recomputed !== committed) stale.push(`${rel}  (committed ${committed} → recomputes to ${recomputed})`);
    }
    // A guard that silently checked nothing would be indistinguishable from a passing one — and
    // this one reads its work-list from `git ls-files`, which is exactly the kind of input that can
    // go empty (wrong cwd, a shallow/exportless checkout) without erroring. Private repo only: the
    // snapshot ships 2 texture sidecars and neither carries a hash (see the note at the top).
    if (INTERNAL_GAMES) expect(checked).toBeGreaterThan(50);
    expect(
      stale,
      stale.length > 0
        ? `${stale.length} committed textureCache block(s) are STALE — they record an artifact the ` +
          `current settings no longer produce (#161):\n  ${stale.join('\n  ')}\n` +
          `Fix: reimport those assets (editor, or POST /api/reimport {path,recursive:true}) and commit the sidecars.`
        : undefined,
    ).toEqual([]);
  });
});

/**
 * The same guard for the OTHER committed cache blocks, added in the #161/#162 close-out sweep.
 *
 * Fixing textures answered "is this one block stale"; it did not answer "which blocks are exposed
 * to this at all". `meta-sidecar.ts` peels six: `modelCache` (hash never committed — see the first
 * guard) plus `textureCache`, `fontCache`, `audioCache`, `environmentCache` and `atlasCache`.
 * Committed, tracked, and carrying a hash the texture-only guard could not see:
 *
 *     textureCache 211  ·  fontCache 4  ·  audioCache 3  ·  environmentCache 3  ·  atlasCache 1
 *
 * All of these hashes are the same pure shape as the texture one
 * (`sha256(source bytes ‖ stableSettings ‖ <KIND>_ENCODER_VERSION)`), so they can be checked
 * exactly — and all are reachable by the identical failure: edit the settings block, never
 * reimport, and the record silently describes an artifact the pipeline stopped producing. Nothing
 * about the defect is texture-specific; textures are only where it was noticed.
 *
 * NOT covered, deliberately: `atlasCache`. `atlasHashKey` is keyed on the member sprites' GUIDs,
 * rects and TEXTURE BYTES resolved through the project-wide asset index, not on the sidecar's own
 * source file — reproducing it here would mean running the asset scanner, a different and much
 * slower kind of test. One committed atlas exists; it is named here as a known gap rather than
 * silently skipped, because a guard whose exclusions are invisible reads as total coverage.
 */
describe('the other committed cache-block hashes reproduce too (#161 sweep)', () => {
  const KINDS = [
    {
      block: 'fontCache', ext: /\.(ttf|otf|woff2?)\.meta\.json$/i,
      recompute: (json: Record<string, unknown>, bytes: Buffer) =>
        fontHashKey(bytes, resolveFontSettings(json as Parameters<typeof resolveFontSettings>[0])),
    },
    {
      block: 'audioCache', ext: /\.(mp3|wav|ogg|m4a|aac|flac)\.meta\.json$/i,
      recompute: (json: Record<string, unknown>, bytes: Buffer) =>
        audioHashKey(bytes, resolveAudioSettings(json as Parameters<typeof resolveAudioSettings>[0])),
    },
    {
      block: 'environmentCache', ext: /\.(hdr|exr)\.meta\.json$/i,
      recompute: (json: Record<string, unknown>, bytes: Buffer) =>
        envHashKey(bytes, resolveEnvSettings(json as Parameters<typeof resolveEnvSettings>[0])),
    },
  ] as const;

  for (const kind of KINDS) {
    it(`every tracked ${kind.block} record reproduces from its committed source + settings`, () => {
      const stale: string[] = [];
      let checked = 0;
      for (const rel of trackedMetaSidecars()) {
        if (!kind.ext.test(rel)) continue;
        const abs = path.join(PROJECT_ROOT, rel);
        let json: Record<string, unknown>;
        try { json = JSON.parse(fs.readFileSync(abs, 'utf-8')) as Record<string, unknown>; }
        catch { continue; }
        const committed = (json[kind.block] as { hash?: string } | undefined)?.hash;
        if (typeof committed !== 'string') continue;
        const src = abs.replace(/\.meta\.json$/, '');
        if (!fs.existsSync(src)) continue;
        checked++;
        const recomputed = kind.recompute(json, fs.readFileSync(src));
        if (recomputed !== committed) stale.push(`${rel}  (committed ${committed} → recomputes to ${recomputed})`);
      }
      // Lower bar than the texture guard on purpose — these kinds have single-digit populations, so
      // the useful assertion is only "the work-list was not empty", which is what would silently
      // hollow this out if the extension globs stopped matching. Private repo only: the snapshot
      // ships 0 audio and no environment cache block (see the note at the top).
      if (INTERNAL_GAMES) expect(checked).toBeGreaterThan(0);
      expect(
        stale,
        stale.length > 0
          ? `${stale.length} committed ${kind.block} block(s) are STALE (#161):\n  ${stale.join('\n  ')}\n` +
            `Fix: reimport those assets and commit the sidecars.`
          : undefined,
      ).toEqual([]);
    });
  }
});
