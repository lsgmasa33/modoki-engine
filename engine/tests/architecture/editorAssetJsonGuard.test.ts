/** Guard: every editor panel that fetches an asset DOCUMENT by its `.path` parses the response
 *  through `parseAssetJson`, never a bare `.json()`.
 *
 *  WHY. `runtime/**` already carries this fix — `assetJsonGuard.test.ts` guards it there — but the
 *  EDITOR panels that load the same documents (SkinEditor/TimelineEditor/ParticleEditor/
 *  AnimationEditor, all opening `.rig2d.json`/`.timeline.json`/`.particle.json`/`.anim.json`) never
 *  adopted it (#460). The dev server answers an unknown path with its SPA fallback — `200
 *  index.html` — so `res.ok` is true and a bare `res.json()` throws `SyntaxError: Unexpected token
 *  '<', "<!doctype "…`, which reads as a CORRUPT asset when the truth is "no asset at this path".
 *  The owner hit exactly this live, from a panel with a stale/rebased path under a live editor.
 *
 *  THE RULE. No editor source calls `fetch(<expr>.path)` / `fetch(path)` and hands the response to
 *  `.json()` — it must go through `parseAssetJson(res, path)` from
 *  `runtime/loaders/assetFetch.ts` instead.
 *
 *  ⚠️ **There is deliberately NO allowlist, and that is the fix (#1123).** There was one, keyed per
 *  FILE, holding a single row for `panels/assetViews/AtlasAssetView.tsx` — whose own reason admitted
 *  the file "would not trip the matcher below regardless". Measured 2026-09-12 on work-ai2: `FETCH_PATH_CALL`
 *  matches that file **zero** times, so the row pardoned nothing and was a standing pre-approval for
 *  whatever `fetch(x.path)` + `.json()` somebody added there later. That is the grain defect in its
 *  purest form — a pardon for zero occurrences, which no staleness check in the old file looked for.
 *
 *  The knowledge the row carried is kept, because it is the useful part: AtlasAssetView fetches its
 *  `.atlas.json` as TEXT (`.text()`), since the exact bytes are the write path's compare-and-swap
 *  baseline (#439). That is why it does not match — not why it is excused.
 *
 *  So this guard needs no exemption ledger (`@modoki/engine/testing/exemptionLedger` is for guards
 *  that actually have pardons). What it needed instead was the **non-vacuity floor** below: with the
 *  row gone, nothing else proved the matcher still matches, and a rule whose detector silently stops
 *  matching reports green having examined nothing. Adjacent to #1105, which is that defect on its own
 *  rather than as a consequence of removing a pardon. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const editorDir = path.resolve(__dirname, '../../packages/modoki/src/editor');

/** Every `.ts`/`.tsx` under editor/**, via the shared corpus producer (#799/#771/#805 Phase 4).
 *  Floored well under the 240 measured today. */
function editorSources() {
  return repoFiles({ under: editorDir, match: /\.tsx?$/, floor: 150 });
}

/** Matches `fetch(asset.path)`, `fetch(path)`, `fetch(x.y.path)` — with or without a trailing
 *  options arg — but NOT `backendFetch(...)` (case-sensitive, and `\bfetch\(` alone would still
 *  match the tail of that name) and NOT `fetch(assetUrl(asset.path))` (the argument there is a call
 *  expression, not a bare `<expr>.path` — deliberately narrower, per the brief). */
const FETCH_PATH_CALL = /(?<![\w$])fetch\(\s*(?:[\w$]+(?:\.[\w$]+)*\.path|path)\s*[,)]/g;

/** How far past a matched `fetch(...path)` call to look for the `.json(`/`parseAssetJson` that
 *  decides its fate — generously past a `.then((r) => …)` chain or an `await`+next-statement pair,
 *  short enough that it can't wander into an unrelated call further down the file. */
const LOOKAHEAD = 400;

