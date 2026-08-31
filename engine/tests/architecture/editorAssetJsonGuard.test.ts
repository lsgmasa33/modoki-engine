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
 *  `runtime/loaders/assetFetch.ts` instead, except the allowlisted files below. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';

const editorDir = path.resolve(__dirname, '../../packages/modoki/src/editor');

/** Files allowed to fetch `<expr>.path` and read the response without `parseAssetJson`, each with
 *  the reason it is not the trap above. Keep this list SHORT and reasoned — an entry is a claim
 *  that this specific call site does not hit the SPA-fallback trap. */
const ALLOWLIST = new Map<string, string>([
  [
    'panels/assetViews/AtlasAssetView.tsx',
    'Fetches its `.atlas.json` as TEXT (`.text()`), not `.json()` — the exact bytes are kept as '
    + 'the write path\'s compare-and-swap baseline (#439), so this legitimately never calls '
    + '`.json()` at all and would not trip the matcher below regardless.',
  ],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(abs);
  }
  return out;
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
  it('has no unguarded fetch(<...>.path) + .json() in editor/**', () => {
    const offenders: string[] = [];
    for (const abs of walk(editorDir)) {
      const rel = path.relative(editorDir, abs).replace(/\\/g, '/');
      if (ALLOWLIST.has(rel)) continue;
      const raw = fs.readFileSync(abs, 'utf8');
      const code = stripComments(raw);
      assertScanIsSane(raw, code, rel);
      for (const line of findOffenders(code)) offenders.push(`${rel}:${line}`);
    }
    expect(
      offenders,
      'Parse an asset document fetched by path with parseAssetJson(res, path) from '
      + 'runtime/loaders/assetFetch.ts, not a bare res.json(). A missing/renamed asset arrives as '
      + '200 OK index.html (the dev server\'s SPA fallback), so res.ok is true and res.json() '
      + 'throws "Unexpected token \'<\'" — reporting a corrupt asset when the asset is merely '
      + 'absent (#460). If this call site genuinely cannot hit the SPA fallback, add it to '
      + 'ALLOWLIST in this file WITH the reason.\n\nOffending call sites:\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  /** The allowlist must not rot into a place to silence the guard: every entry has to name a file
   *  that still exists. */
  it('every allowlist entry is still real', () => {
    for (const [rel, reason] of ALLOWLIST) {
      const abs = path.join(editorDir, rel);
      expect(fs.existsSync(abs), `allowlisted file no longer exists: ${rel}`).toBe(true);
      expect(reason.length, `${rel} needs a real reason`).toBeGreaterThan(40);
    }
  });
});
