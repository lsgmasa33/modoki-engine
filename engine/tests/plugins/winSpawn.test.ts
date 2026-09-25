import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { makeScratchDir } from '@modoki/engine/testing/scratchDir'
import { toSpawn, needsWinShell, winBatchCommandLine } from '../../scripts/winSpawn.mjs'

/**
 * #1537 — variable data (project/asset/folder names, profile paths) reaches a Windows batch file's
 * command line. cmd.exe expands `%VAR%` even inside quotes and runs an unquoted `&` as a second
 * command; the old quote-only `spawnable()` delivered `C:\proj\%OS%\a.glb` as
 * `C:\proj\Windows_NT\a.glb` (observed on the win clone). These tests pin `toSpawn` against that.
 */

/** Every arg shape that broke, or could break, a cmd.exe line: env expansion (`%OS%` is defined on
 *  every Windows box, so an expansion is always visible), command separators, the caret itself,
 *  delayed-expansion `!`, grouping parens, embedded quotes, the MSVCRT backslash-before-quote and
 *  trailing-backslash rules, a space, and the empty arg. */
const HOSTILE = [
  String.raw`C:\p\%OS%\a&echo INJ&b^c!OS!(e) f.glb`,
  // Under a placeholder user: `C:\Users\<name>` is read as a real home dir by the publish scan.
  String.raw`--sdk_root=C:\Users\dev\100%OS%\sdk`,
  'plain',
  String.raw`tail\\`,
  String.raw`C:\Users\Jane Doe\x`,
  'q"uote',
  // An embedded quote flips cmd's quote state for the REST of the arg, so on the batch's second
  // parse of `%*` this `&` sits outside quotes — the case the args' second caret pass exists for.
  'x"&echo INJ&"y%OS%',
  '',
  String.raw`a\"b`,
  'semi;colon,comma=eq',
  'pipe|and<gt>',
]

