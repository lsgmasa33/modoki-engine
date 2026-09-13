/** Playable-ad artifact smoke — builds a game's VITE_PLAYABLE single-file export and drives the
 *  REAL index.html in headless Chromium (Playwright), asserting what unit tests can't: the artifact
 *  actually self-extracts, renders in WebGL2, decodes offline via the DecompressionStream->fflate
 *  fallback, honours the MRAID viewable gate + routes the CTA through mraid.open, and reflows across
 *  orientations. Mirrors `smoke:packaged` (a real-boot fidelity check the static guards can't give).
 *
 *  Usage:  node engine/scripts/smoke-playable.mjs [games/<id>]   (default: games/space-invader)
 *  Exits non-zero on any failed check. Needs a Playwright Chromium (`npx playwright install chromium`).
 *
 *  This found the fflate-`$`-corruption bug that every unit test missed — keep it in the loop for
 *  any change under engine/plugins/inlinePlayable.ts, engine/app/playable/**, or the VITE_PLAYABLE
 *  path in engine/vite.config.ts. */

import { chromium } from 'playwright';
import { repoFiles } from './repoCorpus.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const project = process.argv[2] || 'games/space-invader';
const artifact = path.join(REPO_ROOT, project, 'ads', 'index.html');
// Read from the project rather than hardcoded: this script already takes a project argument, and a
// second game (games/wordweave, #934) made the space-invader-shaped constant wrong for it.
const projectCfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, project, 'project.config.json'), 'utf8'));
const CLICK_URL = projectCfg.build?.playableClickUrl ?? '';
const MAX_BYTES = projectCfg.build?.playableMaxBytes ?? 5 * 1024 * 1024;

let failures = 0;
const ok = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) failures++; };

// 0. Build the artifact fresh.
console.log(`[smoke-playable] building ${project} playable…`);
fs.rmSync(path.join(REPO_ROOT, project, 'ads'), { recursive: true, force: true });
execFileSync('node', ['engine/scripts/build-web.mjs', '--target', 'playable'], {
  cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, MODOKI_PROJECT: project, VITE_PLAYABLE: '1' },
});
if (!fs.existsSync(artifact)) { console.error(`[smoke-playable] no artifact at ${artifact}`); process.exit(1); }
// ⚠️ **Measure the file, do not trust the build's own cap check.** `inlinePlayable.ts` WRITES
// index.html before it compares the size, so an over-budget artifact is left on disk by a build that
// then throws — and a build run with its output piped somewhere nobody reads looks like a pass.
// This is the only assertion in the repo that reads the shipped byte count.
/** Does this project ship any audio at all? Decides whether check 1b applies — see its comment.
 *
 *  ⚠️ `repoFiles()`, not a readdir walk of my own: `corpusProducerIsShared.test.ts` refuses a
 *  hand-rolled recursive walker repo-wide, and it is right to — the shared one is the only place
 *  that knows what git tracks, what to exclude, and how to avoid the path round-trip that silently
 *  empties a corpus. `floor: 0` because ZERO is a legitimate answer here and the whole point of the
 *  probe; the floor exists to catch a filter that matches nothing by accident, which this is not. */
const projectHasAudio = repoFiles({
  under: path.join(REPO_ROOT, project, 'runtime', 'assets'),
  match: /\.(mp3|m4a|aac|wav|ogg|flac)$/i,
  floor: 0,
}).length > 0;

const artifactBytes = fs.statSync(artifact).size;
ok('0  artifact is under the configured cap', artifactBytes <= MAX_BYTES,
  `${(artifactBytes / 1048576).toFixed(2)} MB of ${(MAX_BYTES / 1048576).toFixed(2)} MB cap`);
// pathToFileURL, not a `file://${…}` template: `artifact` is an absolute OS path, so a
// space in the repo path (or a Windows drive letter) yields a URL page.goto cannot open.
const ART = pathToFileURL(artifact).href;

const MRAID_INIT = (viewable) => `(() => {
  const L = {}; window.__mraidOpen = null; window.__viewable = ${viewable};
  window.mraid = {
    getState: () => 'default', isViewable: () => window.__viewable,
    addEventListener: (e, l) => { (L[e] = L[e] || []).push(l); },
    removeEventListener: (e, l) => { L[e] = (L[e] || []).filter((x) => x !== l); },
    open: (u) => { window.__mraidOpen = u; },
    __fire: (e, ...a) => { (L[e] || []).slice().forEach((l) => l(...a)); },
  };
})();`;

