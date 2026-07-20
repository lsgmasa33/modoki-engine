import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detect, resolve, withToolOnPath, npmSpawnSpec, detectAdb, preflight, guide, install, INSTALLABLE, TOOL_IDS, toolchainStatus, gltfTransformInvocation, gltfpackInvocation, parseJavaMajor, javaMajorFromVersion, resetToolchainCache, systemToolchainAllowed, readToolchainSettings, writeToolchainSettings, isInstallable, cocoapodsEnv, isToolStale, PINNED_TOOL_VERSIONS, uninstall, uninstallAll, ffmpegToolBin, ffprobeToolBin, npmToolBin, needsWinShell, type DetectResult } from '../../toolchain'

/**
 * Guards the shared toolchain resolver (engine/toolchain) — Phase A of the toolchain-layer plan.
 * Uses process.execPath (the node binary, which answers `--version`) as a stand-in absolute tool
 * so the env-override / dir / PATH-injection logic is exercised deterministically without toktx.
 */

/** Write a fake tool binary that answers a `--version`/`-v` probe cross-platform. On POSIX it's a
 *  `#!/bin/sh` script (chmod +x); when `binPath` ends in `.cmd` (the Windows npm shim the code
 *  resolves via npmToolBin) it's a batch file the toolchain runs through a shell (needsWinShell →
 *  shell:true). Module-scoped so every describe's userData-install detect tests can use it. */
const writeExecStub = (binPath: string, versionOut: string) => {
  fs.mkdirSync(path.dirname(binPath), { recursive: true })
  if (binPath.endsWith('.cmd')) {
    fs.writeFileSync(binPath, `@echo off\r\necho ${versionOut}\r\n`)
  } else {
    fs.writeFileSync(binPath, `#!/bin/sh\necho "${versionOut}"\n`)
    fs.chmodSync(binPath, 0o755)
  }
}

describe('toolchain resolve() — env override + PATH injection', () => {
  const NODE = process.execPath
  let savedToktx: string | undefined
  let savedPath: string | undefined

  beforeEach(() => {
    savedToktx = process.env.MODOKI_TOKTX
    savedPath = process.env.PATH
    resetToolchainCache()
  })
  afterEach(() => {
    if (savedToktx === undefined) delete process.env.MODOKI_TOKTX
    else process.env.MODOKI_TOKTX = savedToktx
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    resetToolchainCache()
  })

  it('honours the MODOKI_TOKTX absolute-path override (the packaged-editor bundled binary)', () => {
    process.env.MODOKI_TOKTX = NODE // stand-in: responds to --version
    resetToolchainCache()
    const d = detect('toktx')
    expect(d.present).toBe(true)
    expect(d.command).toBe(NODE)
    expect(d.source).toBe('env')
    expect(d.dir).toBe(path.dirname(NODE))
    expect(d.version).toBeTruthy()
  })

  it('withToolOnPath prepends the resolved tool dir so a bare-name child spawn finds it', () => {
    process.env.MODOKI_TOKTX = NODE
    resetToolchainCache()
    const env = withToolOnPath('toktx', { PATH: '/usr/bin' })
    const sep = process.platform === 'win32' ? ';' : ':'
    expect(env.PATH).toBe(`${path.dirname(NODE)}${sep}/usr/bin`)
  })

  it('resolve() throws the actionable install message when the tool is absent', () => {
    process.env.MODOKI_TOKTX = path.join(path.dirname(NODE), 'definitely-not-a-real-tool-xyz')
    process.env.PATH = '' // and not on PATH either
    resetToolchainCache()
    expect(detect('toktx').present).toBe(false)
    expect(() => resolve('toktx')).toThrow(/KTX-Software|MODOKI_TOKTX/)
  })
})

describe('toolchain npmSpawnSpec() — the swappable npm seam', () => {
  const NODE = process.execPath
  let savedNpm: string | undefined
  beforeEach(() => {
    savedNpm = process.env.MODOKI_NPM
    resetToolchainCache()
  })
  afterEach(() => {
    if (savedNpm === undefined) delete process.env.MODOKI_NPM
    else process.env.MODOKI_NPM = savedNpm
    resetToolchainCache()
  })

  it('honours a MODOKI_NPM override (how a later phase points npm at a downloaded Node)', () => {
    process.env.MODOKI_NPM = NODE // stand-in that answers --version
    resetToolchainCache()
    const spec = npmSpawnSpec()
    expect(spec.command).toBe(NODE)
    expect(spec.prefixArgs).toEqual([])
    expect(spec.shell).toBe(process.platform === 'win32')
  })

  it('falls back to system `npm` on PATH when no override is set', () => {
    delete process.env.MODOKI_NPM
    resetToolchainCache()
    // On any dev/CI machine npm is on PATH, so it resolves to the bare name (present).
    expect(npmSpawnSpec().command).toBe('npm')
  })
})

