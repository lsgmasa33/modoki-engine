import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { resolveBuildStep, spawnBuildCommand, killBuildProcess, winKillTreeArgs, type BuildStep } from '../../plugins/buildStepShell'

/**
 * Guards the W-6 cross-platform build-step branching WITHOUT spawning anything — the
 * pure `resolveBuildStep` decides which command string + env a step runs with on each
 * platform. (The actual spawn — bash on posix, cmd.exe on Windows — is validated on a
 * real Windows box; see the plan's Phase W checklist.)
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
    const proc = spawnBuildCommand('trap "" TERM; sleep 30', { cwd: process.cwd(), env: process.env })
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
