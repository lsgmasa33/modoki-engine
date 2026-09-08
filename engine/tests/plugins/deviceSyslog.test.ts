import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { captureIosSyslog, parseSyslogLine, DEFAULT_CAPTURE_SECONDS, MAX_CAPTURE_SECONDS } from '../../plugins/backend/deviceSyslog'

/**
 * Host-side iOS system-log capture. go-ios is stubbed by a script that emits the same JSON-per-line
 * shape the real one does, so the ring buffer / filter / bounded-stream behaviour is testable with
 * no phone attached. The real transport was measured separately against an iPhone 8 / iOS 16.7.16.
 *
 * ⚠️ SKIPPED ON WINDOWS, and there is no portable stub to write. The suite works by spawning a fake
 * `ios`, and Windows cannot execute a script directly: an extensionless `#!/bin/sh` file is ENOENT,
 * and the obvious `.cmd` shim is refused too — Node has thrown EINVAL on spawning `.cmd`/`.bat`
 * without `shell:true` since the CVE-2024-27980 fix, and turning `shell` on in the PRODUCTION spawn
 * to suit a test would be the tail wagging the dog. What is lost is coverage of Node's own child
 * plumbing on Windows; what is under test — the ring buffer, the filter, the clamp, the snapshot
 * copy — is platform-independent and runs on ubuntu + macOS. `parseSyslogLine` below is pure and
 * still runs everywhere, including Windows.
 */
