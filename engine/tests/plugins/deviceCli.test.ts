/**
 * device.mjs CLI tests (#285) — the standalone claim/release/list/run surface for agent CLIs
 * (Codex, Cursor, a plain terminal) that have no access to the MCP surface or the Bash hook.
 *
 * MODOKI_HOME is pointed at a per-test temp dir for EVERY test, exactly like deviceClaims.test.ts.
 * This CLI writes machine-wide claim state — a test that touched the developer's real
 * `~/.modoki/device-claims.json` could block their actual phone, so this is not optional.
 *
 * The CLI is driven by spawning it as a real child process (not by importing its functions), since
 * the thing under test IS the process boundary: argv parsing, exit codes, and what lands on
 * stdout/stderr. No real hardware is required or assumed — every device id used here is a
 * namespaced (`adb:`/`ios:`) fake, so resolution never depends on `adb`/`xcrun` being present or
 * finding anything real.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/device.mjs');

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-device-cli-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  const res = spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MODOKI_HOME: home, ...extraEnv },
    timeout: 15_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const claimsFilePath = () => path.join(home, 'device-claims.json');

/** Write a claim directly into the store file, bypassing the CLI — this is how the tests simulate
 *  "another clone already holds this device" without a second real process. */
function writeForeignClaim(deviceId: string, overrides: Record<string, unknown> = {}) {
  const claim = {
    deviceId,
    clone: '/Users/other/Projects/modoki-other',
    branch: 'work-other',
    pid: 0,
    at: Date.now(),
    owner: 'cli:/Users/other/Projects/modoki-other',
    ttlMs: 90 * 60 * 1000,
    ...overrides,
  };
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(claimsFilePath(), JSON.stringify({ claims: [claim] }, null, 2));
}

describe('device.mjs --help / no subcommand', () => {
  it('prints usage and exits 0 for --help', () => {
    const { status, stdout } = runCli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/device claim/);
    expect(stdout).toMatch(/device release/);
    expect(stdout).toMatch(/device list/);
    expect(stdout).toMatch(/device run/);
  });

  it('prints usage and exits 0 with no subcommand at all', () => {
    const { status, stdout } = runCli([]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/Usage/);
  });

  it('an unknown subcommand exits 1', () => {
    const { status, stderr } = runCli(['frobnicate']);
    expect(status).toBe(1);
    expect(stderr).toMatch(/Unknown subcommand/);
  });
});

describe('device claim / release round-trip', () => {
  it('claims a namespaced id, then releases it', () => {
    const claim = runCli(['claim', 'adb:RFTESTSERIAL1', '--purpose', 'unit test']);
    expect(claim.status).toBe(0);
    expect(claim.stdout).toMatch(/Claimed/);
    expect(claim.stdout).toMatch(/adb:RFTESTSERIAL1/);

    const stored = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8'));
    expect(stored.claims).toHaveLength(1);
    expect(stored.claims[0].deviceId).toBe('adb:RFTESTSERIAL1');
    expect(stored.claims[0].purpose).toBe('unit test');
    expect(typeof stored.claims[0].owner).toBe('string');
    expect(stored.claims[0].owner.startsWith('cli:')).toBe(true);

    const release = runCli(['release', 'adb:RFTESTSERIAL1']);
    expect(release.status).toBe(0);
    expect(release.stdout).toMatch(/Released/);

    const after = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8'));
    expect(after.claims).toHaveLength(0);
  });

  it('a re-claim by the same clone refreshes rather than conflicting', () => {
    const first = runCli(['claim', 'adb:RFTESTSERIAL1']);
    expect(first.status).toBe(0);
    const second = runCli(['claim', 'adb:RFTESTSERIAL1', '--purpose', 'still using it']);
    expect(second.status).toBe(0);

    const stored = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8'));
    expect(stored.claims).toHaveLength(1);
    expect(stored.claims[0].purpose).toBe('still using it');
  });
});

