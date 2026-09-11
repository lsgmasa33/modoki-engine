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
import { PLUGIN_CLASS_LEGS, discoverPluginPackages, legLabel, networkFailureCause, relKey, schemeFor } from '../../scripts/nativePluginLegs.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

type Leg = { dir: string; shape: 'spm' | 'flat' | 'no-spm'; flatSources?: string[]; reason?: string }
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

  it('every leg has an android/ Gradle project for its android/class leg (#992)', () => {
    // test-native.mjs runs an `android/class/*` leg for EVERY row. A package without
    // `android/build.gradle` would SKIP there forever under a reason nobody reads, so one needs an
    // explicit decision — an N/A shape like iOS's `no-spm` — and this is what forces it.
    for (const leg of legs) {
      expect(fs.existsSync(path.join(repoRoot, leg.dir, 'android', 'build.gradle')), `${leg.dir} has no android/build.gradle`).toBe(true)
    }
  })

  it('gives every leg a DISTINCT name in the summary', () => {
    // Found on this gate's first real run: two copies of capacitor-applovin-max existed (court's and
    // 3d-test's; since #931 the engine plugin and 3d-test's fork), so `path.basename(dir)` printed two legs called `ios/class/capacitor-applovin-max`
    // and a FAIL on either was unattributable — the summary is the whole output of this gate, so a
    // name collision there is a real defect, not cosmetics.
    const labels = legs.map((l) => legLabel(l.dir))
    expect(labels.length).toBe(new Set(labels).size)
  })

  it('resolves an xcodebuild scheme for every package it will actually build', () => {
    // A null scheme makes the runner SKIP with a reason rather than build the wrong thing — so a
    // manifest whose `name:` this cannot read would quietly remove a leg from the gate.
    // ⚠️ 'no-spm' rows are excluded because the runner returns N/A before it ever looks for a
    // scheme, so a scheme it will never use is not this test's business.
    //
    // ⚠️ This comment used to add "so deleting that vestigial Package.swift, a perfectly reasonable
    // follow-up, would not fail a test about schemes." That was FALSE when written: the premise
    // guard in capacitorPlatformDeclarations.test.ts hard-asserts the manifest EXISTS for every
    // 'no-spm' row, because the manifest is that row's own stated evidence. Deleting it reddens
    // `verify` either way — deliberately. The exclusion here is a scoping choice, not a licence to
    // remove the file.
    for (const leg of legs.filter((l) => l.shape !== 'no-spm')) {
      expect(schemeFor(path.join(repoRoot, leg.dir)), `no scheme for ${leg.dir}`).toBeTruthy()
    }
  })

  it('gives every no-spm leg a reason, and no other leg one', () => {
    // The reason is printed in the gate summary and is the only thing standing between an N/A row
    // and a silent permanent exemption — #991's whole complaint about the shape it replaced. A row
    // added without one would report `N/A` with a placeholder nobody wrote.
    for (const leg of legs) {
      if (leg.shape === 'no-spm') {
        expect(leg.reason?.trim(), `${leg.dir} is 'no-spm' but declares no reason`).toBeTruthy()
        // A bare ticket number is not an explanation — the summary reader has no browser.
        expect(leg.reason!.length, `${leg.dir}'s reason is too short to explain anything`).toBeGreaterThan(40)
      } else {
        expect(leg.reason, `${leg.dir} is '${leg.shape}' but carries a reason — dead config`).toBeUndefined()
      }
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
        // A stale flatSources on an 'spm' or 'no-spm' row is dead config that reads as if it were
        // doing something — the runner ignores it entirely.
        expect(leg.flatSources, `${leg.dir} is '${leg.shape}' but carries flatSources`).toBeUndefined()
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
    // An assertion, not an early return (#1071). The pbxproj is TRACKED, so under the
    // `hasInternalGames()` gate above it is always here — the `return` this replaced could only
    // ever fire on a move or rename, and then it reported PASS for a comparison it never made.
    expect(fs.existsSync(pbx), `${path.relative(repoRoot, pbx)} is gone — repoint this guard at the project that now hand-wires the plugin`).toBe(true)

    for (const leg of legs.filter((l) => l.shape === 'flat')) {
      const pkg = path.basename(leg.dir)
      const src = readScannedSource(pbx, PBXPROJ_AS_WRITTEN).raw
      const referenced = [...src.matchAll(new RegExp(`path = "[^"]*${pkg}/([^"]+)"`, 'g'))].map((m) => m[1])
      // A floor, so a regex that stopped matching cannot pass this vacuously against an empty set.
      expect(referenced.length, `no ${pkg} file references found in ${path.basename(pbx)} — the regex or the wiring changed`).toBeGreaterThan(0)
      expect([...referenced].sort(), `${leg.dir}'s flatSources and the pbxproj disagree`).toEqual([...(leg.flatSources ?? [])].sort())
    }
  })

  describe('networkFailureCause — the android/class SKIP-vs-FAIL decision (#992)', () => {
    // Shapes are Gradle's real "What went wrong" layout. The first two lines of each FAIL case are
    // what the first run of these legs mis-classified, and what the close-out review showed a
    // compiler error could do.
    const whatWentWrong = (...causes: string[]) =>
      ['* What went wrong:', "Execution failed for task ':plugin:modokiResolveCompileClasspath'.", ...causes].join('\n')

    it.each([
      ['a dependency the network could not GET', whatWentWrong(
        "> MODOKI-UNRESOLVED com.applovin:applovin-sdk:13.5.1: Could not resolve com.applovin:applovin-sdk:13.5.1. <- Could not GET 'https://dl.google.com/…/applovin-sdk-13.5.1.pom'.")],
      ['offline mode with nothing cached', whatWentWrong(
        '> MODOKI-UNRESOLVED com.adjust.sdk:adjust-android:5.0.1: No cached version of com.adjust.sdk:adjust-android:5.0.1 available for offline mode.')],
      ['the buildscript classpath, nested causes', [
        '* What went wrong:', "A problem occurred configuring project ':plugin'.",
        "> Could not resolve all artifacts for configuration ':plugin:classpath'.",
        '   > Could not resolve org.jetbrains.kotlin:kotlin-gradle-plugin:2.3.0.',
        "      > Could not GET 'https://repo.maven.apache.org/…'.",
      ].join('\n')],
      // The SHAPE of a real run (the #992 close-out review's probe, 2026-09-11): a project gradlew
      // whose distribution is not cached dies in the WRAPPER before Gradle prints a single cause line.
      // Only the exception line's form was captured; the host is neutralised and the two stack frames
      // are illustrative, since nothing classifies on them.
      ['the wrapper dying before Gradle starts', [
        'Downloading https://services.gradle.org/distributions/gradle-8.14.3-all.zip',
        '',
        'Exception in thread "main" java.net.UnknownHostException: services.gradle.org',
        '\tat java.base/sun.nio.ch.NioSocketImpl.connect(NioSocketImpl.java:567)',
        '\tat org.gradle.wrapper.Download.downloadInternal(Download.java:129)',
      ].join('\n')],
      // Captured from a real Gradle 8.14.3 run against a server that sent 14 bytes of a 200 and stalled
      // (URL neutralised). The GET SUCCEEDED, so there is no `Could not GET` line — only `get resource`.
      ['a download that stalls mid-body, compile step', [
        '* What went wrong:', "Execution failed for task ':plugin:compileReleaseJavaWithJavac'.",
        "> Could not resolve all files for configuration ':plugin:releaseCompileClasspath'.",
        '   > Could not download stall-1.0.jar (com.x:stall:1.0)',
        "      > Could not get resource 'https://repo.example/m2/com/x/stall/1.0/stall-1.0.jar'.",
        '         > Read timed out',
      ].join('\n')],
    ])('SKIP: %s', (_label, out) => {
      expect(networkFailureCause(out)).toMatch(/Could not GET|Could not get resource|No cached version|java\.net\.UnknownHostException/)
    })

    it.each([
      ['the generic resolution HEADLINE alone — variant ambiguity, the first run\'s false SKIP', whatWentWrong(
        "> Could not resolve all files for configuration ':plugin:releaseCompileClasspath'.",
        '   > The consumer was configured to find a library for use during compile-time … However we cannot choose between the following variants of project :capacitor-android:')],
      ['a coordinate that does not exist, network up', whatWentWrong(
        '> MODOKI-UNRESOLVED com.applovin:applovin-sdkk:13.5.1: Could not find com.applovin:applovin-sdkk:13.5.1.')],
      ['a Kotlin compile error QUOTING a network class name', [
        "e: file:///x/LitertLmPlugin.kt:12:5 Unresolved reference 'UnknownHostException'.",
        '* What went wrong:', "Execution failed for task ':plugin:compileReleaseKotlin'.",
        '> A failure occurred while executing org.jetbrains.kotlin.compilerRunner.GradleCompilerRunnerWithWorkers$GradleKotlinCompilerWorkAction',
        '   > Compilation error. See log for more details',
      ].join('\n')],
      ['a javac error echoing a source line with a network phrase', [
        'GameDebugPlugin.java:40: error: cannot find symbol',
        '        } catch (UnknownHostException e) { call.reject("Read timed out"); }',
        '* What went wrong:', "Execution failed for task ':plugin:compileReleaseJavaWithJavac'.",
        '> Compilation failed; see the compiler error output for details.',
      ].join('\n')],
      // The layout of a real Gradle 8.14.3 run (captured 2026-09-11 in #992's close-out review), path
      // neutralised: javac ECHOES the offending source line, Gradle repeats that echo under "What went
      // wrong", and a wrapped comparison makes the echoed line itself begin with `>`. Narrowing to
      // `> ` lines alone let this through as a SKIP.
      ['a javac-echoed source line that itself begins with `>`', [
        '> Task :plugin:compileReleaseJavaWithJavac FAILED',
        '/work/src/main/java/Probe.java:5: error: cannot find symbol',
        '        > MAX_RETRIES && e instanceof UnknownHostException;',
        '                                      ^',
        '  symbol:   class UnknownHostException',
        '1 error',
        '',
        'FAILURE: Build failed with an exception.',
        '',
        '* What went wrong:',
        "Execution failed for task ':plugin:compileReleaseJavaWithJavac'.",
        '> Compilation failed; see the compiler output below.',
        '  /work/src/main/java/Probe.java:5: error: cannot find symbol',
        '          > MAX_RETRIES && e instanceof UnknownHostException;',
        '                                        ^',
        '    symbol:   class UnknownHostException',
        '  1 error',
        '',
        '* Try:',
        '> Check your code and dependencies to fix the compilation error(s)',
      ].join('\n')],
      ['the resolve step naming a coordinate that does not exist', whatWentWrong(
        '> MODOKI-UNRESOLVED com.x:y:1.0: Could not find com.x:y:1.0.')],
      ['no output at all', ''],
    ])('FAIL: %s', (_label, out) => {
      expect(networkFailureCause(out)).toBeNull()
    })
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