describe.skipIf(process.platform === 'win32')('deviceSyslog — captureIosSyslog (stubbed go-ios)', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-syslog-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  /** A fake `ios` that prints `body` and then (unless `hang`) sleeps, like a real stream. */
  const stubGoIos = (body: string, opts: { hang?: boolean; exitCode?: number } = {}): string => {
    const p = path.join(dir, 'ios')
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n${opts.hang === false ? `exit ${opts.exitCode ?? 0}` : 'sleep 30'}\n`)
    fs.chmodSync(p, 0o755)
    return p
  }
  const line = (msg: string) => `echo '${JSON.stringify({ msg })}'`

  it('returns the device lines, unwrapped from go-ios JSON', async () => {
    const goIos = stubGoIos([line('Aug 13 10:00:00 iPhone8 App[1] <Notice>: hello'), line('Aug 13 10:00:01 iPhone8 App[1] <Notice>: world')].join('\n'))
    const cap = await captureIosSyslog({ udid: 'x', seconds: 1, goIos })
    expect(cap.lines).toEqual([
      'Aug 13 10:00:00 iPhone8 App[1] <Notice>: hello',
      'Aug 13 10:00:01 iPhone8 App[1] <Notice>: world',
    ])
    expect(cap.truncated).toBe(false)
  })

  it('filters case-insensitively, like the in-app path', async () => {
    const goIos = stubGoIos([line('backboardd: unrelated'), line('App[1]: JETSAM kill'), line('App[1]: fine')].join('\n'))
    const cap = await captureIosSyslog({ udid: 'x', seconds: 1, filter: 'jetsam', goIos })
    expect(cap.lines).toEqual(['App[1]: JETSAM kill'])
  })

  it('keeps the LAST `limit` matching lines and SAYS it truncated', async () => {
    // Silent truncation would read as "that is all the device logged" — the opposite of the truth,
    // and the reason the caller is told rather than left to infer it from a suspiciously round count.
    const goIos = stubGoIos([line('a'), line('b'), line('c')].join('\n'))
    const cap = await captureIosSyslog({ udid: 'x', seconds: 1, limit: 2, goIos })
    expect(cap.lines).toEqual(['b', 'c'])
    expect(cap.truncated).toBe(true)
  })

  it('is BOUNDED — a stream that never ends still returns, and reports the window it used', async () => {
    // The whole risk of a forward capture inside a backend route: `ios syslog` never exits on its
    // own, so without the timer this hangs the editor's request until the socket dies.
    const goIos = stubGoIos(line('still going'))
    const cap = await captureIosSyslog({ udid: 'x', seconds: 1, goIos })
    // ⚠️ NO WALL-CLOCK BOUND HERE, deliberately (#751). This ran a REAL 1 s timer plus a process
    // spawn against a 5 s assertion — 5x headroom on an I/O-shaped wait, the thinnest margin of the
    // four sites #751's sweep found. It could not catch anything the harness does not already catch
    // (`testTimeout` is 20 s, 60 s on Windows, so a stream that never ends fails as a timeout), and
    // the two assertions below are what actually prove the capture was BOUNDED: it came back, with
    // the window it used and the lines it read.
    expect(cap.capturedFor).toBe(1)
    expect(cap.lines).toEqual(['still going'])
  })

  it('clamps the window to MAX_CAPTURE_SECONDS rather than honouring an unbounded ask', async () => {
    const goIos = stubGoIos(line('x'))
    // Not awaited to completion at 60s — assert the clamp through the returned window on a short
    // run instead, and the ceiling itself by constant.
    expect(MAX_CAPTURE_SECONDS).toBe(60)
    expect(DEFAULT_CAPTURE_SECONDS).toBeLessThan(MAX_CAPTURE_SECONDS)
    const cap = await captureIosSyslog({ udid: 'x', seconds: 0, goIos })  // floor is 1, not 0
    expect(cap.capturedFor).toBe(1)
  })

  it('REJECTS when go-ios exits early instead of resolving an empty capture', async () => {
    // An empty array and a dead transport look identical to the caller otherwise, and they lead to
    // opposite next moves ("nothing was logged" vs "your device is not attached").
    const goIos = stubGoIos('echo "no device found" >&2', { hang: false, exitCode: 1 })
    await expect(captureIosSyslog({ udid: 'x', seconds: 5, goIos }))
      .rejects.toThrow(/exited early[\s\S]*no device found/)
  })

  it('hands out a SNAPSHOT — the result cannot grow after it resolves', async () => {
    // REGRESSION (close-out review): `ring` was returned by reference with the stdout listener still
    // attached, and SIGTERM is not synchronous with exit, so a caller that awaited anything between
    // receiving the result and reading `.lines` could watch it change underneath — while
    // `truncated`, a primitive copied at resolve, still claimed nothing was dropped.
    //
    // The stub IGNORES SIGTERM (`trap '' TERM`) so the race is deterministic instead of depending on
    // how fast the child happens to die; it self-terminates after ~4s so nothing is orphaned. Under
    // the old code this test grows `cap.lines` after the await and fails.
    const goIos = stubGoIos(`trap '' TERM; i=0; while [ $i -lt 80 ]; do ${line('tick')}; sleep 0.05; i=$((i+1)); done`)
    const cap = await captureIosSyslog({ udid: 'x', seconds: 1, limit: 500, goIos })
    const atResolve = cap.lines.length
    await new Promise((r) => setTimeout(r, 600))
    expect(cap.lines.length).toBe(atResolve)
  })

  it('bounds the capture when `limit` is not a number — the wire is untyped', async () => {
    // `Math.max(1, NaN)` is NaN, so `ring.length > NaN` was always false: the cap silently vanished
    // and the capture grew unbounded while `truncated` still read false. The stub emits MORE than
    // the default 50 so the two behaviours are distinguishable — an earlier version of this test
    // emitted 3 lines and asserted `<= 50`, which passed either way and proved nothing.
    const goIos = stubGoIos(Array.from({ length: 60 }, (_, i) => line(`l${i}`)).join('\n'))
    const cap = await captureIosSyslog({ udid: 'x', seconds: 1, limit: 'nonsense' as unknown as number, goIos })
    expect(cap.lines).toHaveLength(50)
    expect(cap.truncated).toBe(true)
  })

  it('names the fix when go-ios is absent', async () => {
    await expect(captureIosSyslog({ udid: 'x', goIos: path.join(dir, 'does-not-exist') }))
      .rejects.toThrow(/could not run go-ios syslog/)
  })
})

describe('deviceSyslog — parseSyslogLine', () => {
  it('unwraps the device message', () => {
    expect(parseSyslogLine('{"msg":"Aug 13 16:58:54 iPhone8 App[1] <Notice>: hi"}'))
      .toBe('Aug 13 16:58:54 iPhone8 App[1] <Notice>: hi')
  })

  it('drops go-ios’s own status objects — they are not device output', () => {
    expect(parseSyslogLine('{"time":"2026-08-13T16:58:56+09:00","level":"WARN","msg2":"agent not running"}')).toBeNull()
  })

  it('passes a JSON PRIMITIVE through — only an object can be a go-ios status line', () => {
    // REGRESSION (close-out review): any parseable JSON was treated as go-ios noise, so a device
    // line that happened to read `null` or `123` was dropped — the silent swallow this function's
    // own doc says it exists to prevent.
    expect(parseSyslogLine('null')).toBe('null')
    expect(parseSyslogLine('123')).toBe('123')
  })

  it('passes a NON-JSON line through rather than dropping it', () => {
    // Swallowing what we do not recognise is how a real error becomes an empty result that reads as
    // "the device logged nothing".
    expect(parseSyslogLine('panic: something went wrong')).toBe('panic: something went wrong')
  })

  it('ignores blank lines', () => {
    expect(parseSyslogLine('   ')).toBeNull()
  })
})
