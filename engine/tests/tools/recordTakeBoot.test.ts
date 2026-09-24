import { describe, it, expect } from 'vitest'
import { bootWithReloadRetry, failedAttemptReloaded, MAX_BOOT_ATTEMPTS, pageReloaded } from '../../scripts/recordTakeBoot.mjs'

/**
 * #1518 — the gameplay recorder's boot survives a page reload. The first render after a dependency
 * change died with `Execution context was destroyed`: Vite re-optimised mid-boot and reloaded the page
 * the boot loop was driving. The browser half (a fresh context per attempt, `framenavigated` counting)
 * is verified live on a cold Vite cache — see docs/gameplay-recorder.md; this pins the POLICY.
 */
type Outcome = { reloaded: boolean; value: string } | { reloaded: boolean; error: unknown }

/** An `attempt` that plays back one scripted outcome per call, and records what was discarded. */
function scripted(outcomes: Outcome[]) {
  const discarded: Outcome[] = []
  const reported: number[] = []
  let calls = 0
  const attempt = async () => outcomes[calls++]
  return {
    run: () => bootWithReloadRetry(attempt, {
      discard: async (o) => { discarded.push(o) },
      onReload: (n) => { reported.push(n) },
    }),
    discarded, reported, calls: () => calls,
  }
}

describe('bootWithReloadRetry (#1518)', () => {
  it('a clean boot returns its value with no reloads, and discards nothing', async () => {
    const s = scripted([{ reloaded: false, value: 'page' }])
    await expect(s.run()).resolves.toEqual({ value: 'page', reloads: 0 })
    expect(s.calls()).toBe(1)
    expect(s.discarded).toEqual([])
  })

  it('an attempt that threw after a reload is discarded and booted again', async () => {
    const destroyed = { reloaded: true, error: new Error('page.evaluate: Execution context was destroyed') }
    const s = scripted([destroyed, { reloaded: false, value: 'second page' }])
    await expect(s.run()).resolves.toEqual({ value: 'second page', reloads: 1 })
    expect(s.discarded).toEqual([destroyed])
    expect(s.reported).toEqual([1])
  })

  // The reload landed between two evaluates and the boot finished in the SECOND document — on top of
  // the first one's localStorage writes. Accepting it would render from state the take never had.
  it('an attempt that SUCCEEDED after a reload is discarded too', async () => {
    const tainted = { reloaded: true, value: 'booted on a reloaded page' }
    const s = scripted([tainted, { reloaded: false, value: 'clean page' }])
    await expect(s.run()).resolves.toEqual({ value: 'clean page', reloads: 1 })
    expect(s.discarded).toEqual([tainted])
  })

  it('an error with no reload behind it is the game failing, and is thrown without a retry', async () => {
    const failure = new Error('game did not finish loading')
    const s = scripted([{ reloaded: false, error: failure }, { reloaded: false, value: 'never reached' }])
    await expect(s.run()).rejects.toBe(failure)
    expect(s.calls()).toBe(1)
  })

  it('a page that reloads on every attempt fails after the cap, naming the last cause', async () => {
    const outcomes = Array.from({ length: MAX_BOOT_ATTEMPTS + 1 }, () =>
      ({ reloaded: true, error: new Error('Execution context was destroyed') }))
    const s = scripted(outcomes)
    await expect(s.run()).rejects.toThrow(`reloaded during boot on all ${MAX_BOOT_ATTEMPTS} attempts: Execution context was destroyed`)
    expect(s.calls()).toBe(MAX_BOOT_ATTEMPTS)
    // Every attempt's context is closed, the last one included.
    expect(s.discarded).toHaveLength(MAX_BOOT_ATTEMPTS)
    expect(s.reported).toEqual(Array.from({ length: MAX_BOOT_ATTEMPTS - 1 }, (_, i) => i + 1))
  })
})

describe('pageReloaded (#1518)', () => {
  // The live case: the Vite reload's evaluate rejects BEFORE its `framenavigated` arrives, so the count
  // is still 1 (the goto). Measured — a counter-only check let the render die exactly as before.
  it('an execution context destroyed by a navigation is a reload even before the navigation is counted', () => {
    expect(pageReloaded(1, new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'))).toBe(true)
  })

  it('a second main-frame navigation is a reload even when nothing threw', () => {
    expect(pageReloaded(2)).toBe(true)
  })

  // A reload before `load` interrupts the goto itself, with Playwright's goto wording.
  it('a goto cut off by a second navigation is a reload', () => {
    expect(pageReloaded(1, new Error('page.goto: Navigation to "http://x/" is interrupted by another navigation to "http://x/"'))).toBe(true)
    expect(pageReloaded(1, new Error('page.goto: net::ERR_ABORTED at http://x/'))).toBe(true)
  })

  it('the goto alone, with or without an unrelated error, is not a reload', () => {
    expect(pageReloaded(1)).toBe(false)
    expect(pageReloaded(1, new Error('game did not finish loading'))).toBe(false)
    expect(pageReloaded(1, 'not an Error')).toBe(false)
  })
})

describe('failedAttemptReloaded (#1518) — how bootAttempt classifies a failed attempt', () => {
  const destroyed = new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation')

  // The live Vite reload: the error arrives before the second navigation is counted. Classing on the
  // counter alone let the render die exactly as before — measured on a cold cache.
  it('a destroyed context with only the goto counted is a reload', () => {
    expect(failedAttemptReloaded({ navigations: 1, error: destroyed, cancelling: false })).toBe(true)
  })

  it('a second navigation behind any error is a reload', () => {
    expect(failedAttemptReloaded({ navigations: 2, error: new Error('Target closed'), cancelling: false })).toBe(true)
  })

  // `cancel` closes the browser under the attempt; that error must end the render, not start another boot.
  it('nothing is a reload while cancelling', () => {
    expect(failedAttemptReloaded({ navigations: 2, error: destroyed, cancelling: true })).toBe(false)
  })

  it('an unrelated error with only the goto counted is the game failing', () => {
    expect(failedAttemptReloaded({ navigations: 1, error: new Error('game did not finish loading'), cancelling: false })).toBe(false)
  })
})
