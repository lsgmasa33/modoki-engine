/** The adb FORWARD is per-clone, and its removal is serial-scoped (#158).
 *
 *  The device claim (#149) arbitrates which PHONE a clone holds. It cannot arbitrate the host port
 *  the tunnel uses, and that port was a hardcoded machine-wide 9095 — so two clones leasing two
 *  DIFFERENT phones both passed the claim (correctly: different `deviceId`s) and then silently
 *  fought over one `adb forward`. Measured 2026-08-07 on this Mac: the second forward won, the first
 *  clone's lease was pointed at the wrong handset, and both editors displayed a state the system
 *  contradicted, with no error on either side.
 *
 *  Two mechanisms, tested here:
 *   1. the host port is DERIVED per clone (`9095 + (backend − 5179)`), so the collision is
 *      unreachable — the same idiom backend/Vite/editor-CDP/device-CDP ports already use;
 *   2. `adb forward --remove` matches on the HOST PORT SPEC and ignores `-s`, so a removal verifies
 *      the rule belongs to the expected serial before deleting it. Belt to the fix's braces: a
 *      mismatched removal must refuse rather than reach across a clone boundary, regardless.
 *
 *  What this CANNOT reach is the thing that actually proves it — two backends, two handsets, each
 *  `/api/device/status` agreeing with `adb forward --list`. That is a live gate, noted on the issue.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { adbRunner, resolveDeviceHostPort, DEVICE_HOST_PORT_BASE } from '../../plugins/backend/deviceConnection';
import { parseForwardList, forwardOwner } from '../../plugins/backend/androidDevices';

describe('resolveDeviceHostPort — per-clone derivation (#158)', () => {
  it('defaults to the hub port with no env at all', () => {
    expect(resolveDeviceHostPort({})).toBe(DEVICE_HOST_PORT_BASE);
  });

  it('derives from the backend port, one lane per clone', () => {
    expect(resolveDeviceHostPort({ MODOKI_BACKEND_PORT: '5179' })).toBe(9095); // main
    expect(resolveDeviceHostPort({ MODOKI_BACKEND_PORT: '5180' })).toBe(9096); // work-ai
    expect(resolveDeviceHostPort({ MODOKI_BACKEND_PORT: '5181' })).toBe(9097); // work-ai2
    expect(resolveDeviceHostPort({ MODOKI_BACKEND_PORT: '5182' })).toBe(9098); // work-ai3
  });

  it('is injective across the clones — which is the whole point', () => {
    const ports = ['5179', '5180', '5181', '5182'].map((p) => resolveDeviceHostPort({ MODOKI_BACKEND_PORT: p }));
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('honours an explicit override ahead of the derivation', () => {
    expect(resolveDeviceHostPort({ MODOKI_DEVICE_HOST_PORT: '9500', MODOKI_BACKEND_PORT: '5181' })).toBe(9500);
  });

  it('falls back to the hub default on a junk backend port rather than deriving nonsense', () => {
    expect(resolveDeviceHostPort({ MODOKI_BACKEND_PORT: 'nope' })).toBe(9095);
    expect(resolveDeviceHostPort({ MODOKI_BACKEND_PORT: '' })).toBe(9095);
    expect(resolveDeviceHostPort({ MODOKI_DEVICE_HOST_PORT: '0' })).toBe(9095);
    expect(resolveDeviceHostPort({ MODOKI_DEVICE_HOST_PORT: '70000' })).toBe(9095);
  });
});

describe('parseForwardList / forwardOwner', () => {
  const LIST = 'RFCTB0EV83K tcp:9095 tcp:9095\n'
    + 'RFCTA14CMRF tcp:9097 tcp:9095\n'
    + 'RFCTA14CMRF tcp:9333 localabstract:webview_devtools_remote_12345\n';

  it('parses each rule as serial + local + remote', () => {
    expect(parseForwardList(LIST)).toEqual([
      { serial: 'RFCTB0EV83K', local: 'tcp:9095', remote: 'tcp:9095' },
      { serial: 'RFCTA14CMRF', local: 'tcp:9097', remote: 'tcp:9095' },
      { serial: 'RFCTA14CMRF', local: 'tcp:9333', remote: 'localabstract:webview_devtools_remote_12345' },
    ]);
  });

  it('drops the cold-daemon banner rather than parsing it as a rule', () => {
    const noisy = '* daemon not running; starting now at tcp:5037\n* daemon started successfully\n' + LIST;
    expect(parseForwardList(noisy)).toHaveLength(3);
  });

  it('drops a `*` banner STRUCTURALLY, not because its fields happen to look wrong', () => {
    // The real banners are rejected by the field-shape check anyway, so this pins the explicit
    // `*` rule instead: a hypothetical banner whose second token carried a colon would otherwise
    // parse as a ForwardRule, and a rule fabricated from a banner is a wrong answer to "who owns
    // this port". Constructed, deliberately — the point is that the guard does not depend on adb's
    // banner wording staying convenient.
    const hostile = '* daemon tcp:9095 restarting\n' + LIST;
    expect(parseForwardList(hostile)).toHaveLength(3);
    expect(forwardOwner(hostile, 9095)).toBe('RFCTB0EV83K'); // the real rule, not the banner
  });

  it('answers who owns a host port, and undefined when nobody does', () => {
    expect(forwardOwner(LIST, 9095)).toBe('RFCTB0EV83K');
    expect(forwardOwner(LIST, 9097)).toBe('RFCTA14CMRF');
    expect(forwardOwner(LIST, 9096)).toBeUndefined();
    expect(forwardOwner('', 9095)).toBeUndefined();
  });

  it('matches the LOCAL side only — the remote port must never decide ownership', () => {
    // Every rule here forwards to tcp:9095 on the device. Asking "who owns host 9095" must answer
    // the one clone listening there, not all three.
    expect(forwardOwner(LIST, 9095)).toBe('RFCTB0EV83K');
  });
});

describe('adbRunner.removeForward — refuses to delete another device\'s rule (#158)', () => {
  const realList = adbRunner.listForwards;
  afterEach(() => { adbRunner.listForwards = realList; vi.restoreAllMocks(); });

  it('skips (and says why) when the rule on that port belongs to a different serial', () => {
    // The measured incident: `adb -s RFCTB0EV83K forward --remove tcp:9095` deleted the rule owned
    // by RFCTA14CMRF, leaving that clone's live lease with no tunnel and no error.
    adbRunner.listForwards = () => 'RFCTA14CMRF tcp:9095 tcp:9095\n';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No throw is the assertion that matters: the early return happens BEFORE the `adb` shell-out,
    // which on a machine without the Android SDK would throw from `adbBinary()`.
    expect(() => adbRunner.removeForward(9095, 'RFCTB0EV83K')).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('RFCTA14CMRF'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping'));
  });

  it('FAILS CLOSED when the ownership question cannot be answered at all', () => {
    // Found in the #158 close-out review. The catch used to set `owner = undefined` and fall
    // through to the removal — which reproduces the original incident under a narrower trigger:
    // `adb forward --list` timing out on a cold-daemon start (4s budget) or erroring transiently
    // leaves the guard with nothing to compare, and the un-targeted `--remove` then deletes
    // whatever holds that port, including a sibling clone's live rule.
    //
    // Skipping is the safe direction, and the asymmetry is what decides it: a leaked rule is
    // benign and self-healing (`connect()` re-forwards idempotently), a cross-delete strips a
    // live lease from another clone.
    adbRunner.listForwards = () => { throw new Error('adb: device offline'); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => adbRunner.removeForward(9095, 'RFCTB0EV83K')).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not verify'));
  });

  it('does not consult the list at all without a serial — nothing to scope against', () => {
    // An un-targeted removal reproduces the pre-#149 single-phone behaviour, where there is no
    // second owner to protect. Guarding it would only add a shell-out.
    const list = vi.fn(() => '');
    adbRunner.listForwards = list;
    try { adbRunner.removeForward(9095); } catch { /* no adb on this machine — irrelevant here */ }
    expect(list).not.toHaveBeenCalled();
  });
});
