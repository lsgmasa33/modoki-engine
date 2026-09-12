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
 *  the ledger below. Comments are stripped first — several of the files here legitimately
 *  DISCUSS `res.json()` in a comment explaining why they don't call it, and flagging those would
 *  train people to ignore the guard.
 *
 *  ⚠️ **The allowlist was keyed per FILE while the rule is per CALL, so its one entry pardoned every
 *  `.json()` that file would ever contain (#1123).** `ota/otaClient.ts` holds FIVE, under a reason
 *  written about the OTA server; a sixth — say a fetch of a local manifest added to the same module —
 *  was green, which is the one case this guard exists for. The detector was already per-line, so the
 *  only thing discarding the granularity was the `continue` that skipped the whole file.
 *
 *  ⚠️ A COUNT rather than `file::token` here, deliberately: every occurrence is the same token
 *  (`.json()`), so there is nothing to name them apart by except line numbers, which churn on every
 *  edit above them. Where a detector CAN distinguish occurrences, name them — see
 *  `docs/verify-and-ci.md` § "Exemption GRAIN". */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const runtimeDir = path.resolve(__dirname, '../../packages/modoki/src/runtime');

/** Calls allowed to use `.json()` directly, each with the reason it is not the trap above, and each
 *  pardoning a stated NUMBER of them. Keep this SHORT and reasoned — a row is a claim that those
 *  fetches do not go to the Vite dev server. */
const EXEMPT = [
  {
    item: 'ota/otaClient.ts',
    count: 4,
    reason: 'FOUR calls fetch a REMOTE OTA release server, not the Vite dev server — `${baseUrl}/…` '
      + 'at :404, :426, :508 and :684 (the release lookup, its retry, the bundle manifest and '
      + 'tryFetchManifest). There is no SPA fallback on a CDN to mistake for an asset; a 200-HTML '
      + 'there would be a proxy or captive portal, a different problem with a different fix.',
  },
  {
    item: 'ota/otaClient.ts::embedded',
    count: 1,
    reason: 'The FIFTH call (:700, tryFetchEmbeddedManifest) is NOT against that server — its own '
      + "docblock says it is a bare relative URL fetched against the app's own served origin, "
      + 'never baseUrl. So it CAN meet the SPA fallback, and it is exempt for a different reason: '
      + 'missing-or-invalid is an expected, silent outcome for any build predating the feature, so '
      + 'the catch IS the classifier and a 200-HTML reaches the same `return null` as a 404. '
      + '⚠️ The cost is real and stated rather than hidden: a genuinely CORRUPT embedded manifest is '
      + 'indistinguishable from an absent one. Routing it through parseAssetJson would separate '
      + 'them — a behaviour change in shipping OTA code, filed as #1132 rather than made in a close-out.',
  },
] as const;

// Comment stripping is the shared scanner (#419) — it tracks string state, so a `//` inside a URL
// string is not mistaken for a comment and needs no `[^:]` hack.

/** Every `.ts`/`.tsx` under runtime/**, via the shared corpus producer (#799/#771/#805 Phase 4).
 *  Floored well under the 540 measured today — only a broken enumeration (a wrong `under`, a
 *  `match` that stops matching) can turn this red, never ordinary source-file churn. */
function runtimeSources() {
  return repoFiles({ under: runtimeDir, match: /\.tsx?$/, floor: 400 });
}

describe('asset JSON is parsed through parseAssetJson, not res.json()', () => {
  /** Every `.json()` call in runtime/**, one entry per CALL. No file is skipped — that skip was the
   *  defect; the ledger decides what is pardoned. */
  function jsonCalls(): Array<{ item: string; site: string }> {
    const out: Array<{ item: string; site: string }> = [];
    for (const { abs } of runtimeSources()) {
      const rel = path.relative(runtimeDir, abs).replace(/\\/g, '/');
      const raw = fs.readFileSync(abs, 'utf8');
      const code = stripComments(raw);
      assertScanIsSane(raw, code, rel);
      // ⚠️ The embedded-manifest call is keyed SEPARATELY because it is exempt for a different
      // reason — a same-origin fetch, not a CDN one. Without this the two reasons would share one
      // count and the false half would be invisible, which is what review found. Attributed by the
      // enclosing function name, found by walking back to the nearest `function ` declaration.
      const lines = code.split('\n');
      lines.forEach((line, i) => {
        for (let n = (line.match(/\.json\s*\(\s*\)/g) ?? []).length; n > 0; n -= 1) {
          const embedded = lines.slice(0, i + 1).reverse()
            .find((l) => /^\s*(?:async\s+)?function\s/.test(l))
            ?.includes('tryFetchEmbeddedManifest');
          out.push({
            item: embedded ? `${rel}::embedded` : rel,
            site: `${rel}:${i + 1}  ${line.trim()}`,
          });
        }
      });
    }
    return out;
  }

  it('has no unguarded .json() call anywhere in runtime/**', () => {
    assertExemptionLedger({
      label: 'EXEMPT in assetJsonGuard',
      population: jsonCalls(),
      exempt: EXEMPT,
      // 5 measured 2026-09-12 on work-ai2, all in otaClient.ts — so the population IS the pardons today. Floored
      // under it so that REMOVING one reaches the over-blessed arm ("blesses 5, found 4"), which is
      // the message that tells the author to deduct, rather than reporting a broken detector. The
      // real detector-broke check is `runtimeSources()`'s own floor of 400 files.
      floor: 3,
      fix: 'Parse asset JSON with parseAssetJson(res, path) from runtime/loaders/assetFetch.ts.\n'
        + 'A missing asset arrives as 200 OK index.html (the dev server SPA fallback), so res.ok is\n'
        + 'true and res.json() throws "Unexpected token \'<\'" — reporting a corrupt asset when the\n'
        + 'asset is merely absent. If this fetch genuinely does not hit the dev server, add it to\n'
        + 'EXEMPT in this file WITH the reason — or raise an existing row\'s count and say why the\n'
        + 'extra call is safe too.',
    });
  });

  /** A row's reason has to be a sentence, not a shrug. The ledger enforces that each row pardons
   *  something real; this enforces that it says why. */
  it('every EXEMPT row carries a real reason', () => {
    for (const e of EXEMPT) {
      expect(e.reason.length, `${e.item} needs a real reason`).toBeGreaterThan(40);
    }
  });
});
