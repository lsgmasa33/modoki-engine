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

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

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