describe('device claim — refused by a foreign holder', () => {
  it('refuses and names the holder when another clone already holds the device', () => {
    writeForeignClaim('adb:RFTESTSERIAL2');
    const { status, stderr } = runCli(['claim', 'adb:RFTESTSERIAL2']);
    expect(status).toBe(1);
    expect(stderr).toMatch(/already claimed/);
    expect(stderr).toMatch(/work-other/);

    // The foreign claim must be untouched.
    const stored = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8'));
    expect(stored.claims).toHaveLength(1);
    expect(stored.claims[0].owner).toBe('cli:/Users/other/Projects/modoki-other');
  });
});

describe('device release', () => {
  it('--all releases every claim this clone holds and none belonging to someone else', () => {
    runCli(['claim', 'adb:RFTESTSERIALA']);
    runCli(['claim', 'ios:00008150-TESTTESTTESTTEST']);
    // `writeForeignClaim` overwrites the file, so append the foreign claim onto what the two
    // `claim` calls above already wrote rather than clobbering them.
    const before = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8'));
    fs.writeFileSync(claimsFilePath(), JSON.stringify({
      claims: [...before.claims, {
        deviceId: 'adb:RFTESTFOREIGN',
        clone: '/Users/other/Projects/modoki-other',
        branch: 'work-other',
        pid: 0,
        at: Date.now(),
        owner: 'cli:/Users/other/Projects/modoki-other',
        ttlMs: 90 * 60 * 1000,
      }],
    }, null, 2));
    const existing = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8'));
    expect(existing.claims).toHaveLength(3);

    const { status, stdout } = runCli(['release', '--all']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/Released/);
    expect(stdout).toMatch(/adb:RFTESTSERIALA/);
    expect(stdout).toMatch(/ios:00008150-TESTTESTTESTTEST/);
    expect(stdout).not.toMatch(/RFTESTFOREIGN/);

    const after = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8'));
    expect(after.claims.map((c: { deviceId: string }) => c.deviceId)).toEqual(['adb:RFTESTFOREIGN']);
  });

  it('releasing a device this clone does not hold is a clean no-op, exit 0', () => {
    const { status, stdout } = runCli(['release', 'adb:RFNEVERCLAIMED']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/no claim/i);
  });

  it('never releases a foreign holder\'s claim, and says so, exit 0', () => {
    writeForeignClaim('adb:RFTESTFOREIGN2');
    const { status, stdout } = runCli(['release', 'adb:RFTESTFOREIGN2']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/held by another session/);

    const stored = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8'));
    expect(stored.claims).toHaveLength(1);
  });
});

describe('device list', () => {
  it('runs cleanly against an empty store with nothing attached', () => {
    const { status, stdout } = runCli(['list']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/Attached devices/);
  });

  it('reports a live claim on a device that is not attached, under its own heading', () => {
    writeForeignClaim('ip:10.0.0.99');
    const { status, stdout } = runCli(['list']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/not currently attached/);
    expect(stdout).toMatch(/ip:10\.0\.0\.99/);
  });
});

describe('device run', () => {
  it('refuses a destructive command that names no device, without running it', () => {
    const { status, stderr } = runCli(['run', '--', 'adb', 'install', 'app.apk']);
    expect(status).toBe(1);
    expect(stderr).toMatch(/Refused/);
    expect(stderr).toMatch(/no device named/);
  });

  it('refuses when another clone holds the targeted device, without running it', () => {
    writeForeignClaim('adb:RFTESTSERIAL3');
    const { status, stderr } = runCli(['run', '--', 'adb', '-s', 'RFTESTSERIAL3', 'install', 'app.apk']);
    expect(status).toBe(1);
    expect(stderr).toMatch(/already claimed/);
    // Must fail on the CLAIM check, not on trying (and failing) to actually exec adb.
    expect(stderr).not.toMatch(/Failed to run/);

    const stored = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8'));
    expect(stored.claims).toHaveLength(1);
    expect(stored.claims[0].owner).toBe('cli:/Users/other/Projects/modoki-other');
  });

  it('runs a command that names no device at all (nothing to arbitrate)', () => {
    const { status, stdout } = runCli(['run', '--', 'node', '-e', 'console.log("ran")']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/ran/);
  });
});

