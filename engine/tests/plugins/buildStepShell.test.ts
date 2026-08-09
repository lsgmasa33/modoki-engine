import { describe, it, expect, afterEach } from 'vitest'
import { execSync, execFileSync } from 'node:child_process'
import { resolveBuildStep, spawnBuildCommand, killBuildProcess, killBuildProcessSync, winKillTreeArgs, type BuildStep } from '../../plugins/buildStepShell'

/**
 * Guards the W-6 cross-platform build-step branching WITHOUT spawning anything — the
 * pure `resolveBuildStep` decides which command string + env a step runs with on each
 * platform. (The actual spawn — bash on posix, cmd.exe on Windows — is covered by the two
 * integration suites at the bottom of this file, one per platform.)
 */
describe('buildStepShell — resolveBuildStep (platform branching)', () => {
  const baseEnv = { PATH: '/usr/bin', MODOKI_NODE: '/tc/node' } as NodeJS.ProcessEnv

  it('uses the posix `cmd` on darwin/linux even when a winCmd exists', () => {
    const step: BuildStep = { label: 'gradle', cmd: 'android/gradlew assembleDebug', winCmd: 'android\\gradlew.bat assembleDebug', cwd: '/p' }
    expect(resolveBuildStep(step, baseEnv, 'darwin').cmd).toBe('android/gradlew assembleDebug')
    expect(resolveBuildStep(step, baseEnv, 'linux').cmd).toBe('android/gradlew assembleDebug')
  })

  it('uses `winCmd` on win32 when present', () => {
    const step: BuildStep = { label: 'gradle', cmd: 'android/gradlew assembleDebug', winCmd: 'android\\gradlew.bat assembleDebug', cwd: '/p' }
    expect(resolveBuildStep(step, baseEnv, 'win32').cmd).toBe('android\\gradlew.bat assembleDebug')
  })

  it('falls back to `cmd` on win32 when there is no winCmd (pure program+args steps)', () => {
    const step: BuildStep = { label: 'sync', cmd: 'npx cap sync android', cwd: '/p' }
    expect(resolveBuildStep(step, baseEnv, 'win32').cmd).toBe('npx cap sync android')
  })

  it('merges the step env OVER the shared build env (replaces bash export/FOO=bar prefixes)', () => {
    const step: BuildStep = { label: 'apk', cmd: 'android/gradlew assembleDebug', env: { JAVA_HOME: '/jdk21', ANDROID_HOME: '/sdk' }, cwd: '/p' }
    const { env } = resolveBuildStep(step, baseEnv, 'win32')
    expect(env.JAVA_HOME).toBe('/jdk21')
    expect(env.ANDROID_HOME).toBe('/sdk')
    expect(env.PATH).toBe('/usr/bin') // shared env preserved
    expect(env.MODOKI_NODE).toBe('/tc/node')
  })

  it('returns the shared env unchanged (same ref) when the step has no env', () => {
    const step: BuildStep = { label: 'build', cmd: 'npm run build', cwd: '/p' }
    expect(resolveBuildStep(step, baseEnv, 'darwin').env).toBe(baseEnv)
  })

  it('step env overrides a shared-env key of the same name', () => {
    const step: BuildStep = { label: 'web', cmd: 'npm run build', env: { BASE_PATH: '/demo', VITE_GAME_ONLY: 'true' }, cwd: '/p' }
    const merged = { ...baseEnv, BASE_PATH: '/old' } as NodeJS.ProcessEnv
    const { env } = resolveBuildStep(step, merged, 'win32')
    expect(env.BASE_PATH).toBe('/demo')
    expect(env.VITE_GAME_ONLY).toBe('true')
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
    const proc = spawnBuildCommand(COMPOUND, { cwd: process.cwd(), env: process.env })
    await settle()
    const kids = childrenOf(proc.pid!)
    expect(kids.length, 'bash should have forked a grandchild for a compound command').toBeGreaterThan(0)

    proc.kill('SIGTERM') // the pre-#176 abort: one pid
    await settle()
    expect(kids.some(alive), 'the orphan this bug is about').toBe(true)

    for (const k of kids) { try { process.kill(k, 'SIGKILL') } catch { /* gone */ } }
  })

  it('killBuildProcess reaches the grandchild via the process group', async () => {
    const proc = spawnBuildCommand(COMPOUND, { cwd: process.cwd(), env: process.env })
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
    const proc = spawnBuildCommand(`trap "" TERM; ${COMPOUND}`, { cwd: process.cwd(), env: process.env })
    await settle()
    const kids = childrenOf(proc.pid!)
    expect(kids.length).toBeGreaterThan(0)

    killBuildProcess(proc, { graceMs: 400 })
    // Mid-grace: SIGTERM has been sent and IGNORED. Asserting survival here is what proves the
    // second death below came from the escalation and not from the SIGTERM.
    await new Promise((r) => setTimeout(r, 150))
    expect(kids.filter(alive), 'SIGTERM is ignored, so nothing should have died yet').toEqual(kids)

    await new Promise((r) => setTimeout(r, 700))
    expect(kids.filter(alive), 'the SIGKILL escalation should have reaped the group').toEqual([])
  })

  it('is a no-op on an already-exited child (never signals a REUSED pid/group)', async () => {
    const proc = spawnBuildCommand('true', { cwd: process.cwd(), env: process.env })
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
 *    was a three-step edge case there. Windows has no exec-replace: `spawn(cmd, {shell:true})`
 *    is `cmd.exe /d /s /c "<command>"`, and cmd.exe launches the tool as a child and waits.
 *    So EVERY step has the extra layer, simple or not.
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
  const alivePids = (pids: number[]): number[] => {
    if (pids.length === 0) return []
    return ps(`Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`)
      .split(/\s+/).filter(Boolean).map(Number)
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

  const spawnAndFindTool = async (): Promise<{ proc: ReturnType<typeof spawnBuildCommand>; kids: number[] }> => {
    const proc = spawnBuildCommand(SIMPLE, { cwd: process.cwd(), env: process.env })
    const kids = await poll(() => childrenOf(proc.pid!), (k) => k.length > 0, 5000)
    spawned.push(...kids)
    return { proc, kids }
  }

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

    expect(alivePids(kids), 'the orphan this bug is about — still running after `exit`').toEqual(kids)
  }, 30_000)

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
    expect(alivePids(kids), 'the orphan is still running').toEqual(kids)
    expect(closeFired, '`close` must NOT fire while the orphan holds the inherited pipes').toBe(false)

    // Now kill the orphan — and only now can `close` arrive.
    for (const k of kids) { try { execFileSync('taskkill', ['/F', '/PID', String(k)], { stdio: 'ignore' }) } catch { /* gone */ } }
    await closed
    expect(closeFired).toBe(true)
  }, 30_000)

  it('killBuildProcess reaches the tool via taskkill /T', async () => {
    const { proc, kids } = await spawnAndFindTool()
    expect(kids.length).toBeGreaterThan(0)

    killBuildProcess(proc)
    // The win32 path is an ASYNC `execFile('taskkill', …)`, so poll rather than sleep a guess.
    const survivors = await poll(() => alivePids(kids), (s) => s.length === 0, 8000)
    expect(survivors, 'no survivors of the tree kill').toEqual([])
  }, 30_000)

  it('is a no-op on an already-exited child (never taskkills a REUSED pid)', async () => {
    const proc = spawnBuildCommand('exit 0', { cwd: process.cwd(), env: process.env })
    await new Promise((r) => proc.once('close', r))
    expect(() => killBuildProcess(proc)).not.toThrow()
  }, 30_000)

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
  }, 30_000)

  it('killBuildProcessSync is a no-op on an already-exited child', async () => {
    const proc = spawnBuildCommand('exit 0', { cwd: process.cwd(), env: process.env })
    await new Promise((r) => proc.once('close', r))
    expect(() => killBuildProcessSync(proc)).not.toThrow()
  }, 30_000)
})
