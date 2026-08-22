/** The app-icon generator's collateral cleanup (#236).
 *
 *  `@capacitor/assets` does not stay inside the platform it is given: measured on
 *  `demos/forest-camp` with the pinned 3.0.5, `generate --android` also rewrites
 *  `ios/App/App.xcodeproj/project.pbxproj` (`LastUpgradeCheck = 0920` → `920`) and
 *  re-serializes `AndroidManifest.xml`. Roughly half the repo's projects already carry the
 *  mangled `920` in a commit, and `demos/` is the PUBLISHABLE tree — so the wrapper
 *  (`engine/scripts/generate-icons.mjs`) puts back everything written outside the running
 *  platform's product directory.
 *
 *  These tests drive that logic directly rather than invoking the generator: the real thing
 *  needs `npx` and the network, and what can regress here is the SCOPE RULE, not the tool. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collect, newFilesOutsideScope, restoreSnapshot } from '../../scripts/generate-icons.mjs';
import { ICON_COLORS, iconColorArgs } from '../../scripts/iconAssets.mjs';

let root: string;
const PRODUCT = path.join('android', 'app', 'src', 'main', 'res');

const write = (rel: string, body: string) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-icons-'));
  write(path.join(PRODUCT, 'mipmap-hdpi', 'ic_launcher.png'), 'product-image');
  write(path.join(PRODUCT, 'mipmap-anydpi-v26', 'ic_launcher.xml'), '<adaptive-icon/>');
  write(path.join('android', 'app', 'src', 'main', 'AndroidManifest.xml'), '<manifest>\n\n</manifest>');
  write(path.join('ios', 'App', 'App.xcodeproj', 'project.pbxproj'), 'LastUpgradeCheck = 0920;');
  write(path.join('ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'Contents.json'), '{}');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const snapshotFor = (plat: 'android' | 'ios') => {
  const product = path.join(root, plat === 'android' ? PRODUCT : path.join('ios', 'App', 'App', 'Assets.xcassets'));
  return new Map([
    ...collect(path.join(root, 'ios'), product),
    ...collect(path.join(root, 'android'), product),
  ]);
};

describe('icon-generator collateral scope', () => {
  it('protects the project files, and NOT the running platform\'s product directory', () => {
    const snap = snapshotFor('android');
    const rel = [...snap.keys()].map((f) => path.relative(root, f)).sort();
    expect(rel).toContain(path.join('android', 'app', 'src', 'main', 'AndroidManifest.xml'));
    expect(rel).toContain(path.join('ios', 'App', 'App.xcodeproj', 'project.pbxproj'));
    // The generator legitimately rewrites this one — repointing the adaptive icon's background
    // at the PNG it just made. An earlier cut of the rule restored it and orphaned the PNGs.
    expect(rel).not.toContain(path.join(PRODUCT, 'mipmap-anydpi-v26', 'ic_launcher.xml'));
    expect(rel).not.toContain(path.join(PRODUCT, 'mipmap-hdpi', 'ic_launcher.png'));
  });

  it('an --android run still protects the iOS icon assets (it was not asked for them)', () => {
    const rel = [...snapshotFor('android').keys()].map((f) => path.relative(root, f));
    expect(rel).toContain(path.join('ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'Contents.json'));
  });

  it('an --ios run leaves the iOS icon assets writable and still protects android', () => {
    const rel = [...snapshotFor('ios').keys()].map((f) => path.relative(root, f));
    expect(rel).not.toContain(path.join('ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'Contents.json'));
    expect(rel).toContain(path.join('android', 'app', 'src', 'main', 'AndroidManifest.xml'));
  });
});

describe('restoring what the generator wrote outside its scope', () => {
  it('puts back a mangled pbxproj and reports it', () => {
    const snap = snapshotFor('android');
    const pbx = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
    fs.writeFileSync(pbx, 'LastUpgradeCheck = 920;'); // the real mangling, byte for byte
    const { restored, failed } = restoreSnapshot(snap, root);
    expect(fs.readFileSync(pbx, 'utf8')).toBe('LastUpgradeCheck = 0920;');
    expect(restored).toEqual([path.join('ios', 'App', 'App.xcodeproj', 'project.pbxproj')]);
    expect(failed).toEqual([]);
  });

  it('puts back a file the generator DELETED', () => {
    const snap = snapshotFor('android');
    const manifest = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
    fs.rmSync(manifest);
    restoreSnapshot(snap, root);
    expect(fs.readFileSync(manifest, 'utf8')).toBe('<manifest>\n\n</manifest>');
  });

  it('reports nothing when the generator stayed in its lane', () => {
    const snap = snapshotFor('android');
    fs.writeFileSync(path.join(root, PRODUCT, 'mipmap-hdpi', 'ic_launcher.png'), 'regenerated');
    expect(restoreSnapshot(snap, root).restored).toEqual([]);
  });

  it('finds a file created outside the product directory', () => {
    const snap = snapshotFor('android');
    write(path.join('ios', 'App', 'stray.txt'), 'not asked for');
    write(path.join(PRODUCT, 'mipmap-ldpi', 'ic_launcher.png'), 'legitimate new product');
    const created = newFilesOutsideScope(path.join(root, 'ios'), path.join(root, PRODUCT), snap)
      .concat(newFilesOutsideScope(path.join(root, 'android'), path.join(root, PRODUCT), snap))
      .map((f) => path.relative(root, f));
    expect(created).toEqual([path.join('ios', 'App', 'stray.txt')]);
  });
  // Close-out finding: a restore that THREW was logged and swallowed. The caller then wrote the
  // freshness stamp anyway, so `iconIsUpToDate` returned true forever and the mangled file was
  // permanent behind one buried console line — the exact damage the wrapper exists to undo.
  it('reports a restore it could NOT perform, so the caller can withhold the stamp', () => {
    const snap = snapshotFor('android');
    const pbx = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
    fs.writeFileSync(pbx, 'LastUpgradeCheck = 920;'); // the generator's damage
    fs.chmodSync(pbx, 0o444);                         // ...and it cannot be put back
    try {
      const { restored, failed } = restoreSnapshot(snap, root);
      expect(restored).toEqual([]);
      expect(failed).toEqual([path.join('ios', 'App', 'App.xcodeproj', 'project.pbxproj')]);
      expect(fs.readFileSync(pbx, 'utf8')).toBe('LastUpgradeCheck = 920;'); // still damaged
    } finally {
      fs.chmodSync(pbx, 0o644);
    }
  });

});

describe('generator flags', () => {
  // ICON_COLORS is hashed into every project's freshness stamp, so its TEXT is a wire format —
  // changing it rewrites ~60 committed PNGs in every project. The argv form must stay derived.
  it('tokenizes into the exact flags the shell form used to pass', () => {
    expect(iconColorArgs()).toEqual([
      '--iconBackgroundColor', '#ffffff',
      '--iconBackgroundColorDark', '#111111',
      '--splashBackgroundColor', '#ffffff',
      '--splashBackgroundColorDark', '#111111',
    ]);
    expect(ICON_COLORS).not.toMatch(/\n/); // one line: it is spliced into a hash, not formatted
  });
});
