/** App-icon generation freshness — the stamp that stops every native build rewriting every
 *  tracked mipmap/splash PNG. See plugins/iconAssets.ts for the two shipped failures this
 *  guards (an unpinned generator, and unconditional regeneration dirtying the tree). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ICON_TOOL, ICON_COLORS, iconStampValue, iconIsUpToDate,
  iconStampPath, iconSentinelPath,
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
    markGenerated('android', iconStampValue(src, 'android').replace(/^./, 'f'));
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