function findOffenders(code: string): number[] {
  const lines: number[] = [];
  let m: RegExpExecArray | null;
  FETCH_PATH_CALL.lastIndex = 0;
  while ((m = FETCH_PATH_CALL.exec(code))) {
    const start = m.index;
    const window = code.slice(start, start + LOOKAHEAD);
    if (window.includes('parseAssetJson')) continue; // routed through the fix — fine
    if (/\.json\s*\(/.test(window)) {
      lines.push(code.slice(0, start).split('\n').length);
    }
  }
  return lines;
}

describe('editor asset-document loads are parsed through parseAssetJson, not res.json() (#460)', () => {
  /** Every `fetch(<...>.path)` site in editor/**, classified. Nothing is skipped by file — that skip
   *  was the defect. `routed` is the arm that proves the matcher still works: offenders counting down
   *  to zero as the migration succeeds is a countdown, not a pin. */
  function scan(): { offenders: string[]; sites: number; routed: number } {
    const offenders: string[] = [];
    let sites = 0;
    let routed = 0;
    for (const { abs } of editorSources()) {
      const rel = path.relative(editorDir, abs).replace(/\\/g, '/');
      const raw = fs.readFileSync(abs, 'utf8');
      const code = stripComments(raw);
      assertScanIsSane(raw, code, rel);
      FETCH_PATH_CALL.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = FETCH_PATH_CALL.exec(code))) {
        sites += 1;
        if (code.slice(m.index, m.index + LOOKAHEAD).includes('parseAssetJson')) routed += 1;
      }
      for (const line of findOffenders(code)) offenders.push(`${rel}:${line}`);
    }
    return { offenders, sites, routed };
  }

  it('the matcher still finds real fetch-by-path sites — without this the rule is vacuous', () => {
    // ⚠️ The arm the old file had no equivalent of. `offenders` is empty on a clean tree BY DESIGN,
    // so `toEqual([])` below cannot distinguish "editor/** is clean" from "FETCH_PATH_CALL stopped
    // matching" — and the regex is a lookbehind-plus-alternation that one edit could silently narrow.
    // Measured 2026-09-12: 18 sites in 15 files, 17 of them routed through parseAssetJson, 0
    // offending. Floored well under both, so only a broken matcher trips it, never ordinary churn.
    const { sites, routed } = scan();
    expect(sites, 'FETCH_PATH_CALL matches nothing — the rule below is green over zero inputs')
      .toBeGreaterThanOrEqual(10);
    expect(routed, 'no site routes through parseAssetJson — the LOOKAHEAD window or the helper name '
      + 'has changed, so every site would read as an offender or as unmatched')
      .toBeGreaterThanOrEqual(8);
  });

  /** ⚠️ **The corpus floors above cannot see `LOOKAHEAD` being WIDENED, and that direction disarms
   *  the rule.** Measured by review: inject a real offender and it reddens at 400; change `LOOKAHEAD`
   *  to 4000 and the SAME offender passes, because the bigger window swallows some unrelated
   *  `parseAssetJson` and the `continue` at the top of the loop fires. Both floors are `>=`, so
   *  `sites` and `routed` only ever go UP — one constant silently turns every offender into a
   *  "routed" one.
   *
   *  This is a third mutation direction the exemption-grain bar does not name: not adding an
   *  occurrence, not deleting one, but LOOSENING THE CLASSIFIER. Two synthetic fixtures pin the
   *  window from both sides, and neither depends on the corpus. */
  describe('the LOOKAHEAD window itself', () => {
    // ⚠️ **The distances below are LITERALS on purpose — 450 and 280, not `LOOKAHEAD ± n`.** The first
    // version of these fixtures derived their padding FROM `LOOKAHEAD`, so they scaled with it and
    // both passed at 400, 4000 and 120: a test that cannot fail, which is `falsifiable-tests.md`'s
    // Shape (E) — the two sides of the comparison sharing a source — committed while fixing a
    // falsifiability bug. The mutation check is what said so. They now bracket 400 from outside.
    const gap = (n: number) => `\n${'x'.repeat(n)}\n`;

    it('an offender whose parseAssetJson sits 450 chars away is still an offender', () => {
      // RED if LOOKAHEAD grows past ~450: the far parseAssetJson comes into view and this reads as
      // routed, which is the direction that silently disarms the whole rule.
      const src = `const r = await fetch(asset.path);\nconst j = await r.json();${gap(450)}parseAssetJson(r, asset.path);\n`;
      expect(findOffenders(src)).toHaveLength(1);
    });

    it('a call whose parseAssetJson sits 280 chars away is routed, not an offender', () => {
      // RED if LOOKAHEAD shrinks below ~340: a correctly-routed call starts being flagged.
      //
      // ⚠️ `.json()` sits IMMEDIATELY after the fetch, and that ordering is what makes this pin
      // work. The first version put it AFTER the far `parseAssetJson`, so shrinking the window
      // dropped BOTH out of view, no `.json(` was found, and the call was not reported — the
      // assertion passed for the wrong reason and the mutation stayed green. A fixture must keep the
      // thing being classified inside the window and move only the CLASSIFIER.
      const src = `const r = await fetch(asset.path);\nconst j = await r.json();${gap(280)}parseAssetJson(r, asset.path);\n`;
      expect(findOffenders(src)).toEqual([]);
    });
  });

  it('has no unguarded fetch(<...>.path) + .json() in editor/**', () => {
    const { offenders } = scan();
    expect(
      offenders,
      'Parse an asset document fetched by path with parseAssetJson(res, path) from '
      + 'runtime/loaders/assetFetch.ts, not a bare res.json(). A missing/renamed asset arrives as '
      + '200 OK index.html (the dev server\'s SPA fallback), so res.ok is true and res.json() '
      + 'throws "Unexpected token \'<\'" — reporting a corrupt asset when the asset is merely '
      + 'absent (#460). Route it through parseAssetJson — and if you believe a call site genuinely '
      + 'cannot hit the SPA fallback, do NOT add a file-level allowlist: that is what #1123 removed '
      + 'from this guard. Pardon the CALL, with a count, via '
      + '@modoki/engine/testing/exemptionLedger.\n\nOffending call sites:\n' + offenders.join('\n'),
    ).toEqual([]);
  });
});
