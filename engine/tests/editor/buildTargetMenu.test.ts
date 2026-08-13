/** buildTargetMenu — the Build menu's iOS/Android target picker (#170), pure half.
 *
 *  These functions turn `/api/device/list` + the current `user.device` ids into the rows the Build
 *  menu renders. No fetch, no mounted editor — every `DeviceListReply` here is a hand-built literal,
 *  which is the whole point of splitting this out as pure. */
import { describe, it, expect } from 'vitest';
import {
  iosTargetRows, androidTargetRows, iosTargetSummary, androidTargetSummary, buildRefusal, pickRefusal,
  type DeviceTarget,
} from '../../app/editor/buildTargetMenu';
import type { DeviceListReply, IosDeviceRow, AndroidDeviceRow } from '@modoki/engine/editor';

const noTarget: DeviceTarget = { iosDeviceId: '', iosDevicectlId: '', androidDeviceId: '' };

function iosRow(over: Partial<IosDeviceRow> = {}): IosDeviceRow {
  return { udid: 'UDID-1', name: 'iPhone Air', connected: true, claim: null, ...over };
}

function androidRow(over: Partial<AndroidDeviceRow> = {}): AndroidDeviceRow {
  return { serial: 'SER-1', state: 'device', usable: true, claim: null, ...over };
}

function listWith(over: Partial<DeviceListReply> = {}): DeviceListReply {
  return { android: [], ios: [], otherClaims: [], adb: { present: true }, ...over };
}

describe('buildRefusal — no second concurrent build', () => {
  // Nothing else stops one: /api/build takes no lock, runBuild fires an SSE request per call, and
  // the DOM progress modal cannot cover a NATIVE application menu. Two pipelines then run
  // `npm run build` + `cap sync` against the same project dir at once.
  it('refuses while a build is running', () => {
    expect(buildRefusal({ active: true, failed: false })).toMatch(/already running/);
  });

  it('allows one when nothing is running', () => {
    expect(buildRefusal({ active: false, failed: false })).toBeNull();
  });

  it('allows one when the previous build FAILED but its modal is still up', () => {
    // A failed build is over; refusing here would make "dismiss a dialog" a prerequisite for
    // retrying a broken build — a worse trap than the one the guard exists to prevent.
    expect(buildRefusal({ active: true, failed: true })).toBeNull();
  });

  it('allows one when the store has not reported yet', () => {
    // Absence of status is not evidence of a build; refusing on null would dead-end the menu
    // during boot.
    expect(buildRefusal(null)).toBeNull();
  });
});

describe('pickRefusal — the other writer of user.device.*', () => {
  // The Project Settings dialog snapshots the WHOLE config when it opens and posts that snapshot
  // on Save, so a pick made while it sits open is silently written back to the old device — even
  // if the user only meant to edit the app name. Refusing names the reason; the lost update
  // would not.
  it('refuses while Project Settings is open', () => {
    expect(pickRefusal(true)).toMatch(/Close Project Settings/);
  });

  it('allows a pick when it is closed', () => {
    expect(pickRefusal(false)).toBeNull();
  });
});

describe('a listing that could not be read is not "no devices"', () => {
  // The two have different fixes: one says check the cable, the other says the editor never got
  // an answer. Reachable on every boot (the listing lands 1.6-2.9s in) and on any backend hiccup.
  it('iOS says the list is not loaded, not that no phone is paired', () => {
    const rows = iosTargetRows(null, noTarget, 'darwin');
    expect(rows[0].label).toMatch(/not loaded/);
    expect(rows[0].label).not.toMatch(/No iOS device paired/);
    expect(rows[0].disabled).toBe(true);
  });

  it('iOS still shows the configured target as checked when the listing is missing', () => {
    // It is what the next build would use; a menu with nothing checked would misrepresent that.
    const rows = iosTargetRows(null, { ...noTarget, iosDeviceId: 'UDID-X' }, 'darwin');
    expect(rows.find((r) => r.label.includes('UDID-X'))).toMatchObject({ checked: true, disabled: true });
  });

  it('Android says the same, and keeps the Default row', () => {
    const rows = androidTargetRows(null, noTarget);
    expect(rows[0].label).toBe('Default (first adb device)');
    expect(rows[1].label).toMatch(/not loaded/);
  });

  it('an EMPTY listing still reports genuinely-no-devices', () => {
    // The distinction only pays if the empty case keeps saying "plug one in".
    const rows = iosTargetRows(listWith({ ios: [] }), noTarget, 'darwin');
    expect(rows[0].label).toMatch(/No iOS device paired/);
  });
});

