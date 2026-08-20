/**
 * deviceCommandTargets tests (#285) — a PURE parser that answers "which
 * physical device(s) does this shell command target, and would it disturb
 * them?", backing a PreToolUse hook that refuses a raw CLI call against a
 * phone another clone has claimed. No fs, no child_process, no live device.
 */

import { describe, it, expect } from 'vitest';
import { parseDeviceCommand } from '../../scripts/deviceCommandTargets.mjs';

describe('parseDeviceCommand — no recognised device CLI', () => {
  it('returns the all-empty result for a command naming no device CLI', () => {
    expect(parseDeviceCommand('npm test')).toEqual({ ids: [], destructive: false, untargeted: false, tools: [] });
  });

  it('git status → empty', () => {
    expect(parseDeviceCommand('git status')).toEqual({ ids: [], destructive: false, untargeted: false, tools: [] });
  });

  it('does not match "ios" as a bare argument, only as the command word', () => {
    expect(parseDeviceCommand('echo adb')).toEqual({ ids: [], destructive: false, untargeted: false, tools: [] });
    expect(parseDeviceCommand('echo ios install foo')).toEqual({ ids: [], destructive: false, untargeted: false, tools: [] });
  });
});

describe('parseDeviceCommand — adb, the incident commands', () => {
  it('adb -s SERIAL install -r foo.apk → destructive, targeted', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 install -r foo.apk')).toEqual({
      ids: ['adb:RFTESTSERIAL1'],
      destructive: true,
      untargeted: false,
      tools: ['adb'],
    });
  });

  it('adb -s SERIAL shell am force-stop com.apiary.court → destructive, targeted', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 shell am force-stop com.apiary.court')).toEqual({
      ids: ['adb:RFTESTSERIAL1'],
      destructive: true,
      untargeted: false,
      tools: ['adb'],
    });
  });

  it('adb -s SERIAL logcat -c (clear) → destructive, targeted', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 logcat -c')).toEqual({
      ids: ['adb:RFTESTSERIAL1'],
      destructive: true,
      untargeted: false,
      tools: ['adb'],
    });
  });

  it('adb -s SERIAL logcat -d (dump) → read-only, targeted', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 logcat -d')).toEqual({
      ids: ['adb:RFTESTSERIAL1'],
      destructive: false,
      untargeted: false,
      tools: ['adb'],
    });
  });
});

describe('parseDeviceCommand — adb env-var targeting', () => {
  it('ANDROID_SERIAL=X adb install foo.apk → targeted via env, destructive', () => {
    expect(parseDeviceCommand('ANDROID_SERIAL=RFTESTSERIAL1 adb install foo.apk')).toEqual({
      ids: ['adb:RFTESTSERIAL1'],
      destructive: true,
      untargeted: false,
      tools: ['adb'],
    });
  });

  it('MODOKI_ANDROID_SERIAL=X adb uninstall com.foo → targeted via the Modoki-specific env var', () => {
    expect(parseDeviceCommand('MODOKI_ANDROID_SERIAL=RFTESTSERIAL2 adb uninstall com.foo')).toEqual({
      ids: ['adb:RFTESTSERIAL2'],
      destructive: true,
      untargeted: false,
      tools: ['adb'],
    });
  });

  it('an explicit -s flag wins over an env assignment when both are present', () => {
    const result = parseDeviceCommand('ANDROID_SERIAL=WRONG adb -s RFTESTSERIAL1 install foo.apk');
    expect(result.ids).toEqual(['adb:RFTESTSERIAL1']);
  });
});

describe('parseDeviceCommand — adb untargeted', () => {
  it('adb install with no -s and no env var → destructive AND untargeted', () => {
    expect(parseDeviceCommand('adb install app.apk')).toEqual({
      ids: [],
      destructive: true,
      untargeted: true,
      tools: ['adb'],
    });
  });

  it('adb devices (read-only, no serial) → NOT untargeted — nothing is disturbed', () => {
    expect(parseDeviceCommand('adb devices')).toEqual({
      ids: [],
      destructive: false,
      untargeted: false,
      tools: ['adb'],
    });
  });

  it('adb start-server / kill-server are neither destructive nor untargeted', () => {
    expect(parseDeviceCommand('adb start-server')).toEqual({
      ids: [],
      destructive: false,
      untargeted: false,
      tools: ['adb'],
    });
    expect(parseDeviceCommand('adb kill-server')).toEqual({
      ids: [],
      destructive: false,
      untargeted: false,
      tools: ['adb'],
    });
  });
});

