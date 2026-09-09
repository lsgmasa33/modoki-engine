/**
 * #981: every Capacitor plugin package on disk has a plugin-CLASS leg, and every leg names a
 * package that exists.
 *
 * ── WHY THIS GUARD IS WORTH HAVING ───────────────────────────────────────────────────────
 * The gap #981 records is not "one plugin was missed" — it is that NOTHING enumerated the set, so
 * four plugins had no native leg at all and nobody could see it. A leg table without this guard
 * re-creates that: the next plugin package gets added, no row is written for it, and
 * `npm run test:native` reports a tidy green about a set that silently shrank.
 *
 * ⚠️ **The expectation is DERIVED by globbing the filesystem, never written down here.** A guard
 * that asserted the package list against a literal would be a second copy of the same list, and a
 * second copy drifts green — this repo has the scar. `discoverPluginPackages()` is the same
 * function the runner uses, so the guard cannot disagree with what actually runs.
 *
 * ⚠️ This checks COVERAGE, not correctness. It cannot see whether a leg's shape is right, and a
 * leg declared with the wrong shape passes here and fails (or falsely passes) in the native gate.
 * That is what the `flat`/`spm` reasoning in nativePluginLegs.mjs is for; `npm run verify` cannot
 * run xcodebuild and this test does not pretend to.
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readScannedSource } from '@modoki/engine/testing'
import { hasInternalGames } from '../helpers/repoLayout'
// @ts-expect-error — .mjs script module, no type declarations by design (it is a build script).
import { PLUGIN_CLASS_LEGS, discoverPluginPackages, legLabel, relKey, schemeFor } from '../../scripts/nativePluginLegs.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

type Leg = { dir: string; shape: 'spm' | 'flat'; flatSources?: string[] }
const allLegs = PLUGIN_CLASS_LEGS as Leg[]

/**
 * ⚠️ **The legs whose package is actually PRESENT in this checkout.**
 *
 * The OSS snapshot ships `engine/` + `docs/` + selected `demos/` and **no `games/`**
 * (`scripts/publish-engine-oss.sh`), and it runs `engine/tests/architecture/` — both in-stage and
 * on the free public runner. So a guard comparing the full table against a filesystem glob is red
 * there by construction, on three `games/*` rows that are correct in this repo. That would turn
 * `ci/main` red on every push and abort the publish script.
 *
 * Filtering by existence rather than `skipIf(hasInternalGames())` is deliberate: a wholesale skip
 * would take the ENGINE-owned coverage down with it in exactly the environment that ships the
 * engine. This way the five `engine/packages/*` rows are still checked in the snapshot, in both
 * directions.
 *
 * The direction that filtering WOULD lose — a declared row whose package was deleted or moved,
 * which the filter silently swallows — is restored by its own `hasInternalGames()`-gated test
 * below, where the full table is meaningful.
 */
const legs = allLegs.filter((l) => fs.existsSync(path.join(repoRoot, l.dir)))