describe('iosTargetRows', () => {
  it('emits one row per listed device', () => {
    const list = listWith({ ios: [iosRow({ udid: 'A' }), iosRow({ udid: 'B', name: 'iPhone 8' })] });
    const rows = iosTargetRows(list, noTarget);
    expect(rows).toHaveLength(2);
  });

  it('checks only the row whose udid matches the target', () => {
    const list = listWith({ ios: [iosRow({ udid: 'A' }), iosRow({ udid: 'B' })] });
    const rows = iosTargetRows(list, { ...noTarget, iosDeviceId: 'B' });
    expect(rows.map((r) => r.checked)).toEqual([false, true]);
  });

  it('a devicectl-listed device patches BOTH ids to its udid', () => {
    // This is the load-bearing field (#170): iosDevicectlId is what flips the build from an Xcode
    // handoff to a hands-free devicectl install.
    const list = listWith({ ios: [iosRow({ udid: 'A', devicectl: true })] });
    const [row] = iosTargetRows(list, noTarget);
    expect(row.patch).toEqual({ iosDeviceId: 'A', iosDevicectlId: 'A' });
  });

  it('a legacy xctrace-only device (no devicectl field) clears iosDevicectlId in its patch', () => {
    // Picking a pre-iOS-17 device must NOT plan a devicectl install, which would fail on the phone
    // — clearing the id is what makes that happen (the build then installs via go-ios instead).
    const list = listWith({ ios: [iosRow({ udid: 'A' })] }); // devicectl absent
    const [row] = iosTargetRows(list, noTarget);
    expect(row.patch).toEqual({ iosDeviceId: 'A', iosDevicectlId: '' });
  });

  it('the label names the install mode, naming the TOOL for a legacy device', () => {
    // Both are hands-free now (#217 — go-ios installs to what devicectl cannot see), so the row
    // has to distinguish them by tool: "Xcode handoff" here would be a lie, and a bare
    // "hands-free install" on both would hide which program is about to talk to the phone.
    const list = listWith({ ios: [iosRow({ udid: 'A', devicectl: true }), iosRow({ udid: 'B' })] });
    const [devicectlRow, legacyRow] = iosTargetRows(list, noTarget);
    expect(devicectlRow.label).toContain('hands-free install');
    expect(devicectlRow.label).not.toContain('go-ios');
    expect(legacyRow.label).toContain('hands-free install (go-ios)');
  });

  it('a claim held by ANOTHER clone is annotated in the label but the row stays selectable', () => {
    const list = listWith({
      ios: [iosRow({ udid: 'A', claim: { deviceId: 'ios:A', clone: '/Users/x/Projects/modoki-ai3', branch: 'work-ai3', pid: 1, at: 0 } })],
      self: { clone: '/Users/x/Projects/modoki-ai2', pid: 2 },
    });
    const [row] = iosTargetRows(list, noTarget);
    expect(row.label).toContain('debugged by modoki-ai3');
    expect(row.disabled).toBeFalsy();
    expect(row.patch).toBeDefined();
  });

  it('a claim whose clone equals list.self.clone is NOT annotated (it is this editor)', () => {
    const list = listWith({
      ios: [iosRow({ udid: 'A', claim: { deviceId: 'ios:A', clone: '/Users/x/Projects/modoki-ai2', branch: 'work-ai2', pid: 2, at: 0 } })],
      self: { clone: '/Users/x/Projects/modoki-ai2', pid: 2 },
    });
    const [row] = iosTargetRows(list, noTarget);
    expect(row.label).not.toContain('debugged by');
  });

  it('platform win32 returns a single disabled "needs macOS" row, regardless of the listing', () => {
    const list = listWith({ ios: [iosRow()] });
    const rows = iosTargetRows(list, noTarget, 'win32');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ checked: false, disabled: true });
    expect(rows[0].label).toMatch(/macOS/);
  });

  it('an empty listing on darwin returns a single disabled explanatory row', () => {
    const rows = iosTargetRows(listWith({ ios: [] }), noTarget, 'darwin');
    expect(rows).toHaveLength(1);
    expect(rows[0].disabled).toBe(true);
    expect(rows[0].patch).toBeUndefined();
  });

  it('a configured iosDeviceId not present in the listing gets an extra checked+disabled "not attached" row', () => {
    const list = listWith({ ios: [iosRow({ udid: 'A' })] });
    const rows = iosTargetRows(list, { ...noTarget, iosDeviceId: 'MISSING' });
    const extra = rows.find((r) => r.label.includes('not attached'));
    expect(extra).toMatchObject({ checked: true, disabled: true });
    // and the attached device's row is present too, unchecked
    expect(rows).toHaveLength(2);
  });
});