describe('toolchain detect() — android-sdk (directory tool, the unified probe)', () => {
  let tmp: string
  let savedHome: string | undefined
  let savedRoot: string | undefined

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-sdk-'))
    savedHome = process.env.ANDROID_HOME
    savedRoot = process.env.ANDROID_SDK_ROOT
    delete process.env.ANDROID_HOME
    delete process.env.ANDROID_SDK_ROOT
    resetToolchainCache()
  })
  afterEach(() => {
    if (savedHome === undefined) delete process.env.ANDROID_HOME
    else process.env.ANDROID_HOME = savedHome
    if (savedRoot === undefined) delete process.env.ANDROID_SDK_ROOT
    else process.env.ANDROID_SDK_ROOT = savedRoot
    fs.rmSync(tmp, { recursive: true, force: true })
    resetToolchainCache()
  })

  it('accepts an ANDROID_HOME with platform-tools (source: env, path: the dir)', () => {
    fs.mkdirSync(path.join(tmp, 'platform-tools'))
    process.env.ANDROID_HOME = tmp
    resetToolchainCache()
    const d = detect('android-sdk')
    expect(d.present).toBe(true)
    expect(d.path).toBe(tmp)
    expect(d.source).toBe('env')
  })

  it('REJECTS an ANDROID_HOME dir that lacks platform-tools (the consistent marker check)', () => {
    // The dir exists but has no platform-tools → not a usable SDK. This is the convergence:
    // healNativeConfig's old "dir exists" check would have wrongly accepted this. Assert the
    // marker-less env dir is NOT the resolved path (the machine may have a real SDK elsewhere,
    // so we can't assert absent — only that THIS dir was rejected).
    process.env.ANDROID_HOME = tmp
    resetToolchainCache()
    expect(detect('android-sdk').path).not.toBe(tmp)
  })

  it('falls through ANDROID_HOME → ANDROID_SDK_ROOT', () => {
    fs.mkdirSync(path.join(tmp, 'platform-tools'))
    process.env.ANDROID_HOME = path.join(tmp, 'nonexistent')
    process.env.ANDROID_SDK_ROOT = tmp
    resetToolchainCache()
    const d = detect('android-sdk')
    expect(d.present).toBe(true)
    expect(d.path).toBe(tmp)
  })

  /** Write a fake JDK home. The marker is the platform launcher (`java.exe` on Windows). On POSIX
   *  the launcher is a runnable stub so the `java -version` SPAWN path is exercised; on Windows a
   *  fake `java.exe` can't be spawned to print a version, so we also drop a `release` file — which
   *  the code reads FIRST (readReleaseJavaMajor, no spawn), exactly as a real Windows JDK ships. */
  const writeJavaStub = (home: string, versionLine: string) => {
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
    const launcher = path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    fs.writeFileSync(launcher, `#!/bin/sh\necho '${versionLine}' 1>&2\n`)
    if (process.platform !== 'win32') {
      fs.chmodSync(launcher, 0o755)
    } else {
      const v = /"([^"]+)"/.exec(versionLine)?.[1] ?? versionLine
      fs.writeFileSync(path.join(home, 'release'), `JAVA_VERSION="${v}"\n`)
    }
  }

  it('detect(java) accepts a JAVA_HOME whose marker is a FILE (bin/java) AND reports v21', () => {
    // Regression guard: the marker check accepts a file (JDK home's `bin/java`) — AND now the
    // version-strict validate accepts it only because it reports 21.
    const savedJava = process.env.JAVA_HOME
    writeJavaStub(tmp, 'openjdk version "21.0.7" 2025-04-15')
    process.env.JAVA_HOME = tmp
    resetToolchainCache()
    try {
      const d = detect('java')
      expect(d.present).toBe(true)
      expect(d.path).toBe(tmp)
      expect(d.source).toBe('env')
    } finally {
      if (savedJava === undefined) delete process.env.JAVA_HOME
      else process.env.JAVA_HOME = savedJava
      resetToolchainCache()
    }
  })

  it('detect(java) REJECTS a JAVA_HOME whose java -version is not 21 (version-strict)', () => {
    // The works-on-my-machine guard: a present-but-wrong JDK (here 17) must NOT resolve to that dir
    // — Android/AGP is JDK-21-specific. (The machine may have a real 21 elsewhere, so assert only
    // that THIS 17 dir was rejected, not that java is wholly absent.)
    const savedJava = process.env.JAVA_HOME
    writeJavaStub(tmp, 'openjdk version "17.0.11" 2024-04-16')
    process.env.JAVA_HOME = tmp
    resetToolchainCache()
    try {
      expect(detect('java').path).not.toBe(tmp)
    } finally {
      if (savedJava === undefined) delete process.env.JAVA_HOME
      else process.env.JAVA_HOME = savedJava
      resetToolchainCache()
    }
  })

  it('parseJavaMajor handles modern + legacy version strings', () => {
    expect(parseJavaMajor('openjdk version "21.0.11" 2024-04-16')).toBe(21)
    expect(parseJavaMajor('java version "17.0.1" 2021-10-19')).toBe(17)
    expect(parseJavaMajor('java version "1.8.0_412"')).toBe(8)
    expect(parseJavaMajor('no version here')).toBeNull()
  })

  it('javaMajorFromVersion handles release-file JAVA_VERSION strings', () => {
    expect(javaMajorFromVersion('21.0.11')).toBe(21)
    expect(javaMajorFromVersion('25.0.3')).toBe(25)
    expect(javaMajorFromVersion('21')).toBe(21)
    expect(javaMajorFromVersion('1.8.0_412')).toBe(8)
    expect(javaMajorFromVersion('garbage')).toBeNull()
  })

  it('detect(java) reads the JDK `release` file (JAVA_VERSION) WITHOUT spawning java', () => {
    // The canonical path: a real JDK ships `release`; version comes from it, not `java -version`.
    // The bin/java marker is a NON-executable file here, proving the release file (not a spawn) is used.
    const savedJava = process.env.JAVA_HOME
    fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), '') // marker only — not runnable
    fs.writeFileSync(path.join(tmp, 'release'), 'IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="21.0.11"\n')
    process.env.JAVA_HOME = tmp
    resetToolchainCache()
    try {
      const d = detect('java')
      expect(d.present).toBe(true)
      expect(d.path).toBe(tmp)
    } finally {
      if (savedJava === undefined) delete process.env.JAVA_HOME
      else process.env.JAVA_HOME = savedJava
      resetToolchainCache()
    }
  })

  it('detect(java) REJECTS a JDK whose `release` file JAVA_VERSION is not 21 (e.g. 25)', () => {
    const savedJava = process.env.JAVA_HOME
    fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), '')
    fs.writeFileSync(path.join(tmp, 'release'), 'JAVA_VERSION="25.0.3"\n')
    process.env.JAVA_HOME = tmp
    resetToolchainCache()
    try {
      expect(detect('java').path).not.toBe(tmp)
    } finally {
      if (savedJava === undefined) delete process.env.JAVA_HOME
      else process.env.JAVA_HOME = savedJava
      resetToolchainCache()
    }
  })

  it('detectAdb derives adb from the SDK platform-tools dir', () => {
    const adbName = process.platform === 'win32' ? 'adb.exe' : 'adb'
    fs.mkdirSync(path.join(tmp, 'platform-tools'))
    fs.writeFileSync(path.join(tmp, 'platform-tools', adbName), '')
    process.env.ANDROID_HOME = tmp
    resetToolchainCache()
    const adb = detectAdb()
    expect(adb.present).toBe(true)
    expect(adb.path).toBe(path.join(tmp, 'platform-tools', adbName))
  })

  it('detectAdb reports absent when the SDK exists but adb is missing', () => {
    fs.mkdirSync(path.join(tmp, 'platform-tools')) // sdk present (marker) but no adb binary
    process.env.ANDROID_HOME = tmp
    resetToolchainCache()
    expect(detectAdb().present).toBe(false)
  })
})

