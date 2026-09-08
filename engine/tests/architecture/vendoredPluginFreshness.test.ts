/** Every project's VENDORED engine Capacitor plugin must match the plugin's CURRENT source (#90).
 *
 *  Why this guard exists. Games do not build engine plugins from source — they depend on a
 *  content-addressed tarball committed into the project
 *  (`"capacitor-game-debug": "file:plugins/capacitor-game-debug-1.0.0-<hash>.tgz"`). Nothing in the
 *  repo forced that tarball to be refreshed when the plugin's SOURCE changed: `vendorEnginePlugins`
 *  detects content changes correctly, but the native build only called it on the scaffold path, or
 *  gated behind `ensureCapacitorDeps.changed` — which fires only for a MISSING dep, and a plugin
 *  already depended on is never missing.
 *
 *  The failure mode is the dangerous one: the gradle build succeeds, the APK installs, the app
 *  launches, and it silently contains the PREVIOUS native code. Every signal says the change
 *  shipped. Measured 2026-08-02 while fixing #88 — the first build compiled the pre-fix Java, and
 *  it was caught only because the tarball hash was checked by hand. A guard is what removes the
 *  "someone has to think of it" step.
 *
 *  ⚠️ The name is not the bytes (#375). For most of this guard's life it compared the plugin's
 *  source hash against the FILENAME in each project's package.json and never opened the tarball —
 *  so a `.tgz` with a correct name and stale contents passed green, which is the same shipping
 *  accident by a different route (an interrupted re-vendor, a merge taking the new manifest with
 *  the old tarball, a `git checkout <old-sha> -- <project>/plugins/`). The second test below opens
 *  it and compares the contents; the name check stays as the cheap first pass.
 *
 *  This asserts the STATE (what is committed), which is what an APK is actually built from. The
 *  build-path fix in `vite-asset-scanner.ts` keeps it true going forward; this catches a project
 *  that drifts anyway — e.g. a plugin edited without rebuilding every consumer, exactly the
 *  situation #88 created across nine projects. */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { pluginContentHash, listEnginePlugins, compareTarballToSource, readPackedVersion, packedVersion } from '../../plugins/vendorPlugins';
import { PROJECT_ROOT_DIRS } from '../../scripts/projectRoots.mjs';
import { hasAnyProject, hasVendoredPluginTarballs } from '../helpers/repoLayout';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Every project directory under the configured roots that has its own package.json. */
function allProjects(): { id: string; dir: string }[] {
  const out: { id: string; dir: string }[] = [];
  for (const root of PROJECT_ROOT_DIRS) {
    const abs = path.join(repoRoot, root);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(abs, entry.name);
      if (fs.existsSync(path.join(dir, 'package.json'))) out.push({ id: `${root}/${entry.name}`, dir });
    }
  }
  return out;
}

