/** App-icon generation freshness — the stamp that stops every native build rewriting every
 *  tracked mipmap/splash PNG. See plugins/iconAssets.ts for the two shipped failures this
 *  guards (an unpinned generator, and unconditional regeneration dirtying the tree). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/repoLayout';
import {
  ICON_TOOL, ICON_COLORS, iconStampValue, iconIsUpToDate,
  iconStampPath, iconSentinelPath, splashPipelineVersion, pipelineVersionFrom,
} from '../../plugins/iconAssets';

let root: string;
let src: string;

/** Put the project in the "icons are current" state for `plat`. */
function markGenerated(plat: 'ios' | 'android', stamp = iconStampValue(src, plat)) {
  const sentinel = iconSentinelPath(root, plat);
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, 'png-bytes');
  const stampFile = iconStampPath(root, plat);
  fs.mkdirSync(path.dirname(stampFile), { recursive: true });
  fs.writeFileSync(stampFile, stamp);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-icon-'));
  src = path.join(root, 'icon.png');
  fs.writeFileSync(src, 'original-icon-bytes');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('icon generator pinning', () => {
  // The whole point of #2: `npx --yes @capacitor/assets` installs LATEST, so a comment
  // claiming a verified version was documenting something the build did not use.
  it('pins an exact version rather than a floating tag', () => {
    expect(ICON_TOOL).toMatch(/^@capacitor\/assets@\d+\.\d+\.\d+$/);
  });
});

describe('icon freshness stamp', () => {
  it('regenerates when nothing has been generated yet', () => {
    expect(iconIsUpToDate(root, src, 'android')).toBe(false);
  });

  it('skips regeneration once the icons are current', () => {
    markGenerated('android');
    expect(iconIsUpToDate(root, src, 'android')).toBe(true);
  });

  // The bug this whole change exists to kill: a no-op build rewriting tracked PNGs.
  it('stays skippable across repeated checks (a no-op build stays a no-op)', () => {
    markGenerated('android');
    expect(iconIsUpToDate(root, src, 'android')).toBe(true);
    expect(iconIsUpToDate(root, src, 'android')).toBe(true);
  });

  it('regenerates when the source image CONTENT changes', () => {
    markGenerated('android');
    fs.writeFileSync(src, 'a-different-icon');
    expect(iconIsUpToDate(root, src, 'android')).toBe(false);
  });

  // Content, not path/mtime: repointing at a byte-identical file must NOT regenerate.
  it('does not regenerate for a different path with identical bytes', () => {
    markGenerated('android');
    const twin = path.join(root, 'copy.png');
    fs.writeFileSync(twin, fs.readFileSync(src));
    expect(iconIsUpToDate(root, twin, 'android')).toBe(true);
  });

  // Without the sentinel check, a wiped res/ would never come back.
  it('regenerates when the generated output was deleted but the stamp survived', () => {
    markGenerated('android');
    fs.rmSync(iconSentinelPath(root, 'android'));
    expect(iconIsUpToDate(root, src, 'android')).toBe(false);
  });

  it('regenerates when the pinned tool version changes', () => {
    // ⚠️ The mutation must ALWAYS change the value. This used to be `.replace(/^./, 'f')`, which
    // is a NO-OP whenever the hash already starts with 'f' — a 1-in-16 chance of asserting that an
    // identical stamp is stale, i.e. passing vacuously. It duly went red the first time an
    // unrelated change moved the digest onto an 'f'. Flipping the first character to a DIFFERENT
    // one cannot degenerate.
    const real = iconStampValue(src, 'android');
    markGenerated('android', (real[0] === 'f' ? '0' : 'f') + real.slice(1));
    expect(iconIsUpToDate(root, src, 'android')).toBe(false);
  });

  // ios and android write different outputs; one being current must not skip the other.
  it('tracks each platform independently', () => {
    markGenerated('android');
    expect(iconIsUpToDate(root, src, 'android')).toBe(true);
    expect(iconIsUpToDate(root, src, 'ios')).toBe(false);
  });

  it('regenerates (rather than throwing) when the source is unreadable', () => {
    markGenerated('android');
    fs.rmSync(src);
    expect(() => iconIsUpToDate(root, src, 'android')).not.toThrow();
    expect(iconIsUpToDate(root, src, 'android')).toBe(false);
  });

  it('folds the colour flags into the stamp', () => {
    expect(ICON_COLORS).toContain('--iconBackgroundColor');
    // Same source, same platform → stable hash; the flags are part of the input set.
    expect(iconStampValue(src, 'android')).toBe(iconStampValue(src, 'android'));
    expect(iconStampValue(src, 'android')).not.toBe(iconStampValue(src, 'ios'));
  });

  it('keeps the stamp inside the gitignored .cache/ (never a committed file)', () => {
    expect(path.relative(root, iconStampPath(root, 'ios')).split(path.sep)[0]).toBe('.cache');
  });
});

/** #396/#397 added nine inputs, and `iconStep` DROPS ITSELF from the build plan on a stamp
 *  match. So anything that changes the output and is not in this hash does not merely take an
 *  extra build to appear — it never appears, until somebody deletes `.cache/icon-stamp-*` by
 *  hand. Both issues named that as the trap to avoid, so every new input gets a case here.
 *
 *  Each case perturbs ONE input and asserts the stamp moved: a test that changed two at once
 *  would pass with either half of the hash missing. */