/**
 * #285 follow-up: an `ios:<udid>` claim can be the SAME physical phone as a foreign `ip:<host>`
 * (WiFi lease) claim — see `deviceClaimsStore.mjs`'s "KNOWN GAP" header. `device.mjs` narrows this
 * by comparing product types: the foreign claim's `model` (stamped by the WiFi lease) against the
 * UDID's product type from `xcrun devicectl`.
 *
 * The `xcrun` lookup is NEVER really spawned here — `MODOKI_DEVICECTL_JSON_FIXTURE` points the CLI
 * at a canned JSON file with the same shape `devicectl list devices --json-output` writes
 * (`result.devices[].hardwareProperties.{udid,productType}`), so these tests pass on a machine with
 * no Xcode and no phone attached. Every id here is a fake (`00008150-TESTTESTTESTTEST`,
 * `iPhoneTEST,1`) per the "never a real device id" rule — this file ships in the public OSS
 * snapshot.
 */
describe('device claim — ios: vs. foreign ip: same-phone narrowing (#285)', () => {
  const UDID = '00008150-TESTTESTTESTTEST';

  function writeDevicectlFixture(devices: { udid: string; productType: string }[]) {
    const file = path.join(home, `devicectl-fixture-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify({
      result: { devices: devices.map((d) => ({ hardwareProperties: { udid: d.udid, productType: d.productType } })) },
    }));
    return file;
  }

  it('refuses when the UDID\'s product type matches a foreign ip: claim\'s model, naming the holder and both product types', () => {
    writeForeignClaim('ip:10.0.0.50', { model: 'iPhoneTEST,1', deviceId: 'ip:10.0.0.50' });
    const fixture = writeDevicectlFixture([{ udid: UDID, productType: 'iPhoneTEST,1' }]);

    const { status, stderr } = runCli(['claim', `ios:${UDID}`], { MODOKI_DEVICECTL_JSON_FIXTURE: fixture });

    expect(status).toBe(1);
    expect(stderr).toMatch(/Refused/);
    expect(stderr).toMatch(/work-other/); // names the holder's clone/branch
    expect(stderr).toMatch(/iPhoneTEST,1/); // both sides' product type
    expect(stderr).toMatch(/--force/); // tells them how to override

    // The claim must not have gone through.
    const stored = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8'));
    expect(stored.claims.find((c: { deviceId: string }) => c.deviceId === `ios:${UDID}`)).toBeUndefined();
  });

  it('allows silently when the UDID\'s product type is resolved but DIFFERENT from the foreign claim\'s model', () => {
    writeForeignClaim('ip:10.0.0.50', { model: 'iPhoneOTHER,1', deviceId: 'ip:10.0.0.50' });
    const fixture = writeDevicectlFixture([{ udid: UDID, productType: 'iPhoneTEST,1' }]);

    const { status, stdout, stderr } = runCli(['claim', `ios:${UDID}`], { MODOKI_DEVICECTL_JSON_FIXTURE: fixture });

    expect(status).toBe(0);
    expect(stdout).toMatch(/Claimed/);
    expect(stderr).not.toMatch(/Warning/);
    expect(stderr).not.toMatch(/Refused/);
  });

  it('allows WITH a warning line when the product-type lookup cannot resolve (UDID absent from the listing)', () => {
    writeForeignClaim('ip:10.0.0.50', { model: 'iPhoneTEST,1', deviceId: 'ip:10.0.0.50' });
    const fixture = writeDevicectlFixture([]); // the listing exists but never mentions our UDID

    const { status, stdout, stderr } = runCli(['claim', `ios:${UDID}`], { MODOKI_DEVICECTL_JSON_FIXTURE: fixture });

    expect(status).toBe(0);
    expect(stdout).toMatch(/Claimed/);
    expect(stderr).toMatch(/Warning/);
    expect(stderr).toMatch(/work-other/); // still names the foreign holder it couldn't compare against
  });

  it('allows WITH a warning line when xcrun itself is unavailable (fixture path does not exist)', () => {
    writeForeignClaim('ip:10.0.0.50', { model: 'iPhoneTEST,1', deviceId: 'ip:10.0.0.50' });

    const { status, stdout, stderr } = runCli(['claim', `ios:${UDID}`], {
      MODOKI_DEVICECTL_JSON_FIXTURE: path.join(home, 'does-not-exist.json'),
    });

    expect(status).toBe(0);
    expect(stdout).toMatch(/Claimed/);
    expect(stderr).toMatch(/Warning/);
  });

  it('--force proceeds past a matching-product-type refusal, printing what it overrides', () => {
    writeForeignClaim('ip:10.0.0.50', { model: 'iPhoneTEST,1', deviceId: 'ip:10.0.0.50' });
    const fixture = writeDevicectlFixture([{ udid: UDID, productType: 'iPhoneTEST,1' }]);

    const { status, stdout, stderr } = runCli(
      ['claim', `ios:${UDID}`, '--force'],
      { MODOKI_DEVICECTL_JSON_FIXTURE: fixture },
    );

    expect(status).toBe(0);
    expect(stdout).toMatch(/Claimed/);
    expect(stderr).toMatch(/--force/);
    expect(stderr).toMatch(/overrid/i);

    const stored = JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8'));
    expect(stored.claims.some((c: { deviceId: string }) => c.deviceId === `ios:${UDID}`)).toBe(true);
  });

  it('never even attempts the product-type lookup when there is no foreign ip: claim', () => {
    const marker = path.join(home, 'lookup-marker');
    const fixture = writeDevicectlFixture([{ udid: UDID, productType: 'iPhoneTEST,1' }]);

    const { status, stdout } = runCli(['claim', `ios:${UDID}`], {
      MODOKI_DEVICECTL_JSON_FIXTURE: fixture,
      MODOKI_DEVICECTL_LOOKUP_MARKER: marker,
    });

    expect(status).toBe(0);
    expect(stdout).toMatch(/Claimed/);
    expect(fs.existsSync(marker)).toBe(false); // the lookup function was never even entered
  });

  it('does not run the collision check at all for a non-ios: namespace (adb:), even with a matching foreign ip: claim', () => {
    writeForeignClaim('ip:10.0.0.50', { model: 'iPhoneTEST,1', deviceId: 'ip:10.0.0.50' });
    const marker = path.join(home, 'lookup-marker-adb');

    const { status, stdout } = runCli(['claim', 'adb:RFTESTSERIALIOSCHECK'], {
      MODOKI_DEVICECTL_LOOKUP_MARKER: marker,
    });

    expect(status).toBe(0);
    expect(stdout).toMatch(/Claimed/);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('device run — a refused command must leave no claim behind', () => {
  it('leaks no claim when a multi-device command is refused on the second device', () => {
    // Measured before the two-pass fix: the free Android was claimed, the foreign iPhone refused the
    // run, the command never executed — and the Android stayed locked out of every other clone for
    // 90 minutes on behalf of a command that did nothing.
    writeForeignClaim('ios:00008150-TESTTESTTESTTEST', { purpose: 'holding a device lease over USB' });

    const res = runCli([
      'run', '--',
      'adb -s RFTESTSERIAL1 install foo.apk && xcrun devicectl device install app --device 00008150-TESTTESTTESTTEST App.app',
    ]);

    expect(res.status).toBe(1);
    // The free device must NOT have been taken on the way to the refusal.
    const ids = (JSON.parse(fs.readFileSync(claimsFilePath(), 'utf8')).claims as { deviceId: string }[])
      .map((c) => c.deviceId);
    expect(ids).not.toContain('adb:RFTESTSERIAL1');
  });
});