describe('toolchain guide() / install() verbs', () => {
  it('guide(xcodebuild) is manual (canAutoInstall:false) with steps + an App Store link', () => {
    const g = guide('xcodebuild')
    expect(g.canAutoInstall).toBe(false)
    expect(g.steps.length).toBeGreaterThan(0)
    expect(g.links?.[0]?.url).toMatch(/apps\.apple\.com/)
  })

  it('cocoapods is one-click installable on macOS (provisioned Ruby, no brew), guided elsewhere', () => {
    const g = guide('cocoapods')
    expect(INSTALLABLE.has('cocoapods')).toBe(false) // special: provisioned via its own Ruby, not the static set
    // Installable on darwin (we download a portable Ruby + gem-install CocoaPods); guided otherwise.
    expect(isInstallable('cocoapods')).toBe(process.platform === 'darwin')
    expect(g.canAutoInstall).toBe(isInstallable('cocoapods'))
    expect(g.steps.join(' ')).toMatch(/no Homebrew|without.*Homebrew|provisions its own Ruby/i)
    expect(g.links?.[0]?.url).toMatch(/cocoapods\.org/)
  })

  it('cocoapodsEnv() is null until CocoaPods is provisioned (no crash when absent)', () => {
    const saved = process.env.MODOKI_TOOLCHAIN_DIR
    process.env.MODOKI_TOOLCHAIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-cp-'))
    try {
      expect(cocoapodsEnv()).toBeNull() // no ruby/ + cocoapods-gems/ provisioned yet
    } finally {
      fs.rmSync(process.env.MODOKI_TOOLCHAIN_DIR, { recursive: true, force: true })
      if (saved === undefined) delete process.env.MODOKI_TOOLCHAIN_DIR
      else process.env.MODOKI_TOOLCHAIN_DIR = saved
    }
  })

  it('guide() marks canAutoInstall from the INSTALLABLE set', () => {
    expect(guide('gltf-transform-cli').canAutoInstall).toBe(INSTALLABLE.has('gltf-transform-cli'))
    expect(INSTALLABLE.has('gltf-transform-cli')).toBe(true)
    // gltfpack is the second npm-CLI model tool (E-3) — also auto-installable.
    expect(guide('gltfpack').canAutoInstall).toBe(INSTALLABLE.has('gltfpack'))
    expect(INSTALLABLE.has('gltfpack')).toBe(true)
  })

  it('install() rejects a tool that can only be guided (Xcode)', async () => {
    await expect(install('xcodebuild', { toolchainDir: '/tmp/x' })).rejects.toThrow(/guide/i)
  })

  it('detect(gltf-transform-cli) finds a userData-installed CLI via MODOKI_TOOLCHAIN_DIR', () => {
    const saved = process.env.MODOKI_TOOLCHAIN_DIR
    const tc = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-tc-'))
    // npmToolBin picks the platform-correct shim (.cmd on Windows) — the exact path the code resolves.
    const bin = npmToolBin(tc, 'gltf-transform')
    writeExecStub(bin, '4.0.0') // answers --version so the binary probe passes
    process.env.MODOKI_TOOLCHAIN_DIR = tc
    resetToolchainCache()
    try {
      const d = detect('gltf-transform-cli')
      expect(d.present).toBe(true)
      expect(d.path).toBe(bin)
      expect(d.source).toBe('probe')
    } finally {
      if (saved === undefined) delete process.env.MODOKI_TOOLCHAIN_DIR
      else process.env.MODOKI_TOOLCHAIN_DIR = saved
      fs.rmSync(tc, { recursive: true, force: true })
      resetToolchainCache()
    }
  })

  it('detect(gltfpack) finds a userData-installed CLI via MODOKI_TOOLCHAIN_DIR (probes -v)', () => {
    const saved = process.env.MODOKI_TOOLCHAIN_DIR
    const savedPath = process.env.PATH
    const tc = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-tc-'))
    const bin = npmToolBin(tc, 'gltfpack') // platform-correct shim (.cmd on Windows)
    writeExecStub(bin, 'gltfpack 1.2') // gltfpack answers `-v` with its version on stdout, exit 0
    process.env.MODOKI_TOOLCHAIN_DIR = tc
    process.env.PATH = '' // ensure the userData candidate (not a PATH gltfpack) is what's found
    resetToolchainCache()
    try {
      const d = detect('gltfpack')
      expect(d.present).toBe(true)
      expect(d.path).toBe(bin)
      expect(d.source).toBe('probe')
      expect(d.version).toBe('gltfpack 1.2')
    } finally {
      if (saved === undefined) delete process.env.MODOKI_TOOLCHAIN_DIR
      else process.env.MODOKI_TOOLCHAIN_DIR = saved
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      fs.rmSync(tc, { recursive: true, force: true })
      resetToolchainCache()
    }
  })

  // Skipped on Windows: ffmpeg-static's payload is a real ffmpeg.exe the code spawns WITHOUT a
  // shell, so it can't be faked with a script. ffmpegToolBin's .exe-suffix logic is unit-tested
  // above, and the real editor resolves it on Windows (verified via /api/toolchain).
  it.skipIf(process.platform === 'win32')('detect(ffmpeg) finds the in-package binary (no .bin symlink) via MODOKI_TOOLCHAIN_DIR', () => {
    const saved = process.env.MODOKI_TOOLCHAIN_DIR
    const savedPath = process.env.PATH
    const tc = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-tc-'))
    // ffmpeg-static keeps the binary at the package ROOT, not node_modules/.bin.
    const bin = path.join(tc, 'npm-tools', 'node_modules', 'ffmpeg-static', 'ffmpeg')
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, '#!/bin/sh\necho "ffmpeg version 6.0"\n')
    fs.chmodSync(bin, 0o755)
    process.env.MODOKI_TOOLCHAIN_DIR = tc
    process.env.PATH = '' // ensure the userData candidate wins over any system ffmpeg
    resetToolchainCache()
    try {
      const d = detect('ffmpeg')
      expect(d.present).toBe(true)
      expect(d.path).toBe(bin)
      expect(d.source).toBe('probe')
    } finally {
      if (saved === undefined) delete process.env.MODOKI_TOOLCHAIN_DIR
      else process.env.MODOKI_TOOLCHAIN_DIR = saved
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      fs.rmSync(tc, { recursive: true, force: true })
      resetToolchainCache()
    }
  })

  // Windows batch-shim spawn class (CVE-2024-27980): Node throws `spawn EINVAL` running a
  // .cmd/.bat without a shell, and probing one with a no-shell execFile fails the same way —
  // which read as sdkmanager / gltf-transform being "not found" after a successful install.
  it('needsWinShell flags .cmd/.bat on win32 only', () => {
    expect(needsWinShell('C:\\x\\gltf-transform.cmd', 'win32')).toBe(true)
    expect(needsWinShell('C:\\x\\sdkmanager.bat', 'win32')).toBe(true)
    expect(needsWinShell('C:\\x\\ffprobe.exe', 'win32')).toBe(false) // a real .exe spawns fine
    expect(needsWinShell('/usr/bin/gltf-transform', 'darwin')).toBe(false)
    expect(needsWinShell('/x/foo.cmd', 'linux')).toBe(false) // .cmd is meaningless off Windows
  })

  it('npmToolBin resolves the .cmd shim on win32, bare name elsewhere', () => {
    expect(npmToolBin('/tc', 'gltf-transform', 'win32').endsWith(path.join('.bin', 'gltf-transform.cmd'))).toBe(true)
    expect(npmToolBin('/tc', 'gltf-transform', 'darwin').endsWith(path.join('.bin', 'gltf-transform'))).toBe(true)
    expect(npmToolBin('/tc', 'gltfpack', 'linux').endsWith('.cmd')).toBe(false)
  })

  // Pure path resolvers — assert the WINDOWS branch from any host (macOS/Linux CI).
  // Regression: on Windows the payload is ffmpeg.exe / ffprobe.exe; omitting the `.exe`
  // suffix resolved to a non-existent path, so provisioning threw "Installed
  // @ffprobe-installer/ffprobe but its executable is missing" even though npm succeeded.
  it('ffmpegToolBin appends .exe on win32, bare name elsewhere', () => {
    const tc = '/tc'
    expect(ffmpegToolBin(tc, 'win32').endsWith(path.join('ffmpeg-static', 'ffmpeg.exe'))).toBe(true)
    expect(ffmpegToolBin(tc, 'darwin').endsWith(path.join('ffmpeg-static', 'ffmpeg'))).toBe(true)
    expect(ffmpegToolBin(tc, 'linux').endsWith('.exe')).toBe(false)
  })

  it('ffprobeToolBin picks the per-platform sub-package + .exe on win32', () => {
    const tc = '/tc'
    expect(ffprobeToolBin(tc, 'win32', 'x64')).toContain(path.join('@ffprobe-installer', 'win32-x64', 'ffprobe.exe'))
    expect(ffprobeToolBin(tc, 'darwin', 'arm64')).toContain(path.join('@ffprobe-installer', 'darwin-arm64', 'ffprobe'))
    expect(ffprobeToolBin(tc, 'darwin', 'arm64').endsWith('.exe')).toBe(false)
  })

  // Skipped on Windows: same as ffmpeg — @ffprobe-installer ships a real ffprobe.exe spawned
  // without a shell; ffprobeToolBin's per-platform + .exe logic is unit-tested above.
  it.skipIf(process.platform === 'win32')('detect(ffprobe) resolves the per-platform @ffprobe-installer sub-package binary', () => {
    const saved = process.env.MODOKI_TOOLCHAIN_DIR
    const savedPath = process.env.PATH
    const tc = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-tc-'))
    const bin = path.join(tc, 'npm-tools', 'node_modules', '@ffprobe-installer', `${process.platform}-${process.arch}`, 'ffprobe')
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, '#!/bin/sh\necho "ffprobe version n4.4.1"\n')
    fs.chmodSync(bin, 0o755)
    process.env.MODOKI_TOOLCHAIN_DIR = tc
    process.env.PATH = ''
    resetToolchainCache()
    try {
      const d = detect('ffprobe')
      expect(d.present).toBe(true)
      expect(d.path).toBe(bin)
      expect(d.source).toBe('probe')
    } finally {
      if (saved === undefined) delete process.env.MODOKI_TOOLCHAIN_DIR
      else process.env.MODOKI_TOOLCHAIN_DIR = saved
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      fs.rmSync(tc, { recursive: true, force: true })
      resetToolchainCache()
    }
  })

  // Skipped on Windows: part (b) needs a PATH-resolvable `gltf-transform` the code probes by bare
  // name without a shell — Windows won't resolve a `.cmd`/extensionless script that way, so a
  // system tool on PATH can't be faked. systemToolchainAllowed gating is covered by other tests.
  it.skipIf(process.platform === 'win32')('bundled-only mode does NOT fall back to a system-PATH installable tool', () => {
    const saved = process.env.MODOKI_TOOLCHAIN_DIR
    const savedPath = process.env.PATH
    const savedAllow = process.env.MODOKI_ALLOW_SYSTEM_TOOLCHAIN
    const tc = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-tc-')) // no settings.json → bundled-only
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-sysbin-'))
    const sys = path.join(binDir, 'gltf-transform')
    fs.writeFileSync(sys, '#!/bin/sh\necho 4.0.0\n') // a system gltf-transform on PATH
    fs.chmodSync(sys, 0o755)
    process.env.MODOKI_TOOLCHAIN_DIR = tc
    process.env.PATH = binDir
    delete process.env.MODOKI_ALLOW_SYSTEM_TOOLCHAIN
    resetToolchainCache()
    try {
      // The toolchain has no gltf install and the PATH one must be IGNORED (no system fallback).
      expect(detect('gltf-transform-cli').present).toBe(false)
      // Opting into system tools ("Use system SDKs") brings the PATH one back.
      process.env.MODOKI_ALLOW_SYSTEM_TOOLCHAIN = '1'
      resetToolchainCache()
      const d = detect('gltf-transform-cli')
      expect(d.present).toBe(true)
      expect(d.source).toBe('path')
    } finally {
      if (saved === undefined) delete process.env.MODOKI_TOOLCHAIN_DIR; else process.env.MODOKI_TOOLCHAIN_DIR = saved
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath
      if (savedAllow === undefined) delete process.env.MODOKI_ALLOW_SYSTEM_TOOLCHAIN; else process.env.MODOKI_ALLOW_SYSTEM_TOOLCHAIN = savedAllow
      fs.rmSync(tc, { recursive: true, force: true })
      fs.rmSync(binDir, { recursive: true, force: true })
      resetToolchainCache()
    }
  })

  it('ffmpeg/ffprobe are installable but NOT version-pinned (npm ver ≠ CLI ver → never stale)', () => {
    expect(isInstallable('ffmpeg')).toBe(true)
    expect(isInstallable('ffprobe')).toBe(true)
    expect(PINNED_TOOL_VERSIONS.ffmpeg).toBeUndefined()
    expect(PINNED_TOOL_VERSIONS.ffprobe).toBeUndefined()
    // With no pin, isToolStale is always false regardless of the detected version.
    const d: DetectResult = { id: 'ffmpeg', present: true, source: 'probe', command: '/x/ffmpeg', path: '/x/ffmpeg', version: 'ffmpeg version 6.0' }
    expect(isToolStale('ffmpeg', d)).toBe(false)
  })
})

