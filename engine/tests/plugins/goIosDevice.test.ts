import { describe, it, expect } from 'vitest'
import { pickHostSidePlatform, pickGoIosDevice, leaseForIosOps, type GoIosDevice } from '../../plugins/backend/goIosDevice'

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

  // This used to assert the junk was IGNORED — falling through to the lease. Not trusting it was
  // right; ignoring it was the same wrong-device answer this function exists to refuse: a caller who
  // NAMED a platform (`'andriod'`) was answered about whatever the lease or the cable said instead,
  // with no hint its ask had been dropped. #1072's close-out sweep found it; the curl API reaches it
  // (the MCP tools enum-validate `platform`).
  it('REFUSES a junk `explicit` — neither trusting it nor silently falling through to the lease', () => {
    const got = pickHostSidePlatform({ explicit: 'windows-phone', leased: 'android', iphones: [], androids: ['S'] })
    expect(got).toHaveProperty('error')
    expect(String((got as { error: string }).error)).toContain('windows-phone')
  })

  it('an EMPTY or NULL explicit is "not given", not junk', () => {
    expect(pickHostSidePlatform({ explicit: '', leased: 'android', iphones: [], androids: ['S'] })).toBe('android')
    // A JSON body can carry `platform: null` — the curl API reaches this with it.
    expect(pickHostSidePlatform({ explicit: null as unknown as string, leased: 'android', iphones: [], androids: ['S'] })).toBe('android')
  })
})

/**
 * WHICH DEVICE a go-ios op reads, once the platform is already iOS. Pure, so the whole table is
 * testable with no hardware — the same shape as `pickHostSidePlatform` above.
 */
describe('goIosDevice — pickGoIosDevice', () => {
  const phone = (udid: string, productType?: string, name?: string): GoIosDevice =>
    (productType === undefined ? { udid } : { udid, productType, name: name ?? productType })

  it('#670 regression: one attached iPhone, lease reports a DIFFERENT model — refuses rather than reading the wrong phone', () => {
    // Before the fix, resolveGoIosDevice took the single-device shortcut before ever consulting
    // the lease, so this case silently returned the wrong phone, labelled as if it were correct.
    const got = pickGoIosDevice({
      devices: [phone('UDID1', 'iPhone10,1', 'Attached Phone')],
      lease: { deviceModel: 'iPhone14,5', osVersion: '17.0' },
    })
    expect(got).toHaveProperty('error')
    const msg = String((got as { error: string }).error)
    expect(msg).toContain('iPhone14,5')
    expect(msg).toContain('UDID1')
  })

  it('one attached iPhone, lease model MATCHES — returns it with no `unverified`', () => {
    const got = pickGoIosDevice({
      devices: [phone('UDID1', 'iPhone14,5')],
      lease: { deviceModel: 'iPhone14,5', osVersion: '17.0' },
    })
    expect(got).toEqual({ device: { udid: 'UDID1', productType: 'iPhone14,5', name: 'iPhone14,5' } })
    expect(got).not.toHaveProperty('unverified')
  })

  it('one attached iPhone, no lease at all — returns it with no `unverified` (the common path stays quiet)', () => {
    const got = pickGoIosDevice({ devices: [{ udid: 'UDID1' }] })
    expect(got).toEqual({ device: { udid: 'UDID1' } })
    expect(got).not.toHaveProperty('unverified')
  })

  it('one attached iPhone, lease present but reports no hardware (deviceModel: null) — degrades with `unverified`', () => {
    const got = pickGoIosDevice({
      devices: [{ udid: 'UDID1' }],
      lease: { deviceModel: null, osVersion: null },
    })
    expect(got).toMatchObject({ device: { udid: 'UDID1' } })
    expect((got as { unverified?: string }).unverified).toBeTruthy()
  })

  it('one attached iPhone with NO productType (the info probe failed), lease model set — degrades rather than refuses', () => {
    const got = pickGoIosDevice({
      devices: [{ udid: 'UDID1' }],
      lease: { deviceModel: 'iPhone14,5', osVersion: '17.0' },
    })
    expect(got).toMatchObject({ device: { udid: 'UDID1' } })
    expect((got as { unverified?: string }).unverified).toBeTruthy()
  })

  it('several attached, exactly one confirms the lease — that one, no `unverified`', () => {
    const got = pickGoIosDevice({
      devices: [phone('UDID1', 'iPhone10,1'), phone('UDID2', 'iPhone14,5')],
      lease: { deviceModel: 'iPhone14,5', osVersion: '17.0' },
    })
    expect(got).toMatchObject({ device: { udid: 'UDID2' } })
    expect(got).not.toHaveProperty('unverified')
  })

  it('several attached, all identified, none confirms the lease — refuses, naming the lease model and every attached device', () => {
    const got = pickGoIosDevice({
      devices: [phone('UDID1', 'iPhone10,1', 'Old Phone'), phone('UDID2', 'iPhone12,1', 'Other Phone')],
      lease: { deviceModel: 'iPhone14,5', osVersion: '17.0' },
    })
    expect(got).toHaveProperty('error')
    const msg = String((got as { error: string }).error)
    expect(msg).toContain('iPhone14,5')
    expect(msg).toContain('UDID1')
    expect(msg).toContain('UDID2')
  })

  it('several attached, more than one confirms the lease — refuses, naming both udids', () => {
    const got = pickGoIosDevice({
      devices: [phone('UDID1', 'iPhone14,5', 'Phone A'), phone('UDID2', 'iPhone14,5', 'Phone B')],
      lease: { deviceModel: 'iPhone14,5', osVersion: '17.0' },
    })
    expect(got).toHaveProperty('error')
    const msg = String((got as { error: string }).error)
    expect(msg).toContain('UDID1')
    expect(msg).toContain('UDID2')
  })

  it('several attached, all UNIDENTIFIED — refuses rather than degrading (a degrade is only correct for exactly one)', () => {
    const got = pickGoIosDevice({
      devices: [{ udid: 'UDID1' }, { udid: 'UDID2' }],
      lease: { deviceModel: 'iPhone14,5', osVersion: '17.0' },
    })
    expect(got).toHaveProperty('error')
    expect(String((got as { error: string }).error)).toContain('iPhone14,5')
  })

  it('pin present and attached — wins over a contradicting lease', () => {
    const got = pickGoIosDevice({
      pinned: 'UDID1',
      devices: [phone('UDID1', 'iPhone10,1'), phone('UDID2', 'iPhone14,5')],
      lease: { deviceModel: 'iPhone14,5', osVersion: '17.0' },
    })
    expect(got).toMatchObject({ device: { udid: 'UDID1' } })
  })

  it('pin present and not attached — errors', () => {
    const got = pickGoIosDevice({ pinned: 'UDID9', devices: [phone('UDID1', 'iPhone10,1')] })
    expect(got).toHaveProperty('error')
    expect(String((got as { error: string }).error)).toContain('UDID9')
  })

  it('no device attached at all — errors', () => {
    const got = pickGoIosDevice({ devices: [] })
    expect(got).toHaveProperty('error')
  })

  it('several attached, no lease — ambiguous, errors', () => {
    const got = pickGoIosDevice({ devices: [phone('UDID1', 'iPhone10,1'), phone('UDID2', 'iPhone14,5')] })
    expect(got).toHaveProperty('error')
  })
})