describe('androidTargetRows', () => {
  it('the first row is always "Default (first adb device)"', () => {
    const rows = androidTargetRows(listWith({ android: [androidRow()] }), noTarget);
    expect(rows[0].label).toBe('Default (first adb device)');
  });

  it('the default row is checked exactly when androidDeviceId is empty', () => {
    const empty = androidTargetRows(listWith(), noTarget);
    expect(empty[0].checked).toBe(true);
    const set = androidTargetRows(listWith({ android: [androidRow({ serial: 'S' })] }), { ...noTarget, androidDeviceId: 'S' });
    expect(set[0].checked).toBe(false);
  });

  it('emits a row per device, checked matching the serial', () => {
    const list = listWith({ android: [androidRow({ serial: 'S1' }), androidRow({ serial: 'S2' })] });
    const rows = androidTargetRows(list, { ...noTarget, androidDeviceId: 'S2' });
    const deviceRows = rows.slice(1);
    expect(deviceRows.map((r) => r.checked)).toEqual([false, true]);
  });

  it('adb.present:false yields the note row and no device rows', () => {
    const list = listWith({ adb: { present: false }, note: 'adb is not on PATH', android: [androidRow()] });
    const rows = androidTargetRows(list, noTarget);
    // default row + the note row only — the (would-be) device row is suppressed
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ label: 'adb is not on PATH', disabled: true });
  });

  it('an unauthorized device is still selectable (has a patch) with the state in its label', () => {
    const list = listWith({ android: [androidRow({ serial: 'S', state: 'unauthorized', usable: false })] });
    const [, row] = androidTargetRows(list, noTarget);
    expect(row.patch).toEqual({ androidDeviceId: 'S' });
    expect(row.label).toContain('unauthorized');
  });

  it('a configured serial not in the listing gets the checked+disabled "not attached" row', () => {
    const list = listWith({ android: [androidRow({ serial: 'S1' })] });
    const rows = androidTargetRows(list, { ...noTarget, androidDeviceId: 'MISSING' });
    const extra = rows.find((r) => r.label.includes('not attached'));
    expect(extra).toMatchObject({ checked: true, disabled: true });
  });
});

describe('iosTargetSummary', () => {
  it('names the device when the listing knows it', () => {
    const list = listWith({ ios: [iosRow({ udid: 'A', name: 'iPhone Air' })] });
    expect(iosTargetSummary(list, { ...noTarget, iosDeviceId: 'A' })).toBe('iPhone Air');
  });

  it('falls back to the raw id when the listing does not know it', () => {
    expect(iosTargetSummary(listWith(), { ...noTarget, iosDeviceId: 'UNKNOWN-ID' })).toBe('UNKNOWN-ID');
  });

  it('says "no device set" when empty', () => {
    expect(iosTargetSummary(listWith(), noTarget)).toBe('no device set');
  });
});

describe('androidTargetSummary', () => {
  it('names the device when the listing knows it', () => {
    const list = listWith({ android: [androidRow({ serial: 'S', name: 'Galaxy A23' })] });
    expect(androidTargetSummary(list, { ...noTarget, androidDeviceId: 'S' })).toBe('Galaxy A23');
  });

  it('falls back to the raw id when the listing does not know it', () => {
    expect(androidTargetSummary(listWith(), { ...noTarget, androidDeviceId: 'UNKNOWN-SERIAL' })).toBe('UNKNOWN-SERIAL');
  });

  it('says "default adb device" when empty', () => {
    expect(androidTargetSummary(listWith(), noTarget)).toBe('default adb device');
  });
});
