import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseCrashReportName, filterCrashReports, summarizeCrashReport, fetchCrashReport, IOS_PAGE_BYTES,
} from '../../plugins/backend/deviceCrashReports'

/**
 * The `.ips` summariser, against REAL reports pulled off an iPhone 8 / iOS 16.7.16 and trimmed to
 * the fields the parser reads. Real captures rather than hand-written JSON on purpose: the whole
 * risk in this feature is being wrong about Apple's shape, and a fixture I invented would agree
 * with my mistake. The device identifiers are scrubbed (`crashReporterKey` is per-DEVICE — Apple
 * derives it from the UDID — so it is #103 class and must not reach the OSS snapshot).
 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/crash-reports')
const load = (n: string) => fs.readFileSync(path.join(FIXTURES, n), 'utf8')

describe('deviceCrashReports — parseCrashReportName', () => {
  it('splits process and time out of the filename, so a listing needs no fetch', () => {
    expect(parseCrashReportName('App.wakeups_resource-2026-08-13-102720.ips'))
      .toEqual({ name: 'App.wakeups_resource-2026-08-13-102720.ips', when: '2026-08-13 10:27:20', process: 'App' })
  })

  it('treats a device-wide jetsam as its own "process"', () => {
    expect(parseCrashReportName('JetsamEvent-2026-08-07-133543.ips').process).toBe('JetsamEvent')
  })

  it('survives a name it cannot parse rather than throwing', () => {
    expect(parseCrashReportName('ota_patch.txt').when).toBeNull()
  })
})

describe('deviceCrashReports — fetchCrashReport name validation', () => {
  it('REFUSES a name that would be read as a CLI flag', async () => {
    // REGRESSION (close-out review): the pattern allowed a leading dash. `execFile` passes an argv
    // array so there is no shell to inject into, but `crash cp` parses its own flags — `--udid`
    // as a report name would be eaten as one, acting on something other than the named report.
    await expect(fetchCrashReport({ udid: 'x', name: '--udid', goIos: '/bin/true' }))
      .rejects.toThrow(/invalid crash report name/)
    await expect(fetchCrashReport({ udid: 'x', name: '../../etc/passwd', goIos: '/bin/true' }))
      .rejects.toThrow(/invalid crash report name/)
  })
})

describe('deviceCrashReports — filterCrashReports', () => {
  const names = [
    'App-2026-08-10-090000.ips',
    'App.wakeups_resource-2026-08-13-102720.ips',
    'SiriSearchFeedback-2026-08-13-095111.ips',
    'JetsamEvent-2026-08-07-133543.ips',
    'ota_patch.txt',
  ]

  it('keeps this app’s reports AND every jetsam, newest first', () => {
    // The jetsam is the load-bearing inclusion: it names no process in its filename, and it is
    // exactly how an app dies WITHOUT writing a report of its own. Filtering strictly by process
    // would hide the most likely cause of a mystery termination on a low-end device.
    expect(filterCrashReports(names, 'App').map((r) => r.name)).toEqual([
      'App.wakeups_resource-2026-08-13-102720.ips',
      'App-2026-08-10-090000.ips',
      'JetsamEvent-2026-08-07-133543.ips',
    ])
  })

  it('drops non-.ips entries (the store holds other junk)', () => {
    expect(filterCrashReports(names).some((r) => r.name.endsWith('.txt'))).toBe(false)
  })

  it('returns everything when no process is given', () => {
    expect(filterCrashReports(names)).toHaveLength(4)
  })
})

describe('deviceCrashReports — summarizeCrashReport', () => {
  it('summarises a JETSAM: who was killed, why, and how big we were', () => {
    const s = summarizeCrashReport(load('jetsam.ips'), 'App')
    expect(s.kind).toBe('jetsam')
    if (s.kind !== 'jetsam') return
    // The measured event: WebKit's content process hit its memory ceiling. `highwater` is the
    // kernel's own word for it and is the difference between "we leaked" and "we were evicted".
    expect(s.killed.map((k) => k.reason)).toContain('highwater')
    expect(s.killed[0].name).toBe('com.apple.WebKit.WebContent')
    expect(s.killed[0].mb).toBeGreaterThan(500)
    expect(s.largest?.name).toBe('com.apple.WebKit.WebContent')
    // Our own footprint is reported whether or not we were the victim — a jetsam that killed
    // something else still tells you what the game was holding at that moment.
    expect(s.app.some((a) => a.name === 'App')).toBe(true)
    expect(s.app.every((a) => a.peakMb >= a.mb)).toBe(true)
  })

  it('converts pages with the page size NAMED, not silently', () => {
    // The reports carry no pageSize field (checked on a real one), so the MB figures rest on an
    // assumption. If that assumption ever changes, this is the test that should fail.
    expect(IOS_PAGE_BYTES).toBe(16384)
  })

  it('summarises an EXCEPTION: type, termination, faulting frames', () => {
    const s = summarizeCrashReport(load('exception.ips'))
    expect(s.kind).toBe('exception')
    if (s.kind !== 'exception') return
    expect(s.exception).toContain('EXC_GUARD')
    expect(s.exception).toContain('GUARD_TYPE_USER')
    expect(s.termination).toContain('LIBXPC')
    expect(s.termination).toContain('XPC_EXIT_REASON_FAULT')
    expect(s.frames.length).toBeGreaterThan(0)
    expect(s.process).toBe('diagnosticd')
  })

  it('falls back to the HEAD of a legacy text report instead of failing', () => {
    const s = summarizeCrashReport(load('text.ips'))
    expect(s.kind).toBe('text')
    if (s.kind !== 'text') return
    expect(s.process).toBe('App')
    expect(s.head.join('\n')).toContain('OS Version')
  })

  it('branches on SHAPE, not on bug_type', () => {
    // bug_type is an opaque number whose meaning has moved across OS versions; trusting it would
    // mis-parse a real crash silently. A report claiming to be a jetsam but carrying an exception
    // body must be read as the exception it is.
    const raw = `{"bug_type":"298","timestamp":"2026-01-01 00:00:00.00 +0900"}\n${JSON.stringify({ exception: { type: 'EXC_BAD_ACCESS' }, threads: [], usedImages: [] })}`
    expect(summarizeCrashReport(raw).kind).toBe('exception')
  })

  it('does not throw on a report it cannot parse at all', () => {
    expect(summarizeCrashReport('not json at all\nnor is this').kind).toBe('text')
  })
})