describe('parseDeviceCommand — adb read-only surface', () => {
  it('adb shell getprop ro.product.model → read-only', () => {
    const r = parseDeviceCommand('adb -s RFTESTSERIAL1 shell getprop ro.product.model');
    expect(r.destructive).toBe(false);
    expect(r.untargeted).toBe(false);
  });

  it('adb shell dumpsys battery (no set) → read-only', () => {
    const r = parseDeviceCommand('adb -s RFTESTSERIAL1 shell dumpsys battery');
    expect(r.destructive).toBe(false);
  });

  it('adb shell dumpsys battery set level 50 → destructive (contains "set")', () => {
    const r = parseDeviceCommand('adb -s RFTESTSERIAL1 shell dumpsys battery set level 50');
    expect(r.destructive).toBe(true);
  });

  it('adb shell ls /sdcard → read-only', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 shell ls /sdcard').destructive).toBe(false);
  });

  it('adb shell cat /proc/version → read-only', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 shell cat /proc/version').destructive).toBe(false);
  });

  it('adb shell screencap -p /sdcard/x.png → read-only ("screencap+redirect is NOT destructive")', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 shell screencap -p /sdcard/x.png').destructive).toBe(false);
  });

  it('adb pull /sdcard/x /tmp/x → read-only', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 pull /sdcard/x /tmp/x').destructive).toBe(false);
  });

  it('adb bugreport → read-only', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 bugreport').destructive).toBe(false);
  });

  it('adb get-state → read-only', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 get-state').destructive).toBe(false);
  });

  it('adb wait-for-device → read-only', () => {
    expect(parseDeviceCommand('adb wait-for-device').destructive).toBe(false);
  });

  it('adb forward --list → read-only', () => {
    expect(parseDeviceCommand('adb forward --list').destructive).toBe(false);
  });
});

describe('parseDeviceCommand — adb destructive surface', () => {
  it('adb push local.txt /sdcard/ → destructive', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 push local.txt /sdcard/').destructive).toBe(true);
  });

  it('adb reboot → destructive', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 reboot').destructive).toBe(true);
  });

  it('adb root / adb unroot → destructive', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 root').destructive).toBe(true);
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 unroot').destructive).toBe(true);
  });

  it('adb shell pm clear com.foo → destructive (pm)', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 shell pm clear com.foo').destructive).toBe(true);
  });

  it('adb shell input tap 100 200 → destructive (input)', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 shell input tap 100 200').destructive).toBe(true);
  });

  it('adb shell svc wifi disable → destructive (svc)', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 shell svc wifi disable').destructive).toBe(true);
  });

  it('adb shell settings put global x 1 → destructive (settings put)', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 shell settings put global x 1').destructive).toBe(true);
  });

  it('adb shell rm /sdcard/x → destructive (rm)', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 shell rm /sdcard/x').destructive).toBe(true);
  });

  it('adb shell monkey -p com.foo 500 → destructive (monkey)', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 shell monkey -p com.foo 500').destructive).toBe(true);
  });

  it('adb shell setprop debug.x 1 → destructive (setprop)', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 shell setprop debug.x 1').destructive).toBe(true);
  });

  it('adb shell content insert --uri content://x → destructive (content)', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 shell content insert --uri content://x').destructive).toBe(true);
  });

  it('an unrecognised adb subcommand fails SAFE (destructive)', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 some-future-subcommand').destructive).toBe(true);
  });

  it('an unrecognised adb shell verb fails SAFE (destructive)', () => {
    expect(parseDeviceCommand('adb -s RFTESTSERIAL1 shell some-future-verb').destructive).toBe(true);
  });
});

describe('parseDeviceCommand — devicectl', () => {
  it('xcrun devicectl device process terminate --device UDID --pid 123 → destructive, targeted', () => {
    expect(
      parseDeviceCommand('xcrun devicectl device process terminate --device 00008150-TESTTESTTESTTEST --pid 123')
    ).toEqual({
      ids: ['ios:00008150-TESTTESTTESTTEST'],
      destructive: true,
      untargeted: false,
      tools: ['devicectl'],
    });
  });

  it('xcrun devicectl device install app --device UDID → destructive, targeted', () => {
    const r = parseDeviceCommand('xcrun devicectl device install app --device 00008150-TESTTESTTESTTEST ./App.app');
    expect(r.destructive).toBe(true);
    expect(r.ids).toEqual(['ios:00008150-TESTTESTTESTTEST']);
  });

  it('xcrun devicectl list devices → read-only, no id required', () => {
    expect(parseDeviceCommand('xcrun devicectl list devices')).toEqual({
      ids: [],
      destructive: false,
      untargeted: false,
      tools: ['devicectl'],
    });
  });

  it('xcrun devicectl device info --device UDID → read-only, targeted', () => {
    const r = parseDeviceCommand('xcrun devicectl device info --device 00008150-TESTTESTTESTTEST');
    expect(r.destructive).toBe(false);
    expect(r.ids).toEqual(['ios:00008150-TESTTESTTESTTEST']);
  });

  it('devicectl device install with no --device → destructive AND untargeted', () => {
    const r = parseDeviceCommand('xcrun devicectl device install app ./App.app');
    expect(r.destructive).toBe(true);
    expect(r.untargeted).toBe(true);
    expect(r.ids).toEqual([]);
  });
});

