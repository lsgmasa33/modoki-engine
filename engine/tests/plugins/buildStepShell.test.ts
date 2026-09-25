import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { makeScratchDir } from '@modoki/engine/testing/scratchDir'
import {
  planBuildStep, spawnBuildStep, sh, ref, authoredShell, execStep,
  killBuildProcess, killBuildProcessSync, winKillTreeArgs, type ShellStep,
} from '../../plugins/buildStepShell'

/** A shell step running `text` from the cwd — the process-tree shape the kill suites below need
 *  (a shell between us and the tool). `authoredShell` is the sanctioned raw-text door. */
const spawnShell = (text: string) =>
  spawnBuildStep({ kind: 'shell', label: 'test', script: authoredShell(text), cwd: process.cwd() }, process.env)

/** Collect a child's stdout/stderr and exit code. */
const finish = (proc: ReturnType<typeof spawnBuildStep>) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
  let out = ''
  let err = ''
  proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
  proc.stderr?.on('data', (d: Buffer) => { err += d.toString() })
  proc.on('close', (code) => resolve({ code, out, err }))
})

/**
 * #1537 — a step used to be one command STRING, and the values in it (paths, bucket names, device
 * ids) were parsed by bash or cmd.exe: `%VAR%` expanded inside cmd's quotes, `$(…)` ran inside
 * bash's. `planBuildStep` is the pure decision of what gets spawned; the round trips below prove a
 * hostile value arrives byte-exact through the real shells.
 */
