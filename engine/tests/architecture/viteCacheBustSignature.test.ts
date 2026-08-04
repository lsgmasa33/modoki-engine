/** Guard: the packaged editor's Vite dep-cache bust signature is built from CONTENT, never
 *  from a file timestamp.
 *
 *  `main.ts` wipes `userData/vite-cache` when the app build changes, because Vite keys its
 *  dep-optimize cache on the LOCKFILE and would otherwise reuse a stale pre-bundled
 *  `@modoki/engine` chunk across an app update. The signature it compares must therefore be a
 *  stable property of the build.
 *
 *  It used to be `${version}:${size}:${mtimeMs}` of `__filename`, which CANNOT work in a
 *  packaged app (#21, measured on packaged Windows 2026-08-02): `__filename` is a path inside
 *  `app.asar`, and Electron's asar `stat` shim reports real sizes but FABRICATES timestamps —
 *  `mtimeMs` came back as the current wall-clock on every launch. The signature never matched
 *  itself, so the editor wiped and cold-re-optimized its entire dep graph on EVERY boot rather
 *  than only after an update. That is the precise opposite of the block's intent, and it meant
 *  every single launch paid the cold-scan race window that #21 is about.
 *
 *  The failure was invisible from the outside — the app booted fine, just always cold — and it
 *  is unreachable from a unit test (it needs a real packaged app + asar). Hence a source guard:
 *  a timestamp must never come back into this signature. The measurements and the general rule
 *  ("never key packaged-build identity on a file timestamp") live in docs/build.md § "Packaged
 *  editor loop", which owns them — this header covers only why the GUARD exists.
 *
 *  KNOWN GAP, accepted: this is a text scan over one file's signature block. It cannot prove the
 *  signature is stable, only that it is not derived from the one input already known to be
 *  fabricated under asar. A future signature built from some other unstable input would pass. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const mainTs = path.resolve(__dirname, '../../electron/main.ts');

/** The statements that compute `buildSig`, comments stripped — this file's own prose explains
 *  the mtime hazard at length and must not read as a violation of it. */
function signatureBlock(): string {
  const src = fs.readFileSync(mainTs, 'utf8');
  const start = src.indexOf('const sigFile = path.join');
  expect(start, 'could not locate the vite-cache bust block in engine/electron/main.ts — if it '
    + 'moved or was renamed, retarget this guard rather than deleting it').toBeGreaterThan(-1);
  // Walk back to the start of the enclosing try, forward to the sig write.
  const from = src.lastIndexOf('try {', start);
  const to = src.indexOf('process.env.MODOKI_VITE_CACHEDIR', start);
  return src
    .slice(from, to)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

describe('packaged Vite dep-cache bust signature (#21)', () => {
  it('does not derive the signature from a file timestamp', () => {
    const block = signatureBlock();
    const offenders = ['mtimeMs', 'mtime', 'ctimeMs', 'ctime', 'birthtimeMs', 'birthtime']
      .filter((prop) => new RegExp(`\\b${prop}\\b`).test(block));
    expect(
      offenders,
      'Electron\'s asar stat shim fabricates timestamps for paths inside app.asar, so a '
        + 'timestamp-derived signature never matches itself and the dep cache is wiped on every '
        + 'boot (#21). Derive the signature from file CONTENT instead.',
    ).toEqual([]);
  });

  it('derives the signature from a content hash', () => {
    const block = signatureBlock();
    expect(
      /createHash\(/.test(block) && /buildSig/.test(block),
      'the bust signature should hash the packaged main.cjs so it changes exactly when the '
        + 'build does — and not otherwise',
    ).toBe(true);
  });

  /** #110: wiping `vite-cache` alone accomplishes NOTHING across an app update. Vite serves
   *  `/deps/*.js?v=<browserHash>` as `Cache-Control: immutable`, and browserHash keys on the
   *  lockfile — not on @modoki/engine source — so an engine-only update leaves the dep URL
   *  byte-identical and Chromium replays the PRE-UPDATE body out of its own disk cache, which
   *  lives in userData and survives the update just like the dep-cache does. The freshly
   *  re-optimized chunk is never read and the renderer dies with "does not provide an export
   *  named '<newly-added export>'".
   *
   *  Measured on packaged Windows 0.3.7: the on-disk dep contained the export, its browserHash
   *  matched the failing URL's `?v=`, and clearing the browser caches (`Cache/` + `Code Cache/`)
   *  fixed it. The clears are therefore ONE fix, and this guard exists because dropping the
   *  browser half is invisible locally — it only bites on update-over-install, a path
   *  `smoke:packaged` never takes (it starts from a fresh profile).
   *
   *  Matches the `clearBrowserCaches()` helper OR a direct call, so the block can be refactored
   *  without tripping this — what must not happen is the browser cache going unclaimed entirely. */
  it('clears the renderer browser caches alongside the dep-cache wipe', () => {
    const block = signatureBlock();
    expect(
      /clearBrowserCaches\(|clearCache\(|clearData\(/.test(block),
      'the buildSig branch must ALSO clear the renderer\'s browser caches (clearBrowserCaches() '
        + '— session.clearCache() + session.clearCodeCaches()). Without it the vite-cache wipe is '
        + 'a no-op across an app update: the dep URL is unchanged and served immutable, so the '
        + 'renderer re-reads the stale pre-update chunk from disk and crashes on a newly-added '
        + 'export (#110).',
    ).toBe(true);
  });

  /** The helper must clear BOTH caches. They are separate Electron APIs over separate userData
   *  dirs, and the measured #110 repair deleted both — clearing only the HTTP cache would ship
   *  something narrower than what was demonstrated to work. */
  it('clearBrowserCaches clears the V8 code cache as well as the HTTP cache', () => {
    const src = fs.readFileSync(mainTs, 'utf8');
    const start = src.indexOf('async function clearBrowserCaches');
    expect(start, 'clearBrowserCaches() not found in engine/electron/main.ts — if it was renamed, '
      + 'retarget this guard rather than deleting it').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(/clearCache\(/.test(body), 'must clear the HTTP cache').toBe(true);
    expect(
      /clearCodeCaches\(/.test(body),
      'must ALSO clear V8\'s compiled-code cache — a separate Electron API over a separate '
        + 'userData dir (Code Cache/). clearCache() does not touch it.',
    ).toBe(true);
  });
});