describe('toolchain registry consistency (drift guards)', () => {
  it('every INSTALLABLE id is a registered tool', () => {
    for (const id of INSTALLABLE) expect(TOOL_IDS).toContain(id)
  })

  it('guide() returns a well-formed doc for every tool, with canAutoInstall matching isInstallable', () => {
    for (const id of TOOL_IDS) {
      const g = guide(id)
      expect(g.id).toBe(id)
      expect(g.steps.length).toBeGreaterThan(0)
      expect(g.canAutoInstall).toBe(isInstallable(id))
    }
  })

  it('install() rejects — never silently no-ops — a guided-only tool (Xcode)', async () => {
    // A guided-only tool must throw (point at guide()), so a caller can't mistake it for installed.
    await expect(install('xcodebuild', { toolchainDir: '/tmp/x' })).rejects.toThrow()
  })
})

describe('toolchain toolchainStatus() — the Build-Support dialog status read', () => {
  let savedDir: string | undefined
  beforeEach(() => { savedDir = process.env.MODOKI_TOOLCHAIN_DIR; resetToolchainCache() })
  afterEach(() => {
    if (savedDir === undefined) delete process.env.MODOKI_TOOLCHAIN_DIR
    else process.env.MODOKI_TOOLCHAIN_DIR = savedDir
    resetToolchainCache()
  })

  it('reports one row per registered tool, each with an install-vs-guide affordance', () => {
    // Presence is machine-dependent — assert STRUCTURE + invariants, not present/absent.
    const st = toolchainStatus()
    expect(st.tools.map((t) => t.id).sort()).toEqual([...TOOL_IDS].sort())
    for (const t of st.tools) {
      expect(t.installable).toBe(isInstallable(t.id))
      expect(t.guide.id).toBe(t.id)
      // An installable tool's guide is auto; a guided-only tool's is manual.
      expect(t.guide.canAutoInstall).toBe(t.installable)
      // A present tool carries a source that isn't 'missing'; an absent one is 'missing'.
      expect(t.present ? t.source !== 'missing' : t.source === 'missing').toBe(true)
    }
  })

  it('carries preflight for all three targets + the platform + toolchainDir', () => {
    process.env.MODOKI_TOOLCHAIN_DIR = '/tmp/some-toolchain'
    const st = toolchainStatus()
    expect(st.platform).toBe(process.platform)
    expect(st.toolchainDir).toBe('/tmp/some-toolchain')
    expect(Object.keys(st.preflight).sort()).toEqual(['android', 'ios', 'web'])
    expect(st.preflight.web.ready).toBe(true)
    // adb is surfaced separately from the registry tools.
    expect(typeof st.adb.present).toBe('boolean')
  })

  it('toolchainDir is null when no userData dir is shared (a plain dev editor)', () => {
    delete process.env.MODOKI_TOOLCHAIN_DIR
    expect(toolchainStatus().toolchainDir).toBeNull()
  })
})