const bootState = (page) => page.evaluate(() => ({
  assets: Object.keys(globalThis.__PLAYABLE_ASSETS__ || {}).length,
  audioAssets: Object.keys(globalThis.__PLAYABLE_ASSETS__ || {}).filter((k) => k.includes('/audio/')).length,
  canvas: !!document.querySelector('canvas'),
  canvasW: document.querySelector('canvas')?.width || 0,
  bootErr: (document.body || document.documentElement).getAttribute('data-playable-error'),
  installPill: !!document.querySelector('button[aria-label="Install"]'),
  // #1108 — an ad placeholder that shipped INSIDE the ad. Matched on rendered text, deliberately:
  // the UI renderer attaches no per-entity attribute, so there is no name selector for the slot,
  // and a geometry rule ("an opaque full-width strip across the bottom") cannot tell a fake banner
  // from a legitimate bottom HUD row — it would need an allowlist on day one. This needs none.
  // ⚠️ What it cannot see: a placeholder with no text, one drawn as an image or on the canvas, or
  // one positioned off the bottom edge. And it is a repo-wide ban on the PHRASE, so a creative
  // whose legitimate copy says "no banner ads" would fail it and need an allowlist then.
  adPlaceholder: (() => {
    const m = /^.*\bbanner ad\b.*$/im.exec(document.body?.innerText || '');
    return m ? m[0].trim().slice(0, 80) : null;
  })(),
  // ⚠️ **The positive control for the check above, and it is load-bearing** (#1108 close-out
  // findings F2 + round-2 finding 6). `adPlaceholder` is an ABSENCE, and an absence is trivially
  // true before the game's UI exists: measured on a banner-carrying build, `innerText` at the
  // moment `__PLAYABLE_ASSETS__ && canvas` resolves is just "Loading… | Install" and the match is
  // null. Only the fixed 1500 ms sleep stood between that and a vacuous PASS.
  //
  // ⚠️ **The first fix for that was ALSO an absence** — `!/Loading/.test(innerText)` — which is
  // true of an EMPTY body, so a bundle that throws before React mounts still printed PASS
  // (measured: `t=6ms {booted:true, txt:""}`). And it double-banned a phrase: `games/court` renders
  // 'Loading…' in its own store panel, so a court creative showing that panel would have FAILED.
  // Both gone: this counts RENDERED DOM UI instead, which is what a text probe for the banner
  // actually depends on.
  //
  // The banner is a DOM UI element, so "no DOM UI at all" makes the probe meaningless rather than
  // passing — reported `n/a`, the same way check 1b handles a project that ships no audio.
  uiTextEls: [...document.body.querySelectorAll('*')]
    .filter((el) => el.getAttribute('aria-label') !== 'Install'
      && !!(el.textContent || '').trim()
      && ![...el.children].some((c) => (c.textContent || '').trim()))
    .length,
}));

