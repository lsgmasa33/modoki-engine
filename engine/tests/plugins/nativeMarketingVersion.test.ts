import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverProjects } from '../../scripts/projectRoots.mjs';
import { loadProjectConfig } from '../../plugins/load-project-config';

/**
 * Every project's COMMITTED native marketing version must equal the `app.version` the version
 * heal writes (`healAndroidVersion` / `healIosVersion` in `engine/plugins/healNativeConfig.ts`).
 *
 * The heal syncs the marketing version in BOTH directions on every build, from the RESOLVED
 * config — so a hand edit to `versionName` / `MARKETING_VERSION` with no `app.version` behind it
 * is silently undone by the next build, and the store gets the config's value (the default
 * `1.0`), not the one the committed files show. Court shipped exactly that: its native files said
 * `0.1.0` by hand edit while the config fell back to `1.0`, so the build uploaded as 1.0 against
 * a 0.1.0 App Store version page (2026-09-23, `games/court/store-listing.md`). An Xcode archive,
 * which skips the heal, would have shipped the other value — the two paths disagreed.
 *
 * `loadProjectConfig` is the heal's own loader, so a missing field resolves to the same default
 * the heal would write. Build numbers are deliberately NOT compared: they are never-lower and
 * move on every build (#1226).
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function nativeVersions(dir: string): string[] {
  const out: string[] = [];
  const gradle = path.join(dir, 'android', 'app', 'build.gradle');
  if (fs.existsSync(gradle)) {
    for (const m of fs.readFileSync(gradle, 'utf8').matchAll(/versionName(?:\s*=\s*|\s+)"([^"]*)"/g)) {
      out.push(`android versionName ${m[1]}`);
    }
  }
  const pbx = path.join(dir, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
  if (fs.existsSync(pbx)) {
    for (const m of fs.readFileSync(pbx, 'utf8').matchAll(/MARKETING_VERSION = ([0-9.]+);/g)) {
      out.push(`ios MARKETING_VERSION ${m[1]}`);
    }
  }
  return out;
}

describe('native marketing version matches app.version', () => {
  const projects = discoverProjects(repoRoot).filter((p) => fs.existsSync(path.join(p.dir, 'project.config.json')));

  it('finds projects with native folders to check', () => {
    // A guard that silently checks nothing (a moved android/ios layout, a renamed root) is not a guard.
    expect(projects.filter((p) => nativeVersions(p.dir).length > 0).length).toBeGreaterThan(0);
  });

  it('every committed versionName / MARKETING_VERSION equals the resolved app.version', () => {
    const mismatches: string[] = [];
    for (const p of projects) {
      const found = nativeVersions(p.dir);
      if (found.length === 0) continue;
      const want = String(loadProjectConfig(p.dir).app.version);
      for (const f of found) {
        if (!f.endsWith(` ${want}`)) {
          mismatches.push(`${p.root}/${p.name}: ${f}, but app.version resolves to ${want} — the next build's heal overwrites the native file; set app.version in project.config.json instead`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