describe('parseDeviceCommand — ideviceinstaller', () => {
  it('ideviceinstaller -u UDID install App.app → destructive, targeted', () => {
    expect(
      parseDeviceCommand('ideviceinstaller -u 30aftestudidtestudidtestudidtestudidtest install App.app')
    ).toEqual({
      ids: ['ios:30aftestudidtestudidtestudidtestudidtest'],
      destructive: true,
      untargeted: false,
      tools: ['ideviceinstaller'],
    });
  });

  it('ideviceinstaller --udid UDID -U com.foo (uninstall flag) → destructive, targeted', () => {
    const r = parseDeviceCommand('ideviceinstaller --udid 30aftestudidtestudidtestudidtestudidtest -U com.foo');
    expect(r.destructive).toBe(true);
    expect(r.ids).toEqual(['ios:30aftestudidtestudidtestudidtestudidtest']);
  });

  it('ideviceinstaller -u UDID -l → read-only, targeted', () => {
    const r = parseDeviceCommand('ideviceinstaller -u 30aftestudidtestudidtestudidtestudidtest -l');
    expect(r.destructive).toBe(false);
    expect(r.ids).toEqual(['ios:30aftestudidtestudidtestudidtestudidtest']);
  });
});

describe('parseDeviceCommand — go-ios ("ios" command)', () => {
  it('ios install --path=App.app --udid UDID → destructive, targeted', () => {
    expect(
      parseDeviceCommand('ios install --path=App.app --udid 00008150-TESTTESTTESTTEST')
    ).toEqual({
      ids: ['ios:00008150-TESTTESTTESTTEST'],
      destructive: true,
      untargeted: false,
      tools: ['go-ios'],
    });
  });

  it('ios launch com.x --udid=UDID (= form) → destructive, targeted', () => {
    const r = parseDeviceCommand('ios launch com.apiary.court --udid=00008150-TESTTESTTESTTEST');
    expect(r.destructive).toBe(true);
    expect(r.ids).toEqual(['ios:00008150-TESTTESTTESTTEST']);
  });

  it('ios list → read-only, untargeted stays false', () => {
    expect(parseDeviceCommand('ios list')).toEqual({
      ids: [],
      destructive: false,
      untargeted: false,
      tools: ['go-ios'],
    });
  });

  it('ios install with no --udid → destructive AND untargeted', () => {
    const r = parseDeviceCommand('ios install --path=App.app');
    expect(r.destructive).toBe(true);
    expect(r.untargeted).toBe(true);
    expect(r.ids).toEqual([]);
  });
});

describe('parseDeviceCommand — xcodebuild', () => {
  it("physical destination (id=) → destructive, targeted", () => {
    expect(
      parseDeviceCommand("xcodebuild -destination 'platform=iOS,id=00008150-TESTTESTTESTTEST' -scheme App")
    ).toEqual({
      ids: ['ios:00008150-TESTTESTTESTTEST'],
      destructive: true,
      untargeted: false,
      tools: ['xcodebuild'],
    });
  });

  it('iOS Simulator destination contributes NOTHING at all', () => {
    expect(
      parseDeviceCommand("xcodebuild -destination 'platform=iOS Simulator,name=iPhone 15' -scheme App")
    ).toEqual({ ids: [], destructive: false, untargeted: false, tools: [] });
  });

  it('macOS destination also contributes nothing', () => {
    expect(
      parseDeviceCommand("xcodebuild -destination 'platform=macOS' -scheme App")
    ).toEqual({ ids: [], destructive: false, untargeted: false, tools: [] });
  });

  it('an unquoted destination with no spaces still parses', () => {
    const r = parseDeviceCommand('xcodebuild -destination platform=iOS,id=00008150-TESTTESTTESTTEST -scheme App');
    expect(r.ids).toEqual(['ios:00008150-TESTTESTTESTTEST']);
    expect(r.destructive).toBe(true);
  });

  it('a physical destination naming only a name (no id=) → device-touching but untargeted', () => {
    const r = parseDeviceCommand("xcodebuild -destination 'platform=iOS,name=iPhone 8' -scheme App");
    expect(r.destructive).toBe(true);
    expect(r.untargeted).toBe(true);
    expect(r.ids).toEqual([]);
  });

  it('xcodebuild with no -destination contributes nothing — it is not a device command', () => {
    // `-list`, `clean`, `-showBuildSettings` and simulator builds all land here. Refusing them
    // would fire device refusals on commands that touch no device; see the module comment.
    for (const cmd of ['xcodebuild -list', 'xcodebuild clean -scheme App', 'xcodebuild -showBuildSettings']) {
      expect(parseDeviceCommand(cmd)).toEqual({ ids: [], destructive: false, untargeted: false, tools: [] });
    }
    const r = parseDeviceCommand('xcodebuild -scheme App build');
    expect(r.destructive).toBe(false);
    expect(r.untargeted).toBe(false);
    expect(r.tools).toEqual([]);
  });
});