describe('toolchain model-CLI invocation seam (E-3.5)', () => {
  let savedDir: string | undefined
  let savedPath: string | undefined
  beforeEach(() => { savedDir = process.env.MODOKI_TOOLCHAIN_DIR; savedPath = process.env.PATH; resetToolchainCache() })
  afterEach(() => {
    if (savedDir === undefined) delete process.env.MODOKI_TOOLCHAIN_DIR; else process.env.MODOKI_TOOLCHAIN_DIR = savedDir
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath
    resetToolchainCache()
  })

  it('gltfTransformInvocation falls back to `npx --no-install @gltf-transform/cli` in dev (no install, not on PATH)', () => {
    delete process.env.MODOKI_TOOLCHAIN_DIR
    process.env.PATH = '' // no system gltf-transform
    resetToolchainCache()
    expect(gltfTransformInvocation()).toEqual({ command: 'npx', prefixArgs: ['--no-install', '@gltf-transform/cli'] })
  })

  it('gltfTransformInvocation prefers a userData install (packaged editor)', () => {
    const tc = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-inv-'))
    const bin = npmToolBin(tc, 'gltf-transform') // platform-correct shim (.cmd on Windows)
    writeExecStub(bin, '4.4.1')
    process.env.MODOKI_TOOLCHAIN_DIR = tc
    process.env.PATH = ''
    resetToolchainCache()
    try {
      const inv = gltfTransformInvocation()
      expect(inv.command).toBe(bin)
      expect(inv.prefixArgs).toEqual([])
    } finally { fs.rmSync(tc, { recursive: true, force: true }) }
  })

  it('gltfpackInvocation falls back to a bare PATH `gltfpack` in dev (no install)', () => {
    delete process.env.MODOKI_TOOLCHAIN_DIR
    process.env.PATH = ''
    resetToolchainCache()
    expect(gltfpackInvocation()).toEqual({ command: 'gltfpack', prefixArgs: [] })
  })
})