describe('buildStepShell — planBuildStep (pure, every host)', () => {
  const baseEnv = { PATH: '/usr/bin', MODOKI_NODE: '/tc/node' } as NodeJS.ProcessEnv

  it('an exec step spawns its program + argv with NO shell on posix, argv untouched', () => {
    const hostile = 'a b"$(touch x)%OS%&c'
    for (const platform of ['darwin', 'linux'] as const) {
      const p = planBuildStep(execStep('gradle', '/p', 'android/gradlew', ['-p', 'android', hostile], { winCommand: 'android\\gradlew.bat' }), baseEnv, platform)
      expect(p).toMatchObject({ command: 'android/gradlew', args: ['-p', 'android', hostile], options: { shell: false } })
    }
  })

  it('on win32 an exec step takes winCommand, and a batch file runs through cmd.exe with a verbatim line', () => {
    const p = planBuildStep(execStep('gradle', '/p', 'android/gradlew', ['assembleDebug'], { winCommand: 'android\\gradlew.bat' }), baseEnv, 'win32')
    expect(p.options).toEqual({ shell: false, windowsVerbatimArguments: true })
    expect(p.args.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c'])
    expect(p.args[4]).toContain('gradlew.bat')
  })

  it('on win32 a BARE command is resolved on the step env PATH — no shell does the PATHEXT lookup any more', () => {
    const dir = makeScratchDir('modoki-bare-')
    try {
      // Only in the fixture dir, and reachable only through the STEP's env PATH (baseEnv's is /usr/bin).
      // A real `npx.cmd` on this machine's PATH would let a resolver that ignored the step env pass.
      fs.writeFileSync(path.join(dir, 'modoki-fixture-npx.cmd'), '@echo off')
      const p = planBuildStep(execStep('sync', '/p', 'modoki-fixture-npx', ['cap', 'sync'], { env: { PATH: dir } }), baseEnv, 'win32')
      // Resolved to the shim, so it went the batch route: cmd.exe running <dir>\npx.cmd.
      expect(p.args[4]).toContain('modoki-fixture-npx.cmd')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('merges the step env OVER the shared build env', () => {
    const p = planBuildStep(execStep('apk', '/p', 'gradlew', [], { env: { JAVA_HOME: '/jdk21', MODOKI_NODE: '/over' } }), baseEnv, 'darwin')
    expect(p.env).toMatchObject({ JAVA_HOME: '/jdk21', MODOKI_NODE: '/over', PATH: '/usr/bin' })
  })

  it('a shell step runs its posix text under bash -c and its win text under cmd.exe, with its refs in env', () => {
    const step: ShellStep = { kind: 'shell', label: 's', cwd: '/p', script: sh`echo ${ref('APP_ID', 'com.x')}` }
    const posix = planBuildStep(step, baseEnv, 'darwin')
    expect(posix).toMatchObject({ command: 'bash', args: ['-c', 'echo "$MODOKI_ARG_APP_ID"'] })
    expect(posix.env.MODOKI_ARG_APP_ID).toBe('com.x')
    const win = planBuildStep(step, baseEnv, 'win32')
    expect(win.args).toEqual(['/d', '/v:off', '/s', '/c', '"echo "%MODOKI_ARG_APP_ID%""'])
    expect(win.env.MODOKI_ARG_APP_ID).toBe('com.x')
  })
})

describe('buildStepShell — sh / ref (the only way to write shell text)', () => {
  it('renders every ref QUOTED and carries its value in env, never in the text', () => {
    const s = sh`xcrun devicectl --device ${ref('DEV', 'id$(x)')} ${ref('APP', 'a%OS%b')}`
    expect(s.posix).toBe('xcrun devicectl --device "$MODOKI_ARG_DEV" "$MODOKI_ARG_APP"')
    expect(s.win).toBe('xcrun devicectl --device "%MODOKI_ARG_DEV%" "%MODOKI_ARG_APP%"')
    expect(s.env).toEqual({ MODOKI_ARG_DEV: 'id$(x)', MODOKI_ARG_APP: 'a%OS%b' })
    expect(s.posix + s.win).not.toContain('$(x)')
  })

  it('a raw string cannot be interpolated — the old shape is a TYPE error', () => {
    const path = '/Users/x/My Game'
    // @ts-expect-error a string is not a ShellRef — the #1537 guard, checked by `npm run typecheck`
    const s = sh`open ${path}`
    expect(s).toBeDefined()
  })

  it('nested fragments splice text and merge env; one name bound to two values throws', () => {
    const inner = sh`echo ${ref('WHY', 'because')}`
    const outer = sh`${inner}; open ${ref('P', '/x')}`
    expect(outer.posix).toBe('echo "$MODOKI_ARG_WHY"; open "$MODOKI_ARG_P"')
    expect(outer.env).toEqual({ MODOKI_ARG_WHY: 'because', MODOKI_ARG_P: '/x' })
    expect(() => sh`${ref('A', '1')} ${ref('A', '2')}`).toThrow(/two different values/)
    expect(() => ref('lower', 'x')).toThrow(/UPPER_SNAKE/)
  })
})

/**
 * The round trips — each spawns a real bash or cmd.exe, because the defect is a property of how
 * those shells parse, and no pure test can observe it.
 */
describe('buildStepShell — hostile values survive a real spawn (#1537)', () => {
  // `%OS%` is defined on every Windows box and `$HOME` on every posix one, so an expansion is
  // always visible; the `$(…)` would create a file; `&` would start a second command.
  const HOSTILE = process.platform === 'win32'
    ? ['C:\\p\\%OS%\\a&echo INJ&b', 'x"&echo INJ&"y', '100% done', '']
    : ['/p/$(touch pwned)/a', '`touch pwned2`', '$HOME', 'a"b\'c', '']

  it('an exec step hands every hostile arg to the program byte-exact', async () => {
    const dir = makeScratchDir('modoki-exec-')
    try {
      fs.writeFileSync(path.join(dir, 'argv.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
      const r = await finish(spawnBuildStep(execStep('argv', dir, 'node', ['argv.js', ...HOSTILE]), process.env))
      expect(r.err).toBe('')
      expect(JSON.parse(r.out)).toEqual(HOSTILE)
      expect(fs.readdirSync(dir)).toEqual(['argv.js']) // no `pwned` file: nothing was evaluated
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a shell step prints a hostile ref literally — expanded once, never re-parsed', async () => {
    const dir = makeScratchDir('modoki-shell-')
    try {
      // A `"` is excluded on win32 because planBuildStep REFUSES it there (next test).
      for (const value of HOSTILE.filter((v) => v && !(process.platform === 'win32' && v.includes('"')))) {
        // node, not echo: cmd's echo would print the quotes too. The ref arrives as ONE argument.
        const script = sh`node -e "process.stdout.write(process.argv[1])" ${ref('V', value)}`
        const r = await finish(spawnBuildStep({ kind: 'shell', label: 's', cwd: dir, script }, process.env))
        expect({ value, out: r.out, err: r.err }).toEqual({ value, out: value, err: '' })
      }
      expect(fs.readdirSync(dir)).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('on win32 a ref holding a double quote is REFUSED — it would close cmd\'s quotes and free its `&`', () => {
    const step: ShellStep = { kind: 'shell', label: 'deploy', cwd: '/p', script: sh`echo ${ref('V', 'x"&echo INJ&"y')}` }
    expect(() => planBuildStep(step, {}, 'win32')).toThrow(/deploy.*MODOKI_ARG_V holds a double quote/)
    expect(() => planBuildStep(step, {}, 'darwin')).not.toThrow() // bash carries it inside "$X" fine
  })
})

describe('buildStepShell — winKillTreeArgs (the Windows tree kill)', () => {
  it('walks the tree (/T) and scopes BY PID, never by image name', () => {
    const args = winKillTreeArgs(4321)
    expect(args).toEqual(['/T', '/F', '/PID', '4321'])
    // /IM is the machine-wide form: it matches every process of that name, so on a machine
    // running several clones it would reap another clone's build. Same rule as winKillCommand.
    expect(args).not.toContain('/IM')
  })
})

/**
 * The #176 proof. This is an INTEGRATION test on purpose — the defect is a property of how
 * bash handles signals, and no amount of mocking `child_process` can observe it. It spawns
 * real processes and asserts on real pids, so it must stay cheap: two ~0.5s sleeps.
 *
 * ⚠️ The CONTROL case is the load-bearing half. Without it the "killed" assertion passes
 * vacuously on any machine where the grandchild never forms (or where the command is simple
 * enough that bash exec-replaces itself) — it would report success for a fix that does
 * nothing. So the first test PROVES the orphan exists under a plain `proc.kill()`, and only
 * then does the second prove the group kill closes it.
 */
describe.skipIf(process.platform === 'win32')('buildStepShell — killBuildProcess kills the whole group (#176)', () => {
  // Compound (`X=$(…) && { … }`) so bash FORKS instead of exec-replacing itself. A simple
  // `sleep 30` would have no grandchild at all and both cases below would trivially pass.
  const COMPOUND = 'X=$(echo hi) && { sleep 30 || true; }'
  const settle = () => new Promise((r) => setTimeout(r, 350))
  const childrenOf = (pid: number): number[] => {
    try { return execSync(`pgrep -P ${pid} || true`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number) } catch { return [] }
  }
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

  it('CONTROL: a plain proc.kill() signals only the shell, orphaning the real child', async () => {
    const proc = spawnShell(COMPOUND)
    await settle()
    const kids = childrenOf(proc.pid!)
    expect(kids.length, 'bash should have forked a grandchild for a compound command').toBeGreaterThan(0)

    proc.kill('SIGTERM') // the pre-#176 abort: one pid
    await settle()
    expect(kids.some(alive), 'the orphan this bug is about').toBe(true)

    for (const k of kids) { try { process.kill(k, 'SIGKILL') } catch { /* gone */ } }
  })

  it('killBuildProcess reaches the grandchild via the process group', async () => {
    const proc = spawnShell(COMPOUND)
    await settle()
    const kids = childrenOf(proc.pid!)
    expect(kids.length).toBeGreaterThan(0)

    killBuildProcess(proc)
    await settle()
    expect(kids.filter(alive), 'no survivors of the group kill').toEqual([])
  })

  it('escalates to SIGKILL when the tree IGNORES SIGTERM', async () => {
    // `trap "" TERM` installs SIG_IGN, which is INHERITED across fork+exec — so neither the
    // shell nor `sleep` can be killed by the SIGTERM. That is not a contrived shape: a build
    // tool holding a lock is exactly the thing that traps signals, and if the escalation were
    // broken the abort would silently leave the tree running forever while reporting success.
    //
    // ⚠️ COMPOUND, not a bare `sleep 30` — and that is a PORTABILITY fix, not a style choice.
    // bash 5 (ubuntu CI) exec-replaces itself with the last simple command of a `;` list, so
    // `trap "" TERM; sleep 30` left NO grandchild and the premise assertion below failed with
    // `expected 0 to be greater than 0`. bash 3.2 (macOS) lacks that optimization and forks,
    // which is why this was green on every Mac and red on `ci/main` only. A TERM trap does not
    // suppress the optimization — only EXIT/ERR traps do.
    const proc = spawnShell(`trap "" TERM; ${COMPOUND}`)
    await settle()
    const kids = childrenOf(proc.pid!)
    expect(kids.length).toBeGreaterThan(0)

    killBuildProcess(proc, { graceMs: 400 })
    // Mid-grace: SIGTERM has been sent and IGNORED. Asserting survival here is what proves the
    // second death below came from the escalation and not from the SIGTERM.
    // A fixed sleep on purpose (#1478): this one sits INSIDE the product's 400ms grace window, so it
    // is a bet on a product timer with 250ms of margin, not a wait for an event — polling would pass
    // on its first sample and prove nothing about the window.
    await new Promise((r) => setTimeout(r, 150))
    expect(kids.filter(alive), 'SIGTERM is ignored, so nothing should have died yet').toEqual(kids)

    // The escalation's deaths are an EVENT, so this polls (#1478). It used to sleep 700ms and bet the
    // SIGKILL and the reap both landed inside it. Survival mid-grace is already pinned above, so a
    // death that comes early cannot satisfy this falsely; a missing escalation times out red.
    await vi.waitFor(() => expect(kids.filter(alive), 'the SIGKILL escalation should have reaped the group').toEqual([]), { timeout: 5000, interval: 25 })
  })

  it('is a no-op on an already-exited child (never signals a REUSED pid/group)', async () => {
    const proc = spawnShell('true')
    await new Promise((r) => proc.once('close', r))
    expect(() => killBuildProcess(proc)).not.toThrow()
  })
})

/**
 * The Windows twin of the suite above (#182). It exists because the posix suite `skipIf`s
 * itself here, so before this the only Windows coverage was `winKillTreeArgs` — a pure argv
 * check that cannot see whether the tree actually dies.
 *
 * ⚠️ Windows is the WORSE case, and the shape differs enough that this is not a port:
 *
 *  - The command is SIMPLE (`ping`), not compound. On posix a simple command is the case bash
 *    exec-replaces away, so there is no grandchild and nothing to orphan — which is why #176
 *    was a three-step edge case there. Windows has no exec-replace: a shell step is
 *    `cmd.exe /d /s /c "<command>"`, and cmd.exe launches the tool as a child and waits — as does
 *    an exec step whose program is a `.cmd`/`.bat` (gradlew.bat, npx.cmd), via toSpawn.
 *  - The CONTROL asserts something the posix control cannot: `close` FIRES while the tool is
 *    still alive. `proc.kill()` does kill cmd.exe, so the step loop sees a completed step and
 *    frees the build slot while `gradlew`/`java` runs on — orphaned, holding no slot, free to
 *    race the retry. That is the hazard, not merely a leaked process.
 *  - There is no escalation twin. `taskkill /T /F` has no graceful form to escalate FROM
 *    (Node's `SIGTERM` on Windows is already a hard `TerminateProcess`), so the posix
 *    `trap "" TERM` test has no meaning here.
 *
 * Measured on a real Windows box before this was written: 4/4 runs, control survivors 4/4,
 * treatment survivors 0/4, parent dead in every control run.
 *
 * ⚠️ DO NOT re-await `close` in the CONTROL below (#184). The first version did, and it was
 * unsatisfiable BY CONSTRUCTION rather than merely flaky: the orphan inherits cmd.exe's stdio
 * pipes, so `close` cannot fire until the orphan is dead — the thing being asserted alive was
 * always already gone. It failed on `ci/main` twice (31287242205, 31287701127) with the tool
 * found and then missing, and cost two hypothesis-driven "fixes" from a Mac before a real box
 * measured it: `exit` at +6ms with the tool running, `close` at +27593ms with it dead. One of
 * those attempts is worth recording as DISPROVED, since it is the theory anyone re-reading this
 * will reach for first — "ping dies writing to a pipe node tore down" — redirecting its output
 * to `NUL` changed nothing, because stderr stays piped either way and the wait was never about
 * ping's writes at all.
 *
 * This suite RUNS on CI. A `&& !process.env.CI` gate was added at `dc66059e5` on the theory that
 * the runner reaps the tool before the assertions can see it — but the run history contradicts
 * that: with the gate absent, the suite ran on every `ci/main` run across that window and passed
 * on every green one, and a runner that reaped the tool would have failed the CONTROL (which
 * asserts the orphan is STILL ALIVE) on every single run, not intermittently. The real cause was
 * #184 above: the first CONTROL awaited `close`, which cannot fire until the orphan is dead, so
 * it was unsatisfiable by construction. `origin/win`'s repaired version (awaiting `exit` instead)
 * came in via merge `fda2dfbcc` and is what actually made the gate unnecessary. The gate was
 * briefly and mistakenly re-added under #847 on a belief that the merge had silently reverted it,
 * and removed again here once the run history above was checked. The one genuine residual is a
 * small flake at child discovery (a handful of failure runs since 2026-08-10, each a timeout on
 * `kids.length === 0` at the first CONTROL) — see the poll deadline below.
 */
describe.runIf(process.platform === 'win32')('buildStepShell — killBuildProcess kills the whole tree on Windows (#182)', () => {
  // A SIMPLE command on purpose — see the header. `ping -n 30` is the measured shape: it runs
  // long enough to observe and needs no shell builtins.
  const SIMPLE = 'ping -n 30 127.0.0.1'

  // The same PowerShell queries the #182 step-1 measurement used, so the test exercises the
  // mechanism through the same lens the manual run did.
  const ps = (script: string): string => {
    try { return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }) }
    catch { return '' }
  }
  const childrenOf = (pid: number): number[] =>
    ps(`Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object -ExpandProperty ProcessId`)
      .split(/\s+/).filter(Boolean).map(Number)
  // Batched into ONE powershell call: each invocation costs ~300-600ms, and polling per-pid
  // would dominate the test's runtime.
  /** Liveness is a SET question — "which of these are still up" — so give it a canonical order.
   *
   *  ⚠️ `Get-Process -Id a,b` does NOT promise to echo the input order, and a `toEqual` against
   *  the unsorted `kids` is therefore an ordering assertion nobody meant to write. It held for
   *  weeks and then reddened the whole gate under full-suite load with the same two PIDs
   *  transposed (`[24516, 3432]` vs `[3432, 24516]`) — a false red in the one lane that runs this
   *  file at all. Sorting here and at the comparison keeps membership exact while dropping the
   *  order, which is the property the callers actually assert. */
  const byId = (pids: number[]): number[] => [...pids].sort((a, b) => a - b)
  const alivePids = (pids: number[]): number[] => {
    if (pids.length === 0) return []
    return byId(ps(`Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`)
      .split(/\s+/).filter(Boolean).map(Number))
  }
  const poll = async <T,>(fn: () => T, done: (v: T) => boolean, deadlineMs: number): Promise<T> => {
    const stop = Date.now() + deadlineMs
    let v = fn()
    while (!done(v) && Date.now() < stop) {
      await new Promise((r) => setTimeout(r, 250))
      v = fn()
    }
    return v
  }

  // Every spawned tool pid, so a failing assertion cannot leave a 30s ping running.
  const spawned: number[] = []
  afterEach(() => {
    for (const p of alivePids(spawned)) {
      try { execFileSync('taskkill', ['/F', '/PID', String(p)], { stdio: 'ignore' }) } catch { /* gone */ }
    }
    spawned.length = 0
  })

  const spawnAndFindTool = async (): Promise<{ proc: ReturnType<typeof spawnBuildStep>; kids: number[] }> => {
    // A SHELL step, so cmd.exe sits between us and the tool — the tree this suite is about.
    const proc = spawnShell(SIMPLE)
    // Each `childrenOf` call is a PowerShell CIM query costing ~1-3s (docs/windows.md), so a 5s
    // deadline allowed only 2-3 samples — the observed cause of the child-discovery flake above.
    // The tool runs `ping -n 30`, so 15s is still well inside its window. NOT verified on
    // Windows from this machine.
    const kids = await poll(() => childrenOf(proc.pid!), (k) => k.length > 0, 15000)
    spawned.push(...kids)
    return { proc, kids }
  }

  // Timeout raised 30_000 → 60_000 on every test in this suite: child discovery above can spend
  // up to 15s (poll deadline) plus a slow PowerShell CIM call, and the liveness poll elsewhere in
  // this file can spend up to 8s plus another slow call — leaving no headroom under a 30s vitest
  // timeout, so a slow-but-correct discovery failed as an unattributed bare timeout instead of a
  // readable assertion.
  it('CONTROL: a plain proc.kill() kills only cmd.exe, orphaning the tool underneath', async () => {
    const { proc, kids } = await spawnAndFindTool()
    expect(kids.length, 'cmd.exe should have launched PING.EXE as a child').toBeGreaterThan(0)

    // `exit` — NOT `close`. `exit` fires when cmd.exe itself dies, which is the moment that proves
    // the signal landed on the shell and not on the tool. (This assertion was originally written
    // against `close` and was unsatisfiable by construction: the orphan INHERITS the stdio pipes,
    // so `close` cannot fire until the orphan is dead, and the thing being asserted alive was
    // therefore always gone. See the sibling test below, which pins that half. #184)
    const exited = new Promise<void>((r) => proc.once('exit', () => r()))
    proc.kill() // the pre-#176 abort: signal the pid we spawned
    await exited

    expect(alivePids(kids), 'the orphan this bug is about — still running after `exit`').toEqual(byId(kids))
  }, 60_000)

  it('CONTROL: `close` is DEFERRED until the orphan dies, because it inherited the stdio pipes', async () => {
    // The other half of the hazard, and the one that says what the pre-#176 symptom actually WAS.
    // The step loop resolves a step on `proc.on('close')` (vite-asset-scanner.ts), and the orphan
    // holds those pipes open — so an aborted build did not free the slot early and race a retry
    // (the original framing). It HUNG, holding the slot for the tool's full natural runtime.
    //
    // We CHOOSE when the orphan dies rather than waiting out a fixed `ping -n N`. That makes the
    // causal claim exact — `close` fires because the orphan died, not merely after it — and it
    // removes the timing race: an earlier version asserted the exit->close gap exceeded a
    // threshold, which held in isolation and failed at 871ms under full-suite load, because the
    // gap was really just "however much of the ping was left after child discovery".
    const { proc, kids } = await spawnAndFindTool()
    expect(kids.length).toBeGreaterThan(0)

    let closeFired = false
    const closed = new Promise<void>((r) => { proc.once('close', () => { closeFired = true; r() }) })
    const exited = new Promise<void>((r) => proc.once('exit', () => r()))

    proc.kill()
    await exited
    await new Promise((r) => setTimeout(r, 750))

    // The load-bearing assertion: cmd.exe is gone, yet `close` has NOT fired — because the orphan
    // still holds the pipes. This is the step loop being left hanging.
    expect(alivePids(kids), 'the orphan is still running').toEqual(byId(kids))
    expect(closeFired, '`close` must NOT fire while the orphan holds the inherited pipes').toBe(false)

    // Now kill the orphan — and only now can `close` arrive.
    for (const k of kids) { try { execFileSync('taskkill', ['/F', '/PID', String(k)], { stdio: 'ignore' }) } catch { /* gone */ } }
    await closed
    expect(closeFired).toBe(true)
  }, 60_000)

  it('killBuildProcess reaches the tool via taskkill /T', async () => {
    const { proc, kids } = await spawnAndFindTool()
    expect(kids.length).toBeGreaterThan(0)

    killBuildProcess(proc)
    // The win32 path is an ASYNC `execFile('taskkill', …)`, so poll rather than sleep a guess.
    const survivors = await poll(() => alivePids(kids), (s) => s.length === 0, 8000)
    expect(survivors, 'no survivors of the tree kill').toEqual([])
  }, 60_000)

  it('is a no-op on an already-exited child (never taskkills a REUSED pid)', async () => {
    const proc = spawnShell('exit 0')
    await new Promise((r) => proc.once('close', r))
    expect(() => killBuildProcess(proc)).not.toThrow()
  }, 60_000)

  it('killBuildProcessSync reaps the tree from the `exit` hook — the path that used to skip win32 (#185)', async () => {
    // `ping` is the deliberate stand-in, not a convenience. The shutdown hole hid because every
    // real step is a node process that dies of EPIPE when the backend's pipe breaks; `ping` and a
    // gradle JVM both IGNORE that failed write, so they are the cell that actually orphans.
    // Measured on the win box: two `gradlew --no-daemon` JVMs outlived a hard-killed parent by
    // 60s+, and `taskkill /T` cleared the same tree in 1s.
    const { proc, kids } = await spawnAndFindTool()
    expect(kids.length).toBeGreaterThan(0)

    killBuildProcessSync(proc)

    // ⚠️ Poll, do NOT assert immediately. What is synchronous here is ISSUING the kill — which is
    // the whole contract an `exit` handler needs, since it cannot await an execFile. The OS reap is
    // not: `taskkill /F` calls TerminateProcess, which *initiates* termination and returns, so the
    // target can still appear in Get-Process for a few ms afterwards. An earlier draft asserted
    // `toEqual([])` on the next line; it passed in isolation and was a load-dependent flake of
    // exactly the kind this suite already hit at 871ms.
    const survivors = await poll(() => alivePids(kids), (s) => s.length === 0, 8000)
    expect(survivors, 'the sync kill reaps the whole tree').toEqual([])
  }, 60_000)

  it('killBuildProcessSync is a no-op on an already-exited child', async () => {
    const proc = spawnShell('exit 0')
    await new Promise((r) => proc.once('close', r))
    expect(() => killBuildProcessSync(proc)).not.toThrow()
  }, 60_000)
})