describe('parseDeviceCommand — multi-segment commands', () => {
  it('only the second segment (after &&) touches a device', () => {
    const r = parseDeviceCommand('npm test && adb -s RFTESTSERIAL1 shell am force-stop com.foo');
    expect(r.ids).toEqual(['adb:RFTESTSERIAL1']);
    expect(r.destructive).toBe(true);
    expect(r.tools).toEqual(['adb']);
  });

  it('a `;`-separated command unions results across segments', () => {
    const r = parseDeviceCommand('adb devices; adb -s RFTESTSERIAL1 install foo.apk');
    expect(r.destructive).toBe(true);
    expect(r.ids).toEqual(['adb:RFTESTSERIAL1']);
    expect(r.tools).toEqual(['adb']);
  });

  it('a `||` separator is not mistaken for two `|` separators', () => {
    const r = parseDeviceCommand("adb -s RFTESTSERIAL1 install foo.apk || echo failed");
    expect(r.ids).toEqual(['adb:RFTESTSERIAL1']);
    expect(r.destructive).toBe(true);
  });

  it('a piped command still finds the device-touching segment', () => {
    const r = parseDeviceCommand('adb -s RFTESTSERIAL1 logcat -d | grep MyApp');
    expect(r.ids).toEqual(['adb:RFTESTSERIAL1']);
    expect(r.destructive).toBe(false);
  });

  it('a newline-separated multi-line command unions both lines', () => {
    const r = parseDeviceCommand('adb devices\nadb -s RFTESTSERIAL2 reboot');
    expect(r.ids).toEqual(['adb:RFTESTSERIAL2']);
    expect(r.destructive).toBe(true);
  });

  it('ids from multiple segments are concatenated and deduped, order preserved', () => {
    const r = parseDeviceCommand('adb -s RFTESTSERIAL1 devices && adb -s RFTESTSERIAL1 install foo.apk && adb -s RFTESTSERIAL2 reboot');
    expect(r.ids).toEqual(['adb:RFTESTSERIAL1', 'adb:RFTESTSERIAL2']);
    expect(r.tools).toEqual(['adb']);
  });
});

describe('parseDeviceCommand — quoting and flag forms', () => {
  it('accepts a quoted -s value', () => {
    const r = parseDeviceCommand("adb -s 'RFTESTSERIAL1' install foo.apk");
    expect(r.ids).toEqual(['adb:RFTESTSERIAL1']);
  });

  it('accepts -s=VALUE form', () => {
    const r = parseDeviceCommand('adb -s=RFTESTSERIAL1 install foo.apk');
    expect(r.ids).toEqual(['adb:RFTESTSERIAL1']);
  });

  it('accepts a double-quoted --device value', () => {
    const r = parseDeviceCommand('xcrun devicectl device info --device "00008150-TESTTESTTESTTEST"');
    expect(r.ids).toEqual(['ios:00008150-TESTTESTTESTTEST']);
  });

  it('accepts a leading path to the adb binary', () => {
    const r = parseDeviceCommand('/opt/homebrew/bin/adb -s RFTESTSERIAL1 install foo.apk');
    expect(r.ids).toEqual(['adb:RFTESTSERIAL1']);
    expect(r.destructive).toBe(true);
  });
});