describe('winSpawn toSpawn() — shape (every host)', () => {
  it('a non-batch command spawns with NO shell and argv untouched, on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(toSpawn('C:\\x\\ffmpeg.exe', HOSTILE, { platform })).toEqual({ command: 'C:\\x\\ffmpeg.exe', args: HOSTILE, options: { shell: false } })
    }
    // `.cmd` means nothing off Windows.
    expect(toSpawn('/x/foo.cmd', ['a b'], { platform: 'linux' }).options).toEqual({ shell: false })
  })

  it('a win32 batch file runs through cmd.exe itself — never `shell:true` — with a verbatim line', () => {
    const s = toSpawn('C:\\x\\gltf-transform.cmd', ['weld', 'a.glb'], { platform: 'win32', comspec: 'C:\\Windows\\system32\\cmd.exe' })
    expect(s.command).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(s.options).toEqual({ shell: false, windowsVerbatimArguments: true })
    expect(s.args.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c'])
    expect(s.args[4]).toBe(`"${winBatchCommandLine('C:\\x\\gltf-transform.cmd', ['weld', 'a.glb'])}"`)
  })

  it('no `%` survives unescaped into the line — the character quoting could never neutralise', () => {
    const line = winBatchCommandLine('C:\\100%\\t.cmd', ['%OS%'])
    // Every `%` is preceded by a caret (the args' by two, since the batch re-parses `%*`).
    expect(line.match(/(?<!\^)%/g)).toBeNull()
  })

  it('on win32 a BARE name is resolved on the given env PATH (the lookup a shell used to do); posix leaves it alone', () => {
    const dir = makeScratchDir('modoki-bare-')
    try {
      // A name found ONLY in the fixture dir: a real `npm.cmd` on this machine's PATH would let a
      // resolver that ignored `env` pass too (it did, under mutation).
      fs.writeFileSync(path.join(dir, 'modoki-fixture-tool.cmd'), '@echo off')
      const s = toSpawn('modoki-fixture-tool', ['install'], { platform: 'win32', comspec: 'cmd.exe', env: { Path: dir } })
      expect(s.command).toBe('cmd.exe')
      expect(s.args[4]).toContain('modoki-fixture-tool.cmd') // resolved through the Path key, then the batch route
      expect(toSpawn('modoki-fixture-tool', ['install'], { platform: 'darwin', env: { PATH: dir } }).command).toBe('modoki-fixture-tool')
      // An unresolvable name is spawned as given — a plain ENOENT naming it, not a silent shell lookup.
      expect(toSpawn('nope-not-here', [], { platform: 'win32', env: { PATH: dir } }).command).toBe('nope-not-here')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('needsWinShell flags .cmd/.bat on win32 only', () => {
    expect(needsWinShell('C:\\x\\gltf-transform.cmd', 'win32')).toBe(true)
    expect(needsWinShell('C:\\x\\sdkmanager.BAT', 'win32')).toBe(true)
    expect(needsWinShell('C:\\x\\ffprobe.exe', 'win32')).toBe(false)
    expect(needsWinShell('/x/foo.cmd', 'linux')).toBe(false)
  })
})

describe.skipIf(process.platform !== 'win32')('winSpawn toSpawn() — round trip through a real cmd.exe (win32)', () => {
  let root: string
  // Each shim sits in a HOSTILE directory of its own: the command half of the line is escaped
  // separately from the args. ⚠️ The npm cmd-shim's directory has no `&`: the shim itself runs
  // `SET dp0=%~dp0` UNQUOTED, so an `&` in its own install path breaks the shim before our line is
  // involved (observed: "\ was unexpected at this time"). That is npm's defect, not the escaper's.
  const dirs = { 'npm-shim.cmd': 'sp ace %OS% (x)', 'gradle-style.bat': 'sp ace %OS% & (x)' } as const
  const dirOf = (shim: keyof typeof dirs) => path.join(root, dirs[shim])
  beforeAll(() => {
    root = makeScratchDir('modoki-winspawn-')
    for (const d of Object.values(dirs)) {
      fs.mkdirSync(path.join(root, d), { recursive: true })
      fs.writeFileSync(path.join(root, d, 'argv.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
    }
    const dir = dirOf('npm-shim.cmd')
    // The npm cmd-shim shape (node_modules/.bin/<tool>.cmd, verbatim structure): `%dp0%` + `%*`.
    fs.writeFileSync(path.join(dir, 'npm-shim.cmd'), [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
      'SET "_prog=node"', 'SET PATHEXT=%PATHEXT:;.JS;=;%',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\argv.js" %*', '',
    ].join('\r\n'))
    // The gradlew.bat / sdkmanager.bat shape: a quoted program, then `%*` forwarded once.
    fs.writeFileSync(path.join(dirOf('gradle-style.bat'), 'gradle-style.bat'), '@ECHO off\r\nsetlocal\r\nset "PROG=node"\r\n"%PROG%" "%~dp0\\argv.js" %*\r\n')
    // SYNTHETIC — no batch the engine runs has this shape (gcloud.cmd turns delayed expansion back
    // OFF before its `%*` line): `%*` forwarded WHILE delayed expansion is on. Pins the documented residual.
    fs.writeFileSync(path.join(dirOf('gradle-style.bat'), 'delayed-on.cmd'),
      '@echo off\r\nSETLOCAL EnableDelayedExpansion\r\nnode "%~dp0argv.js" %*\r\n')
  })

  it('delayed-on.cmd (synthetic): every arg WITHOUT `!` still arrives exact; a `!` does not — the documented residual', () => {
    const shim = path.join(dirOf('gradle-style.bat'), 'delayed-on.cmd')
    for (const arg of HOSTILE.filter((a) => !a.includes('!'))) {
      const s = toSpawn(shim, [arg])
      const r = spawnSync(s.command, s.args, { ...s.options, encoding: 'utf8' })
      expect({ arg, stderr: r.stderr, out: r.stdout }).toEqual({ arg, stderr: '', out: JSON.stringify([arg]) })
    }
    const s = toSpawn(shim, ['a!OS!b'])
    expect(spawnSync(s.command, s.args, { ...s.options, encoding: 'utf8' }).stdout).toBe(JSON.stringify(['aWindows_NTb']))
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))


  for (const shim of ['npm-shim.cmd', 'gradle-style.bat'] as const) {
    it(`${shim}: every hostile arg arrives byte-exact — no expansion, no second command`, () => {
      const s = toSpawn(path.join(dirOf(shim), shim), HOSTILE)
      const r = spawnSync(s.command, s.args, { ...s.options, encoding: 'utf8' })
      expect(r.stderr).toBe('')
      expect(JSON.parse(r.stdout)).toEqual(HOSTILE)
    })

    // ALONE as well as together: cmd's quote state carries across args, so one arg with an odd
    // quote count can re-quote the next arg's `&` and mask a missing escape (it did — a
    // single-caret mutation stayed green while every arg shared one line).
    it(`${shim}: each hostile arg ALONE arrives byte-exact`, () => {
      for (const arg of HOSTILE) {
        const s = toSpawn(path.join(dirOf(shim), shim), [arg])
        const r = spawnSync(s.command, s.args, { ...s.options, encoding: 'utf8' })
        expect({ arg, stderr: r.stderr, out: r.stdout }).toEqual({ arg, stderr: '', out: JSON.stringify([arg]) })
      }
    })
  }
})