describe('toolchain preflight() — the friendly build-tool gate', () => {
  let savedHome: string | undefined
  let savedRoot: string | undefined
  let savedJava: string | undefined
  beforeEach(() => {
    savedHome = process.env.ANDROID_HOME; savedRoot = process.env.ANDROID_SDK_ROOT; savedJava = process.env.JAVA_HOME
    resetToolchainCache()
  })
  afterEach(() => {
    const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    restore('ANDROID_HOME', savedHome); restore('ANDROID_SDK_ROOT', savedRoot); restore('JAVA_HOME', savedJava)
    resetToolchainCache()
  })

  it('web needs no native tools — always ready', () => {
    const pf = preflight('web')
    expect(pf.ready).toBe(true)
    expect(pf.tools).toEqual([])
  })

  it('android reports java/android-sdk/adb with the ready + message invariants', () => {
    // (Presence is machine-dependent — this box may have an SDK — so assert the STRUCTURE +
    // invariants, not a specific present/absent, which stays deterministic across machines.)
    const pf = preflight('android')
    expect(pf.tools.map((t) => t.id).sort()).toEqual(['adb', 'android-sdk', 'java'])
    // ready iff every tool present; every absent tool carries an actionable message.
    expect(pf.ready).toBe(pf.tools.every((t) => t.present))
    for (const t of pf.tools) if (!t.present) expect(t.message, `${t.id} needs a message`).toBeTruthy()
  })

  it('ios reports xcodebuild (or a macOS-only note off-darwin)', () => {
    const pf = preflight('ios')
    expect(pf.tools.map((t) => t.id)).toEqual(['xcodebuild'])
    if (process.platform !== 'darwin') expect(pf.ready).toBe(false)
  })
})

