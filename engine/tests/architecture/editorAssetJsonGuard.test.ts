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

/** Matches `fetch(asset.path)`, `fetch(path)`, `fetch(x.y.path)` and the same wrapped in `assetUrl(…)` — with or
 *  without a trailing options arg — but NOT `backendFetch(...)` (case-sensitive, and `\bfetch\(` alone would still
 *  match the tail of that name). The `assetUrl(…)` arm was excluded once ("deliberately narrower"); since #1979 a
 *  PATH may only be fetched through `assetUrl` (it percent-encodes), so that wrapped shape is now the ONLY correct
 *  one — every bare site moved to it, and without the arm this rule would be green over zero inputs. */
const PATH_EXPR = String.raw`(?:[\w$]+(?:\.[\w$]+)*\.path|path)`;
const FETCH_PATH_CALL = new RegExp(String.raw`(?<![\w$])fetch\(\s*(?:assetUrl\(\s*${PATH_EXPR}\s*\)|${PATH_EXPR})\s*[,)]`, 'g');

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
    // #1902 then folded every asset-document panel's read into ONE (`panels/assetDocLoad.ts` `readAssetDocFresh`: the
    // five editors, then the Inspector's Material/Shader/AnimSet/multi-material views), which took nine routed sites out
    // of the corpus by design — about 9 sites, 4 routed after it (the helper's own read is a site, not "routed": its
    // `parseAssetJson` wraps the fetch rather than following it). The floors moved down with it rather than a panel read
    // being kept inline to feed them.
    const { sites, routed } = scan();
    expect(sites, 'FETCH_PATH_CALL matches nothing — the rule below is green over zero inputs')
      .toBeGreaterThanOrEqual(6);
    expect(routed, 'no site routes through parseAssetJson — the LOOKAHEAD window or the helper name '
      + 'has changed, so every site would read as an offender or as unmatched')
      .toBeGreaterThanOrEqual(3);
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

/** #1979: an asset PATH reaches the network only through `assetUrl`, which percent-encodes the `%`, `?` and `#` a
 *  URL cannot carry literally (docs/engine-concepts.md, "Asset path vs asset URL"). The close-out review found a dozen
 *  editor sites handing a raw path to `fetch` / a loader / `src` / a CSS `url()`. Each one could open a different file
 *  than the one a later write hit: `my%20fx.particle.json` was read as `my fx.particle.json` and saved over the
 *  literal file.
 *
 *  ⚠️ SCOPE, stated so the green means what it says: the rule sees a value spelled as a PATH — an identifier ending in
 *  `path`/`Path` (`path`, `texPath`, `scenePath`, `assetPath`…) or a `.path` member, bare or inside
 *  `cacheBustReimport(…)` — as the first argument of `fetch(`, a loader's `.load(`/`.loadAsync(`, `cssUrl(`, or a
 *  `src=`. It does NOT see a path held in a variable named otherwise (`p`, `url`, `file`), or one built by a helper call
 *  (`videoPreviewUrl(path, …)`). Naming a path `…Path` is therefore what puts it under this rule. Scanned in
 *  `editor/**` and the app shell (`engine/app/**`). */
describe('an editor fetch / load / src of an asset PATH goes through assetUrl (#1979)', () => {
  const PATHISH = String.raw`(?:[\w$]+(?:\.[\w$]+)*\.path|[\w$]*[pP]ath)\b`;
  const ARG = String.raw`\s*(?:cacheBustReimport\(\s*)?${PATHISH}\s*[,)]`;
  const BARE_PATH_USE = new RegExp(
    String.raw`(?<![\w$])fetch\(${ARG}` // fetch(path) / fetch(x.path) / fetch(cacheBustReimport(path, e))
    + String.raw`|\.load(?:Async)?\(${ARG}` // loader.load(path, …) / loadAsync(texPath)
    + String.raw`|(?<![\w$])cssUrl\(${ARG}` // cssUrl(texPath)
    + String.raw`|\bsrc\s*=\s*\{?\s*${PATHISH}\s*[;}\n]`, // img.src = path / <img src={path}>
    'g');
  const appDir = path.resolve(__dirname, '../../app');

  it('the matcher catches each shape and lets the assetUrl-wrapped one through', () => {
    const hits = (src: string) => (src.match(BARE_PATH_USE) ?? []).length;
    expect(hits('const r = await fetch(path, init);')).toBe(1);
    expect(hits('fetch(asset.path).then(f);')).toBe(1);
    expect(hits('fetch(cacheBustReimport(path, epoch), { signal })')).toBe(1);
    expect(hits('loader.load(path, onLoad);')).toBe(1);
    expect(hits('await gltf.loadAsync(glbPath);')).toBe(1);
    expect(hits('backgroundImage: cssUrl(texPath),')).toBe(1);
    expect(hits('img.src = scenePath;')).toBe(1);
    expect(hits('<img src={path} alt="" />')).toBe(1);
    expect(hits('await fetch(assetUrl(path), init); img.src = assetUrl(path); <img src={assetUrl(path)} />')).toBe(0);
    expect(hits('loader.load(assetUrl(path)); cssUrl(assetUrl(texPath)); fetch(cacheBustReimport(assetUrl(path), e))')).toBe(0);
    expect(hits('backendFetch(path); loadPath(path); fetch(url)')).toBe(0);
  });

  it('has no bare fetch / load / src / cssUrl of a path in editor/** or the app shell', () => {
    const offenders: string[] = [];
    const appSources = repoFiles({ under: appDir, match: /\.tsx?$/, floor: 50 });
    for (const { abs } of [...editorSources(), ...appSources]) {
      const rel = path.relative(path.resolve(editorDir, '../../../..'), abs).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(abs, 'utf8'));
      BARE_PATH_USE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = BARE_PATH_USE.exec(code))) offenders.push(`${rel}:${code.slice(0, m.index).split('\n').length}`);
    }
    expect(offenders, 'route the path through assetUrl(...) — a raw path is not a URL').toEqual([]);
  });
});
