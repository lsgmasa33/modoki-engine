import { describe, it, expect } from 'vitest'
import { resolveBuildStep, type BuildStep } from '../../plugins/buildStepShell'

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