describe('toolchain — bundled-vs-system SDK preference (systemToolchainAllowed + settings)', () => {
  let tcDir: string
  let savedTcDir: string | undefined
  let savedAllowEnv: string | undefined

  beforeEach(() => {
    savedTcDir = process.env.MODOKI_TOOLCHAIN_DIR
    savedAllowEnv = process.env.MODOKI_ALLOW_SYSTEM_TOOLCHAIN
    delete process.env.MODOKI_ALLOW_SYSTEM_TOOLCHAIN
    tcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-tc-'))
  })
  afterEach(() => {
    if (savedTcDir === undefined) delete process.env.MODOKI_TOOLCHAIN_DIR
    else process.env.MODOKI_TOOLCHAIN_DIR = savedTcDir
    if (savedAllowEnv === undefined) delete process.env.MODOKI_ALLOW_SYSTEM_TOOLCHAIN
    else process.env.MODOKI_ALLOW_SYSTEM_TOOLCHAIN = savedAllowEnv
    fs.rmSync(tcDir, { recursive: true, force: true })
  })

  it('DEV editor (no toolchain dir) always allows the machine SDKs', () => {
    delete process.env.MODOKI_TOOLCHAIN_DIR
    expect(systemToolchainAllowed()).toBe(true)
  })

  it('PACKAGED editor defaults to BUNDLED-ONLY (no system fallback)', () => {
    process.env.MODOKI_TOOLCHAIN_DIR = tcDir
    expect(systemToolchainAllowed()).toBe(false) // no settings.json yet → bundled-only
    expect(toolchainStatus().allowSystemToolchain).toBe(false)
  })

  it('the persisted "Use system SDKs" toggle flips it (round-trips via settings.json)', () => {
    process.env.MODOKI_TOOLCHAIN_DIR = tcDir
    expect(readToolchainSettings().allowSystemToolchain).toBe(false)
    writeToolchainSettings({ allowSystemToolchain: true })
    expect(fs.existsSync(path.join(tcDir, 'settings.json'))).toBe(true)
    expect(readToolchainSettings().allowSystemToolchain).toBe(true)
    expect(systemToolchainAllowed()).toBe(true)
    writeToolchainSettings({ allowSystemToolchain: false })
    expect(systemToolchainAllowed()).toBe(false)
  })

  it('MODOKI_ALLOW_SYSTEM_TOOLCHAIN=1 overrides the bundled-only default', () => {
    process.env.MODOKI_TOOLCHAIN_DIR = tcDir
    process.env.MODOKI_ALLOW_SYSTEM_TOOLCHAIN = '1'
    expect(systemToolchainAllowed()).toBe(true)
  })

  it('writeToolchainSettings throws in a dev editor (no toolchain dir to persist into)', () => {
    delete process.env.MODOKI_TOOLCHAIN_DIR
    expect(() => writeToolchainSettings({ allowSystemToolchain: true })).toThrow(/no toolchain dir/i)
  })
})