// #670 finding 3: `deviceConnection.deviceHardware()` is platform-agnostic, so the router must
// filter its hardware by the lease's PLATFORM before handing it to `pickGoIosDevice` — an Android
// lease's `deviceModel` (e.g. 'SM-S901B') can never match an attached iPhone's `ProductType`, so
// it read as a genuine mismatch and refused about a device that was attached, just on Android.
describe('goIosDevice — a USB lease names its device by UDID (#1065)', () => {
  const devices: GoIosDevice[] = [
    { udid: 'UDID-A', productType: 'iPhone10,1' },
    { udid: 'UDID-B', productType: 'iPhone10,1' },
  ]

  it('picks the leased UDID outright — two phones of the same model are no longer ambiguous', () => {
    expect(pickGoIosDevice({ devices, lease: { deviceModel: 'iPhone10,1', osVersion: null }, leaseUdid: 'UDID-B' }))
      .toEqual({ device: devices[1] })
  })

  it('refuses when the leased UDID is not attached — never another phone', () => {
    const r = pickGoIosDevice({ devices, leaseUdid: 'UDID-GONE' })
    expect((r as { error: string }).error).toMatch(/USB lease's device UDID-GONE is not attached/)
  })

  it('an explicit MODOKI_IOS_DEVICE_UDID pin still wins, as it does over the lease model', () => {
    expect(pickGoIosDevice({ pinned: 'UDID-A', devices, leaseUdid: 'UDID-B' })).toEqual({ device: devices[0] })
  })
})

describe('goIosDevice — leaseForIosOps (#670 finding 3)', () => {
  const hardware = { deviceModel: 'iPhone14,5', osVersion: '17.0' }

  it('iOS lease — hardware is passed through', () => {
    expect(leaseForIosOps('ios', hardware)).toEqual(hardware)
  })

  it('Android lease — hardware is withheld (undefined), not handed to the iOS resolver', () => {
    expect(leaseForIosOps('android', hardware)).toBeUndefined()
  })

  it('null platform (unresolved/older bridge) — withheld, "not confirmed iOS" is never "assume iOS"', () => {
    expect(leaseForIosOps(null, hardware)).toBeUndefined()
  })

  it('undefined platform (no lease at all) — withheld', () => {
    expect(leaseForIosOps(undefined, hardware)).toBeUndefined()
  })
})