describe('parseDeviceCommand — launcher words must not become a bypass', () => {
  // Every case here was MEASURED silently allowed by the first version of this parser, which matched
  // only a bare tool name in command position. Two independent reviewers found the hole within
  // minutes of each other. A wrapped command is the same command: `sudo adb … uninstall` does
  // exactly what the incident in #285 did.
  const DESTRUCTIVE = 'install -r foo.apk';

  it('sees through sudo, and through its value-taking options', () => {
    for (const cmd of [
      `sudo adb -s RFTESTSERIAL1 ${DESTRUCTIVE}`,
      `sudo -u someone adb -s RFTESTSERIAL1 ${DESTRUCTIVE}`,
      `sudo -n -E adb -s RFTESTSERIAL1 ${DESTRUCTIVE}`,
      `doas adb -s RFTESTSERIAL1 ${DESTRUCTIVE}`,
    ]) {
      const r = parseDeviceCommand(cmd);
      expect(r.ids, cmd).toEqual(['adb:RFTESTSERIAL1']);
      expect(r.destructive, cmd).toBe(true);
    }
  });

  it('sees through env — and COLLECTS the serial env it carries, rather than skipping it', () => {
    // The collecting half matters as much as the seeing-through half: `env ANDROID_SERIAL=… adb
    // install` is precisely targeted, and a parser that merely stepped over the assignment would
    // classify it as untargeted and refuse it for the wrong reason.
    const r = parseDeviceCommand('env ANDROID_SERIAL=RFTESTSERIAL1 adb install foo.apk');
    expect(r.ids).toEqual(['adb:RFTESTSERIAL1']);
    expect(r.destructive).toBe(true);
    expect(r.untargeted).toBe(false);

    const unset = parseDeviceCommand('env -u SOMEVAR adb -s RFTESTSERIAL1 uninstall com.foo');
    expect(unset.ids).toEqual(['adb:RFTESTSERIAL1']);
    expect(unset.destructive).toBe(true);
  });

  it('sees through nice, command, nohup, exec, time and xargs', () => {
    for (const cmd of [
      `nice adb -s RFTESTSERIAL1 ${DESTRUCTIVE}`,
      `nice -n 10 adb -s RFTESTSERIAL1 ${DESTRUCTIVE}`,
      `command adb -s RFTESTSERIAL1 ${DESTRUCTIVE}`,
      `nohup adb -s RFTESTSERIAL1 ${DESTRUCTIVE}`,
      `exec adb -s RFTESTSERIAL1 ${DESTRUCTIVE}`,
      `time adb -s RFTESTSERIAL1 ${DESTRUCTIVE}`,
      `echo x | xargs adb -s RFTESTSERIAL1 ${DESTRUCTIVE}`,
      `echo x | xargs -n 1 adb -s RFTESTSERIAL1 ${DESTRUCTIVE}`,
    ]) {
      const r = parseDeviceCommand(cmd);
      expect(r.ids, cmd).toEqual(['adb:RFTESTSERIAL1']);
      expect(r.destructive, cmd).toBe(true);
    }
  });

  it('sees a launcher stacked on a launcher', () => {
    const r = parseDeviceCommand('sudo env ANDROID_SERIAL=RFTESTSERIAL1 nice adb install foo.apk');
    expect(r.ids).toEqual(['adb:RFTESTSERIAL1']);
    expect(r.destructive).toBe(true);
  });

  it('normalises a Windows .exe and an alias-dodging backslash', () => {
    // The `win` clone runs these as `adb.exe`, and `\adb` is the ordinary way to bypass a shell
    // alias — both were measured allowed.
    for (const cmd of [
      `adb.exe -s RFTESTSERIAL1 ${DESTRUCTIVE}`,
      `\\adb -s RFTESTSERIAL1 ${DESTRUCTIVE}`,
      `C:\\Android\\platform-tools\\adb.exe -s RFTESTSERIAL1 ${DESTRUCTIVE}`,
    ]) {
      const r = parseDeviceCommand(cmd);
      expect(r.ids, cmd).toEqual(['adb:RFTESTSERIAL1']);
      expect(r.destructive, cmd).toBe(true);
    }
  });

  it('does not mistake a launcher option value for the command word', () => {
    // `sudo -u adb …` runs as the USER named adb; the command after it is `whoami`, not a device
    // call. Stepping over the value is what keeps this from being a false refusal.
    const r = parseDeviceCommand('sudo -u adb whoami');
    expect(r).toEqual({ ids: [], destructive: false, untargeted: false, tools: [] });
  });

  it('still ignores a launcher that runs something harmless', () => {
    expect(parseDeviceCommand('sudo npm install')).toEqual({ ids: [], destructive: false, untargeted: false, tools: [] });
    expect(parseDeviceCommand('env FOO=bar node script.mjs')).toEqual({ ids: [], destructive: false, untargeted: false, tools: [] });
  });
});