// `channel:'chromium'` uses the full Chromium build (no chrome-headless-shell dependency).
let browser;
try { browser = await chromium.launch({ channel: 'chromium' }); } catch { browser = await chromium.launch(); }
try {
  // 1. Standalone boot + WebGL2 render.
  {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    await page.goto(ART, { waitUntil: 'load' });
    await page.waitForFunction(() => globalThis.__PLAYABLE_ASSETS__ && document.querySelector('canvas'), { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const s = await bootState(page);
    ok('1a self-extracts (__PLAYABLE_ASSETS__ populated)', s.assets >= 6, `${s.assets} assets`);
    // ⚠️ Conditional on the PROJECT having audio, not asserted unconditionally. It was written for
    // space-invader, which ships clips; games/wordweave (#934) ships none at all — no audio assets,
    // no `AudioSource` in its scene — so a bare `>= 1` reported a FAILING smoke for a correct
    // artifact. A check that a second project cannot pass is a check about the first project.
    // The expectation is derived from the source tree, so a game that HAS audio and inlines none
    // still fails, which is the regression this exists to catch.
    if (projectHasAudio) {
      ok('1b audio inlined offline', s.audioAssets >= 1, `${s.audioAssets} audio blobs`);
    } else {
      console.log(`n/a   1b audio inlined offline — ${project} ships no audio assets`);
    }
    ok('1c WebGL canvas renders', s.canvas && s.canvasW > 0, `canvas w=${s.canvasW}`);
    ok('1d no bootstrap error', !s.bootErr, s.bootErr || '');
    ok('1e no console/page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    // An MRAID creative has no ad SDK and can never fill a banner, so a banner placeholder in it is
    // not "unfilled" — it is dead pixels the creative paid for, and it sits under the Install CTA.
    // wordweave shipped one across 9.1% of the ad (#1108) and this script, which already drove the
    // artifact, was the only thing in the repo positioned to catch it.
    // ⚠️ The presence half is not a nicety: without it this check cannot fail on a creative whose
    // UI never rendered, which is the state it is MOST likely to be in. Wait for DOM UI to appear
    // rather than for a phrase to disappear.
    await page.waitForFunction(() => [...document.body.querySelectorAll('*')]
      .filter((el) => el.getAttribute('aria-label') !== 'Install'
        && !!(el.textContent || '').trim()
        && ![...el.children].some((c) => (c.textContent || '').trim())).length > 3,
    { timeout: 10000 }).catch(() => {});
    const sBoot = await bootState(page);
    if (sBoot.uiTextEls > 3) {
      ok('1h no ad-banner placeholder in the creative', !sBoot.adPlaceholder, sBoot.adPlaceholder || '');
    } else {
      console.log(`n/a   1h no ad-banner placeholder — ${project} rendered ${sBoot.uiTextEls} DOM `
        + 'text elements, so a text probe cannot see a banner either way (1c/1d/1e cover a '
        + 'creative that failed to render at all)');
    }
    // Audio must NOT auto-play on load: muted until the FIRST user gesture (even standalone, where
    // the ad is "viewable" immediately). Then a tap unmutes it.
    const mutedOnLoad = await page.evaluate(() => globalThis.__playableAudioMuted?.() ?? null);
    ok('1f audio MUTED on load (no autoplay)', mutedOnLoad === true, `muted=${mutedOnLoad}`);
    await page.evaluate(() => window.dispatchEvent(new Event('pointerdown')));
    await page.waitForTimeout(50);
    ok('1g audio unmutes after first tap', (await page.evaluate(() => globalThis.__playableAudioMuted())) === false);
  }

  // 2. Offline fallback (#3): DecompressionStream removed → fflate must still decode.
  {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await page.addInitScript(() => { delete window.DecompressionStream; });
    await page.goto(ART, { waitUntil: 'load' });
    await page.waitForFunction(() => globalThis.__PLAYABLE_ASSETS__, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    const s = await bootState(page);
    ok('2  fflate fallback decodes w/o DecompressionStream', s.assets >= 6 && !s.bootErr, `${s.assets} assets, err=${s.bootErr || 'none'}`);
  }

  // 3. MRAID viewable gate + CTA clickthrough.
  {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await page.addInitScript(MRAID_INIT(false)); // container present, NOT viewable
    await page.goto(ART, { waitUntil: 'load' });
    await page.waitForFunction(() => globalThis.__PLAYABLE_ASSETS__, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    ok('3a CTA withheld while off-screen', (await bootState(page)).canvas && !(await bootState(page)).installPill);
    await page.evaluate(() => { window.__viewable = true; window.mraid.__fire('viewableChange', true); });
    await page.waitForFunction(() => !!document.querySelector('button[aria-label="Install"]'), { timeout: 5000 }).catch(() => {});
    ok('3b CTA Install pill appears once viewable', (await bootState(page)).installPill);
    await page.click('button[aria-label="Install"]').catch(() => {});
    const opened = await page.evaluate(() => window.__mraidOpen);
    ok('3c Install routes through mraid.open(storeUrl)', opened === CLICK_URL, `mraid.open(${opened})`);
  }

  // 4. Orientation reflow.
  {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await page.goto(ART, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('canvas'), { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    const rect = () => page.evaluate(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
    const p = await rect();
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(600);
    const l = await rect();
    ok('4  canvas reflows portrait↔landscape', p.w > 0 && l.w > 0 && (p.w !== l.w || p.h !== l.h), `P ${p.w}x${p.h} → L ${l.w}x${l.h}`);
  }
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? '✅ playable smoke PASSED' : `❌ playable smoke: ${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