describe('vendored engine plugins are not stale (#90)', () => {
  const plugins = listEnginePlugins(repoRoot);
  const projects = allProjects();

  /** Every (project, plugin, spec) the repo actually pins. Iteration only — NOT the premise:
   *  `hasVendoredPluginTarballs()` is the gate, and it reads the committed tarballs instead of
   *  this join. Gating on `pins.length` would be self-disabling — rename what
   *  `listEnginePlugins()` reports, or move a `file:` pin into `devDependencies`, and the guards
   *  below would skip silently green rather than fail "checked nothing". */
  const pins = plugins.flatMap((plugin) =>
    projects.flatMap((project) => {
      const pkg = JSON.parse(fs.readFileSync(path.join(project.dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      const spec = pkg.dependencies?.[plugin.name];
      return spec ? [{ plugin, project, spec }] : [];
    }),
  );

  // Gated on the LOOSE predicate: any project that pins a plugin is in scope, so "is there
  // anything to scan?" is the question. The public RELEASE snapshot on `main` ships no projects
  // at all (the `ci/main` snapshot ships two demos — which is why this only went red on `main`),
  // and there the plugin-staleness check has nothing to be stale.
  it.skipIf(!hasAnyProject())('finds engine plugins and projects to check (a guard that checks nothing is not a guard)', () => {
    expect(plugins.length).toBeGreaterThan(0);
    expect(projects.length).toBeGreaterThan(0);
  });

  it('every project pinning an engine plugin pins the CURRENT content hash', () => {
    const stale: string[] = [];

    for (const plugin of plugins) {
      const currentHash = pluginContentHash(plugin.dir);
      for (const project of projects) {
        const pkg = JSON.parse(fs.readFileSync(path.join(project.dir, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, string>;
        };
        const spec = pkg.dependencies?.[plugin.name];
        // A project that does not depend on this plugin is not stale — it opted out, which is a
        // legitimate state (no native target yet, or a project that never needed the bridge).
        if (!spec) continue;
        if (!spec.includes(currentHash)) {
          stale.push(`${project.id}: ${plugin.name} pins "${spec}" but the plugin's current content hash is ${currentHash}`);
        }
      }
    }

    expect(stale, stale.length
      ? `Stale vendored plugin(s) — these projects would build an APK/IPA containing OLD native code, `
        + `while the build reports success:\n  ${stale.join('\n  ')}\n\n`
        + `Fix: \`node engine/scripts/vendor-plugins.mjs <projectDir>\` then \`npm install\` in the project. `
        + `Both native build paths also re-vendor on their own now — the editor's Build → iOS/Android `
        + `(#90) and the CLI's \`npm run build -- --target native\` (#148). This message used to claim `
        + `"the native build does this automatically", which was true of the EDITOR path only, and it `
        + `said so to a reader who had just been burned by the CLI one.`
      : '',
    ).toEqual([]);
  });

  // ── The LOCKFILE's integrity, against the same bytes (#375) ───────────────────────────
  // A lockfile records a sha512 OF THE TARBALL. Re-vendoring can rewrite a tarball under an
  // UNCHANGED name — the name omits dist/ by design — and if the lockfiles are not refreshed in
  // the same commit, `npm ci` fails in CI and in every fresh clone while a dev machine with warm
  // node_modules stays happy. Nothing checked this either; it was verified by hand during #368's
  // review, which is precisely the "someone has to think of it" step a guard removes.
  it.skipIf(!hasVendoredPluginTarballs())('every lockfile integrity matches the committed tarball bytes', () => {
    const problems: string[] = [];
    let checked = 0;

    // Driven off the LOCKFILE, not `pins`: a project that drops the plugin from package.json
    // while its lockfile keeps the `file:` entry still breaks `npm ci` in every fresh clone, and
    // that is exactly the state this test is for.
    for (const plugin of plugins) {
      for (const project of projects) {
        const lockPath = path.join(project.dir, 'package-lock.json');
        if (!fs.existsSync(lockPath)) continue; // a project may legitimately not commit one
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
          packages?: Record<string, { resolved?: string; integrity?: string }>;
        };
        const entry = lock.packages?.[`node_modules/${plugin.name}`];
        if (!entry?.integrity || !entry.resolved?.startsWith('file:')) continue;
        const abs = path.join(project.dir, entry.resolved.replace(/^file:/, ''));
        if (!fs.existsSync(abs)) { problems.push(`${project.id}: lockfile resolves ${plugin.name} to ${entry.resolved}, which does not exist`); continue; }
        const actual = `sha512-${createHash('sha512').update(fs.readFileSync(abs)).digest('base64')}`;
        checked++;
        if (actual !== entry.integrity) {
          problems.push(`${project.id}: ${entry.resolved} — lockfile integrity ${entry.integrity.slice(0, 24)}… but the file hashes to ${actual.slice(0, 24)}…`);
        }
      }
    }

    expect(checked, 'no lockfile integrity was checked — the check ran on nothing').toBeGreaterThan(0);
    expect(problems, problems.length
      ? `Lockfile integrity does not match the committed tarball — \`npm ci\` will fail in CI and in `
        + `every fresh clone, while a warm node_modules hides it locally:\n  ${problems.join('\n  ')}\n\n`
        + `⚠️ Do NOT reach for \`npm install --package-lock-only\` — measured (#685): it is what CREATES `
        + `this state (it writes the new resolved+integrity into both lockfiles without extracting), and a `
        + `tree left there is unrecoverable by any plain install. A bare \`npm install\` or \`--force\` will `
        + `not fix it either. Repair, in order:\n`
        + `  1. delete the plugin's entry from <project>/package-lock.json ("node_modules/<plugin>" under "packages")\n`
        + `  2. (cd <project> && npm install)   # a PLAIN install — it now re-resolves AND extracts\n`
        + `  3. ONLY if step 2 reported "up to date" and this check still fires — then node_modules/.package-lock.json `
        + `is ahead of the disk and nothing will re-extract:\n`
        + `     (cd <project> && rm -rf node_modules/<plugin> && npm install)\n`
        + `Then commit the package-lock.json.`
      : '',
    ).toEqual([]);
  });

  // ── The BYTES, not the name (#375) ────────────────────────────────────────────────────
  // Only meaningful where a project actually pins a plugin; the release snapshot ships none.
  it.skipIf(!hasVendoredPluginTarballs())('every pinned tarball CONTAINS the plugin source it is named after', () => {
    const problems: string[] = [];
    let checked = 0;

    {
      for (const { plugin, project, spec } of pins) {
        const rel = spec.replace(/^file:/, '');
        const abs = path.join(project.dir, rel);
        // A dep spec pointing at a tarball that is not there breaks `npm install` outright, and
        // the name-only check above cannot see it — it reads the string, not the disk.
        if (!fs.existsSync(abs)) { problems.push(`${project.id}: ${plugin.name} pins "${spec}" but ${rel} does not exist`); continue; }
        const { drift } = compareTarballToSource(abs, plugin.dir);
        checked++;
        // `d.reason` is set only for a read/parse failure (#685 FIX 6) — a corrupt/truncated
        // tarball that couldn't be compared at all, surfaced rather than swallowed.
        for (const d of drift) problems.push(`${project.id}: ${rel} — ${d.path} ${d.kind}${d.reason ? ` (${d.reason})` : ''}`);
      }
    }

    // A guard that checked nothing must not report green (repoLayout.ts's own header). hasAnyProject
    // says some project exists; this says at least one of them actually pins a plugin we opened.
    expect(checked, 'no committed plugin tarball was opened — the check ran on nothing').toBeGreaterThan(0);
    expect(problems, problems.length
      ? `Committed plugin tarball(s) do NOT match the plugin source, despite a CURRENT name — `
        + `a build from these would report success and ship the tarball's (older) native code:\n  `
        + `${problems.join('\n  ')}\n\n`
        + `Fix: \`node engine/scripts/vendor-plugins.mjs <projectDir>\` then \`npm install\` in the project.\n`
        + `Note this compares the shipped set MINUS dist/ — the same set the tarball's NAME is `
        + `computed over — so a report here is a real content difference, never toolchain drift.`
      : '',
    ).toEqual([]);
  });

  // ── The PACKED version, not just the filename (#685) ──────────────────────────────────
  // A tarball packed before packInto started writing packedVersion into the PACKED package.json
  // still has a bare `1.0.0` inside, even though its NAME (and so the two checks above) look
  // completely current. Measured (#685 FIX 2), correcting an earlier claim here: npm's `file:`
  // resolver does NOT key re-vendoring detection on this field — extraction is LOCKFILE-driven,
  // and npm never opens the committed tarball at all. What the packed version buys is
  // IDENTIFIABILITY: it's the only thing that lets this repo tell WHICH generation of a
  // same-named tarball is the one currently committed, which is what makes this assertion — and
  // the tarball-vs-installed comparison in `vendorPlugins.ts` — meaningful. This is what stops it
  // regressing: a future tarball that goes back to a bare/wrong packed version fails LOUD here
  // even while its filename is correct.
  //
  // The 22-project migration (`vendor-plugins.mjs` per project) landed in the SAME commit as this
  // assertion, so it has never actually been red in this repo — it guards against a regression
  // from here on, not a known-red starting state.
  it.skipIf(!hasVendoredPluginTarballs())("every pinned tarball's PACKED version is <base>-h<hash> (#685)", () => {
    const problems: string[] = [];
    let checked = 0;

    for (const { plugin, project, spec } of pins) {
      const rel = spec.replace(/^file:/, '');
      const abs = path.join(project.dir, rel);
      if (!fs.existsSync(abs)) continue; // reported by the "pins a tarball that is not there" case above
      const hashMatch = rel.match(/-([0-9a-f]{8})\.tgz$/);
      if (!hashMatch) { problems.push(`${project.id}: ${rel} does not look like a content-addressed tarball name`); continue; }
      const want = packedVersion(plugin.version, hashMatch[1]);
      const got = readPackedVersion(abs);
      checked++;
      if (got !== want) {
        problems.push(`${project.id}: ${rel} — packed package.json version is "${got}" but expected "${want}"`);
      }
    }

    expect(checked, 'no committed plugin tarball was opened — the check ran on nothing').toBeGreaterThan(0);
    expect(problems, problems.length
      ? `Committed plugin tarball(s) still carry a bare/stale PACKED version. npm's \`file:\` resolver `
        + `does not read this field — re-vendoring is LOCKFILE-driven, and npm never opens the tarball `
        + `— but this repo does: it's the only thing that lets a same-named tarball's CURRENT generation `
        + `be told apart from a stale one, so a bare/stale version here means the next real content `
        + `change can't be identified either (#685):\n  ${problems.join('\n  ')}\n\n`
        + `Fix: \`node engine/scripts/vendor-plugins.mjs <projectDir>\` then \`npm install\` in the project.`
      : '',
    ).toEqual([]);
  });

  // ── The COMMITTED plugin manifest must never carry packInto's TRANSIENT suffix (#685 FIX 4) ──
  // `packInto` briefly writes a hash-suffixed version (`<base>-h<hash>`) into a plugin's OWN
  // package.json for the duration of `npm pack`, then restores the exact original bytes in a
  // `finally`. A SIGKILL mid-pack, or two `vendorEnginePlugins` runs racing on the SAME plugin dir
  // (the editor's `/api/build` and a terminal build interleaving), can leave that suffix on disk
  // PERMANENTLY — and nothing else notices: `listEnginePlugins` base-strips it, `pluginContentHash`
  // normalizes it out, `compareTarballToSource` normalizes both sides. `npm run verify` stays
  // green over a corrupted TRACKED file without this.
  //
  // This also guards a latent bug in `baseVersion`, which splits on the FIRST `-`: a genuine
  // prerelease like `2.0.0-rc.1` would be silently erased everywhere that calls it, not just here.
  // Banning any `-`/`+` in the committed version is deliberately stricter than plain semver (which
  // permits a real prerelease/build-metadata suffix) — no engine plugin has ever shipped one, and
  // the day one wants to, this assertion is what has to change on purpose, not silently absorb it.
  it('every engine/packages/capacitor-*/package.json version has no prerelease and no build metadata', () => {
    const pkgDir = path.join(repoRoot, 'engine', 'packages');
    const problems: string[] = [];
    let checked = 0;
    if (fs.existsSync(pkgDir)) {
      for (const entry of fs.readdirSync(pkgDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('capacitor-')) continue;
        const pj = path.join(pkgDir, entry.name, 'package.json');
        if (!fs.existsSync(pj)) continue; // e.g. a plugin dir with no manifest yet
        const pkg = JSON.parse(fs.readFileSync(pj, 'utf8')) as { version?: unknown };
        const version = String(pkg.version ?? '');
        checked++;
        if (version.includes('-') || version.includes('+')) {
          problems.push(`engine/packages/${entry.name}/package.json: version is "${version}"`);
        }
      }
    }

    expect(checked, 'no engine/packages/capacitor-*/package.json was checked — the check ran on nothing').toBeGreaterThan(0);
    expect(problems, problems.length
      ? `Committed engine plugin package.json carries a "-"/"+" in its version — that only happens `
        + `when a \`packInto\` run (\`npm pack\`) was interrupted (SIGKILL) or two vendoring runs raced `
        + `on the same plugin dir, leaving its transient "-h<hash>" suffix on disk instead of restoring `
        + `the committed original (#685):\n  ${problems.join('\n  ')}\n\n`
        + `Fix: \`git checkout -- <that file>\`.`
      : '',
    ).toEqual([]);
  });
});
