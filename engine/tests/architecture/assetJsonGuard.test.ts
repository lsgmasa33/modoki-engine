/** Guard: every asset-JSON fetch in `runtime/**` parses through `parseAssetJson`, never `.json()`.
 *
 *  WHY. The dev server answers an unknown path with its SPA fallback — `index.html`, status
 *  **200**. So `res.ok` is true, there is no 404, and nothing in the fetch path can tell it from a
 *  real hit; a bare `res.json()` throws `SyntaxError: Unexpected token '<', "<!doctype "…`. That
 *  names the wrong cause: the asset is not corrupt, it is ABSENT. Since a ref pointing at a path
 *  that does not exist is the single most common authoring mistake on this engine, the most common
 *  mistake reported itself as the rarest one.
 *
 *  `parseAssetJson` (runtime/loaders/assetFetch.ts) exists precisely for this and reports
 *  `no asset at <path> — the dev server answered with index.html…`.
 *
 *  WHY A TEST AND NOT A CONVENTION. The helper was introduced with six loaders converted, and the
 *  remaining eight call sites simply stayed as they were — including the SCENE, the asset whose
 *  failure is most visible, which is what #91 turned out to be. `timelineCache.ts` is the sharpest
 *  illustration: it IMPORTED `parseAssetJson`, used it in `getTimeline`, and left `loadTimelineNow`
 *  three functions below parsing raw. A convention that holds for the function that was audited and
 *  not the one next to it is not a convention, it is a coincidence.
 *
 *  It also has teeth beyond message quality: `smoke-packaged.sh` and `assert-app-renders.sh` fail
 *  on ANY renderer console error, so one of these can fail a packaging gate for a reason unrelated
 *  to the commit under test.
 *
 *  THE RULE. No `.json()` call on a Response inside `engine/packages/modoki/src/runtime/**`, except
 *  the allowlist below. Comments are stripped first — several of the files here legitimately
 *  DISCUSS `res.json()` in a comment explaining why they don't call it, and flagging those would
 *  train people to ignore the guard. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const runtimeDir = path.resolve(__dirname, '../../packages/modoki/src/runtime');

/** Files allowed to call `.json()` directly, each with the reason it is not the trap above.
 *  Keep this list SHORT and reasoned — an entry is a claim that the fetch does not go to the
 *  Vite dev server. */
const ALLOWLIST = new Map<string, string>([
  [
    'ota/otaClient.ts',
    'Fetches a REMOTE OTA release server, not the Vite dev server — there is no SPA fallback to '
    + 'mistake for an asset. (A 200-HTML there would be a proxy/captive portal, a different '
    + 'problem with a different fix.)',
  ],
]);

// Comment stripping is the shared scanner (#419) — it tracks string state, so a `//` inside a URL
// string is not mistaken for a comment and needs no `[^:]` hack.

/** Every `.ts`/`.tsx` under runtime/**, via the shared corpus producer (#799/#771/#805 Phase 4).
 *  Floored well under the 540 measured today — only a broken enumeration (a wrong `under`, a
 *  `match` that stops matching) can turn this red, never ordinary source-file churn. */
function runtimeSources() {
  return repoFiles({ under: runtimeDir, match: /\.tsx?$/, floor: 400 });
}

describe('asset JSON is parsed through parseAssetJson, not res.json()', () => {
  it('has no unguarded .json() call anywhere in runtime/**', () => {
    const offenders: string[] = [];
    for (const { abs } of runtimeSources()) {
      const rel = path.relative(runtimeDir, abs).replace(/\\/g, '/');
      if (ALLOWLIST.has(rel)) continue;
      const raw = fs.readFileSync(abs, 'utf8');
      const code = stripComments(raw);
      assertScanIsSane(raw, code, rel);
      code.split('\n').forEach((line, i) => {
        if (/\.json\s*\(\s*\)/.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      'Parse asset JSON with parseAssetJson(res, path) from runtime/loaders/assetFetch.ts.\n'
      + 'A missing asset arrives as 200 OK index.html (the dev server SPA fallback), so res.ok is\n'
      + 'true and res.json() throws "Unexpected token \'<\'" — reporting a corrupt asset when the\n'
      + 'asset is merely absent. If this fetch genuinely does not hit the dev server, add it to\n'
      + 'ALLOWLIST in this file WITH the reason.\n\nOffending call sites:\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  /** The allowlist must not rot into a place to silence the guard: every entry has to name a file
   *  that still exists and still calls `.json()`. A stale entry is a hole nobody can see. */
  it('every allowlist entry is still real and still needed', () => {
    for (const [rel, reason] of ALLOWLIST) {
      const abs = path.join(runtimeDir, rel);
      expect(fs.existsSync(abs), `allowlisted file no longer exists: ${rel}`).toBe(true);
      expect(
        /\.json\s*\(\s*\)/.test(stripComments(fs.readFileSync(abs, 'utf8'))),
        `${rel} no longer calls .json() — drop it from ALLOWLIST`,
      ).toBe(true);
      expect(reason.length, `${rel} needs a real reason`).toBeGreaterThan(40);
    }
  });
});
