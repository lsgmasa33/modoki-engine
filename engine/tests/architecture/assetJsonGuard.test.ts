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
 *  `.json()` that file would ever contain (#1123).** `ota/otaClient.ts` held FIVE, under a reason
 *  written about the OTA server, and one of them WAS a fetch of a local manifest (#1132) — it and any
 *  sixth were green, which is the one case this guard exists for. The detector was already per-line, so the
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
      + '— release.json in fetchRelease and again in checkForUpdate, the target bundle manifest in '
      + 'checkForUpdate, '
      + 'and tryFetchManifest. There is no SPA fallback on a CDN to mistake for an asset; a 200-HTML '
      + 'there would be a proxy or captive portal, a different problem with a different fix. The fifth '
      + 'fetch in the file, tryFetchEmbeddedManifest, is same-origin and parses through parseAssetJson (#1132).',
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
      const lines = code.split('\n');
      lines.forEach((line, i) => {
        for (let n = (line.match(/\.json\s*\(\s*\)/g) ?? []).length; n > 0; n -= 1) {
          out.push({ item: rel, site: `${rel}:${i + 1}  ${line.trim()}` });
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
      // 4 measured 2026-09-14 on work-ai3 (5 before #1132 moved the embedded read to parseAssetJson), all in
      // otaClient.ts — so the population IS the pardons today. Floored under it so that REMOVING one
      // reaches the over-blessed arm ("blesses 4, found 3"), which is
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

/** The second half of the same fetch contract: the CACHE POLICY. `ASSET_FETCH_INIT` is `no-store` in
 *  dev (assetFetch.ts says when a stale 304 is possible) and `{}` in a build. Three of the five
 *  sibling def caches — spriteAnim, rig2d, animSet — fetched bare while animationClip and particle
 *  passed it (#1165); nothing but reading them side by side could tell. */
describe('asset fetches through assetUrl() carry ASSET_FETCH_INIT', () => {
  /** Every `fetch(assetUrl(…), …)` call in runtime/**, with the text of its argument list. NOT seen:
   *  a URL built first and fetched by name (`const u = assetUrl(p); fetch(u)`) — none exists today. The
   *  argument list is found by paren depth, not a line regex, so a call wrapped across lines is
   *  still read whole. (`stripComments` blanks comments; string contents are irrelevant here — an
   *  unbalanced paren inside a string literal in a fetch's arguments would mis-scan, and none exists.) */
  function assetUrlFetches(): Array<{ site: string; args: string }> {
    const out: Array<{ site: string; args: string }> = [];
    for (const { abs } of runtimeSources()) {
      const rel = path.relative(runtimeDir, abs).replace(/\\/g, '/');
      const raw = fs.readFileSync(abs, 'utf8');
      const code = stripComments(raw);
      assertScanIsSane(raw, code, rel);
      // `plumbing.assetUrl(` too — the provider-injected twin (`pixiShaderBuilder.ts`), whose init
      // arrives as `plumbing.fetchInit` (registerProviders.ts binds it to ASSET_FETCH_INIT).
      for (const m of code.matchAll(/\bfetch\s*\(\s*(?:[\w$]+\.)?assetUrl\s*\(/g)) {
        const open = code.indexOf('(', m.index);
        let depth = 0;
        let end = open;
        for (; end < code.length; end += 1) {
          if (code[end] === '(') depth += 1;
          else if (code[end] === ')' && (depth -= 1) === 0) break;
        }
        const line = code.slice(0, m.index).split('\n').length;
        out.push({ site: `${rel}:${line}`, args: code.slice(open + 1, end) });
      }
    }
    return out;
  }

  it('has no fetch(assetUrl(…)) without the dev no-store init', () => {
    const calls = assetUrlFetches();
    // 16 measured 2026-09-13 on work-ai2. Floored well under it: only a detector that stopped
    // matching can reach this, and that is what would turn the rule below vacuously green.
    expect(calls.length, 'the fetch(assetUrl(…)) detector matched almost nothing — it is broken').toBeGreaterThan(8);
    const bare = calls.filter((c) => !/\bASSET_FETCH_INIT\b|\.fetchInit\b/.test(c.args)).map((c) => c.site);
    expect(bare, 'Pass ASSET_FETCH_INIT from runtime/loaders/assetFetch.ts:\n'
      + '  fetch(assetUrl(path), ASSET_FETCH_INIT)  or  { signal, ...ASSET_FETCH_INIT }\n'
      + 'Without it the dev editor can be served a cached copy of the asset (see assetFetch.ts).').toEqual([]);
  });
});
