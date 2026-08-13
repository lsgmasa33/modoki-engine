import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseLogcatLine, parseCrashBuffer, parseKillEvents, filterAndroidDiag,
} from '../../plugins/backend/deviceAndroidDiag'

/**
 * The Android log parsers, against REAL logcat output from a Galaxy S22 — including a crash that
 * was deliberately forced (`adb shell am crash com.modokiengine.court`) so the FATAL EXCEPTION
 * shape is Android's, not mine. Same rule as the iOS `.ips` fixtures: the risk in a log parser is
 * being wrong about the format, and a sample I invented would agree with my mistake.
 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/android-diag')
const load = (n: string) => fs.readFileSync(path.join(FIXTURES, n), 'utf8')

describe('deviceAndroidDiag — parseLogcatLine', () => {
  it('splits a -v threadtime line', () => {
    expect(parseLogcatLine('08-13 18:11:17.565 13160 13160 E AndroidRuntime: FATAL EXCEPTION: main'))
      .toEqual({ when: '08-13 18:11:17.565', pid: 13160, tag: 'AndroidRuntime', text: 'FATAL EXCEPTION: main' })
  })

  it('returns null for a banner line rather than inventing a record', () => {
    expect(parseLogcatLine('--------- beginning of crash')).toBeNull()
  })

  it('parses a CRLF line — adb on WINDOWS does not send LF', () => {
    // REGRESSION (Windows CI, 2026-08-13): `\r` is a JS line terminator, so `.` will not match it
    // and the trailing `(.*)$` failed — every line parsed as null, `parseCrashBuffer` returned [],
    // and the tool reported "no crashes" about a phone that had just crashed. Invisible to a Mac
    // run, which is why the assertion is on an explicit `\r` rather than on a fixture (whose line
    // endings git rewrites per platform, so it can only ever test the host it runs on).
    expect(parseLogcatLine('08-13 18:11:17.565 13160 13160 E AndroidRuntime: FATAL EXCEPTION: main\r'))
      .toEqual({ when: '08-13 18:11:17.565', pid: 13160, tag: 'AndroidRuntime', text: 'FATAL EXCEPTION: main' })
  })
})

describe('deviceAndroidDiag — parseCrashBuffer', () => {
  it('parses a real FATAL EXCEPTION: process, pid, exception, stack', () => {
    const [c] = parseCrashBuffer(load('crash-buffer.txt'))
    expect(c.kind).toBe('crash')
    expect(c.process).toBe('com.modokiengine.court')
    expect(c.pid).toBe(13160)
    expect(c.exception).toContain('CrashedByAdbException')
    expect(c.frames[0]).toMatch(/^at android\.app\.ActivityThread/)
    expect(c.frames.length).toBeGreaterThan(3)
  })

  it('parses the SAME buffer delivered as CRLF — the Windows adb shape', () => {
    // The end-to-end payoff of the parseLogcatLine fix, asserted on the real fixture rewritten to
    // CRLF in-test: this is byte-for-byte what the Windows CI leg fed it when it returned [].
    const [c] = parseCrashBuffer(load('crash-buffer.txt').replace(/\n/g, '\r\n'))
    expect(c.process).toBe('com.modokiengine.court')
    expect(c.frames[0]).toMatch(/^at android\.app\.ActivityThread/)
  })

  it('caps the stack — a deep trace is not worth the response budget', () => {
    const deep = ['08-13 18:11:17.565 1 1 E AndroidRuntime: FATAL EXCEPTION: main',
      '08-13 18:11:17.565 1 1 E AndroidRuntime: Process: x, PID: 1',
      '08-13 18:11:17.565 1 1 E AndroidRuntime: java.lang.IllegalStateException: boom',
      ...Array.from({ length: 40 }, (_, i) => `08-13 18:11:17.565 1 1 E AndroidRuntime: \tat com.x.F${i}(F.java:1)`)].join('\n')
    expect(parseCrashBuffer(deep)[0].frames.length).toBeLessThanOrEqual(12)
  })

  it('returns [] for an empty buffer — no crash is a real answer', () => {
    // Measured: a phone that has not crashed returns literally nothing on `-b crash -d`.
    expect(parseCrashBuffer('')).toEqual([])
  })
})

describe('deviceAndroidDiag — parseKillEvents', () => {
  it('reads am_kill with its process, pid and REASON', () => {
    // The reason is the activity manager's own attribution (`empty #34`) and is the whole value of
    // this buffer — it is the Android answer to a jetsam's `highwater`.
    const kills = parseKillEvents(load('events-kills.txt'))
    const withReason = kills.filter((k) => k.reason)
    expect(withReason.length).toBeGreaterThan(0)
    expect(withReason[0].process).toMatch(/^com\./)
    expect(withReason.some((k) => /empty/.test(k.reason ?? ''))).toBe(true)
  })

  it('keeps an am_proc_died only when no am_kill already explains that pid', () => {
    // Both events fire for one death; reporting both would double-count every kill. A death with
    // no attribution still shows up, because a process vanishing unexplained is itself the finding.
    const out = [
      '08-13 18:08:38.788 2671 3749 I am_kill : [0,4579,com.example.a,999,empty #34]',
      '08-13 18:08:38.826 2671 6464 I am_proc_died: [0,4579,com.example.a,999,19,887,2356]',
      '08-13 18:08:38.842 2671 6464 I am_proc_died: [0,4630,com.example.b,999,19,887,2356]',
    ].join('\n')
    const got = parseKillEvents(out)
    expect(got).toHaveLength(2)
    expect(got.filter((k) => k.process === 'com.example.a')).toHaveLength(1)
    expect(got.find((k) => k.process === 'com.example.b')?.reason).toBeNull()
  })

  it('does NOT let a recycled PID make one kill swallow another process’s death', () => {
    // REGRESSION (close-out review): the dedup keyed on pid alone. Android recycles pids and a
    // 4000-line tail can span hours, so com.foo's kill hid com.bar's LATER death — and if com.bar
    // is the app you are diagnosing, the tool answers "no kill happened", which is the worst
    // possible failure for a diagnostic.
    const out = [
      '08-13 10:00:00.000  100  100 I am_kill : [0,500,com.foo,10,empty #34]',
      '08-13 10:05:00.000  100  100 I am_proc_died: [0,500,com.bar,5]',
    ].join('\n')
    const got = parseKillEvents(out)
    expect(got.map((k) => k.process).sort()).toEqual(['com.bar', 'com.foo'])
  })

  it('sorts newest first, like every other listing here', () => {
    const kills = parseKillEvents(load('events-kills.txt'))
    const times = kills.map((k) => k.when)
    expect([...times].sort((a, b) => b.localeCompare(a))).toEqual(times)
  })
})

describe('deviceAndroidDiag — filterAndroidDiag', () => {
  const records = [
    ...parseCrashBuffer(load('crash-buffer.txt')),
    ...parseKillEvents(load('events-kills.txt')),
  ]

  it('keeps only this package', () => {
    const got = filterAndroidDiag(records, 'com.modokiengine.court')
    expect(got.length).toBeGreaterThan(0)
    expect(got.every((r) => r.process === 'com.modokiengine.court')).toBe(true)
  })

  it('keeps a package’s SUB-PROCESSES too — for CRASHES as well as kills', () => {
    // A Capacitor game's WebView runs in `<pkg>:sandboxed_process…`; dropping those would hide the
    // renderer kill, which is the one that actually takes the screen black.
    // REGRESSION (close-out review): the sub-process match applied to kills ONLY, so an
    // OutOfMemoryError thrown in the renderer — filed under `com.x:webview` — was silently excluded
    // from a filtered view, i.e. exactly the crash the filter's own doc argues you must not lose.
    const got = filterAndroidDiag([
      { kind: 'kill', when: '08-13 10:00:00.000', process: 'com.x:sandboxed_process0', pid: 1, adj: 900, reason: 'empty #1' },
      { kind: 'crash', when: '08-13 10:00:01.000', process: 'com.x:webview', pid: 2, exception: 'java.lang.OutOfMemoryError', frames: [] },
    ], 'com.x')
    expect(got).toHaveLength(2)
    expect(got.some((r) => r.kind === 'crash')).toBe(true)
  })

  it('drops a crash it could not attribute, rather than filing it under the asked-for package', () => {
    const got = filterAndroidDiag(
      [{ kind: 'crash', when: '08-13 10:00:00.000', process: null, pid: 1, exception: 'boom', frames: [] }],
      'com.x')
    expect(got).toEqual([])
  })

  it('returns everything when no package is given', () => {
    expect(filterAndroidDiag(records)).toHaveLength(records.length)
  })
})