describe('#981 plugin-class leg coverage', () => {
  it('covers every capacitor-* package that exists on disk, and no others', () => {
    const onDisk = (discoverPluginPackages(repoRoot) as string[]).map((abs) => relKey(repoRoot, abs))
    const declared = legs.map((l) => l.dir)
    // Both directions in one assertion so the failure message names the actual difference: a new
    // package with no leg, AND a leg whose package was deleted or moved.
    expect([...declared].sort()).toEqual([...onDisk].sort())
  })

  it('finds a non-empty set — a guard over an empty glob passes vacuously', () => {
    // Without this, a discoverPluginPackages() that silently returned [] would make the test above
    // compare [] to [] and go green with the whole gate switched off. Holds in the snapshot too:
    // the five engine-owned packages ship there.
    expect(legs.length).toBeGreaterThan(0)
    expect((discoverPluginPackages(repoRoot) as string[]).length).toBe(legs.length)
  })

  it.skipIf(!hasInternalGames())('declares no leg for a package that no longer exists', () => {
    // The half `legs`' existence-filter gives up (see its docblock). Only meaningful in a checkout
    // that HAS games/ — in the snapshot the three games/* rows are absent on purpose, not stale.
    for (const leg of allLegs) {
      expect(fs.existsSync(path.join(repoRoot, leg.dir)), `${leg.dir} has a leg but no package`).toBe(true)
    }
  })

  it('gives every leg a DISTINCT name in the summary', () => {
    // Found on this gate's first real run: two copies of capacitor-applovin-max exist (court's and
    // 3d-test's), so `path.basename(dir)` printed two legs called `ios/class/capacitor-applovin-max`
    // and a FAIL on either was unattributable — the summary is the whole output of this gate, so a
    // name collision there is a real defect, not cosmetics.
    const labels = legs.map((l) => legLabel(l.dir))
    expect(labels.length).toBe(new Set(labels).size)
  })

  it('resolves an xcodebuild scheme for every package, because the scheme IS the package name', () => {
    // A null scheme makes the runner SKIP with a reason rather than build the wrong thing — so a
    // manifest whose `name:` this cannot read would quietly remove a leg from the gate.
    for (const leg of legs) {
      expect(schemeFor(path.join(repoRoot, leg.dir)), `no scheme for ${leg.dir}`).toBeTruthy()
    }
  })

  it('declares flatSources for exactly the flat legs, and every one of them exists', () => {
    for (const leg of legs) {
      if (leg.shape === 'flat') {
        expect(leg.flatSources?.length, `${leg.dir} is flat but declares no flatSources`).toBeGreaterThan(0)
        for (const rel of leg.flatSources ?? []) {
          expect(fs.existsSync(path.join(repoRoot, leg.dir, rel)), `${leg.dir}/${rel} is missing`).toBe(true)
        }
      } else {
        // A stale flatSources on an 'spm' row is dead config that reads as if it were doing
        // something — the runner ignores it entirely.
        expect(leg.flatSources, `${leg.dir} is 'spm' but carries flatSources`).toBeUndefined()
      }
    }
  })

  it.skipIf(!hasInternalGames())("a flat leg's sources ARE the pbxproj's file references, derived not copied", () => {
    // ⚠️ `flatSources` mirrors the consuming app's pbxproj file references, and until this guard
    // nothing checked they agreed — the shadowing-constant shape this repo has scars from. The
    // SILENT direction is what matters: add `core/Sources/ModokiOtaCore/OtaManifest.swift`, wire it
    // into the pbxproj so the app compiles it, forget this table, and the flat leg keeps compiling
    // the old three files and reports PASS while the shipping app target fails. The existing
    // `flatSources` test only checks the declared files EXIST — it cannot see a file the pbxproj
    // has and the table does not.
    //
    // ⚠️ Read `comments: 'include'` on purpose. A pbxproj's `/* Name */` spans are generated NAMING
    // that is part of its syntax, not prose hiding code — blanking them cost `pbxprojObjectIds` 42
    // of the 43 ids it inspects (#812 close-out). Same reason here: the `path = "…"` values this
    // parses sit beside those annotations.
    const PBXPROJ_AS_WRITTEN = {
      comments: 'include',
      reason: 'the `/* Name */` spans are generated naming that is pbxproj syntax, not prose',
    } as const
    // ota-test is the ONE project that hand-wires this plugin (healNativeConfig generates the
    // game-debug half only — see docs/native-and-sdks.md § iOS SPM static-linking gotcha).
    const pbx = path.join(repoRoot, 'games/ota-test/ios/App/App.xcodeproj/project.pbxproj')
    if (!fs.existsSync(pbx)) return   // the plugin is not wired here; nothing to compare against

    for (const leg of legs.filter((l) => l.shape === 'flat')) {
      const pkg = path.basename(leg.dir)
      const src = readScannedSource(pbx, PBXPROJ_AS_WRITTEN).raw
      const referenced = [...src.matchAll(new RegExp(`path = "[^"]*${pkg}/([^"]+)"`, 'g'))].map((m) => m[1])
      // A floor, so a regex that stopped matching cannot pass this vacuously against an empty set.
      expect(referenced.length, `no ${pkg} file references found in ${path.basename(pbx)} — the regex or the wiring changed`).toBeGreaterThan(0)
      expect([...referenced].sort(), `${leg.dir}'s flatSources and the pbxproj disagree`).toEqual([...(leg.flatSources ?? [])].sort())
    }
  })

  it("the flat leg's sources really do lack the import that would make it an 'spm' package", () => {
    // The WHOLE justification for the flat shape is that the plugin deliberately does not import
    // its core (OtaPlugin.swift says so). If somebody adds that import, the flat synthesis becomes
    // unnecessary and the row should become 'spm' — this is what notices, instead of the gate
    // quietly testing a shape the code left behind.
    for (const leg of legs.filter((l) => l.shape === 'flat')) {
      const cores = (leg.flatSources ?? []).filter((r) => !r.startsWith('ios/Sources/'))
      // ⚠️ Derive the module from the `Sources/<Module>/` convention and ASSERT the match, rather
      // than `basename(dirname(rel))`. The latter is right only while every core source sits
      // directly under its module dir: nest one a level deeper (`.../ModokiOtaCore/Zip/OtaZip.swift`)
      // and it yields `'Zip'`, the `import Zip` regex never matches, and this whole check passes
      // VACUOUSLY forever while claiming the flat shape is still justified.
      const modules = cores.map((r) => {
        const m = /(?:^|\/)Sources\/([^/]+)\//.exec(r)
        expect(m, `cannot derive a module name from ${r} — expected a Sources/<Module>/ path`).not.toBeNull()
        return m![1]
      })
      // ⚠️ `.code`, never the raw file (#812). OtaPlugin.swift's own header says, in prose, "no
      // `import ModokiOtaCore`" — so a guard matching raw text is one careless regex away from
      // being satisfied by the comment that documents the absence, and going green forever.
      const pluginSrc = (leg.flatSources ?? [])
        .filter((r) => r.startsWith('ios/Sources/'))
        .map((r) => readScannedSource(path.join(repoRoot, leg.dir, r)).code)
        .join('\n')
      expect(modules.length, `${leg.dir} declares no core sources — nothing to be flat about`).toBeGreaterThan(0)
      for (const mod of modules) {
        expect(
          new RegExp(`^\\s*import\\s+${mod}\\b`, 'm').test(pluginSrc),
          `${leg.dir}'s plugin now imports ${mod} — the flat shape is obsolete, make this row 'spm'`,
        ).toBe(false)
      }
    }
  })
})
