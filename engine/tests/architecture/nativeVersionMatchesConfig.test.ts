/** A project's committed NATIVE version agrees with what `healNativeConfig` would write.
 *
 *  Why this guard exists. `app.version` is the single source of truth for the marketing version —
 *  the string a store shows as "Version 0.1.0" — and `healNativeConfig` writes it into
 *  `android/app/build.gradle`'s `versionName` and the pbxproj's `MARKETING_VERSION` on **every
 *  native build** (`healNativeProject`, called from `vite-asset-scanner`'s native path). The
 *  committed native files are therefore GENERATED, and a hand-edit to them is not a change — it is
 *  a value waiting to be silently overwritten.
 *
 *  **This drifted for real, and nothing caught it** (2026-09-23). `games/court` had no
 *  `app.version` at all, so it fell through to `DEFAULT_PROJECT_CONFIG.app.version` (`'1.0'`), while
 *  its committed `build.gradle` and pbxproj said `0.1.0` from a hand-edit. Every heal rewrote them
 *  to `1.0`, so the owner kept finding the two files dirty in `git status` and kept reverting them —
 *  and, worse, every artifact ever uploaded carried `1.0` while the repo claimed `0.1.0`. The fix
 *  was to author `app.version: "0.1.0"`; this test is what stops the shadowing from coming back.
 *
 *  It is the CLAUDE.md single-source-of-truth rule in its most expensive form: a value duplicated
 *  into a generated file drifts, and the copy you read is not the copy that ships. A store version
 *  cannot be un-shipped, and App Store Connect refuses a version below one it has already accepted,
 *  so a drift discovered at submission time is a wrong number you are stuck going forward from.
 *
 *  ⚠️ Scope: the MARKETING version only. `versionCode` / `CURRENT_PROJECT_VERSION` are deliberately
 *  NOT checked — with `buildNumberAuto` the build injects them on the command line from the commit
 *  count, so the committed value is a floor rather than a shadow, and `decideBuildWrite` already
 *  guards that direction with its never-lower rule.
 *
 *  ⚠️ Gated on `hasNativeProjects()` because the PUBLIC snapshot does not ship `games/**`, so the
 *  corpus there is a handful of demos and the vacuity floor below is a private-repo shape. The
 *  publish scan caught this as a red shipped guard on its first run; the house rule is to gate on
 *  the shared predicate rather than lower the floor, which would disable the control everywhere.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT_DIRS } from '../../scripts/projectRoots.mjs';
import { DEFAULT_PROJECT_CONFIG } from '../../project-config';
import { hasNativeProjects } from '../helpers/repoLayout';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function readIf(dir: string, rel: string): string | undefined {
  const p = path.join(dir, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined;
}

/** Every committed project that owns a native folder, with the marketing version its config
 *  RESOLVES to — the authored value, or the engine default when the project does not author one.
 *  The default is the trap: a project with no `app.version` still gets a version written. */
function nativeProjects(): { id: string; dir: string; want: string }[] {
  const out: { id: string; dir: string; want: string }[] = [];
  for (const root of PROJECT_ROOT_DIRS) {
    const abs = path.join(repoRoot, root);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(abs, entry.name);
      const cfgRaw = readIf(dir, 'project.config.json');
      if (!cfgRaw) continue;
      if (!fs.existsSync(path.join(dir, 'ios')) && !fs.existsSync(path.join(dir, 'android'))) continue;
      let cfg: { app?: { version?: unknown } };
      try { cfg = JSON.parse(cfgRaw); } catch { continue; }
      const authored = cfg.app?.version;
      const want = typeof authored === 'string' && authored !== ''
        ? authored
        : DEFAULT_PROJECT_CONFIG.app.version;
      out.push({ id: `${root}/${entry.name}`, dir, want });
    }
  }
  return out;
}

/** `versionName "0.1.0"` or `versionName = "0.1.0"` — the file's own separator is preserved on
 *  write (both spellings exist across the corpus), so the reader must accept either. */
function androidVersionName(dir: string): string | undefined {
  const raw = readIf(dir, 'android/app/build.gradle');
  return raw ? /versionName\s*=?\s*"([^"]+)"/.exec(raw)?.[1] : undefined;
}

function iosMarketingVersions(dir: string): string[] {
  const appDir = path.join(dir, 'ios/App');
  if (!fs.existsSync(appDir)) return [];
  const proj = fs.readdirSync(appDir).find((e) => e.endsWith('.xcodeproj'));
  if (!proj) return [];
  const raw = readIf(path.join(appDir, proj), 'project.pbxproj');
  if (!raw) return [];
  return [...raw.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1].trim());
}

describe('committed native marketing version matches project.config.json (#the-0.1.0-drift)', () => {
  it.skipIf(!hasNativeProjects())('finds native projects to check at all', () => {
    // Without this the two assertions below pass vacuously on an empty list — the failure mode a
    // corpus sweep has by default, when a moved root or a renamed file silently matches nothing.
    expect(nativeProjects().length).toBeGreaterThan(5);
  });

  it.skipIf(!hasNativeProjects())('every android versionName equals the config-resolved marketing version', () => {
    const bad: string[] = [];
    for (const p of nativeProjects()) {
      const got = androidVersionName(p.dir);
      if (got === undefined) continue; // no android/ folder, or a gradle file without the key
      if (got !== p.want) bad.push(`${p.id}: build.gradle versionName "${got}" but config resolves to "${p.want}"`);
    }
    expect(bad).toEqual([]);
  });

  it.skipIf(!hasNativeProjects())('every ios MARKETING_VERSION equals the config-resolved marketing version', () => {
    const bad: string[] = [];
    for (const p of nativeProjects()) {
      for (const got of iosMarketingVersions(p.dir)) {
        if (got !== p.want) bad.push(`${p.id}: pbxproj MARKETING_VERSION ${got} but config resolves to "${p.want}"`);
      }
    }
    expect(bad).toEqual([]);
  });
});