describe('splash + icon-variant inputs are all in the stamp', () => {
  let other: string;
  beforeEach(() => {
    other = path.join(root, 'other.png');
    fs.writeFileSync(other, 'different-bytes');
  });

  const base = () => iconStampValue(src, 'android');

  it('an unconfigured project hashes to a stable value', () => {
    expect(iconStampValue(src, 'android', {})).toBe(base());
  });

  it.each([
    ['splashSrcAbs'],
    ['splashDarkSrcAbs'],
    ['titleSrcAbs'],
    ['badgeArtAbs'],
    ['iconDarkSrcAbs'],
    ['iconTintedSrcAbs'],
    ['iconMonochromeSrcAbs'],
  ])('configuring %s changes the stamp', (field) => {
    expect(iconStampValue(src, 'android', { [field]: other })).not.toBe(base());
  });

  it('hashes each source file\'s CONTENT, so editing one in place regenerates', () => {
    const before = iconStampValue(src, 'android', { splashSrcAbs: other });
    fs.writeFileSync(other, 'edited-in-place');
    expect(iconStampValue(src, 'android', { splashSrcAbs: other })).not.toBe(before);
  });

  it('distinguishes an UNSET source from one whose file has gone missing', () => {
    // Both are "no usable file", but they must not collide: repairing a broken path would
    // otherwise hash identically to the broken state and regenerate nothing.
    const unset = iconStampValue(src, 'android', {});
    const missing = iconStampValue(src, 'android', { splashSrcAbs: path.join(root, 'nope.png') });
    expect(missing).not.toBe(unset);
  });

  it('does NOT regenerate when a source is repointed at byte-identical art', () => {
    const copy = path.join(root, 'copy.png');
    fs.copyFileSync(other, copy);
    expect(iconStampValue(src, 'android', { splashSrcAbs: copy }))
      .toBe(iconStampValue(src, 'android', { splashSrcAbs: other }));
  });

  it('covers the placement numbers — they move the overlay without touching a single file', () => {
    expect(iconStampValue(src, 'android', { titleWidthPct: 55 }))
      .not.toBe(iconStampValue(src, 'android', { titleWidthPct: 60 }));
    expect(iconStampValue(src, 'android', { titleOffsetPct: -8 }))
      .not.toBe(iconStampValue(src, 'android', { titleOffsetPct: -12 }));
  });

  it('hashes the DARK badge art too, not just the light one', () => {
    // Found in review. Only `badgeArtAbs` (the light mark) was hashed, so re-cutting the dark
    // mark — the one shown on a LIGHT splash — produced an identical stamp and shipped the old art.
    expect(iconStampValue(src, 'android', { badgeArtAbs: src, badgeDarkArtAbs: other }))
      .not.toBe(iconStampValue(src, 'android', { badgeArtAbs: src }));
  });

  it('covers the badge flag', () => {
    expect(iconStampValue(src, 'android', { badge: true }))
      .not.toBe(iconStampValue(src, 'android', { badge: false }));
  });

  it('covers ORIENTATION — it decides the crop-safe box, so it moves the overlays', () => {
    // The subtle one: every source file is byte-identical, and the output still changes.
    expect(iconStampValue(src, 'android', { orientation: 'portrait' }))
      .not.toBe(iconStampValue(src, 'android', { orientation: 'auto' }));
  });

  it('DERIVES the post-processing version from the source files, so it cannot be forgotten', () => {
    // This replaced `typeof === 'string'`, which passed under both hypotheses and duly failed to
    // notice a real missed bump: a fix to `regionLuminanceOf` (the splash badge's colour) shipped
    // with the constant untouched, `iconIsUpToDate` returned true, and the fix reached nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-pipeline-'));
    const a = path.join(dir, 'a.mjs'); const b = path.join(dir, 'b.mjs');
    fs.writeFileSync(a, 'export const x = 1;'); fs.writeFileSync(b, 'export const y = 2;');

    const before = pipelineVersionFrom([a, b]);
    expect(before).toMatch(/^[0-9a-f]{12}$/);
    expect(pipelineVersionFrom([a, b])).toBe(before);           // stable

    fs.writeFileSync(a, 'export const x = 2;');                 // ANY edit moves it
    expect(pipelineVersionFrom([a, b])).not.toBe(before);

    // Order is part of the identity, and a missing file cannot collide with a present one.
    expect(pipelineVersionFrom([b, a])).not.toBe(pipelineVersionFrom([a, b]));
    expect(pipelineVersionFrom([a, path.join(dir, 'gone.mjs')])).not.toBe(pipelineVersionFrom([a, b]));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tracks the REAL pipeline sources when anchored — not a placeholder', () => {
    // Guards the wiring, not just the helper: pinned back to a literal, this stops matching.
    const expected = pipelineVersionFrom(
      ['splashCompose.mjs', 'splashLayout.mjs', 'iconVariants.mjs', 'androidSplashTheme.mjs']
        .map((f) => path.join(REPO_ROOT, 'engine', 'scripts', f)),
    );
    expect(splashPipelineVersion(REPO_ROOT)).toBe(expected);
  });

  it('makes an UNANCHORED caller visible in the digest instead of silently unprotected', () => {
    // The anchor comes from the caller (import.meta.url is undefined in the packaged CJS bundle —
    // #326). A caller that forgets it must not quietly get "no post-processing identity".
    expect(splashPipelineVersion(undefined)).toBe('pipeline:unanchored');
    expect(iconStampValue(src, 'android', { engineRootAbs: REPO_ROOT }))
      .not.toBe(iconStampValue(src, 'android', {}));
  });

  it('feeds through iconIsUpToDate, not just the raw hash', () => {
    markGenerated('android', iconStampValue(src, 'android', { badge: true }));
    expect(iconIsUpToDate(root, src, 'android', { badge: true })).toBe(true);
    expect(iconIsUpToDate(root, src, 'android', { badge: false })).toBe(false);
    // …and the old two-argument call still means "nothing configured".
    expect(iconIsUpToDate(root, src, 'android')).toBe(false);
  });
});
