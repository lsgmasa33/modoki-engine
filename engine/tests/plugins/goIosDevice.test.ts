import { describe, it, expect } from 'vitest'
import { pickHostSidePlatform } from '../../plugins/backend/goIosDevice'

/**
 * WHICH PLATFORM a host-side op reads. Pure, so the whole decision table is testable with no
 * hardware — the same shape as `planIosInstall`, and for the same reason: this decision must not
 * be able to drift between the two routes that consume it.
 */
describe('goIosDevice — pickHostSidePlatform', () => {
  it('REFUSES when both kinds are attached and no lease says which', () => {
    // REGRESSION (close-out review), and MEASURED before the fix: with an iPhone and three Androids
    // attached and no lease, `device_crash_reports` silently answered about the IPHONE — right-
    // looking payload, wrong device, no hint a choice was made. #149 refuses an ambiguous adb
    // serial for exactly this reason; this is that rule binding the platform.
    const got = pickHostSidePlatform({ iphones: ['UDID1'], androids: ['SERIAL1'] })
    expect(got).toHaveProperty('error')
    expect(String((got as { error: string }).error)).toContain('UDID1')
    expect(String((got as { error: string }).error)).toContain('SERIAL1')
  })

  it('an explicit platform wins over everything, including a contradicting lease', () => {
    expect(pickHostSidePlatform({ explicit: 'android', leased: 'ios', iphones: ['U'], androids: ['S'] })).toBe('android')
  })

  it('the lease wins when there is no explicit ask', () => {
    expect(pickHostSidePlatform({ leased: 'ios', iphones: ['U'], androids: ['S'] })).toBe('ios')
  })

  it('falls back to what is ATTACHED when nothing else says — either way round', () => {
    // The motivating case: these ops exist for when the app has DIED, so the lease is gone and
    // cannot answer. An unambiguous room is still an answer.
    expect(pickHostSidePlatform({ iphones: ['U'], androids: [] })).toBe('ios')
    expect(pickHostSidePlatform({ iphones: [], androids: ['S'] })).toBe('android')
  })

  it('says nothing is attached rather than picking a platform with no device on it', () => {
    const got = pickHostSidePlatform({ iphones: [], androids: [] })
    expect(got).toHaveProperty('error')
    expect(String((got as { error: string }).error)).toMatch(/no device is attached/)
  })

  it('ignores a junk `explicit` instead of trusting it', () => {
    expect(pickHostSidePlatform({ explicit: 'windows-phone', leased: 'android', iphones: [], androids: ['S'] })).toBe('android')
  })
})