describe('toolchain — pinned CLI/gem tool versions + staleness (bump → reinstall)', () => {
  let savedTc: string | undefined
  beforeEach(() => { savedTc = process.env.MODOKI_TOOLCHAIN_DIR })
  afterEach(() => {
    if (savedTc === undefined) delete process.env.MODOKI_TOOLCHAIN_DIR
    else process.env.MODOKI_TOOLCHAIN_DIR = savedTc
  })

  it('pins exact versions for the by-name tools (gltf-transform, gltfpack, cocoapods)', () => {
    expect(PINNED_TOOL_VERSIONS['gltf-transform-cli']).toMatch(/^\d+\.\d+\.\d+/)
    expect(PINNED_TOOL_VERSIONS.gltfpack).toMatch(/^\d+\.\d+\.\d+/)
    expect(PINNED_TOOL_VERSIONS.cocoapods).toMatch(/^\d+\.\d+\.\d+/)
  })

  const mk = (over: Partial<DetectResult>): DetectResult => ({ id: 'gltf-transform-cli', present: true, source: 'probe', ...over })

  it('flags OUR-toolchain install as STALE when its version != the pin, fresh when it matches', () => {
    const tc = '/tmp/modoki-tc-stale'
    process.env.MODOKI_TOOLCHAIN_DIR = tc
    const pin = PINNED_TOOL_VERSIONS['gltf-transform-cli']!
    const inTc = `${tc}/npm-tools/node_modules/.bin/gltf-transform`
    expect(isToolStale('gltf-transform-cli', mk({ version: pin, path: inTc }))).toBe(false)      // matches pin
    expect(isToolStale('gltf-transform-cli', mk({ version: '0.0.1', path: inTc }))).toBe(true)   // old → stale
  })

  it('does NOT flag a SYSTEM/PATH tool as stale (only our own installs are pinned)', () => {
    process.env.MODOKI_TOOLCHAIN_DIR = '/tmp/modoki-tc-x'
    // Resolved from PATH (path outside the toolchain dir) → left alone regardless of version.
    expect(isToolStale('gltf-transform-cli', mk({ version: '0.0.1', path: '/usr/local/bin/gltf-transform', source: 'path' }))).toBe(false)
  })

  it('never stale for an un-pinned tool, or when absent', () => {
    process.env.MODOKI_TOOLCHAIN_DIR = '/tmp/modoki-tc-y'
    expect(isToolStale('toktx', mk({ id: 'toktx', version: '1.0', path: '/tmp/modoki-tc-y/x' }))).toBe(false)
    expect(isToolStale('gltf-transform-cli', mk({ present: false, version: undefined }))).toBe(false)
  })
})

describe('toolchain — uninstall / uninstallAll (remove provisioned tools)', () => {
  let root: string
  let tc: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-un-')); tc = path.join(root, 'toolchain'); fs.mkdirSync(tc) })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("uninstall('java') removes <toolchain>/jdk", async () => {
    fs.mkdirSync(path.join(tc, 'jdk', '21.0.11+10'), { recursive: true })
    await uninstall('java', { toolchainDir: tc })
    expect(fs.existsSync(path.join(tc, 'jdk'))).toBe(false)
  })

  it("uninstall('cocoapods') removes BOTH cocoapods-gems AND the portable ruby it ran on", async () => {
    fs.mkdirSync(path.join(tc, 'cocoapods-gems'), { recursive: true })
    fs.mkdirSync(path.join(tc, 'ruby'), { recursive: true })
    await uninstall('cocoapods', { toolchainDir: tc })
    expect(fs.existsSync(path.join(tc, 'cocoapods-gems'))).toBe(false)
    expect(fs.existsSync(path.join(tc, 'ruby'))).toBe(false)
  })

  it('uninstallAll deletes the ENTIRE toolchain folder (settings included)', () => {
    fs.mkdirSync(path.join(tc, 'node'), { recursive: true })
    fs.writeFileSync(path.join(tc, 'settings.json'), '{}')
    uninstallAll(tc)
    expect(fs.existsSync(tc)).toBe(false)
  })

  it('uninstallAll REFUSES a path not named "toolchain" (safety guard)', () => {
    const notTc = path.join(root, 'important-stuff')
    fs.mkdirSync(notTc)
    expect(() => uninstallAll(notTc)).toThrow(/refusing/i)
    expect(fs.existsSync(notTc)).toBe(true) // untouched
  })
})

describe('toolchain — detect(npm) resolves a PROVISIONED Node (Core shows present)', () => {
  let dir: string
  let savedNode: string | undefined, savedCli: string | undefined
  beforeEach(() => {
    savedNode = process.env.MODOKI_NODE; savedCli = process.env.MODOKI_NPM_CLI
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-npm-'))
    resetToolchainCache()
  })
  afterEach(() => {
    if (savedNode === undefined) delete process.env.MODOKI_NODE; else process.env.MODOKI_NODE = savedNode
    if (savedCli === undefined) delete process.env.MODOKI_NPM_CLI; else process.env.MODOKI_NPM_CLI = savedCli
    fs.rmSync(dir, { recursive: true, force: true }); resetToolchainCache()
  })

  it('reports npm present via MODOKI_NODE + MODOKI_NPM_CLI even with no PATH npm', () => {
    // A fake npm-cli.js the provisioned node runs: `node npm-cli.js --version` → prints a version.
    const npmCli = path.join(dir, 'npm-cli.js')
    fs.writeFileSync(npmCli, `console.log('10.9.8')`)
    process.env.MODOKI_NODE = process.execPath // real node — answers `node <cli> --version`
    process.env.MODOKI_NPM_CLI = npmCli
    resetToolchainCache()
    const d = detect('npm')
    expect(d.present).toBe(true)
    expect(d.source).toBe('env')
    expect(d.version).toBe('10.9.8')
    expect(d.path).toBe(npmCli)
  })

  it('falls back to the normal probe when the provisioned paths are unset', () => {
    delete process.env.MODOKI_NODE; delete process.env.MODOKI_NPM_CLI
    resetToolchainCache()
    // No assertion on present (depends on the host's system npm) — just that it doesn't throw
    // and returns a well-formed result rather than crashing on the missing provisioned Node.
    const d = detect('npm')
    expect(d.id).toBe('npm')
    expect(typeof d.present).toBe('boolean')
  })
})
